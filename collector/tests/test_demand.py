"""Tests for market-demand discovery. No test here touches the network."""

from __future__ import annotations

import pytest

from seocockpit.demand import (
    AutocompleteSource,
    DemandKeyword,
    SOURCE_AUTOCOMPLETE,
    SOURCE_SERPAPI_TRENDS,
    SerpApiTrendsSource,
    discover,
    fold_diacritics,
    parse_rising_value,
    seeds_from_pages,
)


class TestParseRisingValue:
    def test_breakout_never_becomes_a_number(self):
        """Breakout means >5000% with no upper bound.

        Turning it into a float would invent precision Google explicitly
        refused to give, and would sort a genuinely explosive term below a
        merely large percentage.
        """
        pct, label = parse_rising_value("Breakout")
        assert pct is None
        assert label == "Breakout"

    def test_percentage_is_parsed_with_its_label_kept(self):
        assert parse_rising_value("+90%") == (90.0, "+90%")

    def test_thousands_separator_does_not_truncate_the_number(self):
        pct, _ = parse_rising_value("+1,250%")
        assert pct == 1250.0

    def test_missing_value_is_not_zero(self):
        # The recurring rule: absent is not zero. A 0 here would claim the
        # term measurably did not grow.
        assert parse_rising_value(None) == (None, None)
        assert parse_rising_value("") == (None, None)

    def test_a_real_zero_is_preserved_as_zero(self):
        pct, _ = parse_rising_value(0)
        assert pct == 0.0


class TestFoldDiacritics:
    def test_folds_serbian_diacritics(self):
        assert fold_diacritics("naočare") == "naocare"
        assert fold_diacritics("tečnost za sočiva") == "tecnost za sociva"

    def test_dj_has_no_combining_form_so_is_mapped_explicitly(self):
        # đ does not decompose under NFKD; without the explicit map it would
        # survive folding and never match its ASCII spelling.
        assert fold_diacritics("đubre") == "djubre"


class TestSeedsFromPages:
    def test_derives_phrases_from_slugs(self):
        seeds = seeds_from_pages(
            [
                "https://optikacajs.rs/kontaktna-sociva",
                "https://optikacajs.rs/dioptrijski-okviri",
            ]
        )
        assert seeds == ["kontaktna sociva", "dioptrijski okviri"]

    def test_skips_product_detail_pages(self):
        # /proizvod/ray-ban-aviator-rb3025 names one SKU; expanding it yields
        # model numbers, not demand.
        seeds = seeds_from_pages(
            [
                "https://optikacajs.rs/naocare-za-sunce",
                "https://optikacajs.rs/proizvod/ray-ban-aviator-rb3025",
            ]
        )
        assert seeds == ["naocare za sunce"]

    def test_ignores_the_homepage_and_deduplicates(self):
        seeds = seeds_from_pages(
            [
                "https://optikacajs.rs/",
                "https://optikacajs.rs/naocare-za-sunce",
                "https://optikacajs.rs/naocare-za-sunce",
            ]
        )
        assert seeds == ["naocare za sunce"]


class TestAutocompleteSource:
    def test_expands_a_seed_and_records_googles_ordering(self):
        calls: list[str] = []

        def fake_fetch(url):
            calls.append(url)
            if "q=naocare&" in url or url.endswith("q=naocare"):
                return ["naocare", ["naocare za sunce", "naocare za vid"]]
            return ["", []]

        src = AutocompleteSource(delay_seconds=0, fetch=fake_fetch)
        out = src.expand("naocare")

        assert [k.keyword for k in out] == ["naocare za sunce", "naocare za vid"]
        assert [k.suggest_rank for k in out] == [0, 1]
        assert all(k.source == SOURCE_AUTOCOMPLETE for k in out)
        assert all(k.seed == "naocare" for k in out)
        # It must actually expand, not just query the bare seed.
        assert len(calls) > 1

    def test_a_failing_variant_does_not_abandon_the_expansion(self):
        def flaky_fetch(url):
            if " a" in urllib_unquote(url):
                raise TimeoutError("boom")
            return ["", ["kontaktna sociva cena"]]

        src = AutocompleteSource(delay_seconds=0, fetch=flaky_fetch)
        out = src.expand("kontaktna sociva")
        assert any(k.keyword == "kontaktna sociva cena" for k in out)

    def test_keeps_the_first_sighting_of_a_duplicate(self):
        # The bare seed is queried first, so its rank is the meaningful one;
        # a later, longer variant must not overwrite it with a worse rank.
        def fake_fetch(url):
            if url.endswith("q=optika"):
                return ["", ["optika leskovac"]]
            return ["", ["something else", "optika leskovac"]]

        src = AutocompleteSource(delay_seconds=0, fetch=fake_fetch)
        out = src.expand("optika")
        hit = [k for k in out if k.keyword == "optika leskovac"]
        assert len(hit) == 1
        assert hit[0].suggest_rank == 0

    def test_never_reports_a_volume(self):
        src = AutocompleteSource(delay_seconds=0, fetch=lambda u: ["", ["x"]])
        assert all(k.volume is None for k in src.expand("s"))


class TestSerpApiTrendsSource:
    RESPONSE = {
        "related_queries": {
            "rising": [
                {"query": "izipizi", "value": "+90%"},
                {"query": "sani optik", "value": "Breakout"},
            ],
            "top": [
                {"query": "naocare za sunce", "value": 100},
                {"query": "naocare za vid", "value": 54},
            ],
        }
    }

    def test_parses_rising_and_top(self):
        src = SerpApiTrendsSource("k", fetch=lambda u: self.RESPONSE)
        out = {k.keyword: k for k in src.expand("naocare")}

        assert out["izipizi"].rising_pct == 90.0
        assert out["naocare za sunce"].top_value == 100.0
        assert all(k.source == SOURCE_SERPAPI_TRENDS for k in out.values())

    def test_breakout_keeps_its_label_and_no_number(self):
        src = SerpApiTrendsSource("k", fetch=lambda u: self.RESPONSE)
        out = {k.keyword: k for k in src.expand("naocare")}
        assert out["sani optik"].rising_label == "Breakout"
        assert out["sani optik"].rising_pct is None

    def test_no_data_is_empty_not_an_error(self):
        # Measured against the real account: Trends returns this for any term
        # below its volume floor, which is most Serbian long tail.
        err = {"error": "Google Trends hasn't returned any results for this query."}
        src = SerpApiTrendsSource("k", fetch=lambda u: err)
        assert src.expand("naocare za vid") == []

    def test_a_network_failure_does_not_raise(self):
        def boom(url):
            raise TimeoutError()

        assert SerpApiTrendsSource("k", fetch=boom).expand("x") == []

    def test_searches_left_reads_the_free_account_endpoint(self):
        src = SerpApiTrendsSource("k", fetch=lambda u: {"total_searches_left": 243})
        assert src.searches_left() == 243

    def test_searches_left_is_none_when_unknown_not_zero(self):
        # Zero would mean "budget exhausted" and would stop a run that should
        # have proceeded.
        src = SerpApiTrendsSource("k", fetch=lambda u: {})
        assert src.searches_left() is None

    def test_sends_related_queries_for_the_configured_geo(self):
        seen: list[str] = []

        def capture(url):
            seen.append(url)
            return {}

        SerpApiTrendsSource("k", geo="RS", fetch=capture).expand("naocare")
        assert "data_type=RELATED_QUERIES" in seen[0]
        assert "geo=RS" in seen[0]
        assert "engine=google_trends" in seen[0]


class TestDiscover:
    def _src(self, name, keywords):
        class S:
            def __init__(self):
                self.name = name

            def expand(self, seed):
                return [DemandKeyword(keyword=k, source=name, seed=seed) for k in keywords]

        return S()

    def test_rows_carry_the_site_and_a_shared_timestamp(self):
        rows = discover("site-a", [self._src("autocomplete", ["a"])], ["s"], now="T")
        assert rows[0]["site"] == "site-a"
        assert rows[0]["first_seen"] == "T"
        assert rows[0]["last_seen"] == "T"

    def test_same_keyword_from_two_sources_keeps_both_provenances(self):
        rows = discover(
            "site-a",
            [self._src("autocomplete", ["naocare"]), self._src("serpapi_trends", ["naocare"])],
            ["s"],
        )
        assert len(rows) == 2
        assert {r["source"] for r in rows} == {"autocomplete", "serpapi_trends"}

    def test_deduplicates_within_a_source(self):
        rows = discover("site-a", [self._src("autocomplete", ["a", "a"])], ["s1", "s2"])
        assert len(rows) == 1

    def test_unmeasured_fields_are_null_not_zero(self):
        rows = discover("site-a", [self._src("autocomplete", ["a"])], ["s"])
        for field in ("volume", "rising_pct", "top_value"):
            assert rows[0][field] is None, f"{field} must be NULL, not 0"


def urllib_unquote(url: str) -> str:
    import urllib.parse

    return urllib.parse.unquote_plus(url)


class TestGenericSlugStoplist:
    def test_navigation_slugs_are_not_used_as_seeds(self):
        # Measured on real data: `usluge` returned "usluge elektricara cene"
        # and `kontakt` returned "koliko traje kontaktni dermatitis". These
        # words are meaningless outside their own site.
        seeds = seeds_from_pages(
            [
                "https://optikacajs.rs/usluge",
                "https://optikacajs.rs/kontakt",
                "https://optikacajs.rs/dodaci",
                "https://optikacajs.rs/kontaktna-sociva",
            ]
        )
        assert seeds == ["kontaktna sociva"]

    def test_a_topical_slug_containing_a_generic_word_survives(self):
        # Only the WHOLE slug is generic; "kontaktna sociva" must not be
        # caught by the "kontakt" entry.
        assert seeds_from_pages(["https://x.rs/kontaktna-sociva"]) == ["kontaktna sociva"]
