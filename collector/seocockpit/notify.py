"""ntfy push notifications for the collector.

Two kinds of message, and deliberately no third:

- **Problems, immediately.** A site whose collection failed, or which
  collected search data but not its CWV snapshot. These are the events the
  dashboard's health panel can only report to someone who thinks to look at
  it, which is exactly the person who has no reason to suspect anything.
- **A weekly digest.** One message a week with each site's movement.

A per-run "all good" message was considered and rejected: 365 identical
notifications a year train you to ignore the channel, which costs you the
one message that mattered. The weekly digest carries the same "still alive"
signal at a frequency you will still read.

Notification failure must never affect collection. Every publish is wrapped
and returns a bool; the caller logs and moves on. A run that collected data
but could not tell you about it still collected the data.
"""

from __future__ import annotations

import datetime
import json
import logging
import os
import sqlite3
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Callable, Iterable, Mapping

logger = logging.getLogger(__name__)

# ntfy priorities. 4 ("high") buzzes a phone; 3 ("default") does not.
PRIORITY_HIGH = 4
PRIORITY_DEFAULT = 3
PRIORITY_LOW = 2


@dataclass(frozen=True)
class NtfyConfig:
    """Where to publish. Built from the environment so no secret is in git."""

    url: str
    topic: str
    token: str | None = None

    @property
    def endpoint(self) -> str:
        return f"{self.url}/{self.topic}"


def config_from_env(env: Mapping[str, str] | None = None) -> NtfyConfig | None:
    """Read NTFY_URL / NTFY_TOPIC / NTFY_TOKEN.

    Returns ``None`` when either required variable is missing, which means
    "alerts are switched off" -- not an error. A collector without ntfy
    configured must still collect, so callers treat ``None`` as a no-op
    rather than a failure.
    """
    source = os.environ if env is None else env
    url = (source.get("NTFY_URL") or "").strip().rstrip("/")
    topic = (source.get("NTFY_TOPIC") or "").strip()
    if not url or not topic:
        return None
    token = (source.get("NTFY_TOKEN") or "").strip() or None
    return NtfyConfig(url=url, topic=topic, token=token)


def _post(url: str, data: bytes, headers: dict[str, str], timeout: int = 15) -> None:
    request = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(request, timeout=timeout):
        return None


def publish(
    config: NtfyConfig | None,
    *,
    title: str,
    message: str,
    priority: int = PRIORITY_DEFAULT,
    tags: Iterable[str] = (),
    post: Callable[..., None] | None = None,
) -> bool:
    """Send one notification. Never raises.

    Returns True when the push was accepted, False when it was skipped
    (alerts not configured) or failed. The distinction between "skipped" and
    "failed" is in the log, not the return value -- callers do not branch on
    it, they only report it.
    """
    if config is None:
        return False

    headers = {
        "Title": title,
        "Priority": str(priority),
        "Content-Type": "text/plain; charset=utf-8",
    }
    if tags:
        headers["Tags"] = ",".join(tags)
    if config.token:
        headers["Authorization"] = f"Bearer {config.token}"

    sender = post or _post
    try:
        sender(config.endpoint, message.encode("utf-8"), headers)
        return True
    except (urllib.error.URLError, OSError, ValueError) as e:
        # Deliberately swallowed: an unreachable ntfy must not fail a
        # collection run that otherwise succeeded.
        logger.warning("ntfy publish failed (%s): %s", config.endpoint, e)
        return False


def summarize_failures(results: list[dict]) -> tuple[str, str, int] | None:
    """Build a problem alert from ``collect_once`` results, or None if clean.

    Returns ``(title, message, priority)``. ``None`` means every site
    succeeded with no CWV error -- the silent case, which is the normal one.

    A failed site outranks a CWV-degraded one: losing search data is losing
    the product, losing a CWV snapshot is losing one number that the next
    run will refetch.
    """
    failed = [r for r in results if r.get("status") == "failed"]
    degraded = [r for r in results if r.get("status") == "success" and r.get("cwv_error")]

    if not failed and not degraded:
        return None

    # Formatting note from the real ntfy client: it COLLAPSES leading
    # whitespace, so column alignment does not survive and indented
    # continuation lines run into their heading. Blank-line-separated blocks
    # with a label on each line render correctly everywhere.
    blocks: list[str] = []
    for r in failed:
        blocks.append(f"FAILED: {r['site']}\n{r.get('error') or 'no error recorded'}")
    for r in degraded:
        blocks.append(f"SEARCH DATA OK, CWV FAILED: {r['site']}\n{r['cwv_error']}")

    succeeded = sum(1 for r in results if r.get("status") == "success")
    blocks.append(f"{succeeded}/{len(results)} sites collected search data.")

    if failed:
        title = f"seo-cockpit: {len(failed)} site(s) failed"
        priority = PRIORITY_HIGH
    else:
        title = f"seo-cockpit: CWV degraded on {len(degraded)} site(s)"
        priority = PRIORITY_DEFAULT

    return title, "\n\n".join(blocks), priority


def alert_run_result(
    config: NtfyConfig | None,
    results: list[dict],
    *,
    post: Callable[..., None] | None = None,
) -> bool:
    """Push a problem alert if this run had problems. Silent when clean."""
    summary = summarize_failures(results)
    if summary is None:
        return False
    title, message, priority = summary
    return publish(
        config,
        title=title,
        message=message,
        priority=priority,
        tags=["warning"],
        post=post,
    )


def _window_totals(
    conn: sqlite3.Connection, site: str, start: str, end: str
) -> tuple[int, int, int]:
    """(clicks, impressions, days_with_rows) over an inclusive date range."""
    row = conn.execute(
        """
        SELECT COALESCE(SUM(clicks), 0), COALESCE(SUM(impressions), 0), COUNT(*)
        FROM totals_daily WHERE site = ? AND date BETWEEN ? AND ?
        """,
        (site, start, end),
    ).fetchone()
    return int(row[0]), int(row[1]), int(row[2])


def _delta_phrase(recent: int, prior: int, prior_days: int) -> str:
    """Describe a change without inventing a percentage from nothing.

    A percentage against a zero baseline is undefined, and a percentage
    against an *uncollected* baseline is a fabrication. Both are reported in
    words instead.
    """
    if prior_days == 0:
        return f"{recent} (no prior week collected)"
    if prior == 0:
        return f"{recent} (up from 0)" if recent else "0 (unchanged)"
    pct = (recent - prior) / prior * 100
    return f"{recent} vs {prior} ({pct:+.0f}%)"


def build_weekly_digest(
    conn: sqlite3.Connection,
    sites: list,
    *,
    today: datetime.date | None = None,
) -> tuple[str, str]:
    """Build ``(title, message)`` for the weekly digest.

    Compares the last 7 collected days against the 7 before, per site, and
    lists any collection failures in the period. Pure read -- takes a
    connection rather than a path so tests drive it against an in-memory DB.
    """
    if today is None:
        today = datetime.date.today()

    # Mirror the collector's own GSC finalization lag so the digest never
    # compares a complete week against a partial one.
    end = today - datetime.timedelta(days=3)
    start = end - datetime.timedelta(days=6)
    prior_end = start - datetime.timedelta(days=1)
    prior_start = prior_end - datetime.timedelta(days=6)

    lines: list[str] = []
    for site in sites:
        clicks, impressions, days = _window_totals(
            conn, site.property, start.isoformat(), end.isoformat()
        )
        p_clicks, p_impressions, p_days = _window_totals(
            conn, site.property, prior_start.isoformat(), prior_end.isoformat()
        )

        # No indentation and no column padding anywhere: the ntfy client
        # collapses leading whitespace, so alignment silently disappears and
        # indented lines run into their heading. Blank lines separate sites.
        if days == 0:
            lines.append(f"{site.display_name}\nnothing collected this week")
            continue

        lines.append(
            f"{site.display_name}\n"
            f"impressions {_delta_phrase(impressions, p_impressions, p_days)}\n"
            f"clicks {_delta_phrase(clicks, p_clicks, p_days)}"
        )

    failures = conn.execute(
        """
        SELECT site, COUNT(*) FROM collection_runs
        WHERE status = 'failed' AND started_at >= ?
        GROUP BY site
        """,
        (start.isoformat(),),
    ).fetchall()
    if failures:
        lines.append("")
        for site_property, count in failures:
            lines.append(f"{count} failed run(s): {site_property}")

    title = f"seo-cockpit weekly: {start.isoformat()} to {end.isoformat()}"
    return title, "\n\n".join(lines)


def send_weekly_digest(
    conn: sqlite3.Connection,
    sites: list,
    config: NtfyConfig | None,
    *,
    today: datetime.date | None = None,
    post: Callable[..., None] | None = None,
) -> bool:
    title, message = build_weekly_digest(conn, sites, today=today)
    return publish(
        config,
        title=title,
        message=message,
        priority=PRIORITY_LOW,
        tags=["bar_chart"],
        post=post,
    )
