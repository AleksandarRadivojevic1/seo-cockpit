"""Scheduler entrypoint and CLI for the seocockpit collector.

Wires ``collect_once`` up to two run modes:

- ``run [--backfill]``: a one-shot manual invocation -- load config, call
  ``collect_once`` exactly once, log a summary, and exit. This is the
  first-run / manual path: ``python -m seocockpit.schedule run --backfill``.
- ``serve``: the long-running container entrypoint -- build an APScheduler
  ``BlockingScheduler`` with a single daily cron job that calls
  ``collect_once(config, "incremental")``, then block on ``scheduler.start()``.

No fetching/DB logic lives here; everything is delegated to ``collect_once``.
"""

from __future__ import annotations

import argparse
import datetime
import logging
import sys
from typing import Callable

from apscheduler.schedulers.blocking import BlockingScheduler
from apscheduler.triggers.cron import CronTrigger

from .collect import collect_once
from .config import Config, load_config

logger = logging.getLogger(__name__)

# Default daily run time, in UTC (see SCHEDULE_TIMEZONE): early morning,
# well after GSC's data finalizes for the previous day and outside any
# expected traffic/maintenance window.
DEFAULT_HOUR = 3
DEFAULT_MINUTE = 0

# Pin the cron trigger to UTC rather than inheriting APScheduler's default
# (the host's local zone). Every timestamp this collector writes is UTC, and
# the dashboard's health panel decides "did a run happen since the last
# expected slot" in UTC. On a Europe/Belgrade host the unpinned trigger fired
# at 01:00 UTC in summer and 02:00 UTC in winter, so the panel could not tell
# a missed run from a clock offset.
SCHEDULE_TIMEZONE = datetime.timezone.utc


def _log_summary(results: list[dict]) -> None:
    """Log one line per site plus a totals line, at INFO."""
    for r in results:
        logger.info(
            "site=%s status=%s rows=%s error=%s",
            r["site"],
            r["status"],
            r["rows"],
            r["error"],
        )
    succeeded = sum(1 for r in results if r["status"] == "success")
    failed = len(results) - succeeded
    logger.info("collection run complete: %d succeeded, %d failed", succeeded, failed)


def build_scheduler(
    config: Config,
    collect_fn: Callable = collect_once,
    *,
    hour: int = DEFAULT_HOUR,
    minute: int = DEFAULT_MINUTE,
) -> BlockingScheduler:
    """Build (but do not start) a ``BlockingScheduler`` with one daily job.

    The job calls ``collect_fn(config, "incremental")`` at ``hour:minute``
    **UTC** every day (see ``SCHEDULE_TIMEZONE``). The caller is responsible
    for calling ``.start()`` -- this function never blocks, which keeps it
    directly unit-testable.
    """
    scheduler = BlockingScheduler()

    def _job() -> None:
        results = collect_fn(config, "incremental")
        _log_summary(results)

    scheduler.add_job(
        _job,
        CronTrigger(hour=hour, minute=minute, timezone=SCHEDULE_TIMEZONE),
        id="daily_incremental_collection",
        name="daily incremental collection",
    )
    return scheduler


def _run(config: Config, collect_fn: Callable, backfill: bool) -> int:
    mode = "backfill" if backfill else "incremental"
    logger.info("starting one-shot collection run: mode=%s", mode)
    results = collect_fn(config, mode)
    _log_summary(results)
    return 0


def _sites_for(config: Config, slug: str | None):
    if slug is None:
        return config.sites
    matches = [s for s in config.sites if s.slug == slug]
    if not matches:
        raise SystemExit(f"no site with slug {slug!r} in the config")
    return matches


def _discover(config: Config, slug: str | None) -> int:
    """Free autocomplete discovery. Seeds come from each site's own pages."""
    from . import db as db_module
    from .demand import AutocompleteSource, discover, seeds_from_pages

    conn = db_module.init_db(config.db_path)
    total = 0
    for site in _sites_for(config, slug):
        pages = [
            row[0]
            for row in conn.execute(
                "SELECT DISTINCT page FROM page_daily WHERE site = ?", (site.property,)
            )
        ]
        seeds = seeds_from_pages(pages)
        if not seeds:
            logger.info("site=%s no seeds derivable from page_daily yet", site.slug)
            continue
        rows = discover(site.property, [AutocompleteSource()], seeds)
        db_module.upsert_demand_keywords(conn, rows)
        total += len(rows)
        logger.info("site=%s seeds=%d keywords=%d", site.slug, len(seeds), len(rows))
    logger.info("discovery complete: %d keyword rows", total)
    return 0


def _trends(config: Config, slug: str | None, dry_run: bool) -> int:
    """METERED SerpApi Trends. Never runs on a schedule -- see the CLI help."""
    import os

    from . import db as db_module
    from .demand import SerpApiTrendsSource, discover

    api_key = os.environ.get("SERPAPI_KEY")
    if not api_key:
        raise SystemExit("SERPAPI_KEY is not set")

    source = SerpApiTrendsSource(api_key)
    left = source.searches_left()
    sites = [s for s in _sites_for(config, slug) if s.trend_seeds]
    planned = sum(len(s.trend_seeds) for s in sites)

    # `left` is None when the account endpoint could not be read. That is
    # "unknown", not "zero", so it must not silently block a legitimate run --
    # but spending an unknown budget unasked is worse, so a dry-run is
    # required to proceed in that case.
    logger.info(
        "trends: %d seeds across %d site(s); credits left: %s",
        planned,
        len(sites),
        left if left is not None else "unknown",
    )
    if left is not None and planned > left:
        raise SystemExit(f"refusing to run: {planned} seeds > {left} credits remaining")
    if dry_run:
        for site in sites:
            logger.info("would query site=%s seeds=%s", site.slug, list(site.trend_seeds))
        return 0

    conn = db_module.init_db(config.db_path)
    for site in sites:
        rows = discover(site.property, [source], site.trend_seeds)
        db_module.upsert_demand_keywords(conn, rows)
        # Empty is the normal below-the-floor result, not a failure.
        logger.info("site=%s seeds=%d keywords=%d", site.slug, len(site.trend_seeds), len(rows))
    return 0


def _serve(config: Config, collect_fn: Callable, scheduler_factory: Callable) -> int:
    logger.info(
        "starting scheduler: daily incremental collection at %02d:%02d",
        DEFAULT_HOUR,
        DEFAULT_MINUTE,
    )
    scheduler = scheduler_factory(config, collect_fn)
    scheduler.start()
    return 0


def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m seocockpit.schedule",
        description="seocockpit collector: one-shot run or long-running scheduler.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    run_parser = subparsers.add_parser(
        "run", help="Run one collection pass and exit."
    )
    run_parser.add_argument(
        "--backfill",
        action="store_true",
        help="Fetch the full backfill window instead of the incremental one.",
    )

    subparsers.add_parser(
        "serve", help="Start the long-running daily scheduler (blocks)."
    )

    discover_parser = subparsers.add_parser(
        "discover",
        help="Discover market-demand keywords via Google autocomplete (free).",
    )
    discover_parser.add_argument(
        "--site",
        help="Limit to one site slug. Default: every configured site.",
    )

    # Deliberately a separate command rather than part of `run`: the SerpApi
    # free plan is 250 searches/month and a scheduled job across several
    # seeds would exhaust it without being asked.
    trends_parser = subparsers.add_parser(
        "trends",
        help="Fetch rising Google Trends queries via SerpApi (METERED, 1 credit/seed).",
    )
    trends_parser.add_argument(
        "--site",
        help="Limit to one site slug. Default: every site with trend_seeds.",
    )
    trends_parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show which seeds would be queried and the remaining credits, and exit.",
    )

    return parser


def main(
    argv: list[str] | None = None,
    *,
    config: Config | None = None,
    collect_fn: Callable = collect_once,
    scheduler_factory: Callable = build_scheduler,
) -> int:
    """CLI entrypoint. Returns a process exit code.

    ``config``, ``collect_fn``, and ``scheduler_factory`` are injectable so
    tests can drive ``run``/``serve`` without real config, network, or a
    blocking scheduler. When ``config`` is not injected, it is loaded via
    ``load_config()``.
    """
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    parser = _build_arg_parser()
    args = parser.parse_args(argv if argv is not None else sys.argv[1:])

    if config is None:
        config = load_config()

    if args.command == "run":
        return _run(config, collect_fn, backfill=args.backfill)
    if args.command == "serve":
        return _serve(config, collect_fn, scheduler_factory)
    if args.command == "discover":
        return _discover(config, args.site)
    if args.command == "trends":
        return _trends(config, args.site, args.dry_run)

    parser.error(f"unknown command: {args.command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
