#!/usr/bin/env python3
"""db_schema.py — idempotent schema migrations for leads.db.

Safe to run any number of times. Run it after pulling changes:
    .venv/bin/python scripts/db_schema.py
"""
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "leads.db"

# column additions on `leads`: (name, definition)
LEAD_COLUMNS = [
    ("duplicate_of", "INTEGER"),          # set when a lead is flagged as a duplicate of another
    ("score_breakdown", "TEXT"),          # JSON, why the lead got its priority_score
    ("scored_at", "TEXT"),
    ("report_published_at", "TEXT"),      # newest report publication date found (ISO)
    ("website_domain", "TEXT"),           # normalised domain, natural key for dedupe
]

JOBS_TABLE = """
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,                 -- find_pdfs | render_pages | generate | score | dedupe
  lead_id INTEGER,
  state TEXT NOT NULL DEFAULT 'queued',  -- queued | running | done | error
  payload TEXT DEFAULT '{}',          -- JSON input
  result TEXT,                        -- JSON output
  error TEXT,
  credits REAL,                       -- Magnific credits consumed, when known
  created_at TEXT DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT
)
"""

INDEXES = [
    "CREATE INDEX IF NOT EXISTS idx_jobs_lead ON jobs(lead_id)",
    "CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state)",
    "CREATE INDEX IF NOT EXISTS idx_jobs_type_created ON jobs(type, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_leads_domain ON leads(website_domain)",
]


def migrate(conn: sqlite3.Connection) -> list[str]:
    applied = []
    existing = {r[1] for r in conn.execute("PRAGMA table_info(leads)")}
    for name, ddl in LEAD_COLUMNS:
        if name not in existing:
            conn.execute(f"ALTER TABLE leads ADD COLUMN {name} {ddl}")
            applied.append(f"leads.{name}")

    before = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    conn.execute(JOBS_TABLE)
    if "jobs" not in before:
        applied.append("table jobs")

    for idx in INDEXES:
        conn.execute(idx)

    conn.commit()
    return applied


def main() -> int:
    conn = sqlite3.connect(DB)
    applied = migrate(conn)
    conn.close()
    print("migraciones aplicadas:", ", ".join(applied) if applied else "ninguna (esquema al día)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
