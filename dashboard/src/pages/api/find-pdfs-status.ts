import type { APIRoute } from 'astro';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../../lib/db';

export const prerender = false;

const STATUS_FILE = path.join(PROJECT_ROOT, '.pdfsearch_status.json');

export const GET: APIRoute = async () => {
  try {
    const raw = fs.readFileSync(STATUS_FILE, 'utf-8');
    return Response.json(JSON.parse(raw));
  } catch {
    return Response.json({ state: 'idle' });
  }
};
