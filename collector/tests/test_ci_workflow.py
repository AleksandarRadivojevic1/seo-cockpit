"""Guards on .github/workflows/ci.yml.

The suites used to run only when someone remembered to. The workflow runs
them on every push; these tests keep a check from being dropped quietly and
keep CI on the same Python and Node the images ship, so a version-specific
break can't pass CI and then fail in the container.
"""

import re
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parent.parent.parent
WORKFLOW = REPO / ".github" / "workflows" / "ci.yml"


def _workflow() -> dict:
    return yaml.safe_load(WORKFLOW.read_text())


def _run_lines(job: dict) -> list[str]:
    return [step["run"] for step in job["steps"] if "run" in step]


def _step_with(job: dict, action_prefix: str) -> dict:
    return next(s for s in job["steps"] if s.get("uses", "").startswith(action_prefix))


def _base_image_version(dockerfile: str, image: str) -> str:
    text = (REPO / "deploy" / dockerfile).read_text()
    match = re.search(rf"^FROM {image}:(\d+(?:\.\d+)?)", text, re.MULTILINE)
    assert match, f"no FROM {image} in {dockerfile}"
    return match.group(1)


def test_runs_on_every_push():
    # PyYAML reads the bare `on` key as True.
    triggers = _workflow().get("on", _workflow().get(True))
    assert "push" in triggers


def test_collector_job_runs_pytest_on_the_image_python():
    job = _workflow()["jobs"]["collector"]
    runs = _run_lines(job)
    assert any("requirements-dev.txt" in r for r in runs)
    assert any(re.search(r"\bpytest\b", r) and "pip" not in r for r in runs)
    python = str(_step_with(job, "actions/setup-python")["with"]["python-version"])
    assert python == _base_image_version("Dockerfile.collector", "python")


def test_dashboard_job_runs_vitest_tsc_and_lint_on_the_image_node():
    job = _workflow()["jobs"]["dashboard"]
    runs = _run_lines(job)
    for check in ("npm ci", "vitest run", "tsc --noEmit", "npm run lint"):
        assert any(check in r for r in runs), check
    # tsc needs Next's generated route types on a clean checkout.
    typegen = next(i for i, r in enumerate(runs) if "next typegen" in r)
    tsc = next(i for i, r in enumerate(runs) if "tsc --noEmit" in r)
    assert typegen < tsc
    node = str(_step_with(job, "actions/setup-node")["with"]["node-version"])
    assert node == _base_image_version("Dockerfile.dashboard", "node")
