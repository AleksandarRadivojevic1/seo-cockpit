"""Market-demand discovery: what people search, whether or not you rank.

Search Console can only report queries a site has *already appeared* for, so
it structurally cannot answer "what am I missing". Measured on the real
portfolio, the gap is the whole story: optikacajs has 13 known queries of
which 44 of 56 impressions are its own brand name. This module supplies the
other side of that picture.

Two sources, both behind ``DemandSource`` so a third (DataForSEO, Keyword
Planner) can be added without touching storage or the dashboard:

``AutocompleteSource``
    Google's suggest endpoint. Free, unmetered, no credentials, and verified
    working for Serbian. Provides breadth and long tail. Gives no volume.

``SerpApiTrendsSource``
    Google Trends ``RELATED_QUERIES`` via SerpApi. Provides the *rising*
    signal nothing else here can. Metered -- one credit per seed on a 250/mo
    plan -- so it is deliberately NOT part of scheduled collection and runs
    only when invoked explicitly.

**Trends has a volume floor, measured 2026-07-26 against the real account.**
``naočare`` and ``sočiva`` return data; ``naočare za vid`` and ``kontaktna
sočiva`` return nothing at all. So head terms work and 2-3 word long tail does
not -- which creates a real tension: terms specific enough to be relevant are
often below the floor, and terms above it can be too broad to be yours
(``zakazivanje`` returns government appointment booking, not booking
software). Trends seeds are therefore configured per site and opt-in, never
derived automatically.
"""

from __future__ import annotations

import json
import re
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable, Protocol

SOURCE_AUTOCOMPLETE = "autocomplete"
SOURCE_SERPAPI_TRENDS = "serpapi_trends"

_SUGGEST_ENDPOINT = "https://suggestqueries.google.com/complete/search"
_SERPAPI_ENDPOINT = "https://serpapi.com/search"
_SERPAPI_ACCOUNT_ENDPOINT = "https://serpapi.com/account"

# Serbian question prefixes. This is what AnswerThePublic and AlsoAsked sell;
# autocomplete gives the same thing free when seeded with question words.
QUESTION_PREFIXES = ("kako", "gde", "koliko", "zašto", "da li", "koji", "kada", "šta")

# Suffix alphabet for expansion. Latin letters only: Google's suggest handles
# the diacritic-free forms Serbian users actually type, and adding the
# Cyrillic alphabet roughly doubles the request count for near-duplicate
# results.
SUFFIX_ALPHABET = tuple("abcdefgijklmnoprstuvz")


def fold_diacritics(text: str) -> str:
    """Normalize Serbian text for comparison, matching the dashboard's rule.

    ``đ`` has no combining-mark decomposition so it is mapped explicitly;
    every other diacritic is stripped via NFKD. Mirrors ``foldDiacritics`` in
    the dashboard's ``lib/analysis/brand.ts`` -- the two must agree or a
    keyword will look like a gap on one side and a match on the other.
    """
    text = text.replace("đ", "dj").replace("Đ", "Dj")
    return "".join(
        c for c in unicodedata.normalize("NFKD", text.lower()) if not unicodedata.combining(c)
    )


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass(frozen=True)
class DemandKeyword:
    """One discovered keyword. Every measure is optional by design.

    ``None`` means "this source does not measure it", never zero. See the
    ``demand_keywords`` schema comment for why that distinction is enforced
    all the way to the column.
    """

    keyword: str
    source: str
    seed: str | None = None
    suggest_rank: int | None = None
    rising_pct: float | None = None
    rising_label: str | None = None
    top_value: float | None = None
    volume: float | None = None

    def as_row(self, site: str, *, now: str | None = None) -> dict:
        stamp = now or _now_iso()
        return {
            "site": site,
            "keyword": self.keyword,
            "source": self.source,
            "seed": self.seed,
            "suggest_rank": self.suggest_rank,
            "rising_pct": self.rising_pct,
            "rising_label": self.rising_label,
            "top_value": self.top_value,
            "volume": self.volume,
            "first_seen": stamp,
            "last_seen": stamp,
        }


class DemandSource(Protocol):
    """A source of demand keywords for a seed term."""

    name: str

    def expand(self, seed: str) -> list[DemandKeyword]:
        """Return keywords related to ``seed``. Must not raise on no-data."""
        ...


def _http_get_json(url: str, *, timeout: int = 20) -> dict | list:
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8", "replace"))


class AutocompleteSource:
    """Google suggest. Free, unmetered, no credentials.

    Returns keywords in Google's own order and records that order as
    ``suggest_rank``. That ordering correlates loosely with popularity, which
    is worth keeping as a tiebreak -- but it is not a volume and is never
    presented as one.
    """

    name = SOURCE_AUTOCOMPLETE

    def __init__(
        self,
        *,
        hl: str = "sr",
        gl: str = "RS",
        delay_seconds: float = 0.12,
        fetch=None,
    ) -> None:
        self.hl = hl
        self.gl = gl
        self.delay_seconds = delay_seconds
        # Injectable so tests never touch the network.
        self._fetch = fetch or _http_get_json

    def _suggest(self, query: str) -> list[str]:
        params = urllib.parse.urlencode(
            {"client": "firefox", "hl": self.hl, "gl": self.gl, "q": query}
        )
        try:
            payload = self._fetch(f"{_SUGGEST_ENDPOINT}?{params}")
        except (urllib.error.URLError, urllib.error.HTTPError, ValueError, TimeoutError):
            # A single failed suffix must not abandon the whole expansion --
            # discovery is best-effort breadth, not a transactional fetch.
            return []
        if isinstance(payload, list) and len(payload) > 1 and isinstance(payload[1], list):
            return [s for s in payload[1] if isinstance(s, str)]
        return []

    def expand(self, seed: str) -> list[DemandKeyword]:
        """Expand one seed: the bare term, then a-z and question prefixes."""
        found: dict[str, DemandKeyword] = {}
        variants = [seed]
        variants += [f"{seed} {letter}" for letter in SUFFIX_ALPHABET]
        variants += [f"{prefix} {seed}" for prefix in QUESTION_PREFIXES]

        for variant in variants:
            for rank, suggestion in enumerate(self._suggest(variant)):
                # Keep the FIRST sighting: it came from the shortest, most
                # direct variant, so its rank is the most meaningful one.
                if suggestion not in found:
                    found[suggestion] = DemandKeyword(
                        keyword=suggestion,
                        source=self.name,
                        seed=seed,
                        suggest_rank=rank,
                    )
            if self.delay_seconds:
                time.sleep(self.delay_seconds)
        return list(found.values())


def parse_rising_value(raw) -> tuple[float | None, str | None]:
    """Split a Trends rising value into a number and a label.

    Trends reports either a percentage (``"+90%"``, ``"+1,250%"``) or the
    literal ``"Breakout"``, which means growth above 5000% and has no upper
    bound. Breakout therefore yields ``(None, "Breakout")`` -- turning it into
    a float would invent a precision Google explicitly refused to give, and
    would sort a genuinely explosive term below a merely large percentage.
    """
    if raw is None:
        return None, None
    if isinstance(raw, (int, float)):
        return float(raw), None
    text = str(raw).strip()
    if not text:
        return None, None
    if "breakout" in text.lower():
        return None, "Breakout"
    match = re.search(r"-?[\d.,]+", text)
    if not match:
        return None, text
    try:
        return float(match.group(0).replace(",", "").rstrip(".")), text
    except ValueError:
        return None, text


class SerpApiTrendsSource:
    """Google Trends RELATED_QUERIES via SerpApi. METERED -- 1 credit/seed.

    Deliberately not wired into scheduled collection: the free plan is 250
    searches per month, and a daily job across several seeds would exhaust it
    without being asked. Invoked explicitly instead.

    Returns nothing (not an error) when Trends has no data for a term, which
    is the common case below its volume floor.
    """

    name = SOURCE_SERPAPI_TRENDS

    def __init__(
        self,
        api_key: str,
        *,
        geo: str = "RS",
        date: str = "today 12-m",
        fetch=None,
    ) -> None:
        self.api_key = api_key
        self.geo = geo
        self.date = date
        self._fetch = fetch or _http_get_json

    def searches_left(self) -> int | None:
        """Remaining monthly credits. Costs no credit itself."""
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

    def expand(self, seed: str) -> list[DemandKeyword]:
        params = urllib.parse.urlencode(
            {
                "engine": "google_trends",
                "q": seed,
                "geo": self.geo,
                "date": self.date,
                "data_type": "RELATED_QUERIES",
                "api_key": self.api_key,
            }
        )
        try:
            payload = self._fetch(f"{_SERPAPI_ENDPOINT}?{params}")
        except Exception:
            return []
        if not isinstance(payload, dict) or payload.get("error"):
            # "Google Trends hasn't returned any results for this query" is
            # the normal below-the-floor response, not a failure worth raising.
            return []

        related = payload.get("related_queries") or {}
        out: list[DemandKeyword] = []

        for entry in related.get("rising") or []:
            keyword = (entry or {}).get("query")
            if not keyword:
                continue
            pct, label = parse_rising_value(entry.get("value"))
            out.append(
                DemandKeyword(
                    keyword=keyword,
                    source=self.name,
                    seed=seed,
                    rising_pct=pct,
                    rising_label=label,
                )
            )

        for entry in related.get("top") or []:
            keyword = (entry or {}).get("query")
            if not keyword:
                continue
            value = entry.get("value")
            out.append(
                DemandKeyword(
                    keyword=keyword,
                    source=self.name,
                    seed=seed,
                    top_value=float(value) if isinstance(value, (int, float)) else None,
                )
            )
        return out


# Navigation slugs that name a PAGE rather than a topic. Expanding them
# produces confident nonsense -- measured on real data, `usluge` returned
# "usluge elektricara cene" and "usluge zavarivanja cena" (electricians,
# welders) and `kontakt` returned "gde se nalaze kontakti u gmailu" and
# "koliko traje kontaktni dermatitis". The words are semantically empty
# outside their site, so autocomplete answers a question nobody asked.
GENERIC_SLUGS = frozenset(
    {
        "kontakt",
        "kontakti",
        "usluge",
        "dodaci",
        "o-nama",
        "o nama",
        "onama",
        "uslovi",
        "uslovi koriscenja",
        "uslovi korišćenja",
        "privatnost",
        "reklamacije",
        "zakazivanje",
        "blog",
        "faq",
        "cesta pitanja",
        "about",
        "contact",
        "terms",
        "privacy",
        # --- added 2026-07-27, after these produced 548 junk keywords ---
        #
        # These read as topical rather than navigational, which is exactly
        # why they slipped through the first pass. They are not: outside the
        # site that owns them they are bare common nouns, and autocomplete
        # completes the word, not the context.
        #
        # Measured on the real API:
        #   "cene"   -> cene goriva / cene goriva u srbiji / cene goriva danas
        #               (fuel prices, every single completion)
        #   "povrat" -> povratak zikine dinastije (a film), povratak otpisanih
        #               (a TV series), povratna karta beograd bar (a train)
        #
        # Between them they generated ALL 548 of skedio's demand keywords,
        # none of which had anything to do with booking software.
        "cene",
        "cena",
        "cenovnik",
        "povrat",
        "povracaj",
        "pricing",
        "prices",
        "refund",
        "refunds",
        "returns",
        "dostava",
        "placanje",
        "shipping",
        "delivery",
    }
)


def seeds_from_pages(pages: Iterable[str], *, min_words: int = 1) -> list[str]:
    """Derive seed phrases from a site's own page URLs.

    Slugs encode what a page is about (``/kontaktna-sociva``,
    ``/dioptrijski-okviri``) and cost nothing to obtain -- the collector
    already stores them in ``page_daily``. Product-detail slugs are skipped:
    they name individual SKUs (``/proizvod/ray-ban-aviator-rb3025``) and
    expand into model numbers rather than demand.
    """
    seeds: dict[str, None] = {}
    for page in pages:
        path = urllib.parse.urlparse(page).path.strip("/")
        if not path:
            continue
        segments = [s for s in path.split("/") if s]
        if len(segments) > 1:
            continue
        slug = segments[0]
        words = [w for w in re.split(r"[-_]+", slug) if w]
        if len(words) < min_words:
            continue
        phrase = " ".join(words)
        if not phrase or phrase in seeds:
            continue
        if slug.lower() in GENERIC_SLUGS or phrase.lower() in GENERIC_SLUGS:
            continue
        seeds[phrase] = None
    return list(seeds)


def discover(
    site: str,
    sources: Iterable[DemandSource],
    seeds: Iterable[str],
    *,
    now: str | None = None,
) -> list[dict]:
    """Run every source over every seed and return ``demand_keywords`` rows.

    One source failing or returning nothing never stops the others: demand
    discovery is additive, and a partial picture beats none.
    """
    stamp = now or _now_iso()
    seen: set[tuple[str, str]] = set()
    rows: list[dict] = []
    for source in sources:
        for seed in seeds:
            for keyword in source.expand(seed):
                key = (keyword.keyword, keyword.source)
                if key in seen:
                    continue
                seen.add(key)
                rows.append(keyword.as_row(site, now=stamp))
    return rows
