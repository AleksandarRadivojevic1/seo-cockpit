import json

from apscheduler.schedulers.blocking import BlockingScheduler

from seocockpit.schedule import (
    _run_lock,
    build_scheduler,
    main,
    make_run_trigger_watcher,
    read_run_trigger,
)


class _DummyConfig:
    """Stand-in for a loaded Config.

    ``db_path`` is read by the post-run backup job. Backups stay disabled in
    these tests because SEO_BACKUP_DIR is unset, so run_backup returns
    immediately -- but the attribute has to exist, since the call site reads
    it before run_backup's own error isolation applies.
    """

    db_path = "/nonexistent/seo.db"


def _refusing_scheduler_factory(*args, **kwargs):
    raise AssertionError("serve wiring must not be touched by `run`")


# ---------------------------------------------------------------------------
# `run` subcommand: one-shot, calls collect_once exactly once, never builds
# a scheduler.
# ---------------------------------------------------------------------------


def test_run_incremental_calls_collect_once_once_and_exits():
    config = _DummyConfig()
    calls = []

    def collect_fn(cfg, mode):
        calls.append((cfg, mode))
        return [{"site": "sc-domain:example.com", "status": "success", "rows": 3, "error": None}]

    exit_code = main(
        ["run"],
        config=config,
        collect_fn=collect_fn,
        scheduler_factory=_refusing_scheduler_factory,
    )

    assert exit_code == 0
    assert calls == [(config, "incremental")]


def test_run_backfill_calls_collect_once_with_backfill_mode():
    config = _DummyConfig()
    calls = []

    def collect_fn(cfg, mode):
        calls.append((cfg, mode))
        return [{"site": "sc-domain:example.com", "status": "success", "rows": 3, "error": None}]

    exit_code = main(
        ["run", "--backfill"],
        config=config,
        collect_fn=collect_fn,
        scheduler_factory=_refusing_scheduler_factory,
    )

    assert exit_code == 0
    assert calls == [(config, "backfill")]


def test_run_reports_failed_sites_but_still_exits_zero():
    """A per-site failure inside collect_once is a normal result, not a
    schedule.py-level error -- collect_once already isolates it."""
    config = _DummyConfig()

    def collect_fn(cfg, mode):
        return [{"site": "sc-domain:example.com", "status": "failed", "rows": 0, "error": "boom"}]

    exit_code = main(
        ["run"],
        config=config,
        collect_fn=collect_fn,
        scheduler_factory=_refusing_scheduler_factory,
    )

    assert exit_code == 0


# ---------------------------------------------------------------------------
# `build_scheduler`: wiring only, never blocks.
# ---------------------------------------------------------------------------


def _job_by_id(scheduler, job_id):
    for job in scheduler.get_jobs():
        if job.id == job_id:
            return job
    raise AssertionError(f"no job with id {job_id!r}")


def test_build_scheduler_registers_the_daily_collection_job():
    config = _DummyConfig()
    calls = []

    def collect_fn(cfg, mode):
        calls.append((cfg, mode))
        return []

    scheduler = build_scheduler(config, collect_fn=collect_fn)

    assert isinstance(scheduler, BlockingScheduler)
    job = _job_by_id(scheduler, "daily_incremental_collection")
    assert job.trigger.fields[job.trigger.FIELD_NAMES.index("hour")].expressions[0].first == 3
    assert job.trigger.fields[job.trigger.FIELD_NAMES.index("minute")].expressions[0].first == 0

    # Invoke the job's wired function directly -- proves it calls
    # collect_fn(config, "incremental") without ever starting the scheduler.
    job.func()
    assert calls == [(config, "incremental")]


def test_build_scheduler_registers_the_weekly_digest_on_monday_after_collection():
    """The digest must read a database the day's run has already written.

    Collection is 03:00 UTC; the digest is 07:00 UTC Monday. If the digest
    ran first it would report a week ending on stale data every time.
    """
    config = _DummyConfig()
    scheduler = build_scheduler(config, collect_fn=lambda cfg, mode: [])

    job = _job_by_id(scheduler, "weekly_digest")
    fields = {name: job.trigger.fields[i] for i, name in enumerate(job.trigger.FIELD_NAMES)}
    assert str(fields["day_of_week"]) == "mon"
    assert fields["hour"].expressions[0].first == 7
    assert str(job.trigger.timezone) == "UTC"


def test_only_the_expected_jobs_are_registered():
    config = _DummyConfig()
    scheduler = build_scheduler(config, collect_fn=lambda cfg, mode: [])
    assert {job.id for job in scheduler.get_jobs()} == {
        "daily_incremental_collection",
        "weekly_digest",
        "run_now_watcher",
    }


# ---------------------------------------------------------------------------
# Run-now trigger: the dashboard writes a trigger file, the collector's
# watcher job runs a collection when it sees a new timestamp.
# ---------------------------------------------------------------------------


def test_read_run_trigger_reads_requested_at(tmp_path):
    p = tmp_path / "run-now.json"
    p.write_text(json.dumps({"requested_at": "2026-09-14T12:00:00Z"}), encoding="utf-8")
    assert read_run_trigger(str(p)) == "2026-09-14T12:00:00Z"


def test_read_run_trigger_missing_or_malformed_returns_none(tmp_path):
    assert read_run_trigger(str(tmp_path / "nope.json")) is None
    bad = tmp_path / "bad.json"
    bad.write_text("{ not json", encoding="utf-8")
    assert read_run_trigger(str(bad)) is None


def test_watcher_runs_collection_on_each_new_trigger(tmp_path):
    p = tmp_path / "run-now.json"  # absent at build time -> last_seen is None
    config = _DummyConfig()
    calls = []
    watch = make_run_trigger_watcher(
        config, lambda cfg, mode: calls.append((cfg, mode)) or [], str(p)
    )

    watch()  # no file yet
    assert calls == []

    p.write_text(json.dumps({"requested_at": "t1"}), encoding="utf-8")
    watch()  # new timestamp -> runs
    assert calls == [(config, "incremental")]

    watch()  # same timestamp -> no re-run
    assert len(calls) == 1

    p.write_text(json.dumps({"requested_at": "t2"}), encoding="utf-8")
    watch()  # new again -> runs again
    assert len(calls) == 2


def test_watcher_does_not_fire_for_the_trigger_present_at_startup(tmp_path):
    p = tmp_path / "run-now.json"
    p.write_text(json.dumps({"requested_at": "t0"}), encoding="utf-8")
    config = _DummyConfig()
    calls = []
    watch = make_run_trigger_watcher(
        config, lambda cfg, mode: calls.append(mode) or [], str(p)
    )
    watch()  # last_seen initialized to t0 at build time -> no fire
    assert calls == []


def test_watcher_skips_while_a_run_is_in_progress(tmp_path):
    p = tmp_path / "run-now.json"
    config = _DummyConfig()
    calls = []
    watch = make_run_trigger_watcher(
        config, lambda cfg, mode: calls.append(mode) or [], str(p)
    )
    p.write_text(json.dumps({"requested_at": "t1"}), encoding="utf-8")

    assert _run_lock.acquire(blocking=False)  # simulate a run already running
    try:
        watch()  # lock held -> skip, do not run, do not mark seen
        assert calls == []
    finally:
        _run_lock.release()

    watch()  # lock free -> runs the still-pending t1
    assert calls == ["incremental"]


def test_a_clean_run_sends_no_notification(monkeypatch):
    """The daily job must stay silent when nothing went wrong.

    Wiring regression guard: it would be easy to "helpfully" push a summary
    from the job, which is the exact behaviour this feature rejected.
    """
    import seocockpit.schedule as schedule_module

    published = []
    monkeypatch.setattr(
        schedule_module.notify,
        "config_from_env",
        lambda: schedule_module.notify.NtfyConfig(url="http://x", topic="t"),
    )
    monkeypatch.setattr(
        schedule_module.notify,
        "alert_run_result",
        lambda config, results, **kw: published.append(results) or False,
    )

    config = _DummyConfig()
    results = [{"site": "a", "status": "success", "rows": 5, "error": None, "cwv_error": None}]
    scheduler = build_scheduler(config, collect_fn=lambda cfg, mode: results)
    _job_by_id(scheduler, "daily_incremental_collection").func()

    # alert_run_result is called, and it is the function that decides to stay
    # silent -- the job must not second-guess it or publish separately.
    assert published == [results]


def test_a_notification_failure_does_not_break_the_collection_job(monkeypatch):
    import seocockpit.schedule as schedule_module

    def boom():
        raise RuntimeError("ntfy config exploded")

    monkeypatch.setattr(schedule_module.notify, "config_from_env", boom)

    config = _DummyConfig()
    scheduler = build_scheduler(config, collect_fn=lambda cfg, mode: [])
    # Must not raise: the data is already committed by this point.
    _job_by_id(scheduler, "daily_incremental_collection").func()


def test_build_scheduler_fires_in_utc_not_server_local_time():
    """Every timestamp this collector writes is UTC, but CronTrigger takes
    its timezone from the scheduler's default (the system's) unless told
    otherwise. On a Europe/Belgrade host that made "03:00" fire at 01:00
    UTC, and at 02:00 UTC after the DST change -- so the dashboard could
    not tell whether a run was missed. Pin it.
    """
    config = _DummyConfig()
    scheduler = build_scheduler(config, collect_fn=lambda cfg, mode: None)

    trigger = scheduler.get_jobs()[0].trigger
    assert str(trigger.timezone) == "UTC"


def test_build_scheduler_custom_hour_minute():
    config = _DummyConfig()
    scheduler = build_scheduler(config, collect_fn=lambda cfg, mode: None, hour=5, minute=30)

    job = scheduler.get_jobs()[0]
    assert job.trigger.fields[job.trigger.FIELD_NAMES.index("hour")].expressions[0].first == 5
    assert job.trigger.fields[job.trigger.FIELD_NAMES.index("minute")].expressions[0].first == 30


# ---------------------------------------------------------------------------
# `serve` subcommand: only wiring is exercised -- .start() is called on
# whatever the (injected) scheduler_factory returns, never a real
# BlockingScheduler.start().
# ---------------------------------------------------------------------------


class _FakeScheduler:
    def __init__(self):
        self.start_calls = 0

    def start(self):
        self.start_calls += 1


def test_serve_builds_scheduler_via_factory_and_starts_it():
    config = _DummyConfig()
    fake = _FakeScheduler()
    factory_calls = []

    def scheduler_factory(cfg, collect_fn, config_provider=None):
        factory_calls.append((cfg, collect_fn))
        return fake

    exit_code = main(
        ["serve"],
        config=config,
        collect_fn=lambda cfg, mode: None,
        scheduler_factory=scheduler_factory,
    )

    assert exit_code == 0
    assert fake.start_calls == 1
    assert len(factory_calls) == 1
    assert factory_calls[0][0] is config


# ---------------------------------------------------------------------------
# Config reload: dashboard add/remove/edit of sites must take effect on the
# next run WITHOUT a collector restart. The scheduler resolves fresh config
# per run via an optional `config_provider`, instead of closing over a single
# config captured at process startup.
# ---------------------------------------------------------------------------


def test_watcher_reloads_config_before_each_run(tmp_path):
    """Each triggered run collects against freshly-resolved config, so a site
    added/removed via the dashboard is picked up without a restart."""
    p = tmp_path / "run-now.json"  # absent at build -> last_seen is None
    config_a = _DummyConfig()
    config_b = _DummyConfig()
    provided = [config_a, config_b]
    seen = []

    watch = make_run_trigger_watcher(
        _DummyConfig(),  # startup snapshot -- must NOT be what runs use
        lambda cfg, mode: seen.append(cfg) or [],
        str(p),
        config_provider=lambda: provided.pop(0),
    )

    p.write_text(json.dumps({"requested_at": "t1"}), encoding="utf-8")
    watch()
    p.write_text(json.dumps({"requested_at": "t2"}), encoding="utf-8")
    watch()

    assert seen == [config_a, config_b]


def test_daily_job_reloads_config_each_run():
    """The daily cron job resolves fresh config on each fire, not the startup
    snapshot."""
    config_a = _DummyConfig()
    config_b = _DummyConfig()
    provided = [config_a, config_b]
    seen = []

    scheduler = build_scheduler(
        _DummyConfig(),
        collect_fn=lambda cfg, mode: seen.append(cfg) or [],
        config_provider=lambda: provided.pop(0),
    )

    job = _job_by_id(scheduler, "daily_incremental_collection")
    job.func()
    job.func()

    assert seen == [config_a, config_b]


def test_serve_wires_a_disk_reloading_config_provider(monkeypatch):
    """`serve` hands the scheduler a provider that reloads config from disk
    (via load_config), so long-running collectors pick up config changes."""
    import seocockpit.schedule as schedule_module

    sentinel = _DummyConfig()
    monkeypatch.setattr(schedule_module, "load_config", lambda: sentinel)

    captured = {}

    def scheduler_factory(cfg, collect_fn, config_provider=None):
        captured["provider"] = config_provider
        return _FakeScheduler()

    exit_code = main(
        ["serve"],
        config=_DummyConfig(),
        collect_fn=lambda cfg, mode: None,
        scheduler_factory=scheduler_factory,
    )

    assert exit_code == 0
    assert captured["provider"] is not None
    assert captured["provider"]() is sentinel
