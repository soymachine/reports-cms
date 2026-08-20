#!/usr/bin/env python3
"""build_comparison_pdf.py — before / after deck for a lead's redesigns.

The layout follows the studio's HTML mock-up: bone background, near-black
editorial type, white photo frames with a soft shadow and monospace captions.
No accent colour on the "después" side — original and redesign are presented
as equals so the work speaks for itself.

Usage:
  python3 build_comparison_pdf.py <lead_id> [--styles editorial,swiss] [--pages 2,5]
                                  [--pdf-slug SLUG] [--hero-only]
Output: JSON {"ok": true, "file": "generated/1/comparativa-....pdf", "spreads": N}
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

# A4 landscape, in points
PAGE_W, PAGE_H = 842, 595
MARGIN = 58
GUTTER = 22
BAND_H = 82          # teal footer band on the cover and the closing page
BAND_SLIM = 26       # slimmer version on the comparison spreads

# palette taken from the studio's own slide: mint paper, one teal, nothing else
PAPER = (0.851, 0.894, 0.886)     # #D9E4E2
TEAL = (0.180, 0.506, 0.537)      # #2E8189 headlines and band
TEAL_SOFT = (0.298, 0.549, 0.573) # #4C8C92 body copy
BAND_TEXT = (0.678, 0.827, 0.839) # #ADD3D6 secondary line on the band
WHITE = (1, 1, 1)
HAIR = (0.72, 0.80, 0.79)

# Avenir is the closest thing on macOS to the studio's slide; both faces fall back
# to Helvetica when the files are absent (another OS, or a stripped-down box).
FONT_FALLBACK = {"reg": "helv", "bold": "hebo"}
FONT_CANDIDATES = {
    "reg": ["/System/Library/Fonts/Avenir.ttc",
            "/System/Library/Fonts/HelveticaNeue.ttc"],
    "bold": ["/System/Library/Fonts/Avenir Next.ttc"],
}


class Face:
    """One typeface: draws and measures the same way whether embedded or base-14."""

    def __init__(self, alias: str, path: str | None, fallback: str):
        self.alias = alias
        self.path = path
        self.fallback = fallback
        self.font = None
        if path:
            try:
                self.font = pymupdf.Font(fontfile=path)
            except Exception:
                self.path = None

    @property
    def name(self) -> str:
        return self.alias if self.path else self.fallback

    def length(self, text: str, size: float) -> float:
        if self.font:
            return self.font.text_length(text, size)
        return pymupdf.get_text_length(text, fontname=self.fallback, fontsize=size)

    def draw(self, page, xy, text: str, size: float, color) -> None:
        if self.path:
            page.insert_text(xy, text, fontname=self.alias, fontfile=self.path,
                             fontsize=size, color=color)
        else:
            page.insert_text(xy, text, fontname=self.fallback, fontsize=size, color=color)


def pick_font(kind: str, configured: str | None) -> Face:
    paths = [configured] if configured else []
    paths += FONT_CANDIDATES[kind]
    for path in paths:
        if path and Path(path).exists():
            return Face(f"tt{kind}", path, FONT_FALLBACK[kind])
    return Face(f"tt{kind}", None, FONT_FALLBACK[kind])


REG: Face = None      # type: ignore[assignment]  set in main(), after branding is read
BOLD: Face = None     # type: ignore[assignment]

# every piece of copy in the deck, so the language is a single switch
STRINGS = {
    "es": {
        "cover_title": "Antes / Después",
        "subtitle": "{n} página(s) de vuestro informe, reinterpretadas por {studio}.",
        "note": "Los datos son 100 % los de vuestro informe — sólo ha cambiado el diseño.",
        "styles": "Estilos: {list}",
        "page": "Página {n}",
        "tag": "ANTES / DESPUÉS",
        "cap_before": "Original — página {n}",
        "cap_after": "Rediseño — página {n}",
        "closing_kicker": "SOBRE ESTA DEMO",
        "closing_title": "¿Y SI VUESTRO CONTENIDO\nRINDIERA MÁS?",
        "closing_p1": (
            "Hemos elegido algunas páginas de vuestra publicación y las hemos reimaginado para "
            "explorar cómo la misma información puede ser más clara, más atractiva y más memorable "
            "a través del diseño."
        ),
        "closing_p2": (
            "El objetivo es simple: enseñar cómo un enfoque visual más potente mejora la lectura, "
            "ordena la jerarquía y da más impacto a vuestra comunicación."
        ),
        "closing_p3": (
            "Si queréis explorar qué podríamos hacer con vuestros informes, publicaciones o vuestra "
            "comunicación visual, nos encantará hablar con vosotros."
        ),
        "tagline_a": "Los datos tienen valor.",
        "tagline_b": "El impacto empieza por entenderlos.",
        "closing_body": (
            "Hemos cogido páginas reales de vuestro informe y las hemos rediseñado sin tocar "
            "un solo dato: las cifras, los porcentajes y los años son exactamente los vuestros. {note}"
        ),
        "missing_image": "imagen no disponible",
        "footer": "Think Things — estudio de diseño gráfico, Barcelona",
        "filename": "comparativa",
    },
    "en": {
        "cover_title": "Before / After",
        "subtitle": "{n} page(s) from your report, reimagined by {studio}.",
        "note": "The data is 100% yours — only the design has changed.",
        "styles": "Styles: {list}",
        "page": "Page {n}",
        "tag": "BEFORE / AFTER",
        "cap_before": "Original — page {n}",
        "cap_after": "Redesign — page {n}",
        "closing_kicker": "ABOUT THIS DEMO",
        "closing_title": "WHAT IF YOUR CONTENT\nCOULD WORK HARDER?",
        "closing_p1": (
            "We selected a few pages from your existing publication and reimagined them to explore "
            "how the same information could become clearer, more engaging and more memorable "
            "through design."
        ),
        "closing_p2": (
            "The aim is simple: to show how a stronger visual approach can improve readability, "
            "create clearer hierarchy and give your communication more impact."
        ),
        "closing_p3": (
            "If you'd like to explore what we could do with your reports, publications or wider "
            "visual communication, we'd love to hear from you."
        ),
        "tagline_a": "Data has value.",
        "tagline_b": "Impact starts with understanding.",
        "closing_body": (
            "We took real pages from your report and redesigned them without touching a single "
            "figure: the numbers, percentages and years are exactly yours. {note}"
        ),
        "missing_image": "image unavailable",
        "footer": "Think Things — graphic design studio, Barcelona",
        "filename": "comparison",
    },
}

LANG = "es"   # set from --lang before anything is drawn


def t(key: str, **kw) -> str:
    return STRINGS[LANG][key].format(**kw)


def branding() -> dict:
    """Studio identity. Keys may carry an `_en` variant used when LANG is english."""
    default = {
        "studio": "Think Things",
        "logo": "dashboard/public/Logo_TT2024_negro_horitzontal.png",
        "logo_white": "",          # version for the teal band; skipped when absent
        "footer": t("footer"),
        "contact": "",
        "website": "thinkthings.es",
        "cover_title": t("cover_title"),
        "note": t("note"),
        "tagline_a": t("tagline_a"),
        "tagline_b": t("tagline_b"),
        "font_regular": "",
        "font_bold": "",
    }
    try:
        cfg = json.loads((ROOT / "settings.json").read_text()).get("branding", {})
    except Exception:
        cfg = {}

    for key in ("studio", "logo", "logo_white", "footer", "contact", "website",
                "cover_title", "note", "tagline_a", "tagline_b",
                "font_regular", "font_bold"):
        localised = cfg.get(f"{key}_{LANG}")
        generic = cfg.get(key)
        # a Spanish-only override must not leak into the english deck
        if localised:
            default[key] = localised
        elif generic and (LANG == "es" or key in ("studio", "logo", "logo_white", "contact",
                                                  "website", "font_regular", "font_bold")):
            default[key] = generic
    return default


# ------------------------------------------------------------------ drawing

def tracked(page, xy, text, *, face=None, size=8, color=None, tracking=1.6):
    """insert_text has no letter-spacing, so lay the glyphs out by hand."""
    face = face or BOLD
    color = TEAL_SOFT if color is None else color
    x, y = xy
    for ch in text:
        face.draw(page, (x, y), ch, size, color)
        x += face.length(ch, size) + tracking
    return x


def tracked_width(text: str, size: float, tracking: float = 1.6, face=None) -> float:
    face = face or BOLD
    return sum(face.length(ch, size) + tracking for ch in text)


def wrap(text: str, width: float, face, size: float) -> list[str]:
    lines, current = [], ""
    for word in text.split():
        probe = f"{current} {word}".strip()
        if face.length(probe, size) <= width:
            current = probe
        else:
            if current:
                lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


def paragraph(page, text: str, x: float, y: float, width: float, *,
              face=None, size=13.5, leading=21, color=None, limit=12) -> float:
    """Draw a wrapped block and return the y just below it."""
    face = face or REG
    color = TEAL_SOFT if color is None else color
    for line in wrap(text, width, face, size)[:limit]:
        face.draw(page, (x, y), line, size, color)
        y += leading
    return y


TEXTURE = ROOT / "assets" / "paper-texture.png"
_texture_xref: dict[int, int] = {}


def ensure_texture() -> Path | None:
    """Fibrous paper texture, generated once and reused by every deck.

    The studio's slide is printed on textured stock; a flat fill next to it looks
    like a different brand. Pillow is optional: without it the paper stays flat.
    """
    if TEXTURE.exists():
        return TEXTURE
    try:
        import random
        from PIL import Image, ImageDraw, ImageFilter
    except ImportError:
        return None

    w, h = 1000, 707
    rnd = random.Random(7)          # fixed seed: the same paper on every deck
    base = tuple(round(c * 255) for c in PAPER)
    img = Image.new("RGB", (w, h), base)
    px = img.load()
    for y in range(h):              # fine grain
        for x in range(w):
            n = rnd.randint(-6, 6)
            r, g, b = px[x, y]
            px[x, y] = (max(0, min(255, r + n)), max(0, min(255, g + n)), max(0, min(255, b + n)))
    draw = ImageDraw.Draw(img, "RGBA")
    for _ in range(1400):           # short fibres
        x, y = rnd.randrange(w), rnd.randrange(h)
        dx, dy = rnd.randint(-9, 9), rnd.randint(-3, 3)
        shade = rnd.choice([(255, 255, 255, 26), (0, 0, 0, 14)])
        draw.line((x, y, x + dx, y + dy), fill=shade, width=1)
    for _ in range(2):              # long soft creases, like the reference
        x = rnd.randrange(w)
        pts = [(x + rnd.randint(-22, 22), y) for y in range(0, h + 1, 90)]
        draw.line(pts, fill=(255, 255, 255, 20), width=2)
    img = img.filter(ImageFilter.GaussianBlur(0.4))
    TEXTURE.parent.mkdir(parents=True, exist_ok=True)
    # a 64-colour palette keeps the noise cheap: ~150 KB instead of ~1.5 MB
    img.convert("P", palette=Image.ADAPTIVE, colors=64).save(TEXTURE, optimize=True)
    return TEXTURE


def paper(doc):
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    page.draw_rect(pymupdf.Rect(0, 0, PAGE_W, PAGE_H), color=PAPER, fill=PAPER)
    tex = ensure_texture()
    if tex:
        full = pymupdf.Rect(0, 0, PAGE_W, PAGE_H)
        xref = _texture_xref.get(id(doc))
        try:
            # reuse the same image object: one copy in the file, not one per page
            if xref:
                page.insert_image(full, xref=xref)
            else:
                _texture_xref[id(doc)] = page.insert_image(full, filename=str(tex))
        except Exception:
            pass
    return page


def place_logo(page, box: pymupdf.Rect, *, white: bool = False) -> None:
    b = branding()
    rel = b.get("logo_white") if white else b.get("logo")
    if not rel:
        return
    logo = ROOT / rel
    if not logo.exists():
        return
    try:
        with pymupdf.open(logo) as doc:
            w, h = doc[0].rect.width, doc[0].rect.height
        scale = min(box.width / w, box.height / h)
        page.insert_image(pymupdf.Rect(box.x0, box.y0, box.x0 + w * scale, box.y0 + h * scale),
                          filename=str(logo))
    except Exception:
        pass


def band(page, *, slim: bool = False, right: str = "") -> None:
    """The teal footer of the studio's slide: two taglines left, site right."""
    b = branding()
    h = BAND_SLIM if slim else BAND_H
    rect = pymupdf.Rect(0, PAGE_H - h, PAGE_W, PAGE_H)
    page.draw_rect(rect, color=TEAL, fill=TEAL)

    site = right or b.get("website", "")
    if slim:
        REG.draw(page, (MARGIN, PAGE_H - 9), b.get("tagline_a", ""), 8.5, BAND_TEXT)
        if site:
            BOLD.draw(page, (PAGE_W - MARGIN - BOLD.length(site, 8.5), PAGE_H - 9), site, 8.5, WHITE)
        return

    REG.draw(page, (MARGIN, PAGE_H - 45), b.get("tagline_a", ""), 13, BAND_TEXT)
    BOLD.draw(page, (MARGIN, PAGE_H - 25), b.get("tagline_b", ""), 13, WHITE)
    if site:
        BOLD.draw(page, (PAGE_W - MARGIN - BOLD.length(site, 13.5) - 46, PAGE_H - 25), site, 13.5, WHITE)
    place_logo(page, pymupdf.Rect(PAGE_W - MARGIN - 34, PAGE_H - h + 14, PAGE_W - MARGIN, PAGE_H - 14),
               white=True)


def framed_image(page, img: Path, box: pymupdf.Rect, caption: str) -> None:
    """White mount with a soft drop shadow, caption in tracked caps below."""
    cap_h = 20
    frame_box = pymupdf.Rect(box.x0, box.y0, box.x1, box.y1 - cap_h)
    pad = 9

    if not img.exists():
        REG.draw(page, (box.x0, box.y0 + 14), t("missing_image"), 9, TEAL_SOFT)
        return

    try:
        with pymupdf.open(img) as doc:
            iw, ih = doc[0].rect.width, doc[0].rect.height
    except Exception:
        iw = ih = 0

    inner = pymupdf.Rect(frame_box.x0 + pad, frame_box.y0 + pad, frame_box.x1 - pad, frame_box.y1 - pad)
    if iw and ih:
        scale = min(inner.width / iw, inner.height / ih)
        w, h = iw * scale, ih * scale
        # the mount hugs the image so the frame never floats around empty space
        cx = (frame_box.x0 + frame_box.x1) / 2
        inner = pymupdf.Rect(cx - w / 2, frame_box.y0 + pad, cx + w / 2, frame_box.y0 + pad + h)
        frame_box = pymupdf.Rect(inner.x0 - pad, inner.y0 - pad, inner.x1 + pad, inner.y1 + pad)

    # shadow: two translucent offsets read as a soft blur at print size
    for dx, dy, alpha in ((3, 4, 0.10), (1.5, 2, 0.08)):
        page.draw_rect(frame_box + (dx, dy, dx, dy), color=None, fill=(0, 0, 0), fill_opacity=alpha)

    page.draw_rect(frame_box, color=None, fill=WHITE)
    page.insert_image(inner, filename=str(img))

    tracked(page, (frame_box.x0, frame_box.y1 + 14), caption.upper(), size=7.5, tracking=1.4)


# -------------------------------------------------------------------- pages

def headline(page, text: str, x: float, y: float, width: float, size: float,
             leading: float | None = None) -> float:
    """Uppercase teal headline, the way the studio sets it."""
    leading = leading or size + 9
    for para in text.split("\n"):
        for line in wrap(para.upper(), width, BOLD, size):
            BOLD.draw(page, (x, y), line, size, TEAL)
            y += leading
    return y


def cover(doc, lead: sqlite3.Row, spreads: int, styles: list[str]) -> None:
    b = branding()
    page = paper(doc)

    org = str(lead["organisation"])
    max_w = PAGE_W - 2 * MARGIN - 90

    size = 30
    while size > 19 and len(wrap(org.upper(), max_w, BOLD, size)) > 2:
        size -= 2

    y = headline(page, org, MARGIN, 150, max_w, size)
    y = headline(page, b["cover_title"], MARGIN, y + 8, max_w, size)

    sub = t("subtitle", n=spreads, studio=b["studio"]) + " " + b.get("note", "")
    y = paragraph(page, sub, MARGIN, y + 26, 560, size=13.5, leading=21, limit=4)

    meta = [m for m in (lead["sector"], lead["country"]) if m]
    if meta:
        tracked(page, (MARGIN, y + 18), " · ".join(str(m) for m in meta).upper(), size=8)
    if styles:
        tracked(page, (MARGIN, y + 36), t("styles", list=", ".join(styles)).upper(), size=8)

    band(page)


def spread(doc, item: dict, index: int, total: int) -> None:
    page = paper(doc)

    head_y = MARGIN - 6
    BOLD.draw(page, (MARGIN, head_y), f"{index:02d} · " + t("page", n=item["page"]).upper(), 17, TEAL)

    tag = t("tag")
    tracked(page, (PAGE_W - MARGIN - tracked_width(tag, 8, 1.6), head_y - 2), tag, size=8)

    page.draw_line(pymupdf.Point(MARGIN, head_y + 13), pymupdf.Point(PAGE_W - MARGIN, head_y + 13),
                   color=TEAL, width=1.2)

    top = head_y + 32
    bottom = PAGE_H - BAND_SLIM - 26
    col_w = (PAGE_W - 2 * MARGIN - GUTTER) / 2

    framed_image(page, ROOT / item["original_img"],
                 pymupdf.Rect(MARGIN, top, MARGIN + col_w, bottom),
                 t("cap_before", n=item["page"]))
    framed_image(page, ROOT / item["generated_img"],
                 pymupdf.Rect(MARGIN + col_w + GUTTER, top, PAGE_W - MARGIN, bottom),
                 t("cap_after", n=item["page"]))

    band(page, slim=True, right=f"{index}/{total}")


def closing(doc, lead: sqlite3.Row) -> None:
    b = branding()
    page = paper(doc)

    col = PAGE_W - 2 * MARGIN - 210        # the reference keeps a wide right margin
    y = headline(page, t("closing_title"), MARGIN, 132, col + 60, 26, leading=34)

    y += 26
    for key in ("closing_p1", "closing_p2", "closing_p3"):
        y = paragraph(page, t(key), MARGIN, y, col, size=13.5, leading=21, limit=5) + 18

    if b.get("contact"):
        tracked(page, (MARGIN, PAGE_H - BAND_H - 26), b["contact"].upper(), size=8)

    band(page)


# --------------------------------------------------------------------- main

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("lead_id", type=int)
    ap.add_argument("--styles", default="", help="comma-separated style ids; empty = all")
    ap.add_argument("--pages", default="", help="comma-separated page numbers; empty = all")
    ap.add_argument("--pdf-slug", default="", help="restrict to one source report")
    ap.add_argument("--hero-only", action="store_true", help="only the redesigns marked as winners")
    ap.add_argument("--allow-failed-qc", action="store_true",
                    help="include redesigns whose data check failed (blocked by default: "
                         "the cover promises the figures are untouched)")
    ap.add_argument("--select", default="",
                    help="comma-separated generated_img paths to include, in that exact order. "
                         "Overrides --styles/--pages/--hero-only and can pick older versions.")
    ap.add_argument("--lang", default="es", choices=sorted(STRINGS.keys()), help="deck language")
    a = ap.parse_args()

    global LANG, REG, BOLD
    LANG = a.lang
    b = branding()
    REG = pick_font("reg", b.get("font_regular") or None)
    BOLD = pick_font("bold", b.get("font_bold") or None)

    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    lead = conn.execute("SELECT * FROM leads WHERE id = ?", (a.lead_id,)).fetchone()
    if not lead:
        print(json.dumps({"ok": False, "error": "lead not found"}))
        return 1

    items = json.loads(lead["generated"] or "[]")
    items = [g for g in items if g.get("original_img") and g.get("generated_img")]

    # An explicit picture list wins over every filter: the dashboard already decided
    # which image of which page and version goes in, including older versions.
    picked = [x.strip() for x in a.select.split(",") if x.strip()] if a.select else []
    if picked:
        by_img = {}
        for g in items:
            by_img.setdefault(g["generated_img"], g)
        chosen = [by_img[img] for img in picked if img in by_img]
        missing = [img for img in picked if img not in by_img]
        if not chosen:
            print(json.dumps({"ok": False, "error": "ninguna de las imágenes elegidas existe en este lead"},
                             ensure_ascii=False))
            return 1
        items = chosen
    else:
        items = [g for g in items if not g.get("superseded")]
        missing = []

    if not picked:
        if a.pdf_slug:
            items = [g for g in items if g.get("pdf") == a.pdf_slug]
        if a.styles:
            wanted = {s.strip() for s in a.styles.split(",") if s.strip()}
            items = [g for g in items if g.get("style") in wanted]
        if a.pages:
            wanted_pages = {int(p) for p in a.pages.split(",") if p.strip().isdigit()}
            items = [g for g in items if int(g.get("page", 0)) in wanted_pages]
        if a.hero_only:
            heroes = [g for g in items if g.get("hero")]
            items = heroes or items

    # The cover states the data is 100 % the client's. A redesign whose OCR check
    # says figures went missing or were invented must not go out under that claim.
    blocked = []
    if not a.allow_failed_qc:
        kept = []
        for g in items:
            if (g.get("qc") or {}).get("verdict") == "fail":
                blocked.append({"page": g.get("page"), "style": g.get("styleName") or g.get("style"),
                                "image": g.get("generated_img"),
                                "missing": (g.get("qc") or {}).get("missing", [])[:8]})
            else:
                kept.append(g)
        items = kept

    if not items:
        error = ("todos los rediseños elegidos tienen el control de datos en fallo"
                 if blocked else "no hay rediseños que cumplan el filtro")
        print(json.dumps({"ok": False, "error": error, "blocked": blocked}, ensure_ascii=False))
        return 1

    if not picked:      # an explicit selection keeps the order the user gave it
        items.sort(key=lambda g: (str(g.get("styleName") or g.get("style")), int(g.get("page", 0))))
    styles = sorted({str(g.get("styleName") or g.get("style")) for g in items})

    out_dir = ROOT / "generated" / str(a.lead_id)
    out_dir.mkdir(parents=True, exist_ok=True)
    slug = re.sub(r"[^A-Za-z0-9_-]+", "-", str(lead["organisation"]).lower()).strip("-")[:40]
    out = out_dir / f"{t('filename')}-{slug}-{datetime.date.today().isoformat()}.pdf"

    doc = pymupdf.open()
    cover(doc, lead, len(items), styles)
    for i, item in enumerate(items, start=1):
        spread(doc, item, i, len(items))
    closing(doc, lead)
    doc.save(out, deflate=True)
    doc.close()

    rel = str(out.relative_to(ROOT))
    tl = json.loads(lead["timeline"] or "[]")
    tl.append({"type": "comparison_pdf",
               "text": f"PDF comparativo generado ({len(items)} spreads, {len(styles)} estilo(s))",
               "date": datetime.datetime.now().isoformat()})
    conn.execute("UPDATE leads SET timeline = ?, updated_at = datetime('now') WHERE id = ?",
                 (json.dumps(tl, ensure_ascii=False), a.lead_id))
    conn.commit()
    conn.close()

    print(json.dumps({"ok": True, "file": rel, "spreads": len(items), "lang": LANG,
                      "styles": styles, "size_kb": round(out.stat().st_size / 1024),
                      "missing": missing, "blocked": blocked}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
