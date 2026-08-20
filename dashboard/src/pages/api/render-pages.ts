import type { APIRoute } from 'astro';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { PROJECT_ROOT } from '../../lib/db';

export const prerender = false;

function slugify(file: string): string {
  const stem = path.basename(file).replace(/\.[^.]+$/, '');
  return stem.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60);
}

export const POST: APIRoute = async ({ request }) => {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }
  const leadId = Number(body?.lead_id);
  const pdf = String(body?.pdf ?? '');
  if (!leadId || !pdf) return Response.json({ ok: false, error: 'missing lead_id or pdf' }, { status: 400 });

  // path traversal protection: pdf must resolve inside the project's pdfs/ dir
  const resolved = path.resolve(PROJECT_ROOT, pdf);
  if (!resolved.startsWith(path.join(PROJECT_ROOT, 'pdfs') + path.sep)) {
    return Response.json({ ok: false, error: 'pdf path outside pdfs/' }, { status: 400 });
  }

  const python = path.join(PROJECT_ROOT, '.venv', 'bin', 'python');
  const script = path.join(PROJECT_ROOT, 'scripts', 'render_pages.py');

  try {
    const out = execFileSync(python, [script, String(leadId), '--pdf', pdf], {
      cwd: PROJECT_ROOT,
      timeout: 240_000,
      encoding: 'utf-8',
      maxBuffer: 16 * 1024 * 1024,
    });
    const parsed = JSON.parse(out.trim().split('\n').filter(Boolean).pop() ?? '{}');
    return Response.json({ ...parsed, slug: slugify(pdf) });
  } catch (err: any) {
    const detail = err?.stdout ? String(err.stdout).slice(-1000) : String(err?.message ?? err);
    return Response.json({ ok: false, error: detail }, { status: 500 });
  }
};
