import type { APIRoute } from 'astro';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import db, { parseLead, PROJECT_ROOT } from '../../lib/db';

export const prerender = false;

/** Runs the python detector and returns the suspected duplicate clusters. */
export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const threshold = Math.min(Math.max(Number(url.searchParams.get('threshold')) || 0.86, 0.5), 1);

  const python = path.join(PROJECT_ROOT, '.venv', 'bin', 'python');
  const script = path.join(PROJECT_ROOT, 'scripts', 'dedupe.py');

  try {
    const out = execFileSync(python, [script, '--threshold', String(threshold), '--flag'], {
      cwd: PROJECT_ROOT,
      timeout: 120_000,
      encoding: 'utf-8',
      maxBuffer: 16 * 1024 * 1024,
    });
    const parsed = JSON.parse(out.trim().split('\n').filter(Boolean).pop() ?? '{}');
    return Response.json(parsed);
  } catch (err: any) {
    return Response.json({ ok: false, error: String(err?.stderr ?? err?.message ?? err).slice(-800) }, { status: 500 });
  }
};

/** Merges duplicates into one lead: assets and history are kept, the extras are removed. */
export const POST: APIRoute = async ({ request }) => {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  const keep = Number(body?.keep);
  const drop = (Array.isArray(body?.drop) ? body.drop : []).map(Number).filter((n: number) => n > 0 && n !== keep);
  if (!keep || !drop.length) return Response.json({ ok: false, error: 'missing keep or drop ids' }, { status: 400 });

  const target: any = db.prepare('SELECT * FROM leads WHERE id = ?').get(keep);
  if (!target) return Response.json({ ok: false, error: 'lead a conservar no encontrado' }, { status: 404 });

  const json = (raw: any, fallback: any[]) => {
    try { return JSON.parse(raw || '[]'); } catch { return fallback; }
  };

  const pdfs = json(target.pdfs, []);
  const generated = json(target.generated, []);
  const timeline = json(target.timeline, []);
  const merged: number[] = [];

  const fillable = [
    'website', 'linkedin', 'sector', 'country', 'city', 'type', 'relationship', 'rationale',
    'services', 'contact1_name', 'contact1_title', 'contact1_email',
    'contact2_name', 'contact2_title', 'contact2_email', 'general_email', 'email_confidence', 'notes',
  ];
  const fills: Record<string, unknown> = {};

  for (const id of drop) {
    const src: any = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
    if (!src) continue;

    for (const p of json(src.pdfs, [])) {
      if (!pdfs.some((x: any) => x.url === p.url || x.file === p.file)) pdfs.push(p);
    }
    for (const g of json(src.generated, [])) {
      if (!generated.some((x: any) => x.generated_img === g.generated_img)) generated.push(g);
    }
    timeline.push(...json(src.timeline, []));

    // a blank field on the survivor takes the duplicate's value
    for (const f of fillable) {
      if (!target[f] && !fills[f] && src[f]) fills[f] = src[f];
    }
    merged.push(id);
  }

  timeline.push({
    type: 'merge',
    text: `Fusionados ${merged.length} duplicado(s): ids ${merged.join(', ')}`,
    date: new Date().toISOString(),
  });

  const sets = Object.keys(fills).map((f) => `${f} = ?`);
  const params = Object.values(fills);
  db.prepare(
    `UPDATE leads SET pdfs = ?, generated = ?, timeline = ?${sets.length ? ', ' + sets.join(', ') : ''},
            duplicate_of = NULL, updated_at = datetime('now')
      WHERE id = ?`
  ).run(JSON.stringify(pdfs), JSON.stringify(generated), JSON.stringify(timeline), ...params, keep);

  // the merged rows keep their files on disk: they are now referenced by `keep`
  const placeholders = merged.map(() => '?').join(', ');
  if (merged.length) db.prepare(`DELETE FROM leads WHERE id IN (${placeholders})`).run(...merged);

  const lead = parseLead(db.prepare('SELECT * FROM leads WHERE id = ?').get(keep));
  return Response.json({ ok: true, kept: keep, merged, lead });
};
