#!/usr/bin/env python3
"""generate_redesign.py — redesign PDF pages as new aesthetic images via Magnific MCP.

Calls the magnific MCP directly (see magnific_client.py) taking each selected
page image and produces a redesigned, high-aesthetic version of it. Saves the
results under generated/{lead_id}/redesigns/ and registers them in leads.generated.

Usage:
  python3 generate_redesign.py <lead_id> --pages 2,5,7 --pdf-slug SLUG [--style-prompt "..."] [--extra-prompt "..."]
Status file: .generate_status.json  (spawn + poll pattern from dashboard)
"""
import argparse
import datetime
import json
import re
import sqlite3
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "leads.db"
STATUS_FILE = ROOT / ".generate_status.json"

def compose_magnific_prompt(style_prompt: str, extra: str, palette: str, feedback: str,
                            refine: bool = False, consistent: bool = False) -> str:
    """The literal prompt handed to Magnific.

    Built here, in one place, so what the dashboard previews is byte for byte
    what the agent is told to send. Order matters: corrections outrank the
    team's instructions, which outrank the base style.
    """
    parts = [
        "Premium editorial report page redesign, bold modern typography, sophisticated "
        "data visualization, elegant layout, high-end design studio quality, clean grid, "
        "striking visual hierarchy. Keep every figure, percentage and year exactly as in "
        "the original page."
    ]
    if style_prompt.strip():
        parts.append(f"Estilo: {style_prompt.strip()}")
    if palette.strip():
        parts.append(f"Paleta obligatoria (colores del informe original): {palette.strip()}")
    if extra.strip():
        parts.append(f"INDICACIONES DEL EQUIPO (prioritarias sobre el estilo): {extra.strip()}")
    if feedback.strip():
        parts.append(f"CORRECCIONES sobre el intento anterior (máxima prioridad): {feedback.strip()}")
    if refine:
        parts.append(
            "PUNTO DE PARTIDA: la imagen de referencia YA es un rediseño aprobado. Conserva su "
            "composición, tipografía, paleta y elementos gráficos, y aplica ÚNICAMENTE las "
            "correcciones indicadas arriba. No rediseñes la página desde cero."
        )
    if consistent:
        parts.append(
            "COHERENCIA DE SERIE (obligatoria): esta página forma parte de un mismo documento. "
            "Usa EXACTAMENTE el mismo sistema visual que la imagen de referencia de estilo: la "
            "misma paleta, la misma familia y jerarquía tipográfica, la misma retícula y márgenes, "
            "el mismo tratamiento de gráficos, títulos y pies. Solo cambia el contenido de la "
            "página; el diseño debe parecer del mismo maquetador y del mismo informe."
        )
    return "\n".join(parts)



def archive_previous_versions(generated: list, out_dir: Path, pages: list[int],
                              pdf_slug: str, style_id: str) -> dict[str, str]:
    """Move the images this run is about to overwrite out of the way.

    The agent always writes page-{NN}-{style}-redesign.png, so a rerun used to
    clobber the previous attempt: the version history kept the row but the pixels
    were gone. Rename the old file to ...-vN.png first and repoint every entry
    that referenced it. Returns the {old path: new path} mapping.
    """
    moved: dict[str, str] = {}
    for entry in generated:
        if entry.get("pdf") != pdf_slug or entry.get("style") != style_id:
            continue
        if int(entry.get("page") or 0) not in pages:
            continue
        rel = entry.get("generated_img") or ""
        if not rel or rel in moved:
            continue
        old = ROOT / rel
        # only files this run could overwrite, and not ones already archived
        if old.parent != out_dir or not old.exists() or re.search(r"-v\d+$", old.stem):
            continue
        version = int(entry.get("version") or 1)
        new = out_dir / f"{old.stem}-v{version}{old.suffix}"
        n = version
        while new.exists():
            n += 1
            new = out_dir / f"{old.stem}-v{n}{old.suffix}"
        old.rename(new)
        moved[rel] = str(new.relative_to(ROOT))

    if moved:
        for entry in generated:
            if entry.get("generated_img") in moved:
                entry["generated_img"] = moved[entry["generated_img"]]
            if entry.get("base_img") in moved:
                entry["base_img"] = moved[entry["base_img"]]
    return moved


ASPECTS = {"1:1": 1.0, "3:4": 0.75, "2:3": 0.667, "9:16": 0.5625, "4:5": 0.8,
           "4:3": 1.333, "3:2": 1.5, "16:9": 1.778, "5:4": 1.25}


def nearest_aspect(img: Path) -> str:
    """Report pages are portrait; keeping the ratio avoids a re-cropped redesign."""
    try:
        from PIL import Image
        with Image.open(img) as im:
            ratio = im.width / im.height
    except Exception:
        return ""
    return min(ASPECTS, key=lambda k: abs(ASPECTS[k] - ratio))


def run_direct(originals, refs, out_dir: Path, style_file: str, magnific_prompt: str,
               model: str, resolution: str, quality: str,
               consistent: bool = True, anchor_img: Path | None = None,
               consistent_prompt: str | None = None
               ) -> tuple[list[dict], float, list[str], float | None]:
    """Generate straight through the MCP API: one call, one image, exact credits.

    Returns (files, credits spent, errors, credits left in the account).
    """
    sys.path.insert(0, str(Path(__file__).parent))
    from magnific_client import Magnific, MagnificAuthError, MagnificError

    produced: list[dict] = []
    errors: list[str] = []
    total_credits = 0.0

    with Magnific() as m:
        uploaded: dict[str, str] = {}

        def identifier_for(path: Path) -> str:
            key = str(path)
            if key not in uploaded:
                uploaded[key] = m.upload_image(path)
            return uploaded[key]

        # Pages generated independently come out looking like four different
        # studios. The first image of the run (or one handed in from an earlier
        # run) is passed to the others as a style reference so the set matches.
        anchor: str | None = None
        if consistent and anchor_img is not None:
            try:
                anchor = identifier_for(anchor_img)
            except MagnificError as e:
                errors.append(f"referencia de estilo no usable: {e}")

        for page, original in originals:
            ref_path = refs[page]
            try:
                out = m.generate(
                    prompt=(consistent_prompt or magnific_prompt) if anchor else magnific_prompt,
                    reference=identifier_for(ref_path),
                    style_reference=anchor if consistent else None,
                    mode=model,
                    resolution=resolution,
                    quality=quality,
                    aspect_ratio=nearest_aspect(original),
                )
            except MagnificError as e:
                errors.append(f"página {page}: {e}")
                continue

            if not out.get("url"):
                errors.append(f"página {page}: la creación no devolvió imagen")
                continue
            dest = out_dir / f"page-{page:02d}-{style_file}-redesign.png"
            try:
                m.download(out["url"], dest)
            except Exception as e:
                errors.append(f"página {page}: no se pudo descargar ({e})")
                continue
            credits = float(out.get("credits") or 0)
            total_credits += credits
            produced.append({"page": page, "path": dest, "credits": credits,
                             "anchor": anchor})
            if consistent and not anchor and out.get("identifier"):
                anchor = out["identifier"]          # the rest of the run follows this one

        left = None
        try:                                     # free call, and the only true balance
            left = float(m.account_balance().get("credits", {}).get("available"))
        except Exception:
            pass

    return produced, total_credits, errors, left


def run_qc(entry: dict, source_pdf: Path | None) -> dict:
    """OCR check that the redesign kept the original figures."""
    cmd = [sys.executable, str(Path(__file__).with_name("qc_redesign.py")),
           "--original", entry["original_img"], "--generated", entry["generated_img"]]
    if source_pdf and source_pdf.exists():
        cmd += ["--pdf", str(source_pdf.relative_to(ROOT)), "--page", str(entry["page"])]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=180, cwd=str(ROOT))
        return json.loads(res.stdout.strip().split("\n")[-1])
    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}


def finish_job(conn, job_id: int, state: str, result: dict | None = None,
               error: str | None = None, credits: float | None = None) -> None:
    if not job_id:
        return
    conn.execute(
        """UPDATE jobs SET state = ?, result = ?, error = ?, credits = COALESCE(?, credits),
                  finished_at = datetime('now')
            WHERE id = ?""",
        (state, json.dumps(result, ensure_ascii=False) if result else None, error, credits, job_id),
    )
    conn.commit()


def set_status(state: str, **kw) -> None:
    STATUS_FILE.write_text(json.dumps({"state": state, "ts": datetime.datetime.now().isoformat(), **kw}))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("lead_id", type=int)
    ap.add_argument("--pages", required=True, help="comma-separated page numbers")
    ap.add_argument("--pdf-slug", required=True, help="slug folder under generated/{id}/pages/")
    ap.add_argument("--style-prompt", default="editorial premium, tipografía moderna, paleta elegante")
    ap.add_argument("--style-id", default="editorial", help="preset id")
    ap.add_argument("--style-name", default="Editorial Premium", help="preset display name")
    ap.add_argument("--extra-prompt", default="", help="free-text extra instructions from the dashboard")
    ap.add_argument("--job-id", type=int, default=0, help="jobs row to report progress into")
    ap.add_argument("--feedback", default="", help="what to fix from a previous attempt")
    ap.add_argument("--palette", default="", help="comma-separated hex colours of the source report")
    ap.add_argument("--model", default="", help="Magnific model slug for images_generate `mode` "
                                                "(empty or 'auto' lets Magnific choose)")
    ap.add_argument("--resolution", default="", help="images_generate `resolution`, e.g. 1k/2k/4k")
    ap.add_argument("--quality", default="", help="images_generate `quality`, e.g. low/medium/high")
    ap.add_argument("--base-img", default="",
                    help="refine this existing redesign (path relative to the project root) "
                         "instead of starting again from the rendered PDF page")
    ap.add_argument("--no-consistency", action="store_true",
                    help="generate each page on its own; by default the first image of the run "
                         "is used as a style reference so the set looks like one document")
    ap.add_argument("--style-anchor", default="",
                    help="existing redesign (path relative to the project root) whose look the "
                         "new pages must follow — for adding pages to a deck that already exists")
    ap.add_argument("--no-qc", action="store_true", help="skip the OCR data check")
    ap.add_argument("--print-prompt", action="store_true",
                    help="print the exact Magnific prompt and exit, without generating")
    a = ap.parse_args()

    consistent = not a.no_consistency
    magnific_prompt = compose_magnific_prompt(a.style_prompt, a.extra_prompt, a.palette, a.feedback,
                                              refine=bool(a.base_img))
    # the series clause only belongs on the pages that actually get an anchor
    consistent_prompt = compose_magnific_prompt(a.style_prompt, a.extra_prompt, a.palette,
                                                a.feedback, refine=bool(a.base_img),
                                                consistent=True)
    if a.print_prompt:
        # cheap path: no DB, no rendered pages — the dashboard previews this
        print(json.dumps({"ok": True, "magnific_prompt": magnific_prompt}, ensure_ascii=False))
        return 0

    # respect settings max_pages
    max_pages = 4
    try:
        settings = json.loads((ROOT / "settings.json").read_text())
        max_pages = int(settings.get("redesign", {}).get("max_pages", 4))
    except Exception:
        pass
    pages = [int(p) for p in a.pages.split(",") if p.strip()][:max_pages]
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT * FROM leads WHERE id = ?", (a.lead_id,)).fetchone()
    if not row:
        set_status("error", error="lead not found")
        return 1

    pages_dir = ROOT / "generated" / str(a.lead_id) / "pages" / a.pdf_slug
    out_dir = ROOT / "generated" / str(a.lead_id) / "redesigns"
    out_dir.mkdir(parents=True, exist_ok=True)

    originals = []
    full_candidates = {int(m.group(1)): f for f in pages_dir.glob("full-*.png")
                       if (m := re.search(r"full-(\d+)\.png$", f.name))}
    for p in pages:
        img = full_candidates.get(p)
        if not img or not img.exists():
            set_status("error", error=f"page image missing for page {p} in {pages_dir}")
            return 1
        originals.append((p, img))

    source_pdf = None
    for entry in json.loads(row["pdfs"] or "[]"):
        if entry.get("slug") == a.pdf_slug:
            candidate = ROOT / entry.get("file", "")
            if candidate.exists():
                source_pdf = candidate
            break

    style_file = re.sub(r"[^a-z0-9_-]+", "_", a.style_id.lower()).strip("_")[:20] or "editorial"

    # keep the images of the earlier attempts: this run writes over their filenames
    prior_generated = json.loads(row["generated"] or "[]")
    moved = archive_previous_versions(prior_generated, out_dir, pages, a.pdf_slug, a.style_id)
    if moved:
        conn.execute("UPDATE leads SET generated = ? WHERE id = ?",
                     (json.dumps(prior_generated, ensure_ascii=False), a.lead_id))
        conn.commit()

    # the reference handed to Magnific: the rendered page, or an earlier redesign
    # when the dashboard asked to refine it instead of starting over
    base_img = None
    if a.base_img:
        candidate = ROOT / moved.get(a.base_img, a.base_img)
        if not candidate.exists():
            set_status("error", error=f"base image not found: {a.base_img}")
            finish_job(conn, a.job_id, "error", error=f"base image not found: {a.base_img}")
            return 1
        if len(originals) != 1:
            set_status("error", error="--base-img only applies to a single page")
            finish_job(conn, a.job_id, "error", error="--base-img only applies to a single page")
            return 1
        base_img = candidate

    # a look to follow from an earlier run (the deck already has pages)
    anchor_img = None
    if a.style_anchor:
        candidate = ROOT / moved.get(a.style_anchor, a.style_anchor)
        if candidate.exists():
            anchor_img = candidate

    refs = {p: (base_img or img) for p, img in originals}

    set_status("running", lead_id=a.lead_id, pages=pages)

    previous = prior_generated

    def next_version(page_no: int) -> int:
        same = [g for g in previous
                if g.get("pdf") == a.pdf_slug and g.get("page") == page_no and g.get("style") == a.style_id]
        return max((int(g.get("version") or 1) for g in same), default=0) + 1

    def entry_for(page_no: int, original: Path, produced: Path, credits: float | None,
                  engine: str) -> dict:
        try:
            from thumbs import make_thumb
            thumb = make_thumb(produced)
        except Exception:
            thumb = None
        return {
            "page": page_no,
            "pdf": a.pdf_slug,
            "style": a.style_id,
            "styleName": a.style_name,
            "original_img": str(original.relative_to(ROOT)),
            "generated_img": str(produced.relative_to(ROOT)),
            "thumb": thumb,
            "status": "done",
            "created_at": datetime.datetime.now().isoformat(),
            # traceability: exactly what produced this image
            "style_prompt": a.style_prompt,
            "extra_prompt": a.extra_prompt,
            "magnific_prompt": magnific_prompt,
            "feedback": a.feedback,
            "palette": a.palette,
            "model": a.model or "auto",
            "resolution": a.resolution or None,
            "quality": a.quality or None,
            "base_img": str(base_img.relative_to(ROOT)) if base_img else None,
            "style_anchor": str(anchor_img.relative_to(ROOT)) if anchor_img else None,
            "consistent": consistent,
            "credits": credits,
            "engine": engine,
            "job_id": a.job_id or None,
            "hero": False,
            "version": next_version(page_no),
        }

    generated: list[dict] = []
    credits_used = credits_left = None
    output = ""

    sys.path.insert(0, str(Path(__file__).parent))
    from magnific_client import MagnificAuthError

    try:
        produced, spent, errors, left = run_direct(
            originals, refs, out_dir, style_file, magnific_prompt,
            a.model, a.resolution, a.quality,
            consistent=consistent, anchor_img=anchor_img,
            consistent_prompt=consistent_prompt)
    except MagnificAuthError as e:
        # el panel busca este marcador para ofrecer el login en vez de un error suelto
        set_status("error", error="MAGNIFIC_AUTH_REQUIRED", tail=str(e))
        finish_job(conn, a.job_id, "error", error="MAGNIFIC_AUTH_REQUIRED")
        return 1
    except Exception as e:                        # red caída, MCP fuera de servicio…
        set_status("error", error=str(e)[:200])
        finish_job(conn, a.job_id, "error", error=str(e)[:200])
        return 1

    originals_by_page = dict(originals)
    for item in produced:
        generated.append(entry_for(item["page"], originals_by_page[item["page"]],
                                   item["path"], item["credits"], "direct"))
    credits_used = spent or None
    credits_left = left
    output = "\n".join(errors)
    if not generated:
        message = errors[0] if errors else "la API no devolvió ninguna imagen"
        set_status("error", error=message)
        finish_job(conn, a.job_id, "error", error=message, credits=credits_used)
        return 1

    if generated and not a.no_qc:
        for g in generated:
            g["qc"] = run_qc(g, source_pdf)

    if generated:
        existing = previous
        # keep older attempts as history; only the newest version is shown by default
        new_keys = {(g.get("pdf"), g.get("page"), g.get("style")) for g in generated}
        for g in existing:
            if (g.get("pdf"), g.get("page"), g.get("style")) in new_keys:
                g["superseded"] = True
                g["hero"] = False
        existing.extend(generated)
        tl = json.loads(row["timeline"] or "[]")
        tl.append({"type": "redesign",
                   "text": f"Rediseño Magnific ({a.style_name or a.style_id}): págs {', '.join(str(g['page']) for g in generated)} | {a.pdf_slug}",
                   "date": datetime.datetime.now().isoformat()})
        conn.execute(
            "UPDATE leads SET generated = ?, timeline = ?, updated_at = datetime('now') WHERE id = ?",
            (json.dumps(existing, ensure_ascii=False), json.dumps(tl, ensure_ascii=False), a.lead_id))
        conn.commit()
        set_status("done", generated=len(generated), pages=[g["page"] for g in generated],
                   credits_used=credits_used, credits_left=credits_left)
        payload = {"ok": True, "generated": generated, "style_id": a.style_id,
                   "style_name": a.style_name, "credits_used": credits_used,
                   "credits_left": credits_left}
        finish_job(conn, a.job_id, "done", result=payload, credits=credits_used)
        print(json.dumps(payload, ensure_ascii=False))
        return 0

    set_status("error", error="no images produced", tail=output[-800:])
    finish_job(conn, a.job_id, "error", error="no se produjo ninguna imagen", credits=credits_used)
    print(json.dumps({"ok": False, "error": "no images produced", "tail": output[-500:]}))
    return 1


if __name__ == "__main__":
    sys.exit(main())
