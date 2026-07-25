import sqlite3

import pytest

from seocockpit.db import (
    finish_run,
    init_db,
    insert_cwv,
    start_run,
    upsert_page_daily,
    upsert_query_daily,
    upsert_sites,
    upsert_totals,
)

SITE = "sc-domain:example.com"


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


def test_insert_cwv_appends_rows_without_upsert(conn):
    row = {
        "site": SITE,
        "url": "https://example.com/",
        "captured_at": "2026-07-20T00:00:00",
        "lcp_p75": 2.1,
        "inp_p75": 150.0,
        "cls_p75": 0.05,
        "source": "crux",
        "form_factor": "PHONE",
    }
    insert_cwv(conn, row)
    insert_cwv(conn, row)

    count = conn.execute("SELECT COUNT(*) FROM cwv_snapshots").fetchone()[0]
    assert count == 2


def test_insert_cwv_allows_null_metrics(conn):
    row = {
        "site": SITE,
        "url": "https://example.com/",
        "captured_at": "2026-07-20T00:00:00",
        "lcp_p75": None,
        "inp_p75": None,
        "cls_p75": None,
        "source": "psi",
        "form_factor": "PHONE",
    }
    insert_cwv(conn, row)

    fetched = conn.execute(
        "SELECT lcp_p75, inp_p75, cls_p75 FROM cwv_snapshots"
    ).fetchone()
    assert fetched == (None, None, None)


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
