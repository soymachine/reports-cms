#!/usr/bin/env python3
"""magnific_login.py — sesión OAuth propia contra el MCP de Magnific.

Sustituye a `hermes mcp login magnific`. Hace el flujo completo que hacía el CLI
de Hermes: descubrimiento de metadatos, registro dinámico de cliente (RFC 7591),
código de autorización con PKCE (RFC 7636) y canje por tokens, y deja la sesión
escrita donde `magnific_client.py` la busca.

Escribe tres ficheros en ~/.thinkthings/magnific/, con los mismos nombres y la
misma forma que usaba Hermes, para que `Magnific._refresh()` siga renovando la
sesión sin cambios:

    magnific.json         access_token, refresh_token, expires_at
    magnific.meta.json    endpoints descubiertos (token, authorization, registro)
    magnific.client.json  client_id registrado y redirect_uris

Uso:
    .venv/bin/python scripts/magnific_login.py            # login y verificación
    .venv/bin/python scripts/magnific_login.py --status   # ¿hay sesión válida?
    .venv/bin/python scripts/magnific_login.py --force    # vuelve a registrar
    .venv/bin/python scripts/magnific_login.py --port 9000

Nada de lo que imprime es secreto: los tokens no se muestran nunca.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import http.server
import json
import os
import secrets
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

MCP_URL = os.environ.get("MAGNIFIC_MCP_URL", "https://mcp.magnific.com")
TOKEN_DIR = Path(os.environ.get(
    "MAGNIFIC_TOKEN_DIR", str(Path.home() / ".thinkthings" / "magnific")))
CLIENT_NAME = "thinkthings-cms"
DEFAULT_PORT = 8765
TIMEOUT = 30
WAIT_FOR_BROWSER = 300          # 5 min para autorizar en el navegador

OK, WARN, BAD, INFO = "✓", "!", "✗", "·"


class LoginError(RuntimeError):
    """El flujo no se pudo completar. El mensaje explica qué hacer."""


def say(mark: str, text: str) -> None:
    print(f"  {mark} {text}")


# --------------------------------------------------------------------- HTTP

def _json_request(url: str, *, data: bytes | None = None,
                  headers: dict[str, str] | None = None) -> dict:
    req = urllib.request.Request(url, data=data, method="POST" if data else "GET",
                                 headers={"Accept": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
            return json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as e:
        detail = (e.read() or b"")[:300].decode("utf-8", "replace")
        raise LoginError(f"{url} devolvió HTTP {e.code}: {detail}") from e
    except urllib.error.URLError as e:
        raise LoginError(f"no se pudo contactar con {url}: {e.reason}") from e


def _try_json(url: str) -> dict | None:
    try:
        return _json_request(url)
    except LoginError:
        return None


# -------------------------------------------------------------- descubrimiento

def discover(mcp_url: str = MCP_URL) -> dict:
    """Metadatos del servidor de autorización que protege este MCP.

    Sigue el camino del estándar: recurso protegido → servidor de autorización.
    Devuelve el documento del servidor más `_resource`, el identificador que hay
    que enviar como `resource` en las peticiones (RFC 8707); sin él, algunos
    servidores emiten un token que luego el MCP rechaza.
    """
    base = mcp_url.rstrip("/")
    resource = base
    issuers: list[str] = []

    prm = _try_json(f"{base}/.well-known/oauth-protected-resource")
    if prm:
        resource = prm.get("resource") or resource
        issuers = list(prm.get("authorization_servers") or [])

    issuers.append(base)
    for issuer in issuers:
        root = issuer.rstrip("/")
        for suffix in (".well-known/oauth-authorization-server",
                       ".well-known/openid-configuration"):
            meta = _try_json(f"{root}/{suffix}")
            if meta and meta.get("token_endpoint") and meta.get("authorization_endpoint"):
                meta["_resource"] = resource
                return meta

    raise LoginError(
        "no se han podido descubrir los metadatos OAuth de Magnific.\n"
        "    Comprueba la conexión y vuelve a intentarlo; si persiste, ejecuta\n"
        "    `python3 scripts/fase0_check.py` para ver qué contesta el servidor.")


# ------------------------------------------------------------------- registro

def register(meta: dict, redirect_uri: str) -> dict:
    """Registro dinámico como cliente público (RFC 7591): sin secreto, con PKCE."""
    endpoint = meta.get("registration_endpoint")
    if not endpoint:
        raise LoginError(
            "este servidor no permite registro dinámico de clientes.\n"
            "    Ejecuta `python3 scripts/fase0_check.py`: si el client_id de Hermes\n"
            "    es público, se puede reutilizar con MAGNIFIC_CLIENT_ID=<id>.")

    body = json.dumps({
        "client_name": CLIENT_NAME,
        "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
        "application_type": "native",
    }).encode()
    client = _json_request(endpoint, data=body,
                           headers={"Content-Type": "application/json"})
    if not client.get("client_id"):
        raise LoginError(f"el registro no devolvió client_id: {str(client)[:200]}")
    return client


# ---------------------------------------------------------------------- PKCE

def make_pkce() -> tuple[str, str]:
    """(verifier, challenge) con S256, según RFC 7636."""
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(64)).decode().rstrip("=")
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).decode().rstrip("=")
    return verifier, challenge


def authorize_url(meta: dict, client_id: str, redirect_uri: str,
                  challenge: str, state: str) -> str:
    params = {
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    if meta.get("_resource"):
        params["resource"] = meta["_resource"]
    scopes = meta.get("scopes_supported")
    if scopes:
        params["scope"] = " ".join(scopes)
    return f"{meta['authorization_endpoint']}?{urllib.parse.urlencode(params)}"


# ------------------------------------------------------- servidor de retorno

PAGE = """<!doctype html><meta charset="utf-8">
<title>{title}</title>
<style>
 body{{font-family:'IBM Plex Mono',ui-monospace,Menlo,monospace;font-weight:400;
      background:#fafafa;color:#18181b;display:grid;place-items:center;
      height:100vh;margin:0;text-align:center;line-height:1.7}}
 @media (prefers-color-scheme:dark){{body{{background:#0a0a0b;color:#fafafa}}}}
 .m{{color:{color};font-size:1.1rem}} .s{{color:#52525b;font-size:.875rem}}
</style>
<div><p class="m">{title}</p><p class="s">{detail}</p></div>"""


class _Callback(http.server.BaseHTTPRequestHandler):
    """Recoge un único `code` y cierra. No sirve nada más."""

    result: dict = {}
    expected_state: str = ""

    def do_GET(self) -> None:                                # noqa: N802
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        got = {k: v[0] for k, v in query.items()}

        if got.get("error"):
            _Callback.result = {"error": got.get("error_description") or got["error"]}
            page, code = PAGE.format(title="Autorización denegada", color="#dc2626",
                                     detail=_Callback.result["error"]), 400
        elif got.get("state") != _Callback.expected_state:
            # el state protege de que alguien nos cuele su propio código
            _Callback.result = {"error": "el parámetro state no coincide"}
            page, code = PAGE.format(title="Respuesta inesperada", color="#dc2626",
                                     detail="El state no coincide. Repite el login."), 400
        elif got.get("code"):
            _Callback.result = {"code": got["code"]}
            page, code = PAGE.format(title="Magnific autorizado", color="#059669",
                                     detail="Ya puedes cerrar esta pestaña."), 200
        else:
            _Callback.result = {"error": "la respuesta no traía código"}
            page, code = PAGE.format(title="Respuesta incompleta", color="#dc2626",
                                     detail="No llegó ningún código."), 400

        body = page.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args) -> None:
        """Silencio: el servidor vive tres segundos y no es el protagonista."""


def wait_for_code(port: int, state: str) -> str:
    _Callback.result = {}
    _Callback.expected_state = state
    try:
        server = http.server.HTTPServer(("127.0.0.1", port), _Callback)
    except OSError as e:
        raise LoginError(
            f"el puerto {port} está ocupado ({e}). Cierra lo que lo use o pasa "
            f"--port con otro número (tendrás que registrar de nuevo con --force).") from e

    server.timeout = WAIT_FOR_BROWSER
    thread = threading.Thread(target=server.handle_request, daemon=True)
    thread.start()
    thread.join(WAIT_FOR_BROWSER)
    server.server_close()

    if not _Callback.result:
        raise LoginError(f"nadie autorizó en {WAIT_FOR_BROWSER // 60} minutos.")
    if _Callback.result.get("error"):
        raise LoginError(_Callback.result["error"])
    return _Callback.result["code"]


# ------------------------------------------------------------ canje de tokens

def exchange(meta: dict, client_id: str, code: str, verifier: str,
             redirect_uri: str) -> dict:
    fields = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
        "client_id": client_id,
        "code_verifier": verifier,
    }
    if meta.get("_resource"):
        fields["resource"] = meta["_resource"]
    tokens = _json_request(
        meta["token_endpoint"], data=urllib.parse.urlencode(fields).encode(),
        headers={"Content-Type": "application/x-www-form-urlencoded"})
    if not tokens.get("access_token"):
        raise LoginError(f"el canje no devolvió access_token: {str(tokens)[:200]}")
    return tokens


# -------------------------------------------------------------- persistencia

def save(token_dir: Path, tokens: dict, meta: dict, client: dict) -> None:
    """Deja la sesión en el formato que `magnific_client.py` sabe leer y renovar."""
    token_dir.mkdir(parents=True, exist_ok=True)
    token_dir.chmod(0o700)

    session = dict(tokens)
    session["expires_at"] = time.time() + float(tokens.get("expires_in") or 3600)

    for name, payload in (("magnific.json", session),
                          ("magnific.meta.json", meta),
                          ("magnific.client.json", client)):
        path = token_dir / name
        path.write_text(json.dumps(payload, indent=2))
        path.chmod(0o600)


def load_client(token_dir: Path) -> dict | None:
    path = token_dir / "magnific.client.json"
    if not path.exists():
        return None
    try:
        client = json.loads(path.read_text())
    except Exception:
        return None
    return client if client.get("client_id") else None


# ------------------------------------------------------------------ verificar

def verify(token_dir: Path) -> bool:
    """Prueba la sesión recién escrita con la llamada más barata que hay."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    try:
        from magnific_client import Magnific, MagnificError    # noqa: PLC0415
    except Exception as e:
        say(WARN, f"no se pudo importar magnific_client para verificar: {e}")
        return False

    try:
        with Magnific(token_dir=token_dir) as m:
            balance = m.account_balance()
    except MagnificError as e:
        say(BAD, f"la sesión no funciona: {e}")
        return False
    except Exception as e:
        say(WARN, f"no se pudo verificar ahora mismo: {e}")
        return False

    credits = balance.get("credits", balance.get("balance", balance))
    say(OK, f"sesión verificada — saldo: {credits}")
    return True


# ----------------------------------------------------------------- comandos

def status(token_dir: Path) -> int:
    print(f"Sesión de Magnific en {token_dir}\n")
    path = token_dir / "magnific.json"
    if not path.exists():
        say(BAD, "no hay sesión: ejecuta `.venv/bin/python scripts/magnific_login.py`")
        legacy = Path.home() / ".hermes" / "mcp-tokens" / "magnific.json"
        if legacy.exists():
            say(INFO, f"hay una sesión antigua de Hermes en {legacy.parent}")
            say(INFO, "el cliente la usará mientras exista, pero conviene migrar")
        return 1

    data = json.loads(path.read_text())
    exp = float(data.get("expires_at") or 0)
    if not exp:
        say(INFO, "sin fecha de caducidad registrada")
    elif exp > time.time():
        say(OK, f"access token válido {int((exp - time.time()) / 60)} min más")
    else:
        say(WARN, "access token caducado (se renovará solo en la próxima llamada)")
    say(OK if data.get("refresh_token") else BAD,
        f"refresh token: {'presente' if data.get('refresh_token') else 'AUSENTE'}")
    return 0 if verify(token_dir) else 1


def login(token_dir: Path, port: int, force: bool, open_browser: bool) -> int:
    redirect_uri = f"http://127.0.0.1:{port}/callback"
    print(f"Login de Magnific → {token_dir}\n")

    print("1. Descubriendo el servidor de autorización")
    meta = discover()
    say(OK, f"authorization_endpoint: {meta['authorization_endpoint']}")
    say(OK, f"token_endpoint: {meta['token_endpoint']}")

    print("\n2. Cliente OAuth")
    client = None if force else load_client(token_dir)
    env_id = os.environ.get("MAGNIFIC_CLIENT_ID")
    if client and redirect_uri not in (client.get("redirect_uris") or [redirect_uri]):
        say(WARN, f"el cliente registrado no admite {redirect_uri}: registrando de nuevo")
        client = None
    if client:
        say(OK, "reutilizando el cliente ya registrado")
    elif env_id:
        say(OK, f"usando MAGNIFIC_CLIENT_ID del entorno ({env_id[:12]}…)")
        client = {"client_id": env_id, "redirect_uris": [redirect_uri]}
    else:
        client = register(meta, redirect_uri)
        say(OK, f"registrado como «{CLIENT_NAME}»")

    print("\n3. Autorización en el navegador")
    verifier, challenge = make_pkce()
    state = secrets.token_urlsafe(24)
    url = authorize_url(meta, client["client_id"], redirect_uri, challenge, state)

    if open_browser and webbrowser.open(url):
        say(OK, "navegador abierto — autoriza y vuelve aquí")
    else:
        say(INFO, "abre esta dirección a mano:")
        print(f"\n{url}\n")
    say(INFO, f"esperando la respuesta en {redirect_uri}")

    code = wait_for_code(port, state)
    say(OK, "código recibido")

    print("\n4. Canjeando por una sesión")
    tokens = exchange(meta, client["client_id"], code, verifier, redirect_uri)
    save(token_dir, tokens, meta, client)
    say(OK, f"sesión guardada en {token_dir} (solo lectura para tu usuario)")
    if not tokens.get("refresh_token"):
        say(WARN, "el servidor no dio refresh token: habrá que repetir el login al caducar")

    print("\n5. Verificando")
    ok = verify(token_dir)

    print("\n" + ("Listo. Ya no hace falta Hermes para generar rediseños."
                  if ok else
                  "Sesión escrita, pero la verificación falló. Repite con --status."))
    return 0 if ok else 1


def main() -> int:
    ap = argparse.ArgumentParser(description="Sesión OAuth propia para el MCP de Magnific")
    ap.add_argument("--status", action="store_true", help="solo comprobar la sesión actual")
    ap.add_argument("--force", action="store_true", help="registrar un cliente nuevo")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT,
                    help=f"puerto de retorno local (por defecto {DEFAULT_PORT})")
    ap.add_argument("--no-browser", action="store_true", help="no abrir el navegador")
    ap.add_argument("--dir", type=Path, default=TOKEN_DIR, help="dónde guardar la sesión")
    a = ap.parse_args()

    try:
        if a.status:
            return status(a.dir)
        return login(a.dir, a.port, a.force, not a.no_browser)
    except LoginError as e:
        print(f"\n{BAD} {e}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\ncancelado", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
