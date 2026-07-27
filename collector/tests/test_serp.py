"""Tests for SERP competitor checks (Task 2.5).

The fixture in ``tests/fixtures/serpapi_google_rs.json`` is a REAL SerpApi
response, captured 2026-07-27 for "dioptrijski okviri akcija" (gl=rs, hl=sr)
at a cost of one credit. It is the reference for what the parser must handle,
and it already disproved two assumptions: this SERP carries no ``ads`` key and
no ``local_results`` key at all, rather than empty ones.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from seocockpit import db as db_module
from seocockpit.demand import fold_diacritics
from seocockpit.serp import (
    SerpApiSearchSource,
    UnsupportedLocation,
    own_domain_for,
    registrable_domain,
    select_gap_keywords,
    to_rows,
    validate_location,
)

FIXTURE = Path(__file__).parent / "fixtures" / "serpapi_google_rs.json"


@pytest.fixture
def real_payload() -> dict:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def source(payload, **kwargs) -> SerpApiSearchSource:
    return SerpApiSearchSource("fake-key", fetch=lambda url: payload, **kwargs)


# --------------------------------------------------------------------------
# domain helpers
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "url,expected",
    [
        ("https://www.kupujemprodajem.com/x", "kupujemprodajem.com"),
        ("https://online.sanioptik.rs/sr/akcije", "online.sanioptik.rs"),
        ("http://OKOPLUSOPTIKA.rs/", "okoplusoptika.rs"),
        ("https://example.rs:8443/a", "example.rs"),
    ],
)
def test_registrable_domain(url, expected):
    assert registrable_domain(url) == expected


def test_subdomains_are_not_collapsed():
    # shop.x.rs and x.rs are genuinely different places to rank; collapsing
    # them would hide that one of them is the one winning.
    assert registrable_domain("https://shop.optikacajs.rs/a") == "shop.optikacajs.rs"
    assert registrable_domain("https://optikacajs.rs/a") == "optikacajs.rs"


@pytest.mark.parametrize(
    "prop,expected",
    [
        ("https://optikacajs.rs/", "optikacajs.rs"),
        ("sc-domain:alexrad.dev", "alexrad.dev"),
        ("https://www.skedio.rs/", "skedio.rs"),
    ],
)
def test_own_domain_for(prop, expected):
    assert own_domain_for(prop) == expected


# --------------------------------------------------------------------------
# parsing the real response
# --------------------------------------------------------------------------


def test_parses_the_real_serp_into_ten_ordered_results(real_payload):
    check = source(real_payload).check("dioptrijski okviri akcija", "optikacajs.rs")

    assert len(check.results) == 10
    assert [r.position for r in check.results] == list(range(1, 11))
    assert check.results[0].domain == "online.sanioptik.rs"
    assert check.results[8].domain == "kupujemprodajem.com"
    assert check.geo == "rs"
    assert check.language == "sr"


def test_absent_own_domain_records_none_position_with_the_depth_examined(real_payload):
    """The whole point of depth_checked.

    optikacajs.rs is genuinely not in this SERP. `our_position = None` alone
    would be unfalsifiable -- "not in top 10" and "not in top 100" are
    different facts, and only depth_checked tells them apart.
    """
    check = source(real_payload).check("dioptrijski okviri akcija", "optikacajs.rs")
    assert check.our_position is None
    assert check.depth_checked == 10


def test_own_domain_present_records_its_position(real_payload):
    check = source(real_payload).check("q", "oculusoptika.rs")
    assert check.our_position == 2


def test_a_subdomain_counts_as_the_domain_and_the_first_hit_wins(real_payload):
    # sanioptik.rs appears as online.sanioptik.rs at BOTH 1 and 5.
    check = source(real_payload).check("q", "sanioptik.rs")
    assert check.our_position == 1


def test_a_serp_with_no_ads_or_local_pack_records_zero_and_false(real_payload):
    # Measured from the real response: neither key is present at all. Absent
    # means Google showed none, which is a measurement of "no", not "unknown".
    assert "ads" not in real_payload
    assert "local_results" not in real_payload
    check = source(real_payload).check("q", "optikacajs.rs")
    assert check.ads_top == 0
    assert check.ads_bottom == 0
    assert check.local_pack is False


def test_depth_limits_how_many_results_are_kept(real_payload):
    check = source(real_payload, depth=3).check("q", "optikacajs.rs")
    assert len(check.results) == 3
    assert check.depth_checked == 3


def test_request_carries_engine_market_and_location():
    captured = {}

    def fake_fetch(url):
        captured["url"] = url
        return {"organic_results": []}

    SerpApiSearchSource(
        "k", location="Nis,Serbia", fetch=fake_fetch
    ).check("naocare", "optikacajs.rs")

    assert "engine=google" in captured["url"]
    assert "gl=rs" in captured["url"]
    assert "hl=sr" in captured["url"]
    assert "location=Nis%2CSerbia" in captured["url"]


def test_location_is_omitted_entirely_when_unset():
    captured = {}

    def fake_fetch(url):
        captured["url"] = url
        return {"organic_results": []}

    SerpApiSearchSource("k", fetch=fake_fetch).check("naocare", "optikacajs.rs")
    assert "location=" not in captured["url"]


# --------------------------------------------------------------------------
# failure handling -- the invariant
# --------------------------------------------------------------------------


def test_a_network_error_returns_none_rather_than_a_partial_check():
    def boom(url):
        raise OSError("connection reset")

    assert SerpApiSearchSource("k", fetch=boom).check("q", "d") is None


def test_an_api_error_payload_returns_none():
    src = SerpApiSearchSource("k", fetch=lambda url: {"error": "Invalid API key"})
    assert src.check("q", "d") is None


def test_a_malformed_payload_returns_none():
    assert SerpApiSearchSource("k", fetch=lambda url: ["not", "a", "dict"]).check("q", "d") is None
    src = SerpApiSearchSource("k", fetch=lambda url: {"organic_results": "nonsense"})
    assert src.check("q", "d") is None


def test_a_genuinely_empty_serp_is_a_finding_not_a_failure():
    """Zero organic results is real data and must be recorded.

    This is the one case that produces a stored check with no result rows,
    and it is why the dashboard needs a third empty state.
    """
    src = SerpApiSearchSource("k", fetch=lambda url: {"search_metadata": {}})
    check = src.check("a query nobody ranks for", "optikacajs.rs")
    assert check is not None
    assert check.results == []
    assert check.our_position is None
    assert check.depth_checked == 10


# --------------------------------------------------------------------------
# location validation
# --------------------------------------------------------------------------


def test_validate_location_rejects_an_unsupported_city_and_suggests_alternatives():
    payload = [
        {"canonical_name": "Nis,Serbia"},
        {"canonical_name": "Belgrade,Serbia"},
    ]
    with pytest.raises(UnsupportedLocation) as excinfo:
        validate_location("Leskovac,Serbia", fetch=lambda url: payload)
    # Measured on the real endpoint: Leskovac is genuinely absent.
    assert "Nis,Serbia" in str(excinfo.value)


def test_validate_location_canonicalises_a_space_after_the_comma():
    payload = [{"canonical_name": "Nis,Serbia"}]
    assert validate_location("Nis, Serbia", fetch=lambda url: payload) == "Nis,Serbia"


def test_validate_location_passes_through_when_the_endpoint_is_unreachable():
    # Unknown is not invalid -- the same rule as an unreadable credit balance.
    def boom(url):
        raise OSError("dns failure")

    assert validate_location("Nis,Serbia", fetch=boom) == "Nis,Serbia"


# --------------------------------------------------------------------------
# keyword selection
# --------------------------------------------------------------------------


def test_selection_excludes_keywords_the_site_already_ranks_for_across_diacritics():
    """Folding is load-bearing: GSC reports whichever spelling was typed."""
    demand = [("kontaktna sočiva", 0, "sociva"), ("naocare za sunce", 1, "naocare")]
    chosen = select_gap_keywords(demand, ["kontaktna sociva"], fold_diacritics, 10)
    assert chosen == ["naocare za sunce"]


def test_selection_round_robins_across_seeds_instead_of_clustering_on_one():
    """Found by running it on the real database, not by reasoning.

    Sorting purely by suggest_rank returned six variants of "dioptrijski
    okviri" in the first eight, because rank ties break alphabetically. Every
    credit is a question you only get to ask 250 times a month.
    """
    demand = [
        ("okviri a", 0, "okviri"), ("okviri b", 1, "okviri"), ("okviri c", 2, "okviri"),
        ("sociva a", 0, "sociva"), ("sociva b", 1, "sociva"),
        ("naocare a", 0, "naocare"),
    ]
    chosen = select_gap_keywords(demand, [], fold_diacritics, 4)
    # One from each seed before any seed's second.
    assert set(chosen[:3]) == {"okviri a", "sociva a", "naocare a"}
    assert len(chosen) == 4


def test_selection_sorts_a_null_suggest_rank_last_not_as_zero():
    demand = [("unknown rank", None, "s"), ("known rank", 5, "s")]
    assert select_gap_keywords(demand, [], fold_diacritics, 2) == ["known rank", "unknown rank"]


def test_selection_deduplicates_keywords_that_fold_to_the_same_text():
    demand = [("sočiva cena", 0, "a"), ("sociva cena", 1, "b")]
    assert select_gap_keywords(demand, [], fold_diacritics, 10) == ["sočiva cena"]


def test_selection_respects_the_limit():
    demand = [(f"kw {i}", i, "s") for i in range(50)]
    assert len(select_gap_keywords(demand, [], fold_diacritics, 15)) == 15


# --------------------------------------------------------------------------
# persistence
# --------------------------------------------------------------------------


@pytest.fixture
def conn(tmp_path):
    connection = db_module.init_db(tmp_path / "serp.db")
    yield connection
    connection.close()


def test_a_check_and_its_results_round_trip(conn, real_payload):
    check = source(real_payload).check("dioptrijski okviri akcija", "optikacajs.rs")
    check_row, result_rows = to_rows("https://optikacajs.rs/", check)
    db_module.insert_serp_check(conn, check_row, result_rows)

    stored = conn.execute(
        "SELECT depth_checked, local_pack, ads_top, our_position FROM serp_checks"
    ).fetchone()
    assert stored == (10, 0, 0, None)

    domains = [
        r[0] for r in conn.execute("SELECT domain FROM serp_results ORDER BY position")
    ]
    assert domains[0] == "online.sanioptik.rs"
    assert len(domains) == 10


def test_a_failed_results_write_rolls_back_the_check_row(conn, real_payload):
    """The invariant: a stored check ALWAYS has its results.

    If the check row could commit while the results insert failed, the pair
    would render as "we looked and nobody ranks" -- the single most
    misleading thing this feature could say.
    """
    check = source(real_payload).check("q", "optikacajs.rs")
    check_row, result_rows = to_rows("https://optikacajs.rs/", check)
    # Corrupt one result row so executemany raises mid-write.
    result_rows[3] = {**result_rows[3], "position": None}

    with pytest.raises(sqlite3.Error):
        db_module.insert_serp_check(conn, check_row, result_rows)

    assert conn.execute("SELECT COUNT(*) FROM serp_checks").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM serp_results").fetchone()[0] == 0


def test_rechecking_a_keyword_adds_a_snapshot_rather_than_overwriting(conn, real_payload):
    for stamp in ("2026-07-01T00:00:00+00:00", "2026-08-01T00:00:00+00:00"):
        check = source(real_payload).check("q", "optikacajs.rs")
        check_row, result_rows = to_rows("https://optikacajs.rs/", check)
        check_row["checked_at"] = stamp
        result_rows = [{**r, "checked_at": stamp} for r in result_rows]
        db_module.insert_serp_check(conn, check_row, result_rows)

    assert conn.execute("SELECT COUNT(*) FROM serp_checks").fetchone()[0] == 2


def test_ever_ranked_queries_spans_all_history_not_a_window(conn):
    conn.executemany(
        "INSERT INTO query_daily (site, date, query, clicks, impressions, ctr, position) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
            ("https://x.test/", "2025-01-01", "ancient query", 0, 1, 0.0, 40.0),
            ("https://x.test/", "2026-07-20", "recent query", 1, 10, 0.1, 5.0),
        ],
    )
    conn.commit()
    assert set(db_module.ever_ranked_queries(conn, "https://x.test/")) == {
        "ancient query",
        "recent query",
    }
