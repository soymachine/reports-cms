import type { APIRoute } from 'astro';
import db, { parseLead } from '../../lib/db';
import { getSettings } from '../../lib/settings';

export const prerender = false;

/**
 * Leads whose last known report is about to be a year old: their next edition
 * is coming, which is exactly when a redesign pitch lands.
 */
export const GET: APIRoute = async () => {
  const s = getSettings();
  const cycle = s.radar?.cycle_months ?? 12;
  const window = s.radar?.window_months ?? 3;

  const rows = db
    .prepare(
      `SELECT * FROM leads
        WHERE report_published_at IS NOT NULL AND report_published_at != ''
          AND status NOT IN ('Won', 'Lost', 'Discarded')
        ORDER BY report_published_at ASC`
    )
    .all() as any[];

  const now = Date.now();
  const months = (iso: string) => (now - new Date(String(iso).slice(0, 10)).getTime()) / (1000 * 60 * 60 * 24 * 30.44);

  const due: any[] = [];
  const upcoming: any[] = [];

  for (const row of rows) {
    const age = months(row.report_published_at);
    if (!Number.isFinite(age)) continue;
    const entry = {
      ...parseLead(row),
      months_since_report: Math.round(age * 10) / 10,
      months_to_next: Math.round((cycle - age) * 10) / 10,
    };
    if (age >= cycle - window) due.push(entry);
    else if (age >= cycle - window * 2) upcoming.push(entry);
  }

  due.sort((a, b) => b.months_since_report - a.months_since_report);
  upcoming.sort((a, b) => a.months_to_next - b.months_to_next);

  return Response.json({
    ok: true,
    cycle_months: cycle,
    window_months: window,
    due: due.slice(0, 50),
    upcoming: upcoming.slice(0, 50),
    counts: { due: due.length, upcoming: upcoming.length, tracked: rows.length },
  });
};
