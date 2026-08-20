#!/usr/bin/env python3
"""fase0_check.py — ¿podemos autenticarnos contra Magnific sin Hermes?

Sondeo de solo lectura, previo a escribir `magnific_login.py`. Responde a una
pregunta: ¿el MCP de Magnific permite que nos registremos como cliente OAuth
propio, o dependemos del registro que hizo Hermes?

No modifica nada, no llama a ninguna herramienta que cueste créditos y no
imprime ningún secreto: de los tokens solo se dice si existen y cuándo caducan.

Uso:
    .venv/bin/python scripts/fase0_check.py
    python3 scripts/fase0_check.py            # no necesita dependencias
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

MCP_URL = os.environ.get("MAGNIFIC_MCP_URL", "https://mcp.magnific.com")
HERMES_TOKENS = Path.home() / ".hermes" / "mcp-tokens"
TIMEOUT = 20

OK, WARN, BAD, INFO = "✓", "!", "✗", "·"

# ¿hemos llegado a hablar con el servidor, aunque nos rechazara?
REACHED = {"mcp": False}


def say(mark: str, text: str) -> None:
    print(f"  {mark} {text}")


def get_json(url: str) -> tuple[int, dict | None, str]:
    """GET que nunca lanza: devuelve (status, json|None, detalle)."""
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
            raw = res.read()
            try:
                return res.status, json.loads(raw), ""
            except Exception:
                return res.status, None, f"respuesta no-JSON ({len(raw)} bytes)"
    except urllib.error.HTTPError as e:
        return e.code, None, e.reason or ""
    except Exception as e:                                  # DNS, TLS, timeout…
        return 0, None, str(e)


def probe_www_authenticate() -> str | None:
    """La vía del estándar MCP: una llamada sin token debe devolver 401 y decir
    en `WWW-Authenticate` dónde están los metadatos del recurso protegido."""
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                       "params": {"protocolVersion": "2025-06-18",
                                  "capabilities": {},
                                  "clientInfo": {"name": "fase0", "version": "0"}}}).encode()
    req = urllib.request.Request(MCP_URL, data=body, method="POST", headers={
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-06-18",
    })
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
            REACHED["mcp"] = True
            say(WARN, f"el MCP respondió {res.status} sin token (no esperado, pero no es un problema)")
            return None
    except urllib.error.HTTPError as e:
        REACHED["mcp"] = True
        hdr = (e.headers or {}).get("WWW-Authenticate", "")
        if e.code in (401, 403):
            say(OK, f"el MCP pide autenticación ({e.code}), como debe")
        else:
            say(WARN, f"el MCP respondió {e.code} a una llamada sin token")
        if hdr:
            say(INFO, f"WWW-Authenticate: {hdr[:160]}")
            for part in hdr.split(","):
                if "resource_metadata" in part:
                    return part.split("=", 1)[1].strip().strip('"')
        return None
    except Exception as e:
        say(BAD, f"no se pudo contactar con {MCP_URL}: {e}")
        return None


def discover() -> dict | None:
    """Metadatos del servidor de autorización, por los tres caminos posibles."""
    base = MCP_URL.rstrip("/")
    candidates: list[str] = []

    hinted = probe_www_authenticate()
    if hinted:
        candidates.append(hinted)
    candidates.append(f"{base}/.well-known/oauth-protected-resource")

    issuer = None
    for url in candidates:
        status, data, detail = get_json(url)
        if status == 200 and data:
            say(OK, f"metadatos del recurso protegido en {url}")
            servers = data.get("authorization_servers") or []
            if servers:
                issuer = servers[0]
                say(INFO, f"servidor de autorización: {issuer}")
            break
        say(INFO, f"{url} → {status or 'sin respuesta'} {detail}".rstrip())

    roots = [issuer] if issuer else []
    roots.append(base)
    seen: set[str] = set()
    for root in roots:
        root = root.rstrip("/")
        for suffix in (".well-known/oauth-authorization-server",
                       ".well-known/openid-configuration"):
            url = f"{root}/{suffix}"
            if url in seen:
                continue
            seen.add(url)
            status, data, detail = get_json(url)
            if status == 200 and data and data.get("token_endpoint"):
                say(OK, f"metadatos del servidor de autorización en {url}")
                return data
            say(INFO, f"{url} → {status or 'sin respuesta'} {detail}".rstrip())
    return None


def inspect_hermes() -> dict:
    """Qué dejó escrito Hermes. Solo metadatos: ningún token se imprime."""
    out: dict = {"dir": HERMES_TOKENS, "client_id": None, "public_client": None}
    if not HERMES_TOKENS.exists():
        say(INFO, f"no hay sesión de Hermes en {HERMES_TOKENS} (¿otra máquina?)")
        return out

    token_f = HERMES_TOKENS / "magnific.json"
    meta_f = HERMES_TOKENS / "magnific.meta.json"
    client_f = HERMES_TOKENS / "magnific.client.json"

    if token_f.exists():
        data = json.loads(token_f.read_text())
        exp = float(data.get("expires_at") or 0)
        when = (f"caduca en {int((exp - time.time()) / 60)} min" if exp > time.time()
                else "caducado" if exp else "sin fecha de caducidad")
        say(OK, f"sesión presente ({when}), "
                f"refresh token: {'sí' if data.get('refresh_token') else 'NO'}")
    else:
        say(WARN, "no hay magnific.json: esta máquina no ha hecho login nunca")

    if meta_f.exists():
        meta = json.loads(meta_f.read_text())
        say(OK, f"token_endpoint conocido: {meta.get('token_endpoint')}")
        if meta.get("registration_endpoint"):
            say(OK, f"registration_endpoint conocido: {meta['registration_endpoint']}")

    if client_f.exists():
        client = json.loads(client_f.read_text())
        cid = client.get("client_id") or ""
        out["client_id"] = cid
        out["public_client"] = not client.get("client_secret")
        say(OK, f"client_id de Hermes: {cid[:12]}…{cid[-4:] if len(cid) > 16 else ''} "
                f"({'público, sin secreto' if out['public_client'] else 'CON secreto de cliente'})")
        if client.get("redirect_uris"):
            say(INFO, f"redirect_uris registradas: {client['redirect_uris']}")
    return out


def verdict(meta: dict | None, hermes: dict, reachable: bool) -> int:
    print("\nVEREDICTO")
    if not reachable:
        say(WARN, "SIN VEREDICTO — no se ha podido hablar con Magnific.")
        print("\n  Esto no dice nada sobre el escenario A/B/C: dice que esta máquina")
        print("  no llega al servidor. Repítelo con conexión directa (sin proxy ni")
        print("  VPN corporativa) antes de sacar conclusiones.")
        return 2
    if meta and meta.get("registration_endpoint"):
        pkce = meta.get("code_challenge_methods_supported") or []
        say(OK, "ESCENARIO A — registro dinámico disponible.")
        say(INFO, f"registration_endpoint: {meta['registration_endpoint']}")
        say(INFO, f"PKCE soportado: {pkce or 'no declarado (asumir S256)'}")
        print("\n  Vía libre: `magnific_login.py` se registra como cliente propio.")
        print("  Independencia total de Hermes. Adelante con la fase 1.")
        return 0

    if hermes.get("client_id") and hermes.get("public_client"):
        say(WARN, "ESCENARIO B — sin registro dinámico, pero el client_id de Hermes")
        say(WARN, "              es público (sin secreto): reutilizable con PKCE.")
        print("\n  `magnific_login.py` usa ese client_id y hace el flujo él solo.")
        print("  Hermes NO hace falta en ejecución, solo prestó el registro una vez.")
        print("  Antes de la fase 1, comprueba que redirect_uris admite 127.0.0.1.")
        return 0

    say(BAD, "ESCENARIO C — ni registro dinámico ni cliente reutilizable.")
    print("\n  No se puede hacer login sin Hermes. Recomendación: dejar Hermes")
    print("  instalado SOLO para `hermes mcp login magnific` y quitarlo de todo lo")
    print("  demás (fases 2-6 siguen siendo válidas y valen la pena).")
    print("  Antes de rendirse: mira si Magnific ofrece API key en su panel web.")
    return 1


def main() -> int:
    print(f"Fase 0 — sondeo OAuth de Magnific ({MCP_URL})\n")
    print("1. Servidor MCP y descubrimiento OAuth")
    meta = discover()
    # una red caída no es un veredicto: hay que poder distinguir "no hay registro
    # dinámico" de "no he podido preguntar"
    reachable = meta is not None or REACHED["mcp"]
    if meta:
        for key in ("issuer", "authorization_endpoint", "token_endpoint",
                    "registration_endpoint"):
            if meta.get(key):
                say(INFO, f"{key}: {meta[key]}")
        if not meta.get("registration_endpoint"):
            say(WARN, "no declara registration_endpoint (no hay registro dinámico)")
    else:
        say(BAD, "no se han podido leer los metadatos OAuth")
        say(INFO, "si estás detrás de un proxy o sin red, repítelo con conexión directa")

    print("\n2. Qué dejó escrito Hermes en esta máquina")
    hermes = inspect_hermes()

    return verdict(meta, hermes, reachable)


if __name__ == "__main__":
    sys.exit(main())
