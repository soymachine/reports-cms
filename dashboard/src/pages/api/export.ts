import type { APIRoute } from 'astro';
import db from '../../lib/db';

export const prerender = false;

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const where: string[] = [];
  const params: any[] = [];

  const q = url.searchParams.get('q')?.trim();
  if (q) {
    where.push('(organisation LIKE ? OR sector LIKE ? OR country LIKE ? OR city LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  for (const key of ['priority', 'sector', 'country', 'source', 'status'] as const) {
    const v = url.searchParams.get(key)?.trim();
    if (v) {
      where.push(`${key} = ?`);
      params.push(v);
    }
  }

  let sql = 'SELECT * FROM leads';
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY rank ASC NULLS LAST, id ASC';

  const rows = db.prepare(sql).all(...params) as any[];

  const cols = [
    'id', 'rank', 'priority_score', 'priority', 'organisation', 'country', 'city',
    'sector', 'type', 'relationship', 'website', 'linkedin',
    'contact1_name', 'contact1_title', 'contact1_email',
    'contact2_name', 'contact2_title', 'contact2_email',
    'general_email', 'email_confidence', 'status', 'last_contacted',
    'next_action', 'source', 'created_at', 'updated_at',
  ];

  const lines = [cols.join(',')];
  for (const r of rows) {
    lines.push(cols.map((c) => csvCell(r[c])).join(','));
  }

  return new Response(lines.join('\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="thinkthings-leads-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
};
