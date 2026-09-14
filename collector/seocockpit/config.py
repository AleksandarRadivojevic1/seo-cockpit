"""Config loading for the seocockpit collector.

Reads sites.yaml (the single source of truth for site list, database path,
and service account credentials path) into typed objects.
"""

from __future__ import annotations

import json
import logging
import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

import yaml

logger = logging.getLogger(__name__)

DEFAULT_CONFIG_PATH = Path(__file__).resolve().parent.parent / "sites.yaml"

# Path to the dashboard-written user sites file, when not passed explicitly.
USER_SITES_ENV = "SEO_USER_SITES_PATH"

_REQUIRED_TOP_LEVEL_KEYS = ("db_path", "service_account_path", "sites")
_REQUIRED_SITE_KEYS = ("property", "slug", "display_name", "brand_token")


@dataclass(frozen=True)
class Site:
    property: str
    slug: str
    display_name: str
    brand_token: str
    # Head terms to feed Google Trends, per site and OPTIONAL by design.
    #
    # Trends has a volume floor: measured against the real account,
    # `naočare` and `sočiva` return data while `naočare za vid` and
    # `kontaktna sočiva` return nothing at all. Terms broad enough to clear
    # the floor can also be too broad to be yours -- `zakazivanje` returns
    # government appointment booking, not booking software -- so these are
    # chosen by hand rather than derived, and a site with no good head term
    # simply leaves them empty.
    # Hand-written seeds for free autocomplete discovery. OPTIONAL, and when
    # present they REPLACE the slugs derived from page_daily rather than
    # adding to them.
    #
    # Why this has to exist: slug-derived seeds work for shops and fail for
    # SaaS. An e-commerce site's slugs ARE product categories
    # (/naocare-za-sunce, /dioptrijski-okviri), so autocomplete expands them
    # into real demand. A single-product SaaS has only site sections --
    # pricing, refunds, contact, terms -- and expanding those returns
    # whatever the wider internet associates with the bare word. Skedio's
    # /cene/ and /povrat/ produced 548 keywords about fuel prices and a
    # Serbian film before this existed.
    discover_seeds: tuple[str, ...] = ()
    trend_seeds: tuple[str, ...] = ()
    # City to request SERPs from, e.g. "Leskovac, Serbia". OPTIONAL.
    #
    # Load-bearing for a local business and wrong for everyone else:
    # Google's results for "optika" from Leskovac and from Belgrade are not
    # the same SERP, and a local optician competes with the shops in its own
    # city. Left unset, checks are country-level (gl/hl only), which is the
    # right frame for a SaaS with no geography.
    serp_location: str | None = None


@dataclass(frozen=True)
class Config:
    sites: list[Site]
    db_path: str
    service_account_path: str


def _site_from_dict(raw: Mapping, source: str) -> Site | None:
    """Build a ``Site`` from a raw mapping, or ``None`` (logged) if invalid.

    Used for the dashboard-written user sites, which unlike ``sites.yaml`` are
    edited at runtime and may be incomplete. A missing required key skips just
    that entry rather than aborting the whole run.
    """
    for key in _REQUIRED_SITE_KEYS:
        if key not in raw:
            logger.warning(
                "skipping %s entry missing required key '%s': %r", source, key, raw
            )
            return None
    return Site(
        property=raw["property"],
        slug=raw["slug"],
        display_name=raw["display_name"],
        brand_token=raw["brand_token"],
        discover_seeds=tuple(raw.get("discover_seeds") or ()),
        trend_seeds=tuple(raw.get("trend_seeds") or ()),
        serp_location=raw.get("serp_location") or None,
    )


def _load_user_sites(path: str | Path | None) -> list[Site]:
    """Read the dashboard-written user-sites JSON array. Never raises.

    ``path`` defaults to the ``SEO_USER_SITES_PATH`` env var; unset means the
    feature is dormant and no user sites are loaded. A missing file, malformed
    JSON, or a non-array payload yields an empty list (logged) so a bad config
    can never abort collection of the ``sites.yaml`` seed sites.
    """
    if path is None:
        env = os.environ.get(USER_SITES_ENV)
        if not env:
            return []
        path = env
    p = Path(path)
    if not p.exists():
        return []
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        logger.warning("could not read user sites file %s: %s", p, e)
        return []
    if not isinstance(raw, list):
        logger.warning("user sites file %s is not a JSON array; ignoring", p)
        return []
    sites: list[Site] = []
    for entry in raw:
        if not isinstance(entry, Mapping):
            logger.warning("skipping non-object user site entry: %r", entry)
            continue
        site = _site_from_dict(entry, "user-sites.json")
        if site is not None:
            sites.append(site)
    return sites


def load_config(
    path: str | Path | None = None,
    user_sites_path: str | Path | None = None,
) -> Config:
    """Load and parse the collector config from a sites.yaml file.

    Args:
        path: Path to the YAML config file. Defaults to the repo's
            collector/sites.yaml.

    Raises:
        ValueError: If a required top-level or per-site key is missing, or
            if two sites share the same ``slug``.
    """
    config_path = Path(path) if path is not None else DEFAULT_CONFIG_PATH

    with open(config_path, "r", encoding="utf-8") as f:
        raw = yaml.safe_load(f)

    for key in _REQUIRED_TOP_LEVEL_KEYS:
        if key not in raw:
            raise ValueError(
                f"Missing required key '{key}' in config file: {config_path}"
            )

    sites = []
    seen_slugs: set[str] = set()
    for index, raw_site in enumerate(raw["sites"]):
        for key in _REQUIRED_SITE_KEYS:
            if key not in raw_site:
                raise ValueError(
                    f"Missing required key '{key}' in sites[{index}] "
                    f"of config file: {config_path}"
                )
        slug = raw_site["slug"]
        if slug in seen_slugs:
            raise ValueError(
                f"Duplicate slug '{slug}' in sites[{index}] "
                f"of config file: {config_path}"
            )
        seen_slugs.add(slug)
        sites.append(
            Site(
                property=raw_site["property"],
                slug=slug,
                display_name=raw_site["display_name"],
                brand_token=raw_site["brand_token"],
                discover_seeds=tuple(raw_site.get("discover_seeds") or ()),
                trend_seeds=tuple(raw_site.get("trend_seeds") or ()),
                serp_location=raw_site.get("serp_location") or None,
            )
        )

    # Append dashboard-added sites after the YAML seeds. On a slug collision
    # the YAML seed wins and the user entry is dropped (the dashboard already
    # prevents this at submit time; this is defence in depth).
    for user_site in _load_user_sites(user_sites_path):
        if user_site.slug in seen_slugs:
            logger.warning(
                "user site slug '%s' collides with a configured site; dropping",
                user_site.slug,
            )
            continue
        seen_slugs.add(user_site.slug)
        sites.append(user_site)

    return Config(
        sites=sites,
        db_path=raw["db_path"],
        service_account_path=raw["service_account_path"],
    )
