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

# El historial del cazador nocturno. Lo escribía el agente de Hermes desde fuera
# del repo, así que la tabla nunca se creó aquí y en una máquina nueva no existía:
# los endpoints que la leen van envueltos en try/catch por eso mismo.
CRON_HISTORY_TABLE = """
CREATE TABLE IF NOT EXISTS cron_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT NOT NULL,                  -- lead_hunter
  ran_at TEXT DEFAULT (datetime('now')),
  summary TEXT,                       -- una línea legible: qué encontró
  detail TEXT                         -- JSON: consultas, candidatos, descartes
)
"""

INDEXES = [
    "CREATE INDEX IF NOT EXISTS idx_jobs_lead ON jobs(lead_id)",
    "CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state)",
    "CREATE INDEX IF NOT EXISTS idx_jobs_type_created ON jobs(type, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_leads_domain ON leads(website_domain)",
    "CREATE INDEX IF NOT EXISTS idx_cron_history_ran ON cron_history(ran_at DESC)",
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

    conn.execute(CRON_HISTORY_TABLE)
    if "cron_history" not in before:
        applied.append("table cron_history")

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
