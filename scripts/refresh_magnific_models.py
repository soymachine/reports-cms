#!/usr/bin/env python3
"""refresh_magnific_models.py — rebuild magnific_models.json from the Magnific MCP.

Two read-only MCP tools do the work, both through a Hermes agent because that is
the only client wired to the magnific OAuth session:

  * images_models_list — the model catalog (slugs, resolutions, qualities)
  * simulate_cost      — the credit price of one images_generate call

Neither generates an image, so running this costs nothing. It is slow (minutes),
which is exactly why the dashboard reads the cached file instead of asking live.

Usage:
  python3 scripts/refresh_magnific_models.py [--models gpt-2,seedream-5-pro] [--dry-run]
"""
import argparse
import datetime
import json
import re
import subprocess
import sys
from pathlib import Path

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

ASK = """Usa el MCP magnific. NO generes ninguna imagen.

1. Llama a images_models_list.
2. Para cada modelo de esta lista: {models}
   y para CADA una de sus resoluciones soportadas (y sin resolución si no soporta
   ninguna), llama a simulate_cost con tool="images_generate" y arguments =
   {{"prompt":"editorial report page redesign","count":1,"aspectRatio":"3:4",
   "mode":<slug>,"resolution":<res>}}. simulate_cost es de solo lectura y no cobra.

Devuelve SOLO un bloque JSON con esta forma exacta:
{{"models":[{{"slug":"...","name":"...","resolutions":[...],"qualities":[...],
"supportsReferences":true,"summary":"...","prices":[{{"resolution":"2k","quality":null,
"credits":75}}]}}]}}
Si una combinación falla, inclúyela con "credits":null."""


def ask_agent(models: list[str]) -> dict:
    prompt = ASK.format(models=", ".join(models))
    res = subprocess.run(["hermes", "chat", "-q", prompt],
                         capture_output=True, text=True, timeout=1800, cwd=str(ROOT))
    out = (res.stdout or "") + "\n" + (res.stderr or "")
    (ROOT / ".magnific_models_last_output.log").write_text(out[-20000:])
    # the agent wraps the payload in prose and often in a ```json fence
    blocks = re.findall(r"\{[\s\S]*\}", out)
    for block in sorted(blocks, key=len, reverse=True):
        try:
            data = json.loads(block)
        except Exception:
            continue
        if isinstance(data, dict) and isinstance(data.get("models"), list):
            return data
    raise SystemExit("no JSON catalog found in the agent output "
                     "(see .magnific_models_last_output.log)")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", default=",".join(DEFAULT_MODELS),
                    help="comma-separated slugs to include and price")
    ap.add_argument("--dry-run", action="store_true", help="print the result, do not write")
    a = ap.parse_args()

    models = [m.strip() for m in a.models.split(",") if m.strip()]
    data = ask_agent(models)

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
        "models": data["models"],
    }
    # keep whatever the previous file said about credits when the run could not price one
    old_prices = {m.get("slug"): m.get("prices") or [] for m in previous.get("models", [])}
    for m in payload["models"]:
        if not any(p.get("credits") for p in (m.get("prices") or [])) and old_prices.get(m.get("slug")):
            m["prices"] = old_prices[m["slug"]]

    text = json.dumps(payload, ensure_ascii=False, indent=2)
    if a.dry_run:
        print(text)
        return 0
    CATALOG.write_text(text + "\n")
    print(f"✓ {CATALOG.relative_to(ROOT)} · {len(payload['models'])} modelos")
    return 0


if __name__ == "__main__":
    sys.exit(main())
