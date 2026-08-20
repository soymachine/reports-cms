import db from './db';

export type JobType = 'find_pdfs' | 'render_pages' | 'generate' | 'score' | 'dedupe';
export type JobState = 'queued' | 'running' | 'done' | 'error';

export interface Job {
  id: number;
  type: JobType;
  lead_id: number | null;
  state: JobState;
  payload: any;
  result: any;
  error: string | null;
  credits: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

function parse(row: any): Job | null {
  if (!row) return null;
  const safe = (raw: any) => {
    if (raw == null || raw === '') return null;
    try { return JSON.parse(String(raw)); } catch { return { raw: String(raw) }; }
  };
  return { ...row, payload: safe(row.payload) ?? {}, result: safe(row.result) };
}

/** Creates a job row in `running` state and returns it. */
export function createJob(type: JobType, leadId: number | null, payload: Record<string, unknown> = {}): Job {
  const info = db
    .prepare(
      `INSERT INTO jobs (type, lead_id, state, payload, started_at)
       VALUES (?, ?, 'running', ?, datetime('now'))`
    )
    .run(type, leadId, JSON.stringify(payload));
  return getJob(Number(info.lastInsertRowid))!;
}

export function getJob(id: number): Job | null {
  return parse(db.prepare('SELECT * FROM jobs WHERE id = ?').get(id));
}

export function finishJob(id: number, result: unknown, credits?: number | null) {
  db.prepare(
    `UPDATE jobs SET state = 'done', result = ?, credits = COALESCE(?, credits),
            finished_at = datetime('now') WHERE id = ?`
  ).run(JSON.stringify(result ?? null), credits ?? null, id);
}

export function failJob(id: number, error: string, result?: unknown) {
  db.prepare(
    `UPDATE jobs SET state = 'error', error = ?, result = COALESCE(?, result),
            finished_at = datetime('now') WHERE id = ?`
  ).run(String(error).slice(0, 4000), result === undefined ? null : JSON.stringify(result), id);
}

/** Jobs still running, oldest first — what the "Trabajos" panel shows. */
export function activeJobs(): Job[] {
  return (db
    .prepare("SELECT * FROM jobs WHERE state IN ('queued','running') ORDER BY created_at ASC")
    .all() as any[])
    .map(parse) as Job[];
}

export function recentJobs(limit = 30): Job[] {
  return (db
    .prepare('SELECT * FROM jobs ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(limit) as any[])
    .map(parse) as Job[];
}

/** A same-type job already in flight for this lead, if any: prevents double clicks. */
export function inFlight(type: JobType, leadId: number): Job | null {
  return parse(
    db.prepare("SELECT * FROM jobs WHERE type = ? AND lead_id = ? AND state IN ('queued','running') ORDER BY id DESC LIMIT 1")
      .get(type, leadId)
  );
}

/** Anything still marked running after `minutes` is stale — the process died. */
export function reapStale(minutes = 45): number {
  const info = db
    .prepare(
      `UPDATE jobs SET state = 'error', error = 'el proceso no terminó (timeout)',
              finished_at = datetime('now')
        WHERE state IN ('queued','running')
          AND started_at IS NOT NULL
          AND started_at < datetime('now', ?)`
    )
    .run(`-${minutes} minutes`);
  return info.changes;
}
