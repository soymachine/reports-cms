import type { APIRoute } from 'astro';
import db from '../../lib/db';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);

  let runs: any[] = [];
  try {
    runs = db
      .prepare('SELECT id, job, ran_at, summary FROM cron_history ORDER BY ran_at DESC, id DESC LIMIT ?')
      .all(limit) as any[];
  } catch {
    runs = [];
  }

  // leads created by each run, matched by day, so a run can be inspected in detail
  const enriched = runs.map((r) => {
    let leads: any[] = [];
    try {
      leads = db
        .prepare(
          `SELECT id, organisation, priority, sector, country, status
             FROM leads
            WHERE source = 'agent' AND date(created_at) = date(?)
            ORDER BY id`
        )
        .all(r.ran_at) as any[];
    } catch {
      leads = [];
    }
    return { ...r, leads };
  });

  return Response.json({ runs: enriched, count: enriched.length });
};
