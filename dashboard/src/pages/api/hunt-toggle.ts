import type { APIRoute } from 'astro';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../../lib/db';

export const prerender = false;

const SETTINGS = path.join(PROJECT_ROOT, 'settings.json');

/**
 * Enciende o apaga el cazador automático. Apagado, launchd sigue disparando cada
 * noche y hunt.py sale de inmediato: pausar es tocar un fichero, no el sistema.
 */
export const POST: APIRoute = async ({ request }) => {
  let enabled: boolean;
  try {
    ({ enabled } = await request.json());
    if (typeof enabled !== 'boolean') throw new Error('falta "enabled" (true o false)');
  } catch (err) {
    return Response.json({ ok: false, error: String((err as Error).message ?? err) }, { status: 400 });
  }

  try {
    // Reescribir sobre el fichero leído conserva el resto de ajustes y su orden.
    const settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf-8'));
    settings.hunter = { ...(settings.hunter ?? {}), enabled };
    fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
    return Response.json({
      ok: true,
      enabled,
      message: enabled ? 'cazador activo' : 'cazador en pausa',
    });
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 500 });
  }
};
