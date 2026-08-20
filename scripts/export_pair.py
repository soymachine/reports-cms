#!/usr/bin/env python3
"""export_pair.py — compose one before/after pair as a shareable image.

The comparison PDF is for attaching to an email; this is for the other case:
dropping the pair into LinkedIn, a slide or a deck.

Formats: slide (16:9), square (1:1), story (9:16), raw (side by side, no frame)

Usage:
  python3 export_pair.py <lead_id> --original <img> --generated <img>
                         [--format slide] [--label "Editorial Premium"] [--page 3]
Output: JSON {"ok": true, "file": "generated/1/exports/....png"}
"""
from __future__ import annotations

import argparse
import datetime
import json
import re
import sqlite3
import sys
from pathlib import Path

try:
    import pymupdf
except ImportError:  # pragma: no cover
    import fitz as pymupdf

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "leads.db"

SIZES = {
    "slide": (1920, 1080),
    "square": (1200, 1200),
    "story": (1080, 1920),
    "raw": (2400, 1400),
}

INK = (0.09, 0.09, 0.11)
MUTED = (0.58, 0.58, 0.62)
ACCENT = (0.06, 0.72, 0.51)
PAPER = (1, 1, 1)


def fit(img: Path, box: pymupdf.Rect) -> pymupdf.Rect:
    try:
        with pymupdf.open(img) as doc:
            w, h = doc[0].rect.width, doc[0].rect.height
    except Exception:
        return box
    if not w or not h:
        return box
    scale = min(box.width / w, box.height / h)
    nw, nh = w * scale, h * scale
    x = box.x0 + (box.width - nw) / 2
    y = box.y0 + (box.height - nh) / 2
    return pymupdf.Rect(x, y, x + nw, y + nh)


def compose(fmt: str, original: Path, generated: Path, title: str, label: str,
            page: int, studio: str, raw: bool = False) -> pymupdf.Document:
    W, H = SIZES[fmt]
    doc = pymupdf.open()
    p = doc.new_page(width=W, height=H)
    p.draw_rect(pymupdf.Rect(0, 0, W, H), color=PAPER, fill=PAPER)

    pad = int(W * 0.035)
    head = 0 if raw else int(H * 0.11)
    foot = 0 if raw else int(H * 0.07)
    body = pymupdf.Rect(pad, head, W - pad, H - foot)

    vertical = fmt == "story"
    if vertical:
        half = (body.height - pad) / 2
        boxes = [
            pymupdf.Rect(body.x0, body.y0, body.x1, body.y0 + half),
            pymupdf.Rect(body.x0, body.y0 + half + pad, body.x1, body.y1),
        ]
    else:
        half = (body.width - pad) / 2
        boxes = [
            pymupdf.Rect(body.x0, body.y0, body.x0 + half, body.y1),
            pymupdf.Rect(body.x0 + half + pad, body.y0, body.x1, body.y1),
        ]

    if not raw:
        size_t = max(int(H * 0.030), 14)
        p.insert_text((pad, int(head * 0.52)), title[:70], fontname="hebo", fontsize=size_t, color=INK)
        sub = f"página {page}" + (f" · {label}" if label else "")
        p.insert_text((pad, int(head * 0.52) + size_t + 6), sub, fontname="helv",
                      fontsize=max(int(H * 0.018), 10), color=MUTED)

    tag = max(int(H * 0.016), 9)
    for (img, box, color, caption) in (
        (original, boxes[0], MUTED, "ANTES"),
        (generated, boxes[1], ACCENT, "DESPUÉS"),
    ):
        inner = pymupdf.Rect(box.x0, box.y0 + (0 if raw else tag + 8), box.x1, box.y1)
        if not img.exists():
            continue
        target = fit(img, inner)
        p.insert_image(target, filename=str(img))
        p.draw_rect(target, color=color, width=1.2)
        if not raw:
            p.insert_text((box.x0, box.y0 + tag), caption, fontname="helv", fontsize=tag, color=color)

    if not raw:
        p.insert_text((pad, H - foot * 0.45), studio, fontname="helv",
                      fontsize=max(int(H * 0.016), 9), color=MUTED)
    return doc


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("lead_id", type=int)
    ap.add_argument("--original", required=True)
    ap.add_argument("--generated", required=True)
    ap.add_argument("--format", default="slide", choices=sorted(SIZES.keys()))
    ap.add_argument("--label", default="")
    ap.add_argument("--page", type=int, default=0)
    ap.add_argument("--ext", default="png", choices=["png", "jpg"])
    a = ap.parse_args()

    original = ROOT / a.original
    generated = ROOT / a.generated
    if not generated.exists():
        print(json.dumps({"ok": False, "error": "imagen generada no encontrada"}))
        return 1

    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    lead = conn.execute("SELECT organisation FROM leads WHERE id = ?", (a.lead_id,)).fetchone()
    org = lead["organisation"] if lead else f"lead {a.lead_id}"

    studio = "Think Things — estudio de diseño gráfico, Barcelona"
    try:
        settings = json.loads((ROOT / "settings.json").read_text())
        studio = settings.get("branding", {}).get("footer", studio)
    except Exception:
        pass

    doc = compose(a.format, original, generated, org, a.label, a.page, studio, raw=(a.format == "raw"))
    pix = doc[0].get_pixmap(dpi=110)

    out_dir = ROOT / "generated" / str(a.lead_id) / "exports"
    out_dir.mkdir(parents=True, exist_ok=True)
    slug = re.sub(r"[^A-Za-z0-9_-]+", "-", f"{org}-p{a.page}-{a.label or 'pair'}".lower()).strip("-")[:60]
    out = out_dir / f"{slug}-{a.format}-{datetime.datetime.now().strftime('%H%M%S')}.{a.ext}"
    pix.save(out)
    doc.close()
    conn.close()

    print(json.dumps({"ok": True, "file": str(out.relative_to(ROOT)),
                      "format": a.format, "width": pix.width, "height": pix.height,
                      "size_kb": round(out.stat().st_size / 1024)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
