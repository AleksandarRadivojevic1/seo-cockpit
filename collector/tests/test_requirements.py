"""Guards on how the collector's dependencies are declared and installed.

The image used to ``pip install`` five bare names on every build, so each
rebuild silently took whatever was newest. APScheduler 4 is the concrete
hazard: it folds ``BlockingScheduler`` into a new ``Scheduler`` class, and
``schedule.py`` imports ``BlockingScheduler``, so the day 4.0 final ships an
unpinned rebuild fails at import. These tests keep the pins from drifting
back out.
"""

import re
from pathlib import Path

COLLECTOR = Path(__file__).resolve().parent.parent
REPO = COLLECTOR.parent


def _normalize(name: str) -> str:
    """PEP 503 name normalization, so ``PyYAML`` and ``pyyaml`` compare equal."""
    return re.sub(r"[-_.]+", "-", name).lower()


def _requirements(path: Path) -> dict[str, str]:
    """``{normalized name: specifier}`` for every requirement line in ``path``.

    Comments, blank lines and ``-r`` includes are skipped.
    """
    reqs: dict[str, str] = {}
    for raw in path.read_text().splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line or line.startswith("-"):
            continue
        match = re.match(r"([A-Za-z0-9][A-Za-z0-9._-]*)\s*(.*)", line)
        assert match, f"unparseable requirement in {path.name}: {raw!r}"
        reqs[_normalize(match.group(1))] = match.group(2).replace(" ", "")
    return reqs


def test_apscheduler_is_capped_below_4():
    spec = _requirements(COLLECTOR / "requirements.txt")["apscheduler"]
    assert "<4" in spec.split(","), spec


def test_lock_pins_every_package_to_an_exact_version():
    locked = _requirements(COLLECTOR / "requirements.lock")
    assert locked, "requirements.lock is empty"
    loose = {name: spec for name, spec in locked.items() if not re.fullmatch(r"==[^,]+", spec)}
    assert loose == {}


def test_lock_covers_every_direct_requirement():
    direct = _requirements(COLLECTOR / "requirements.txt")
    locked = _requirements(COLLECTOR / "requirements.lock")
    assert set(direct) - set(locked) == set()
    assert locked["apscheduler"].startswith("==3.")


def test_pytest_ships_only_in_the_dev_requirements():
    assert "pytest" not in _requirements(COLLECTOR / "requirements.txt")
    assert "pytest" not in _requirements(COLLECTOR / "requirements.lock")

    dev_text = (COLLECTOR / "requirements-dev.txt").read_text()
    assert "pytest" in _requirements(COLLECTOR / "requirements-dev.txt")
    # Dev and CI test against the exact versions the image runs.
    assert re.search(r"^-r\s+requirements\.lock\s*$", dev_text, re.MULTILINE)


def test_collector_image_installs_from_the_lock():
    dockerfile = (REPO / "deploy" / "Dockerfile.collector").read_text()
    installs = re.findall(r"pip install[^\n]*", dockerfile)
    assert installs, "no pip install in Dockerfile.collector"
    for line in installs:
        assert "requirements.lock" in line, line
        assert "requirements.txt" not in line, line
    assert "COPY collector/requirements.lock" in dockerfile
