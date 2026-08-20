"""Import thinkthings_eu_associations_prospect_database.xlsx into leads.db.

Idempotent: skips organisations already present (by normalised name).
Usage: .venv/bin/python scripts/import_excel.py
"""
import json
import re
import sqlite3
import sys
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "leads.db"
XLSX = ROOT / "documentacion" / "thinkthings_eu_associations_prospect_database.xlsx"

SCHEMA = """
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rank INTEGER,
  priority_score INTEGER,
  priority TEXT,                 -- A - Hot / B - Strong / C - Medium / D - Long list
  organisation TEXT NOT NULL,
  country TEXT,
  city TEXT,
  sector TEXT,
  type TEXT,
  relationship TEXT,             -- relationship to Think Things
  rationale TEXT,
  services TEXT,
  website TEXT,
  linkedin TEXT,
  contact1_name TEXT,
  contact1_title TEXT,
  contact1_email TEXT,
  contact2_name TEXT,
  contact2_title TEXT,
  contact2_email TEXT,
  general_email TEXT,
  email_confidence TEXT,
  contact_source_url TEXT,
  source_urls TEXT,
  status TEXT DEFAULT 'Not contacted',
  last_contacted TEXT,
  next_action TEXT,
  notes TEXT,
  -- pipeline extensions
  source TEXT DEFAULT 'excel',   -- excel | agent
  pdfs TEXT DEFAULT '[]',        -- JSON [{file, url, title, downloaded_at}]
  generated TEXT DEFAULT '[]',   -- JSON [{page, original_img, generated_img, created_at, status}]
  email_draft TEXT,
  timeline TEXT DEFAULT '[]',    -- JSON [{type, text, date}]
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS cron_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT,
  ran_at TEXT DEFAULT (datetime('now')),
  summary TEXT
);
"""


def norm(name: str) -> str:
    return re.sub(r"\s+", " ", (name or "").strip().lower())


def main() -> None:
    conn = sqlite3.connect(DB)
    conn.executescript(SCHEMA)
    conn.execute("PRAGMA journal_mode = WAL")

    wb = openpyxl.load_workbook(XLSX, read_only=True, data_only=True)
    ws = wb["Database"]
    rows = list(ws.iter_rows(values_only=True))
    header = [str(h).strip() if h else "" for h in rows[0]]
    idx = {h: i for i, h in enumerate(header)}

    def cell(row, name):
        v = row[idx[name]] if idx.get(name) is not None and idx[name] < len(row) else None
        return str(v).strip() if v is not None and str(v).strip() else None

    existing = {norm(r[0]) for r in conn.execute("SELECT organisation FROM leads")}
    added = skipped = 0
    for row in rows[1:]:
        org = cell(row, "Organisation")
        if not org:
            continue
        if norm(org) in existing:
            skipped += 1
            continue
        conn.execute(
            """INSERT INTO leads (rank, priority_score, priority, organisation, country, city,
               sector, type, relationship, rationale, services, website, linkedin,
               contact1_name, contact1_title, contact1_email, contact2_name, contact2_title,
               contact2_email, general_email, email_confidence, contact_source_url, source_urls,
               status, last_contacted, next_action, notes, source)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'excel')""",
            (
                cell(row, "Rank"), cell(row, "Priority score"), cell(row, "Priority"), org,
                cell(row, "Country"), cell(row, "City"), cell(row, "Sector"), cell(row, "Type"),
                cell(row, "Relationship to Think Things"), cell(row, "Potential rationale"),
                cell(row, "Potential services"), cell(row, "Website"), cell(row, "LinkedIn company"),
                cell(row, "Contact 1 name"), cell(row, "Contact 1 title"), cell(row, "Contact 1 email"),
                cell(row, "Contact 2 name"), cell(row, "Contact 2 title"), cell(row, "Contact 2 email"),
                cell(row, "General email"), cell(row, "Email confidence"),
                cell(row, "Contact source URL"), cell(row, "Source URLs"),
                cell(row, "Status") or "Not contacted", cell(row, "Last contacted"),
                cell(row, "Next action"), cell(row, "Notes"),
            ),
        )
        existing.add(norm(org))
        added += 1
    conn.commit()
    total = conn.execute("SELECT COUNT(*) FROM leads").fetchone()[0]
    print(json.dumps({"added": added, "skipped": skipped, "total": total}))
    conn.close()


if __name__ == "__main__":
    sys.exit(main())
