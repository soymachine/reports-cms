import type { APIRoute } from 'astro';
import db from '../../lib/db';
import { getSettings } from '../../lib/settings';

export const prerender = false;

export const GET: APIRoute = async () => {
  const total = (db.prepare('SELECT COUNT(*) AS c FROM leads').get() as any).c as number;

  const byStatus: Record<string, number> = {};
  for (const r of db.prepare('SELECT status, COUNT(*) AS c FROM leads GROUP BY status').all() as any[]) {
    byStatus[r.status ?? 'unknown'] = r.c;
  }

  const byPriority: Record<string, number> = {};
  for (const r of db.prepare('SELECT priority, COUNT(*) AS c FROM leads GROUP BY priority').all() as any[]) {
    if (r.priority) byPriority[r.priority] = r.c;
  }

  const withPdfs = (db.prepare("SELECT COUNT(*) AS c FROM leads WHERE pdfs IS NOT NULL AND pdfs != '[]'").get() as any).c;
  const withGenerated = (db.prepare("SELECT COUNT(*) AS c FROM leads WHERE generated IS NOT NULL AND generated != '[]'").get() as any).c;

  let lastCron: any = null;
  try {
    lastCron = db.prepare('SELECT job, ran_at, summary FROM cron_history ORDER BY ran_at DESC, id DESC LIMIT 1').get() ?? null;
  } catch {
    lastCron = null;
  }

  const sectors = (db.prepare('SELECT DISTINCT sector FROM leads WHERE sector IS NOT NULL AND sector != \'\' ORDER BY sector').all() as any[]).map((r) => r.sector);
  const countries = (db.prepare('SELECT DISTINCT country FROM leads WHERE country IS NOT NULL AND country != \'\' ORDER BY country').all() as any[]).map((r) => r.country);

  // pipeline health signals for the sidebar
  const duplicates = (db.prepare('SELECT COUNT(*) AS c FROM leads WHERE duplicate_of IS NOT NULL').get() as any).c;
  const activeJobs = (db.prepare("SELECT COUNT(*) AS c FROM jobs WHERE state IN ('queued','running')").get() as any).c;
  const creditsRow = db.prepare("SELECT ROUND(SUM(COALESCE(credits,0)),2) AS total FROM jobs WHERE type = 'generate'").get() as any;
  const scored = (db.prepare('SELECT COUNT(*) AS c FROM leads WHERE scored_at IS NOT NULL').get() as any).c;

  const s = getSettings();

  const cycle = s.radar?.cycle_months ?? 12;
  const win = s.radar?.window_months ?? 3;
  const radarDue = (db.prepare(
    `SELECT COUNT(*) AS c FROM leads
      WHERE report_published_at IS NOT NULL AND report_published_at != ''
        AND status NOT IN ('Won','Lost','Discarded')
        AND julianday('now') - julianday(report_published_at) >= ?`
  ).get((cycle - win) * 30.44) as any).c;

  return Response.json({
    total,
    by_status: byStatus,
    by_priority: byPriority,
    with_pdfs: withPdfs,
    with_generated: withGenerated,
    last_cron: lastCron,
    duplicates,
    active_jobs: activeJobs,
    credits_spent: creditsRow?.total ?? 0,
    scored,
    radar_due: radarDue,
    sectors,
    countries,
    settings: {
      statuses: s.statuses ?? [],
      priorities: s.priorities ?? [],
      style_presets: s.redesign?.style_presets ?? [],
      cron_schedule: s.cron?.schedule ?? null,
      cron_description: s.cron?.description ?? null,
      max_pages: s.redesign?.max_pages ?? 3,
      radar_cycle_months: cycle,
    },
  });
};
