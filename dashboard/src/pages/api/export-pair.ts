import type { APIRoute } from 'astro';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { PROJECT_ROOT } from '../../lib/db';

export const prerender = false;

const FORMATS = new Set(['slide', 'square', 'story', 'raw']);

export const POST: APIRoute = async ({ request }) => {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  const leadId = Number(body?.lead_id);
  const original = String(body?.original ?? '');
  const generated = String(body?.generated ?? '');
  const format = FORMATS.has(String(body?.format)) ? String(body.format) : 'slide';
  if (!leadId || !generated) return Response.json({ ok: false, error: 'missing lead_id or generated' }, { status: 400 });

  // both images must live under generated/
  for (const rel of [original, generated].filter(Boolean)) {
    const abs = path.resolve(PROJECT_ROOT, rel);
    if (!abs.startsWith(path.join(PROJECT_ROOT, 'generated') + path.sep)) {
      return Response.json({ ok: false, error: 'forbidden path' }, { status: 403 });
    }
  }

  const python = path.join(PROJECT_ROOT, '.venv', 'bin', 'python');
  const script = path.join(PROJECT_ROOT, 'scripts', 'export_pair.py');
  const args = [script, String(leadId), '--original', original, '--generated', generated, '--format', format];
  if (body?.label) args.push('--label', String(body.label).slice(0, 64));
  if (body?.page) args.push('--page', String(Number(body.page) || 0));
  if (body?.ext === 'jpg') args.push('--ext', 'jpg');

  try {
    const out = execFileSync(python, args, { cwd: PROJECT_ROOT, timeout: 120_000, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });
    return Response.json(JSON.parse(out.trim().split('\n').filter(Boolean).pop() ?? '{}'));
  } catch (err: any) {
    return Response.json({ ok: false, error: String(err?.stderr || err?.message || err).slice(-600) }, { status: 500 });
  }
};
