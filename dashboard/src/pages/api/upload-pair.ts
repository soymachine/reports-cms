import type { APIRoute } from 'astro';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import db, { parseLead, PROJECT_ROOT } from '../../lib/db';

export const prerender = false;

const MAX_MB = 25;
const MAX_PAIRS = 20;
const EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const QC_BUDGET_MS = 60_000;

const slug = (s: string) =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 40);

function extOf(file: File): string {
  const ext = path.extname(file.name).toLowerCase();
  if (EXTS.has(ext)) return ext;
  if (file.type === 'image/png') return '.png';
  if (file.type === 'image/webp') return '.webp';
  if (file.type === 'image/jpeg') return '.jpg';
  return '';
}

/** The same check the generated pairs get: figures kept, and design actually changed. */
function runQc(original: string, generated: string, pdfFile: string | null, page: number) {
  const python = path.join(PROJECT_ROOT, '.venv', 'bin', 'python');
  const script = path.join(PROJECT_ROOT, 'scripts', 'qc_redesign.py');
  const args = [script, '--original', original, '--generated', generated];
  if (pdfFile) args.push('--pdf', pdfFile, '--page', String(page));
  try {
    const out = execFileSync(python, args, {
      cwd: PROJECT_ROOT, timeout: 45_000, encoding: 'utf-8', maxBuffer: 4 * 1024 * 1024,
    });
    return JSON.parse(out.trim().split('\n').filter(Boolean).pop() ?? 'null');
  } catch (err: any) {
    const stdout = String(err?.stdout ?? '').trim();
    if (stdout) {
      try { return JSON.parse(stdout.split('\n').filter(Boolean).pop() ?? 'null'); } catch { /* below */ }
    }
    return null;             // no venv, no tesseract: the pair simply has no check
  }
}

/**
 * Pairs a designer made by hand, uploaded straight into the pipeline.
 *
 * They are written as ordinary `generated` entries, so the before/after strip,
 * the comparator, the winners, the comparison PDF and the e-mail all work on
 * them without knowing where they came from — only `source: "manual"` says so.
 */
export const POST: APIRoute = async ({ request }) => {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ ok: false, error: 'se esperaba multipart/form-data' }, { status: 400 });
  }

  const leadId = Number(form.get('lead_id'));
  if (!leadId) return Response.json({ ok: false, error: 'missing lead_id' }, { status: 400 });

  const row: any = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  if (!row) return Response.json({ ok: false, error: 'lead not found' }, { status: 404 });

  // the pairs hang off one of this lead's reports: that is what the deck names
  const pdfs: any[] = JSON.parse(row.pdfs || '[]');
  const pdfSlug = String(form.get('pdf_slug') ?? '');
  const report = pdfs.find((p) => p.slug === pdfSlug);
  if (!report) {
    return Response.json({ ok: false, error: 'el report indicado no existe en este lead' }, { status: 400 });
  }

  const originals = form.getAll('originals').filter((f): f is File => f instanceof File && f.size > 0);
  const redesigns = form.getAll('redesigns').filter((f): f is File => f instanceof File && f.size > 0);
  if (!originals.length) return Response.json({ ok: false, error: 'no se recibió ninguna imagen original' }, { status: 400 });
  if (originals.length !== redesigns.length) {
    return Response.json({
      ok: false,
      error: `hacen falta el mismo número de originales y de nuevas: ${originals.length} y ${redesigns.length}`,
    }, { status: 400 });
  }
  if (originals.length > MAX_PAIRS) {
    return Response.json({ ok: false, error: `máximo ${MAX_PAIRS} pares por subida` }, { status: 400 });
  }

  const label = (String(form.get('label') ?? '').trim() || 'Manual').slice(0, 40);
  const styleId = slug(label) ? `manual-${slug(label)}` : 'manual';
  const pages = String(form.get('pages') ?? '').split(',').map((n) => Number(n.trim()));

  const destDir = path.join(PROJECT_ROOT, 'generated', String(leadId), 'manual');
  fs.mkdirSync(destDir, { recursive: true });

  // the text layer beats OCR, but only if the report is still on disk
  const sourcePdf = report.file && fs.existsSync(path.join(PROJECT_ROOT, report.file))
    ? String(report.file)
    : null;

  const generated: any[] = JSON.parse(row.generated || '[]');
  const added: any[] = [];
  const written: string[] = [];
  const deadline = Date.now() + QC_BUDGET_MS;

  try {
    for (let i = 0; i < originals.length; i++) {
      const pair = [originals[i], redesigns[i]];
      for (const f of pair) {
        if (f.size > MAX_MB * 1024 * 1024) {
          throw new Error(`${f.name} supera los ${MAX_MB} MB`);
        }
        if (!extOf(f)) throw new Error(`${f.name} no es PNG, JPG o WEBP`);
      }

      const page = Number.isFinite(pages[i]) && pages[i] > 0 ? Math.floor(pages[i]) : i + 1;
      const token = Date.now().toString(36).slice(-4);
      const paths: string[] = [];
      for (const [f, role] of [[originals[i], 'antes'], [redesigns[i], 'despues']] as const) {
        const name = `page-${String(page).padStart(2, '0')}-${styleId}-${role}-${token}${extOf(f)}`;
        const abs = path.join(destDir, name);
        fs.writeFileSync(abs, Buffer.from(await f.arrayBuffer()));
        written.push(abs);
        paths.push(`generated/${leadId}/manual/${name}`);
      }

      // Re-uploading a page under the same label is a new take on it, not a
      // duplicate: it behaves like a regeneration, so the version chips work.
      const prior = generated.filter(
        (g) => g.pdf === report.slug && g.page === page && g.style === styleId);
      for (const g of prior) g.superseded = true;

      const entry: any = {
        page,
        pdf: report.slug,
        style: styleId,
        styleName: label,
        original_img: paths[0],
        generated_img: paths[1],
        created_at: new Date().toISOString(),
        source: 'manual',
        version: prior.reduce((n: number, g: any) => Math.max(n, g.version ?? 1), 0) + 1,
        style_prompt: 'Par subido a mano desde el panel: el diseño no salió de Magnific.',
        qc: Date.now() < deadline ? runQc(paths[0], paths[1], sourcePdf, page) : null,
      };
      generated.push(entry);
      added.push(entry);
    }
  } catch (err: any) {
    for (const f of written) { try { fs.unlinkSync(f); } catch { /* best effort */ } }
    return Response.json({ ok: false, error: String(err?.message ?? err) }, { status: 400 });
  }

  const timeline: any[] = JSON.parse(row.timeline || '[]');
  timeline.push({
    type: 'manual_pairs',
    text: `${added.length} par(es) antes/después subidos a mano · ${label}`,
    date: new Date().toISOString(),
  });

  db.prepare("UPDATE leads SET generated = ?, timeline = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(generated), JSON.stringify(timeline), leadId);

  // the gallery paints tiles out of these: give them the same WebP the rest has
  try {
    execFileSync(path.join(PROJECT_ROOT, '.venv', 'bin', 'python'),
      [path.join(PROJECT_ROOT, 'scripts', 'thumbs.py'), '--backfill'],
      { cwd: PROJECT_ROOT, timeout: 60_000, encoding: 'utf-8', maxBuffer: 4 * 1024 * 1024 });
  } catch {
    /* the UI falls back to the full image when there is no thumb */
  }

  const lead = parseLead(db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId));
  return Response.json({ ok: true, added: added.length, lead });
};

/** Removes one hand-made pair, images included. Only ever touches manual ones. */
export const DELETE: APIRoute = async ({ request }) => {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  const leadId = Number(body?.lead_id);
  const image = String(body?.generated_img ?? '');
  if (!leadId || !image) return Response.json({ ok: false, error: 'missing lead_id or generated_img' }, { status: 400 });

  const row: any = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  if (!row) return Response.json({ ok: false, error: 'lead not found' }, { status: 404 });

  const generated: any[] = JSON.parse(row.generated || '[]');
  const entry = generated.find((g) => g.generated_img === image);
  if (!entry) return Response.json({ ok: false, error: 'ese par no existe en el lead' }, { status: 404 });
  if (entry.source !== 'manual') {
    return Response.json({ ok: false, error: 'solo se pueden borrar los pares subidos a mano' }, { status: 400 });
  }

  // the thumb lives in a subfolder of the same place, so one prefix covers all three
  const expected = path.join(PROJECT_ROOT, 'generated', String(leadId), 'manual') + path.sep;
  for (const rel of [entry.original_img, entry.generated_img, entry.thumb].filter(Boolean)) {
    const abs = path.resolve(PROJECT_ROOT, rel);
    if (!abs.startsWith(expected)) continue;      // never follow a path that climbed out
    try { fs.unlinkSync(abs); } catch { /* already gone */ }
  }

  db.prepare("UPDATE leads SET generated = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(generated.filter((g) => g.generated_img !== image)), leadId);

  const lead = parseLead(db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId));
  return Response.json({ ok: true, lead });
};
