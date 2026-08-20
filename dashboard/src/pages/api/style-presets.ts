import type { APIRoute } from 'astro';
import db from '../../lib/db';
import { getSettings } from '../../lib/settings';

export const prerender = false;

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);

/** Built-in presets from settings.json plus the custom ones stored in the DB. */
export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const leadId = Number(url.searchParams.get('lead_id')) || null;

  const builtin = (getSettings().redesign?.style_presets ?? []).map((p) => ({ ...p, source: 'builtin' as const, lead_id: null }));

  const custom = db
    .prepare(
      `SELECT id, name, prompt, lead_id, derived_from FROM style_presets
        WHERE lead_id IS NULL OR lead_id = ?
        ORDER BY lead_id IS NULL DESC, name`
    )
    .all(leadId) as any[];

  return Response.json({
    ok: true,
    presets: [...builtin, ...custom.map((c) => ({ ...c, source: c.lead_id ? 'lead' : 'custom' }))],
  });
};

export const POST: APIRoute = async ({ request }) => {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  const name = String(body?.name ?? '').trim();
  const prompt = String(body?.prompt ?? '').trim();
  if (!name || !prompt) return Response.json({ ok: false, error: 'name y prompt son obligatorios' }, { status: 400 });

  const leadId = Number(body?.lead_id) || null;
  const derivedFrom = body?.derived_from ? String(body.derived_from).slice(0, 32) : null;

  // ids must stay unique across builtin + custom: suffix on collision
  const builtinIds = new Set((getSettings().redesign?.style_presets ?? []).map((p) => p.id));
  let id = body?.id ? slug(String(body.id)) : slug(name);
  if (!id) id = `custom-${Date.now().toString(36)}`;
  const exists = (candidate: string) =>
    builtinIds.has(candidate) || Boolean(db.prepare('SELECT 1 FROM style_presets WHERE id = ?').get(candidate));
  if (exists(id) && !body?.overwrite) {
    let i = 2;
    while (exists(`${id}-${i}`)) i += 1;
    id = `${id}-${i}`;
  }

  db.prepare(
    `INSERT INTO style_presets (id, name, prompt, lead_id, derived_from) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, prompt = excluded.prompt, lead_id = excluded.lead_id`
  ).run(id, name.slice(0, 64), prompt.slice(0, 2000), leadId, derivedFrom);

  const preset = db.prepare('SELECT id, name, prompt, lead_id, derived_from FROM style_presets WHERE id = ?').get(id);
  return Response.json({ ok: true, preset }, { status: 201 });
};

export const DELETE: APIRoute = async ({ request }) => {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }
  const id = String(body?.id ?? '');
  if (!id) return Response.json({ ok: false, error: 'missing id' }, { status: 400 });

  const info = db.prepare('DELETE FROM style_presets WHERE id = ?').run(id);
  if (!info.changes) {
    return Response.json({ ok: false, error: 'ese estilo no existe o es de los predefinidos' }, { status: 404 });
  }
  return Response.json({ ok: true, deleted: id });
};
