#!/usr/bin/env python3
"""hunt.py — cazador nocturno de leads. Sin agente, sin LLM, sin CLI externo.

Sustituye al job `lead_hunter` que vivía en el cron de Hermes (y solo allí: el
repo únicamente guardaba su identificador, así que el agente no era reproducible
en otra máquina).

Qué hace, en orden:

  1. Lanza las consultas de `settings.json → hunter.queries` contra DuckDuckGo
     Lite, la misma fuente que ya usa pdf_finder.py.
  2. Saca de cada resultado un candidato: nombre de la organización y dominio.
  3. Descarta lo que no es una organización —agregadores, redes sociales,
     prensa, Wikipedia— y lo que ya está en la base, por nombre normalizado y
     por dominio.
  4. Inserta hasta `hunter.max_new_leads` con `source=agent` y estado
     "Not contacted", y anota la ejecución en `cron_history`.

No juzga si un lead es bueno: eso lo hace quien lo revisa en el tablero, y por
eso todo entra como "Not contacted" y sin gastar un solo crédito.

Uso:
  .venv/bin/python scripts/hunt.py                 # una ronda
  .venv/bin/python scripts/hunt.py --dry-run       # enseña lo que insertaría
  .venv/bin/python scripts/hunt.py --max 3
  .venv/bin/python scripts/hunt.py --ignore-pause  # aunque esté pausado
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import time
import urllib.parse
import urllib.request
from html import unescape
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "leads.db"
SETTINGS = ROOT / "settings.json"
STATE_FILE = ROOT / ".hunt_status.json"

UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"}

# Dominios que nunca son la web de una organización: agregadores, prensa,
# directorios y redes. Un resultado en uno de ellos puede hablar de un lead, pero
# no es el lead.
SKIP_DOMAINS = {
    "wikipedia.org", "linkedin.com", "twitter.com", "x.com", "facebook.com",
    "instagram.com", "youtube.com", "reddit.com", "medium.com", "amazon.com",
    "google.com", "duckduckgo.com", "scholar.google.com", "researchgate.net",
    "europa.eu", "consilium.europa.eu", "europarl.europa.eu",
    "crunchbase.com", "glassdoor.com", "indeed.com", "yelp.com",
    "pinterest.com", "slideshare.net", "scribd.com", "issuu.com",
}

# Ruido habitual en los títulos de resultado que no forma parte del nombre.
TITLE_NOISE = re.compile(
    r"\s*[|\-–—:·]\s*(home|homepage|inicio|about( us)?|welcome|official (web)?site|"
    r"publications?|reports?|news|contact).*$", re.I)


def load_settings() -> dict:
    try:
        return json.loads(SETTINGS.read_text())
    except Exception:
        return {}


def save_state(**kw) -> None:
    """Estado para el panel: qué está pasando y desde cuándo."""
    payload = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "pid": os.getpid(), **kw}
    try:
        STATE_FILE.write_text(json.dumps(payload, ensure_ascii=False))
    except Exception:
        pass


# ----------------------------------------------------------------- búsqueda

class SearchError(RuntimeError):
    """El buscador no contestó. Distinto de que no haya resultados."""


def ddg_results(query: str, limit: int = 12) -> list[dict]:
    """[{url, title}] de DuckDuckGo Lite. Mismo camino que pdf_finder.py.

    Lanza SearchError si no se pudo preguntar: una noche con la red caída no
    puede parecerse a una noche sin leads nuevos.
    """
    url = "https://lite.duckduckgo.com/lite/?" + urllib.parse.urlencode({"q": query})
    req = urllib.request.Request(url, headers=UA)
    try:
        body = urllib.request.urlopen(req, timeout=25).read().decode("utf-8", "ignore")
    except Exception as e:
        raise SearchError(f"{type(e).__name__}: {e}") from e

    out, seen = [], set()
    for m in re.finditer(r'<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', body, re.S):
        href, text = unescape(m.group(1)), re.sub(r"<[^>]+>", "", m.group(2)).strip()
        if "uddg=" in href:                       # DDG envuelve los enlaces
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(href).query)
            href = qs.get("uddg", [href])[0]
        if not href.lower().startswith("http") or not text:
            continue
        if href in seen:
            continue
        seen.add(href)
        out.append({"url": href, "title": unescape(text)[:200]})
        if len(out) >= limit:
            break
    return out


# --------------------------------------------------------------- candidatos

def domain_of(url: str) -> str:
    host = urllib.parse.urlparse(url).netloc.lower()
    return host[4:] if host.startswith("www.") else host


def registrable(domain: str) -> str:
    """Dominio sin subdominios, para que `x.org` y `docs.x.org` sean lo mismo."""
    parts = domain.split(".")
    if len(parts) <= 2:
        return domain
    # dominios de segundo nivel tipo .co.uk, .org.uk
    if len(parts[-2]) <= 3 and parts[-1] in {"uk", "es", "it", "br", "au", "nz", "za"}:
        return ".".join(parts[-3:])
    return ".".join(parts[-2:])


def clean_name(title: str) -> str:
    """El nombre de la organización tal y como lo escribiría una persona."""
    name = TITLE_NOISE.sub("", unescape(title or "")).strip()
    name = re.sub(r"\s*\((?:pdf|doc|es|en)\)\s*$", "", name, flags=re.I)
    name = re.sub(r"\s+", " ", name).strip(" -–—|·:,")
    return name


def is_organisation(candidate: dict) -> bool:
    """Filtros baratos que quitan casi todo el ruido antes de tocar la base."""
    domain = registrable(candidate["domain"])
    if not domain or domain in SKIP_DOMAINS:
        return False
    if any(domain.endswith("." + skip) or domain == skip for skip in SKIP_DOMAINS):
        return False
    name = candidate["organisation"]
    if len(name) < 4 or len(name) > 120:
        return False
    if not re.search(r"[A-Za-zÀ-ÿ]{3}", name):     # títulos que son solo cifras
        return False
    return True


def candidates_from(results: list[dict]) -> list[dict]:
    found: dict[str, dict] = {}
    for r in results:
        domain = domain_of(r["url"])
        name = clean_name(r["title"])
        if not domain or not name:
            continue
        key = registrable(domain)
        entry = {"organisation": name, "domain": domain, "website": f"https://{key}",
                 "source_url": r["url"]}
        if is_organisation(entry) and key not in found:
            found[key] = entry
    return list(found.values())


# ------------------------------------------------------------------- base

def norm_name(name: str) -> str:
    """Mismo criterio que lead_mgr.norm, más la puntuación y los artículos."""
    n = re.sub(r"\s+", " ", (name or "").strip().lower())
    n = re.sub(r"^(the|la|el|les|los|das|der|die|le)\s+", "", n)
    return re.sub(r"[^\w\s]", "", n).strip()


def existing(conn: sqlite3.Connection) -> tuple[set[str], set[str]]:
    names, domains = set(), set()
    for row in conn.execute("SELECT organisation, website, website_domain FROM leads"):
        names.add(norm_name(row[0]))
        for value in (row[2], row[1]):
            if value:
                domains.add(registrable(domain_of(value if "//" in value
                                                  else f"https://{value}")))
                break
    return names, domains


def insert(conn: sqlite3.Connection, candidate: dict, query: str) -> int:
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    timeline = json.dumps([{
        "type": "note", "date": now,
        "text": f"Encontrado por el cazador nocturno · «{query}» · {candidate['source_url']}",
    }], ensure_ascii=False)
    cur = conn.execute(
        """INSERT INTO leads (organisation, website, website_domain, source, status,
                              rationale, timeline)
           VALUES (?, ?, ?, 'agent', 'Not contacted', ?, ?)""",
        (candidate["organisation"], candidate["website"],
         registrable(candidate["domain"]),
         f"Candidato automático de la búsqueda «{query}»", timeline))
    return cur.lastrowid


def record_run(conn: sqlite3.Connection, summary: str, detail: dict) -> None:
    conn.execute("INSERT INTO cron_history (job, summary, detail) VALUES (?, ?, ?)",
                 ("lead_hunter", summary, json.dumps(detail, ensure_ascii=False)))


# ------------------------------------------------------------------- ronda

def hunt(conn: sqlite3.Connection, queries: list[str], limit: int,
         dry_run: bool = False) -> dict:
    names, domains = existing(conn)
    inserted: list[dict] = []
    skipped = {"conocido": 0}
    failed: list[str] = []
    seen_now: set[str] = set()

    for query in queries:
        if len(inserted) >= limit:
            break
        print(f"· {query}")
        try:
            results = ddg_results(query)
        except SearchError as e:
            failed.append(query)
            print(f"  ! búsqueda fallida: {e}", file=sys.stderr)
            continue
        for candidate in candidates_from(results):
            if len(inserted) >= limit:
                break
            key = registrable(candidate["domain"])
            name_key = norm_name(candidate["organisation"])
            if key in seen_now or name_key in names or key in domains:
                skipped["conocido"] += 1
                continue
            seen_now.add(key)

            if dry_run:
                print(f"  + {candidate['organisation']} ({key})")
                inserted.append({**candidate, "id": None})
                continue

            lead_id = insert(conn, candidate, query)
            names.add(name_key)
            domains.add(key)
            inserted.append({**candidate, "id": lead_id})
            print(f"  + [{lead_id}] {candidate['organisation']} ({key})")

        time.sleep(2)                              # no martillear el buscador

    if not dry_run:
        conn.commit()
    return {"inserted": inserted, "skipped": skipped, "failed": failed,
            "queries": queries}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--max", type=int, help="tope de leads nuevos en esta ronda")
    ap.add_argument("--dry-run", action="store_true",
                    help="enseña lo que insertaría, sin tocar la base")
    ap.add_argument("--ignore-pause", action="store_true",
                    help="corre aunque el cazador esté pausado en settings.json")
    a = ap.parse_args()

    settings = load_settings().get("hunter", {})
    queries = settings.get("queries") or []
    limit = a.max or int(settings.get("max_new_leads") or 5)

    # El interruptor de pausa se mira aquí, no en el programador: launchd sigue
    # disparando y la ronda sale sola. Pausar es entonces tocar un fichero, no el
    # sistema, y funciona igual en las dos máquinas.
    if not settings.get("enabled", True) and not a.ignore_pause:
        print("· cazador en pausa (settings.json → hunter.enabled = false)")
        save_state(state="paused")
        return 0

    if not queries:
        print("✗ no hay consultas: define settings.json → hunter.queries", file=sys.stderr)
        return 1

    if not DB.exists():
        print(f"✗ no existe {DB}", file=sys.stderr)
        return 1

    save_state(state="running", queries=len(queries))
    started = time.time()
    conn = sqlite3.connect(DB)
    try:
        report = hunt(conn, queries, limit, dry_run=a.dry_run)
        count, failed = len(report["inserted"]), report["failed"]
        summary = (f"{count} lead(s) nuevo(s) de {len(queries)} búsqueda(s); "
                   f"{report['skipped']['conocido']} ya conocidos")
        if failed:
            summary += f"; {len(failed)} búsqueda(s) fallida(s)"
        if not a.dry_run:
            record_run(conn, summary, report)
            conn.commit()
    except Exception as e:
        save_state(state="error", error=str(e)[:200])
        print(f"✗ {e}", file=sys.stderr)
        return 1
    finally:
        conn.close()

    # ninguna búsqueda llegó a contestar: el buscador está caído o cambió de HTML,
    # y eso hay que verlo, no dejarlo pasar como una noche tranquila
    broken = len(failed) == len(queries)
    save_state(state="error" if broken else "done", inserted=len(report["inserted"]),
               failed=len(failed), seconds=round(time.time() - started, 1))
    print(f"\n{'✗' if broken else '✓'} {summary}" + (" (simulación)" if a.dry_run else ""))
    print(json.dumps({"ok": not broken, "inserted": len(report["inserted"]),
                      "failed_queries": failed,
                      "leads": [{"id": c["id"], "organisation": c["organisation"]}
                                for c in report["inserted"]]}, ensure_ascii=False))
    return 1 if broken else 0


if __name__ == "__main__":
    sys.exit(main())
