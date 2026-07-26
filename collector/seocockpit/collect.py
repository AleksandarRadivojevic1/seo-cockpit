"""Per-run collection orchestration for the seocockpit collector.

Ties together ``config``, ``db``, ``gsc``, and ``cwv`` into a single
``collect_once`` call: for each configured site, fetch GSC Search Analytics
for a date window (offset by GSC's finalization lag) plus one current CWV
snapshot for the homepage, and write everything through ``db``. Each site
is wrapped in its own try/except so one site's failure is recorded and
skipped rather than aborting the whole run.

No scheduler, no CLI: this module only exposes ``collect_once`` (and the
small pure helpers it's built from) for a later task to call on a schedule.
"""

from __future__ import annotations

import datetime
import logging
from typing import Callable

from . import cwv as cwv_module
from . import db
from . import gsc as gsc_module
from .config import Config

logger = logging.getLogger(__name__)

# GSC's Search Analytics data isn't final for the most recent ~2-3 days, so
# every window ends this many days before "today".
LAG_DAYS = 3
# Incremental runs re-fetch a trailing window this wide (days), both to
# pick up the newly-finalized tail and to smooth over any missed runs.
INCREMENTAL_WINDOW_DAYS = 5
# Backfill runs fetch this many days of history in one go.
BACKFILL_DAYS = 90


def _date_range(mode: str, today: datetime.date) -> tuple[str, str]:
    """Compute the ``(start, end)`` ISO date strings for a collection run.

    ``end`` is ``today`` offset back by ``LAG_DAYS`` (GSC finalization lag).
    ``start`` is ``end`` offset back by ``INCREMENTAL_WINDOW_DAYS`` for
    ``mode="incremental"``, or ``BACKFILL_DAYS`` for ``mode="backfill"``.
    Pure function of ``today`` -- no I/O, so it's directly unit-testable.
    """
    end = today - datetime.timedelta(days=LAG_DAYS)
    window = BACKFILL_DAYS if mode == "backfill" else INCREMENTAL_WINDOW_DAYS
    start = end - datetime.timedelta(days=window)
    return start.isoformat(), end.isoformat()


def _homepage_url(property: str) -> str:
    """Derive the homepage URL to check CWV for, from a GSC property.

    A ``sc-domain:`` property (domain-property verification) has no URL of
    its own, so the domain is turned into its https homepage. A URL-prefix
    property (e.g. ``https://skedio.rs/``) already *is* a URL and is
    returned unchanged.

    Homepage only for now; top-page CWV (checking a site's highest-traffic
    pages rather than just "/") is a later enhancement.
    """
    if property.startswith("sc-domain:"):
        domain = property[len("sc-domain:") :]
        return f"https://{domain}/"
    return property


def collect_once(
    config: Config,
    mode: str = "incremental",
    *,
    conn=None,
    service=None,
    fetch_analytics: Callable | None = None,
    fetch_cwv_fn: Callable | None = None,
    today: datetime.date | None = None,
) -> list[dict]:
    """Run one collection pass over every site in ``config``.

    For each site (in order): fetch GSC Search Analytics for the mode's
    date window, upsert totals/query/page/country rows, fetch one current
    CWV snapshot for the homepage, and record a ``collection_runs`` row.
    Each site's body runs inside its own try/except -- one site raising is
    recorded as a ``"failed"`` run with the error message and does not
    prevent the remaining sites from being collected.

    The CWV fetch has a **second, nested** try/except of its own. A CWV
    failure leaves the run ``"success"`` with the GSC rows counted, and
    records the error separately (``cwv_error``, also written to the run's
    ``error`` column with a ``cwv:`` prefix) rather than discarding it.
    Search data is the point of this collector; failing a whole site's run
    because PageSpeed Insights timed out would both hide good data and,
    since 11d calls PSI on every fetch, happen often.

    Note on partial writes: the four GSC upserts self-commit
    individually (see ``db``). If a *later* write raises after an earlier
    one has committed (e.g. ``upsert_page_daily`` fails after
    ``upsert_totals`` succeeded), that site is marked ``"failed"`` with
    ``rows=0`` while the already-committed rows remain. This is benign and
    self-healing: the writes are idempotent upserts keyed by
    ``(site, date, ...)``, so the next successful run overwrites the
    partial data in place. No cross-table transaction is used here because
    ``db``'s functions each own their own commit.

    Dependency injection (all optional, defaulting to the real
    implementations) keeps tests off the network and real credentials:

    Args:
        config: Loaded ``Config`` (sites, db path, service account path).
        mode: ``"incremental"`` (trailing ``INCREMENTAL_WINDOW_DAYS``-day
            window) or ``"backfill"`` (trailing ``BACKFILL_DAYS``-day
            window).
        conn: An open ``sqlite3.Connection``. Defaults to
            ``db.init_db(config.db_path)``.
        service: An authenticated GSC API client. Defaults to
            ``gsc.build_service(config.service_account_path)`` -- built
            lazily (only if not injected) so tests that pass a mock
            ``service`` never trigger real auth.
        fetch_analytics: ``(service, property, start, end) ->
            SearchAnalytics``. Defaults to ``gsc.fetch_search_analytics``.
        fetch_cwv_fn: ``(url) -> CwvSnapshot | None``. Defaults to
            ``cwv.fetch_cwv``.
        today: The date to treat as "today" for date-window math. Defaults
            to ``datetime.date.today()``.

    Returns:
        A list of one dict per site, in config order:
        ``{"site": property, "status": "success"|"failed", "rows": int,
        "error": str | None, "cwv_error": str | None}``. ``rows`` is 0 for
        failed sites. A site with ``status="success"`` and a non-null
        ``cwv_error`` collected its search data but not its CWV snapshot.
    """
    if today is None:
        today = datetime.date.today()
    if conn is None:
        conn = db.init_db(config.db_path)
    if service is None:
        service = gsc_module.build_service(config.service_account_path)
    if fetch_analytics is None:
        fetch_analytics = gsc_module.fetch_search_analytics
    if fetch_cwv_fn is None:
        fetch_cwv_fn = cwv_module.fetch_cwv

    start, end = _date_range(mode, today)
    # One "now" timestamp for every CWV snapshot captured in this run,
    # derived from `today` (start-of-day UTC) rather than a fresh
    # datetime.now() per site, so all snapshots in a run share one
    # captured_at and the run is deterministic/testable end-to-end.
    captured_at = datetime.datetime(
        today.year, today.month, today.day, tzinfo=datetime.timezone.utc
    ).isoformat()

    db.upsert_sites(
        conn,
        (
            {
                "property": site.property,
                "slug": site.slug,
                "display_name": site.display_name,
                "brand_token": site.brand_token,
                "updated_at": captured_at,
            }
            for site in config.sites
        ),
    )

    results: list[dict] = []

    for site in config.sites:
        run_id = db.start_run(conn, site.property)
        try:
            sa = fetch_analytics(service, site.property, start, end)
            db.upsert_totals(conn, sa.totals)
            db.upsert_query_daily(conn, sa.by_query)
            db.upsert_page_daily(conn, sa.by_page)
            db.upsert_country_daily(conn, sa.by_country)

            rows_written = (
                len(sa.totals)
                + len(sa.by_query)
                + len(sa.by_page)
                + len(sa.by_country)
            )

            # Deliberately its own try/except, outside the GSC one: a CWV
            # failure must not condemn GSC rows that already committed.
            cwv_error: str | None = None
            try:
                snap = fetch_cwv_fn(_homepage_url(site.property))
                if snap is not None:
                    db.insert_cwv(conn, snap.to_db_row(site.property, captured_at))
                    rows_written += 1
            except Exception as e:  # noqa: BLE001 - isolate CWV from GSC
                cwv_error = f"cwv: {e}"
                logger.warning(
                    "CWV fetch failed for %s (GSC data still collected): %s",
                    site.property,
                    e,
                )

            db.finish_run(conn, run_id, "success", cwv_error, rows_written)
            results.append(
                {
                    "site": site.property,
                    "status": "success",
                    "rows": rows_written,
                    "error": cwv_error,
                    "cwv_error": cwv_error,
                }
            )
        except Exception as e:  # noqa: BLE001 - isolate one site's failure
            db.finish_run(conn, run_id, "failed", str(e), 0)
            results.append(
                {
                    "site": site.property,
                    "status": "failed",
                    "rows": 0,
                    "error": str(e),
                    "cwv_error": None,
                }
            )

    return results
