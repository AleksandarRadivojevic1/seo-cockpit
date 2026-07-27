"""Tests for the SQLite backup job."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from seocockpit.backup import backup_db, prune_backups, resolve_backup_dir, run_backup


def _make_db(path: Path, rows: int = 3) -> None:
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE totals_daily (site TEXT, date TEXT, impressions INT)")
    conn.executemany(
        "INSERT INTO totals_daily VALUES (?, ?, ?)",
        [("https://example.rs/", f"2026-07-0{i}", i) for i in range(1, rows + 1)],
    )
    conn.commit()
    conn.close()


def test_backup_copies_every_row(tmp_path: Path) -> None:
    src = tmp_path / "seo.db"
    _make_db(src)

    out = backup_db(src, tmp_path / "backups", today="2026-07-27")

    assert out is not None and out.exists()
    conn = sqlite3.connect(out)
    assert conn.execute("SELECT COUNT(*) FROM totals_daily").fetchone()[0] == 3
    conn.close()


def test_backup_uses_the_online_api_not_a_file_copy(tmp_path: Path) -> None:
    """A snapshot must be consistent while another connection holds the db.

    A plain ``shutil.copy`` of a live SQLite file can capture a half-written
    page. The backup API takes a proper snapshot, so this must succeed with
    an open writer -- and the copy must not see the uncommitted row.
    """
    src = tmp_path / "seo.db"
    _make_db(src)

    writer = sqlite3.connect(src)
    writer.execute("BEGIN")
    writer.execute("INSERT INTO totals_daily VALUES ('x', '2026-07-09', 99)")

    out = backup_db(src, tmp_path / "backups", today="2026-07-27")
    writer.rollback()
    writer.close()

    assert out is not None
    conn = sqlite3.connect(out)
    assert conn.execute("SELECT COUNT(*) FROM totals_daily").fetchone()[0] == 3
    conn.close()


def test_backup_creates_the_destination_directory(tmp_path: Path) -> None:
    src = tmp_path / "seo.db"
    _make_db(src)
    dest = tmp_path / "nested" / "backups"

    assert backup_db(src, dest, today="2026-07-27") is not None
    assert dest.is_dir()


def test_backup_leaves_no_partial_file_behind(tmp_path: Path) -> None:
    """The write goes to a temp name and is renamed into place.

    An interrupted backup must not leave a truncated file sitting under a
    name that looks like a real, restorable snapshot.
    """
    src = tmp_path / "seo.db"
    _make_db(src)
    dest = tmp_path / "backups"

    backup_db(src, dest, today="2026-07-27")

    assert list(dest.glob("*.tmp")) == []
    assert [p.name for p in dest.glob("*.db")] == ["seo-2026-07-27.db"]


def test_backup_overwrites_the_same_day_rather_than_accumulating(tmp_path: Path) -> None:
    src = tmp_path / "seo.db"
    _make_db(src)
    dest = tmp_path / "backups"

    backup_db(src, dest, today="2026-07-27")
    backup_db(src, dest, today="2026-07-27")

    assert len(list(dest.glob("*.db"))) == 1


def test_prune_keeps_the_newest_and_deletes_the_rest(tmp_path: Path) -> None:
    dest = tmp_path / "backups"
    dest.mkdir()
    for day in range(1, 8):
        (dest / f"seo-2026-07-0{day}.db").write_bytes(b"x")

    prune_backups(dest, keep=3)

    assert sorted(p.name for p in dest.glob("*.db")) == [
        "seo-2026-07-05.db",
        "seo-2026-07-06.db",
        "seo-2026-07-07.db",
    ]


def test_prune_ignores_unrelated_files(tmp_path: Path) -> None:
    dest = tmp_path / "backups"
    dest.mkdir()
    (dest / "seo-2026-07-01.db").write_bytes(b"x")
    (dest / "notes.txt").write_bytes(b"x")

    prune_backups(dest, keep=0)

    assert (dest / "notes.txt").exists()


def test_resolve_backup_dir_is_disabled_when_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    """Absent configuration means "do not back up", not "back up somewhere".

    Guessing a default would silently write snapshots onto the SD card the
    backup exists to survive.
    """
    monkeypatch.delenv("SEO_BACKUP_DIR", raising=False)
    assert resolve_backup_dir() is None


def test_resolve_backup_dir_reads_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SEO_BACKUP_DIR", "/backups")
    assert resolve_backup_dir() == Path("/backups")


def test_run_backup_never_raises_into_the_caller(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A backup failure must not fail the collection run.

    Same isolation rule as the CWV fetch in 11d: the collected data is
    already committed by this point, and losing the run's success status
    over a backup problem would misreport a healthy collector as broken.
    """
    monkeypatch.setenv("SEO_BACKUP_DIR", str(tmp_path / "dest"))

    assert run_backup(tmp_path / "does-not-exist.db") is None


def test_run_backup_returns_the_path_on_success(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    src = tmp_path / "seo.db"
    _make_db(src)
    monkeypatch.setenv("SEO_BACKUP_DIR", str(tmp_path / "dest"))

    out = run_backup(src)

    assert out is not None and out.exists()
