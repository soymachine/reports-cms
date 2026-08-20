import { spawn } from 'node:child_process';
import db from './db';
import { getSettings } from './settings';
import { failJob, finishJob, getJob, type Job, type JobType } from './jobs';

/**
 * A real queue for the long jobs.
 *
 * Generation used to be spawned straight from the HTTP handler: nothing capped
 * how many agents ran at once (four styles times N leads is N processes burning
 * credits in parallel), and a dashboard restart left rows stuck in `running`
 * forever because nobody was watching the child any more.
 *
 * The worker lives in the Astro server process — the only long-lived one here —
 * and keeps at most `jobs.max_concurrent` children alive. Every child's pid is
 * stored, so a job can be cancelled and, on boot, anything whose process is gone
 * is closed honestly instead of pretending to still run.
 */

const TICK_MS = 1000;

// columns the original schema did not have; added here so either process may boot first
for (const [col, decl] of [
  ['command', 'TEXT'],
  ['pid', 'INTEGER'],
  ['queued_at', 'TEXT'],
] as const) {
  try {
    db.exec(`ALTER TABLE jobs ADD COLUMN ${col} ${decl}`);
  } catch {
    /* already there */
  }
}

/** Placeholder replaced with the row id when the job starts. */
export const JOB_ID_TOKEN = '{{JOB_ID}}';

export interface QueuedCommand {
  file: string;
  /** may contain JOB_ID_TOKEN: the id only exists once the row is written */
  args: string[];
  cwd?: string;
  /** minutes after which the child is killed; generation runs are long */
  timeoutMin?: number;
}

export function maxConcurrent(): number {
  const n = Number(getSettings().jobs?.max_concurrent ?? 2);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 8) : 2;
}

/** Put a job in the queue. It starts when a worker slot frees up. */
export function enqueue(
  type: JobType,
  leadId: number | null,
  payload: Record<string, unknown>,
  command: QueuedCommand,
): Job {
  const info = db
    .prepare(
      `INSERT INTO jobs (type, lead_id, state, payload, command, queued_at)
       VALUES (?, ?, 'queued', ?, ?, datetime('now'))`,
    )
    .run(type, leadId, JSON.stringify(payload), JSON.stringify(command));
  const job = getJob(Number(info.lastInsertRowid))!;
  setTimeout(tick, 0);
  return job;
}

export function queueDepth(): { queued: number; running: number; max: number } {
  const row = db
    .prepare(
      `SELECT SUM(state = 'queued') AS queued, SUM(state = 'running') AS running FROM jobs
        WHERE state IN ('queued','running')`,
    )
    .get() as any;
  return { queued: row?.queued ?? 0, running: row?.running ?? 0, max: maxConcurrent() };
}

/** Stop a job: kills the process when it is already running. */
export function cancel(id: number): { ok: boolean; error?: string } {
  const job = getJob(id);
  if (!job) return { ok: false, error: 'job not found' };
  if (job.state === 'done' || job.state === 'error') return { ok: false, error: 'ya había terminado' };

  const pid = (db.prepare('SELECT pid FROM jobs WHERE id = ?').get(id) as any)?.pid;
  if (pid && alive(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* it just died */
    }
  }
  failJob(id, 'cancelado desde el panel');
  return { ok: true };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 only probes
    return true;
  } catch {
    return false;
  }
}

/**
 * Close jobs whose process no longer exists. Runs once when the module loads —
 * i.e. on every dashboard boot — so a restart mid-generation does not leave a
 * row spinning forever in the UI.
 */
export function reconcile(): number {
  const rows = db
    .prepare("SELECT id, pid FROM jobs WHERE state = 'running'")
    .all() as { id: number; pid: number | null }[];
  let closed = 0;
  for (const row of rows) {
    if (row.pid && alive(row.pid)) continue;
    failJob(row.id, 'interrumpido: el proceso ya no existe (reinicio del dashboard)');
    closed++;
  }
  return closed;
}

let ticking = false;

/** Start as many queued jobs as the concurrency cap allows. */
export function tick(): void {
  if (ticking) return;
  ticking = true;
  try {
    const { running, max } = queueDepth();
    let free = max - running;
    if (free <= 0) return;

    const next = db
      .prepare("SELECT id FROM jobs WHERE state = 'queued' ORDER BY id ASC LIMIT ?")
      .all(free) as { id: number }[];
    for (const row of next) {
      if (free-- <= 0) break;
      start(row.id);
    }
  } finally {
    ticking = false;
  }
}

function start(id: number): void {
  const row = db.prepare('SELECT command FROM jobs WHERE id = ?').get(id) as any;
  let command: QueuedCommand;
  try {
    command = JSON.parse(row?.command ?? '');
  } catch {
    failJob(id, 'job sin comando: no se puede ejecutar');
    return;
  }

  const args = command.args.map((a) => a.split(JOB_ID_TOKEN).join(String(id)));

  let child;
  try {
    child = spawn(command.file, args, { cwd: command.cwd ?? process.cwd() });
  } catch (err) {
    failJob(id, String(err));
    return;
  }

  db.prepare("UPDATE jobs SET state = 'running', pid = ?, started_at = datetime('now') WHERE id = ?")
    .run(child.pid ?? null, id);

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d.toString()));
  child.stderr.on('data', (d) => (stderr += d.toString()));

  const limit = (command.timeoutMin ?? 30) * 60_000;
  const killer = setTimeout(() => {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }, limit);

  child.on('error', (err) => {
    clearTimeout(killer);
    failJob(id, String(err));
    setTimeout(tick, 0);
  });

  child.on('close', (code) => {
    clearTimeout(killer);
    let result: any = null;
    try {
      result = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop() ?? '');
    } catch {
      result = { raw: stdout.trim().slice(-2000) };
    }
    // the job row may already be closed: the script writes its own outcome, and a
    // cancel marks it as an error before the process exits
    const state = (db.prepare('SELECT state FROM jobs WHERE id = ?').get(id) as any)?.state;
    if (state === 'running') {
      if (code === 0) finishJob(id, result, result?.credits ?? result?.credits_used ?? null);
      else failJob(id, stderr.trim().slice(-1000) || `exit code ${code}`, result);
    }
    setTimeout(tick, 0);
  });
}

// boot: clean up after the previous process, then keep the queue moving
const closed = reconcile();
if (closed) console.log(`[queue] ${closed} job(s) huérfanos cerrados`);
const timer = setInterval(tick, TICK_MS);
// never hold the process open just for the poller
if (typeof timer.unref === 'function') timer.unref();
tick();
