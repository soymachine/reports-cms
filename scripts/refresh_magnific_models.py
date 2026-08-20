#!/usr/bin/env python3
"""refresh_magnific_models.py — rebuild magnific_models.json from the Magnific MCP.

Two read-only MCP tools do the work, called straight through magnific_client:

  * images_models_list — the model catalog (slugs, resolutions, qualities)
  * simulate_cost      — the credit price of one images_generate call

Neither generates an image, so running this costs nothing. It used to go through
an LLM agent that was *asked* to make those calls and answer with JSON, and the
catalog was then fished out of its prose. Same reason the redesign stopped doing
that: a price list is not a judgement call, and a number scraped out of a
sentence is a number nobody can check.

Usage:
  python3 scripts/refresh_magnific_models.py [--models gpt-2,seedream-5-pro] [--dry-run]
"""
from __future__ import annotations

import argparse
import datetime
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from magnific_client import Magnific, MagnificError   # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CATALOG = ROOT / "magnific_models.json"

# The redesign pipeline always passes the page as a reference, so a model is only
# usable here if it supports image references. This is the shortlist we price.
DEFAULT_MODELS = [
    "auto",
    "gpt-2",
    "seedream-5-pro",
    "imagen-nano-banana-2-flash",
    "imagen-nano-banana-2",
    "imagen-nano-banana-2-lite",
]

# What one page of a redesign asks for. The price depends on the shape of the
# request, so the simulation has to match what generate_redesign.py really sends.
SAMPLE = {"prompt": "editorial report page redesign", "count": 1, "aspectRatio": "3:4"}


def _first_list(payload: Any, keys: tuple[str, ...]) -> list:
    """Find a list under any of `keys`, wherever the payload happens to nest it."""
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in keys:
            value = payload.get(key)
            if isinstance(value, list):
                return value
        for value in payload.values():
            found = _first_list(value, keys)
            if found:
                return found
    return []


def catalog(m: Magnific) -> list[dict]:
    """The models the server offers, normalised to the shape the dashboard reads."""
    raw = m.call("images_models_list", timeout=120)
    models = _first_list(raw, ("models", "items", "data"))
    if not models:
        raise MagnificError(f"images_models_list no devolvió modelos: {str(raw)[:300]}")

    out = []
    for entry in models:
        if not isinstance(entry, dict):
            continue
        slug = entry.get("slug") or entry.get("id") or entry.get("mode") or entry.get("name")
        if not slug:
            continue
        out.append({
            "slug": str(slug),
            "name": entry.get("name") or entry.get("label") or str(slug),
            "resolutions": [str(r) for r in _first_list(
                entry.get("resolutions") or entry.get("supportedResolutions") or [], ())],
            "qualities": [str(q) for q in _first_list(
                entry.get("qualities") or entry.get("supportedQualities") or [], ())],
            "supportsReferences": bool(entry.get("supportsReferences",
                                                 entry.get("references", True))),
            "summary": entry.get("summary") or entry.get("description") or "",
        })
    return out


def price(m: Magnific, slug: str, resolution: str | None,
          quality: str | None) -> float | None:
    """Credits for one image with this combination, or None if it cannot be priced."""
    args = dict(SAMPLE)
    if slug and slug != "auto":
        args["mode"] = slug
    if resolution:
        args["resolution"] = resolution
    if quality:
        args["quality"] = quality
    try:
        out = m.simulate_cost("images_generate", args)
    except MagnificError as e:
        print(f"    ! {slug} {resolution or '-'}/{quality or '-'}: {str(e)[:90]}",
              file=sys.stderr)
        return None

    for key in ("credits", "cost", "creditsRequired", "totalCredits"):
        value = out.get(key)
        if isinstance(value, (int, float)):
            return float(value)
    for node in out.values():                    # a veces viene envuelto un nivel
        if isinstance(node, dict):
            for key in ("credits", "cost"):
                if isinstance(node.get(key), (int, float)):
                    return float(node[key])
    return None


def price_all(m: Magnific, model: dict) -> list[dict]:
    """One row per combination the model actually offers."""
    resolutions = model["resolutions"] or [None]
    qualities = model["qualities"] or [None]
    rows = []
    for resolution in resolutions:
        for quality in qualities:
            credits = price(m, model["slug"], resolution, quality)
            rows.append({"resolution": resolution, "quality": quality, "credits": credits})
    return rows


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--models", default=",".join(DEFAULT_MODELS),
                    help="slugs a incluir y tarifar, separados por comas")
    ap.add_argument("--all", action="store_true",
                    help="tarifar todos los modelos que ofrezca el servidor")
    ap.add_argument("--dry-run", action="store_true", help="imprime el resultado, no escribe")
    a = ap.parse_args()

    wanted = [s.strip() for s in a.models.split(",") if s.strip()]

    try:
        with Magnific() as m:
            available = catalog(m)
            print(f"· {len(available)} modelos en el servidor")

            by_slug = {model["slug"]: model for model in available}
            chosen = available if a.all else [by_slug[s] for s in wanted if s in by_slug]
            for missing in [s for s in wanted if s not in by_slug]:
                # "auto" no siempre aparece en el listado, pero sí se puede tarifar
                print(f"  ! {missing} no está en el catálogo del servidor", file=sys.stderr)
                chosen.append({"slug": missing, "name": missing, "resolutions": [],
                               "qualities": [], "supportsReferences": True, "summary": ""})

            for model in chosen:
                model["prices"] = price_all(m, model)
                priced = sum(1 for p in model["prices"] if p["credits"] is not None)
                print(f"  ✓ {model['slug']}: {priced}/{len(model['prices'])} combinaciones")
    except MagnificError as e:
        print(f"✗ {e}", file=sys.stderr)
        return 1

    previous = {}
    if CATALOG.exists():
        try:
            previous = json.loads(CATALOG.read_text())
        except Exception:
            previous = {}

    payload = {
        "_comment": "Catálogo de modelos Magnific para el rediseño. Regenerar con "
                    "scripts/refresh_magnific_models.py (solo lectura, no gasta créditos).",
        "updated_at": datetime.datetime.now().isoformat(timespec="seconds"),
        "source": "magnific MCP · images_models_list + simulate_cost",
        "models": chosen,
    }
    # keep whatever the previous file said about credits when the run could not price one
    old_prices = {m.get("slug"): m.get("prices") or [] for m in previous.get("models", [])}
    for model in payload["models"]:
        if not any(p.get("credits") for p in (model.get("prices") or [])) and \
                old_prices.get(model.get("slug")):
            model["prices"] = old_prices[model["slug"]]

    text = json.dumps(payload, ensure_ascii=False, indent=2)
    if a.dry_run:
        print(text)
        return 0
    CATALOG.write_text(text + "\n")
    print(f"✓ {CATALOG.relative_to(ROOT)} · {len(payload['models'])} modelos")
    return 0


if __name__ == "__main__":
    sys.exit(main())
