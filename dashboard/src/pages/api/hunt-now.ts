import type { APIRoute } from 'astro';
import { spawn } from 'node:child_process';
import { getSettings } from '../../lib/settings';

export const prerender = false;

export const POST: APIRoute = async () => {
  const settings = getSettings();
  const jobId = settings.cron?.lead_hunter_job_id ?? 'd28024ce08c5';

  try {
    const child = spawn('hermes', ['cron', 'run', jobId], { detached: true, stdio: 'ignore' });
    child.on('error', () => {
      /* surfaced via spawn catch below is unreliable for async errors; status polled separately */
    });
    child.unref();
    return Response.json({ ok: true, job_id: jobId, message: `hermes cron run ${jobId} lanzado` });
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 500 });
  }
};
