#!/usr/bin/env python3
"""pdf_finder.py — find & download report PDFs for a lead.

Two sources, in order of quality:
  1. The lead's own website — publication hubs (/publications, /reports, …)
     and its sitemap. This is where the real reports live.
  2. DuckDuckGo Lite, as a fallback when the site yields nothing.

Every downloaded file is checked with pdf_utils.report_quality(): short
documents, forms and text-only press releases are rejected and deleted, so
render and Magnific credits are never spent on something that is not a report.

Usage:
  python3 pdf_finder.py <lead_id> [--max 3] [--min-pages 8] [--no-crawl] [--job-id N]
Output: JSON {"ok": true, "found": N, "pdfs": [{file, url, title, pages, published_at}]}
"""
import argparse
import datetime
import json
import html
import re
import sqlite3
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from html import unescape
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pdf_utils import published_date, report_quality  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "leads.db"
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"}


def ddg_pdf_links(query: str, limit: int = 8) -> list[dict]:
    """Return [{url, title}] of PDF links from DuckDuckGo Lite."""
    url = "https://lite.duckduckgo.com/lite/?" + urllib.parse.urlencode({"q": query})
    req = urllib.request.Request(url, headers=UA)
    try:
        html = urllib.request.urlopen(req, timeout=20).read().decode("utf-8", "ignore")
    except Exception as e:
        print(f"search error: {e}", file=sys.stderr)
        return []
    results = []
    # lite.duckduckgo.com wraps result links; extract href + anchor text
    for m in re.finditer(r'<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', html, re.S):
        href, text = unescape(m.group(1)), re.sub(r"<[^>]+>", "", m.group(2)).strip()
        # DDG redirect links: /l/?uddg=<urlencoded>
        if "uddg=" in href:
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(href).query)
            href = qs.get("uddg", [href])[0]
        if not href.lower().startswith("http"):
            continue
        if ".pdf" not in href.lower():
            continue
        results.append({"url": href, "title": text[:200]})
        if len(results) >= limit:
            break
    # dedupe by url
    seen, out = set(), []
    for r in results:
        if r["url"] not in seen:
            seen.add(r["url"])
            out.append(r)
    return out



# ----------------------------------------------------------------- site crawl

# where organisations actually publish their reports
HUB_PATHS = [
    "", "/publications", "/publication", "/reports", "/report", "/resources",
    "/media", "/news", "/insights", "/library", "/knowledge", "/documents",
    "/press", "/data", "/studies", "/downloads", "/about/publications",
]

REPORT_HINTS = re.compile(
    r"report|annual|outlook|review|study|monitor|statistic|insight|barometer|"
    r"whitepaper|white-paper|yearbook|memoria|informe|anuario|estudio",
    re.I,
)


def fetch(url: str, timeout: int = 20) -> str:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        ctype = r.headers.get("Content-Type", "")
        if "html" not in ctype.lower() and "xml" not in ctype.lower():
            return ""
        return r.read(3 * 1024 * 1024).decode("utf-8", "ignore")


def pdf_links_from_html(page_url: str, body: str) -> list[dict]:
    """Absolute .pdf links plus their anchor text."""
    out = []
    for m in re.finditer(r'<a[^>]+href="([^"#]+)"[^>]*>(.*?)</a>', body, re.S | re.I):
        href = unescape(m.group(1)).strip()
        text = re.sub(r"<[^>]+>", " ", m.group(2))
        text = re.sub(r"\s+", " ", unescape(text)).strip()
        if ".pdf" not in href.lower():
            continue
        out.append({"url": urllib.parse.urljoin(page_url, href), "title": text[:200]})
    return out


def crawl_site_for_pdfs(domain: str, limit: int = 40) -> list[dict]:
    """Walk the lead's own publication pages and sitemap looking for PDFs."""
    if not domain:
        return []
    base = f"https://{domain}"
    found, seen = [], set()

    for path_ in HUB_PATHS:
        if len(found) >= limit:
            break
        try:
            body = fetch(base + path_)
        except Exception:
            continue
        if not body:
            continue
        for link in pdf_links_from_html(base + path_, body):
            if link["url"] in seen:
                continue
            seen.add(link["url"])
            found.append(link)
        time.sleep(0.4)  # stay polite on the lead's own server

    # sitemap often lists PDFs the hub pages do not link directly
    for sm in ("/sitemap.xml", "/sitemap_index.xml"):
        if len(found) >= limit:
            break
        try:
            body = fetch(base + sm)
        except Exception:
            continue
        for m in re.finditer(r"<loc>\s*([^<\s]+\.pdf)\s*</loc>", body, re.I):
            url = unescape(m.group(1))
            if url not in seen:
                seen.add(url)
                found.append({"url": url, "title": Path(urllib.parse.urlparse(url).path).stem.replace("-", " ")[:200]})

    # reports first: a URL or link text that talks like a report wins
    found.sort(key=lambda c: 0 if REPORT_HINTS.search(c["url"] + " " + c["title"]) else 1)
    return found[:limit]


def download_pdf(url: str, dest: Path, max_mb: int = 60) -> bool:
    try:
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=45) as r:
            ctype = r.headers.get("Content-Type", "")
            data = r.read(max_mb * 1024 * 1024)
        if not data.startswith(b"%PDF"):
            # some servers lie about content-type; require real PDF magic
            if "pdf" not in ctype.lower() or not data[:1024].find(b"%PDF") >= 0:
                return False
        dest.write_bytes(data)
        return True
    except Exception as e:
        print(f"download error {url}: {e}", file=sys.stderr)
        return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("lead_id", type=int)
    ap.add_argument("--max", type=int, default=3)
    ap.add_argument("--min-pages", type=int, default=8, help="reject PDFs shorter than this")
    ap.add_argument("--no-crawl", action="store_true", help="skip the site crawl, search engine only")
    ap.add_argument("--job-id", type=int, default=0, help="jobs row to report progress into")
    a = ap.parse_args()

    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT * FROM leads WHERE id = ?", (a.lead_id,)).fetchone()
    if not row:
        print(json.dumps({"ok": False, "error": "lead not found"}))
        return 1
    org, website = row["organisation"], row["website"] or ""
    domain = ""
    if website:
        parsed = urllib.parse.urlparse(website if website.startswith("http") else f"https://{website}")
        domain = parsed.netloc.replace("www.", "")

    candidates, seen = [], set()

    # 1) the lead's own site — highest quality source
    if domain and not a.no_crawl:
        for c in crawl_site_for_pdfs(domain):
            if c["url"] not in seen:
                seen.add(c["url"])
                c["source"] = "site"
                candidates.append(c)

    # 2) search engine fallback
    if len(candidates) < a.max * 3:
        queries = [f'"{org}" report filetype:pdf',
                   f'"{org}" annual report OR industry report filetype:pdf']
        if domain:
            queries.insert(0, f"site:{domain} report filetype:pdf")
        for q in queries:
            for r in ddg_pdf_links(q):
                if r["url"] not in seen:
                    seen.add(r["url"])
                    r["source"] = "search"
                    candidates.append(r)
            time.sleep(1.5)  # be polite with DDG
            if len(candidates) >= a.max * 4:
                break

    dest_dir = ROOT / "pdfs" / str(a.lead_id)
    dest_dir.mkdir(parents=True, exist_ok=True)
    existing = json.loads(row["pdfs"] or "[]")
    downloaded, rejected = [], []

    for c in candidates:
        if len(downloaded) >= a.max:
            break
        if any(p.get("url") == c["url"] for p in existing):
            continue
        fname = re.sub(r"[^A-Za-z0-9._-]+", "_", c["url"].split("/")[-1].split("?")[0])[:80]
        if not fname.lower().endswith(".pdf"):
            fname += ".pdf"
        dest = dest_dir / fname
        if not download_pdf(c["url"], dest):
            continue

        # quality gate: a real report, not a form or a two-page press release
        quality = report_quality(dest, min_pages=a.min_pages)
        if not quality.get("ok"):
            rejected.append({"url": c["url"], "reason": quality.get("reason", "descartado")})
            dest.unlink(missing_ok=True)
            continue

        slug = re.sub(r"[^A-Za-z0-9_-]+", "_", Path(fname).stem).strip("_")[:60]
        entry = {
            "file": f"pdfs/{a.lead_id}/{fname}",
            "slug": slug,
            "url": c["url"],
            "title": html.unescape(c["title"] or fname),
            "downloaded_at": datetime.datetime.now().isoformat(),
            "source": c.get("source", "search"),
            "pages": quality.get("pages"),
            "visual_ratio": quality.get("visual_ratio"),
            "published_at": published_date(dest, c["title"]),
        }
        existing.append(entry)
        downloaded.append(entry)

    conn.execute("UPDATE leads SET pdfs = ?, updated_at = datetime('now') WHERE id = ?",
                 (json.dumps(existing, ensure_ascii=False), a.lead_id))

    # newest publication date across all this lead's reports drives the timing radar
    dates = [p.get("published_at") for p in existing if p.get("published_at")]
    if dates:
        conn.execute("UPDATE leads SET report_published_at = ? WHERE id = ?", (max(dates), a.lead_id))

    tl = json.loads(row["timeline"] or "[]")
    detail = f"Búsqueda de PDFs: {len(downloaded)} descargados de {len(candidates)} candidatos"
    if rejected:
        detail += f"; {len(rejected)} descartados por calidad"
    tl.append({"type": "pdf_search", "text": detail, "date": datetime.datetime.now().isoformat()})
    conn.execute("UPDATE leads SET timeline = ? WHERE id = ?", (json.dumps(tl, ensure_ascii=False), a.lead_id))

    result = {"ok": True, "found": len(downloaded), "candidates": len(candidates),
              "rejected": rejected, "pdfs": downloaded}

    if a.job_id:
        conn.execute(
            "UPDATE jobs SET state = 'done', result = ?, finished_at = datetime('now') WHERE id = ?",
            (json.dumps(result, ensure_ascii=False), a.job_id),
        )
    conn.commit()
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
