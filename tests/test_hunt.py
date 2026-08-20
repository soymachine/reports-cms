"""Pruebas del cazador nocturno (scripts/hunt.py).

El cazador escribe en la base sin que nadie mire, a las dos de la mañana, así que
lo que importa es lo que NO hace: no duplicar lo que ya existe, no meter
agregadores ni redes sociales como si fueran organizaciones, no pasarse del tope
y no correr cuando está pausado.

La búsqueda en DuckDuckGo se sustituye por resultados de mentira: estas pruebas
no tocan la red.

    .venv/bin/python -m pytest tests -q
"""
from __future__ import annotations

import importlib.util
import json
import sqlite3
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))


def load(name: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


hunt = load("hunt")


LEADS_TABLE = """
CREATE TABLE leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation TEXT, website TEXT, website_domain TEXT,
  source TEXT, status TEXT, rationale TEXT, timeline TEXT,
  created_at TEXT DEFAULT (datetime('now'))
)"""
CRON_TABLE = """
CREATE TABLE cron_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT, ran_at TEXT DEFAULT (datetime('now')), summary TEXT, detail TEXT
)"""


@pytest.fixture
def conn():
    c = sqlite3.connect(":memory:")
    c.execute(LEADS_TABLE)
    c.execute(CRON_TABLE)
    return c


def results(*pairs) -> list[dict]:
    return [{"url": url, "title": title} for url, title in pairs]


# ------------------------------------------------------------------ nombres

def test_the_name_loses_the_boilerplate_of_the_page_title():
    assert hunt.clean_name("WindEurope | Home") == "WindEurope"
    assert hunt.clean_name("Hydrogen Europe - About us") == "Hydrogen Europe"
    assert hunt.clean_name("SolarPower Europe: Publications") == "SolarPower Europe"
    assert hunt.clean_name("  Bioenergy   Europe  ") == "Bioenergy Europe"


def test_a_name_that_is_only_boilerplate_does_not_survive():
    assert hunt.clean_name("| Home") == ""


# ----------------------------------------------------------------- dominios

def test_subdomains_collapse_to_the_organisation():
    assert hunt.registrable("docs.windeurope.org") == "windeurope.org"
    assert hunt.registrable("windeurope.org") == "windeurope.org"


def test_two_level_country_domains_keep_their_three_parts():
    """`example.co.uk` recortado a `co.uk` fundiría organizaciones distintas."""
    assert hunt.registrable("www2.example.co.uk") == "example.co.uk"
    assert hunt.registrable("example.org.uk") == "example.org.uk"


def test_domain_of_drops_the_www():
    assert hunt.domain_of("https://www.windeurope.org/publications/") == "windeurope.org"


# ---------------------------------------------------------------- candidatos

def test_aggregators_and_social_networks_are_not_organisations():
    for url in ("https://en.wikipedia.org/wiki/WindEurope",
                "https://www.linkedin.com/company/windeurope",
                "https://twitter.com/windeurope",
                "https://scholar.google.com/citations"):
        assert hunt.candidates_from(results((url, "WindEurope"))) == []


def test_a_subdomain_of_an_aggregator_is_also_out():
    assert hunt.candidates_from(results(
        ("https://es.wikipedia.org/wiki/Algo", "Algo"))) == []


def test_a_real_organisation_becomes_a_candidate():
    got = hunt.candidates_from(results(
        ("https://windeurope.org/about/", "WindEurope | Home")))
    assert got == [{
        "organisation": "WindEurope",
        "domain": "windeurope.org",
        "website": "https://windeurope.org",
        "source_url": "https://windeurope.org/about/",
    }]


def test_the_same_organisation_twice_in_one_search_counts_once():
    got = hunt.candidates_from(results(
        ("https://windeurope.org/about/", "WindEurope"),
        ("https://docs.windeurope.org/reports/", "WindEurope reports"),
    ))
    assert len(got) == 1


def test_titles_that_are_just_numbers_are_not_names():
    assert hunt.candidates_from(results(("https://example.org/x", "2026 · 45%"))) == []


# --------------------------------------------------------------- duplicados

def test_an_organisation_already_in_the_base_is_not_inserted_again(conn, monkeypatch):
    conn.execute("INSERT INTO leads (organisation, website_domain) VALUES (?, ?)",
                 ("WindEurope", "windeurope.org"))
    monkeypatch.setattr(hunt, "ddg_results", lambda q, limit=12: results(
        ("https://windeurope.org/", "WindEurope")))
    monkeypatch.setattr(hunt.time, "sleep", lambda *_: None)

    report = hunt.hunt(conn, ["una consulta"], limit=5)
    assert report["inserted"] == []
    assert report["skipped"]["conocido"] == 1


def test_the_same_name_written_differently_still_counts_as_known(conn, monkeypatch):
    """«The Wind Europe» y «Wind Europe» son el mismo lead para una persona."""
    conn.execute("INSERT INTO leads (organisation) VALUES (?)", ("The Wind Europe",))
    monkeypatch.setattr(hunt, "ddg_results", lambda q, limit=12: results(
        ("https://otra-web.org/", "Wind Europe!")))
    monkeypatch.setattr(hunt.time, "sleep", lambda *_: None)

    assert hunt.hunt(conn, ["q"], limit=5)["inserted"] == []


def test_a_lead_found_twice_in_one_round_is_inserted_once(conn, monkeypatch):
    monkeypatch.setattr(hunt, "ddg_results", lambda q, limit=12: results(
        ("https://windeurope.org/", "WindEurope")))
    monkeypatch.setattr(hunt.time, "sleep", lambda *_: None)

    report = hunt.hunt(conn, ["consulta uno", "consulta dos"], limit=5)
    assert len(report["inserted"]) == 1


# ---------------------------------------------------------------- inserción

def test_an_inserted_lead_arrives_reviewable_and_traceable(conn, monkeypatch):
    monkeypatch.setattr(hunt, "ddg_results", lambda q, limit=12: results(
        ("https://windeurope.org/reports/", "WindEurope | Publications")))
    monkeypatch.setattr(hunt.time, "sleep", lambda *_: None)

    hunt.hunt(conn, ["energía eólica"], limit=5)
    row = conn.execute("SELECT organisation, website, website_domain, source, status, "
                       "rationale, timeline FROM leads").fetchone()
    assert row[0] == "WindEurope"
    assert row[1] == "https://windeurope.org"
    assert row[2] == "windeurope.org"
    assert row[3] == "agent"
    assert row[4] == "Not contacted"       # nada entra dado por bueno
    assert "energía eólica" in row[5]
    # el timeline guarda de dónde salió, para poder juzgarlo después
    entry = json.loads(row[6])[0]
    assert "energía eólica" in entry["text"]
    assert "windeurope.org/reports/" in entry["text"]


def test_the_round_stops_at_the_limit(conn, monkeypatch):
    monkeypatch.setattr(hunt, "ddg_results", lambda q, limit=12: results(
        ("https://uno.org/", "Uno Europe"), ("https://dos.org/", "Dos Europe"),
        ("https://tres.org/", "Tres Europe"), ("https://cuatro.org/", "Cuatro Europe")))
    monkeypatch.setattr(hunt.time, "sleep", lambda *_: None)

    report = hunt.hunt(conn, ["q1", "q2"], limit=2)
    assert len(report["inserted"]) == 2
    assert conn.execute("SELECT COUNT(*) FROM leads").fetchone()[0] == 2


def test_a_dry_run_writes_nothing(conn, monkeypatch):
    monkeypatch.setattr(hunt, "ddg_results", lambda q, limit=12: results(
        ("https://windeurope.org/", "WindEurope")))
    monkeypatch.setattr(hunt.time, "sleep", lambda *_: None)

    report = hunt.hunt(conn, ["q"], limit=5, dry_run=True)
    assert len(report["inserted"]) == 1
    assert conn.execute("SELECT COUNT(*) FROM leads").fetchone()[0] == 0


def test_a_search_that_fails_does_not_sink_the_round(conn, monkeypatch):
    def flaky(query, limit=12):
        if query == "rota":
            return []                       # ddg_results ya absorbe la excepción
        return results(("https://windeurope.org/", "WindEurope"))
    monkeypatch.setattr(hunt, "ddg_results", flaky)
    monkeypatch.setattr(hunt.time, "sleep", lambda *_: None)

    assert len(hunt.hunt(conn, ["rota", "buena"], limit=5)["inserted"]) == 1


def test_the_run_is_recorded_so_the_panel_can_show_it(conn):
    hunt.record_run(conn, "2 leads nuevos", {"queries": ["q"]})
    row = conn.execute("SELECT job, summary FROM cron_history").fetchone()
    assert row[0] == "lead_hunter"
    assert row[1] == "2 leads nuevos"


# -------------------------------------------------------------------- pausa

def _run_main(monkeypatch, tmp_path, settings: dict, argv: list[str]) -> int:
    (tmp_path / "settings.json").write_text(json.dumps(settings))
    monkeypatch.setattr(hunt, "SETTINGS", tmp_path / "settings.json")
    monkeypatch.setattr(hunt, "STATE_FILE", tmp_path / ".hunt_status.json")
    monkeypatch.setattr(hunt, "DB", tmp_path / "leads.db")
    monkeypatch.setattr(sys, "argv", ["hunt.py", *argv])
    return hunt.main()


def test_a_paused_hunter_does_nothing_and_says_so(monkeypatch, tmp_path, capsys):
    """launchd sigue disparando: la ronda tiene que salirse sola."""
    code = _run_main(monkeypatch, tmp_path,
                     {"hunter": {"enabled": False, "queries": ["q"]}}, [])
    assert code == 0                        # salir en pausa no es un fallo
    assert "pausa" in capsys.readouterr().out
    state = json.loads((tmp_path / ".hunt_status.json").read_text())
    assert state["state"] == "paused"


def test_the_button_runs_even_when_the_hunter_is_paused(monkeypatch, tmp_path, capsys):
    """Pulsar «buscar ahora» es una orden explícita: la pausa no la anula."""
    code = _run_main(monkeypatch, tmp_path,
                     {"hunter": {"enabled": False, "queries": []}}, ["--ignore-pause"])
    assert code == 1                        # llega hasta la falta de consultas
    assert "consultas" in capsys.readouterr().err


def test_without_queries_it_refuses_instead_of_hunting_nothing(monkeypatch, tmp_path, capsys):
    code = _run_main(monkeypatch, tmp_path, {"hunter": {"enabled": True}}, [])
    assert code == 1
    assert "hunter.queries" in capsys.readouterr().err


# ------------------------------------------------- el buscador se puede caer

def test_a_search_that_never_answers_is_recorded_as_failed(conn, monkeypatch):
    def down(query, limit=12):
        raise hunt.SearchError("URLError: sin ruta al host")
    monkeypatch.setattr(hunt, "ddg_results", down)
    monkeypatch.setattr(hunt.time, "sleep", lambda *_: None)

    report = hunt.hunt(conn, ["q1", "q2"], limit=5)
    assert report["failed"] == ["q1", "q2"]
    assert report["inserted"] == []


def test_one_broken_search_does_not_stop_the_others(conn, monkeypatch):
    def half(query, limit=12):
        if query == "rota":
            raise hunt.SearchError("timeout")
        return results(("https://windeurope.org/", "WindEurope"))
    monkeypatch.setattr(hunt, "ddg_results", half)
    monkeypatch.setattr(hunt.time, "sleep", lambda *_: None)

    report = hunt.hunt(conn, ["rota", "buena"], limit=5)
    assert report["failed"] == ["rota"]
    assert len(report["inserted"]) == 1


def test_a_night_where_nothing_could_be_searched_is_a_failure(monkeypatch, tmp_path, capsys):
    """Si no distinguiera esto de «no hay leads nuevos», el cazador podría
    llevar meses roto sin que nadie se enterase."""
    db = tmp_path / "leads.db"
    c = sqlite3.connect(db)
    c.execute("CREATE TABLE leads (id INTEGER PRIMARY KEY, organisation TEXT, "
              "website TEXT, website_domain TEXT, source TEXT, status TEXT, "
              "rationale TEXT, timeline TEXT)")
    c.execute("CREATE TABLE cron_history (id INTEGER PRIMARY KEY, job TEXT, "
              "ran_at TEXT DEFAULT (datetime('now')), summary TEXT, detail TEXT)")
    c.commit()
    c.close()

    def down(query, limit=12):
        raise hunt.SearchError("URLError: sin ruta al host")
    monkeypatch.setattr(hunt, "ddg_results", down)
    monkeypatch.setattr(hunt.time, "sleep", lambda *_: None)

    code = _run_main(monkeypatch, tmp_path,
                     {"hunter": {"enabled": True, "queries": ["q1", "q2"]}}, [])
    assert code == 1
    out = capsys.readouterr().out
    assert "✗" in out
    assert "2 búsqueda(s) fallida(s)" in out
    # y queda anotado en el historial, para verlo desde el panel
    c = sqlite3.connect(db)
    assert "fallida" in c.execute("SELECT summary FROM cron_history").fetchone()[0]
