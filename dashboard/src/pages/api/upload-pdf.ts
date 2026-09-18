import type { APIRoute } from 'astro';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import db, { parseLead, PROJECT_ROOT } from '../../lib/db';

export const prerender = false;

const MAX_MB = 60;
// several sites answer 403 to a bare fetch; this is the one pdf_finder.py uses
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function safeName(name: string): string {
  const base = name.split('/').pop()?.split('\\').pop() ?? 'documento.pdf';
  let clean = base.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
  if (!clean.toLowerCase().endsWith('.pdf')) clean += '.pdf';
  return clean;
}

function slugify(fileName: string): string {
  return fileName.replace(/\.pdf$/i, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
}

/** A name nothing else in this lead's folder is using yet. */
function freeName(destDir: string, wanted: string): string {
  let fname = safeName(wanted);
  while (fs.existsSync(path.join(destDir, fname))) {
    fname = `${slugify(fname)}-${Date.now().toString(36)}.pdf`;
  }
  return fname;
}

/**
 * Pages, visual ratio and publication date, the same ones the automatic search
 * records — without them the card shows no page count and the radar has no date.
 * Best effort: the PDF is already saved and usable if this cannot run.
 */
function enrichMeta() {
  try {
    execFileSync(path.join(PROJECT_ROOT, '.venv', 'bin', 'python'),
      [path.join(PROJECT_ROOT, 'scripts', 'backfill_pdf_meta.py')],
      { cwd: PROJECT_ROOT, timeout: 120_000, encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024 });
  } catch {
    /* the entry simply keeps the fields it was created with */
  }
}

function leadRow(leadId: number) {
  return db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId) as any;
}

function commit(leadId: number, pdfs: any[], note: string) {
  const row = leadRow(leadId);
  const timeline: any[] = JSON.parse(row.timeline || '[]');
  timeline.push({ type: 'pdf_upload', text: note, date: new Date().toISOString() });
  db.prepare("UPDATE leads SET pdfs = ?, timeline = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(pdfs), JSON.stringify(timeline), leadId);
  enrichMeta();
  return parseLead(leadRow(leadId));
}

/** Adding PDFs by hand: the files are already on disk. */
export const POST: APIRoute = async ({ request }) => {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ ok: false, error: 'se esperaba multipart/form-data' }, { status: 400 });
  }

  const leadId = Number(form.get('lead_id'));
  if (!leadId) return Response.json({ ok: false, error: 'missing lead_id' }, { status: 400 });

  const row = leadRow(leadId);
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

    const fname = freeName(destDir, file.name);
    fs.writeFileSync(path.join(destDir, fname), Buffer.from(await file.arrayBuffer()));

    const entry = {
      file: `pdfs/${leadId}/${fname}`,
      slug: slugify(fname),
      url: String(form.get('url') ?? ''),
      title: String(form.get('title') ?? '') || file.name.replace(/\.pdf$/i, ''),
      downloaded_at: new Date().toISOString(),
      source: 'manual',
    };
    existing.push(entry);
    added.push(entry);
  }

  const lead = commit(leadId, existing, `${added.length} PDF(s) añadidos a mano`);
  return Response.json({ ok: true, added: added.length, lead });
};

/** Never let the dashboard fetch something on the machine's own network. */
function publicUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  const blocked =
    host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') ||
    host === '::1' || host === '0.0.0.0' ||
    /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  return blocked ? null : u;
}

/**
 * Adding a PDF the team found online: the dashboard downloads it itself, so
 * nobody has to save it to disk and pick it again from the file dialog.
 */
export const PUT: APIRoute = async ({ request }) => {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  const leadId = Number(body?.lead_id);
  if (!leadId) return Response.json({ ok: false, error: 'missing lead_id' }, { status: 400 });

  const row = leadRow(leadId);
  if (!row) return Response.json({ ok: false, error: 'lead not found' }, { status: 404 });

  const target = publicUrl(String(body?.url ?? ''));
  if (!target) {
    return Response.json({ ok: false, error: 'la dirección no es un http(s) público válido' }, { status: 400 });
  }

  const existing: any[] = JSON.parse(row.pdfs || '[]');
  if (existing.some((p) => p.url === target.href)) {
    return Response.json({ ok: false, error: 'ese PDF ya está en el lead' }, { status: 409 });
  }

  let buf: Buffer;
  try {
    const res = await fetch(target, {
      headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*' },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      return Response.json({ ok: false, error: `el servidor respondió ${res.status}` }, { status: 400 });
    }
    const raw = await res.arrayBuffer();
    if (raw.byteLength > MAX_MB * 1024 * 1024) {
      return Response.json({ ok: false, error: `el archivo supera los ${MAX_MB} MB` }, { status: 413 });
    }
    buf = Buffer.from(raw);
  } catch (err: any) {
    const why = err?.name === 'TimeoutError' ? 'la descarga tardó demasiado' : String(err?.message ?? err);
    return Response.json({ ok: false, error: `no se pudo descargar: ${why}` }, { status: 400 });
  }

  // servers lie about content-type, so the magic bytes decide
  if (!buf.subarray(0, 1024).includes(Buffer.from('%PDF'))) {
    return Response.json({ ok: false, error: 'lo que hay en esa dirección no es un PDF' }, { status: 415 });
  }

  const destDir = path.join(PROJECT_ROOT, 'pdfs', String(leadId));
  fs.mkdirSync(destDir, { recursive: true });
  const fname = freeName(destDir, decodeURIComponent(target.pathname.split('/').pop() || 'documento.pdf'));
  fs.writeFileSync(path.join(destDir, fname), buf);

  const entry = {
    file: `pdfs/${leadId}/${fname}`,
    slug: slugify(fname),
    url: target.href,
    title: String(body?.title ?? '').trim() || fname.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' '),
    downloaded_at: new Date().toISOString(),
    source: 'manual',
  };
  existing.push(entry);

  const lead = commit(leadId, existing, `PDF añadido desde ${target.hostname}`);
  // commit() enriches pages and dates, so report the stored entry, not the draft
  const saved = (lead?.pdfs ?? []).find((p: any) => p.file === entry.file) ?? entry;
  return Response.json({ ok: true, added: 1, entry: saved, lead });
};
