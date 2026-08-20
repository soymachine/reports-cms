import type { APIRoute } from 'astro';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../../lib/db';

export const prerender = false;

// same allowlist as /api/file: nothing outside the asset folders is reachable
const ALLOWED_DIRS = ['pdfs', 'generated'];

export const POST: APIRoute = async ({ request }) => {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  const rel = String(body?.path ?? '');
  if (!rel) return Response.json({ ok: false, error: 'missing path' }, { status: 400 });

  const resolved = path.resolve(PROJECT_ROOT, rel);
  const allowed = ALLOWED_DIRS.some((d) => resolved.startsWith(path.join(PROJECT_ROOT, d) + path.sep));
  if (!allowed) return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });

  if (!fs.existsSync(resolved)) {
    return Response.json({ ok: false, error: 'el archivo ya no existe en disco' }, { status: 404 });
  }

  if (process.platform !== 'darwin') {
    return Response.json({ ok: false, error: `abrir el Finder solo está soportado en macOS (platform: ${process.platform})` }, { status: 501 });
  }

  try {
    // -R reveals the file inside its folder instead of opening the PDF itself
    const child = spawn('open', ['-R', resolved], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 500 });
  }

  return Response.json({ ok: true, path: rel, dir: path.dirname(resolved) });
};
