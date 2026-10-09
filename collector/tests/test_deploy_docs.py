"""Guards on deploy/DEPLOY.md, the runbook the deploy files point at.

``Dockerfile.collector`` and ``compose.snippet.yml`` both sent readers to a
DEPLOY.md that had never been committed. These tests keep every reference
resolvable, and keep the restore runbook's steps -- above all the dashboard
restart, without which a restore looks like it did nothing -- in order.
"""

import re
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
DEPLOY_DIR = REPO / "deploy"
RUNBOOK = DEPLOY_DIR / "DEPLOY.md"


def test_every_deploy_md_reference_resolves():
    referencing = [
        path
        for path in sorted(DEPLOY_DIR.iterdir())
        if path.is_file() and path != RUNBOOK and "DEPLOY.md" in path.read_text()
    ]
    assert referencing, "expected the deploy files to point at DEPLOY.md"
    assert RUNBOOK.is_file()


def _restore_section() -> str:
    """The '### Restoring a snapshot' section, up to the next heading.

    Fence-aware: the shell comments inside its code blocks start with '#'
    too, and must not end the section.
    """
    lines = RUNBOOK.read_text().splitlines()
    assert "### Restoring a snapshot" in lines, "DEPLOY.md has no restore section"
    section: list[str] = []
    in_fence = False
    for line in lines[lines.index("### Restoring a snapshot") + 1 :]:
        if line.startswith("```"):
            in_fence = not in_fence
        elif not in_fence and re.match(r"#{1,3} ", line):
            break
        section.append(line)
    return "\n".join(section)


def test_restore_runbook_steps_run_in_order():
    section = _restore_section()
    steps = [
        "docker compose stop seo-cockpit-collector",
        "cp /media/library/backups/seo-cockpit/seo-",
        "docker compose start seo-cockpit-collector",
        "docker compose restart seo-cockpit-dashboard",
    ]
    positions = [section.find(step) for step in steps]
    assert -1 not in positions, dict(zip(steps, positions))
    assert positions == sorted(positions)


def test_restore_runbook_explains_the_dashboard_restart():
    # getDb() memoizes one connection per path for the life of the process.
    assert "getDb()" in _restore_section()


def test_runbook_covers_client_share_links():
    text = RUNBOOK.read_text()
    for needle in ("SEO_INTERNAL_HOSTS", "SEO_TUNNEL_TOKEN", "clients.deimos.agency", "/sites/links"):
        assert needle in text, needle
