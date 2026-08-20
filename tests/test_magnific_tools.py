"""Pruebas del semáforo de estado y del catálogo de modelos.

Ambos scripts dejaron de pasar por un CLI externo y ahora hablan con el MCP
directamente. Lo que se comprueba aquí es lo que antes se hacía a ojo: que el
estado sale de la excepción tipada y no de buscar palabras en un texto, y que el
catálogo entiende las formas en que el servidor puede devolver lo mismo.

    .venv/bin/python -m pytest tests -q
"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))


def load(name: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# cada load() trae su propia copia de magnific_client, así que las excepciones se
# toman del módulo que se prueba: comparar contra otra copia no casaría nunca
status_mod = load("magnific_status")
models_mod = load("refresh_magnific_models")


class FakeMagnific:
    """Un cliente de mentira: devuelve lo que se le diga, o lanza lo que se le diga."""

    def __init__(self, *, balance=None, raises=None, tools=None, costs=None):
        self._balance, self._raises = balance, raises
        self._tools, self._costs = tools or {}, costs or {}
        self.asked: list[tuple] = []

    def __enter__(self):
        if self._raises:
            raise self._raises
        return self

    def __exit__(self, *_exc):
        return None

    def account_balance(self):
        if self._raises:
            raise self._raises
        return self._balance

    def call(self, tool, arguments=None, **_kw):
        self.asked.append((tool, arguments))
        return self._tools[tool]

    def simulate_cost(self, tool, arguments):
        self.asked.append(("simulate_cost", arguments))
        key = (arguments.get("mode"), arguments.get("resolution"), arguments.get("quality"))
        result = self._costs.get(key, self._costs.get("*"))
        if isinstance(result, Exception):
            raise result
        return result if result is not None else {}


# ------------------------------------------------------------------- estado

def test_a_working_session_reports_connected_with_the_balance(monkeypatch):
    monkeypatch.setattr(status_mod, "Magnific",
                        lambda *a, **k: FakeMagnific(balance={"credits": 1234}))
    out = status_mod.status()
    assert out["ok"] is True
    assert out["status"] == "connected"
    assert out["credits"] == 1234
    assert "1234" in out["detail"]


def test_an_expired_session_reports_auth_required_not_a_generic_error(monkeypatch):
    """Antes esto se decidía buscando «OAuth» en la salida de un CLI."""
    monkeypatch.setattr(status_mod, "Magnific", lambda *a, **k: FakeMagnific(
        raises=status_mod.MagnificAuthError("la sesión de Magnific ha caducado: haz login")))
    out = status_mod.status()
    assert out["status"] == "auth_required"
    assert out["ok"] is False
    assert "magnific_login.py" in out["hint"]


def test_a_broken_server_is_an_error_not_a_login_problem(monkeypatch):
    """Un 500 no se arregla volviendo a autenticarse: no debe pedir login."""
    monkeypatch.setattr(status_mod, "Magnific", lambda *a, **k: FakeMagnific(
        raises=status_mod.MagnificError("HTTP 500: algo se rompió por dentro")))
    out = status_mod.status()
    assert out["status"] == "error"
    assert "hint" not in out


def test_the_network_being_down_is_also_an_error(monkeypatch):
    monkeypatch.setattr(status_mod, "Magnific",
                        lambda *a, **k: FakeMagnific(raises=OSError("sin ruta al host")))
    out = status_mod.status()
    assert out["status"] == "error"
    assert "OSError" in out["detail"]


def test_a_balance_without_credits_still_counts_as_connected(monkeypatch):
    monkeypatch.setattr(status_mod, "Magnific",
                        lambda *a, **k: FakeMagnific(balance={"plan": "pro"}))
    out = status_mod.status()
    assert out["status"] == "connected" and out["credits"] is None


def test_status_prints_one_line_of_json(monkeypatch, capsys):
    """El endpoint del panel se queda con la última línea y la parsea."""
    monkeypatch.setattr(status_mod, "Magnific",
                        lambda *a, **k: FakeMagnific(balance={"credits": 10}))
    assert status_mod.main() == 0
    printed = capsys.readouterr().out.strip()
    assert "\n" not in printed
    assert json.loads(printed)["status"] == "connected"


def test_status_exits_nonzero_when_there_is_no_session(monkeypatch, capsys):
    monkeypatch.setattr(status_mod, "Magnific", lambda *a, **k: FakeMagnific(
        raises=status_mod.MagnificAuthError("no hay sesión")))
    assert status_mod.main() == 1
    assert json.loads(capsys.readouterr().out.strip())["ok"] is False


# ----------------------------------------------------------------- catálogo

def test_catalog_normalises_whatever_shape_the_server_uses():
    fake = FakeMagnific(tools={"images_models_list": {"models": [
        {"slug": "gpt-2", "name": "GPT 2", "resolutions": ["1k", "2k"],
         "qualities": ["alta"], "summary": "un modelo"},
        {"id": "otro-modelo", "supportedResolutions": ["4k"]},
    ]}})
    got = models_mod.catalog(fake)
    assert [m["slug"] for m in got] == ["gpt-2", "otro-modelo"]
    assert got[0]["resolutions"] == ["1k", "2k"]
    assert got[1]["name"] == "otro-modelo"        # sin nombre, sirve el slug
    assert got[1]["resolutions"] == ["4k"]


def test_catalog_finds_the_models_even_when_they_come_nested():
    fake = FakeMagnific(tools={"images_models_list":
                               {"result": {"data": [{"slug": "x"}]}}})
    assert [m["slug"] for m in models_mod.catalog(fake)] == ["x"]


def test_catalog_complains_instead_of_writing_an_empty_price_list():
    fake = FakeMagnific(tools={"images_models_list": {"models": []}})
    try:
        models_mod.catalog(fake)
    except models_mod.MagnificError as e:
        assert "no devolvió modelos" in str(e)
    else:
        raise AssertionError("un catálogo vacío tiene que fallar, no pasar en silencio")


# ------------------------------------------------------------------ precios

def test_price_reads_the_credits_from_the_response():
    fake = FakeMagnific(costs={("gpt-2", "2k", None): {"credits": 75}})
    assert models_mod.price(fake, "gpt-2", "2k", None) == 75.0


def test_price_looks_one_level_deeper_when_it_has_to():
    fake = FakeMagnific(costs={"*": {"estimate": {"credits": 40}}})
    assert models_mod.price(fake, "gpt-2", None, None) == 40.0


def test_price_returns_none_instead_of_inventing_a_number():
    fake = FakeMagnific(costs={"*": {"mensaje": "no se puede simular"}})
    assert models_mod.price(fake, "gpt-2", None, None) is None


def test_a_combination_the_server_rejects_does_not_sink_the_whole_run():
    fake = FakeMagnific(costs={"*": models_mod.MagnificError("combinación no válida")})
    assert models_mod.price(fake, "gpt-2", "8k", None) is None


def test_auto_is_priced_without_pinning_a_mode():
    """`auto` significa «elige tú»: mandarlo como mode sería contradecirlo."""
    fake = FakeMagnific(costs={"*": {"credits": 50}})
    models_mod.price(fake, "auto", "2k", None)
    _, args = fake.asked[-1]
    assert "mode" not in args
    assert args["resolution"] == "2k"


def test_pricing_covers_every_combination_the_model_offers():
    fake = FakeMagnific(costs={"*": {"credits": 10}})
    rows = models_mod.price_all(fake, {"slug": "m", "resolutions": ["1k", "2k"],
                                       "qualities": ["baja", "alta"]})
    assert len(rows) == 4
    assert {(r["resolution"], r["quality"]) for r in rows} == {
        ("1k", "baja"), ("1k", "alta"), ("2k", "baja"), ("2k", "alta")}


def test_a_model_without_options_is_still_priced_once():
    fake = FakeMagnific(costs={"*": {"credits": 10}})
    rows = models_mod.price_all(fake, {"slug": "m", "resolutions": [], "qualities": []})
    assert rows == [{"resolution": None, "quality": None, "credits": 10.0}]


def test_the_simulated_request_matches_what_the_pipeline_really_sends():
    """Si la simulación no pide lo mismo, el precio que guardamos no es el precio."""
    fake = FakeMagnific(costs={"*": {"credits": 10}})
    models_mod.price(fake, "gpt-2", "2k", "alta")
    _, args = fake.asked[-1]
    assert args["count"] == 1
    assert args["aspectRatio"] == "3:4"
    assert args["mode"] == "gpt-2" and args["resolution"] == "2k" and args["quality"] == "alta"
