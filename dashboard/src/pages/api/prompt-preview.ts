import type { APIRoute } from 'astro';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { PROJECT_ROOT } from '../../lib/db';

export const prerender = false;

/**
 * Returns the exact prompt that will be handed to Magnific. It shells out to
 * the same script that runs the generation, so the preview can never drift
 * from what is actually sent.
 */
export const POST: APIRoute = async ({ request }) => {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  const python = path.join(PROJECT_ROOT, '.venv', 'bin', 'python');
  const script = path.join(PROJECT_ROOT, 'scripts', 'generate_redesign.py');

  const args = [script, '0', '--pages', '1', '--pdf-slug', 'preview', '--print-prompt'];
  const push = (flag: string, value: unknown, max = 2000) => {
    const v = String(value ?? '').trim();
    if (v) args.push(flag, v.slice(0, max));
  };
  push('--style-prompt', body?.style_prompt);
  push('--extra-prompt', body?.extra_prompt);
  push('--feedback', body?.feedback, 1000);
  push('--palette', String(body?.palette ?? '').replace(/[^#0-9A-Fa-f,]/g, ''), 120);

  try {
    const out = execFileSync(python, args, { cwd: PROJECT_ROOT, timeout: 30_000, encoding: 'utf-8' });
    return Response.json(JSON.parse(out.trim().split('\n').filter(Boolean).pop() ?? '{}'));
  } catch (err: any) {
    return Response.json({ ok: false, error: String(err?.stderr || err?.message || err).slice(-400) }, { status: 500 });
  }
};
