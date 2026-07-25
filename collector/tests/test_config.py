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
