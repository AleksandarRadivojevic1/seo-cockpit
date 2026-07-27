"""Config loading for the seocockpit collector.

Reads sites.yaml (the single source of truth for site list, database path,
and service account credentials path) into typed objects.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import yaml

DEFAULT_CONFIG_PATH = Path(__file__).resolve().parent.parent / "sites.yaml"

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


def load_config(path: str | Path | None = None) -> Config:
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
                trend_seeds=tuple(raw_site.get("trend_seeds") or ()),
                serp_location=raw_site.get("serp_location") or None,
            )
        )

    return Config(
        sites=sites,
        db_path=raw["db_path"],
        service_account_path=raw["service_account_path"],
    )
