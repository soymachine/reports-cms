import type { APIRoute } from 'astro';
import fs from 'node:fs';
import path from 'node:path';
import db, { parseLead, PROJECT_ROOT } from '../../lib/db';

export const prerender = false;

function insideProject(target: string, dir: string): boolean {
  return target.startsWith(path.join(PROJECT_ROOT, dir) + path.sep);
}

export const POST: APIRoute = async ({ request }) => {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  const leadId = Number(body?.lead_id);
  const file = String(body?.file ?? '');
  const keepGenerated = Boolean(body?.keep_generated);
  if (!leadId || !file) return Response.json({ ok: false, error: 'missing lead_id or file' }, { status: 400 });

  const row: any = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  if (!row) return Response.json({ ok: false, error: 'lead not found' }, { status: 404 });

  const safe = (raw: any) => {
    try { return JSON.parse(raw || '[]'); } catch { return []; }
  };

  const pdfs: any[] = safe(row.pdfs);
  const entry = pdfs.find((p) => p.file === file);
  if (!entry) return Response.json({ ok: false, error: 'ese PDF no pertenece a este lead' }, { status: 404 });

  // the entry came from our own DB, but re-check before touching the filesystem
  const resolved = path.resolve(PROJECT_ROOT, entry.file);
  if (!insideProject(resolved, 'pdfs')) {
    return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }

  const removedFiles: string[] = [];
  try {
    if (fs.existsSync(resolved)) {
      fs.rmSync(resolved);
      removedFiles.push(entry.file);
    }
  } catch (err) {
    return Response.json({ ok: false, error: `no se pudo borrar el archivo: ${err}` }, { status: 500 });
  }

  // rendered page images are derived from the PDF: they go with it either way
  const slug = String(entry.slug ?? '');
  if (slug) {
    const pagesDir = path.resolve(PROJECT_ROOT, 'generated', String(leadId), 'pages', slug);
    if (insideProject(pagesDir, 'generated')) {
      try { fs.rmSync(pagesDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }

  let generated: any[] = safe(row.generated);
  const attached = generated.filter((g) => g.pdf === slug);
  if (!keepGenerated && attached.length) {
    for (const g of attached) {
      for (const rel of [g.generated_img, g.original_img]) {
        if (!rel) continue;
        const abs = path.resolve(PROJECT_ROOT, rel);
        if (!insideProject(abs, 'generated')) continue;
        try {
          if (fs.existsSync(abs)) { fs.rmSync(abs); removedFiles.push(rel); }
        } catch { /* best effort */ }
      }
    }
    generated = generated.filter((g) => g.pdf !== slug);
  }

  const remaining = pdfs.filter((p) => p.file !== file);
  const timeline: any[] = safe(row.timeline);
  timeline.push({
    type: 'pdf_deleted',
    text: `PDF eliminado: ${entry.title || entry.file}` +
      (attached.length ? ` (${attached.length} rediseño(s) ${keepGenerated ? 'conservados' : 'eliminados'})` : ''),
    date: new Date().toISOString(),
  });

  // the timing radar follows the newest surviving report
  const dates = remaining.map((p) => p.published_at).filter(Boolean).sort();
  db.prepare(
    `UPDATE leads SET pdfs = ?, generated = ?, timeline = ?, report_published_at = ?,
            updated_at = datetime('now')
      WHERE id = ?`
  ).run(
    JSON.stringify(remaining),
    JSON.stringify(generated),
    JSON.stringify(timeline),
    dates.length ? dates[dates.length - 1] : null,
    leadId
  );

  const lead = parseLead(db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId));
  return Response.json({
    ok: true,
    removed_files: removedFiles.length,
    generated_removed: keepGenerated ? 0 : attached.length,
    lead,
  });
};
