import type { APIRoute } from 'astro';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../../lib/db';

export const prerender = false;

const STATE = path.join(PROJECT_ROOT, '.hunt_status.json');

/** ¿Hay una ronda viva ahora mismo? El pid del fichero de estado lo dice. */
export function runningPid(): number | null {
  try {
    const state = JSON.parse(fs.readFileSync(STATE, 'utf-8'));
    if (state.state !== 'running' || !state.pid) return null;
    process.kill(state.pid, 0);      // señal 0: solo comprueba que existe
    return state.pid as number;
  } catch {
    return null;                     // sin fichero, o el proceso ya no está
  }
}

export const POST: APIRoute = async () => {
  if (runningPid()) {
    return Response.json({ ok: false, error: 'ya hay una búsqueda en marcha' }, { status: 409 });
  }

  const python = path.join(PROJECT_ROOT, '.venv', 'bin', 'python');
  const script = path.join(PROJECT_ROOT, 'scripts', 'hunt.py');
  try {
    // --ignore-pause: pulsar el botón es una orden explícita, y saltársela
    // porque el cazador automático está pausado sería desobedecer al usuario.
    const child = spawn(python, [script, '--ignore-pause'], {
      cwd: PROJECT_ROOT,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return Response.json({ ok: true, pid: child.pid, message: 'búsqueda lanzada' });
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 500 });
  }
};
