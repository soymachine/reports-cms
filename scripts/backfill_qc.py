#!/usr/bin/env python3
"""backfill_qc.py — run the OCR data check over redesigns generated before QC existed.

Usage: python3 backfill_qc.py [--lead-id N] [--force]
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "leads.db"
QC = Path(__file__).with_name("qc_redesign.py")


def run_qc(entry: dict, source_pdf: Path | None) -> dict:
    cmd = [sys.executable, str(QC), "--original", entry.get("original_img", ""),
           "--generated", entry["generated_img"]]
    if source_pdf and source_pdf.exists():
        cmd += ["--pdf", str(source_pdf.relative_to(ROOT)), "--page", str(entry.get("page", 0))]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=240, cwd=str(ROOT))
        return json.loads(res.stdout.strip().split("\n")[-1])
    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--lead-id", type=int, default=0)
    ap.add_argument("--force", action="store_true", help="re-check entries that already have a verdict")
    a = ap.parse_args()

    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    sql = "SELECT id, organisation, generated, pdfs FROM leads WHERE generated NOT IN ('', '[]')"
    params: tuple = ()
    if a.lead_id:
        sql += " AND id = ?"
        params = (a.lead_id,)

    checked = 0
    verdicts: dict[str, int] = {}
    for row in conn.execute(sql, params).fetchall():
        items = json.loads(row["generated"] or "[]")
        pdfs = {p.get("slug"): p.get("file") for p in json.loads(row["pdfs"] or "[]")}
        changed = False
        for entry in items:
            if entry.get("qc") and not a.force:
                continue
            if not (ROOT / entry.get("generated_img", "")).exists():
                continue
            src = pdfs.get(entry.get("pdf"))
            qc = run_qc(entry, ROOT / src if src else None)
            entry["qc"] = qc
            changed = True
            checked += 1
            v = qc.get("verdict", "error") if qc.get("ok") else "error"
            verdicts[v] = verdicts.get(v, 0) + 1
            print(f"  #{row['id']:>4} {row['organisation'][:34]:<34} p{entry.get('page')}"
                  f" {entry.get('styleName', '')[:18]:<18} → {v}", file=sys.stderr)
        if changed:
            conn.execute("UPDATE leads SET generated = ? WHERE id = ?",
                         (json.dumps(items, ensure_ascii=False), row["id"]))

    conn.commit()
    conn.close()
    print(json.dumps({"ok": True, "checked": checked, "verdicts": verdicts}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
