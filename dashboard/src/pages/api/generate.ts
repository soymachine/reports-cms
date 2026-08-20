import type { APIRoute } from 'astro';
import path from 'node:path';
import { PROJECT_ROOT } from '../../lib/db';
import { enqueue, queueDepth, JOB_ID_TOKEN } from '../../lib/queue';
import { getSettings } from '../../lib/settings';
import { creditsPerImage, findModel } from '../../lib/models';
import db from '../../lib/db';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }
  const leadId = Number(body?.lead_id);
  const pages = Array.isArray(body?.pages) ? body.pages.map((p: any) => Number(p)).filter((n: number) => Number.isInteger(n) && n > 0) : [];
  const pdfSlug = String(body?.pdf_slug ?? '').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60);
  const extraPrompt = String(body?.extra_prompt ?? '').trim().slice(0, 2000);
  const feedback = String(body?.feedback ?? '').trim().slice(0, 1000);
  const palette = String(body?.palette ?? '').replace(/[^#0-9A-Fa-f,]/g, '').slice(0, 120);
  // optional: refine an existing redesign instead of starting from the PDF page.
  // Only paths inside generated/ are accepted, and only for a single page.
  // model / resolution / quality decide the credit cost, so they are validated
  // against the catalog instead of being forwarded blindly
  const settings0 = getSettings().redesign ?? {};
  const wantedModel = String(body?.model ?? settings0.model ?? 'auto').trim() || 'auto';
  const model = findModel(wantedModel) ? wantedModel : 'auto';
  const wantedRes = String(body?.resolution ?? settings0.resolution ?? '').trim();
  const wantedQual = String(body?.quality ?? settings0.quality ?? '').trim();
  const modelSpec = findModel(model);
  const resolution = modelSpec?.resolutions?.includes(wantedRes) ? wantedRes : '';
  const quality = modelSpec?.qualities?.includes(wantedQual) ? wantedQual : '';

  // pages of one report must look like one document: the run anchors on its own
  // first image, or on an existing redesign when the deck already has pages
  const consistent = body?.consistent !== false;
  const rawAnchor = String(body?.style_anchor ?? '').trim();

  const rawBase = String(body?.base_img ?? '').trim();
  const safeImage = (v: string) =>
    /^generated\/[A-Za-z0-9_\-./]+\.(png|jpe?g|webp)$/i.test(v) && !v.includes('..') ? v : '';
  const baseImg = safeImage(rawBase);
  const styleAnchor = safeImage(rawAnchor);

  // one entry per style: the same pages can be generated in several styles at once (A/B)
  const rawStyles = Array.isArray(body?.styles) && body.styles.length
    ? body.styles
    : [{ id: body?.style_id, name: body?.style_name, prompt: body?.style_prompt }];

  const styles = rawStyles
    .map((s: any) => ({
      id: String(s?.id ?? 'editorial').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 32),
      name: String(s?.name ?? s?.id ?? 'Editorial').slice(0, 64),
      prompt: String(s?.prompt ?? ''),
    }))
    .slice(0, 4);

  if (!leadId || !pages.length || !pdfSlug) {
    return Response.json({ ok: false, error: 'missing lead_id, pages or pdf_slug' }, { status: 400 });
  }

  // ---- credit budget guard -------------------------------------------------
  // An A/B run of 4 styles x 4 pages is 16 images; without a ceiling the bill
  // only shows up at the end of the month.
  const budget = getSettings().budget ?? {};
  const perLead = Number(budget.credits_per_lead ?? 0);
  const perDay = Number(budget.credits_per_day ?? 0);
  const images = pages.length * styles.length;
  // real price of one image with these settings, from the cached simulate_cost figures
  const perImage = creditsPerImage(model, resolution, quality);
  const estimate = images * perImage;

  const spentLead = (db.prepare(
    "SELECT COALESCE(SUM(credits), 0) AS c FROM jobs WHERE type = 'generate' AND lead_id = ?"
  ).get(leadId) as any).c as number;
  const spentToday = (db.prepare(
    "SELECT COALESCE(SUM(credits), 0) AS c FROM jobs WHERE type = 'generate' AND date(created_at) = date('now')"
  ).get() as any).c as number;

  const overLead = perLead > 0 && spentLead + estimate > perLead;
  const overDay = perDay > 0 && spentToday + estimate > perDay;

  if ((overLead || overDay) && !body?.confirm_budget) {
    return Response.json({
      ok: false,
      needs_confirmation: true,
      error: overLead
        ? `Este lead lleva ${spentLead} créditos; esta tanda sumaría ~${estimate} (${images} × ${perImage} cr. con ${modelSpec?.name ?? model}${resolution ? ` ${resolution}` : ''}${quality ? ` ${quality}` : ''}) y el tope por lead es ${perLead}.`
        : `Hoy llevas ${spentToday} créditos; esta tanda sumaría ~${estimate} (${images} × ${perImage} cr. con ${modelSpec?.name ?? model}${resolution ? ` ${resolution}` : ''}${quality ? ` ${quality}` : ''}) y el tope diario es ${perDay}.`,
      budget: {
        spent_lead: spentLead, spent_today: spentToday, estimate, per_lead: perLead,
        per_day: perDay, images, credits_per_image: perImage,
        model, resolution: resolution || null, quality: quality || null,
      },
    }, { status: 409 });
  }

  const python = path.join(PROJECT_ROOT, '.venv', 'bin', 'python');
  const script = path.join(PROJECT_ROOT, 'scripts', 'generate_redesign.py');

  const jobIds: number[] = [];

  for (const style of styles) {
    const args = [
      script, String(leadId), '--pages', pages.join(','), '--pdf-slug', pdfSlug,
      '--style-id', style.id, '--style-name', style.name,
    ];
    if (style.prompt) args.push('--style-prompt', style.prompt);
    if (extraPrompt) args.push('--extra-prompt', extraPrompt);
    if (feedback) args.push('--feedback', feedback);
    if (palette) args.push('--palette', palette);
    if (model && model !== 'auto') args.push('--model', model);
    if (resolution) args.push('--resolution', resolution);
    if (quality) args.push('--quality', quality);
    if (baseImg && pages.length === 1) args.push('--base-img', baseImg);
    if (!consistent) args.push('--no-consistency');
    if (consistent && styleAnchor) args.push('--style-anchor', styleAnchor);

    // the queue owns the process: it caps concurrency, records the pid so the job
    // can be cancelled, and closes the row if the dashboard restarts mid-run
    const job = enqueue('generate', leadId, {
      pages, pdf_slug: pdfSlug, style_id: style.id, style_name: style.name,
      extra_prompt: extraPrompt, feedback, palette, estimate,
      base_img: baseImg || undefined,
      model, resolution: resolution || undefined, quality: quality || undefined,
      credits_per_image: perImage,
      consistent, style_anchor: styleAnchor || undefined,
    }, {
      file: python,
      // the script writes its own progress into this row, so it needs the id
      args: [...args, '--job-id', JOB_ID_TOKEN],
      cwd: PROJECT_ROOT,
      timeoutMin: 30,
    });
    jobIds.push(job.id);
  }

  const depth = queueDepth();
  return Response.json({
    ok: true, job_ids: jobIds, state: depth.running >= depth.max ? 'queued' : 'running',
    queue: depth, lead_id: leadId, pages,
    styles: styles.length, estimate, credits_per_image: perImage,
    model, resolution: resolution || null, quality: quality || null,
  });
};
