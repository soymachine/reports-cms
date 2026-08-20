import type { APIRoute } from 'astro';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { PROJECT_ROOT } from '../../lib/db';

export const prerender = false;

/**
 * Read-only disk report. Deleting is deliberately CLI-only
 * (`python3 scripts/cleanup.py --apply`): no button should erase client work.
 */
export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const days = String(Math.max(0, Number(url.searchParams.get('days') ?? 30) || 0));
  const python = path.join(PROJECT_ROOT, '.venv', 'bin', 'python');
  const script = path.join(PROJECT_ROOT, 'scripts', 'cleanup.py');
  try {
    const out = execFileSync(python, [script, '--days', days], {
      cwd: PROJECT_ROOT, timeout: 60_000, encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024,
    });
    return Response.json(JSON.parse(out.trim().split('\n').filter(Boolean).pop() ?? '{}'));
  } catch (err: any) {
    return Response.json({ ok: false, error: String(err?.stderr || err?.message || err).slice(-500) },
      { status: 500 });
  }
};
