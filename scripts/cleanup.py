#!/usr/bin/env python3
"""cleanup.py — what is eating the disk, and what is safe to delete.

generated/ and pdfs/ grow forever: full-resolution page renders for every PDF we
ever looked at, one 6 MB PNG per redesign, an archived copy of every superseded
version, and a comparison deck per build. This reports the damage and, only when
asked with --apply, prunes it.

Nothing referenced by a lead is ever deleted except archived versions beyond
--keep-versions, and even those must be older than --days.

    python3 scripts/cleanup.py                # report, deletes nothing
    python3 scripts/cleanup.py --apply        # actually delete
    python3 scripts/cleanup.py --apply --days 60 --keep-versions 1
"""
from __future__ import annotations

import argparse
import datetime
import json
import re
import sqlite3
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "leads.db"
GENERATED = ROOT / "generated"
PDFS = ROOT / "pdfs"


def size_of(paths) -> int:
    return sum(p.stat().st_size for p in paths if p.exists())


def mb(n: int) -> float:
    return round(n / 1024 / 1024, 1)


def load_leads(conn) -> list[dict]:
    out = []
    for row in conn.execute("SELECT id, organisation, generated, pdfs FROM leads"):
        try:
            generated = json.loads(row[2] or "[]")
        except Exception:
            generated = []
        try:
            pdfs = json.loads(row[3] or "[]")
        except Exception:
            pdfs = []
        out.append({"id": row[0], "organisation": row[1], "generated": generated, "pdfs": pdfs})
    return out


def referenced(leads: list[dict]) -> set[str]:
    """Every file path a lead points at — these are never touched."""
    keep: set[str] = set()
    for lead in leads:
        for g in lead["generated"]:
            for key in ("original_img", "generated_img", "thumb", "base_img"):
                if g.get(key):
                    keep.add(str(g[key]))
        for p in lead["pdfs"]:
            if p.get("file"):
                keep.add(str(p["file"]))
    return keep


def old_enough(path: Path, days: int) -> bool:
    return (time.time() - path.stat().st_mtime) > days * 86400


def collect(days: int, keep_versions: int) -> dict:
    conn = sqlite3.connect(DB)
    leads = load_leads(conn)
    conn.close()
    keep = referenced(leads)

    groups: dict[str, list[Path]] = {
        "archived_versions": [],   # ...-vN copies beyond the ones we keep
        "orphan_files": [],        # in generated/ but no lead points at them
        "old_decks": [],           # comparison PDFs that are not the newest per lead
        "unused_page_renders": [], # renders of reports that never produced a redesign
    }

    # 1. archived versions, oldest first, keeping the most recent `keep_versions`
    by_stem: dict[str, list[Path]] = {}
    for f in GENERATED.glob("*/redesigns/*"):
        if f.is_file() and re.search(r"-v\d+$", f.stem):
            base = re.sub(r"-v\d+$", "", f.stem)
            by_stem.setdefault(f"{f.parent}/{base}", []).append(f)
    for _, files in by_stem.items():
        files.sort(key=lambda f: f.stat().st_mtime, reverse=True)
        for f in files[keep_versions:]:
            if old_enough(f, days) and str(f.relative_to(ROOT)) not in keep:
                groups["archived_versions"].append(f)

    # 3. comparison decks: keep the newest per lead
    for lead_dir in GENERATED.glob("*"):
        decks = sorted(lead_dir.glob("compara*-*.pdf"), key=lambda f: f.stat().st_mtime,
                       reverse=True)
        decks += sorted(lead_dir.glob("comparison-*.pdf"), key=lambda f: f.stat().st_mtime,
                        reverse=True)[1:]
        for f in decks[1:]:
            if old_enough(f, days):
                groups["old_decks"].append(f)

    # page renders for reports nobody ever redesigned
    used_slugs = {(lead["id"], g.get("pdf")) for lead in leads for g in lead["generated"]}
    for pages_dir in GENERATED.glob("*/pages/*"):
        try:
            lead_id = int(pages_dir.parent.parent.name)
        except ValueError:
            continue
        if (lead_id, pages_dir.name) in used_slugs:
            continue
        for f in pages_dir.glob("*.png"):
            if old_enough(f, days) and str(f.relative_to(ROOT)) not in keep:
                groups["unused_page_renders"].append(f)

    # orphans last, and only what no other group already claimed: otherwise the
    # report double counts and promises more space than the disk actually holds
    claimed = {f for files in groups.values() for f in files}
    for f in GENERATED.rglob("*"):
        if not f.is_file() or f.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp"}:
            continue
        if f in claimed or str(f.relative_to(ROOT)) in keep:
            continue
        if re.search(r"-v\d+$", f.stem):
            continue                            # an archived version we chose to keep
        if f.parent.name == "thumbs" and (f.parent.parent / f"{f.stem}.png").exists():
            continue                            # thumbnail of a live image
        if old_enough(f, days):
            groups["orphan_files"].append(f)

    report = {name: {"files": len(files), "mb": mb(size_of(files))}
              for name, files in groups.items()}
    report["_total_mb"] = round(sum(v["mb"] for v in report.values()), 1)
    report["disk"] = {"generated_mb": mb(size_of([f for f in GENERATED.rglob("*") if f.is_file()])),
                      "pdfs_mb": mb(size_of([f for f in PDFS.rglob("*") if f.is_file()]))}
    return {"report": report, "groups": groups}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=30,
                    help="only touch files older than this many days")
    ap.add_argument("--keep-versions", type=int, default=2,
                    help="archived versions to keep per image")
    ap.add_argument("--apply", action="store_true", help="delete; without it this only reports")
    ap.add_argument("--only", default="", help="comma-separated groups to act on")
    a = ap.parse_args()

    found = collect(a.days, a.keep_versions)
    groups = found["groups"]
    if a.only:
        wanted = {x.strip() for x in a.only.split(",") if x.strip()}
        groups = {k: v for k, v in groups.items() if k in wanted}

    deleted = 0
    freed = 0
    if a.apply:
        for _, files in groups.items():
            for f in files:
                try:
                    freed += f.stat().st_size
                    f.unlink()
                    deleted += 1
                except Exception:
                    pass

    print(json.dumps({
        "ok": True,
        "applied": a.apply,
        "deleted": deleted,
        "freed_mb": mb(freed) if a.apply else 0,
        "would_free_mb": found["report"]["_total_mb"],
        "report": found["report"],
        "days": a.days,
        "keep_versions": a.keep_versions,
        "at": datetime.datetime.now().isoformat(timespec="seconds"),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
