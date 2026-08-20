#!/usr/bin/env python3
"""lead_mgr.py — CLI to operate on the ThinkThings leads DB from a terminal.

All commands output JSON. Scripts and people use this CLI; the dashboard uses its
own API.

Usage:
  python3 lead_mgr.py add --organisation "..." [--country ...] [--sector ...] ...
  python3 lead_mgr.py list [--status X] [--priority X] [--limit N] [--json]
  python3 lead_mgr.py get <id>
  python3 lead_mgr.py update <id> [--status X] [--notes X] ...
  python3 lead_mgr.py exists --organisation "..."
  python3 lead_mgr.py stats
  python3 lead_mgr.py add-pdf <id> --file X --url Y [--title Z]
  python3 lead_mgr.py add-generated <id> --page N --original X --generated Y
  python3 lead_mgr.py timeline <id> --type X --text Y
"""
import argparse
import json
import re
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DB = ROOT / "leads.db"

FIELDS = [
    "rank", "priority_score", "priority", "organisation", "country", "city", "sector",
    "type", "relationship", "rationale", "services", "website", "linkedin",
    "contact1_name", "contact1_title", "contact1_email", "contact2_name",
    "contact2_title", "contact2_email", "general_email", "email_confidence",
    "contact_source_url", "source_urls", "status", "last_contacted", "next_action",
    "notes", "source", "email_draft",
]

SCHEMA = (ROOT / "scripts" / "import_excel.py").read_text().split('SCHEMA = """')[1].split('"""')[0]


def connect():
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def out(data):
    print(json.dumps(data, ensure_ascii=False, indent=2))


def norm(name: str) -> str:
    return re.sub(r"\s+", " ", (name or "").strip().lower())


def row_to_dict(r):
    d = dict(r)
    for k in ("pdfs", "generated", "timeline"):
        try:
            d[k] = json.loads(d.get(k) or "[]")
        except json.JSONDecodeError:
            d[k] = []
    return d


def cmd_add(a):
    conn = connect()
    if norm(a.organisation) in {norm(r[0]) for r in conn.execute("SELECT organisation FROM leads")}:
        out({"ok": False, "error": "duplicate", "organisation": a.organisation})
        return 1
    data = {f: getattr(a, f, None) for f in FIELDS if getattr(a, f, None) is not None}
    data.setdefault("source", "agent")
    data.setdefault("status", "Not contacted")
    cols = ", ".join(data.keys())
    cur = conn.execute(
        f"INSERT INTO leads ({cols}) VALUES ({', '.join('?' * len(data))})",
        list(data.values()),
    )
    conn.commit()
    out({"ok": True, "id": cur.lastrowid, "organisation": a.organisation})
    return 0


def cmd_list(a):
    conn = connect()
    q, params = "SELECT * FROM leads WHERE 1=1", []
    if a.status:
        q += " AND status = ?"
        params.append(a.status)
    if a.priority:
        q += " AND priority = ?"
        params.append(a.priority)
    if a.sector:
        q += " AND sector LIKE ?"
        params.append(f"%{a.sector}%")
    if a.source:
        q += " AND source = ?"
        params.append(a.source)
    q += " ORDER BY priority_score DESC, rank ASC LIMIT ?"
    params.append(a.limit)
    out([row_to_dict(r) for r in conn.execute(q, params)])
    return 0


def cmd_get(a):
    conn = connect()
    r = conn.execute("SELECT * FROM leads WHERE id = ?", (a.id,)).fetchone()
    if not r:
        out({"ok": False, "error": "not found"})
        return 1
    out(row_to_dict(r))
    return 0


def cmd_update(a):
    conn = connect()
    sets, params = [], []
    for f in FIELDS:
        v = getattr(a, f, None)
        if v is not None:
            sets.append(f"{f} = ?")
            params.append(v)
    if not sets:
        out({"ok": False, "error": "nothing to update"})
        return 1
    sets.append("updated_at = datetime('now')")
    cur = conn.execute(f"UPDATE leads SET {', '.join(sets)} WHERE id = ?", (*params, a.id))
    conn.commit()
    out({"ok": cur.rowcount > 0, "id": a.id})
    return 0 if cur.rowcount else 1


def cmd_exists(a):
    conn = connect()
    hit = any(
        norm(r[0]) == norm(a.organisation)
        for r in conn.execute("SELECT organisation FROM leads")
    )
    out({"exists": hit, "organisation": a.organisation})
    return 0


def cmd_stats(a):
    conn = connect()
    by_status = dict(conn.execute("SELECT status, COUNT(*) FROM leads GROUP BY status").fetchall())
    by_priority = dict(conn.execute("SELECT priority, COUNT(*) FROM leads GROUP BY priority").fetchall())
    total = conn.execute("SELECT COUNT(*) FROM leads").fetchone()[0]
    with_pdf = conn.execute("SELECT COUNT(*) FROM leads WHERE pdfs != '[]'").fetchone()[0]
    with_gen = conn.execute("SELECT COUNT(*) FROM leads WHERE generated != '[]'").fetchone()[0]
    out({"total": total, "by_status": by_status, "by_priority": by_priority,
         "with_pdfs": with_pdf, "with_generated": with_gen})
    return 0


def cmd_add_pdf(a):
    conn = connect()
    r = conn.execute("SELECT pdfs FROM leads WHERE id = ?", (a.id,)).fetchone()
    if not r:
        out({"ok": False, "error": "not found"})
        return 1
    pdfs = json.loads(r[0] or "[]")
    pdfs.append({"file": a.file, "url": a.url, "title": a.title or "",
                 "downloaded_at": __import__("datetime").datetime.now().isoformat()})
    conn.execute("UPDATE leads SET pdfs = ?, updated_at = datetime('now') WHERE id = ?",
                 (json.dumps(pdfs), a.id))
    conn.commit()
    out({"ok": True, "id": a.id, "pdfs": len(pdfs)})
    return 0


def cmd_add_generated(a):
    conn = connect()
    r = conn.execute("SELECT generated FROM leads WHERE id = ?", (a.id,)).fetchone()
    if not r:
        out({"ok": False, "error": "not found"})
        return 1
    gen = json.loads(r[0] or "[]")
    gen.append({"page": a.page, "original_img": a.original, "generated_img": a.generated,
                "status": "done",
                "created_at": __import__("datetime").datetime.now().isoformat()})
    conn.execute("UPDATE leads SET generated = ?, updated_at = datetime('now') WHERE id = ?",
                 (json.dumps(gen), a.id))
    conn.commit()
    out({"ok": True, "id": a.id, "generated": len(gen)})
    return 0


def cmd_timeline(a):
    conn = connect()
    r = conn.execute("SELECT timeline FROM leads WHERE id = ?", (a.id,)).fetchone()
    if not r:
        out({"ok": False, "error": "not found"})
        return 1
    tl = json.loads(r[0] or "[]")
    tl.append({"type": a.type, "text": a.text,
               "date": __import__("datetime").datetime.now().isoformat()})
    conn.execute("UPDATE leads SET timeline = ?, updated_at = datetime('now') WHERE id = ?",
                 (json.dumps(tl), a.id))
    conn.commit()
    out({"ok": True, "id": a.id})
    return 0


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)

    def add_fields(sp, for_update=False):
        for f in FIELDS:
            sp.add_argument(f"--{f.replace('_', '-')}", dest=f)

    sp = sub.add_parser("add")
    add_fields(sp)
    sp.set_defaults(fn=cmd_add)

    sp = sub.add_parser("list")
    sp.add_argument("--status")
    sp.add_argument("--priority")
    sp.add_argument("--sector")
    sp.add_argument("--source")
    sp.add_argument("--limit", type=int, default=50)
    sp.set_defaults(fn=cmd_list)

    sp = sub.add_parser("get")
    sp.add_argument("id", type=int)
    sp.set_defaults(fn=cmd_get)

    sp = sub.add_parser("update")
    sp.add_argument("id", type=int)
    add_fields(sp, for_update=True)
    sp.set_defaults(fn=cmd_update)

    sp = sub.add_parser("exists")
    sp.add_argument("--organisation", required=True)
    sp.set_defaults(fn=cmd_exists)

    sp = sub.add_parser("stats")
    sp.set_defaults(fn=cmd_stats)

    sp = sub.add_parser("add-pdf")
    sp.add_argument("id", type=int)
    sp.add_argument("--file", required=True)
    sp.add_argument("--url", required=True)
    sp.add_argument("--title")
    sp.set_defaults(fn=cmd_add_pdf)

    sp = sub.add_parser("add-generated")
    sp.add_argument("id", type=int)
    sp.add_argument("--page", type=int, required=True)
    sp.add_argument("--original", required=True)
    sp.add_argument("--generated", required=True)
    sp.set_defaults(fn=cmd_add_generated)

    sp = sub.add_parser("timeline")
    sp.add_argument("id", type=int)
    sp.add_argument("--type", default="note")
    sp.add_argument("--text", required=True)
    sp.set_defaults(fn=cmd_timeline)

    args = p.parse_args()
    sys.exit(args.fn(args))


if __name__ == "__main__":
    main()
