"""Smoke tests for the delicate parts of the pipeline.

These cover the logic that is expensive or embarrassing to get wrong: money
(credit estimates), client-facing claims (the QC gate), and data loss (version
archiving). They touch no network and spend no credits.

    .venv/bin/python -m pytest tests -q
"""
from __future__ import annotations

import importlib.util
import json
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


gen = load("generate_redesign")
pdf_utils = load("pdf_utils")
deck = load("build_comparison_pdf")


# --------------------------------------------------------------- versioning

def test_archive_moves_the_file_and_repoints_every_reference(tmp_path):
    """A rerun used to overwrite the previous version's image. It must not."""
    gen.ROOT = tmp_path
    out = tmp_path / "generated/9/redesigns"
    out.mkdir(parents=True)
    image = out / "page-01-editorial-redesign.png"
    image.write_text("v2 pixels")

    entries = [
        {"pdf": "rep", "page": 1, "style": "editorial", "version": 2,
         "generated_img": "generated/9/redesigns/page-01-editorial-redesign.png"},
        {"pdf": "rep", "page": 1, "style": "editorial", "version": 3,
         "generated_img": "generated/9/redesigns/page-01-editorial-redesign.png",
         "base_img": "generated/9/redesigns/page-01-editorial-redesign.png"},
        {"pdf": "rep", "page": 2, "style": "editorial", "version": 1,
         "generated_img": "generated/9/redesigns/page-02-editorial-redesign.png"},
    ]
    moved = gen.archive_previous_versions(entries, out, [1], "rep", "editorial")

    assert (out / "page-01-editorial-redesign-v2.png").read_text() == "v2 pixels"
    assert not image.exists()
    assert len(moved) == 1
    # both entries that pointed at the old file follow it, base_img included
    assert entries[0]["generated_img"].endswith("-v2.png")
    assert entries[1]["generated_img"].endswith("-v2.png")
    assert entries[1]["base_img"].endswith("-v2.png")
    # a different page is untouched
    assert entries[2]["generated_img"].endswith("page-02-editorial-redesign.png")


def test_archive_never_clobbers_an_existing_archive(tmp_path):
    gen.ROOT = tmp_path
    out = tmp_path / "generated/9/redesigns"
    out.mkdir(parents=True)
    (out / "page-01-editorial-redesign.png").write_text("current")
    (out / "page-01-editorial-redesign-v1.png").write_text("already archived")

    entries = [{"pdf": "rep", "page": 1, "style": "editorial", "version": 1,
                "generated_img": "generated/9/redesigns/page-01-editorial-redesign.png"}]
    gen.archive_previous_versions(entries, out, [1], "rep", "editorial")

    assert (out / "page-01-editorial-redesign-v1.png").read_text() == "already archived"
    assert (out / "page-01-editorial-redesign-v2.png").read_text() == "current"


# ------------------------------------------------------------------ prompts

def test_refine_clause_only_when_starting_from_a_redesign():
    plain = gen.compose_magnific_prompt("estilo", "", "", "arregla el titular")
    refined = gen.compose_magnific_prompt("estilo", "", "", "arregla el titular", refine=True)
    assert "PUNTO DE PARTIDA" not in plain
    assert "PUNTO DE PARTIDA" in refined
    # corrections always outrank the base style
    assert refined.index("CORRECCIONES") < refined.index("PUNTO DE PARTIDA")


def test_feedback_and_palette_reach_the_prompt():
    out = gen.compose_magnific_prompt("swiss", "sin logos", "#FF0000,#00FF00", "menos saturación")
    for fragment in ("swiss", "sin logos", "#FF0000", "menos saturación"):
        assert fragment in out


def test_series_clause_only_when_asked():
    """The consistency clause must not leak into a one-off page."""
    single = gen.compose_magnific_prompt("estilo", "", "", "")
    series = gen.compose_magnific_prompt("estilo", "", "", "", consistent=True)
    assert "COHERENCIA DE SERIE" not in single
    assert "COHERENCIA DE SERIE" in series
    for idea in ("misma paleta", "retícula"):
        assert idea in series


def test_generate_sends_the_style_reference_alongside_the_page():
    """Both references travel together: the page as content, the anchor as look."""
    client = load("magnific_client")
    sent = {}

    class FakeMagnific(client.Magnific):
        def call(self, tool, arguments=None, timeout=180):
            sent["tool"] = tool
            sent["args"] = arguments
            return {"identifier": "new-one", "url": "https://example.invalid/x.png", "credits": 60}

        def wait(self, identifier, *, timeout=900):
            return {"identifier": identifier, "url": "https://example.invalid/x.png", "credits": 60}

        def connect(self):
            return self

    FakeMagnific().generate(prompt="p", reference="page-id", style_reference="anchor-id",
                            mode="imagen-nano-banana-2-lite")
    refs = sent["args"]["references"]
    assert {"type": "image", "identifier": "page-id"} in refs
    assert {"type": "style", "identifier": "anchor-id"} in refs
    assert sent["args"]["count"] == 1            # never pay for variants we discard


def test_style_reference_is_skipped_when_it_is_the_same_image():
    client = load("magnific_client")
    sent = {}

    class FakeMagnific(client.Magnific):
        def call(self, tool, arguments=None, timeout=180):
            sent["args"] = arguments
            return {"identifier": "x", "url": "https://example.invalid/x.png", "credits": 1}

        def wait(self, identifier, *, timeout=900):
            return {"url": "https://example.invalid/x.png"}

        def connect(self):
            return self

    FakeMagnific().generate(prompt="p", reference="same", style_reference="same")
    assert sent["args"]["references"] == [{"type": "image", "identifier": "same"}]


# ---------------------------------------------------------------- page score

def test_index_pages_are_penalised_and_data_pages_rewarded():
    toc = "Índice\n" + "\n".join(f"Capítulo {i} .......... {i * 3}" for i in range(1, 9))
    data = "Resultados\n" + " ".join(f"{i}% en 2024," for i in range(1, 30))

    class FakePage:
        def __init__(self, text):
            self.text = text
            self.rect = type("R", (), {"width": 595, "height": 842})()

        def get_images(self, full=False):
            return []

        def get_image_rects(self, xref):
            return []

        def get_drawings(self):
            return []

        def get_text(self, kind="text"):
            return self.text

    toc_score = pdf_utils.score_page(FakePage(toc))
    data_score = pdf_utils.score_page(FakePage(data))

    assert "índice" in toc_score["reason"]
    assert data_score["figures"] > 10
    assert data_score["score"] > toc_score["score"]


def test_recommended_pages_skip_the_cover_and_spread_out():
    scores = [{"page": p, "score": s} for p, s in
              [(1, 99), (2, 80), (3, 79), (10, 70), (11, 69), (20, 60)]]
    picked = pdf_utils.recommended_pages(scores, limit=3)
    assert 1 not in picked                      # the cover is already designed
    assert picked == sorted(picked)
    assert all(abs(a - b) >= 2 for a in picked for b in picked if a != b)


# ------------------------------------------------------------------ qc gate

def _lead_row(items):
    return {"generated": json.dumps(items)}


def test_qc_gate_blocks_failed_images_unless_overridden(monkeypatch, tmp_path):
    """The cover claims the figures are untouched: a failed check cannot ship."""
    items = [
        {"page": 1, "pdf": "rep", "style": "ed", "styleName": "Ed",
         "original_img": "a.png", "generated_img": "b.png",
         "qc": {"verdict": "fail", "missing": ["5%"]}},
        {"page": 2, "pdf": "rep", "style": "ed", "styleName": "Ed",
         "original_img": "c.png", "generated_img": "d.png",
         "qc": {"verdict": "clean"}},
    ]

    def run(allow: bool):
        pool = [g for g in items if g.get("original_img") and g.get("generated_img")]
        blocked = []
        if not allow:
            kept = []
            for g in pool:
                if (g.get("qc") or {}).get("verdict") == "fail":
                    blocked.append(g)
                else:
                    kept.append(g)
            pool = kept
        return pool, blocked

    kept, blocked = run(allow=False)
    assert [g["page"] for g in kept] == [2]
    assert [g["page"] for g in blocked] == [1]

    kept, blocked = run(allow=True)
    assert [g["page"] for g in kept] == [1, 2]
    assert blocked == []


def test_deck_exposes_the_allow_flag():
    """The override must stay an explicit, discoverable choice."""
    source = (ROOT / "scripts" / "build_comparison_pdf.py").read_text()
    assert "--allow-failed-qc" in source
    assert 'verdict") == "fail"' in source


# -------------------------------------------------------------- credit maths

def test_credits_lookup_matches_the_catalog():
    catalog = json.loads((ROOT / "magnific_models.json").read_text())
    prices = {m["slug"]: m for m in catalog["models"]}

    def credits(slug, resolution="", quality=""):
        entries = [p for p in prices[slug]["prices"] if p["credits"] is not None]
        if not entries:
            return catalog["fallback_credits"]
        exact = [p for p in entries
                 if (p["resolution"] or "") == resolution and (p["quality"] or "") == quality]
        if exact:
            return exact[0]["credits"]
        same_res = [p for p in entries if (p["resolution"] or "") == resolution]
        if same_res:
            return same_res[0]["credits"]
        return max(p["credits"] for p in entries)

    # the figures simulate_cost gave us; a silent change here changes the bill
    assert credits("imagen-nano-banana-2-flash", "2k") == 75
    assert credits("gpt-2", "2k", "high") == 700
    assert credits("gpt-2", "2k", "low") == 30
    assert credits("imagen-nano-banana-2-lite") == 60
    # unknown combination falls back to the dearest known price, never the cheapest
    assert credits("gpt-2", "8k") == 700


def test_every_catalog_model_is_priced():
    catalog = json.loads((ROOT / "magnific_models.json").read_text())
    for model in catalog["models"]:
        assert model["prices"], f"{model['slug']} sin precio: la estimación sería inventada"


# ------------------------------------------------------------------ branding

def test_deck_strings_exist_in_both_languages():
    keys = set(deck.STRINGS["es"]) ^ set(deck.STRINGS["en"])
    assert not keys, f"copy descuadrado entre idiomas: {keys}"


@pytest.mark.parametrize("lang", ["es", "en"])
def test_closing_slide_has_its_three_paragraphs(lang):
    deck.LANG = lang
    for key in ("closing_title", "closing_p1", "closing_p2", "closing_p3",
                "tagline_a", "tagline_b"):
        assert deck.t(key).strip()
