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

from . import notify
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

# Weekly digest slot: Monday 07:00 UTC, four hours after the daily collection
# so the week's last run is already in the database when the digest reads it.
DIGEST_DAY_OF_WEEK = "mon"
DIGEST_HOUR = 7
DIGEST_MINUTE = 0


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


def _notify_problems(results: list[dict]) -> None:
    """Push an ntfy alert if this run had problems. Silent when it did not.

    Wrapped so that a notification bug can never turn a successful
    collection into a failed process: the data is already committed by the
    time this runs, and losing the alert is strictly better than losing the
    run.
    """
    try:
        config = notify.config_from_env()
        if config is None:
            logger.debug("ntfy not configured (NTFY_URL/NTFY_TOPIC unset); no alert sent")
            return
        if notify.alert_run_result(config, results):
            logger.info("ntfy problem alert sent")
    except Exception as e:  # pragma: no cover - defensive
        logger.warning("ntfy alerting raised, ignoring: %s", e)


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
        _notify_problems(results)

    scheduler.add_job(
        _job,
        CronTrigger(hour=hour, minute=minute, timezone=SCHEDULE_TIMEZONE),
        id="daily_incremental_collection",
        name="daily incremental collection",
    )

    scheduler.add_job(
        lambda: _digest_job(config),
        CronTrigger(
            day_of_week=DIGEST_DAY_OF_WEEK,
            hour=DIGEST_HOUR,
            minute=DIGEST_MINUTE,
            timezone=SCHEDULE_TIMEZONE,
        ),
        id="weekly_digest",
        name="weekly ntfy digest",
    )
    return scheduler


def _digest_job(config: Config) -> None:
    """Build and push the weekly digest. Never raises into the scheduler."""
    try:
        ntfy_config = notify.config_from_env()
        if ntfy_config is None:
            logger.debug("ntfy not configured; skipping weekly digest")
            return
        from . import db as db_module

        conn = db_module.init_db(config.db_path)
        if notify.send_weekly_digest(conn, config.sites, ntfy_config):
            logger.info("ntfy weekly digest sent")
    except Exception as e:  # pragma: no cover - defensive
        logger.warning("weekly digest raised, ignoring: %s", e)


def _run(config: Config, collect_fn: Callable, backfill: bool) -> int:
    mode = "backfill" if backfill else "incremental"
    logger.info("starting one-shot collection run: mode=%s", mode)
    results = collect_fn(config, mode)
    _log_summary(results)
    _notify_problems(results)
    return 0


def _digest(config: Config, dry_run: bool) -> int:
    """Send the weekly digest now, or print it without sending."""
    from . import db as db_module

    conn = db_module.init_db(config.db_path)
    title, message = notify.build_weekly_digest(conn, config.sites)

    if dry_run:
        print(title)
        print(message)
        return 0

    ntfy_config = notify.config_from_env()
    if ntfy_config is None:
        raise SystemExit(
            "ntfy is not configured: set NTFY_URL and NTFY_TOPIC "
            "(use --dry-run to preview the digest without sending)"
        )
    if not notify.send_weekly_digest(conn, config.sites, ntfy_config):
        raise SystemExit("digest could not be delivered; see the log above")
    logger.info("weekly digest sent")
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


# Keywords checked per `serp` run unless --limit says otherwise. Small on
# purpose: the SerpApi free plan is 250 searches/month and there are ~977
# candidate gap keywords, so a run that "just checks them all" would spend a
# month's budget four times over.
DEFAULT_SERP_LIMIT = 15


def _serp(
    config: Config,
    slug: str | None,
    limit: int,
    keywords_csv: str | None,
    dry_run: bool,
) -> int:
    """METERED SerpApi SERP checks -- 1 credit per keyword. Never scheduled."""
    import os

    from . import db as db_module
    from .demand import fold_diacritics
    from .serp import (
        SerpApiSearchSource,
        UnsupportedLocation,
        own_domain_for,
        select_gap_keywords,
        to_rows,
        validate_location,
    )

    api_key = os.environ.get("SERPAPI_KEY")
    if not api_key and not dry_run:
        raise SystemExit("SERPAPI_KEY is not set (use --dry-run to preview without it)")

    conn = db_module.init_db(config.db_path)
    sites = _sites_for(config, slug)

    explicit = None
    if keywords_csv:
        explicit = [k.strip() for k in keywords_csv.split(",") if k.strip()]

    # Validate every configured location BEFORE planning, let alone spending.
    # The locations endpoint is free.
    for site in sites:
        if site.serp_location:
            try:
                canonical = validate_location(site.serp_location)
            except UnsupportedLocation as e:
                raise SystemExit(f"site {site.slug}: {e}")
            if canonical != site.serp_location:
                logger.info(
                    "site=%s location %r -> canonical %r",
                    site.slug,
                    site.serp_location,
                    canonical,
                )

    plan: list[tuple] = []
    for site in sites:
        if explicit is not None:
            chosen = explicit[:limit]
        else:
            demand_rows = list(
                conn.execute(
                    "SELECT keyword, MIN(suggest_rank), MIN(seed) FROM demand_keywords "
                    "WHERE site = ? GROUP BY keyword",
                    (site.property,),
                )
            )
            if not demand_rows:
                logger.info(
                    "site=%s no demand keywords yet; run `discover` first", site.slug
                )
                continue
            chosen = select_gap_keywords(
                demand_rows,
                db_module.ever_ranked_queries(conn, site.property),
                fold_diacritics,
                limit,
            )
        if chosen:
            plan.append((site, chosen))

    planned = sum(len(k) for _, k in plan)
    if planned == 0:
        logger.info("nothing to check")
        return 0

    left = None
    if api_key:
        left = SerpApiSearchSource(api_key).searches_left()
    logger.info(
        "serp: %d keyword(s) across %d site(s); credits left: %s",
        planned,
        len(plan),
        left if left is not None else "unknown",
    )
    # `left` is None when the account endpoint could not be read. Unknown is
    # not zero, so it must not silently block a legitimate run -- but nor
    # should an unknown budget be spent unasked, hence the dry-run first.
    if left is not None and planned > left:
        raise SystemExit(f"refusing to run: {planned} checks > {left} credits remaining")

    if dry_run:
        for site, chosen in plan:
            location = site.serp_location or "country-level"
            print(f"{site.slug}  ({location})  {len(chosen)} credit(s)")
            for keyword in chosen:
                print(f"    {keyword}")
        print(f"\ntotal: {planned} credit(s); remaining: {left if left is not None else 'unknown'}")
        return 0

    checked = skipped = 0
    for site, chosen in plan:
        source = SerpApiSearchSource(api_key, location=site.serp_location)
        own_domain = own_domain_for(site.property)
        for keyword in chosen:
            check = source.check(keyword, own_domain)
            if check is None:
                # Failed lookups write NOTHING: a check row with no results
                # would read as "nobody ranks for this".
                skipped += 1
                continue
            check_row, result_rows = to_rows(site.property, check)
            db_module.insert_serp_check(conn, check_row, result_rows)
            checked += 1
            logger.info(
                "site=%s keyword=%r results=%d our_position=%s local_pack=%s",
                site.slug,
                keyword,
                len(check.results),
                check.our_position if check.our_position is not None else f"not in top {check.depth_checked}",
                check.local_pack,
            )
    logger.info("serp complete: %d checked, %d skipped after errors", checked, skipped)
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

    # Separate from `discover` for the same reason `trends` is: this one
    # costs money. 1 credit per keyword, 250/month on the free plan.
    serp_parser = subparsers.add_parser(
        "serp",
        help="Check who ranks for the keywords you're missing (METERED, 1 credit/keyword).",
    )
    serp_parser.add_argument("--site", help="Limit to one site slug.")
    serp_parser.add_argument(
        "--limit",
        type=int,
        default=DEFAULT_SERP_LIMIT,
        help=f"Max keywords per site (default {DEFAULT_SERP_LIMIT}).",
    )
    serp_parser.add_argument(
        "--keywords",
        help="Comma-separated keywords to check instead of the auto-selected gaps.",
    )
    serp_parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show exactly which keywords would be checked and the cost, then exit.",
    )

    digest_parser = subparsers.add_parser(
        "digest",
        help="Send the weekly ntfy digest now (also runs automatically Mondays 07:00 UTC).",
    )
    digest_parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the digest instead of sending it. Works without ntfy configured.",
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
    if args.command == "serp":
        return _serp(config, args.site, args.limit, args.keywords, args.dry_run)
    if args.command == "digest":
        return _digest(config, args.dry_run)

    parser.error(f"unknown command: {args.command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
