import type { APIRoute } from 'astro';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { PROJECT_ROOT } from '../../lib/db';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  const leadId = Number(body?.lead_id);
  if (!leadId) return Response.json({ ok: false, error: 'missing lead_id' }, { status: 400 });

  const clean = (v: unknown, re: RegExp) => String(v ?? '').split(',').map((x) => x.trim()).filter((x) => x && re.test(x)).join(',');
  const styles = clean(Array.isArray(body?.styles) ? body.styles.join(',') : body?.styles, /^[A-Za-z0-9_-]+$/);
  const pages = clean(Array.isArray(body?.pages) ? body.pages.join(',') : body?.pages, /^\d+$/);
  const pdfSlug = String(body?.pdf_slug ?? '').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60);
  const lang = body?.lang === 'en' ? 'en' : 'es';

  // explicit picture list: which redesign of which page (and which version) goes in,
  // in the order the dashboard sent them
  const select = (Array.isArray(body?.select) ? body.select : [])
    .map((v: unknown) => String(v ?? '').trim())
    .filter((v: string) => /^generated\/[A-Za-z0-9_\-./]+\.(png|jpe?g|webp)$/i.test(v) && !v.includes('..'))
    .slice(0, 200);

  const python = path.join(PROJECT_ROOT, '.venv', 'bin', 'python');
  const script = path.join(PROJECT_ROOT, 'scripts', 'build_comparison_pdf.py');

  const args = [script, String(leadId), '--lang', lang];
  if (styles) args.push('--styles', styles);
  if (pages) args.push('--pages', pages);
  if (pdfSlug) args.push('--pdf-slug', pdfSlug);
  if (body?.hero_only) args.push('--hero-only');
  // opt-in override: the builder refuses failed data checks unless asked twice
  if (body?.allow_failed_qc) args.push('--allow-failed-qc');
  if (select.length) args.push('--select', select.join(','));

  try {
    const out = execFileSync(python, args, {
      cwd: PROJECT_ROOT,
      timeout: 180_000,
      encoding: 'utf-8',
      maxBuffer: 16 * 1024 * 1024,
    });
    const parsed = JSON.parse(out.trim().split('\n').filter(Boolean).pop() ?? '{}');
    return Response.json(parsed, { status: parsed.ok ? 200 : 400 });
  } catch (err: any) {
    // the script reports its own failures as JSON on stdout before exiting non-zero
    const stdout = String(err?.stdout ?? '').trim();
    if (stdout) {
      try {
        const parsed = JSON.parse(stdout.split('\n').filter(Boolean).pop() ?? '');
        // keep `blocked` and friends: the UI explains which images the data check stopped
        if (parsed?.error) return Response.json({ ...parsed, ok: false }, { status: 400 });
      } catch {
        /* not JSON: fall through to the raw detail */
      }
    }
    const detail = String(err?.stderr || err?.message || stdout || err).slice(-800);
    return Response.json({ ok: false, error: detail }, { status: 500 });
  }
};
