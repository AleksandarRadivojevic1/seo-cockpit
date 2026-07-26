import json
from pathlib import Path
from unittest.mock import MagicMock, call, patch

import pytest
from googleapiclient.errors import HttpError

from seocockpit.gsc import SearchAnalytics, fetch_search_analytics

FIXTURES_DIR = Path(__file__).resolve().parent
PROPERTY = "sc-domain:example.com"


def _load_fixture():
    with open(FIXTURES_DIR / "fixture_gsc_response.json", "r", encoding="utf-8") as f:
        return json.load(f)


EMPTY_RESPONSE = {"rows": []}


def _mock_service(response_by_dimensions):
    """Build a mock searchconsole service.

    ``response_by_dimensions`` maps a tuple(dimensions) -> response dict (or
    a list of responses to be returned on successive calls, for pagination).
    Any dimension set not named defaults to an empty response, so a test
    only has to spell out the dimensions it cares about.
    """
    service = MagicMock()
    call_state = {}

    def query(siteUrl, body):
        dims = tuple(body["dimensions"])
        entry = response_by_dimensions.get(dims, EMPTY_RESPONSE)
        request = MagicMock()
        if isinstance(entry, list):
            idx = call_state.get(dims, 0)
            call_state[dims] = idx + 1
            response = entry[min(idx, len(entry) - 1)]
        else:
            response = entry
        request.execute.return_value = response
        return request

    service.searchanalytics.return_value.query.side_effect = query
    return service


def test_fetch_search_analytics_parses_fixture_into_normalized_rows():
    fixture = _load_fixture()
    service = _mock_service(
        {
            ("date",): fixture["totals"],
            ("date", "query"): fixture["by_query"],
            ("date", "page"): fixture["by_page"],
        }
    )

    result = fetch_search_analytics(
        service, PROPERTY, "2026-07-01", "2026-07-02"
    )

    assert isinstance(result, SearchAnalytics)

    assert result.totals == [
        {
            "site": PROPERTY,
            "date": "2026-07-01",
            "clicks": 120,
            "impressions": 3400,
            "ctr": 0.0352941176,
            "position": 14.2,
        },
        {
            "site": PROPERTY,
            "date": "2026-07-02",
            "clicks": 98,
            "impressions": 3100,
            "ctr": 0.0316129032,
            "position": 14.8,
        },
    ]

    assert {
        "site": PROPERTY,
        "date": "2026-07-01",
        "query": "seo cockpit",
        "clicks": 40,
        "impressions": 500,
        "ctr": 0.08,
        "position": 3.2,
    } in result.by_query
    assert len(result.by_query) == 4

    assert {
        "site": PROPERTY,
        "date": "2026-07-01",
        "page": "https://example.com/",
        "clicks": 60,
        "impressions": 1500,
        "ctr": 0.04,
        "position": 6.4,
    } in result.by_page
    assert len(result.by_page) == 3


def test_fetch_search_analytics_collects_the_country_dimension():
    """GSC returns country as a lowercase ISO-3166-1 alpha-3 code (``srb``,
    ``usa``), stored verbatim; mapping to the numeric codes a TopoJSON world
    atlas keys on is the dashboard's problem, not the collector's.
    """
    service = _mock_service(
        {
            ("date", "country"): {
                "rows": [
                    {
                        "keys": ["2026-07-01", "srb"],
                        "clicks": 110,
                        "impressions": 3000,
                        "ctr": 0.0366,
                        "position": 13.9,
                    },
                    {
                        "keys": ["2026-07-01", "usa"],
                        "clicks": 10,
                        "impressions": 400,
                        "ctr": 0.025,
                        "position": 21.0,
                    },
                ]
            }
        }
    )

    result = fetch_search_analytics(service, PROPERTY, "2026-07-01", "2026-07-01")

    assert result.by_country == [
        {
            "site": PROPERTY,
            "date": "2026-07-01",
            "country": "srb",
            "clicks": 110,
            "impressions": 3000,
            "ctr": 0.0366,
            "position": 13.9,
        },
        {
            "site": PROPERTY,
            "date": "2026-07-01",
            "country": "usa",
            "clicks": 10,
            "impressions": 400,
            "ctr": 0.025,
            "position": 21.0,
        },
    ]

    dimension_sets = [
        tuple(kall.kwargs["body"]["dimensions"])
        for kall in service.searchanalytics.return_value.query.call_args_list
    ]
    assert ("date", "country") in dimension_sets


def test_fetch_search_analytics_does_not_cap_countries_per_day():
    """``top_n`` caps the unbounded query/page dimensions. Country
    cardinality is bounded (~250) and the long tail is the whole point of a
    choropleth, so capping it would silently erase most of the map.
    """
    rows = [
        {
            "keys": ["2026-07-01", f"c{i:02d}"],
            "clicks": i,
            "impressions": i,
            "ctr": 0.1,
            "position": 5.0,
        }
        for i in range(10)
    ]
    service = _mock_service({("date", "country"): {"rows": rows}})

    result = fetch_search_analytics(
        service, PROPERTY, "2026-07-01", "2026-07-01", top_n=3
    )

    assert len(result.by_country) == 10


def test_fetch_search_analytics_passes_site_url_as_named_argument():
    fixture = _load_fixture()
    service = _mock_service(
        {
            ("date",): fixture["totals"],
            ("date", "query"): fixture["by_query"],
            ("date", "page"): fixture["by_page"],
        }
    )

    fetch_search_analytics(service, PROPERTY, "2026-07-01", "2026-07-02")

    query_mock = service.searchanalytics.return_value.query
    assert query_mock.call_count >= 1
    for kall in query_mock.call_args_list:
        args, kwargs = kall
        assert args == ()
        assert kwargs["siteUrl"] == PROPERTY
        assert "body" in kwargs


def test_fetch_search_analytics_paginates_until_short_page():
    row_limit = 25000
    full_page_rows = [
        {
            "keys": ["2026-07-01"],
            "clicks": 1,
            "impressions": 1,
            "ctr": 1.0,
            "position": 1.0,
        }
        for _ in range(row_limit)
    ]
    short_page_rows = [
        {
            "keys": ["2026-07-02"],
            "clicks": 2,
            "impressions": 2,
            "ctr": 1.0,
            "position": 2.0,
        }
    ]
    empty_response = {"rows": []}

    service = _mock_service(
        {
            ("date",): [
                {"rows": full_page_rows},
                {"rows": short_page_rows},
            ],
            ("date", "query"): empty_response,
            ("date", "page"): empty_response,
        }
    )

    result = fetch_search_analytics(service, PROPERTY, "2026-07-01", "2026-07-02")

    assert len(result.totals) == row_limit + 1

    query_mock = service.searchanalytics.return_value.query
    totals_calls = [
        kall
        for kall in query_mock.call_args_list
        if kall.kwargs["body"]["dimensions"] == ["date"]
    ]
    assert len(totals_calls) == 2
    assert totals_calls[0].kwargs["body"]["startRow"] == 0
    assert totals_calls[1].kwargs["body"]["startRow"] == row_limit


def test_fetch_search_analytics_caps_top_n_per_day_by_impressions():
    rows = [
        {
            "keys": ["2026-07-01", f"query-{i}"],
            "clicks": i,
            "impressions": i,
            "ctr": 0.1,
            "position": 5.0,
        }
        for i in range(10)
    ]
    empty_response = {"rows": []}

    service = _mock_service(
        {
            ("date",): empty_response,
            ("date", "query"): {"rows": rows},
            ("date", "page"): empty_response,
        }
    )

    result = fetch_search_analytics(
        service, PROPERTY, "2026-07-01", "2026-07-01", top_n=3
    )

    assert len(result.by_query) == 3
    kept_queries = {row["query"] for row in result.by_query}
    assert kept_queries == {"query-9", "query-8", "query-7"}


def test_fetch_search_analytics_retries_on_429_then_succeeds():
    http_error = HttpError(
        resp=MagicMock(status=429),
        content=b'{"error": {"code": 429}}',
    )

    success_response = {
        "rows": [
            {
                "keys": ["2026-07-01"],
                "clicks": 1,
                "impressions": 1,
                "ctr": 1.0,
                "position": 1.0,
            }
        ]
    }

    service = MagicMock()
    request = MagicMock()
    request.execute.side_effect = [http_error, success_response]
    # First call is the retried totals query; every later dimension set (as
    # many as fetch_search_analytics makes) returns empty.
    def query(siteUrl, body):
        if tuple(body["dimensions"]) == ("date",):
            return request
        return MagicMock(execute=MagicMock(return_value=EMPTY_RESPONSE))

    service.searchanalytics.return_value.query.side_effect = query

    with patch("seocockpit.gsc.time.sleep") as mock_sleep:
        result = fetch_search_analytics(
            service, PROPERTY, "2026-07-01", "2026-07-01"
        )

    assert len(result.totals) == 1
    assert mock_sleep.called


def test_fetch_search_analytics_reraises_after_max_attempts():
    http_error = HttpError(
        resp=MagicMock(status=429),
        content=b'{"error": {"code": 429}}',
    )

    request = MagicMock()
    request.execute.side_effect = http_error

    service = MagicMock()
    service.searchanalytics.return_value.query.return_value = request

    with patch("seocockpit.gsc.time.sleep"):
        with pytest.raises(HttpError):
            fetch_search_analytics(service, PROPERTY, "2026-07-01", "2026-07-01")
