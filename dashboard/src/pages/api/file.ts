import type { APIRoute } from 'astro';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../../lib/db';

export const prerender = false;

const ALLOWED_DIRS = ['pdfs', 'generated'];

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
};

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const rel = url.searchParams.get('path') ?? '';
  if (!rel) return new Response('missing path', { status: 400 });

  // path traversal protection: only serve from pdfs/ and generated/
  const resolved = path.resolve(PROJECT_ROOT, rel);
  const allowed = ALLOWED_DIRS.some((d) => resolved.startsWith(path.join(PROJECT_ROOT, d) + path.sep));
  if (!allowed) return new Response('forbidden', { status: 403 });

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    return new Response('not found', { status: 404 });
  }

  const ext = path.extname(resolved).toLowerCase();
  const type = CONTENT_TYPES[ext] ?? 'application/octet-stream';
  const data = fs.readFileSync(resolved);
  return new Response(data, {
    headers: { 'Content-Type': type, 'Cache-Control': 'no-cache' },
  });
};
