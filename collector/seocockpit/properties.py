"""Publish the set of GSC properties the service account can read.

The dashboard's add-site form validates a property's *format* and *uniqueness*,
but cannot verify GSC *access*: the service-account key lives only in the
collector, so the read-only dashboard can never call ``sites().list()`` itself.
Without this check a wrong property (a typo, or the wrong ``sc-domain:`` vs
``https://.../`` form -- GSC treats them as distinct) is accepted silently and
only fails at the next scheduled run, a day later, as an alarming 403.

This module closes that gap the same way every other dashboard<->collector
exchange works here: through a shared file. The collector fetches the readable
properties and writes them to a file the dashboard reads at add time. No new
network surface, no credentials outside the collector.
"""

from __future__ import annotations

import datetime
import json
import logging
import os
from pathlib import Path
from typing import Callable

from . import gsc as gsc_module
from .config import Config

logger = logging.getLogger(__name__)

# Where the accessible-property list is published. The collector writes it and
# the dashboard reads it, so it lives in the shared data volume (collector
# read-write, dashboard read-only) -- the same polarity as the database, which
# needs no new mount. Both containers set this env var.
ACCESSIBLE_PROPERTIES_ENV = "SEO_ACCESSIBLE_PROPERTIES_PATH"
DEFAULT_ACCESSIBLE_PROPERTIES_PATH = "/data/accessible-properties.json"


def write_accessible_properties(
    path: str, properties: list[str], fetched_at: str
) -> None:
    """Atomically write the accessible-properties file (temp + rename).

    The property list is de-duplicated and sorted so the file is stable across
    runs and diffs cleanly. ``fetched_at`` is stored verbatim so the dashboard
    can tell the operator how fresh the list is.
    """
    payload = {"fetched_at": fetched_at, "properties": sorted(set(properties))}
    p = Path(path)
    stamp = int(datetime.datetime.now().timestamp() * 1000)
    tmp = p.with_name(f".{p.name}.{os.getpid()}.{stamp}.tmp")
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    tmp.replace(p)


def refresh_accessible_properties(
    config: Config,
    path: str | None = None,
    *,
    service_factory: Callable = gsc_module.build_service,
    list_properties_fn: Callable = gsc_module.list_properties,
    now: Callable[[], datetime.datetime] | None = None,
) -> list[str] | None:
    """Fetch the account's readable properties and publish them to ``path``.

    ``path`` defaults to ``SEO_ACCESSIBLE_PROPERTIES_ENV``; when neither is set
    the feature is dormant (returns ``None`` without building a client), the
    same convention the user-sites loader uses so a dev run touches nothing.

    Never raises: publishing this list is best-effort and must never turn a
    healthy collection run into a failure. A fetch or write error is logged and
    yields ``None`` with the previous file left untouched.
    """
    resolved = path or os.environ.get(ACCESSIBLE_PROPERTIES_ENV)
    if not resolved:
        return None
    clock = now or (lambda: datetime.datetime.now(datetime.timezone.utc))
    try:
        service = service_factory(config.service_account_path)
        properties = list_properties_fn(service)
        write_accessible_properties(resolved, properties, clock().isoformat())
        logger.info(
            "published %d accessible propert%s to %s",
            len(properties),
            "y" if len(properties) == 1 else "ies",
            resolved,
        )
        return properties
    except Exception as e:  # noqa: BLE001 - best effort, must not break a run
        logger.warning("could not refresh accessible properties: %s", e)
        return None
