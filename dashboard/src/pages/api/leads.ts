import type { APIRoute } from 'astro';
import fs from 'node:fs';
import path from 'node:path';
import db, { parseLead, PROJECT_ROOT } from '../../lib/db';

export const prerender = false;

const SORTABLE = new Set([
  'rank', 'organisation', 'priority', 'priority_score', 'sector', 'country',
  'status', 'updated_at', 'created_at', 'contact1_name', 'pdfs',
]);

const PATCHABLE = new Set([
  'status', 'notes', 'next_action', 'priority', 'email_draft', 'last_contacted',
  'organisation', 'sector', 'country', 'city', 'type', 'relationship', 'rationale',
  'services', 'website', 'linkedin', 'contact1_name', 'contact1_title', 'contact1_email',
  'contact2_name', 'contact2_title', 'contact2_email', 'general_email', 'email_confidence',
  'pdfs', 'generated', 'timeline', 'source',
]);

const CREATABLE = new Set([
  'organisation', 'priority', 'priority_score', 'rank', 'status', 'sector', 'country', 'city',
  'type', 'relationship', 'rationale', 'services', 'website', 'linkedin',
  'contact1_name', 'contact1_title', 'contact1_email',
  'contact2_name', 'contact2_title', 'contact2_email',
  'general_email', 'email_confidence', 'contact_source_url', 'source_urls',
  'next_action', 'notes', 'source',
]);

const JSON_FIELDS = new Set(['pdfs', 'generated', 'timeline']);

function buildFilters(url: URL) {
  const where: string[] = [];
  const params: any[] = [];
  const q = url.searchParams.get('q')?.trim();
  if (q) {
    where.push('(organisation LIKE ? OR sector LIKE ? OR country LIKE ? OR city LIKE ? OR contact1_name LIKE ? OR notes LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like, like, like);
  }
  for (const key of ['priority', 'sector', 'country', 'source', 'status'] as const) {
    const v = url.searchParams.get(key)?.trim();
    if (v) {
      where.push(`${key} = ?`);
      params.push(v);
    }
  }
  return { where, params };
}

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const { where, params } = buildFilters(url);

  let sql = 'SELECT * FROM leads';
  if (where.length) sql += ' WHERE ' + where.join(' AND ');

  const sort = url.searchParams.get('sort') || 'rank';
  const dir = url.searchParams.get('dir') === 'desc' ? 'DESC' : 'ASC';
  const col = SORTABLE.has(sort) ? sort : 'rank';
  const orderExpr = col === 'pdfs' ? 'json_array_length(pdfs)' : col;
  sql += ` ORDER BY ${orderExpr} ${dir} NULLS LAST, id ASC`;

  const rows = db.prepare(sql).all(...params).map(parseLead);
  return Response.json({ leads: rows, count: rows.length });
};

export const POST: APIRoute = async ({ request }) => {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  const organisation = String(body?.organisation ?? '').trim();
  if (!organisation) return Response.json({ ok: false, error: 'organisation es obligatorio' }, { status: 400 });

  const cols: string[] = [];
  const placeholders: string[] = [];
  const params: any[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (!CREATABLE.has(key)) continue;
    if (value === '' || value === null || value === undefined) continue;
    cols.push(key);
    placeholders.push('?');
    params.push(key === 'organisation' ? organisation : value);
  }
  if (!cols.includes('source')) {
    cols.push('source');
    placeholders.push('?');
    params.push('manual');
  }

  const timeline = JSON.stringify([
    { type: 'created', text: 'Lead creado manualmente desde el dashboard', date: new Date().toISOString() },
  ]);
  cols.push('timeline');
  placeholders.push('?');
  params.push(timeline);

  const info = db
    .prepare(`INSERT INTO leads (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`)
    .run(...params);

  const lead = parseLead(db.prepare('SELECT * FROM leads WHERE id = ?').get(info.lastInsertRowid));
  return Response.json({ ok: true, lead }, { status: 201 });
};

export const PATCH: APIRoute = async ({ request }) => {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }
  const id = Number(body?.id);
  if (!id) return Response.json({ ok: false, error: 'missing id' }, { status: 400 });

  const sets: string[] = [];
  const params: any[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (key === 'id' || !PATCHABLE.has(key)) continue;
    sets.push(`${key} = ?`);
    params.push(JSON_FIELDS.has(key) && typeof value !== 'string' ? JSON.stringify(value ?? []) : value);
  }
  if (!sets.length) return Response.json({ ok: false, error: 'no patchable fields' }, { status: 400 });

  sets.push("updated_at = datetime('now')");
  const info = db.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
  if (info.changes === 0) return Response.json({ ok: false, error: 'lead not found' }, { status: 404 });

  const lead = parseLead(db.prepare('SELECT * FROM leads WHERE id = ?').get(id));
  return Response.json({ ok: true, lead });
};

/** Removes the lead's own asset folders (pdfs/{id}, generated/{id}). */
function removeLeadAssets(id: number) {
  for (const dir of ['pdfs', 'generated']) {
    const target = path.join(PROJECT_ROOT, dir, String(id));
    // stay inside the expected parent, never follow a crafted path
    if (!target.startsWith(path.join(PROJECT_ROOT, dir) + path.sep)) continue;
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch {
      /* asset cleanup is best-effort; the row is already gone */
    }
  }
}

export const DELETE: APIRoute = async ({ request }) => {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  const raw = Array.isArray(body?.ids) ? body.ids : [body?.id];
  const ids = raw.map((v: any) => Number(v)).filter((n: number) => Number.isInteger(n) && n > 0);
  if (!ids.length) return Response.json({ ok: false, error: 'missing id or ids' }, { status: 400 });

  const placeholders = ids.map(() => '?').join(', ');
  const existing = (db.prepare(`SELECT id FROM leads WHERE id IN (${placeholders})`).all(...ids) as any[]).map((r) => r.id);
  if (!existing.length) return Response.json({ ok: false, error: 'lead(s) not found' }, { status: 404 });

  const info = db.prepare(`DELETE FROM leads WHERE id IN (${placeholders})`).run(...ids);
  for (const id of existing) removeLeadAssets(id);

  return Response.json({ ok: true, deleted: info.changes, ids: existing });
};
