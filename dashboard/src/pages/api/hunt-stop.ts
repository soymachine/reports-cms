import type { APIRoute } from 'astro';
import { runningPid } from './hunt-now';

export const prerender = false;

/** Aborta la ronda en curso. No toca el interruptor: eso es hunt-toggle. */
export const POST: APIRoute = async () => {
  const pid = runningPid();
  if (!pid) {
    return Response.json({ ok: true, message: 'no había ninguna búsqueda en marcha' });
  }
  try {
    process.kill(pid, 'SIGTERM');
    return Response.json({ ok: true, message: 'búsqueda detenida', pid });
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 500 });
  }
};
