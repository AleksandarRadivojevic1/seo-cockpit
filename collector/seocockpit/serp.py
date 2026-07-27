"""Live Google SERP checks via SerpApi (Task 2.5). METERED: 1 credit each.

Kept separate from ``demand.py`` on purpose. Discovery is free, unmetered and
re-runnable; a SERP check costs money and is a statement about one moment in
time. Mixing them would make it too easy to re-run something expensive by
reaching for something cheap.

**The invariant everything here protects:** a stored check means the check
succeeded. ``SerpApiSearchSource.check`` returns ``None`` on any error or
malformed response and never a partial result, so a failed lookup writes
nothing rather than rendering as "nobody ranks for this".

Nothing in this module classifies anything. It records which domains held
which positions; deciding whether a domain is a marketplace, a competitor or
a blog happens in the dashboard, where changing your mind is free.
"""

from __future__ import annotations

import datetime
import json
import logging
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Callable, Iterable

logger = logging.getLogger(__name__)

SOURCE_SERPAPI_SEARCH = "serpapi_search"

_SERPAPI_ENDPOINT = "https://serpapi.com/search"
_SERPAPI_ACCOUNT_ENDPOINT = "https://serpapi.com/account"
_SERPAPI_LOCATIONS_ENDPOINT = "https://serpapi.com/locations.json"


class UnsupportedLocation(Exception):
    """A configured ``serp_location`` is not one SerpApi knows about."""


def validate_location(
    location: str,
    *,
    fetch: Callable[..., dict | list] | None = None,
) -> str:
    """Return the canonical SerpApi name for ``location``, or raise.

    Checked BEFORE any credit is spent. SerpApi rejects an unknown location
    with HTTP 400 mid-search, and while that particular failure happens to
    cost nothing today, discovering it one keyword into a fifteen-keyword run
    is still the wrong time to find out.

    Measured, not assumed: **SerpApi has no entry for Leskovac.** The nearest
    supported city is ``Nis,Serbia``, ~45 km away. The canonical form also has
    no space after the comma, so "Leskovac, Serbia" was wrong twice over.

    The locations endpoint is free and costs no credit.
    """
    getter = fetch or _http_get_json
    query = location.split(",")[0].strip()
    params = urllib.parse.urlencode({"q": query, "limit": 25})
    try:
        payload = getter(f"{_SERPAPI_LOCATIONS_ENDPOINT}?{params}")
    except Exception as e:
        # Unreachable endpoint is "unknown", not "invalid" -- the same rule
        # that keeps an unreadable credit balance from blocking a run.
        logger.warning("could not validate location %r (%s); passing it through", location, e)
        return location

    names = [
        entry.get("canonical_name")
        for entry in (payload if isinstance(payload, list) else [])
        if isinstance(entry, dict) and entry.get("canonical_name")
    ]
    normalized = location.replace(", ", ",").strip()
    for name in names:
        if name.lower() == normalized.lower():
            return name

    suggestions = ", ".join(names[:6]) or "none"
    raise UnsupportedLocation(
        f"SerpApi does not support the location {location!r}. "
        f"Nearest matches for {query!r}: {suggestions}. "
        f"Leave serp_location unset for country-level results."
    )

# Organic positions examined per check. SerpApi returns roughly this many on
# page one, and every stored check records the depth it actually used so
# "not in top N" is always a falsifiable claim rather than a bare "not
# ranking".
DEFAULT_DEPTH = 10

# Default market. Serbian results for a Serbian portfolio.
DEFAULT_GEO = "rs"
DEFAULT_LANGUAGE = "sr"


@dataclass(frozen=True)
class SerpResult:
    position: int
    domain: str
    url: str
    title: str | None = None


@dataclass(frozen=True)
class SerpCheck:
    keyword: str
    checked_at: str
    geo: str
    language: str
    location: str | None
    depth_checked: int
    local_pack: bool | None
    ads_top: int
    ads_bottom: int
    our_position: int | None
    results: list[SerpResult] = field(default_factory=list)


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _http_get_json(url: str, *, timeout: int = 30) -> dict | list:
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8", "replace"))


def registrable_domain(url: str) -> str:
    """Host of a URL, lowercased, with a leading ``www.`` stripped.

    Deliberately NOT a public-suffix-aware eTLD+1: ``optikacajs.rs`` and
    ``shop.optikacajs.rs`` are genuinely different places to rank and
    collapsing them would hide that. Stripping ``www.`` is safe because it
    is a convention, not a subdomain anyone ranks separately.
    """
    host = urllib.parse.urlsplit(url).netloc.lower()
    if "@" in host:
        host = host.rsplit("@", 1)[1]
    if ":" in host:
        host = host.split(":", 1)[0]
    return host[4:] if host.startswith("www.") else host


def own_domain_for(site_property: str) -> str:
    """Domain to look for in a SERP, from a GSC property string.

    ``https://optikacajs.rs/`` -> ``optikacajs.rs``
    ``sc-domain:alexrad.dev``  -> ``alexrad.dev``
    """
    if site_property.startswith("sc-domain:"):
        return site_property[len("sc-domain:") :].strip().lower()
    return registrable_domain(site_property)


def select_gap_keywords(
    demand_keywords: Iterable[tuple[str, int | None, str | None]],
    ever_ranked: Iterable[str],
    fold: Callable[[str], str],
    limit: int,
) -> list[str]:
    """Keywords the site does NOT already rank for, diverse across seeds.

    ``demand_keywords`` is ``(keyword, suggest_rank, seed)`` triples;
    ``ever_ranked`` is every query the site has ever appeared for.

    Comparison is on FOLDED text because Serbian users type both ``sočiva``
    and ``sociva`` and GSC reports whichever was typed -- a raw comparison
    would call a keyword a gap while the site already ranks for the other
    spelling.

    **Selection round-robins across seeds**, taking each seed's best-ranked
    unchecked keyword before any seed's second. Sorting purely by
    ``suggest_rank`` looked right and was measurably wrong: on the real
    database it returned six variants of "dioptrijski okviri" in the first
    eight, because rank ties break alphabetically. Every credit is a
    question you only get to ask 250 times a month, so asking six near
    duplicates is the expensive mistake here.

    A NULL ``suggest_rank`` sorts LAST rather than as 0: unknown popularity
    is not the strongest possible popularity.
    """
    ranked_folded = {fold(q) for q in ever_ranked}

    by_seed: dict[str, list[tuple[int, str]]] = {}
    seen: set[str] = set()
    for keyword, suggest_rank, seed in demand_keywords:
        folded = fold(keyword)
        if folded in ranked_folded or folded in seen:
            continue
        seen.add(folded)
        order = suggest_rank if suggest_rank is not None else 10**6
        by_seed.setdefault(seed or "", []).append((order, keyword))

    for bucket in by_seed.values():
        bucket.sort(key=lambda pair: (pair[0], pair[1]))

    chosen: list[str] = []
    # Seeds in a stable order so a dry-run and the real run agree.
    seeds = sorted(by_seed)
    depth = 0
    while len(chosen) < limit:
        added_this_pass = False
        for seed in seeds:
            bucket = by_seed[seed]
            if depth < len(bucket):
                chosen.append(bucket[depth][1])
                added_this_pass = True
                if len(chosen) == limit:
                    return chosen
        if not added_this_pass:
            break
        depth += 1
    return chosen


class SerpApiSearchSource:
    """Google organic results via SerpApi. One credit per ``check`` call."""

    name = SOURCE_SERPAPI_SEARCH

    def __init__(
        self,
        api_key: str,
        *,
        geo: str = DEFAULT_GEO,
        language: str = DEFAULT_LANGUAGE,
        depth: int = DEFAULT_DEPTH,
        location: str | None = None,
        fetch: Callable[..., dict | list] | None = None,
    ) -> None:
        self.api_key = api_key
        self.geo = geo
        self.language = language
        self.depth = depth
        self.location = location
        self._fetch = fetch or _http_get_json

    def searches_left(self) -> int | None:
        """Remaining monthly credits. Costs no credit itself.

        ``None`` means "could not read it", which is NOT zero -- an
        unreadable account endpoint must not silently block a legitimate run.
        """
        params = urllib.parse.urlencode({"api_key": self.api_key})
        try:
            payload = self._fetch(f"{_SERPAPI_ACCOUNT_ENDPOINT}?{params}")
        except Exception:
            return None
        if isinstance(payload, dict):
            value = payload.get("total_searches_left")
            if isinstance(value, (int, float)):
                return int(value)
        return None

    def _params(self, keyword: str) -> str:
        params = {
            "engine": "google",
            "q": keyword,
            "gl": self.geo,
            "hl": self.language,
            "num": self.depth,
            "api_key": self.api_key,
        }
        if self.location:
            # City-level results. Load-bearing for a local business: Google's
            # results for "optika" from Leskovac and from Belgrade are not the
            # same SERP, and a local optician competes with shops in its city.
            params["location"] = self.location
        return urllib.parse.urlencode(params)

    def check(self, keyword: str, own_domain: str) -> SerpCheck | None:
        """One SERP lookup. Returns None on ANY failure -- never partial data."""
        try:
            payload = self._fetch(f"{_SERPAPI_ENDPOINT}?{self._params(keyword)}")
        except Exception as e:
            logger.warning("serp check failed for %r: %s", keyword, e)
            return None

        if not isinstance(payload, dict) or payload.get("error"):
            logger.warning(
                "serp check returned an error for %r: %s",
                keyword,
                payload.get("error") if isinstance(payload, dict) else "malformed response",
            )
            return None

        organic = payload.get("organic_results")
        if organic is None:
            # Distinct from an error: Google genuinely returned no organic
            # results. Rare, real, and worth recording as a finding.
            organic = []
        if not isinstance(organic, list):
            logger.warning("serp check returned a malformed organic_results for %r", keyword)
            return None

        results: list[SerpResult] = []
        our_position: int | None = None
        for index, entry in enumerate(organic[: self.depth], start=1):
            if not isinstance(entry, dict):
                continue
            link = entry.get("link")
            if not link:
                continue
            # Trust our own enumeration over SerpApi's `position` field: the
            # stored position must agree with depth_checked, and a provider
            # that renumbers around ads would silently break that.
            position = index
            domain = registrable_domain(link)
            results.append(
                SerpResult(
                    position=position,
                    domain=domain,
                    url=link,
                    title=entry.get("title"),
                )
            )
            if our_position is None and (domain == own_domain or domain.endswith(f".{own_domain}")):
                our_position = position

        ads = payload.get("ads")
        ads_list = ads if isinstance(ads, list) else []
        ads_top = sum(1 for a in ads_list if isinstance(a, dict) and a.get("block_position") != "bottom")
        ads_bottom = sum(1 for a in ads_list if isinstance(a, dict) and a.get("block_position") == "bottom")

        local_pack = payload.get("local_results")
        if local_pack is None:
            has_local_pack: bool | None = False
        elif isinstance(local_pack, dict):
            has_local_pack = bool(local_pack.get("places"))
        elif isinstance(local_pack, list):
            has_local_pack = bool(local_pack)
        else:
            has_local_pack = None

        return SerpCheck(
            keyword=keyword,
            checked_at=_now_iso(),
            geo=self.geo,
            language=self.language,
            location=self.location,
            depth_checked=self.depth,
            local_pack=has_local_pack,
            ads_top=ads_top,
            ads_bottom=ads_bottom,
            our_position=our_position,
            results=results,
        )


def to_rows(site: str, check: SerpCheck) -> tuple[dict, list[dict]]:
    """Flatten a SerpCheck into the (check_row, result_rows) db.py expects."""
    check_row = {
        "site": site,
        "keyword": check.keyword,
        "checked_at": check.checked_at,
        "geo": check.geo,
        "language": check.language,
        "location": check.location,
        "depth_checked": check.depth_checked,
        "local_pack": None if check.local_pack is None else int(check.local_pack),
        "ads_top": check.ads_top,
        "ads_bottom": check.ads_bottom,
        "our_position": check.our_position,
    }
    result_rows = [
        {
            "site": site,
            "keyword": check.keyword,
            "checked_at": check.checked_at,
            "position": r.position,
            "domain": r.domain,
            "url": r.url,
            "title": r.title,
        }
        for r in check.results
    ]
    return check_row, result_rows
