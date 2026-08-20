import type { APIRoute } from 'astro';
import db from '../../lib/db';
import { getSettings } from '../../lib/settings';

export const prerender = false;

/** Conversion through the pipeline, plus which sector and which style pay off. */
export const GET: APIRoute = async () => {
  const s = getSettings();
  const statuses = s.statuses ?? [];
  const contactedIdx = Math.max(statuses.indexOf('Contacted'), 0);

  const one = (sql: string, ...p: any[]) => (db.prepare(sql).get(...p) as any).c as number;

  const total = one('SELECT COUNT(*) AS c FROM leads');
  const withPdfs = one("SELECT COUNT(*) AS c FROM leads WHERE pdfs NOT IN ('', '[]') AND pdfs IS NOT NULL");
  const withGenerated = one("SELECT COUNT(*) AS c FROM leads WHERE generated NOT IN ('', '[]') AND generated IS NOT NULL");

  // "contacted" = at or past the Contacted column, so Replied/Won count too
  const reached = statuses.slice(contactedIdx).filter((x) => x !== 'Lost' && x !== 'Discarded');
  const ph = reached.map(() => '?').join(', ') || "''";
  const contacted = one(`SELECT COUNT(*) AS c FROM leads WHERE status IN (${ph})`, ...reached);
  const replied = one("SELECT COUNT(*) AS c FROM leads WHERE status IN ('Replied', 'Won')");
  const won = one("SELECT COUNT(*) AS c FROM leads WHERE status = 'Won'");

  const stages = [
    { key: 'leads', label: 'Leads', count: total },
    { key: 'pdfs', label: 'Con informe', count: withPdfs },
    { key: 'demos', label: 'Con rediseño', count: withGenerated },
    { key: 'contacted', label: 'Contactados', count: contacted },
    { key: 'replied', label: 'Respondieron', count: replied },
    { key: 'won', label: 'Ganados', count: won },
  ].map((stage, i, arr) => {
    // the stages are not strictly nested: a lead can be marked Won without ever
    // getting a redesign, so a >100% step is real data, not a bug. Report it as
    // null rather than a misleading percentage.
    const prev = i === 0 ? null : arr[i - 1].count;
    const ratio = prev ? Math.round((stage.count / prev) * 100) : null;
    return {
      ...stage,
      pct_of_total: total ? Math.round((stage.count / total) * 100) : 0,
      pct_of_prev: i === 0 ? 100 : ratio !== null && ratio <= 100 ? ratio : null,
    };
  });

  const bySector = db.prepare(`
    SELECT sector,
           COUNT(*) AS total,
           SUM(CASE WHEN pdfs NOT IN ('', '[]') THEN 1 ELSE 0 END) AS with_pdfs,
           SUM(CASE WHEN generated NOT IN ('', '[]') THEN 1 ELSE 0 END) AS with_generated,
           SUM(CASE WHEN status IN ('Replied','Won') THEN 1 ELSE 0 END) AS replied,
           SUM(CASE WHEN status = 'Won' THEN 1 ELSE 0 END) AS won
      FROM leads
     WHERE sector IS NOT NULL AND sector != ''
     GROUP BY sector
     HAVING total >= 3
     ORDER BY won DESC, replied DESC, total DESC
     LIMIT 15
  `).all() as any[];

  // which redesign style has been produced most, and how those leads are doing
  const styleRows = db.prepare("SELECT id, status, generated FROM leads WHERE generated NOT IN ('', '[]')").all() as any[];
  const byStyle: Record<string, { style: string; images: number; leads: number; replied: number; won: number }> = {};
  for (const row of styleRows) {
    let items: any[] = [];
    try { items = JSON.parse(row.generated || '[]'); } catch { items = []; }
    const seen = new Set<string>();
    for (const g of items) {
      const key = g.styleName || g.style || 'desconocido';
      byStyle[key] ??= { style: key, images: 0, leads: 0, replied: 0, won: 0 };
      byStyle[key].images += 1;
      if (!seen.has(key)) {
        seen.add(key);
        byStyle[key].leads += 1;
        if (row.status === 'Replied' || row.status === 'Won') byStyle[key].replied += 1;
        if (row.status === 'Won') byStyle[key].won += 1;
      }
    }
  }

  const jobStats = db.prepare(`
    SELECT type,
           COUNT(*) AS runs,
           SUM(CASE WHEN state = 'error' THEN 1 ELSE 0 END) AS errors,
           ROUND(SUM(COALESCE(credits, 0)), 2) AS credits
      FROM jobs GROUP BY type ORDER BY runs DESC
  `).all() as any[];

  const credits = db.prepare("SELECT ROUND(SUM(COALESCE(credits,0)),2) AS total FROM jobs WHERE type = 'generate'").get() as any;
  const leadsWithCost = one("SELECT COUNT(DISTINCT lead_id) AS c FROM jobs WHERE type = 'generate' AND credits IS NOT NULL");

  return Response.json({
    ok: true,
    stages,
    by_sector: bySector,
    by_style: Object.values(byStyle).sort((a, b) => b.images - a.images),
    jobs: jobStats,
    credits: {
      total: credits?.total ?? 0,
      leads_with_cost: leadsWithCost,
      avg_per_lead: leadsWithCost ? Number(((credits?.total ?? 0) / leadsWithCost).toFixed(2)) : 0,
    },
  });
};
