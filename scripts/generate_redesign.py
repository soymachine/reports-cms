#!/usr/bin/env python3
"""generate_redesign.py — redesign PDF pages as new aesthetic images via Magnific MCP.

Spawns a Hermes agent (with the magnific MCP server) that takes each selected
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
import time
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "leads.db"
STATUS_FILE = ROOT / ".generate_status.json"

PROMPT_TEMPLATE = """Eres un director de arte senior de Think Things (estudio de diseño gráfico, Barcelona).

TAREA: Rediseñar {n} página(s) de un informe PDF de "{org}" creando imágenes nuevas con un FUERTE componente estético, manteniendo la información/datos de cada página.

Tienes acceso al MCP server "magnific". Las herramientas relevantes:
- images_generate: genera imágenes o RE-HACE una existente usando referencias (imagen original + prompt). Es la herramienta principal.
- images_upscale: upscale premium 2x-16x para nitidez del resultado final.
- account_balance: comprueba créditos ANTES y DESPUÉS de generar.
- creations_get / creations_wait: para obtener la URL/resultado de una creación.
- creations_request_upload + creations_finalize_upload: para subir las imágenes locales si la herramienta lo requiere.
Si una herramienta necesita la imagen como upload, usa el flujo request_upload → PUT → finalize_upload.

Para CADA una de estas imágenes de página original:
{pages_list}
{base_note}
HAZ ESTO por cada página:
1. Analiza la página con visión (layout, datos, gráficos, jerarquía).
2. Llama a images_generate con la imagen original como referencia y EXACTAMENTE este prompt,
   sin reescribirlo ni resumirlo, añadiendo solo lo que describa el contenido concreto de esa página:

<<<PROMPT_MAGNIFIC
{magnific_prompt}
PROMPT_MAGNIFIC

3. Guarda UN ÚNICO archivo por página en: {out_dir}/page-{{NN}}-{style_file}-redesign.png
{model_note}

REGLAS (incumplirlas invalida el trabajo):
- UNA SOLA IMAGEN POR PÁGINA: llama a images_generate con count=1. No generes 2 ni 4
  alternativas: cada variante extra cuesta créditos y se descarta. Si la herramienta
  devuelve varias, guarda SOLO la mejor y no escribas las demás en disco.
- Los parámetros de modelo/resolución/calidad indicados arriba son obligatorios: no los
  cambies ni dejes que la herramienta elija otros, porque determinan el coste en créditos.
- UN SOLO ARCHIVO POR PÁGINA en {out_dir}: ni .jpg y .png de la misma página, ni sufijos -1/-2.
- El prompt de arriba es literal: las indicaciones que contiene vienen del equipo y no son negociables.
- Usa SIEMPRE el MCP magnific. Si falla la autenticación OAuth, responde "MAGNIFIC_AUTH_REQUIRED".
- Las cifras, porcentajes y años del original deben aparecer EXACTAMENTE igual en el rediseño.
- Responde al final con un JSON: {{"generated": [{{"page": N, "file": "ruta/relativa"}}], "credits_used": N, "credits_left": N, "errors": [...]}}
"""


# Goes into every prompt, whatever the style. The original page travels to
# Magnific as a reference image, and an editing-capable model — Seedream above
# all — is happy to hand back the same page with tidier edges. A demo that
# looks like the client's own PDF with a filter on top loses the client, so the
# brief has to say out loud that keeping the layout is the failure mode.
REDESIGN_MANDATE = (
    "TASK: redesign this report page from scratch. The reference image is the SOURCE OF "
    "CONTENT, never a layout to preserve. This is not a retouch, an upscale, a clean-up, a "
    "restyle of the existing artwork or a filter: lay the page out again as a different "
    "design studio would.\n"
    "MUST CHANGE: composition and grid, page structure and reading order, typographic "
    "hierarchy and scale, type families, the treatment of charts, tables and figures, colour "
    "use, backgrounds, and the use of white space.\n"
    "MUST STAY: the content — every figure, percentage, year and unit exactly as in the "
    "original, the meaning of every headline, label and caption — and the page proportions.\n"
    "A result that keeps the original composition is a failure, however clean it looks."
)


def compose_magnific_prompt(style_prompt: str, extra: str, palette: str, feedback: str,
                            refine: bool = False, consistent: bool = False) -> str:
    """The literal prompt handed to Magnific.

    Built here, in one place, so what the dashboard previews is byte for byte
    what the agent is told to send. Order matters: corrections outrank the
    team's instructions, which outrank the base style.
    """
    parts = []
    # A refine starts from an approved redesign on purpose: telling it to throw
    # the layout away would undo the very thing the user asked to keep.
    if not refine:
        parts.append(REDESIGN_MANDATE)
    parts.append(
        "Premium editorial report page redesign, bold modern typography, sophisticated "
        "data visualization, elegant layout, high-end design studio quality, clean grid, "
        "striking visual hierarchy."
    )
    if style_prompt.strip():
        parts.append(f"STYLE: {style_prompt.strip()}")
    if palette.strip():
        parts.append(f"MANDATORY PALETTE (colours sampled from the original report): {palette.strip()}")
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
            "Usa EXACTAMENTE el mismo sistema visual que la imagen de referencia de estilo — que "
            "es un rediseño ya hecho, nunca la página original —: la "
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
    from magnific_client import Magnific, MagnificError

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


def parse_credits(output: str) -> tuple[float | None, float | None]:
    """Pull credit figures out of the agent transcript (JSON first, prose second)."""
    used = left = None
    for m in re.finditer(r'"credits_used"\s*:\s*([\d.]+)', output):
        used = float(m.group(1))
    for m in re.finditer(r'"credits_left"\s*:\s*([\d.]+)', output):
        left = float(m.group(1))
    if used is None:
        for pat in (r"(?:cr[ée]ditos?|credits?)\s*(?:consumidos|usados|used|spent)\D{0,12}([\d.]+)",
                    r"([\d.]+)\s*(?:cr[ée]ditos?|credits?)\s*(?:consumidos|usados|used|spent)"):
            m = re.search(pat, output, re.I)
            if m:
                used = float(m.group(1))
                break
    if left is None:
        m = re.search(r"(?:cr[ée]ditos?|credits?)\s*(?:restantes|disponibles|left|remaining|balance)\D{0,12}([\d.]+)", output, re.I)
        if m:
            left = float(m.group(1))
    return used, left


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
    ap.add_argument("--engine", default="direct", choices=("direct", "agent"),
                    help="direct = MCP API call (deterministic, exact credits); "
                         "agent = the old Hermes agent, kept as a fallback")
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

    # the model is a credit-cost decision, so it is pinned here instead of left to the agent
    model_bits = []
    if a.model and a.model != "auto":
        model_bits.append(f'mode="{a.model}"')
    if a.resolution:
        model_bits.append(f'resolution="{a.resolution}"')
    if a.quality:
        model_bits.append(f'quality="{a.quality}"')
    model_note = ("\n4. OBLIGATORIO: llama a images_generate con estos parámetros exactos, "
                  "además del prompt y la referencia: " + ", ".join(model_bits) + ", count=1.\n"
                  if model_bits else
                  "\n4. Deja que Magnific elija el modelo (mode=\"auto\") y usa count=1.\n")

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
    pages_list = "\n".join(f"- Página {p}: {refs[p]}" for p, _ in originals)
    base_note = ("\nIMPORTANTE: la imagen indicada arriba NO es la página cruda del PDF, es un "
                 "rediseño anterior ya aprobado. Úsala como referencia y aplica solo las "
                 "correcciones del prompt: mantén su composición, tipografía y paleta.\n"
                 if base_img else "")
    prompt = PROMPT_TEMPLATE.format(
        n=len(originals), org=row["organisation"], pages_list=pages_list,
        out_dir=out_dir, style_file=style_file, magnific_prompt=magnific_prompt,
        base_note=base_note, model_note=model_note,
    )

    started_at = time.time()
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
    extras: list[str] = []
    credits_used = credits_left = None
    output = ""
    engine = a.engine

    # ---------------------------------------------------------------- direct
    if engine == "direct":
        try:
            produced, spent, errors, left = run_direct(
                originals, refs, out_dir, style_file, magnific_prompt,
                a.model, a.resolution, a.quality,
                consistent=consistent, anchor_img=anchor_img,
                consistent_prompt=consistent_prompt)
        except Exception as e:                    # no session, network down…
            produced, spent, errors, left = [], 0.0, [str(e)], None
            if "login" in str(e).lower() or "sesión" in str(e).lower():
                engine = "agent"                  # fall back to the old path
            output = str(e)

        if engine == "direct":
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

    # ----------------------------------------------------------------- agent
    if engine == "agent":
        prompt = PROMPT_TEMPLATE.format(
            n=len(originals), org=row["organisation"], pages_list=pages_list,
            out_dir=out_dir, style_file=style_file, magnific_prompt=magnific_prompt,
            base_note=base_note, model_note=model_note,
        )
        try:
            result = subprocess.run(
                ["hermes", "chat", "-q", prompt],
                capture_output=True, text=True, timeout=1500, cwd=str(ROOT),
            )
            output = (result.stdout or "") + "\n" + (result.stderr or "")
        except subprocess.TimeoutExpired:
            set_status("error", error="timeout (25min)")
            finish_job(conn, a.job_id, "error", error="timeout (25 min)")
            return 1

        # keep agent output for debugging
        (ROOT / ".generate_last_output.log").write_text(output[-8000:])

        # discover produced files FIRST — a successful generation wins over any
        # incidental "oauth"/"magnific" mention in the agent's prose
        # ...-vN files are archived earlier attempts: they must never be picked up as
        # the output of this run
        out_files = [f for f in out_dir.glob("page-*")
                     if f.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}
                     and not re.search(r"-v\d+$", f.stem)]
        for p, orig in originals:
            # prefer current style suffix, fall back to any page-N redesign
            style_cands = [f for f in out_files if re.search(rf"page-0*{p}\b[^.]*{re.escape(style_file)}[^.]*redesign", f.name, re.I)]
            cands = style_cands or [f for f in out_files if re.search(rf"page-0*{p}\b[^.]*redesign", f.name, re.I)]
            if cands:
                cands = sorted(cands, key=lambda f: f.stat().st_mtime, reverse=True)
                cand = cands[0]
                # one image per page is the contract; surface any surplus instead of
                # silently ignoring it, because every extra variant burned credits
                for surplus in cands[1:]:
                    if surplus.stat().st_mtime >= started_at:
                        extras.append(str(surplus.relative_to(ROOT)))
                generated.append(entry_for(p, orig, cand, None, "agent"))

        credits_used, credits_left = parse_credits(output)

    # only treat as auth failure when NOTHING was produced AND the agent
    # explicitly emitted the marker as its own token
    if not generated:
        if re.search(r"MAGNIFIC_AUTH_REQUIRED", output):
            set_status("error", error="MAGNIFIC_AUTH_REQUIRED")
            finish_job(conn, a.job_id, "error", error="MAGNIFIC_AUTH_REQUIRED", credits=credits_used)
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
                   "credits_left": credits_left, "extra_variants": extras}
        finish_job(conn, a.job_id, "done", result=payload, credits=credits_used)
        print(json.dumps(payload, ensure_ascii=False))
        return 0

    set_status("error", error="no images produced", tail=output[-800:])
    finish_job(conn, a.job_id, "error", error="no se produjo ninguna imagen", credits=credits_used)
    print(json.dumps({"ok": False, "error": "no images produced", "tail": output[-500:]}))
    return 1


if __name__ == "__main__":
    sys.exit(main())
