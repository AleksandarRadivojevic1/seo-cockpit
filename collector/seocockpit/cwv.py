"""Core Web Vitals fetch and normalization for the seocockpit collector.

Fetches p75 field Core Web Vitals (LCP, INP, CLS) per URL from the Chrome
UX Report (CrUX) API, and Lighthouse data for the same URL from PageSpeed
Insights (PSI) v5. Field metrics prefer CrUX and fall back to PSI's lab
values; the four Lighthouse category scores always come from PSI. Both
APIs are called on every fetch (see ``fetch_cwv``). Normalizes the result
into a ``CwvSnapshot``, ready for a later task (collect.py) to attach
``site``/``captured_at`` and hand to ``db.insert_cwv``.

Only this fetch/normalize layer lives here: no DB writes, no scheduling, no
CLI, no GSC code.

Requires a Google API key (CrUX + PSI share the same key type) in the
``GOOGLE_API_KEY`` environment variable. Only consulted by the real
``_default_crux_query``/``_default_psi_query`` network calls -- callers
that inject their own ``crux_query``/``psi_query`` (as the tests do) never
need it set.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, replace
from typing import Callable

logger = logging.getLogger(__name__)

_CRUX_ENDPOINT = "https://chromeuxreport.googleapis.com/v1/records:queryRecord"
_PSI_ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed"
_API_KEY_ENV_VAR = "GOOGLE_API_KEY"
_FORM_FACTOR = "PHONE"

# Lighthouse category id in the PSI response -> CwvSnapshot field name.
# PSI reports scores as 0-1 floats; we store them as the 0-100 Lighthouse
# shows in its UI.
_LIGHTHOUSE_CATEGORIES = {
    "performance": "lh_performance",
    "accessibility": "lh_accessibility",
    "best-practices": "lh_best_practices",
    "seo": "lh_seo",
}

# Substring (case-insensitive) CrUX puts in the error message of a 404
# response when it simply has no field data recorded for the URL, as
# opposed to a genuine error (bad key, malformed URL, etc).
_CRUX_NOT_FOUND_PHRASE = "chrome ux report data not found"


@dataclass(frozen=True)
class CwvSnapshot:
    """One p75 Core Web Vitals observation for a URL.

    Deliberately omits ``site`` and ``captured_at``: ``fetch_cwv`` only
    receives a url, so a later task (collect.py) attaches those when
    writing to ``db.insert_cwv`` -- see ``to_db_row``.

    ``source`` describes the origin of the *field* metrics only: ``"crux"``
    (real field p75 data) or ``"psi"`` (lab data from a single Lighthouse
    run, stored in the same p75 columns as an approximation; distinguish by
    ``source`` when reading back). The four ``lh_*`` category scores always
    come from PSI/Lighthouse regardless of ``source`` -- they have no CrUX
    equivalent.

    Every ``lh_*`` score is 0-100, or ``None`` for "not fetched". **0 is a
    legitimate Lighthouse score**, so a None must never be read as a zero.
    """

    url: str
    lcp_p75: float | None
    inp_p75: float | None
    cls_p75: float | None
    source: str
    form_factor: str
    lh_performance: float | None = None
    lh_accessibility: float | None = None
    lh_best_practices: float | None = None
    lh_seo: float | None = None

    def to_db_row(self, site: str, captured_at: str) -> dict:
        """Shape this snapshot into a dict matching ``db.cwv_snapshots`` columns."""
        return {
            "site": site,
            "url": self.url,
            "captured_at": captured_at,
            "lcp_p75": self.lcp_p75,
            "inp_p75": self.inp_p75,
            "cls_p75": self.cls_p75,
            "source": self.source,
            "form_factor": self.form_factor,
            "lh_performance": self.lh_performance,
            "lh_accessibility": self.lh_accessibility,
            "lh_best_practices": self.lh_best_practices,
            "lh_seo": self.lh_seo,
        }


def _api_key() -> str:
    key = os.environ.get(_API_KEY_ENV_VAR)
    if not key:
        raise RuntimeError(
            f"{_API_KEY_ENV_VAR} environment variable is not set"
        )
    return key


def _is_crux_not_found_error(error_body: bytes | str) -> bool:
    """True if a CrUX error response body means "no data for this URL".

    Pure string check, kept separate from the network call so the tricky
    part of the CrUX 404 handling is unit-testable without touching
    ``urllib`` or an API key.
    """
    if isinstance(error_body, bytes):
        error_body = error_body.decode("utf-8", errors="replace")
    return _CRUX_NOT_FOUND_PHRASE in error_body.lower()


def _default_crux_query(url: str) -> dict | None:
    """Query the CrUX API for ``url``'s PHONE-form-factor field data.

    Returns the parsed ``record`` dict on success, or ``None`` if CrUX has
    no field data for this URL (a 404 whose error message matches
    ``_is_crux_not_found_error``). Any other error (bad key, 5xx, a 404
    for a different reason, ...) propagates.

    Real network call; not exercised by unit tests.
    """
    body = json.dumps({"url": url, "formFactor": _FORM_FACTOR}).encode("utf-8")
    request = urllib.request.Request(
        f"{_CRUX_ENDPOINT}?key={urllib.parse.quote(_api_key())}",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request) as response:
            return json.load(response)["record"]
    except urllib.error.HTTPError as exc:
        error_body = exc.read()
        if exc.code == 404 and _is_crux_not_found_error(error_body):
            return None
        raise


def _default_psi_query(url: str) -> dict | None:
    """Query PageSpeed Insights v5 (strategy=mobile) for ``url``.

    Returns the parsed PSI response dict on success. PSI doesn't have a
    CrUX-style "no data" error for a plain audit request, so this only
    returns ``None`` if the request truly yields no body; genuine "no
    usable lab metrics" detection happens in ``_parse_psi_response``.

    Real network call; not exercised by unit tests.
    """
    params = urllib.parse.urlencode(
        {"url": url, "strategy": "mobile", "key": _api_key()}
    )
    with urllib.request.urlopen(f"{_PSI_ENDPOINT}?{params}") as response:
        return json.load(response)


def _metric_p75(metrics: dict, key: str) -> float | None:
    """Pull a CrUX metric's p75 percentile, parsed to float (or None)."""
    metric = metrics.get(key)
    if not metric:
        return None
    value = metric.get("percentiles", {}).get("p75")
    if value is None:
        return None
    return float(value)  # CrUX returns CLS's p75 as a string; others as numbers.


def _parse_crux_record(url: str, record: dict) -> CwvSnapshot:
    """Turn a CrUX ``record`` dict into a ``CwvSnapshot`` (source="crux")."""
    metrics = record.get("metrics", {})
    return CwvSnapshot(
        url=url,
        lcp_p75=_metric_p75(metrics, "largest_contentful_paint"),
        inp_p75=_metric_p75(metrics, "interaction_to_next_paint"),
        cls_p75=_metric_p75(metrics, "cumulative_layout_shift"),
        source="crux",
        form_factor=_FORM_FACTOR,
    )


def _lighthouse_categories(data: dict) -> dict[str, float | None]:
    """Pull the four Lighthouse category scores out of a PSI response.

    Each is scaled from PSI's 0-1 ``score`` to 0-100. A category that is
    absent, or present with a null ``score`` (Lighthouse failed to run it),
    yields ``None`` -- "not fetched". A score of ``0`` yields ``0.0``, which
    is a real result and deliberately not the same thing.
    """
    categories = data.get("lighthouseResult", {}).get("categories", {})
    scores: dict[str, float | None] = {}
    for category_id, field in _LIGHTHOUSE_CATEGORIES.items():
        score = (categories.get(category_id) or {}).get("score")
        scores[field] = None if score is None else float(score) * 100
    return scores


def _parse_psi_response(url: str, data: dict) -> CwvSnapshot | None:
    """Turn a PSI v5 response into a ``CwvSnapshot`` (source="psi"), or None.

    Pulls lab metrics from ``lighthouseResult.audits``: LCP and CLS have
    lab equivalents (stored in the p75 columns as single-run
    approximations); INP is a field-only metric with no Lighthouse lab
    equivalent, so ``inp_p75`` is always None here. Also pulls the four
    Lighthouse category scores from ``lighthouseResult.categories``.
    Returns None if PSI has no usable lab result (neither LCP nor CLS
    present).
    """
    audits = data.get("lighthouseResult", {}).get("audits", {})
    lcp = audits.get("largest-contentful-paint", {}).get("numericValue")
    cls = audits.get("cumulative-layout-shift", {}).get("numericValue")

    if lcp is None and cls is None:
        return None

    return CwvSnapshot(
        url=url,
        lcp_p75=float(lcp) if lcp is not None else None,
        inp_p75=None,
        cls_p75=float(cls) if cls is not None else None,
        source="psi",
        form_factor=_FORM_FACTOR,
        **_lighthouse_categories(data),
    )


def fetch_cwv(
    url: str,
    *,
    crux_query: Callable[[str], dict | None] = _default_crux_query,
    psi_query: Callable[[str], dict | None] = _default_psi_query,
) -> CwvSnapshot | None:
    """Fetch Core Web Vitals and Lighthouse scores for ``url``.

    Calls **both** APIs every time. Field metrics (LCP/INP/CLS) prefer
    CrUX's real p75 data and fall back to PSI's lab values when CrUX has
    nothing for the URL; ``source`` records which was used. The Lighthouse
    category scores only exist in the PSI response, so PSI is queried even
    when CrUX succeeds -- otherwise the categories would disappear from a
    site exactly when it grew enough to earn CrUX field data.

    Returns None, without raising, if neither source has usable data.

    PSI is slow (roughly 10-30s per URL) and this doubles how often it is
    called. That is fine at three sites; revisit if the site count grows.
    Because a PSI failure is now a routine risk on a fetch that already
    succeeded, an exception from ``psi_query`` is swallowed (and logged)
    *when CrUX already returned field data* -- the snapshot keeps its field
    metrics and its categories read as "not fetched". With no CrUX data
    there is nothing to salvage, so the error propagates to the caller.

    Args:
        url: The page URL to fetch metrics for.
        crux_query: ``(url) -> dict | None``. Returns the parsed CrUX
            ``record``, or None to signal "no field data for this URL".
            Injected for testing; defaults to the real CrUX API call.
        psi_query: ``(url) -> dict | None``. Returns the parsed PSI
            response, or None to signal "no PSI result at all". Injected
            for testing; defaults to the real PSI API call.
    """
    record = crux_query(url)

    if record is None:
        psi_data = psi_query(url)
        if psi_data is None:
            return None
        return _parse_psi_response(url, psi_data)

    snapshot = _parse_crux_record(url, record)
    try:
        psi_data = psi_query(url)
    except Exception as exc:  # noqa: BLE001 - keep the CrUX field data
        logger.warning(
            "PSI fetch failed for %s; keeping CrUX field metrics, "
            "Lighthouse categories not fetched: %s",
            url,
            exc,
        )
        return snapshot

    if psi_data is None:
        return snapshot

    return replace(snapshot, **_lighthouse_categories(psi_data))
