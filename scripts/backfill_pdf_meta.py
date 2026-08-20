#!/usr/bin/env python3
"""backfill_pdf_meta.py — add pages / visual_ratio / published_at to PDFs
that were downloaded before those fields existed.

Read-only with respect to the files themselves: it only enriches leads.pdfs
and leads.report_published_at, so the radar and the scorer have data to work
with on the existing 260 leads.

Usage: python3 backfill_pdf_meta.py [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "leads.db"

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pdf_utils import published_date, report_quality  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT id, organisation, pdfs FROM leads WHERE pdfs NOT IN ('', '[]')").fetchall()

    touched = enriched = missing = 0
    for row in rows:
        try:
            pdfs = json.loads(row["pdfs"] or "[]")
        except json.JSONDecodeError:
            continue

        changed = False
        for entry in pdfs:
            if entry.get("pages") is not None and entry.get("published_at") is not None:
                continue
            path = ROOT / entry.get("file", "")
            if not path.exists():
                missing += 1
                continue
            quality = report_quality(path)
            entry.setdefault("source", "search")
            entry["pages"] = quality.get("pages")
            entry["visual_ratio"] = quality.get("visual_ratio")
            entry["quality_ok"] = quality.get("ok")
            entry["published_at"] = published_date(path, entry.get("title", ""))
            changed = True
            enriched += 1

        if not changed:
            continue
        touched += 1
        dates = [p.get("published_at") for p in pdfs if p.get("published_at")]
        if not a.dry_run:
            conn.execute("UPDATE leads SET pdfs = ? WHERE id = ?", (json.dumps(pdfs, ensure_ascii=False), row["id"]))
            if dates:
                conn.execute("UPDATE leads SET report_published_at = ? WHERE id = ?", (max(dates), row["id"]))
        print(f"  #{row['id']:>4} {row['organisation'][:44]:<44} {len(pdfs)} pdf(s)"
              f" · {max(dates) if dates else 'sin fecha'}", file=sys.stderr)

    if not a.dry_run:
        conn.commit()
    conn.close()
    print(json.dumps({"ok": True, "leads_touched": touched, "pdfs_enriched": enriched,
                      "files_missing": missing, "dry_run": a.dry_run}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
