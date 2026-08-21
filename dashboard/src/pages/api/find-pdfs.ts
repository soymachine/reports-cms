import type { APIRoute } from 'astro';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { PROJECT_ROOT } from '../../lib/db';
import { createJob, failJob, finishJob, inFlight, setJobPid } from '../../lib/jobs';
import { getSettings } from '../../lib/settings';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }
  const leadId = Number(body?.lead_id);
  if (!leadId) return Response.json({ ok: false, error: 'missing lead_id' }, { status: 400 });

  // one search per lead at a time; a second click joins the running job
  const running = inFlight('find_pdfs', leadId);
  if (running) return Response.json({ ok: true, job_id: running.id, state: running.state, joined: true });

  const settings = getSettings();
  const max = settings.pdf_finder?.max_pdfs_per_search ?? 3;
  const minPages = settings.pdf_finder?.min_pages ?? 8;
  const crawl = settings.pdf_finder?.crawl_site !== false;

  const python = path.join(PROJECT_ROOT, '.venv', 'bin', 'python');
  const script = path.join(PROJECT_ROOT, 'scripts', 'pdf_finder.py');

  const job = createJob('find_pdfs', leadId, { max, min_pages: minPages, crawl });

  const args = [script, String(leadId), '--max', String(max), '--min-pages', String(minPages), '--job-id', String(job.id)];
  if (!crawl) args.push('--no-crawl');

  let stdout = '';
  let stderr = '';
  try {
    const child = spawn(python, args, { cwd: PROJECT_ROOT });
    setJobPid(job.id, child.pid);
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => failJob(job.id, String(err)));
    child.on('close', (code) => {
      let result: any = null;
      try {
        result = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop() ?? '');
      } catch {
        result = { raw: stdout.trim().slice(-2000) };
      }
      if (code === 0) finishJob(job.id, result);
      else failJob(job.id, stderr.trim().slice(-1000) || `exit code ${code}`, result);
    });
  } catch (err) {
    failJob(job.id, String(err));
    return Response.json({ ok: false, error: String(err), job_id: job.id }, { status: 500 });
  }

  return Response.json({ ok: true, job_id: job.id, state: 'running', lead_id: leadId });
};
