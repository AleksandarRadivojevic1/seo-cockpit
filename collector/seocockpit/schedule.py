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
import logging
import sys
from typing import Callable

from apscheduler.schedulers.blocking import BlockingScheduler
from apscheduler.triggers.cron import CronTrigger

from .collect import collect_once
from .config import Config, load_config

logger = logging.getLogger(__name__)

# Default daily run time (server-local time, per APScheduler's default
# scheduler timezone): early morning, well after GSC's data finalizes for
# the previous day and outside any expected traffic/maintenance window.
DEFAULT_HOUR = 3
DEFAULT_MINUTE = 0


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
    every day. The caller is responsible for calling ``.start()`` -- this
    function never blocks, which keeps it directly unit-testable.
    """
    scheduler = BlockingScheduler()

    def _job() -> None:
        results = collect_fn(config, "incremental")
        _log_summary(results)

    scheduler.add_job(
        _job,
        CronTrigger(hour=hour, minute=minute),
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

    parser.error(f"unknown command: {args.command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
