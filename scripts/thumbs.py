#!/usr/bin/env python3
"""thumbs.py — small preview next to every redesign.

The gallery paints 144 px tiles out of 6 MB PNGs: a screen of twenty pairs pulls
a hundred megabytes over the wire. Every redesign gets a WebP thumbnail beside
it, and the UI falls back to the full image only when the thumb is missing.

Library:
    from thumbs import make_thumb
    rel = make_thumb(Path("generated/13/redesigns/page-01-editorial-redesign.png"))

CLI (backfill what already exists):
    python3 scripts/thumbs.py --backfill [--width 720] [--force]
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "leads.db"
WIDTH = 720
SUBDIR = "thumbs"


def thumb_path(src: Path) -> Path:
    return src.parent / SUBDIR / f"{src.stem}.webp"


def make_thumb(src: Path, width: int = WIDTH, force: bool = False) -> str | None:
    """Write the thumbnail and return its path relative to the project root."""
    src = Path(src)
    if not src.exists():
        return None
    dest = thumb_path(src)
    if dest.exists() and not force and dest.stat().st_mtime >= src.stat().st_mtime:
        return str(dest.relative_to(ROOT))
    try:
        from PIL import Image
    except ImportError:
        return None
    try:
        with Image.open(src) as im:
            im = im.convert("RGB")
            if im.width > width:
                im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
            dest.parent.mkdir(parents=True, exist_ok=True)
            im.save(dest, "WEBP", quality=82, method=4)
    except Exception:
        return None
    return str(dest.relative_to(ROOT))


def backfill(width: int, force: bool) -> dict:
    """Thumbnail every registered redesign and store the path in the lead row."""
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    made = skipped = failed = 0

    for row in conn.execute("SELECT id, generated FROM leads WHERE generated NOT IN ('', '[]')"):
        try:
            items = json.loads(row["generated"] or "[]")
        except Exception:
            continue
        dirty = False
        for g in items:
            rel = g.get("generated_img")
            if not rel:
                continue
            existing = g.get("thumb")
            if existing and (ROOT / existing).exists() and not force:
                skipped += 1
                continue
            thumb = make_thumb(ROOT / rel, width=width, force=force)
            if thumb:
                if g.get("thumb") != thumb:
                    g["thumb"] = thumb
                    dirty = True
                made += 1
            else:
                failed += 1
        if dirty:
            conn.execute("UPDATE leads SET generated = ? WHERE id = ?",
                         (json.dumps(items, ensure_ascii=False), row["id"]))
    conn.commit()
    conn.close()
    return {"ok": True, "made": made, "skipped": skipped, "failed": failed}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--backfill", action="store_true", help="thumbnail every existing redesign")
    ap.add_argument("--width", type=int, default=WIDTH)
    ap.add_argument("--force", action="store_true", help="rebuild thumbnails that already exist")
    ap.add_argument("paths", nargs="*", help="images to thumbnail when not backfilling")
    a = ap.parse_args()

    if a.backfill:
        print(json.dumps(backfill(a.width, a.force), ensure_ascii=False))
        return 0

    out = [make_thumb(ROOT / p if not Path(p).is_absolute() else Path(p), a.width, a.force)
           for p in a.paths]
    print(json.dumps({"ok": True, "thumbs": out}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
