#!/usr/bin/env python3
"""qc_redesign.py — check that a redesign kept the data and changed the design.

Two failures ruin a demo, and they are opposite:

* Magnific rewrites or invents figures. The original page has a real text layer
  in the source PDF (or falls back to OCR), the redesign is only an image, so it
  goes through OCR. We compare the *numbers*, which is what damages credibility.
* Magnific hands back the same page with tidier edges. Sending a client their own
  PDF with a filter on top is worse than sending nothing, so the layout distance
  between the two images is measured too.

Usage:
  python3 qc_redesign.py --original <img|pdf#page> --generated <img> [--pdf path --page N]
Output: JSON {"ok": true, "verdict": "clean|warning|fail", "missing": [...], "kept": N,
              "similarity": {"distance": 0.42, "verdict": "ok|weak|copy|unknown"}}
"""
from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
from pathlib import Path

try:
    import pymupdf
except ImportError:  # pragma: no cover
    import fitz as pymupdf

ROOT = Path(__file__).resolve().parent.parent

# a "figure" worth protecting: 2030, 1.5, 45%, 12,500, €3.2bn …
# grouped thousands first (12,500 / 12.500), otherwise a plain run of digits —
# anchored on both sides so "2030" is one number, not "203" plus a stray "0"
NUMBER = re.compile(
    r"(?<![\w.,])(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?)(?![\d])\s*(%|bn|bn€|m|k|tn|€|\$|mt|gw|twh|mwh)?",
    re.I,
)

# noise that is never a claim about the business
IGNORE = {"1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "0"}


def normalise(raw: str, unit: str | None) -> str:
    txt = raw.replace(" ", "")
    # 12,500 and 12.500 are the same figure written in two locales
    if txt.count(",") and txt.count("."):
        txt = txt.replace(",", "")
    elif txt.count(","):
        txt = txt.replace(",", "." if len(txt.split(",")[-1]) <= 2 else "")
    try:
        val = float(txt)
    except ValueError:
        return raw.lower()
    out = f"{val:g}"
    return out + (unit.lower() if unit else "")


def numbers_in(text: str) -> set[str]:
    found = set()
    for m in NUMBER.finditer(text or ""):
        raw, unit = m.group(1), m.group(2)
        if raw in IGNORE and not unit:
            continue
        if len(raw.replace(".", "").replace(",", "")) < 2 and not unit:
            continue  # single digits without a unit are page furniture
        found.add(normalise(raw, unit))
    return found


# A page laid out again moves nearly every gradient bit; a retouch of the same
# artwork leaves them where they were. Measured over pairs built on purpose: a
# recolour or a taller header stays under 0.01, a new grid lands above 0.20. The
# band in between is a redesign that barely tried, and that is worth saying too.
COPY_DISTANCE = 0.08
WEAK_DISTANCE = 0.16
FLAT_PAGE_STD = 10          # below this there is no structure worth comparing


def fingerprint(path: Path, size: int = 16) -> list[int]:
    """A dHash of the page: which way the brightness steps, cell by cell.

    Layout, not colour: a page laid out again on another grid moves nearly every
    bit, while a retouch of the same artwork leaves them where they were. It also
    survives a change of proportions, since both sides are squashed to one grid.
    """
    from PIL import Image

    with Image.open(path) as im:
        im = im.convert("L").resize((size + 1, size), Image.LANCZOS)
        px = im.tobytes()               # one grey byte per pixel, row by row
    bits: list[int] = []
    for y in range(size):
        row = px[y * (size + 1):(y + 1) * (size + 1)]
        bits.extend(1 if row[x] > row[x + 1] else 0 for x in range(size))
    return bits


def page_structure(path: Path, size: int = 64) -> float:
    """How much there is on the page at all: an empty one tells us nothing."""
    from PIL import Image

    with Image.open(path) as im:
        px = im.convert("L").resize((size, size), Image.LANCZOS).tobytes()
    return statistics.pstdev(px)


def compare_layout(original: Path, generated: Path) -> dict | None:
    """How far the redesign moved from the page it came from. None if unreadable."""
    try:
        a, b = fingerprint(original), fingerprint(generated)
        structure = max(page_structure(original), page_structure(generated))
    except Exception:
        return None
    if not a or len(a) != len(b):
        return None
    distance = sum(1 for x, y in zip(a, b) if x != y) / len(a)
    if structure < FLAT_PAGE_STD:
        verdict = "unknown"     # a near-blank page moves few bits whatever you do
    elif distance <= COPY_DISTANCE:
        verdict = "copy"
    elif distance <= WEAK_DISTANCE:
        verdict = "weak"
    else:
        verdict = "ok"
    return {
        "distance": round(distance, 3),
        "verdict": verdict,
        "too_similar": verdict == "copy",
        "copy_threshold": COPY_DISTANCE,
        "weak_threshold": WEAK_DISTANCE,
    }


def ocr_image(path: Path, lang: str = "eng") -> str:
    import pytesseract
    from PIL import Image

    with Image.open(path) as im:
        if im.mode not in ("RGB", "L"):
            im = im.convert("RGB")
        # upscale small renders: OCR is much better above ~1600px wide
        if im.width < 1600:
            ratio = 1600 / im.width
            im = im.resize((1600, int(im.height * ratio)))
        return pytesseract.image_to_string(im, lang=lang)


def text_from_pdf_page(pdf: Path, page: int) -> str:
    """The source text layer, or nothing at all: the caller falls back to OCR.

    The row can outlive the file — a report deleted from disk keeping its
    redesigns, a pair uploaded by hand for a report nobody downloaded — and a
    traceback here would leave the caller with no JSON to read.
    """
    try:
        with pymupdf.open(pdf) as doc:
            if page < 1 or page > doc.page_count:
                return ""
            return doc[page - 1].get_text("text") or ""
    except Exception:
        return ""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--original", required=True, help="original page image (relative to project root)")
    ap.add_argument("--generated", required=True, help="redesigned image (relative to project root)")
    ap.add_argument("--pdf", default="", help="source PDF: its text layer beats OCR on the original")
    ap.add_argument("--page", type=int, default=0)
    ap.add_argument("--lang", default="eng")
    a = ap.parse_args()

    gen_path = ROOT / a.generated
    if not gen_path.exists():
        print(json.dumps({"ok": False, "error": "imagen generada no encontrada"}))
        return 1

    # measured before the OCR: it is worth reporting even when the text check
    # cannot run, and it needs no tesseract
    similarity = compare_layout(ROOT / a.original, gen_path)

    # original: prefer the real text layer, fall back to OCR of the render
    original_text = ""
    if a.pdf and a.page:
        original_text = text_from_pdf_page(ROOT / a.pdf, a.page)
    if len(original_text.strip()) < 40:
        orig_path = ROOT / a.original
        if orig_path.exists():
            try:
                original_text = ocr_image(orig_path, a.lang)
            except Exception as e:
                print(json.dumps({"ok": False, "error": f"OCR del original falló: {e}",
                                  "similarity": similarity}))
                return 1

    try:
        generated_text = ocr_image(gen_path, a.lang)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"OCR del rediseño falló: {e}"}))
        return 1

    before = numbers_in(original_text)
    after = numbers_in(generated_text)

    missing = sorted(before - after)
    invented = sorted(after - before)
    kept = len(before & after)

    coverage = kept / len(before) if before else 1.0
    if not before:
        verdict = "unknown"          # nothing measurable on the page
    elif coverage >= 0.85:
        verdict = "clean"
    elif coverage >= 0.6:
        verdict = "warning"
    else:
        verdict = "fail"

    print(json.dumps({
        "ok": True,
        "verdict": verdict,
        "coverage": round(coverage, 2),
        "kept": kept,
        "total_original": len(before),
        "missing": missing[:25],
        "invented": invented[:25],
        "similarity": similarity,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
