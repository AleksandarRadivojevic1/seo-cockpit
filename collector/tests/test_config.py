from pathlib import Path

import pytest

from seocockpit.config import Config, Site, load_config

FIXTURES_DIR = Path(__file__).resolve().parent


def test_load_config_parses_fixture_into_typed_objects():
    config = load_config(FIXTURES_DIR / "fixture_sites.yaml")

    assert isinstance(config, Config)
    assert config.db_path == "data/test.db"
    assert config.service_account_path == "secrets/test-service-account.json"

    assert config.sites == [
        Site(
            property="sc-domain:example.com",
            slug="example",
            display_name="Example",
            brand_token="example",
        ),
        Site(
            property="https://example.org/",
            slug="example-org",
            display_name="Example Org",
            brand_token="exampleorg",
        ),
    ]
    assert all(isinstance(site, Site) for site in config.sites)


def test_load_config_missing_required_key_raises_clear_error():
    with pytest.raises(ValueError, match="service_account_path"):
        load_config(FIXTURES_DIR / "fixture_sites_missing_key.yaml")


def test_load_config_site_missing_slug_raises():
    with pytest.raises(ValueError, match="slug"):
        load_config(FIXTURES_DIR / "fixture_sites_missing_slug.yaml")


def test_load_config_duplicate_slug_raises():
    with pytest.raises(ValueError, match="duplicate-slug"):
        load_config(FIXTURES_DIR / "fixture_sites_duplicate_slug.yaml")


def test_discover_seeds_are_loaded_and_default_to_empty(tmp_path):
    """Hand-written seeds for sites whose slugs cannot produce them."""
    path = tmp_path / "sites.yaml"
    path.write_text(
        """
db_path: data/seo.db
service_account_path: secrets/sa.json
sites:
  - property: "https://skedio.rs/"
    slug: skedio
    display_name: Skedio
    brand_token: skedio
    discover_seeds:
      - "aplikacija za zakazivanje"
      - "aplikacija za salon"
  - property: "https://optikacajs.rs/"
    slug: optika-cajs
    display_name: Optika Cajs
    brand_token: cajs
""",
        encoding="utf-8",
    )
    config = load_config(path)
    by_slug = {s.slug: s for s in config.sites}

    assert by_slug["skedio"].discover_seeds == (
        "aplikacija za zakazivanje",
        "aplikacija za salon",
    )
    # A site that does not need them gets an empty tuple, not None -- callers
    # test truthiness to decide between configured and derived seeds.
    assert by_slug["optika-cajs"].discover_seeds == ()


def test_serp_location_defaults_to_none_not_empty_string(tmp_path):
    # None means country-level. An empty string would be sent to SerpApi as a
    # location and rejected.
    path = tmp_path / "sites.yaml"
    path.write_text(
        """
db_path: data/seo.db
service_account_path: secrets/sa.json
sites:
  - property: "https://optikacajs.rs/"
    slug: optika-cajs
    display_name: Optika Cajs
    brand_token: cajs
""",
        encoding="utf-8",
    )
    assert load_config(path).sites[0].serp_location is None
