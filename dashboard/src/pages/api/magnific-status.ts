import type { APIRoute } from 'astro';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { PROJECT_ROOT } from '../../lib/db';

export const prerender = false;

// El script hace una llamada de red: una caché corta evita machacarla en cada
// sondeo de la barra lateral (que pregunta cada 60 s).
let cache: { at: number; payload: Record<string, unknown> } | null = null;
const CACHE_MS = 60_000;

/** El estado viene decidido por el script; aquí no se interpreta ningún texto. */
function probe(): Record<string, unknown> {
  const python = path.join(PROJECT_ROOT, '.venv', 'bin', 'python');
  const script = path.join(PROJECT_ROOT, 'scripts', 'magnific_status.py');
  try {
    const out = execFileSync(python, [script], {
      cwd: PROJECT_ROOT,
      timeout: 30_000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(out.trim().split('\n').filter(Boolean).pop() ?? '{}');
  } catch (err: any) {
    // Salida distinta de cero: el script ya explicó por qué en su JSON de stdout.
    const stdout = String(err?.stdout ?? '').trim();
    const last = stdout.split('\n').filter(Boolean).pop();
    if (last) {
      try {
        return JSON.parse(last);
      } catch {
        /* no era JSON: cae al genérico de abajo */
      }
    }
    // Aquí ya no hablamos con Magnific, sino con el entorno: falta el .venv,
    // falta el script, el proceso murió. Merece un mensaje distinto.
    return {
      ok: false,
      status: 'error',
      detail: String(err?.stderr || err?.message || err).slice(-300),
    };
  }
}

export const GET: APIRoute = async () => {
  if (cache && Date.now() - cache.at < CACHE_MS) {
    return Response.json(cache.payload);
  }
  const payload = probe();
  cache = { at: Date.now(), payload };
  return Response.json(payload);
};
