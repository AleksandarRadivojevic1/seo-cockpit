"""Tests for seocockpit.properties -- publishing the accessible-property list.

The dashboard holds no Google credentials, so the collector fetches the set of
GSC properties the service account can read and writes it to a shared file the
read-only dashboard validates against at add time (T2.7).
"""

from __future__ import annotations

import datetime
import json

from seocockpit import properties
from seocockpit.config import Config


def _config(tmp_path):
    return Config(sites=[], db_path=str(tmp_path / "seo.db"), service_account_path="/dev/null")


def _fixed_clock():
    return datetime.datetime(2026, 9, 15, 12, 0, tzinfo=datetime.timezone.utc)


def test_write_accessible_properties_round_trips_and_sorts(tmp_path):
    path = tmp_path / "accessible-properties.json"
    properties.write_accessible_properties(
        str(path),
        ["https://skedio.rs/", "sc-domain:alexrad.dev", "https://skedio.rs/"],
        "2026-09-15T12:00:00+00:00",
    )
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["fetched_at"] == "2026-09-15T12:00:00+00:00"
    # De-duplicated and sorted for a stable, diff-friendly file.
    assert payload["properties"] == ["https://skedio.rs/", "sc-domain:alexrad.dev"]


def test_write_is_atomic_leaving_no_temp_files(tmp_path):
    path = tmp_path / "accessible-properties.json"
    properties.write_accessible_properties(str(path), ["https://x/"], "t")
    leftovers = [p.name for p in tmp_path.iterdir() if p.name != "accessible-properties.json"]
    assert leftovers == []


def test_refresh_fetches_and_publishes(tmp_path):
    path = tmp_path / "accessible-properties.json"
    written = properties.refresh_accessible_properties(
        _config(tmp_path),
        str(path),
        service_factory=lambda _p: object(),
        list_properties_fn=lambda _s: ["sc-domain:alexrad.dev"],
        now=_fixed_clock,
    )
    assert written == ["sc-domain:alexrad.dev"]
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["properties"] == ["sc-domain:alexrad.dev"]
    assert payload["fetched_at"] == "2026-09-15T12:00:00+00:00"


def test_refresh_is_dormant_when_no_path_configured(tmp_path, monkeypatch):
    monkeypatch.delenv(properties.ACCESSIBLE_PROPERTIES_ENV, raising=False)
    called = {"n": 0}

    def _factory(_p):
        called["n"] += 1
        return object()

    result = properties.refresh_accessible_properties(
        _config(tmp_path), None, service_factory=_factory
    )
    assert result is None
    # Dormant means it never even builds the authenticated client.
    assert called["n"] == 0


def test_refresh_resolves_path_from_env(tmp_path, monkeypatch):
    path = tmp_path / "from-env.json"
    monkeypatch.setenv(properties.ACCESSIBLE_PROPERTIES_ENV, str(path))
    properties.refresh_accessible_properties(
        _config(tmp_path),
        None,
        service_factory=lambda _p: object(),
        list_properties_fn=lambda _s: ["https://skedio.rs/"],
        now=_fixed_clock,
    )
    assert json.loads(path.read_text(encoding="utf-8"))["properties"] == ["https://skedio.rs/"]


def test_refresh_never_raises_on_fetch_failure(tmp_path):
    path = tmp_path / "accessible-properties.json"

    def _boom(_s):
        raise RuntimeError("network down")

    result = properties.refresh_accessible_properties(
        _config(tmp_path),
        str(path),
        service_factory=lambda _p: object(),
        list_properties_fn=_boom,
    )
    # Best-effort: a failure returns None and writes nothing, never taking a
    # collection run down with it.
    assert result is None
    assert not path.exists()
