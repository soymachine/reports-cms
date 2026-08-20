import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The project root is wherever leads.db and settings.json live. It used to be
 * hardcoded as `cwd/..`, which silently created an empty database one directory
 * above whenever the server was started from anywhere but the dashboard folder.
 */
function findRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'leads.db')) && fs.existsSync(path.join(dir, 'settings.json'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(process.cwd(), '..');   // the old assumption, as a last resort
}

export const PROJECT_ROOT = findRoot();
const DB_PATH = path.join(PROJECT_ROOT, 'leads.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Keep the schema in step with scripts/db_schema.py — the dashboard and the
// python jobs share this database and either one may boot first.
db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    lead_id INTEGER,
    state TEXT NOT NULL DEFAULT 'queued',
    payload TEXT DEFAULT '{}',
    result TEXT,
    error TEXT,
    credits REAL,
    created_at TEXT DEFAULT (datetime('now')),
    started_at TEXT,
    finished_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_lead ON jobs(lead_id);
  CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state);
  CREATE INDEX IF NOT EXISTS idx_jobs_type_created ON jobs(type, created_at DESC);

  -- custom redesign styles: global when lead_id is null, client-specific otherwise
  CREATE TABLE IF NOT EXISTS style_presets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    lead_id INTEGER,
    derived_from TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_presets_lead ON style_presets(lead_id);
`);
for (const [col, type] of [
  ['duplicate_of', 'INTEGER'], ['score_breakdown', 'TEXT'], ['scored_at', 'TEXT'],
  ['report_published_at', 'TEXT'], ['website_domain', 'TEXT'],
] as const) {
  try {
    db.exec(`ALTER TABLE leads ADD COLUMN ${col} ${type}`);
  } catch {
    /* already there */
  }
}

export default db;

function safeJson<T>(raw: unknown, fallback: T): T {
  if (raw == null || raw === '') return fallback;
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return fallback;
  }
}

export function parseLead(row: any) {
  if (!row) return row;
  return {
    ...row,
    pdfs: safeJson(row.pdfs, [] as any[]),
    generated: safeJson(row.generated, [] as any[]),
    timeline: safeJson(row.timeline, [] as any[]),
  };
}
