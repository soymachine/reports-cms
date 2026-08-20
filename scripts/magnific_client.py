#!/usr/bin/env python3
"""magnific_client.py — direct MCP client for Magnific, no LLM agent in the middle.

The redesign used to run through a Hermes agent that was *asked* to call
images_generate, save one file per page with an exact name and report the credits
it spent. That indirection produced every expensive bug we have hit: surplus
variants that got paid for and thrown away, files overwritten, credits scraped
out of prose, auth failures detected by grepping for a word.

This module speaks the MCP streamable-HTTP protocol itself, reusing the OAuth
session Hermes already established (`hermes mcp login magnific`). Calls are
deterministic and the credit figures come from the API response.

The token is read from ~/.hermes/mcp-tokens/magnific.json at call time and is
never logged. When it has expired the client refreshes it with the stored
refresh token; if that fails, callers get MagnificAuthError and should fall back
to the agent path or ask the user to log in again.

Usage as a library:
    from magnific_client import Magnific
    with Magnific() as m:
        print(m.account_balance())
"""
from __future__ import annotations

import json
import mimetypes
import os
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

HERMES_TOKENS = Path.home() / ".hermes" / "mcp-tokens"
DEFAULT_URL = os.environ.get("MAGNIFIC_MCP_URL", "https://mcp.magnific.com")
TIMEOUT = 180


class MagnificError(RuntimeError):
    """The server refused the call or answered something we cannot use."""


class MagnificAuthError(MagnificError):
    """No usable session: the caller should fall back or ask for a new login."""


def _post(url: str, data: bytes | None, headers: dict[str, str], *,
          method: str = "POST", timeout: int = TIMEOUT) -> tuple[int, bytes, dict]:
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, res.read(), dict(res.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers or {})


class Magnific:
    """Minimal MCP client: initialize once, then tools/call."""

    def __init__(self, url: str = DEFAULT_URL, token_dir: Path = HERMES_TOKENS):
        self.url = url.rstrip("/")
        self.token_dir = token_dir
        self.session_id: str | None = None
        self._token: str | None = None
        self._id = 0

    # ---------------------------------------------------------------- auth

    def _token_file(self) -> Path:
        return self.token_dir / "magnific.json"

    def _load_token(self) -> str:
        """Access token, refreshed when the stored one is past its expiry."""
        if self._token:
            return self._token

        env = os.environ.get("MAGNIFIC_ACCESS_TOKEN")
        if env:
            self._token = env
            return env

        path = self._token_file()
        if not path.exists():
            raise MagnificAuthError(
                "no hay sesión de Magnific: ejecuta `hermes mcp login magnific`")
        data = json.loads(path.read_text())
        token = data.get("access_token")
        expires_at = float(data.get("expires_at") or 0)

        if token and (not expires_at or expires_at - 60 > time.time()):
            self._token = token
            return token

        refreshed = self._refresh(data)
        if refreshed:
            self._token = refreshed
            return refreshed
        if token:
            # expiry may simply be stale; let the server be the judge
            self._token = token
            return token
        raise MagnificAuthError(
            "la sesión de Magnific ha caducado: ejecuta `hermes mcp login magnific`")

    def _refresh(self, data: dict) -> str | None:
        meta_path = self.token_dir / "magnific.meta.json"
        client_path = self.token_dir / "magnific.client.json"
        if not (meta_path.exists() and client_path.exists() and data.get("refresh_token")):
            return None
        meta = json.loads(meta_path.read_text())
        client = json.loads(client_path.read_text())
        endpoint = meta.get("token_endpoint")
        client_id = client.get("client_id")
        if not (endpoint and client_id):
            return None

        body = urllib.parse.urlencode({
            "grant_type": "refresh_token",
            "refresh_token": data["refresh_token"],
            "client_id": client_id,
        }).encode()
        status, raw, _ = _post(endpoint, body,
                               {"Content-Type": "application/x-www-form-urlencoded"},
                               timeout=30)
        if status != 200:
            return None
        try:
            fresh = json.loads(raw)
        except Exception:
            return None
        token = fresh.get("access_token")
        if not token:
            return None
        # write the rotated session back so the next run (and Hermes) reuses it
        data.update(fresh)
        data["expires_at"] = time.time() + float(fresh.get("expires_in") or 3600)
        try:
            self._token_file().write_text(json.dumps(data))
            self._token_file().chmod(0o600)
        except Exception:
            pass
        return token

    # ------------------------------------------------------------- protocol

    def _headers(self) -> dict[str, str]:
        h = {
            "Authorization": f"Bearer {self._load_token()}",
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": "2025-06-18",
        }
        if self.session_id:
            h["Mcp-Session-Id"] = self.session_id
        return h

    def _next_id(self) -> int:
        self._id += 1
        return self._id

    @staticmethod
    def _parse(raw: bytes) -> dict:
        """Responses come back as plain JSON or as a one-message SSE stream."""
        text = raw.decode("utf-8", "replace").strip()
        if not text:
            return {}
        if text.startswith("{"):
            return json.loads(text)
        payload = None
        for line in text.splitlines():
            if line.startswith("data:"):
                payload = line[5:].strip()
        if payload is None:
            raise MagnificError(f"respuesta ininteligible: {text[:200]}")
        return json.loads(payload)

    def _rpc(self, method: str, params: dict | None = None, *, timeout: int = TIMEOUT) -> dict:
        body = json.dumps({"jsonrpc": "2.0", "id": self._next_id(),
                           "method": method, "params": params or {}}).encode()
        status, raw, headers = _post(self.url, body, self._headers(), timeout=timeout)
        if status in (401, 403):
            raise MagnificAuthError(
                "Magnific rechazó la sesión (401/403): ejecuta `hermes mcp login magnific`")
        if status >= 400:
            raise MagnificError(f"HTTP {status}: {raw[:300].decode('utf-8', 'replace')}")
        sid = headers.get("Mcp-Session-Id") or headers.get("mcp-session-id")
        if sid:
            self.session_id = sid
        msg = self._parse(raw)
        if "error" in msg:
            raise MagnificError(str(msg["error"])[:400])
        return msg.get("result", {})

    def _notify(self, method: str, params: dict | None = None) -> None:
        body = json.dumps({"jsonrpc": "2.0", "method": method, "params": params or {}}).encode()
        _post(self.url, body, self._headers(), timeout=30)

    def connect(self) -> "Magnific":
        if self.session_id:
            return self
        self._rpc("initialize", {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "thinkthings-dashboard", "version": "1.0"},
        }, timeout=60)
        self._notify("notifications/initialized")
        return self

    def __enter__(self) -> "Magnific":
        return self.connect()

    def __exit__(self, *_exc) -> None:
        return None

    # ------------------------------------------------------------ tool call

    def call(self, tool: str, arguments: dict | None = None, *, timeout: int = TIMEOUT) -> Any:
        """Run one MCP tool and return its structured content (or the raw text)."""
        self.connect()
        result = self._rpc("tools/call", {"name": tool, "arguments": arguments or {}},
                           timeout=timeout)
        if result.get("isError"):
            raise MagnificError(f"{tool}: {self._text(result)[:400]}")
        if isinstance(result.get("structuredContent"), dict):
            return result["structuredContent"]
        text = self._text(result)
        try:
            return json.loads(text)
        except Exception:
            return text

    @staticmethod
    def _text(result: dict) -> str:
        parts = []
        for block in result.get("content") or []:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(str(block.get("text", "")))
        return "\n".join(parts)

    # ------------------------------------------------------------- helpers

    def account_balance(self) -> dict:
        out = self.call("account_balance", timeout=60)
        return out if isinstance(out, dict) else {"raw": out}

    def simulate_cost(self, tool: str, arguments: dict) -> dict:
        out = self.call("simulate_cost", {"tool": tool, "arguments": arguments}, timeout=60)
        return out if isinstance(out, dict) else {"raw": out}

    def upload_image(self, path: Path) -> str:
        """Local file → creation identifier, via request_upload → PUT → finalize."""
        path = Path(path)
        if not path.exists():
            raise MagnificError(f"no existe la imagen a subir: {path}")
        mime = mimetypes.guess_type(path.name)[0] or "image/png"

        req = self.call("creations_request_upload", {"mimeType": mime}, timeout=120)
        entry = _first_upload(req)
        url = next((entry[k] for k in UPLOAD_URL_KEYS if entry.get(k)), None)
        temp = (entry.get("path") or entry.get("tempPath") or entry.get("key")
                or entry.get("temporaryPath"))
        if not url:
            raise MagnificError(f"creations_request_upload sin URL: {str(req)[:300]}")

        status, raw, _ = _post(url, path.read_bytes(), {"Content-Type": mime}, method="PUT")
        if status >= 300:
            raise MagnificError(f"PUT del upload falló: HTTP {status} {raw[:200]!r}")

        if not temp:
            raise MagnificError(f"creations_request_upload sin path: {str(req)[:300]}")
        fin = self.call("creations_finalize_upload", {"path": temp}, timeout=180)
        ident = _first_identifier(fin)
        if not ident:
            raise MagnificError(f"creations_finalize_upload sin identificador: {str(fin)[:300]}")
        return ident

    def generate(self, *, prompt: str, reference: str | None = None,
                 style_reference: str | None = None, mode: str = "",
                 resolution: str = "", quality: str = "", aspect_ratio: str = "",
                 timeout: int = 900) -> dict:
        """One image, one call. Returns {"identifier", "url", "credits", "raw"}.

        `style_reference` is another creation whose look this one should follow —
        how a set of pages ends up sharing one design instead of four.
        """
        args: dict[str, Any] = {"prompt": prompt, "count": 1}
        refs = []
        if reference:
            refs.append({"type": "image", "identifier": reference})
        if style_reference and style_reference != reference:
            refs.append({"type": "style", "identifier": style_reference})
        if refs:
            args["references"] = refs
        if mode and mode != "auto":
            args["mode"] = mode
        if resolution:
            args["resolution"] = resolution
        if quality:
            args["quality"] = quality
        if aspect_ratio:
            args["aspectRatio"] = aspect_ratio

        out = self.call("images_generate", args, timeout=timeout)
        identifiers = _identifiers(out)
        if not identifiers:
            raise MagnificError(f"images_generate no devolvió creaciones: {str(out)[:300]}")
        done = self.wait(identifiers[0], timeout=timeout)
        return {
            "identifier": identifiers[0],
            "url": _url_of(done) or _url_of(out),
            "credits": _credits_of(out) or _credits_of(done),
            "extra": identifiers[1:],
            "raw": done if isinstance(done, dict) else {"raw": done},
        }

    def wait(self, identifier: str, *, timeout: int = 900) -> dict:
        """Long-poll one creation until it is finished (or the deadline passes)."""
        deadline = time.time() + timeout
        last: Any = {}
        while time.time() < deadline:
            last = self.call("creations_wait",
                             {"identifiers": [identifier], "timeoutSeconds": 25}, timeout=60)
            entry = _entry_for(last, identifier)
            state = str(entry.get("status") or entry.get("state") or "").lower()
            if _url_of(entry):
                return entry
            if state in {"failed", "error", "cancelled", "canceled"}:
                raise MagnificError(f"la creación {identifier} terminó en {state}")
            wait_for = entry.get("poll_after_seconds") or entry.get("pollAfterSeconds") or 3
            time.sleep(min(float(wait_for), 15))
        raise MagnificError(f"la creación {identifier} no terminó en {timeout}s")

    def download(self, url: str, dest: Path) -> Path:
        dest.parent.mkdir(parents=True, exist_ok=True)
        req = urllib.request.Request(url, headers={"User-Agent": "thinkthings-dashboard"})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as res, open(dest, "wb") as fh:
            fh.write(res.read())
        return dest


# ---------------------------------------------------------------- shape helpers
# The MCP payloads are not documented field by field and have changed shape before,
# so every reader below is defensive: find what we need wherever it is.

def _walk(node: Any):
    if isinstance(node, dict):
        yield node
        for v in node.values():
            yield from _walk(v)
    elif isinstance(node, list):
        for v in node:
            yield from _walk(v)


UPLOAD_URL_KEYS = ("proxyUploadUrl", "uploadUrl", "presignedUrl", "url")


def _first_upload(payload: Any) -> dict:
    for node in _walk(payload):
        if any(k in node for k in UPLOAD_URL_KEYS) and \
           any(k in node for k in ("path", "tempPath", "key", "temporaryPath")):
            return node
    for node in _walk(payload):
        if any(k in node for k in UPLOAD_URL_KEYS):
            return node
    return {}


def _first_identifier(payload: Any) -> str | None:
    for node in _walk(payload):
        for key in ("identifier", "creationIdentifier", "id"):
            value = node.get(key)
            if isinstance(value, str) and value:
                return value
    return None


def _identifiers(payload: Any) -> list[str]:
    found: list[str] = []
    for node in _walk(payload):
        for key in ("identifier", "creationIdentifier"):
            value = node.get(key)
            if isinstance(value, str) and value and value not in found:
                found.append(value)
    return found


def _entry_for(payload: Any, identifier: str) -> dict:
    for node in _walk(payload):
        if node.get("identifier") == identifier or node.get("creationIdentifier") == identifier:
            return node
    for node in _walk(payload):
        if _url_of(node):
            return node
    return payload if isinstance(payload, dict) else {}


def _url_of(payload: Any) -> str | None:
    for node in _walk(payload):
        for key in ("url", "imageUrl", "outputUrl", "resultUrl"):
            value = node.get(key)
            if isinstance(value, str) and value.startswith("http") and "upload" not in key.lower():
                return value
    return None


def _credits_of(payload: Any) -> float | None:
    for node in _walk(payload):
        for key in ("credits", "creditsUsed", "credits_used", "cost"):
            value = node.get(key)
            if isinstance(value, (int, float)):
                return float(value)
    return None


import urllib.parse  # noqa: E402  (used by _refresh; kept here to stay out of the hot path)


if __name__ == "__main__":  # smoke test: read-only, spends nothing
    with Magnific() as m:
        balance = m.account_balance()
        print(json.dumps({"ok": True, "balance": balance}, ensure_ascii=False)[:600])
