import json
import urllib.parse
from pathlib import Path

import pytest

from seocockpit.cwv import (
    CwvSnapshot,
    _is_crux_not_found_error,
    _parse_psi_response,
    fetch_cwv,
)

FIXTURES_DIR = Path(__file__).resolve().parent
URL = "https://example.com/"

# Lighthouse category scores from fixture_psi_response.json, already scaled
# from PSI's 0-1 floats to the 0-100 the DB stores.
FIXTURE_CATEGORIES = {
    "lh_performance": 88.0,
    "lh_accessibility": 92.0,
    "lh_best_practices": 100.0,
    "lh_seo": 91.0,
}

NO_CATEGORIES = {
    "lh_performance": None,
    "lh_accessibility": None,
    "lh_best_practices": None,
    "lh_seo": None,
}


def _load_fixture(name: str) -> dict:
    with open(FIXTURES_DIR / name, "r", encoding="utf-8") as f:
        return json.load(f)


def _psi_response(categories: dict) -> dict:
    """A minimal PSI response with usable lab metrics and ``categories``."""
    return {
        "lighthouseResult": {
            "audits": {
                "largest-contentful-paint": {"numericValue": 1000.0},
                "cumulative-layout-shift": {"numericValue": 0.01},
            },
            "categories": categories,
        }
    }


# ---------------------------------------------------------------------------
# Lighthouse category parsing
# ---------------------------------------------------------------------------


def test_parse_psi_response_extracts_all_four_lighthouse_categories():
    result = _parse_psi_response(URL, _load_fixture("fixture_psi_response.json"))

    assert result.lh_performance == 88.0
    assert result.lh_accessibility == 92.0
    assert result.lh_best_practices == 100.0
    assert result.lh_seo == 91.0


def test_parse_psi_response_distinguishes_a_missing_category_from_a_zero_score():
    """NULL means "not fetched"; 0 is a legitimate Lighthouse score. If these
    collapsed, a category PSI failed to run would render as a total failure.
    """
    result = _parse_psi_response(
        URL,
        _psi_response(
            {
                "performance": {"score": 0},
                # accessibility deliberately absent from the response
                "best-practices": {"score": None},  # present but unscored
                "seo": {"score": 0.5},
            }
        ),
    )

    assert result.lh_performance == 0.0
    assert result.lh_accessibility is None
    assert result.lh_best_practices is None
    assert result.lh_seo == 50.0
    assert result.lh_performance != result.lh_accessibility


def test_parse_psi_response_without_categories_yields_none_not_zero():
    result = _parse_psi_response(
        URL,
        {
            "lighthouseResult": {
                "audits": {"largest-contentful-paint": {"numericValue": 1000.0}}
            }
        },
    )

    assert result.lh_performance is None
    assert result.lh_seo is None


# ---------------------------------------------------------------------------
# fetch_cwv: PSI is called unconditionally
# ---------------------------------------------------------------------------


def test_fetch_cwv_calls_psi_even_when_crux_has_field_data():
    """Before 11d a CrUX hit short-circuited PSI, so Lighthouse categories
    silently vanished from a site exactly when it grew enough to earn CrUX
    field data. Field metrics still prefer CrUX; categories always come
    from PSI.
    """
    crux_fixture = _load_fixture("fixture_crux_response.json")
    psi_calls = []

    def psi_query(url):
        psi_calls.append(url)
        return _load_fixture("fixture_psi_response.json")

    result = fetch_cwv(
        URL,
        crux_query=lambda url: crux_fixture["record"],
        psi_query=psi_query,
    )

    assert psi_calls == [URL]
    assert result == CwvSnapshot(
        url=URL,
        # Field metrics from CrUX, unchanged by the PSI call.
        lcp_p75=2500.0,
        inp_p75=180.0,
        cls_p75=0.05,
        source="crux",
        form_factor="PHONE",
        **FIXTURE_CATEGORIES,
    )


def test_fetch_cwv_parses_crux_record_into_snapshot():
    fixture = _load_fixture("fixture_crux_response.json")

    def crux_query(url):
        assert url == URL
        return fixture["record"]

    result = fetch_cwv(URL, crux_query=crux_query, psi_query=lambda url: None)

    assert result == CwvSnapshot(
        url=URL,
        lcp_p75=2500.0,
        inp_p75=180.0,
        cls_p75=0.05,
        source="crux",
        form_factor="PHONE",
        **NO_CATEGORIES,
    )
    assert isinstance(result.cls_p75, float)


def test_fetch_cwv_keeps_crux_field_data_when_psi_fails():
    """PSI is slow and flaky, and 11d roughly doubles how often it is called.
    A PSI failure must not throw away field data CrUX already returned --
    the categories are simply "not fetched".
    """

    def psi_query(url):
        raise RuntimeError("PSI timed out")

    fixture = _load_fixture("fixture_crux_response.json")
    result = fetch_cwv(
        URL, crux_query=lambda url: fixture["record"], psi_query=psi_query
    )

    assert result.source == "crux"
    assert result.lcp_p75 == 2500.0
    assert result.lh_performance is None


def test_fetch_cwv_propagates_psi_errors_when_crux_has_nothing_to_salvage():
    def psi_query(url):
        raise RuntimeError("PSI timed out")

    with pytest.raises(RuntimeError, match="PSI timed out"):
        fetch_cwv(URL, crux_query=lambda url: None, psi_query=psi_query)


def test_fetch_cwv_returns_none_when_no_data_anywhere():
    result = fetch_cwv(URL, crux_query=lambda url: None, psi_query=lambda url: None)

    assert result is None


def test_fetch_cwv_falls_back_to_psi_when_crux_has_no_data():
    fixture = _load_fixture("fixture_psi_response.json")

    def psi_query(url):
        assert url == URL
        return fixture

    result = fetch_cwv(URL, crux_query=lambda url: None, psi_query=psi_query)

    assert result == CwvSnapshot(
        url=URL,
        lcp_p75=1834.2,
        inp_p75=None,
        cls_p75=0.021,
        source="psi",
        form_factor="PHONE",
        **FIXTURE_CATEGORIES,
    )


def test_fetch_cwv_returns_none_when_crux_and_psi_both_have_no_usable_data():
    result = fetch_cwv(
        URL,
        crux_query=lambda url: None,
        psi_query=lambda url: {"lighthouseResult": {"audits": {}}},
    )

    assert result is None


def test_fetch_cwv_missing_crux_metric_is_none_but_others_still_parse():
    record = {
        "metrics": {
            "largest_contentful_paint": {"percentiles": {"p75": 2200}},
            "cumulative_layout_shift": {"percentiles": {"p75": "0.1"}},
            # interaction_to_next_paint deliberately absent
        }
    }

    result = fetch_cwv(URL, crux_query=lambda url: record, psi_query=lambda url: None)

    assert result == CwvSnapshot(
        url=URL,
        lcp_p75=2200.0,
        inp_p75=None,
        cls_p75=0.1,
        source="crux",
        form_factor="PHONE",
        **NO_CATEGORIES,
    )


def test_fetch_cwv_propagates_non_none_signaling_errors():
    def crux_query(url):
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError, match="boom"):
        fetch_cwv(URL, crux_query=crux_query, psi_query=lambda url: None)


# ---------------------------------------------------------------------------
# to_db_row
# ---------------------------------------------------------------------------


def test_to_db_row_carries_the_lighthouse_categories():
    snapshot = CwvSnapshot(
        url=URL,
        lcp_p75=2500.0,
        inp_p75=180.0,
        cls_p75=0.05,
        source="crux",
        form_factor="PHONE",
        **FIXTURE_CATEGORIES,
    )

    row = snapshot.to_db_row("sc-domain:example.com", "2026-07-25T00:00:00+00:00")

    assert row["lh_performance"] == 88.0
    assert row["lh_accessibility"] == 92.0
    assert row["lh_best_practices"] == 100.0
    assert row["lh_seo"] == 91.0


# ---------------------------------------------------------------------------
# CrUX 404 detection
# ---------------------------------------------------------------------------


def test_is_crux_not_found_error_detects_the_data_not_found_message():
    fixture = _load_fixture("fixture_crux_not_found.json")

    assert _is_crux_not_found_error(json.dumps(fixture))
    assert _is_crux_not_found_error(json.dumps(fixture).encode("utf-8"))


def test_is_crux_not_found_error_false_for_genuine_errors():
    other_error = json.dumps({"error": {"code": 403, "message": "API key not valid"}})

    assert not _is_crux_not_found_error(other_error)


# ---------------------------------------------------------------------------
# The PSI request itself
# ---------------------------------------------------------------------------


def test_default_psi_query_asks_for_all_four_lighthouse_categories(monkeypatch):
    """PSI runs ONLY the performance category unless the others are named.

    This is the request half of the Lighthouse feature and it was missing:
    the parser handled four categories while the query asked for one, so
    accessibility/best-practices/seo were always None on real data. The
    fixture happened to contain all four, so nothing caught it until a real
    collection run wrote three NULL columns.
    """
    import urllib.request

    from seocockpit.cwv import _default_psi_query

    seen = {}

    class _FakeResponse:
        def read(self):
            return b'{"lighthouseResult": {"audits": {}, "categories": {}}}'

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    def fake_urlopen(url, *args, **kwargs):
        seen["url"] = url
        return _FakeResponse()

    monkeypatch.setenv("GOOGLE_API_KEY", "test-key")
    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr("json.load", lambda f: {"lighthouseResult": {}})

    _default_psi_query("https://example.com/")

    requested = urllib.parse.parse_qs(urllib.parse.urlparse(seen["url"]).query)
    assert sorted(requested["category"]) == [
        "accessibility",
        "best-practices",
        "performance",
        "seo",
    ]
    assert requested["strategy"] == ["mobile"]
