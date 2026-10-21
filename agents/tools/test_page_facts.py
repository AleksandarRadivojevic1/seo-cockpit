"""Run: python3 -m pytest agents/tools/test_page_facts.py"""

import json

from page_facts import facts_from_html, main

PAGE = """<!doctype html><html lang="sr-Latn"><head>
<title>  Optika Cajs | Naočare  Leskovac </title>
<meta name="description" content="Dioptrijske naočare i sočiva u Leskovcu.">
<link rel="canonical" href="/">
<link rel="alternate" hreflang="en" href="/en/">
<style>.x{color:red}</style>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Optician"},{"@type":["WebSite","Thing"]}]}</script>
<script>var tracking = "not visible text";</script>
</head><body>
<h1>Optika u <em>Leskovcu</em></h1>
<p>Pregled vida i izrada naočara.</p>
<h2>Sočiva</h2>
<a href="/sociva/">Kontaktna sočiva</a>
<a href="https://instagram.com/optikacajs">Instagram</a>
<a href="mailto:info@optikacajs.rs">Email</a>
<img src="a.jpg" alt="Naočare"><img src="b.jpg"><img src="c.jpg" alt=" ">
</body></html>"""


def test_extracts_the_facts_a_recommendation_needs():
    f = facts_from_html(PAGE, "https://optikacajs.rs/", 200)
    assert f["title"] == "Optika Cajs | Naočare Leskovac"
    assert f["titleLength"] == len("Optika Cajs | Naočare Leskovac")
    assert f["metaDescription"] == "Dioptrijske naočare i sočiva u Leskovcu."
    assert f["canonical"] == "https://optikacajs.rs/"
    assert f["hreflang"] == [{"lang": "en", "href": "https://optikacajs.rs/en/"}]
    assert f["lang"] == "sr-Latn"
    assert f["headings"] == [
        {"level": "h1", "text": "Optika u Leskovcu"},
        {"level": "h2", "text": "Sočiva"},
    ]
    assert f["h1Count"] == 1
    assert f["internalLinks"] == [{"href": "https://optikacajs.rs/sociva/", "anchor": "Kontaktna sočiva"}]
    assert f["externalLinkCount"] == 1  # mailto is not a link to another site
    assert (f["images"], f["imagesMissingAlt"]) == (3, 2)  # whitespace alt is missing alt
    assert f["schemaTypes"] == ["Optician", "Thing", "WebSite"]


def test_keeps_scripts_and_styles_out_of_the_text():
    f = facts_from_html(PAGE, "https://optikacajs.rs/")
    assert "tracking" not in f["textExcerpt"]
    assert "color:red" not in f["textExcerpt"]
    assert "Pregled vida" in f["textExcerpt"]


def test_reports_absent_facts_as_null_not_empty():
    f = facts_from_html("<html><body><p>hi</p></body></html>", "https://x.rs/")
    assert f["title"] is None and f["titleLength"] is None
    assert f["metaDescription"] is None and f["metaDescriptionLength"] is None
    assert f["canonical"] is None and f["robots"] is None and f["lang"] is None
    assert f["h1Count"] == 0


def test_cli_reads_a_saved_file(tmp_path, capsys):
    p = tmp_path / "page.html"
    p.write_text(PAGE, encoding="utf-8")
    assert main(["--file", str(p), "--url", "https://optikacajs.rs/"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["title"].startswith("Optika Cajs")
