import datetime

import pytest

from seocockpit.collect import (
    BACKFILL_DAYS,
    INCREMENTAL_WINDOW_DAYS,
    LAG_DAYS,
    _date_range,
    _homepage_url,
    collect_once,
)
from seocockpit.config import Config, Site
from seocockpit.cwv import CwvSnapshot
from seocockpit.db import init_db
from seocockpit.gsc import SearchAnalytics

SITE_A = "sc-domain:alexrad.dev"
SITE_B = "https://skedio.rs/"


def _config(tmp_path, sites=None):
    if sites is None:
        sites = [
            Site(property=SITE_A, slug="alexrad", display_name="Alexrad", brand_token="alexrad"),
            Site(property=SITE_B, slug="skedio", display_name="Skedio", brand_token="skedio"),
        ]
    return Config(
        sites=sites,
        db_path=str(tmp_path / "seo.db"),
        service_account_path="unused/service-account.json",
    )


def _sa(site: str, day: str) -> SearchAnalytics:
    return SearchAnalytics(
        totals=[
            {
                "site": site,
                "date": day,
                "clicks": 10,
                "impressions": 100,
                "ctr": 0.1,
                "position": 5.0,
            }
        ],
        by_query=[
            {
                "site": site,
                "date": day,
                "query": "seo cockpit",
                "clicks": 5,
                "impressions": 50,
                "ctr": 0.1,
                "position": 3.0,
            }
        ],
        by_page=[
            {
                "site": site,
                "date": day,
                "page": f"{site}/",
                "clicks": 5,
                "impressions": 50,
                "ctr": 0.1,
                "position": 4.0,
            }
        ],
        by_country=[
            {
                "site": site,
                "date": day,
                "country": "srb",
                "clicks": 9,
                "impressions": 90,
                "ctr": 0.1,
                "position": 5.0,
            }
        ],
    )


# One SearchAnalytics row per dimension: totals + query + page + country.
GSC_ROWS_PER_SITE = 4


@pytest.fixture()
def conn(tmp_path):
    return init_db(tmp_path / "seo.db")


# ---------------------------------------------------------------------------
# Core guarantee: one site's failure doesn't abort the others.
# ---------------------------------------------------------------------------


def test_one_site_failing_does_not_abort_others(tmp_path, conn):
    config = _config(tmp_path)

    def fetch_analytics(service, property, start, end):
        if property == SITE_A:
            raise RuntimeError("boom: GSC API error")
        return _sa(property, "2026-07-15")

    def fetch_cwv_fn(url):
        return None

    results = collect_once(
        config,
        mode="incremental",
        conn=conn,
        service=object(),
        fetch_analytics=fetch_analytics,
        fetch_cwv_fn=fetch_cwv_fn,
        today=datetime.date(2026, 7, 24),
    )

    # Return value reflects both outcomes.
    by_site = {r["site"]: r for r in results}
    assert by_site[SITE_A]["status"] == "failed"
    assert by_site[SITE_A]["error"] is not None
    assert by_site[SITE_B]["status"] == "success"

    # Failed site: a failed collection_runs row with a non-null error.
    failed_run = conn.execute(
        "SELECT status, error FROM collection_runs WHERE site=?", (SITE_A,)
    ).fetchone()
    assert failed_run[0] == "failed"
    assert failed_run[1] is not None

    # Failed site: no data actually written.
    count_a = conn.execute(
        "SELECT COUNT(*) FROM totals_daily WHERE site=?", (SITE_A,)
    ).fetchone()[0]
    assert count_a == 0

    # Successful site: run recorded as success.
    success_run = conn.execute(
        "SELECT status, error FROM collection_runs WHERE site=?", (SITE_B,)
    ).fetchone()
    assert success_run[0] == "success"
    assert success_run[1] is None

    # Successful site: rows actually present in every table.
    assert (
        conn.execute(
            "SELECT clicks, impressions FROM totals_daily WHERE site=?", (SITE_B,)
        ).fetchone()
        == (10, 100)
    )
    assert (
        conn.execute(
            "SELECT COUNT(*) FROM query_daily WHERE site=?", (SITE_B,)
        ).fetchone()[0]
        == 1
    )
    assert (
        conn.execute(
            "SELECT COUNT(*) FROM page_daily WHERE site=?", (SITE_B,)
        ).fetchone()[0]
        == 1
    )


def test_mid_write_failure_isolates_and_leaves_partial_rows(tmp_path, conn):
    """If a later upsert raises after earlier ones committed, the site is
    marked failed (rows=0) while the already-committed rows remain -- benign
    and self-healing, since the next successful run overwrites by key. Other
    sites are still collected. This pins the partial-write path the single
    fetch-level failure test doesn't exercise.
    """
    config = _config(tmp_path)

    def fetch_analytics(service, property, start, end):
        if property == SITE_A:
            # Valid totals/query, but a by_page row missing the NOT NULL
            # ``page`` key -> upsert_page_daily raises AFTER totals & query
            # have already self-committed.
            sa = _sa(property, "2026-07-15")
            broken_page = dict(sa.by_page[0])
            del broken_page["page"]
            return SearchAnalytics(
                totals=sa.totals,
                by_query=sa.by_query,
                by_page=[broken_page],
                by_country=sa.by_country,
            )
        return _sa(property, "2026-07-15")

    def fetch_cwv_fn(url):
        return None

    results = collect_once(
        config,
        mode="incremental",
        conn=conn,
        service=object(),
        fetch_analytics=fetch_analytics,
        fetch_cwv_fn=fetch_cwv_fn,
        today=datetime.date(2026, 7, 24),
    )

    by_site = {r["site"]: r for r in results}
    # Failed site: recorded failed with rows=0, despite partial writes.
    assert by_site[SITE_A]["status"] == "failed"
    assert by_site[SITE_A]["rows"] == 0
    failed_run = conn.execute(
        "SELECT status, rows_written FROM collection_runs WHERE site=?", (SITE_A,)
    ).fetchone()
    assert failed_run == ("failed", 0)

    # Partial rows from the earlier upserts DID commit and remain in place.
    assert conn.execute(
        "SELECT COUNT(*) FROM totals_daily WHERE site=?", (SITE_A,)
    ).fetchone()[0] == 1
    assert conn.execute(
        "SELECT COUNT(*) FROM query_daily WHERE site=?", (SITE_A,)
    ).fetchone()[0] == 1
    # The write that raised left no page rows.
    assert conn.execute(
        "SELECT COUNT(*) FROM page_daily WHERE site=?", (SITE_A,)
    ).fetchone()[0] == 0

    # Isolation holds even for a mid-write failure: SITE_B fully collected.
    assert by_site[SITE_B]["status"] == "success"
    assert conn.execute(
        "SELECT COUNT(*) FROM page_daily WHERE site=?", (SITE_B,)
    ).fetchone()[0] == 1


# ---------------------------------------------------------------------------
# Site config plumbing: upsert_sites is called once, up front, for every
# configured site (regardless of that site's later collection outcome).
# ---------------------------------------------------------------------------


def test_collect_once_upserts_site_config_for_every_site(tmp_path, conn):
    config = _config(tmp_path)

    def fetch_analytics(service, property, start, end):
        if property == SITE_A:
            raise RuntimeError("boom: GSC API error")
        return _sa(property, "2026-07-15")

    def fetch_cwv_fn(url):
        return None

    collect_once(
        config,
        mode="incremental",
        conn=conn,
        service=object(),
        fetch_analytics=fetch_analytics,
        fetch_cwv_fn=fetch_cwv_fn,
        today=datetime.date(2026, 7, 24),
    )

    # captured_at for today=2026-07-24 is midnight UTC on that date.
    expected_updated_at = "2026-07-24T00:00:00+00:00"

    rows = {
        row[0]: row
        for row in conn.execute(
            "SELECT property, slug, display_name, brand_token, updated_at FROM sites"
        ).fetchall()
    }
    # Both sites' config rows are written up front, even though SITE_A's
    # collection itself fails later in the run.
    assert rows[SITE_A] == (SITE_A, "alexrad", "Alexrad", "alexrad", expected_updated_at)
    assert rows[SITE_B] == (SITE_B, "skedio", "Skedio", "skedio", expected_updated_at)


# ---------------------------------------------------------------------------
# Date window
# ---------------------------------------------------------------------------


def test_date_range_incremental():
    today = datetime.date(2026, 7, 24)
    start, end = _date_range("incremental", today)

    expected_end = today - datetime.timedelta(days=LAG_DAYS)
    expected_start = expected_end - datetime.timedelta(days=INCREMENTAL_WINDOW_DAYS)

    assert end == expected_end.isoformat()
    assert start == expected_start.isoformat()
    assert start == "2026-07-16"
    assert end == "2026-07-21"


def test_date_range_backfill():
    today = datetime.date(2026, 7, 24)
    start, end = _date_range("backfill", today)

    expected_end = today - datetime.timedelta(days=LAG_DAYS)
    expected_start = expected_end - datetime.timedelta(days=BACKFILL_DAYS)

    assert end == expected_end.isoformat()
    assert start == expected_start.isoformat()
    assert end == "2026-07-21"
    assert start == "2026-04-22"


# ---------------------------------------------------------------------------
# Homepage derivation
# ---------------------------------------------------------------------------


def test_homepage_url_sc_domain_property():
    assert _homepage_url("sc-domain:alexrad.dev") == "https://alexrad.dev/"


def test_homepage_url_url_prefix_property_passthrough():
    assert _homepage_url("https://skedio.rs/") == "https://skedio.rs/"


# ---------------------------------------------------------------------------
# CWV handling
# ---------------------------------------------------------------------------


def test_cwv_none_means_no_row_and_run_still_succeeds(tmp_path, conn):
    config = _config(tmp_path, sites=[Site(property=SITE_A, slug="site-a", display_name="A", brand_token="a")])

    def fetch_analytics(service, property, start, end):
        return _sa(property, "2026-07-15")

    def fetch_cwv_fn(url):
        return None

    results = collect_once(
        config,
        mode="incremental",
        conn=conn,
        service=object(),
        fetch_analytics=fetch_analytics,
        fetch_cwv_fn=fetch_cwv_fn,
        today=datetime.date(2026, 7, 24),
    )

    assert results[0]["status"] == "success"
    cwv_count = conn.execute("SELECT COUNT(*) FROM cwv_snapshots").fetchone()[0]
    assert cwv_count == 0

    # rows count excludes cwv: 1 totals + 1 query + 1 page + 1 country = 4
    assert results[0]["rows"] == GSC_ROWS_PER_SITE
    run_row = conn.execute(
        "SELECT rows_written FROM collection_runs WHERE site=?", (SITE_A,)
    ).fetchone()
    assert run_row[0] == GSC_ROWS_PER_SITE


def test_cwv_present_writes_one_row_with_site(tmp_path, conn):
    config = _config(tmp_path, sites=[Site(property=SITE_A, slug="site-a", display_name="A", brand_token="a")])

    def fetch_analytics(service, property, start, end):
        return _sa(property, "2026-07-15")

    snap = CwvSnapshot(
        url="https://alexrad.dev/",
        lcp_p75=2000.0,
        inp_p75=150.0,
        cls_p75=0.02,
        source="crux",
        form_factor="PHONE",
        lh_performance=0.0,
        lh_accessibility=None,
        lh_best_practices=99.0,
        lh_seo=91.0,
    )

    def fetch_cwv_fn(url):
        assert url == "https://alexrad.dev/"
        return snap

    results = collect_once(
        config,
        mode="incremental",
        conn=conn,
        service=object(),
        fetch_analytics=fetch_analytics,
        fetch_cwv_fn=fetch_cwv_fn,
        today=datetime.date(2026, 7, 24),
    )

    assert results[0]["status"] == "success"
    assert results[0]["rows"] == GSC_ROWS_PER_SITE + 1

    row = conn.execute(
        "SELECT site, url, lcp_p75, source, "
        "lh_performance, lh_accessibility, lh_best_practices, lh_seo "
        "FROM cwv_snapshots"
    ).fetchone()
    # A 0 Lighthouse score persists as 0, an unfetched category as NULL.
    assert row == (
        SITE_A,
        "https://alexrad.dev/",
        2000.0,
        "crux",
        0.0,
        None,
        99.0,
        91.0,
    )


# ---------------------------------------------------------------------------
# CWV error isolation: a CWV failure must not condemn the GSC data
# ---------------------------------------------------------------------------


def test_cwv_failure_leaves_the_run_successful_with_gsc_rows_counted(tmp_path, conn):
    """The CWV fetch used to share the GSC try/except, so one PSI timeout
    marked the whole site failed with rows=0 even though the GSC upserts had
    already committed. Unconditional PSI (11d) makes that a routine event.
    """
    config = _config(
        tmp_path,
        sites=[Site(property=SITE_A, slug="site-a", display_name="A", brand_token="a")],
    )

    def fetch_analytics(service, property, start, end):
        return _sa(property, "2026-07-15")

    def fetch_cwv_fn(url):
        raise RuntimeError("PSI timed out")

    results = collect_once(
        config,
        mode="incremental",
        conn=conn,
        service=object(),
        fetch_analytics=fetch_analytics,
        fetch_cwv_fn=fetch_cwv_fn,
        today=datetime.date(2026, 7, 24),
    )

    assert results[0]["status"] == "success"
    assert results[0]["rows"] == GSC_ROWS_PER_SITE

    # The CWV error is recorded, not discarded.
    assert "PSI timed out" in results[0]["cwv_error"]

    status, error, rows_written = conn.execute(
        "SELECT status, error, rows_written FROM collection_runs WHERE site=?",
        (SITE_A,),
    ).fetchone()
    assert status == "success"
    assert rows_written == GSC_ROWS_PER_SITE
    assert error is not None and "PSI timed out" in error

    # The GSC data actually landed.
    assert (
        conn.execute(
            "SELECT COUNT(*) FROM totals_daily WHERE site=?", (SITE_A,)
        ).fetchone()[0]
        == 1
    )
    assert conn.execute("SELECT COUNT(*) FROM cwv_snapshots").fetchone()[0] == 0


def test_a_gsc_failure_is_still_a_failed_run(tmp_path, conn):
    """The isolation fix must not weaken the real failure path: a GSC error
    still fails the site, and ``cwv_error`` stays None.
    """
    config = _config(
        tmp_path,
        sites=[Site(property=SITE_A, slug="site-a", display_name="A", brand_token="a")],
    )

    def fetch_analytics(service, property, start, end):
        raise RuntimeError("boom: GSC API error")

    results = collect_once(
        config,
        mode="incremental",
        conn=conn,
        service=object(),
        fetch_analytics=fetch_analytics,
        fetch_cwv_fn=lambda url: None,
        today=datetime.date(2026, 7, 24),
    )

    assert results[0]["status"] == "failed"
    assert results[0]["rows"] == 0
    assert results[0]["cwv_error"] is None
    assert "boom" in results[0]["error"]


# ---------------------------------------------------------------------------
# Country dimension
# ---------------------------------------------------------------------------


def test_country_rows_are_upserted_and_re_running_does_not_duplicate(tmp_path, conn):
    config = _config(
        tmp_path,
        sites=[Site(property=SITE_A, slug="site-a", display_name="A", brand_token="a")],
    )

    def fetch_analytics(service, property, start, end):
        return _sa(property, "2026-07-15")

    kwargs = dict(
        mode="incremental",
        conn=conn,
        service=object(),
        fetch_analytics=fetch_analytics,
        fetch_cwv_fn=lambda url: None,
        today=datetime.date(2026, 7, 24),
    )
    collect_once(config, **kwargs)
    collect_once(config, **kwargs)

    rows = conn.execute(
        "SELECT site, date, country, clicks, impressions FROM country_daily"
    ).fetchall()
    assert rows == [(SITE_A, "2026-07-15", "srb", 9, 90)]
