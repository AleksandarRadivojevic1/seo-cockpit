import json
from pathlib import Path

from seocockpit.cwv import CwvSnapshot, _is_crux_not_found_error, fetch_cwv

FIXTURES_DIR = Path(__file__).resolve().parent
URL = "https://example.com/"


def _load_fixture(name: str) -> dict:
    with open(FIXTURES_DIR / name, "r", encoding="utf-8") as f:
        return json.load(f)


def test_fetch_cwv_parses_crux_record_into_snapshot():
    fixture = _load_fixture("fixture_crux_response.json")

    def crux_query(url):
        assert url == URL
        return fixture["record"]

    def psi_query(url):
        raise AssertionError("psi_query should not be called when CrUX has data")

    result = fetch_cwv(URL, crux_query=crux_query, psi_query=psi_query)

    assert result == CwvSnapshot(
        url=URL,
        lcp_p75=2500.0,
        inp_p75=180.0,
        cls_p75=0.05,
        source="crux",
        form_factor="PHONE",
    )
    assert isinstance(result.cls_p75, float)


def test_fetch_cwv_returns_none_when_no_data_anywhere():
    result = fetch_cwv(URL, crux_query=lambda url: None, psi_query=lambda url: None)

    assert result is None


def test_fetch_cwv_falls_back_to_psi_when_crux_has_no_data():
    fixture = _load_fixture("fixture_psi_response.json")

    def crux_query(url):
        return None

    def psi_query(url):
        assert url == URL
        return fixture

    result = fetch_cwv(URL, crux_query=crux_query, psi_query=psi_query)

    assert result == CwvSnapshot(
        url=URL,
        lcp_p75=1834.2,
        inp_p75=None,
        cls_p75=0.021,
        source="psi",
        form_factor="PHONE",
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

    result = fetch_cwv(
        URL, crux_query=lambda url: record, psi_query=lambda url: None
    )

    assert result == CwvSnapshot(
        url=URL,
        lcp_p75=2200.0,
        inp_p75=None,
        cls_p75=0.1,
        source="crux",
        form_factor="PHONE",
    )


def test_fetch_cwv_propagates_non_none_signaling_errors():
    def crux_query(url):
        raise RuntimeError("boom")

    try:
        fetch_cwv(URL, crux_query=crux_query, psi_query=lambda url: None)
    except RuntimeError as exc:
        assert str(exc) == "boom"
    else:
        raise AssertionError("expected RuntimeError to propagate")


def test_is_crux_not_found_error_detects_the_data_not_found_message():
    fixture = _load_fixture("fixture_crux_not_found.json")

    assert _is_crux_not_found_error(json.dumps(fixture))
    assert _is_crux_not_found_error(json.dumps(fixture).encode("utf-8"))


def test_is_crux_not_found_error_false_for_genuine_errors():
    other_error = json.dumps(
        {"error": {"code": 403, "message": "API key not valid"}}
    )

    assert not _is_crux_not_found_error(other_error)
