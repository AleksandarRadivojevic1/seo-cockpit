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


def test_load_config_merges_user_sites():
    config = load_config(
        FIXTURES_DIR / "fixture_sites.yaml",
        user_sites_path=FIXTURES_DIR / "fixture_user_sites.json",
    )
    slugs = [s.slug for s in config.sites]
    assert slugs == ["example", "example-org", "agency"]
    agency = next(s for s in config.sites if s.slug == "agency")
    assert agency.property == "sc-domain:agency.example"
    assert agency.brand_token == "agency"


def test_load_config_missing_user_sites_file_is_ignored(tmp_path):
    config = load_config(
        FIXTURES_DIR / "fixture_sites.yaml",
        user_sites_path=tmp_path / "does-not-exist.json",
    )
    assert [s.slug for s in config.sites] == ["example", "example-org"]


def test_load_config_malformed_user_sites_is_ignored(tmp_path):
    bad = tmp_path / "user-sites.json"
    bad.write_text("{ this is not valid json", encoding="utf-8")
    config = load_config(FIXTURES_DIR / "fixture_sites.yaml", user_sites_path=bad)
    assert [s.slug for s in config.sites] == ["example", "example-org"]


def test_load_config_skips_invalid_user_entry_keeps_valid():
    config = load_config(
        FIXTURES_DIR / "fixture_sites.yaml",
        user_sites_path=FIXTURES_DIR / "fixture_user_sites_bad_entry.json",
    )
    slugs = [s.slug for s in config.sites]
    assert "good" in slugs
    assert "bad" not in slugs


def test_load_config_user_slug_colliding_with_yaml_is_dropped(tmp_path):
    collide = tmp_path / "user-sites.json"
    collide.write_text(
        '[{"property":"sc-domain:x.example","slug":"example",'
        '"display_name":"Dup","brand_token":"dup"}]',
        encoding="utf-8",
    )
    config = load_config(FIXTURES_DIR / "fixture_sites.yaml", user_sites_path=collide)
    examples = [s for s in config.sites if s.slug == "example"]
    assert len(examples) == 1
    assert examples[0].property == "sc-domain:example.com"


def test_load_config_reads_user_sites_from_env(tmp_path, monkeypatch):
    monkeypatch.setenv(
        "SEO_USER_SITES_PATH", str(FIXTURES_DIR / "fixture_user_sites.json")
    )
    config = load_config(FIXTURES_DIR / "fixture_sites.yaml")
    assert "agency" in [s.slug for s in config.sites]


# ---------------------------------------------------------------------------
# Report language: per site, Serbian unless set to English
# ---------------------------------------------------------------------------


def test_report_language_defaults_to_serbian_and_reads_english(tmp_path):
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
  - property: "https://example-us.com/"
    slug: example-us
    display_name: Example US
    brand_token: example
    language: en
  - property: "https://shouty.com/"
    slug: shouty
    display_name: Shouty
    brand_token: shouty
    language: " EN "
""",
        encoding="utf-8",
    )
    by_slug = {s.slug: s for s in load_config(path).sites}

    assert by_slug["optika-cajs"].language == "sr"
    assert by_slug["example-us"].language == "en"
    # Hand-edited file: case and whitespace are forgiven.
    assert by_slug["shouty"].language == "en"


def test_unknown_report_language_is_logged_and_treated_as_serbian(tmp_path, caplog):
    import logging

    path = tmp_path / "sites.yaml"
    path.write_text(
        """
db_path: data/seo.db
service_account_path: secrets/sa.json
sites:
  - property: "https://example.de/"
    slug: example-de
    display_name: Example DE
    brand_token: example
    language: de
""",
        encoding="utf-8",
    )
    with caplog.at_level(logging.WARNING):
        site = load_config(path).sites[0]

    # A typo must never stop a collection run.
    assert site.language == "sr"
    assert "unknown report language" in caplog.text


def test_user_site_report_language_is_read_and_defaults_to_serbian(tmp_path):
    import json

    user_sites = tmp_path / "user-sites.json"
    user_sites.write_text(
        json.dumps(
            [
                {"property": "sc-domain:us.example", "slug": "us", "display_name": "US",
                 "brand_token": "us", "language": "en"},
                # Written before this change: no language key at all.
                {"property": "sc-domain:rs.example", "slug": "rs", "display_name": "RS",
                 "brand_token": "rs"},
                {"property": "sc-domain:junk.example", "slug": "junk", "display_name": "Junk",
                 "brand_token": "junk", "language": 42},
            ]
        ),
        encoding="utf-8",
    )
    config = load_config(FIXTURES_DIR / "fixture_sites.yaml", user_sites_path=user_sites)
    by_slug = {s.slug: s for s in config.sites}

    assert by_slug["us"].language == "en"
    assert by_slug["rs"].language == "sr"
    assert by_slug["junk"].language == "sr"
