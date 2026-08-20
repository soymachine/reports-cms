import type { APIRoute } from 'astro';
import { activeJobs, getJob, reapStale, recentJobs } from '../../lib/jobs';
import { cancel, queueDepth } from '../../lib/queue';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);

  // every poll is a chance to clean up jobs whose process died
  reapStale();

  const id = Number(url.searchParams.get('id'));
  if (id) {
    const job = getJob(id);
    if (!job) return Response.json({ ok: false, error: 'job not found' }, { status: 404 });
    return Response.json({ ok: true, job });
  }

  const active = activeJobs();
  const recent = recentJobs(Math.min(Number(url.searchParams.get('limit')) || 25, 100));
  return Response.json({
    ok: true, active, recent, active_count: active.length, queue: queueDepth(),
  });
};

/** POST { id } cancels a queued or running job. */
export const POST: APIRoute = async ({ request }) => {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }
  const id = Number(body?.id);
  if (!id) return Response.json({ ok: false, error: 'missing id' }, { status: 400 });
  const out = cancel(id);
  return Response.json(out, { status: out.ok ? 200 : 400 });
};
