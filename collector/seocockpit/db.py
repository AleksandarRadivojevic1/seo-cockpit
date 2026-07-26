"""SQLite storage layer for the seocockpit collector.

Schema (per DESIGN.md):

- ``totals_daily``      PK (site, date)
- ``query_daily``       PK (site, date, query)
- ``page_daily``        PK (site, date, page)
- ``country_daily``     PK (site, date, country)
- ``cwv_snapshots``     one row per (site, url, captured_at), UNIQUE-indexed
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

CREATE TABLE IF NOT EXISTS country_daily (
    site TEXT NOT NULL,
    date TEXT NOT NULL,
    country TEXT NOT NULL,
    clicks INTEGER,
    impressions INTEGER,
    ctr REAL,
    position REAL,
    PRIMARY KEY (site, date, country)
);

CREATE TABLE IF NOT EXISTS cwv_snapshots (
    site TEXT NOT NULL,
    url TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    lcp_p75 REAL,
    inp_p75 REAL,
    cls_p75 REAL,
    source TEXT NOT NULL,
    form_factor TEXT,
    lh_performance REAL,
    lh_accessibility REAL,
    lh_best_practices REAL,
    lh_seo REAL
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

-- Market demand: keywords people search that this site may or may not rank
-- for. Distinct from query_daily, which can ONLY contain queries the site
-- already appeared for -- Search Console structurally cannot report demand
-- you are absent from, which is the whole reason this table exists.
--
-- Keyed on (site, keyword, source) so the same keyword found by two sources
-- keeps both provenances rather than one overwriting the other.
--
-- EVERY MEASURE IS NULLABLE AND NULL MEANS "NOT MEASURED":
--   volume       -- no free source provides it; NULL until one is wired in.
--   rising_pct   -- percent growth from Google Trends.
--   suggest_rank -- position in the autocomplete list, a weak popularity
--                   proxy and explicitly not a volume.
-- A 0 in any of them would be a measurement of zero, which is a different
-- and much stronger claim.
CREATE TABLE IF NOT EXISTS demand_keywords (
    site         TEXT NOT NULL,
    keyword      TEXT NOT NULL,
    source       TEXT NOT NULL,
    seed         TEXT,
    -- Rank within the source's own ordering (0-based). Google returns
    -- autocomplete roughly by popularity, so this orders results without
    -- claiming a magnitude.
    suggest_rank INTEGER,
    -- Google Trends "rising" growth. `rising_label` carries the raw value
    -- because Trends reports either a percentage OR the literal "Breakout"
    -- (>5000% growth), and coercing Breakout to a number would invent
    -- precision. When the label is Breakout, rising_pct stays NULL.
    rising_pct   REAL,
    rising_label TEXT,
    -- Trends "top" relative interest, 0-100 within its own result set.
    top_value    REAL,
    volume       REAL,
    first_seen   TEXT NOT NULL,
    last_seen    TEXT NOT NULL,
    PRIMARY KEY (site, keyword, source)
);

CREATE INDEX IF NOT EXISTS idx_totals_daily_site_date
    ON totals_daily (site, date);

CREATE INDEX IF NOT EXISTS idx_query_daily_site_date
    ON query_daily (site, date);

CREATE INDEX IF NOT EXISTS idx_query_daily_site_query_date
    ON query_daily (site, query, date);

CREATE INDEX IF NOT EXISTS idx_page_daily_site_date
    ON page_daily (site, date);

CREATE INDEX IF NOT EXISTS idx_country_daily_site_date
    ON country_daily (site, date);

CREATE INDEX IF NOT EXISTS idx_demand_keywords_site_source
    ON demand_keywords (site, source);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cwv_snapshots_site_url_captured_at
    ON cwv_snapshots (site, url, captured_at);
"""

_CWV_INDEX = "idx_cwv_snapshots_site_url_captured_at"

# Lighthouse category scores, added to cwv_snapshots in Task 11d. All
# nullable REAL 0-100: NULL means "not fetched", and 0 is a legitimate
# Lighthouse score -- never conflate them.
_CWV_LIGHTHOUSE_COLUMNS = (
    "lh_performance",
    "lh_accessibility",
    "lh_best_practices",
    "lh_seo",
)


def _table_exists(conn: sqlite3.Connection, table: str) -> bool:
    return (
        conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
        ).fetchone()
        is not None
    )


def _migrate_cwv_snapshots(conn: sqlite3.Connection) -> None:
    """Bring a pre-Task-11d ``cwv_snapshots`` table up to the current schema.

    ``_SCHEMA`` is all ``IF NOT EXISTS``, so it cannot alter a table that
    already exists -- an existing ``seo.db`` would keep the old column set
    and, worse, keep the old *non-unique* index under the name the new
    ``CREATE UNIQUE INDEX IF NOT EXISTS`` expects, silently leaving
    duplicates possible. This runs before ``_SCHEMA`` and is a no-op on a
    fresh database.

    Three steps, in this order:

    1. Add any missing Lighthouse category columns. They are nullable, so
       rows collected before 11d correctly read as "not fetched".
    2. Drop the index if it exists and is not UNIQUE (the pre-11d shape).
    3. De-duplicate ``(site, url, captured_at)``, keeping the highest
       ``rowid`` -- the most recently written row, matching the
       last-write-wins semantics ``insert_cwv`` now has. Without this the
       unique index in ``_SCHEMA`` would fail to create on any database
       that already accumulated duplicates.
    """
    if not _table_exists(conn, "cwv_snapshots"):
        return

    existing = {
        row[1] for row in conn.execute("PRAGMA table_info(cwv_snapshots)").fetchall()
    }
    for column in _CWV_LIGHTHOUSE_COLUMNS:
        if column not in existing:
            conn.execute(f"ALTER TABLE cwv_snapshots ADD COLUMN {column} REAL")

    for _seq, name, unique, *_rest in conn.execute(
        "PRAGMA index_list(cwv_snapshots)"
    ).fetchall():
        if name == _CWV_INDEX and not unique:
            conn.execute(f"DROP INDEX {_CWV_INDEX}")

    conn.execute(
        """
        DELETE FROM cwv_snapshots
        WHERE rowid NOT IN (
            SELECT MAX(rowid) FROM cwv_snapshots
            GROUP BY site, url, captured_at
        )
        """
    )
    conn.commit()


def init_db(path: str | Path) -> sqlite3.Connection:
    """Create the schema at ``path`` if it doesn't already exist.

    Idempotent: safe to call repeatedly against the same file (uses
    ``CREATE TABLE/INDEX IF NOT EXISTS``, and the migration below checks
    before it changes anything). Ensures the parent directory exists.
    Returns an open connection to the database, ready for use by the other
    functions in this module.
    """
    db_path = Path(path)
    db_path.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(db_path)
    _migrate_cwv_snapshots(conn)
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


def upsert_country_daily(conn: sqlite3.Connection, rows: Iterable[Mapping]) -> None:
    """Upsert rows into ``country_daily``, keyed on (site, date, country).

    Each row is a mapping with keys: site, date, country, clicks,
    impressions, ctr, position. ``country`` is GSC's lowercase ISO-3166-1
    alpha-3 code (``srb``, ``usa``), stored verbatim.
    """
    conn.executemany(
        """
        INSERT INTO country_daily (site, date, country, clicks, impressions, ctr, position)
        VALUES (:site, :date, :country, :clicks, :impressions, :ctr, :position)
        ON CONFLICT (site, date, country) DO UPDATE SET
            clicks = excluded.clicks,
            impressions = excluded.impressions,
            ctr = excluded.ctr,
            position = excluded.position
        """,
        list(rows),
    )
    conn.commit()


def upsert_demand_keywords(conn: sqlite3.Connection, rows: Iterable[Mapping]) -> None:
    """Upsert rows into ``demand_keywords``, keyed on (site, keyword, source).

    Each row is a mapping with keys: site, keyword, source, seed,
    suggest_rank, rising_pct, rising_label, top_value, volume, first_seen,
    last_seen.

    ``first_seen`` is preserved on conflict and only ``last_seen`` advances,
    so a keyword's age is real history rather than the timestamp of the most
    recent run. That is what makes "this term has been showing up for three
    months" a statement the data can support.

    The measure columns are overwritten wholesale, including with NULL: a
    source that stops reporting a value must not leave a stale number behind
    looking like a current measurement.
    """
    conn.executemany(
        """
        INSERT INTO demand_keywords (
            site, keyword, source, seed, suggest_rank,
            rising_pct, rising_label, top_value, volume,
            first_seen, last_seen
        )
        VALUES (
            :site, :keyword, :source, :seed, :suggest_rank,
            :rising_pct, :rising_label, :top_value, :volume,
            :first_seen, :last_seen
        )
        ON CONFLICT (site, keyword, source) DO UPDATE SET
            seed = excluded.seed,
            suggest_rank = excluded.suggest_rank,
            rising_pct = excluded.rising_pct,
            rising_label = excluded.rising_label,
            top_value = excluded.top_value,
            volume = excluded.volume,
            last_seen = excluded.last_seen
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
    """Write one CWV snapshot into ``cwv_snapshots``, replacing by key.

    Snapshots are a history *across days*: one row per
    ``(site, url, captured_at)``. ``captured_at`` is start-of-day UTC, so
    two collection runs on the same day address the same row -- the second
    replaces the first rather than duplicating it (the index is UNIQUE).

    Row keys: site, url, captured_at, lcp_p75, inp_p75, cls_p75 (all three
    may be None), source ('crux' or 'psi', describing the origin of the
    *field* metrics), form_factor, and the four Lighthouse category scores
    lh_performance / lh_accessibility / lh_best_practices / lh_seo (0-100,
    always from PSI regardless of ``source``; None means not fetched).
    """
    conn.execute(
        """
        INSERT OR REPLACE INTO cwv_snapshots
            (site, url, captured_at, lcp_p75, inp_p75, cls_p75, source, form_factor,
             lh_performance, lh_accessibility, lh_best_practices, lh_seo)
        VALUES (:site, :url, :captured_at, :lcp_p75, :inp_p75, :cls_p75, :source,
                :form_factor, :lh_performance, :lh_accessibility, :lh_best_practices,
                :lh_seo)
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
