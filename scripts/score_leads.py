#!/usr/bin/env python3
"""score_leads.py — reproducible priority scoring.

Replaces "whatever the Excel said" with signals we can defend and recompute:
reports found, how recent they are, how contactable the organisation is,
sector fit and existing relationship. Every score keeps its breakdown so the
dashboard can show *why* a lead sits where it does.

Usage:
  python3 score_leads.py [--lead-id N] [--dry-run]
Output: JSON {"ok": true, "scored": N, "changed": M}
"""
from __future__ import annotations

import argparse
import datetime
import json
import re
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "leads.db"
SETTINGS = ROOT / "settings.json"

DEFAULT_BANDS = [(70, "A - Hot"), (50, "B - Strong"), (30, "C - Medium"), (0, "D - Long list")]
DEAD_STATUSES = {"Lost", "Discarded"}


def load_settings() -> dict:
    try:
        return json.loads(SETTINGS.read_text())
    except Exception:
        return {}


def months_since(iso: str | None) -> float | None:
    if not iso:
        return None
    try:
        d = datetime.date.fromisoformat(str(iso)[:10])
    except ValueError:
        return None
    return (datetime.date.today() - d).days / 30.44


def score_lead(row: sqlite3.Row, target_sectors: list[str]) -> tuple[int, dict]:
    """Return (score 0-100, breakdown)."""
    parts: dict[str, dict] = {}

    def add(key: str, points: float, why: str) -> None:
        parts[key] = {"points": round(points, 1), "why": why}

    pdfs = json.loads(row["pdfs"] or "[]")
    generated = json.loads(row["generated"] or "[]")

    # 1. material to work with — no report, no demo, no pitch
    if len(pdfs) >= 2:
        add("reports", 25, f"{len(pdfs)} informes descargados")
    elif len(pdfs) == 1:
        add("reports", 15, "1 informe descargado")
    else:
        add("reports", 0, "sin informes todavía")

    # 2. how visual those reports are — a text-only report is a weak demo
    ratios = [p.get("visual_ratio") for p in pdfs if isinstance(p.get("visual_ratio"), (int, float))]
    if ratios:
        best = max(ratios)
        add("visual", best * 10, f"mejor informe con {int(best * 100)}% de páginas visuales")

    # 3. timing — a fresh report means an active publishing cycle
    age = months_since(row["report_published_at"] if "report_published_at" in row.keys() else None)
    if age is not None:
        if age <= 12:
            add("recency", 15, f"informe de hace {age:.0f} meses")
        elif age <= 24:
            add("recency", 8, f"informe de hace {age:.0f} meses")
        else:
            add("recency", 0, f"informe antiguo ({age:.0f} meses)")

    # 4. can we actually reach them
    contact_pts = 0.0
    if row["contact1_email"]:
        contact_pts += 12
    if row["contact2_email"]:
        contact_pts += 3
    if row["general_email"]:
        contact_pts += 5
    conf = (row["email_confidence"] or "").lower()
    if any(k in conf for k in ("verified", "verificado", "high", "alta")):
        contact_pts += 8
    add("contact", min(contact_pts, 25), "contactabilidad por email")

    # 5. digital presence
    presence = (5 if row["website"] else 0) + (5 if row["linkedin"] and "to find" not in str(row["linkedin"]).lower() else 0)
    add("presence", presence, "web / LinkedIn localizados")

    # 6. sector fit against the ones we actually sell to
    sector = (row["sector"] or "").lower()
    if target_sectors and any(t.lower() in sector for t in target_sectors if t):
        add("sector", 12, f"sector objetivo: {row['sector']}")

    # 7. warm relationship beats everything else in conversion
    rel = (row["relationship"] or "").lower()
    if re.search(r"existing|client|cliente|current|actual|partner", rel):
        add("relationship", 10, "relación previa o cliente existente")

    # 8. work already done on this lead
    if generated:
        add("demo", 8, f"{len(generated)} rediseños generados")

    total = sum(p["points"] for p in parts.values())
    total = max(0, min(100, round(total)))

    if (row["status"] or "") in DEAD_STATUSES:
        parts["dead"] = {"points": -total, "why": f"estado {row['status']}"}
        total = 0

    return int(total), parts


def band(score: int, bands=DEFAULT_BANDS) -> str:
    for threshold, name in bands:
        if score >= threshold:
            return name
    return bands[-1][1]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--lead-id", type=int, default=0, help="score a single lead")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--job-id", type=int, default=0)
    a = ap.parse_args()

    settings = load_settings()
    target_sectors = settings.get("scoring", {}).get("target_sectors", [])

    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    sql = "SELECT * FROM leads"
    params: tuple = ()
    if a.lead_id:
        sql += " WHERE id = ?"
        params = (a.lead_id,)
    rows = conn.execute(sql, params).fetchall()

    changed = 0
    now = datetime.datetime.now().isoformat()
    for row in rows:
        score, breakdown = score_lead(row, target_sectors)
        priority = band(score)
        if not a.dry_run:
            conn.execute(
                """UPDATE leads
                      SET priority_score = ?, priority = ?, score_breakdown = ?, scored_at = ?
                    WHERE id = ?""",
                (score, priority, json.dumps(breakdown, ensure_ascii=False), now, row["id"]),
            )
        if score != (row["priority_score"] or -1) or priority != row["priority"]:
            changed += 1

    # rank follows the score so the pipeline order is defensible
    if not a.dry_run:
        conn.execute("""
            WITH ordered AS (
              SELECT id, ROW_NUMBER() OVER (ORDER BY priority_score DESC, id ASC) AS rn FROM leads
            )
            UPDATE leads SET rank = (SELECT rn FROM ordered WHERE ordered.id = leads.id)
        """)

    result = {"ok": True, "scored": len(rows), "changed": changed, "dry_run": a.dry_run}
    if a.job_id and not a.dry_run:
        conn.execute("UPDATE jobs SET state='done', result=?, finished_at=datetime('now') WHERE id=?",
                     (json.dumps(result), a.job_id))
    conn.commit()
    conn.close()
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
