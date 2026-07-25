"""SQLite storage layer for the seocockpit collector.

Schema (per DESIGN.md):

- ``totals_daily``      PK (site, date)
- ``query_daily``       PK (site, date, query)
- ``page_daily``        PK (site, date, page)
- ``cwv_snapshots``     append-only, no PK (site, url, captured_at) grain
- ``collection_runs``   id INTEGER PRIMARY KEY AUTOINCREMENT
- ``sites``             PK (property); display metadata for the dashboard

``site`` (in every table above except ``sites``) is always the GSC property
string from ``Site.property`` (e.g. ``sc-domain:alexrad.dev``) -- the stable
unique key the rest of the collector already has. ``sites`` carries the
``slug``/``display_name``/``brand_token`` from ``sites.yaml`` so the
dashboard container (which shares only the ``data/`` directory, not
``sites.yaml`` itself) can read them from the DB.

Connection management: every write/read function in this module takes an
already-open ``sqlite3.Connection`` and commits its own change. Callers own
the connection's lifetime (open it once per run, close it when done). The
only function that *opens* a connection is ``init_db``, which both creates
the schema (idempotently) and returns the connection for the caller to keep
using -- this keeps callers from having to import ``sqlite3`` directly just
to get started.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Mapping

_SCHEMA = """
CREATE TABLE IF NOT EXISTS totals_daily (
    site TEXT NOT NULL,
    date TEXT NOT NULL,
    clicks INTEGER,
    impressions INTEGER,
    ctr REAL,
    position REAL,
    PRIMARY KEY (site, date)
);

CREATE TABLE IF NOT EXISTS query_daily (
    site TEXT NOT NULL,
    date TEXT NOT NULL,
    query TEXT NOT NULL,
    clicks INTEGER,
    impressions INTEGER,
    ctr REAL,
    position REAL,
    PRIMARY KEY (site, date, query)
);

CREATE TABLE IF NOT EXISTS page_daily (
    site TEXT NOT NULL,
    date TEXT NOT NULL,
    page TEXT NOT NULL,
    clicks INTEGER,
    impressions INTEGER,
    ctr REAL,
    position REAL,
    PRIMARY KEY (site, date, page)
);

CREATE TABLE IF NOT EXISTS cwv_snapshots (
    site TEXT NOT NULL,
    url TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    lcp_p75 REAL,
    inp_p75 REAL,
    cls_p75 REAL,
    source TEXT NOT NULL,
    form_factor TEXT
);

CREATE TABLE IF NOT EXISTS sites (
    property     TEXT PRIMARY KEY,
    slug         TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    brand_token  TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collection_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    rows_written INTEGER,
    status TEXT NOT NULL,
    error TEXT
);

CREATE INDEX IF NOT EXISTS idx_totals_daily_site_date
    ON totals_daily (site, date);

CREATE INDEX IF NOT EXISTS idx_query_daily_site_date
    ON query_daily (site, date);

CREATE INDEX IF NOT EXISTS idx_query_daily_site_query_date
    ON query_daily (site, query, date);

CREATE INDEX IF NOT EXISTS idx_page_daily_site_date
    ON page_daily (site, date);

CREATE INDEX IF NOT EXISTS idx_cwv_snapshots_site_url_captured_at
    ON cwv_snapshots (site, url, captured_at);
"""


def init_db(path: str | Path) -> sqlite3.Connection:
    """Create the schema at ``path`` if it doesn't already exist.

    Idempotent: safe to call repeatedly against the same file (uses
    ``CREATE TABLE/INDEX IF NOT EXISTS``). Ensures the parent directory
    exists. Returns an open connection to the database, ready for use by
    the other functions in this module.
    """
    db_path = Path(path)
    db_path.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(db_path)
    conn.executescript(_SCHEMA)
    conn.commit()
    return conn


def upsert_totals(conn: sqlite3.Connection, rows: Iterable[Mapping]) -> None:
    """Upsert rows into ``totals_daily``, keyed on (site, date).

    Each row is a mapping with keys: site, date, clicks, impressions, ctr,
    position. Re-upserting the same (site, date) updates the existing row
    in place rather than creating a duplicate.
    """
    conn.executemany(
        """
        INSERT INTO totals_daily (site, date, clicks, impressions, ctr, position)
        VALUES (:site, :date, :clicks, :impressions, :ctr, :position)
        ON CONFLICT (site, date) DO UPDATE SET
            clicks = excluded.clicks,
            impressions = excluded.impressions,
            ctr = excluded.ctr,
            position = excluded.position
        """,
        list(rows),
    )
    conn.commit()


def upsert_query_daily(conn: sqlite3.Connection, rows: Iterable[Mapping]) -> None:
    """Upsert rows into ``query_daily``, keyed on (site, date, query).

    Each row is a mapping with keys: site, date, query, clicks, impressions,
    ctr, position. This is the core anti-duplication guarantee: re-upserting
    the same (site, date, query) leaves exactly one row with the latest
    values.
    """
    conn.executemany(
        """
        INSERT INTO query_daily (site, date, query, clicks, impressions, ctr, position)
        VALUES (:site, :date, :query, :clicks, :impressions, :ctr, :position)
        ON CONFLICT (site, date, query) DO UPDATE SET
            clicks = excluded.clicks,
            impressions = excluded.impressions,
            ctr = excluded.ctr,
            position = excluded.position
        """,
        list(rows),
    )
    conn.commit()


def upsert_page_daily(conn: sqlite3.Connection, rows: Iterable[Mapping]) -> None:
    """Upsert rows into ``page_daily``, keyed on (site, date, page).

    Each row is a mapping with keys: site, date, page, clicks, impressions,
    ctr, position.
    """
    conn.executemany(
        """
        INSERT INTO page_daily (site, date, page, clicks, impressions, ctr, position)
        VALUES (:site, :date, :page, :clicks, :impressions, :ctr, :position)
        ON CONFLICT (site, date, page) DO UPDATE SET
            clicks = excluded.clicks,
            impressions = excluded.impressions,
            ctr = excluded.ctr,
            position = excluded.position
        """,
        list(rows),
    )
    conn.commit()


def upsert_sites(conn: sqlite3.Connection, rows: Iterable[Mapping]) -> None:
    """Upsert rows into ``sites``, keyed on ``property``.

    Each row is a mapping with keys: property, slug, display_name,
    brand_token, updated_at. Re-upserting the same ``property`` updates the
    existing row in place rather than creating a duplicate, so editing
    ``sites.yaml`` (display name, brand token, or slug) propagates on the
    next collection run.
    """
    conn.executemany(
        """
        INSERT INTO sites (property, slug, display_name, brand_token, updated_at)
        VALUES (:property, :slug, :display_name, :brand_token, :updated_at)
        ON CONFLICT (property) DO UPDATE SET
            slug = excluded.slug,
            display_name = excluded.display_name,
            brand_token = excluded.brand_token,
            updated_at = excluded.updated_at
        """,
        list(rows),
    )
    conn.commit()


def insert_cwv(conn: sqlite3.Connection, row: Mapping) -> None:
    """Insert one CWV snapshot into ``cwv_snapshots``.

    Append-only: snapshots are historical observations, not upserted. Row
    keys: site, url, captured_at, lcp_p75, inp_p75, cls_p75 (all three may
    be None), source ('crux' or 'psi'), form_factor.
    """
    conn.execute(
        """
        INSERT INTO cwv_snapshots
            (site, url, captured_at, lcp_p75, inp_p75, cls_p75, source, form_factor)
        VALUES (:site, :url, :captured_at, :lcp_p75, :inp_p75, :cls_p75, :source, :form_factor)
        """,
        dict(row),
    )
    conn.commit()


def start_run(conn: sqlite3.Connection, site: str) -> int:
    """Insert a new ``collection_runs`` row for ``site`` and return its id.

    Sets ``started_at`` to the current UTC time (ISO 8601) and ``status``
    to ``'running'``. ``finished_at``, ``rows_written``, and ``error`` are
    left null until ``finish_run`` is called.
    """
    started_at = datetime.now(timezone.utc).isoformat()
    cursor = conn.execute(
        """
        INSERT INTO collection_runs (site, started_at, status)
        VALUES (?, ?, 'running')
        """,
        (site, started_at),
    )
    conn.commit()
    return cursor.lastrowid


def finish_run(
    conn: sqlite3.Connection,
    run_id: int,
    status: str,
    error: str | None,
    rows: int | None,
) -> None:
    """Mark a ``collection_runs`` row as finished.

    Sets ``finished_at`` to the current UTC time (ISO 8601) and updates
    ``status``, ``error``, and ``rows_written`` on the row identified by
    ``run_id`` (as returned by ``start_run``).
    """
    finished_at = datetime.now(timezone.utc).isoformat()
    conn.execute(
        """
        UPDATE collection_runs
        SET finished_at = ?, status = ?, error = ?, rows_written = ?
        WHERE id = ?
        """,
        (finished_at, status, error, rows, run_id),
    )
    conn.commit()
