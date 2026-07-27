import sqlite3

import pytest

from seocockpit.db import (
    finish_run,
    init_db,
    insert_cwv,
    prune_demand_keywords,
    start_run,
    upsert_country_daily,
    upsert_demand_keywords,
    upsert_page_daily,
    upsert_query_daily,
    upsert_sites,
    upsert_totals,
)

SITE = "sc-domain:example.com"

# The cwv_snapshots schema as it shipped before Task 11d: no Lighthouse
# category columns, and a NON-unique index. Written out literally (rather
# than derived from db._SCHEMA) so the migration tests keep testing the
# real upgrade path even as the current schema moves on.
_LEGACY_CWV_SCHEMA = """
CREATE TABLE cwv_snapshots (
    site TEXT NOT NULL,
    url TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    lcp_p75 REAL,
    inp_p75 REAL,
    cls_p75 REAL,
    source TEXT NOT NULL,
    form_factor TEXT
);

CREATE INDEX idx_cwv_snapshots_site_url_captured_at
    ON cwv_snapshots (site, url, captured_at);
"""


def _legacy_db(path, rows=()):
    """Create a pre-11d cwv_snapshots table at ``path`` holding ``rows``."""
    legacy = sqlite3.connect(path)
    legacy.executescript(_LEGACY_CWV_SCHEMA)
    legacy.executemany(
        "INSERT INTO cwv_snapshots "
        "(site, url, captured_at, lcp_p75, inp_p75, cls_p75, source, form_factor) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        rows,
    )
    legacy.commit()
    legacy.close()


def _cwv_row(**overrides):
    row = {
        "site": SITE,
        "url": "https://example.com/",
        "captured_at": "2026-07-20T00:00:00+00:00",
        "lcp_p75": 2100.0,
        "inp_p75": 150.0,
        "cls_p75": 0.05,
        "source": "crux",
        "form_factor": "PHONE",
        "lh_performance": 88.0,
        "lh_accessibility": 92.0,
        "lh_best_practices": 100.0,
        "lh_seo": 91.0,
    }
    row.update(overrides)
    return row


def _index_is_unique(conn, table, index_name):
    for _seq, name, unique, *_rest in conn.execute(
        f"PRAGMA index_list({table})"
    ).fetchall():
        if name == index_name:
            return bool(unique)
    raise AssertionError(f"index {index_name} not found on {table}")


@pytest.fixture()
def conn(tmp_path):
    db_path = tmp_path / "seo.db"
    return init_db(db_path)


def test_init_db_creates_expected_tables(conn):
    tables = {
        row[0]
        for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
    }
    assert {
        "totals_daily",
        "query_daily",
        "page_daily",
        "country_daily",
        "cwv_snapshots",
        "collection_runs",
        "sites",
    } <= tables


def test_init_db_is_idempotent(tmp_path):
    db_path = tmp_path / "seo.db"
    conn1 = init_db(db_path)
    conn1.close()
    # Calling init_db again against the same file must not error and must
    # leave a valid, still-usable schema.
    conn2 = init_db(db_path)
    tables = {
        row[0]
        for row in conn2.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
    }
    assert "totals_daily" in tables
    conn2.close()


def test_init_db_creates_parent_dirs(tmp_path):
    db_path = tmp_path / "nested" / "dir" / "seo.db"
    conn = init_db(db_path)
    assert db_path.exists()
    conn.close()


def test_upsert_query_daily_same_key_twice_yields_one_updated_row(conn):
    row_v1 = {
        "site": SITE,
        "date": "2026-07-20",
        "query": "seo cockpit",
        "clicks": 1,
        "impressions": 10,
        "ctr": 0.1,
        "position": 15.0,
    }
    row_v2 = {
        "site": SITE,
        "date": "2026-07-20",
        "query": "seo cockpit",
        "clicks": 5,
        "impressions": 50,
        "ctr": 0.1,
        "position": 8.5,
    }

    upsert_query_daily(conn, [row_v1])
    upsert_query_daily(conn, [row_v2])

    rows = conn.execute(
        "SELECT clicks, impressions, ctr, position FROM query_daily "
        "WHERE site=? AND date=? AND query=?",
        (SITE, "2026-07-20", "seo cockpit"),
    ).fetchall()

    assert len(rows) == 1
    assert rows[0] == (5, 50, 0.1, 8.5)


def test_upsert_totals_same_key_twice_yields_one_updated_row(conn):
    row_v1 = {
        "site": SITE,
        "date": "2026-07-20",
        "clicks": 10,
        "impressions": 100,
        "ctr": 0.1,
        "position": 12.0,
    }
    row_v2 = {
        "site": SITE,
        "date": "2026-07-20",
        "clicks": 20,
        "impressions": 200,
        "ctr": 0.1,
        "position": 9.0,
    }

    upsert_totals(conn, [row_v1])
    upsert_totals(conn, [row_v2])

    rows = conn.execute(
        "SELECT clicks, impressions, ctr, position FROM totals_daily "
        "WHERE site=? AND date=?",
        (SITE, "2026-07-20"),
    ).fetchall()

    assert len(rows) == 1
    assert rows[0] == (20, 200, 0.1, 9.0)


def test_upsert_page_daily_same_key_twice_yields_one_updated_row(conn):
    row_v1 = {
        "site": SITE,
        "date": "2026-07-20",
        "page": "https://example.com/",
        "clicks": 3,
        "impressions": 30,
        "ctr": 0.1,
        "position": 5.0,
    }
    row_v2 = {
        "site": SITE,
        "date": "2026-07-20",
        "page": "https://example.com/",
        "clicks": 7,
        "impressions": 70,
        "ctr": 0.1,
        "position": 4.0,
    }

    upsert_page_daily(conn, [row_v1])
    upsert_page_daily(conn, [row_v2])

    rows = conn.execute(
        "SELECT clicks, impressions, ctr, position FROM page_daily "
        "WHERE site=? AND date=? AND page=?",
        (SITE, "2026-07-20", "https://example.com/"),
    ).fetchall()

    assert len(rows) == 1
    assert rows[0] == (7, 70, 0.1, 4.0)


def test_upsert_query_daily_multiple_rows_in_one_call(conn):
    rows = [
        {
            "site": SITE,
            "date": "2026-07-20",
            "query": "seo cockpit",
            "clicks": 1,
            "impressions": 10,
            "ctr": 0.1,
            "position": 15.0,
        },
        {
            "site": SITE,
            "date": "2026-07-20",
            "query": "gsc collector",
            "clicks": 2,
            "impressions": 20,
            "ctr": 0.1,
            "position": 12.0,
        },
    ]
    upsert_query_daily(conn, rows)

    count = conn.execute("SELECT COUNT(*) FROM query_daily").fetchone()[0]
    assert count == 2


def test_insert_cwv_same_key_twice_yields_one_replaced_row(conn):
    """``captured_at`` is start-of-day UTC, so two runs on the same day share
    a key. Without the unique index + INSERT OR REPLACE they silently
    accumulate duplicate snapshots for one (site, url, day).
    """
    insert_cwv(conn, _cwv_row(lcp_p75=2100.0))
    insert_cwv(conn, _cwv_row(lcp_p75=1800.0))

    rows = conn.execute("SELECT lcp_p75 FROM cwv_snapshots").fetchall()
    assert rows == [(1800.0,)]  # one row, latest value wins


def test_insert_cwv_keeps_separate_rows_per_captured_at(conn):
    """The history property the replace must not destroy: different days
    are different snapshots.
    """
    insert_cwv(conn, _cwv_row(captured_at="2026-07-20T00:00:00+00:00"))
    insert_cwv(conn, _cwv_row(captured_at="2026-07-21T00:00:00+00:00"))

    count = conn.execute("SELECT COUNT(*) FROM cwv_snapshots").fetchone()[0]
    assert count == 2


def test_insert_cwv_allows_null_metrics(conn):
    insert_cwv(
        conn,
        _cwv_row(
            lcp_p75=None,
            inp_p75=None,
            cls_p75=None,
            source="psi",
            lh_performance=None,
            lh_accessibility=None,
            lh_best_practices=None,
            lh_seo=None,
        ),
    )

    fetched = conn.execute(
        "SELECT lcp_p75, inp_p75, cls_p75, "
        "lh_performance, lh_accessibility, lh_best_practices, lh_seo "
        "FROM cwv_snapshots"
    ).fetchone()
    assert fetched == (None,) * 7


def test_insert_cwv_persists_lighthouse_categories(conn):
    insert_cwv(conn, _cwv_row())

    fetched = conn.execute(
        "SELECT lh_performance, lh_accessibility, lh_best_practices, lh_seo "
        "FROM cwv_snapshots"
    ).fetchone()
    assert fetched == (88.0, 92.0, 100.0, 91.0)


def test_insert_cwv_stores_a_zero_lighthouse_score_distinctly_from_not_fetched(conn):
    """NULL means "not fetched"; 0 is a legitimate Lighthouse score. Storing
    them the same way would make an unmeasured site look like a broken one.
    """
    insert_cwv(conn, _cwv_row(url="https://example.com/zero", lh_performance=0.0))
    insert_cwv(conn, _cwv_row(url="https://example.com/absent", lh_performance=None))

    scored = conn.execute(
        "SELECT lh_performance FROM cwv_snapshots WHERE url=?",
        ("https://example.com/zero",),
    ).fetchone()[0]
    unfetched = conn.execute(
        "SELECT lh_performance FROM cwv_snapshots WHERE url=?",
        ("https://example.com/absent",),
    ).fetchone()[0]

    assert scored == 0.0
    assert unfetched is None
    assert scored != unfetched


# ---------------------------------------------------------------------------
# Migration of an existing (pre-11d) database
# ---------------------------------------------------------------------------


def test_init_db_adds_lighthouse_columns_to_a_legacy_cwv_table(tmp_path):
    db_path = tmp_path / "seo.db"
    _legacy_db(
        db_path,
        rows=[
            (SITE, "https://example.com/", "2026-07-20T00:00:00+00:00",
             2100.0, 150.0, 0.05, "psi", "PHONE"),
        ],
    )

    conn = init_db(db_path)

    columns = {
        row[1] for row in conn.execute("PRAGMA table_info(cwv_snapshots)").fetchall()
    }
    assert {
        "lh_performance",
        "lh_accessibility",
        "lh_best_practices",
        "lh_seo",
    } <= columns

    # The pre-existing row survives and reads as "not fetched", not as zero.
    fetched = conn.execute(
        "SELECT lcp_p75, lh_performance, lh_accessibility, lh_best_practices, lh_seo "
        "FROM cwv_snapshots"
    ).fetchone()
    assert fetched == (2100.0, None, None, None, None)
    conn.close()


def test_init_db_dedupes_legacy_cwv_rows_and_makes_the_index_unique(tmp_path):
    """The legacy index is not UNIQUE, so an existing DB can already hold
    duplicate (site, url, captured_at) rows. Creating the unique index over
    them would fail; the migration must dedupe first, keeping the newest.
    """
    db_path = tmp_path / "seo.db"
    key = (SITE, "https://example.com/", "2026-07-20T00:00:00+00:00")
    _legacy_db(
        db_path,
        rows=[
            (*key, 2100.0, 150.0, 0.05, "psi", "PHONE"),
            (*key, 1800.0, 140.0, 0.04, "psi", "PHONE"),  # newest: wins
            (SITE, "https://example.com/other", "2026-07-20T00:00:00+00:00",
             3000.0, 200.0, 0.10, "psi", "PHONE"),
        ],
    )

    conn = init_db(db_path)

    rows = conn.execute(
        "SELECT url, lcp_p75 FROM cwv_snapshots ORDER BY url"
    ).fetchall()
    assert rows == [
        ("https://example.com/", 1800.0),
        ("https://example.com/other", 3000.0),
    ]
    assert _index_is_unique(
        conn, "cwv_snapshots", "idx_cwv_snapshots_site_url_captured_at"
    )
    conn.close()


def test_init_db_is_idempotent_over_an_already_migrated_db(tmp_path):
    db_path = tmp_path / "seo.db"
    _legacy_db(db_path)

    init_db(db_path).close()
    conn = init_db(db_path)

    columns = [
        row[1] for row in conn.execute("PRAGMA table_info(cwv_snapshots)").fetchall()
    ]
    # A second migration must not re-add (or duplicate) the new columns.
    assert columns.count("lh_performance") == 1
    assert _index_is_unique(
        conn, "cwv_snapshots", "idx_cwv_snapshots_site_url_captured_at"
    )
    conn.close()


# ---------------------------------------------------------------------------
# country_daily
# ---------------------------------------------------------------------------


def test_upsert_country_daily_same_key_twice_yields_one_updated_row(conn):
    row_v1 = {
        "site": SITE,
        "date": "2026-07-20",
        "country": "srb",
        "clicks": 5,
        "impressions": 50,
        "ctr": 0.1,
        "position": 12.0,
    }
    row_v2 = {**row_v1, "clicks": 7, "impressions": 70, "position": 11.0}

    upsert_country_daily(conn, [row_v1])
    upsert_country_daily(conn, [row_v2])

    rows = conn.execute(
        "SELECT clicks, impressions, ctr, position FROM country_daily"
    ).fetchall()
    assert rows == [(7, 70, 0.1, 11.0)]


def test_upsert_country_daily_keeps_one_row_per_country(conn):
    rows = [
        {
            "site": SITE,
            "date": "2026-07-20",
            "country": country,
            "clicks": 1,
            "impressions": 10,
            "ctr": 0.1,
            "position": 15.0,
        }
        for country in ("srb", "usa", "deu")
    ]
    upsert_country_daily(conn, rows)
    upsert_country_daily(conn, rows)

    count = conn.execute("SELECT COUNT(*) FROM country_daily").fetchone()[0]
    assert count == 3


def test_start_run_then_finish_run_records_one_run(conn):
    run_id = start_run(conn, SITE)
    assert isinstance(run_id, int)

    row = conn.execute(
        "SELECT site, status, finished_at, rows_written, error "
        "FROM collection_runs WHERE id=?",
        (run_id,),
    ).fetchone()
    assert row[0] == SITE
    assert row[1] == "running"
    assert row[2] is None

    finish_run(conn, run_id, status="success", error=None, rows=42)

    count = conn.execute("SELECT COUNT(*) FROM collection_runs").fetchone()[0]
    assert count == 1

    row = conn.execute(
        "SELECT status, error, rows_written, finished_at, started_at "
        "FROM collection_runs WHERE id=?",
        (run_id,),
    ).fetchone()
    status, error, rows_written, finished_at, started_at = row
    assert status == "success"
    assert error is None
    assert rows_written == 42
    assert finished_at is not None
    assert started_at is not None


def test_finish_run_records_error(conn):
    run_id = start_run(conn, SITE)
    finish_run(conn, run_id, status="failed", error="boom", rows=0)

    row = conn.execute(
        "SELECT status, error, rows_written FROM collection_runs WHERE id=?",
        (run_id,),
    ).fetchone()
    assert row == ("failed", "boom", 0)


def test_upsert_sites_is_idempotent(conn):
    row = {
        "property": SITE,
        "slug": "example",
        "display_name": "Example",
        "brand_token": "example",
        "updated_at": "2026-07-20T00:00:00+00:00",
    }

    upsert_sites(conn, [row])
    upsert_sites(conn, [row])

    rows = conn.execute("SELECT * FROM sites WHERE property=?", (SITE,)).fetchall()
    assert len(rows) == 1


def test_upsert_sites_second_run_updates_in_place(conn):
    row_v1 = {
        "property": SITE,
        "slug": "example",
        "display_name": "Example",
        "brand_token": "example",
        "updated_at": "2026-07-20T00:00:00+00:00",
    }
    row_v2 = {
        "property": SITE,
        "slug": "example-renamed",
        "display_name": "Example Renamed",
        "brand_token": "example2",
        "updated_at": "2026-07-21T00:00:00+00:00",
    }

    upsert_sites(conn, [row_v1])
    upsert_sites(conn, [row_v2])

    rows = conn.execute(
        "SELECT property, slug, display_name, brand_token, updated_at FROM sites"
    ).fetchall()

    assert len(rows) == 1
    assert rows[0] == (
        SITE,
        "example-renamed",
        "Example Renamed",
        "example2",
        "2026-07-21T00:00:00+00:00",
    )


def test_upsert_sites_multiple_rows_in_one_call(conn):
    rows = [
        {
            "property": SITE,
            "slug": "example",
            "display_name": "Example",
            "brand_token": "example",
            "updated_at": "2026-07-20T00:00:00+00:00",
        },
        {
            "property": "https://example.org/",
            "slug": "example-org",
            "display_name": "Example Org",
            "brand_token": "exampleorg",
            "updated_at": "2026-07-20T00:00:00+00:00",
        },
    ]
    upsert_sites(conn, rows)

    count = conn.execute("SELECT COUNT(*) FROM sites").fetchone()[0]
    assert count == 2


def test_indexes_exist(conn):
    index_names = {
        row[0]
        for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='index'"
        ).fetchall()
    }
    # sqlite auto-names some indexes; check our explicit ones by table+cols
    # via PRAGMA index_list instead of hardcoding names.
    def cols_for(table):
        sets = []
        for idx in conn.execute(f"PRAGMA index_list({table})").fetchall():
            idx_name = idx[1]
            info = conn.execute(f"PRAGMA index_info({idx_name})").fetchall()
            sets.append(tuple(r[2] for r in info))
        return sets

    assert ("site", "date") in cols_for("totals_daily") or any(
        set(("site", "date")) <= set(c) for c in cols_for("totals_daily")
    )
    assert any(
        set(("site", "query", "date")) <= set(c) for c in cols_for("query_daily")
    )
    assert index_names  # sanity: at least some indexes were created


# --------------------------------------------------------------------------
# prune_demand_keywords (2026-07-27)
# --------------------------------------------------------------------------


def _demand_row(site, keyword, source, seed):
    return {
        "site": site,
        "keyword": keyword,
        "source": source,
        "seed": seed,
        "suggest_rank": 0,
        "rising_pct": None,
        "rising_label": None,
        "top_value": None,
        "volume": None,
        "first_seen": "2026-07-01T00:00:00+00:00",
        "last_seen": "2026-07-27T00:00:00+00:00",
    }


def test_prune_removes_keywords_from_retired_seeds_only(tmp_path):
    conn = init_db(tmp_path / "p.db")
    site = "https://skedio.rs/"
    upsert_demand_keywords(
        conn,
        [
            _demand_row(site, "cene goriva", "autocomplete", "cene"),
            _demand_row(site, "povratak zikine dinastije", "autocomplete", "povrat"),
            _demand_row(site, "aplikacija za zakazivanje termina", "autocomplete", "aplikacija za zakazivanje"),
        ],
    )

    removed = prune_demand_keywords(conn, site, "autocomplete", ["aplikacija za zakazivanje"])

    assert removed == 2
    remaining = [r[0] for r in conn.execute("SELECT keyword FROM demand_keywords")]
    assert remaining == ["aplikacija za zakazivanje termina"]


def test_prune_never_touches_a_different_source(tmp_path):
    """Autocomplete is free; Trends costs credits. A free prune must never
    delete metered data."""
    conn = init_db(tmp_path / "p.db")
    site = "https://skedio.rs/"
    upsert_demand_keywords(
        conn,
        [
            _demand_row(site, "cene goriva", "autocomplete", "cene"),
            _demand_row(site, "naocare", "serpapi_trends", "naocare"),
        ],
    )

    prune_demand_keywords(conn, site, "autocomplete", ["aplikacija za zakazivanje"])

    sources = sorted(r[0] for r in conn.execute("SELECT source FROM demand_keywords"))
    assert sources == ["serpapi_trends"]


def test_prune_never_touches_another_site(tmp_path):
    conn = init_db(tmp_path / "p.db")
    upsert_demand_keywords(
        conn,
        [
            _demand_row("https://skedio.rs/", "cene goriva", "autocomplete", "cene"),
            _demand_row("https://optikacajs.rs/", "naocare za sunce muske", "autocomplete", "naocare za sunce"),
        ],
    )

    prune_demand_keywords(conn, "https://skedio.rs/", "autocomplete", ["aplikacija za salon"])

    remaining = [r[0] for r in conn.execute("SELECT site FROM demand_keywords")]
    assert remaining == ["https://optikacajs.rs/"]


def test_prune_with_no_seeds_is_a_no_op_rather_than_deleting_everything(tmp_path):
    """An empty seed list means 'we did not run', not 'nothing is valid'.

    Deleting the site's whole keyword set because a discovery run produced
    no seeds would destroy good data on a configuration mistake.
    """
    conn = init_db(tmp_path / "p.db")
    site = "https://skedio.rs/"
    upsert_demand_keywords(conn, [_demand_row(site, "kw", "autocomplete", "seed")])

    assert prune_demand_keywords(conn, site, "autocomplete", []) == 0
    assert conn.execute("SELECT COUNT(*) FROM demand_keywords").fetchone()[0] == 1
