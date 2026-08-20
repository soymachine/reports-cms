"""Pruebas del login OAuth propio (scripts/magnific_login.py).

Cubren lo que se puede comprobar sin red ni cuenta: el cálculo de PKCE, la
petición de autorización, la validación del `state` en el retorno, los permisos
con los que se guarda la sesión y a qué directorio mira el cliente. El flujo
completo contra Magnific solo se puede probar a mano, con un navegador.

    .venv/bin/python -m pytest tests -q
"""
from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
import stat
import sys
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))


def load(name: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


login = load("magnific_login")
client = load("magnific_client")


META = {
    "authorization_endpoint": "https://auth.example.com/authorize",
    "token_endpoint": "https://auth.example.com/token",
    "_resource": "https://mcp.magnific.com",
    "scopes_supported": ["images:write", "account:read"],
}


# ------------------------------------------------------------------ PKCE

def test_pkce_challenge_is_the_sha256_of_the_verifier():
    """Si el reto no cuadra con el verificador, el canje falla con un 400 opaco."""
    verifier, challenge = login.make_pkce()
    expected = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode("ascii")).digest()).decode().rstrip("=")
    assert challenge == expected


def test_pkce_verifier_respects_the_length_the_rfc_demands():
    """RFC 7636: entre 43 y 128 caracteres, y sin relleno base64."""
    for _ in range(20):
        verifier, challenge = login.make_pkce()
        assert 43 <= len(verifier) <= 128
        assert "=" not in verifier and "=" not in challenge


def test_two_logins_never_share_a_verifier():
    assert len({login.make_pkce()[0] for _ in range(50)}) == 50


# ------------------------------------------------- petición de autorización

def test_authorize_url_carries_everything_the_server_needs():
    url = login.authorize_url(META, "cli-123", "http://127.0.0.1:8765/callback",
                              "reto", "estado")
    query = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
    assert url.startswith(META["authorization_endpoint"] + "?")
    assert query["response_type"] == ["code"]
    assert query["client_id"] == ["cli-123"]
    assert query["redirect_uri"] == ["http://127.0.0.1:8765/callback"]
    assert query["code_challenge"] == ["reto"]
    assert query["code_challenge_method"] == ["S256"]
    assert query["state"] == ["estado"]
    # RFC 8707: sin `resource` algunos servidores emiten un token que el MCP rechaza
    assert query["resource"] == [META["_resource"]]
    assert query["scope"] == ["images:write account:read"]


def test_authorize_url_omits_what_the_server_did_not_declare():
    meta = {"authorization_endpoint": META["authorization_endpoint"],
            "token_endpoint": META["token_endpoint"]}
    query = urllib.parse.parse_qs(urllib.parse.urlparse(
        login.authorize_url(meta, "c", "http://127.0.0.1:1/cb", "r", "e")).query)
    assert "resource" not in query and "scope" not in query


# ------------------------------------------------------- servidor de retorno

def _free_port() -> int:
    import socket
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _callback(port: int, query: str) -> int:
    """Llama al servidor de retorno y devuelve el código HTTP."""
    for _ in range(50):                       # el hilo tarda unos ms en escuchar
        try:
            with urllib.request.urlopen(
                    f"http://127.0.0.1:{port}/callback?{query}", timeout=5) as res:
                return res.status
        except urllib.error.HTTPError as e:
            return e.code
        except urllib.error.URLError:
            time.sleep(0.02)
    raise AssertionError("el servidor de retorno nunca escuchó")


def _run(port: int, state: str) -> dict:
    out: dict = {}
    def go():
        try:
            out["code"] = login.wait_for_code(port, state)
        except login.LoginError as e:
            out["error"] = str(e)
    thread = threading.Thread(target=go, daemon=True)
    thread.start()
    return {"thread": thread, "out": out}


def test_callback_accepts_the_code_when_the_state_matches():
    port = _free_port()
    run = _run(port, "s3cr3t")
    assert _callback(port, urllib.parse.urlencode(
        {"code": "abc123", "state": "s3cr3t"})) == 200
    run["thread"].join(10)
    assert run["out"] == {"code": "abc123"}


def test_callback_rejects_a_code_that_comes_with_the_wrong_state():
    """El state es lo único que impide que alguien nos cuele su propio código."""
    port = _free_port()
    run = _run(port, "s3cr3t")
    assert _callback(port, urllib.parse.urlencode(
        {"code": "del-atacante", "state": "otro"})) == 400
    run["thread"].join(10)
    assert "code" not in run["out"]
    assert "state" in run["out"]["error"]


def test_callback_reports_a_denied_authorization():
    port = _free_port()
    run = _run(port, "s3cr3t")
    assert _callback(port, urllib.parse.urlencode(
        {"error": "access_denied", "error_description": "el usuario dijo que no",
         "state": "s3cr3t"})) == 400
    run["thread"].join(10)
    assert run["out"]["error"] == "el usuario dijo que no"


def test_busy_port_explains_what_to_do(tmp_path):
    port = _free_port()
    run = _run(port, "s3cr3t")
    time.sleep(0.2)
    with pytest.raises(login.LoginError, match="ocupado"):
        login.wait_for_code(port, "otro")
    _callback(port, urllib.parse.urlencode({"code": "x", "state": "s3cr3t"}))
    run["thread"].join(10)


# -------------------------------------------------------------- persistencia

def test_save_writes_the_three_files_the_client_expects(tmp_path):
    dest = tmp_path / "magnific"
    login.save(dest,
               {"access_token": "at", "refresh_token": "rt", "expires_in": 3600},
               dict(META), {"client_id": "cli-123", "redirect_uris": ["http://x/cb"]})

    session = json.loads((dest / "magnific.json").read_text())
    assert session["access_token"] == "at" and session["refresh_token"] == "rt"
    assert time.time() < session["expires_at"] <= time.time() + 3601
    assert json.loads((dest / "magnific.meta.json").read_text())["token_endpoint"]
    assert json.loads((dest / "magnific.client.json").read_text())["client_id"] == "cli-123"


def test_saved_session_is_not_readable_by_anyone_else(tmp_path):
    dest = tmp_path / "magnific"
    login.save(dest, {"access_token": "at", "expires_in": 60}, dict(META),
               {"client_id": "c"})
    assert stat.S_IMODE((dest / "magnific.json").stat().st_mode) == 0o600
    assert stat.S_IMODE(dest.stat().st_mode) == 0o700


def test_save_defaults_the_expiry_when_the_server_omits_it(tmp_path):
    dest = tmp_path / "magnific"
    login.save(dest, {"access_token": "at"}, dict(META), {"client_id": "c"})
    session = json.loads((dest / "magnific.json").read_text())
    assert session["expires_at"] > time.time()


# --------------------------------------------------- dónde busca el cliente

def test_the_client_reads_the_session_the_login_just_wrote(tmp_path, monkeypatch):
    dest = tmp_path / "magnific"
    login.save(dest, {"access_token": "el-token", "expires_in": 3600}, dict(META),
               {"client_id": "c"})
    monkeypatch.delenv("MAGNIFIC_ACCESS_TOKEN", raising=False)
    assert client.Magnific(token_dir=dest)._load_token() == "el-token"


def test_own_session_wins_over_the_one_hermes_left(tmp_path, monkeypatch):
    """Una máquina ya migrada no debe volver a mirar ~/.hermes."""
    monkeypatch.delenv("MAGNIFIC_TOKEN_DIR", raising=False)
    own, hermes = tmp_path / "propio", tmp_path / "hermes"
    for path in (own, hermes):
        path.mkdir()
        (path / "magnific.json").write_text("{}")
    monkeypatch.setattr(client, "OWN_TOKENS", own)
    monkeypatch.setattr(client, "HERMES_TOKENS", hermes)
    assert client.default_token_dir() == own


def test_hermes_session_still_works_until_the_machine_migrates(tmp_path, monkeypatch):
    monkeypatch.delenv("MAGNIFIC_TOKEN_DIR", raising=False)
    own, hermes = tmp_path / "propio", tmp_path / "hermes"
    hermes.mkdir()
    (hermes / "magnific.json").write_text("{}")
    monkeypatch.setattr(client, "OWN_TOKENS", own)
    monkeypatch.setattr(client, "HERMES_TOKENS", hermes)
    assert client.default_token_dir() == hermes


def test_the_environment_variable_beats_both(tmp_path, monkeypatch):
    monkeypatch.setenv("MAGNIFIC_TOKEN_DIR", str(tmp_path / "elegido"))
    assert client.default_token_dir() == tmp_path / "elegido"


def test_missing_session_points_at_the_new_login_not_at_hermes(tmp_path, monkeypatch):
    monkeypatch.delenv("MAGNIFIC_ACCESS_TOKEN", raising=False)
    with pytest.raises(client.MagnificAuthError) as e:
        client.Magnific(token_dir=tmp_path / "vacío")._load_token()
    assert "magnific_login.py" in str(e.value)
    assert "hermes" not in str(e.value).lower()
