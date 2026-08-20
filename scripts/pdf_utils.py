#!/usr/bin/env python3
"""pdf_utils.py — shared PDF analysis: page visual scoring, report quality, dates.

Used by render_pages.py (to pre-select the most visual pages) and by
pdf_finder.py (to reject documents that are not really reports).
"""
from __future__ import annotations

import datetime
import re
from pathlib import Path

try:
    import pymupdf  # PyMuPDF >= 1.24
except ImportError:  # pragma: no cover - older wheels expose `fitz`
    import fitz as pymupdf


# ---------------------------------------------------------------- page scoring

def score_page(page) -> dict:
    """Score one page 0-100 by how visually rich it is.

    A page worth redesigning has charts, images or diagrams — not a wall of
    text and not a near-empty divider. The weights are tuned for corporate
    reports: vector drawings (charts) count more than photos.
    """
    rect = page.rect
    area = max(rect.width * rect.height, 1)

    images = page.get_images(full=True)
    n_images = len(images)
    img_area = 0.0
    for img in images:
        try:
            for r in page.get_image_rects(img[0]):
                img_area += r.width * r.height
        except Exception:
            continue

    try:
        drawings = page.get_drawings()
    except Exception:
        drawings = []
    n_drawings = len(drawings)
    # crude chart detector: many small filled/stroked paths clustered together
    filled = sum(1 for d in drawings if d.get("fill") is not None)

    text = page.get_text("text") or ""
    words = len(text.split())

    # Hard data is what the demo sells: the deck promises every figure survives
    # the redesign, so a page full of percentages and years is worth more than a
    # pretty but empty one.
    figures = len(re.findall(r"(?<![\w/])\d[\d.,]*\s?%|(?<![\w/])(?:19|20)\d{2}(?![\w/])"
                             r"|(?<![\w/])\d{1,3}(?:[.,]\d{3})+(?![\w/])", text))
    # table-ish: rows of short cells separated by runs of spaces
    table_rows = sum(1 for line in text.splitlines() if len(re.findall(r"\s{2,}", line)) >= 2)
    # indexes and bibliographies look rich to a naive scorer and redesign badly
    leaders = len(re.findall(r"\.{4,}\s*\d+\s*$", text, re.M))
    refs = len(re.findall(r"https?://|doi:|ISBN", text, re.I))

    img_cov = min(img_area / area, 1.0)

    score = 0.0
    score += min(n_drawings / 40.0, 1.0) * 42      # charts / diagrams
    score += min(filled / 25.0, 1.0) * 13          # filled shapes = data marks
    score += img_cov * 30                          # photography / figures
    score += min(n_images / 4.0, 1.0) * 10         # several distinct figures
    # text: some is good (labels, titles), a wall of it is not
    if words < 15:
        score -= 12                                # near-empty page / divider
    elif words > 700:
        score -= 14                                # dense body copy
    elif 40 <= words <= 320:
        score += 5

    score += min(figures / 12.0, 1.0) * 16         # numbers, percentages, years
    score += min(table_rows / 10.0, 1.0) * 8       # tables redesign very well
    if leaders >= 4:
        score -= 35                                # table of contents
    if refs >= 8:
        score -= 25                                # bibliography / link dump

    score = max(0.0, min(100.0, score))

    bits = []
    if n_drawings:
        bits.append(f"{n_drawings} gráficos")
    if figures:
        bits.append(f"{figures} cifras")
    if table_rows >= 3:
        bits.append(f"tabla de ~{table_rows} filas")
    if img_cov >= 0.15:
        bits.append(f"{round(img_cov * 100)}% imagen")
    if leaders >= 4:
        bits.append("parece un índice")
    if refs >= 8:
        bits.append("parece bibliografía")
    if words > 700:
        bits.append("mucho texto")
    elif words < 15:
        bits.append("casi vacía")

    return {
        "score": round(score, 1),
        "images": n_images,
        "image_coverage": round(img_cov, 3),
        "drawings": n_drawings,
        "words": words,
        "figures": figures,
        "table_rows": table_rows,
        "reason": " · ".join(bits) or "sin elementos destacables",
    }


def score_pdf_pages(pdf_path: Path) -> list[dict]:
    """Return per-page scores, page numbers 1-indexed."""
    out = []
    with pymupdf.open(pdf_path) as doc:
        for i, page in enumerate(doc, start=1):
            try:
                info = score_page(page)
            except Exception:
                info = {"score": 0.0, "images": 0, "image_coverage": 0.0, "drawings": 0, "words": 0}
            info["page"] = i
            out.append(info)
    return out


def recommended_pages(scores: list[dict], limit: int = 4, skip_cover: bool = True) -> list[int]:
    """Best pages to redesign: highest scoring, spread across the document.

    The cover is usually already designed, so it is skipped unless nothing
    else scores. Pages adjacent to an already-picked one are avoided so the
    selection does not land on one single chapter.
    """
    pool = [s for s in scores if not (skip_cover and s["page"] == 1)] or scores
    ranked = sorted(pool, key=lambda s: (-s["score"], s["page"]))
    picked: list[int] = []
    for s in ranked:
        if len(picked) >= limit:
            break
        if any(abs(s["page"] - p) < 2 for p in picked):
            continue
        if s["score"] <= 0:
            continue
        picked.append(s["page"])
    # top up ignoring the spread rule if we came up short
    for s in ranked:
        if len(picked) >= limit:
            break
        if s["page"] not in picked and s["score"] > 0:
            picked.append(s["page"])
    return sorted(picked)


# ------------------------------------------------------------------- palette

def _hex(rgb: tuple[int, int, int]) -> str:
    return "#{:02X}{:02X}{:02X}".format(*rgb)


def page_palette(pdf_path: Path, pages: list[int] | None = None, top: int = 5) -> list[dict]:
    """Dominant brand colours of the report, ignoring paper and ink.

    Renders the pages small, buckets colours coarsely and drops near-white,
    near-black and greys — what is left is the palette a redesign should
    respect. Returned brightest-weighted first so the accent leads.
    """
    counts: dict[tuple[int, int, int], int] = {}
    with pymupdf.open(pdf_path) as doc:
        targets = pages or list(range(1, min(doc.page_count, 12) + 1))
        for n in targets:
            if n < 1 or n > doc.page_count:
                continue
            pix = doc[n - 1].get_pixmap(dpi=36)
            data = pix.samples
            step = pix.n
            for i in range(0, len(data) - step + 1, step * 3):  # sample every 3rd pixel
                r, g, b = data[i], data[i + 1], data[i + 2]
                mx, mn = max(r, g, b), min(r, g, b)
                if mx > 240 and mn > 225:
                    continue                     # paper
                if mx < 45:
                    continue                     # ink / black
                if mx - mn < 28:
                    continue                     # grey: no hue to speak of
                key = (r // 24 * 24, g // 24 * 24, b // 24 * 24)
                counts[key] = counts.get(key, 0) + 1

    total = sum(counts.values()) or 1
    ranked = sorted(counts.items(), key=lambda kv: -kv[1])[:top]
    return [
        {"hex": _hex((min(r + 12, 255), min(g + 12, 255), min(b + 12, 255))),
         "share": round(c / total, 3)}
        for (r, g, b), c in ranked
    ]


# ------------------------------------------------------------- report quality

def _parse_pdf_date(raw: str | None) -> str | None:
    """PDF dates look like D:20240917120000+02'00'."""
    if not raw:
        return None
    m = re.search(r"(\d{4})(\d{2})?(\d{2})?", str(raw))
    if not m:
        return None
    year = int(m.group(1))
    if not (1990 <= year <= datetime.date.today().year + 1):
        return None
    month = int(m.group(2) or 1)
    day = int(m.group(3) or 1)
    try:
        return datetime.date(year, max(1, min(12, month)), max(1, min(28, day))).isoformat()
    except ValueError:
        return None


def published_date(pdf_path: Path, filename_hint: str = "") -> str | None:
    """Best guess at when the report was published: metadata first, then a year in the name."""
    try:
        with pymupdf.open(pdf_path) as doc:
            meta = doc.metadata or {}
        for key in ("creationDate", "modDate"):
            got = _parse_pdf_date(meta.get(key))
            if got:
                return got
    except Exception:
        pass

    m = re.search(r"(20[12]\d)", filename_hint or pdf_path.name)
    if m:
        return f"{m.group(1)}-01-01"
    return None


def report_quality(pdf_path: Path, min_pages: int = 8) -> dict:
    """Decide whether a PDF is a real report worth keeping.

    Rejects short documents, forms, and text-only press releases — the three
    things the DuckDuckGo search keeps dragging in.
    """
    try:
        with pymupdf.open(pdf_path) as doc:
            n = doc.page_count
            if n == 0:
                return {"ok": False, "reason": "PDF vacío", "pages": 0}

            sample_idx = sorted({0, n // 4, n // 2, (3 * n) // 4, n - 1})
            visual, words_total, form_hits = 0, 0, 0
            for i in sample_idx:
                page = doc[i]
                info = score_page(page)
                words_total += info["words"]
                if info["score"] >= 25:
                    visual += 1
                text = (page.get_text("text") or "").lower()
                if any(k in text for k in ("please complete", "rellene", "signature", "firma:", "application form", "formulario")):
                    form_hits += 1

            has_form_fields = bool(doc.is_form_pdf)

        avg_words = words_total / max(len(sample_idx), 1)
        visual_ratio = visual / max(len(sample_idx), 1)

        if n < min_pages:
            return {"ok": False, "reason": f"solo {n} páginas (mín. {min_pages})", "pages": n}
        if has_form_fields or form_hits >= 2:
            return {"ok": False, "reason": "parece un formulario", "pages": n}
        if visual_ratio == 0 and avg_words > 500:
            return {"ok": False, "reason": "solo texto, sin contenido visual", "pages": n}

        return {
            "ok": True,
            "pages": n,
            "visual_ratio": round(visual_ratio, 2),
            "avg_words": round(avg_words),
        }
    except Exception as e:
        return {"ok": False, "reason": f"no se pudo leer el PDF ({e})", "pages": 0}


if __name__ == "__main__":
    import json
    import sys

    target = Path(sys.argv[1])
    scores = score_pdf_pages(target)
    print(json.dumps({
        "quality": report_quality(target),
        "published": published_date(target),
        "recommended": recommended_pages(scores),
        "top": sorted(scores, key=lambda s: -s["score"])[:6],
    }, indent=2, ensure_ascii=False))
