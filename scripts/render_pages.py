#!/usr/bin/env python3
"""render_pages.py — render PDF pages to PNGs for the page-selection UI.

Uses poppler's pdftoppm. Renders thumbnails (for the grid) and full-size
pages (for preview/original in before-after) into generated/{lead_id}/pages/.

Each page is also scored by how visually rich it is, so the UI can pre-select
the pages actually worth redesigning instead of making you scan 100 thumbnails.

Usage:
  python3 render_pages.py <lead_id> --pdf "pdfs/1/file.pdf" [--dpi 110] [--thumb-dpi 40]
Output: JSON {"ok": true, "pages": [{"page": 1, "thumb": "...", "full": "...", "score": 62.5}],
              "recommended": [7, 10, 12]}
"""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pdf_utils import page_palette, recommended_pages, score_pdf_pages  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


def page_count(pdf: Path) -> int:
    out = subprocess.run(["pdfinfo", str(pdf)], capture_output=True, text=True)
    m = re.search(r"^Pages:\s+(\d+)", out.stdout, re.M)
    return int(m.group(1)) if m else 0


def render(pdf: Path, prefix: Path, dpi: int) -> None:
    subprocess.run(
        ["pdftoppm", "-png", "-r", str(dpi), str(pdf), str(prefix)],
        check=True, capture_output=True,
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("lead_id", type=int)
    ap.add_argument("--pdf", required=True, help="path relative to project root")
    ap.add_argument("--dpi", type=int, default=110)
    ap.add_argument("--thumb-dpi", type=int, default=35)
    ap.add_argument("--recommend", type=int, default=4, help="how many pages to pre-select")
    ap.add_argument("--force", action="store_true", help="ignore the cached render")
    a = ap.parse_args()

    pdf = (ROOT / a.pdf).resolve()
    if not str(pdf).startswith(str(ROOT)) or not pdf.exists():
        print(json.dumps({"ok": False, "error": "pdf not found or outside project"}))
        return 1

    # slugified per-pdf subfolder so multiple PDFs per lead don't collide
    slug = re.sub(r"[^A-Za-z0-9_-]+", "_", pdf.stem)[:60]
    out_dir = ROOT / "generated" / str(a.lead_id) / "pages" / slug
    out_dir.mkdir(parents=True, exist_ok=True)

    # reuse a previous render unless the PDF changed — re-scoring a 100-page
    # report costs seconds and the images never change
    cache = out_dir / "pages.json"
    if not a.force and cache.exists() and cache.stat().st_mtime >= pdf.stat().st_mtime:
        try:
            cached = json.loads(cache.read_text())
            if cached.get("pages") and not cached.get("palette"):
                # cache predates palette extraction: fill it in without re-rendering
                try:
                    cached["palette"] = page_palette(pdf, pages=cached.get("recommended") or None)
                    cache.write_text(json.dumps(cached))
                except Exception as e:
                    print(f"palette backfill failed: {e}", file=sys.stderr)
            if cached.get("pages"):
                print(json.dumps({"ok": True, "pdf": a.pdf, "count": len(cached["pages"]),
                                  "pages": cached["pages"], "recommended": cached.get("recommended", []),
                                  "palette": cached.get("palette", []), "cached": True}))
                return 0
        except Exception:
            pass

    n = page_count(pdf)
    if n == 0:
        print(json.dumps({"ok": False, "error": "could not read pdf page count"}))
        return 1

    render(pdf, out_dir / "full", a.dpi)
    render(pdf, out_dir / "thumb", a.thumb_dpi)

    # visual scoring — never fatal: without it the UI just loses the hints
    try:
        scores = {s["page"]: s for s in score_pdf_pages(pdf)}
        recommended = recommended_pages(list(scores.values()), limit=a.recommend)
    except Exception as e:
        print(f"scoring failed: {e}", file=sys.stderr)
        scores, recommended = {}, []

    # dominant colours of the report, so a redesign can be asked to respect them
    try:
        palette = page_palette(pdf, pages=recommended or None)
    except Exception as e:
        print(f"palette failed: {e}", file=sys.stderr)
        palette = []

    pages = []
    full_files = {int(m.group(1)): f for f in out_dir.glob("full-*.png") if (m := re.search(r"full-(\d+)\.png$", f.name))}
    thumb_files = {int(m.group(1)): f for f in out_dir.glob("thumb-*.png") if (m := re.search(r"thumb-(\d+)\.png$", f.name))}
    for i in sorted(full_files.keys()):
        full = full_files[i]
        thumb = thumb_files.get(i, full)
        sc = scores.get(i, {})
        pages.append({
            "page": i,
            "full": str(full.relative_to(ROOT)),
            "thumb": str(thumb.relative_to(ROOT)),
            "score": sc.get("score", 0),
            "images": sc.get("images", 0),
            "drawings": sc.get("drawings", 0),
            "words": sc.get("words", 0),
            "figures": sc.get("figures", 0),
            "table_rows": sc.get("table_rows", 0),
            # why the scorer likes (or dislikes) this page, shown in the UI
            "reason": sc.get("reason", ""),
            "recommended": i in recommended,
        })

    if not pages:
        print(json.dumps({"ok": False, "error": "pdftoppm produced no images"}))
        return 1

    # cache next to the images so re-opening the PDF does not re-score it
    try:
        (out_dir / "pages.json").write_text(json.dumps({"pages": pages, "recommended": recommended, "palette": palette}))
    except Exception:
        pass

    print(json.dumps({"ok": True, "pdf": a.pdf, "count": len(pages),
                      "pages": pages, "recommended": recommended, "palette": palette}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
