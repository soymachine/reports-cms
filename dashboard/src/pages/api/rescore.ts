import type { APIRoute } from 'astro';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { PROJECT_ROOT } from '../../lib/db';
import { createJob, failJob, finishJob } from '../../lib/jobs';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  let body: any = {};
  try {
    body = await request.json();
  } catch {
    /* no body is fine: score everything */
  }
  const leadId = Number(body?.lead_id) || 0;
  const dryRun = Boolean(body?.dry_run);

  const python = path.join(PROJECT_ROOT, '.venv', 'bin', 'python');
  const script = path.join(PROJECT_ROOT, 'scripts', 'score_leads.py');
  const args = [script];
  if (leadId) args.push('--lead-id', String(leadId));
  if (dryRun) args.push('--dry-run');

  const job = createJob('score', leadId || null, { lead_id: leadId, dry_run: dryRun });

  try {
    const out = execFileSync(python, [...args, '--job-id', String(job.id)], {
      cwd: PROJECT_ROOT,
      timeout: 180_000,
      encoding: 'utf-8',
      maxBuffer: 16 * 1024 * 1024,
    });
    const parsed = JSON.parse(out.trim().split('\n').filter(Boolean).pop() ?? '{}');
    finishJob(job.id, parsed);
    return Response.json({ ...parsed, job_id: job.id });
  } catch (err: any) {
    const detail = String(err?.stderr ?? err?.message ?? err).slice(-800);
    failJob(job.id, detail);
    return Response.json({ ok: false, error: detail, job_id: job.id }, { status: 500 });
  }
};
