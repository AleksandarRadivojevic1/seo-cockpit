from apscheduler.schedulers.blocking import BlockingScheduler

from seocockpit.schedule import build_scheduler, main


class _DummyConfig:
    """Stand-in for a loaded Config -- schedule.py never inspects it."""


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


def test_only_the_two_expected_jobs_are_registered():
    config = _DummyConfig()
    scheduler = build_scheduler(config, collect_fn=lambda cfg, mode: [])
    assert {job.id for job in scheduler.get_jobs()} == {
        "daily_incremental_collection",
        "weekly_digest",
    }


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

    def scheduler_factory(cfg, collect_fn):
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
