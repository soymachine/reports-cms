#!/usr/bin/env python3
"""dedupe.py — find leads that are the same organisation entered twice.

The nightly agent inserts leads on its own, so duplicates cannot be prevented
at the door — they have to be detected after the fact. Two signals:

  1. Same normalised web domain  → almost certainly the same organisation.
  2. Similar normalised name     → "EUROFER" vs "EUROFER - European Steel
     Association" vs "Eurofer AISBL".

Nothing is deleted here: clusters are reported (and optionally flagged via
leads.duplicate_of) for a human to merge from the dashboard.

Usage:
  python3 dedupe.py [--flag] [--threshold 0.86]
Output: JSON {"ok": true, "clusters": [[id, ...]], "detail": [...]}
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
import urllib.parse
from difflib import SequenceMatcher
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "leads.db"

# words that carry no identity: dropping them makes the comparison meaningful
STOPWORDS = {
    "the", "of", "and", "for", "european", "europe", "eu", "international",
    "association", "federation", "confederation", "union", "council", "committee",
    "organisation", "organization", "group", "network", "alliance", "society",
    "institute", "foundation", "centre", "center", "agency", "board", "forum",
    "aisbl", "asbl", "ltd", "limited", "inc", "gmbh", "bv", "nv", "sa", "sl",
    "industry", "industries", "sector", "trade", "body",
}


def normalise_domain(website: str | None) -> str:
    if not website:
        return ""
    raw = website.strip()
    if not raw.lower().startswith(("http://", "https://")):
        raw = "https://" + raw
    host = urllib.parse.urlparse(raw).netloc.lower()
    host = host.split("@")[-1].split(":")[0]
    if host.startswith("www."):
        host = host[4:]
    # drop a leading subdomain that is not part of the identity
    parts = host.split(".")
    if len(parts) > 2 and parts[0] in {"en", "www2", "web", "info", "home", "publications"}:
        host = ".".join(parts[1:])
    return host


def name_key(name: str | None) -> str:
    """Identity-bearing words only, sorted, lowercased."""
    if not name:
        return ""
    txt = re.sub(r"[^\w\s-]", " ", name.lower())
    txt = re.sub(r"\s+", " ", txt)
    words = [w for w in txt.replace("-", " ").split() if w and w not in STOPWORDS]
    return " ".join(sorted(words))


def similar(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    return SequenceMatcher(None, a, b).ratio()


def find_clusters(rows: list[sqlite3.Row], threshold: float = 0.86) -> list[dict]:
    entries = []
    for r in rows:
        entries.append({
            "id": r["id"],
            "organisation": r["organisation"],
            "domain": normalise_domain(r["website"]),
            "key": name_key(r["organisation"]),
            "created_at": r["created_at"],
            "source": r["source"],
            "pdfs": len(json.loads(r["pdfs"] or "[]")),
        })

    parent = {e["id"]: e["id"] for e in entries}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)

    reasons: dict[tuple[int, int], str] = {}

    # same domain → same organisation
    by_domain: dict[str, list[int]] = {}
    for e in entries:
        if e["domain"]:
            by_domain.setdefault(e["domain"], []).append(e["id"])
    for domain, ids in by_domain.items():
        for other in ids[1:]:
            union(ids[0], other)
            reasons[(min(ids[0], other), max(ids[0], other))] = f"mismo dominio ({domain})"

    # similar names
    for i, e1 in enumerate(entries):
        for e2 in entries[i + 1:]:
            if not e1["key"] or not e2["key"]:
                continue
            if find(e1["id"]) == find(e2["id"]):
                continue
            ratio = similar(e1["key"], e2["key"])
            if ratio >= threshold:
                union(e1["id"], e2["id"])
                reasons[(min(e1["id"], e2["id"]), max(e1["id"], e2["id"]))] = f"nombre similar ({ratio:.0%})"

    groups: dict[int, list[dict]] = {}
    for e in entries:
        groups.setdefault(find(e["id"]), []).append(e)

    clusters = []
    for root, members in groups.items():
        if len(members) < 2:
            continue
        members.sort(key=lambda m: m["id"])
        why = [reasons[k] for k in reasons if k[0] in {m["id"] for m in members} and k[1] in {m["id"] for m in members}]
        clusters.append({
            "keep": members[0]["id"],                 # oldest id wins by default
            "members": members,
            "reasons": sorted(set(why)),
        })
    clusters.sort(key=lambda c: -len(c["members"]))
    return clusters


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--threshold", type=float, default=0.86)
    ap.add_argument("--flag", action="store_true", help="write leads.duplicate_of for the extra members")
    a = ap.parse_args()

    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT * FROM leads").fetchall()
    clusters = find_clusters(rows, a.threshold)

    if a.flag:
        conn.execute("UPDATE leads SET duplicate_of = NULL")
        for c in clusters:
            for m in c["members"][1:]:
                conn.execute("UPDATE leads SET duplicate_of = ? WHERE id = ?", (c["keep"], m["id"]))
        conn.commit()

    # keep the domain cache fresh: it is the dedupe key and the funnel groups by it
    for r in rows:
        conn.execute("UPDATE leads SET website_domain = ? WHERE id = ?", (normalise_domain(r["website"]), r["id"]))
    conn.commit()
    conn.close()

    print(json.dumps({"ok": True, "clusters": len(clusters), "detail": clusters}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
