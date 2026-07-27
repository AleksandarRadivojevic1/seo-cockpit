"""Tests for ntfy alerting.

The load-bearing behaviours here are all about *not* doing things: not
sending when a run was clean, not crashing when ntfy is down, and not
inventing a percentage when there is no baseline to compare against.
"""

from __future__ import annotations

import datetime
import sqlite3

import pytest

from seocockpit import db as db_module
from seocockpit import notify


class Recorder:
    """Captures publish calls instead of hitting the network."""

    def __init__(self, raises: Exception | None = None) -> None:
        self.calls: list[tuple[str, bytes, dict]] = []
        self.raises = raises

    def __call__(self, url: str, data: bytes, headers: dict) -> None:
        if self.raises is not None:
            raise self.raises
        self.calls.append((url, data, headers))

    @property
    def body(self) -> str:
        return self.calls[0][1].decode("utf-8")

    @property
    def headers(self) -> dict:
        return self.calls[0][2]


CONFIG = notify.NtfyConfig(url="http://pi.local:8090", topic="seo-cockpit")


# --------------------------------------------------------------------------
# config_from_env
# --------------------------------------------------------------------------


def test_config_from_env_reads_url_topic_and_token():
    config = notify.config_from_env(
        {"NTFY_URL": "http://pi.local:8090/", "NTFY_TOPIC": "seo", "NTFY_TOKEN": "tk_abc"}
    )
    assert config == notify.NtfyConfig(url="http://pi.local:8090", topic="seo", token="tk_abc")
    assert config.endpoint == "http://pi.local:8090/seo"


@pytest.mark.parametrize(
    "env",
    [
        {},
        {"NTFY_URL": "http://pi.local:8090"},
        {"NTFY_TOPIC": "seo"},
        {"NTFY_URL": "", "NTFY_TOPIC": "seo"},
    ],
)
def test_config_from_env_returns_none_when_not_configured(env):
    # "Alerts are switched off" is a valid state, not an error -- a collector
    # with no ntfy must still collect.
    assert notify.config_from_env(env) is None


def test_token_is_omitted_from_headers_when_unset():
    recorder = Recorder()
    notify.publish(CONFIG, title="t", message="m", post=recorder)
    assert "Authorization" not in recorder.headers


# --------------------------------------------------------------------------
# publish
# --------------------------------------------------------------------------


def test_publish_is_a_noop_when_alerts_are_not_configured():
    recorder = Recorder()
    assert notify.publish(None, title="t", message="m", post=recorder) is False
    assert recorder.calls == []


def test_publish_never_raises_when_ntfy_is_unreachable():
    # An unreachable ntfy must not fail a collection run that succeeded.
    recorder = Recorder(raises=OSError("connection refused"))
    assert notify.publish(CONFIG, title="t", message="m", post=recorder) is False


def test_publish_sends_title_priority_and_tags_as_headers():
    recorder = Recorder()
    assert (
        notify.publish(
            CONFIG,
            title="seo-cockpit: 1 site failed",
            message="details",
            priority=notify.PRIORITY_HIGH,
            tags=["warning", "rotating_light"],
            post=recorder,
        )
        is True
    )
    url, data, headers = recorder.calls[0]
    assert url == "http://pi.local:8090/seo-cockpit"
    assert data == b"details"
    assert headers["Title"] == "seo-cockpit: 1 site failed"
    assert headers["Priority"] == "4"
    assert headers["Tags"] == "warning,rotating_light"


def test_publish_encodes_a_non_ascii_body_as_utf8():
    recorder = Recorder()
    notify.publish(CONFIG, title="t", message="tečnost za sočiva", post=recorder)
    assert recorder.body == "tečnost za sočiva"


# --------------------------------------------------------------------------
# summarize_failures -- the "stay silent" rule
# --------------------------------------------------------------------------


def _result(site, status="success", error=None, cwv_error=None, rows=10):
    return {"site": site, "status": status, "rows": rows, "error": error, "cwv_error": cwv_error}


def test_a_fully_successful_run_produces_no_alert_at_all():
    # THE rule for this feature. A daily "all good" push is exactly what was
    # rejected: it trains you to ignore the channel.
    results = [_result("a"), _result("b"), _result("c")]
    assert notify.summarize_failures(results) is None


def test_no_alert_is_published_for_a_clean_run():
    recorder = Recorder()
    assert notify.alert_run_result(CONFIG, [_result("a")], post=recorder) is False
    assert recorder.calls == []


def test_a_failed_site_produces_a_high_priority_alert_naming_it():
    results = [_result("a"), _result("b", status="failed", error="403 Forbidden", rows=0)]
    title, message, priority = notify.summarize_failures(results)
    assert priority == notify.PRIORITY_HIGH
    assert "1 site(s) failed" in title
    assert "b" in message
    assert "403 Forbidden" in message
    assert "1/2 sites collected search data." in message


def test_cwv_error_on_an_otherwise_successful_run_alerts_at_normal_priority():
    # This is the case that silently happened for real: status='success' with
    # a CWV 403, so the run looked clean everywhere and nothing said otherwise.
    results = [_result("a", cwv_error="cwv: HTTP Error 403: Forbidden")]
    title, message, priority = notify.summarize_failures(results)
    assert priority == notify.PRIORITY_DEFAULT
    assert "CWV degraded" in title
    assert "403" in message


def test_a_failed_site_outranks_a_degraded_one_in_priority_and_title():
    results = [
        _result("a", status="failed", error="boom", rows=0),
        _result("b", cwv_error="cwv: 403"),
    ]
    title, message, priority = notify.summarize_failures(results)
    assert priority == notify.PRIORITY_HIGH
    assert "failed" in title
    # The degraded site is still reported, just not in the headline.
    assert "CWV FAILED" in message


# --------------------------------------------------------------------------
# weekly digest
# --------------------------------------------------------------------------


class FakeSite:
    def __init__(self, property_, display_name):
        self.property = property_
        self.display_name = display_name


@pytest.fixture
def conn(tmp_path):
    connection = db_module.init_db(tmp_path / "digest.db")
    yield connection
    connection.close()


def _insert_totals(conn: sqlite3.Connection, site, date, clicks, impressions):
    conn.execute(
        "INSERT OR REPLACE INTO totals_daily (site, date, clicks, impressions, ctr, position) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (site, date, clicks, impressions, 0.1, 5.0),
    )
    conn.commit()


TODAY = datetime.date(2026, 7, 27)
# LAG_DAYS=3 -> window ends 2026-07-24, starts 2026-07-18; prior 07-11..07-17.


def test_digest_compares_the_last_seven_collected_days_against_the_seven_before(conn):
    site = FakeSite("https://x.test/", "X Site")
    for day in range(18, 25):
        _insert_totals(conn, site.property, f"2026-07-{day}", 2, 20)
    for day in range(11, 18):
        _insert_totals(conn, site.property, f"2026-07-{day}", 1, 10)

    title, message = notify.build_weekly_digest(conn, [site], today=TODAY)

    assert "2026-07-18 to 2026-07-24" in title
    assert "impressions 140 vs 70 (+100%)" in message
    assert "clicks 14 vs 7 (+100%)" in message


def test_digest_reports_an_uncollected_prior_week_in_words_not_as_a_percentage(conn):
    # A percentage against an uncollected baseline is a fabrication -- it
    # would read as explosive growth when the truth is "we weren't looking".
    site = FakeSite("https://x.test/", "X Site")
    for day in range(18, 25):
        _insert_totals(conn, site.property, f"2026-07-{day}", 2, 20)

    _, message = notify.build_weekly_digest(conn, [site], today=TODAY)

    assert "no prior week collected" in message
    assert "%" not in message


def test_digest_distinguishes_nothing_collected_from_measured_zero(conn):
    collected_zero = FakeSite("https://zero.test/", "Zero Site")
    never = FakeSite("https://never.test/", "Never Site")
    for day in range(18, 25):
        _insert_totals(conn, collected_zero.property, f"2026-07-{day}", 0, 0)

    _, message = notify.build_weekly_digest(conn, [collected_zero, never], today=TODAY)

    assert "Never Site\nnothing collected this week" in message
    # The measured-zero site reports numbers, not the not-collected phrase.
    zero_block = message.split("Zero Site")[1].split("Never Site")[0]
    assert "nothing collected" not in zero_block
    assert "impressions 0" in zero_block


def test_digest_lists_failed_runs_inside_the_window(conn):
    site = FakeSite("https://x.test/", "X Site")
    _insert_totals(conn, site.property, "2026-07-20", 1, 10)
    conn.execute(
        "INSERT INTO collection_runs (site, started_at, finished_at, status, error, rows_written) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (site.property, "2026-07-20T03:00:00+00:00", "2026-07-20T03:01:00+00:00", "failed", "boom", 0),
    )
    conn.commit()

    _, message = notify.build_weekly_digest(conn, [site], today=TODAY)
    assert "1 failed run(s): https://x.test/" in message


def test_digest_publishes_at_low_priority_so_it_does_not_buzz(conn):
    site = FakeSite("https://x.test/", "X Site")
    _insert_totals(conn, site.property, "2026-07-20", 1, 10)
    recorder = Recorder()

    assert (
        notify.send_weekly_digest(conn, [site], CONFIG, today=TODAY, post=recorder) is True
    )
    assert recorder.headers["Priority"] == str(notify.PRIORITY_LOW)


def test_digest_is_skipped_silently_when_ntfy_is_not_configured(conn):
    site = FakeSite("https://x.test/", "X Site")
    recorder = Recorder()
    assert notify.send_weekly_digest(conn, [site], None, today=TODAY, post=recorder) is False
    assert recorder.calls == []


def test_alert_body_survives_a_client_that_collapses_leading_whitespace():
    """Found by reading the real ntfy render, not the code.

    The ntfy web client strips leading whitespace, so an indented
    continuation line runs into its heading and column alignment silently
    disappears. Entries must therefore be separated by blank lines and every
    line must carry its own label.
    """
    results = [
        _result("https://optikacajs.rs/", status="failed", error="403 quota exceeded", rows=0),
        _result("https://skedio.rs/", cwv_error="cwv: HTTP Error 403: Forbidden"),
    ]
    _, message, _ = notify.summarize_failures(results)

    # No line depends on indentation to be readable.
    for line in message.splitlines():
        assert line == line.lstrip(), f"line relies on leading whitespace: {line!r}"

    # Entries stay separated by a blank line, so collapsing cannot merge them.
    assert "\n\n" in message
    assert "FAILED: https://optikacajs.rs/" in message
    assert "SEARCH DATA OK, CWV FAILED: https://skedio.rs/" in message


def test_digest_body_also_avoids_leading_whitespace(conn):
    site = FakeSite("https://x.test/", "X Site")
    _insert_totals(conn, site.property, "2026-07-20", 3, 30)
    _, message = notify.build_weekly_digest(conn, [site], today=TODAY)
    for line in message.splitlines():
        assert line == line.lstrip(), f"line relies on leading whitespace: {line!r}"
