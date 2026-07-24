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


def test_build_scheduler_registers_exactly_one_daily_job():
    config = _DummyConfig()
    calls = []

    def collect_fn(cfg, mode):
        calls.append((cfg, mode))
        return []

    scheduler = build_scheduler(config, collect_fn=collect_fn)

    assert isinstance(scheduler, BlockingScheduler)
    jobs = scheduler.get_jobs()
    assert len(jobs) == 1

    job = jobs[0]
    assert job.trigger.fields[job.trigger.FIELD_NAMES.index("hour")].expressions[0].first == 3
    assert job.trigger.fields[job.trigger.FIELD_NAMES.index("minute")].expressions[0].first == 0

    # Invoke the job's wired function directly -- proves it calls
    # collect_fn(config, "incremental") without ever starting the scheduler.
    job.func()
    assert calls == [(config, "incremental")]


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
