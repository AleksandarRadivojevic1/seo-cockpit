"""GSC Search Analytics fetch and normalization for the seocockpit collector.

Wraps the Search Console API's ``searchanalytics().query()`` endpoint and
normalizes its responses into DB-ready row dicts (keys matching the
``totals_daily`` / ``query_daily`` / ``page_daily`` columns in
``seocockpit.db``), so a later task (collect.py) can hand them straight to
``db.upsert_*`` with no reshaping.

Only this fetch/normalize layer lives here: no DB writes, no scheduling, no
CLI.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

_SCOPES = ["https://www.googleapis.com/auth/webmasters"]
_ROW_LIMIT = 25000
_RETRYABLE_STATUSES = {429, 503}
_MAX_ATTEMPTS = 5
_BASE_BACKOFF_SECONDS = 1.0


@dataclass(frozen=True)
class SearchAnalytics:
    """DB-ready GSC Search Analytics rows for one site over one date range.

    Each list holds plain dicts whose keys exactly match the corresponding
    ``seocockpit.db`` table columns (including ``site``, set to the GSC
    property string), ready to pass to ``db.upsert_*``.
    """

    totals: list[dict]
    by_query: list[dict]
    by_page: list[dict]
    by_country: list[dict]


def build_service(service_account_path: str):
    """Build an authenticated Search Console API client.

    Thin wrapper around service-account credentials + discovery build; not
    exercised by unit tests (no network/credentials there).
    """
    creds = Credentials.from_service_account_file(
        service_account_path, scopes=_SCOPES
    )
    return build("searchconsole", "v1", credentials=creds)


def _execute_with_retry(request) -> dict:
    """Execute a Search Console API request, retrying on 429/503.

    Uses exponential backoff (via ``time.sleep``, patchable in tests) up to
    ``_MAX_ATTEMPTS`` attempts. Re-raises the ``HttpError`` if the status
    isn't retryable or attempts are exhausted.
    """
    attempt = 0
    while True:
        attempt += 1
        try:
            return request.execute()
        except HttpError as exc:
            status = getattr(exc.resp, "status", None)
            if status not in _RETRYABLE_STATUSES or attempt >= _MAX_ATTEMPTS:
                raise
            time.sleep(_BASE_BACKOFF_SECONDS * (2 ** (attempt - 1)))


def _query_all_rows(service, property: str, body: dict) -> list[dict]:
    """Run a searchanalytics query, paginating via startRow until exhausted."""
    rows: list[dict] = []
    start_row = 0
    row_limit = body["rowLimit"]

    while True:
        page_body = {**body, "startRow": start_row}
        request = service.searchanalytics().query(siteUrl=property, body=page_body)
        response = _execute_with_retry(request)
        page_rows = response.get("rows", [])
        rows.extend(page_rows)

        if len(page_rows) < row_limit:
            break
        start_row += row_limit

    return rows


def _cap_top_n_per_day(rows: list[dict], top_n: int) -> list[dict]:
    """Keep only the top ``top_n`` rows per ``date``, ranked by impressions."""
    by_date: dict[str, list[dict]] = {}
    for row in rows:
        by_date.setdefault(row["date"], []).append(row)

    capped: list[dict] = []
    for date_rows in by_date.values():
        date_rows.sort(key=lambda r: r["impressions"], reverse=True)
        capped.extend(date_rows[:top_n])
    return capped


def _normalize_rows(
    raw_rows: list[dict[str, Any]], property: str, extra_dims: tuple[str, ...]
) -> list[dict]:
    """Turn raw GSC ``rows`` entries into DB-ready dicts.

    ``extra_dims`` names the dimensions after ``date`` in ``keys`` order
    (e.g. ``("query",)`` or ``("page",)``, or ``()`` for totals).
    """
    normalized = []
    for row in raw_rows:
        keys = row["keys"]
        out = {
            "site": property,
            "date": keys[0],
            "clicks": row.get("clicks", 0),
            "impressions": row.get("impressions", 0),
            "ctr": row.get("ctr", 0.0),
            "position": row.get("position", 0.0),
        }
        for i, dim in enumerate(extra_dims, start=1):
            out[dim] = keys[i]
        normalized.append(out)
    return normalized


def fetch_search_analytics(
    service, property: str, start: str, end: str, top_n: int = 500
) -> SearchAnalytics:
    """Fetch and normalize GSC Search Analytics data for ``property``.

    Makes four ``searchanalytics().query()`` calls (totals, by-query,
    by-page, by-country), paginating each until exhausted, and returns
    DB-ready rows. ``by_query`` and ``by_page`` are capped to the top
    ``top_n`` rows per day by impressions; ``.totals`` (one row per day)
    and ``.by_country`` (bounded cardinality, ~250 codes) are not capped.

    GSC reports country as a lowercase ISO-3166-1 alpha-3 code (``srb``,
    ``usa``), kept verbatim in the ``country`` field.

    Args:
        service: An authenticated Search Console API client (as built by
            ``build_service``), injected so callers/tests can pass a mock.
        property: The GSC site property (e.g. ``sc-domain:example.com``).
        start: Start date, ``YYYY-MM-DD``.
        end: End date, ``YYYY-MM-DD``.
        top_n: Max rows kept per day for ``by_query``/``by_page``.
    """
    body_base = {
        "startDate": start,
        "endDate": end,
        "rowLimit": _ROW_LIMIT,
        "dataState": "final",
    }

    totals_raw = _query_all_rows(
        service, property, {**body_base, "dimensions": ["date"]}
    )
    totals = _normalize_rows(totals_raw, property, extra_dims=())

    query_raw = _query_all_rows(
        service, property, {**body_base, "dimensions": ["date", "query"]}
    )
    by_query = _cap_top_n_per_day(
        _normalize_rows(query_raw, property, extra_dims=("query",)), top_n
    )

    page_raw = _query_all_rows(
        service, property, {**body_base, "dimensions": ["date", "page"]}
    )
    by_page = _cap_top_n_per_day(
        _normalize_rows(page_raw, property, extra_dims=("page",)), top_n
    )

    country_raw = _query_all_rows(
        service, property, {**body_base, "dimensions": ["date", "country"]}
    )
    by_country = _normalize_rows(country_raw, property, extra_dims=("country",))

    return SearchAnalytics(
        totals=totals, by_query=by_query, by_page=by_page, by_country=by_country
    )
