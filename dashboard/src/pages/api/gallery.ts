import type { APIRoute } from 'astro';
import db from '../../lib/db';

export const prerender = false;

/** Page renders were always written with a thumb-N.png sibling: reuse it. */
function originalThumb(rel: string | undefined): string | null {
  if (!rel) return null;
  const m = rel.match(/^(.*)\/full-(\d+)\.png$/);
  return m ? `${m[1]}/thumb-${m[2]}.png` : null;
}

/** Every generated pair across all leads: the studio's internal portfolio. */
export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const style = url.searchParams.get('style') ?? '';
  const sector = url.searchParams.get('sector') ?? '';
  const status = url.searchParams.get('status') ?? '';
  const heroOnly = url.searchParams.get('hero') === '1';
  const includeOld = url.searchParams.get('versions') === 'all';
  const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 600);

  const where: string[] = ["generated NOT IN ('', '[]')", 'generated IS NOT NULL'];
  const params: any[] = [];
  if (sector) { where.push('sector = ?'); params.push(sector); }
  if (status) { where.push('status = ?'); params.push(status); }

  const rows = db
    .prepare(`SELECT id, organisation, sector, country, status, priority, generated FROM leads WHERE ${where.join(' AND ')}`)
    .all(...params) as any[];

  const items: any[] = [];
  const styles = new Map<string, number>();

  for (const row of rows) {
    let generated: any[] = [];
    try { generated = JSON.parse(row.generated || '[]'); } catch { generated = []; }
    for (const g of generated) {
      if (!g.generated_img) continue;
      styles.set(g.styleName || g.style, (styles.get(g.styleName || g.style) ?? 0) + 1);
      if (style && g.style !== style && g.styleName !== style) continue;
      if (heroOnly && !g.hero) continue;
      if (!includeOld && g.superseded) continue;
      items.push({
        lead_id: row.id,
        organisation: row.organisation,
        sector: row.sector,
        country: row.country,
        status: row.status,
        priority: row.priority,
        page: g.page,
        pdf: g.pdf,
        style: g.style,
        styleName: g.styleName,
        original_img: g.original_img,
        generated_img: g.generated_img,
        // light versions for the grid; the modal still loads the full images
        thumb: g.thumb ?? null,
        original_thumb: originalThumb(g.original_img),
        hero: Boolean(g.hero),
        version: g.version ?? 1,
        superseded: Boolean(g.superseded),
        qc: g.qc ?? null,
        created_at: g.created_at ?? null,
      });
    }
  }

  items.sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));

  return Response.json({
    ok: true,
    count: items.length,
    items: items.slice(0, limit),
    styles: [...styles.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
  });
};
