import type { APIRoute } from 'astro';
import fs from 'node:fs';
import path from 'node:path';
import db, { parseLead, PROJECT_ROOT } from '../../lib/db';

export const prerender = false;

const MAX_MB = 60;

function safeName(name: string): string {
  const base = name.split('/').pop()?.split('\\').pop() ?? 'documento.pdf';
  let clean = base.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
  if (!clean.toLowerCase().endsWith('.pdf')) clean += '.pdf';
  return clean;
}

function slugify(fileName: string): string {
  return fileName.replace(/\.pdf$/i, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
}

export const POST: APIRoute = async ({ request }) => {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ ok: false, error: 'se esperaba multipart/form-data' }, { status: 400 });
  }

  const leadId = Number(form.get('lead_id'));
  if (!leadId) return Response.json({ ok: false, error: 'missing lead_id' }, { status: 400 });

  const row: any = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  if (!row) return Response.json({ ok: false, error: 'lead not found' }, { status: 404 });

  const files = form.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);
  if (!files.length) return Response.json({ ok: false, error: 'no se recibió ningún archivo' }, { status: 400 });

  const destDir = path.join(PROJECT_ROOT, 'pdfs', String(leadId));
  fs.mkdirSync(destDir, { recursive: true });

  const existing: any[] = JSON.parse(row.pdfs || '[]');
  const added: any[] = [];

  for (const file of files) {
    if (file.size > MAX_MB * 1024 * 1024) {
      return Response.json({ ok: false, error: `${file.name} supera los ${MAX_MB} MB` }, { status: 413 });
    }
    if (file.type && file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      return Response.json({ ok: false, error: `${file.name} no es un PDF` }, { status: 415 });
    }

    // avoid clobbering an existing file with the same name
    let fname = safeName(file.name);
    while (fs.existsSync(path.join(destDir, fname))) {
      fname = `${slugify(fname)}-${Date.now().toString(36)}.pdf`;
    }

    const buf = Buffer.from(await file.arrayBuffer());
    fs.writeFileSync(path.join(destDir, fname), buf);

    const entry = {
      file: `pdfs/${leadId}/${fname}`,
      slug: slugify(fname),
      url: String(form.get('url') ?? ''),
      title: String(form.get('title') ?? '') || file.name.replace(/\.pdf$/i, ''),
      downloaded_at: new Date().toISOString(),
    };
    existing.push(entry);
    added.push(entry);
  }

  const timeline: any[] = JSON.parse(row.timeline || '[]');
  timeline.push({
    type: 'pdf_upload',
    text: `${added.length} PDF(s) añadidos manualmente`,
    date: new Date().toISOString(),
  });

  db.prepare("UPDATE leads SET pdfs = ?, timeline = ?, updated_at = datetime('now') WHERE id = ?").run(
    JSON.stringify(existing),
    JSON.stringify(timeline),
    leadId
  );

  const lead = parseLead(db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId));
  return Response.json({ ok: true, added: added.length, lead });
};
