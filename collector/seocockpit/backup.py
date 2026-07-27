"""Rotating snapshots of the collected database.

``seo.db`` is the one irreplaceable artefact in this project. GSC serves
roughly 16 months of history and nothing can re-fetch a day that was never
collected, so a lost file is lost measurement -- permanently, and silently,
since every page would simply render its empty state.

Until 2026-07-27 there was no backup of it at all, on a Raspberry Pi whose
storage is an SD card.

Two deliberate choices:

- **The SQLite online backup API, not a file copy.** ``shutil.copy`` of a
  live database can capture a page mid-write, producing a file that opens
  fine and is subtly corrupt. ``Connection.backup`` takes a real snapshot
  while the collector holds the database open. It also needs no ``sqlite3``
  binary, which this Pi does not have installed.

- **The destination is configuration, never a default.** An unset
  ``SEO_BACKUP_DIR`` disables the job. Guessing a path would write the
  snapshots onto the very SD card they exist to survive, which is worse
  than no backup because it looks like one.
"""

from __future__ import annotations

import datetime
import logging
import os
import sqlite3
from pathlib import Path

logger = logging.getLogger(__name__)

#: How many daily snapshots to retain. At ~600KB a copy this is trivial on
#: disk, and two weeks is long enough to notice corruption that only shows
#: up in a weekly digest.
DEFAULT_KEEP = 14

_ENV_VAR = "SEO_BACKUP_DIR"
_PREFIX = "seo-"
_SUFFIX = ".db"


def resolve_backup_dir() -> Path | None:
    """The configured destination, or ``None`` when backups are disabled."""
    raw = os.environ.get(_ENV_VAR, "").strip()
    return Path(raw) if raw else None


def prune_backups(dest_dir: Path, keep: int = DEFAULT_KEEP) -> list[Path]:
    """Delete all but the ``keep`` newest snapshots. Returns what was removed.

    Ordering is by filename, which sorts chronologically because the date is
    ISO-formatted -- mtime would reorder the set if the directory were ever
    copied around.
    """
    snapshots = sorted(
        p for p in dest_dir.glob(f"{_PREFIX}*{_SUFFIX}") if p.is_file()
    )
    stale = snapshots[: max(0, len(snapshots) - keep)]
    for path in stale:
        path.unlink()
    return stale


def backup_db(
    db_path: Path,
    dest_dir: Path,
    *,
    keep: int = DEFAULT_KEEP,
    today: str | None = None,
) -> Path | None:
    """Snapshot ``db_path`` into ``dest_dir`` as ``seo-<date>.db``.

    Same-day runs overwrite rather than accumulate: the collector may run
    more than once a day, and a dated snapshot per run would turn retention
    into a function of how often it happened to be triggered.

    Raises on failure -- ``run_backup`` is the isolating wrapper.
    """
    date = today or datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")
    dest_dir.mkdir(parents=True, exist_ok=True)

    final = dest_dir / f"{_PREFIX}{date}{_SUFFIX}"
    # Written under a temp name and renamed: an interrupted backup must never
    # leave a truncated file under a name that looks restorable. rename() is
    # atomic within a filesystem.
    temp = dest_dir / f"{_PREFIX}{date}{_SUFFIX}.tmp"
    temp.unlink(missing_ok=True)

    source = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        target = sqlite3.connect(temp)
        try:
            source.backup(target)
        finally:
            target.close()
    finally:
        source.close()

    temp.replace(final)
    prune_backups(dest_dir, keep=keep)
    return final


def run_backup(db_path: Path, *, keep: int = DEFAULT_KEEP) -> Path | None:
    """Back up if configured, and never raise into the caller.

    The collection run's data is already committed by the time this is
    called. Failing the run over a backup problem would report a healthy
    collector as broken -- the same isolation rule the CWV fetch needed.
    """
    dest_dir = resolve_backup_dir()
    if dest_dir is None:
        logger.debug("backup skipped: %s is not set", _ENV_VAR)
        return None

    try:
        out = backup_db(Path(db_path), dest_dir, keep=keep)
    except Exception:  # noqa: BLE001 - isolate the backup from the run
        logger.exception("database backup failed (collection itself was unaffected)")
        return None

    logger.info("database backed up to %s", out)
    return out
