#!/usr/bin/env python3
"""magnific_status.py — ¿está viva la sesión de Magnific? Para el semáforo del panel.

Sustituye a `hermes mcp test magnific`, que había que invocar por su ruta absoluta
y cuyo veredicto se sacaba buscando «✓» y «OAuth» en la salida del CLI. Aquí el
estado sale de la excepción que lanza el cliente, que es donde esa información
vive de verdad:

    connected      la llamada funcionó — incluye el saldo, que ya hacía falta
    auth_required  MagnificAuthError: no hay sesión, o el servidor la rechazó
    error          cualquier otra cosa (red, MCP caído, respuesta ininteligible)

Imprime una línea de JSON y sale con 0 si está conectado, 1 si no. La llamada es
`account_balance`, de solo lectura: comprobar el estado no cuesta créditos.

Uso:
  .venv/bin/python scripts/magnific_status.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from magnific_client import (  # noqa: E402
    LOGIN_HINT, Magnific, MagnificAuthError, MagnificError, default_token_dir)


def status() -> dict:
    try:
        with Magnific() as m:
            balance = m.account_balance()
    except MagnificAuthError as e:
        return {"ok": False, "status": "auth_required", "detail": str(e), "hint": LOGIN_HINT}
    except MagnificError as e:
        return {"ok": False, "status": "error", "detail": str(e)[-300:]}
    except Exception as e:                       # red caída, DNS, TLS…
        return {"ok": False, "status": "error", "detail": f"{type(e).__name__}: {e}"[-300:]}

    credits = balance.get("credits", balance.get("balance"))
    return {
        "ok": True,
        "status": "connected",
        "credits": credits,
        "detail": f"sesión activa · saldo {credits}" if credits is not None else "sesión activa",
        "session": str(default_token_dir()),
    }


def main() -> int:
    payload = status()
    print(json.dumps(payload, ensure_ascii=False))
    return 0 if payload["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
