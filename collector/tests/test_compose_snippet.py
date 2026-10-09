"""Guards on the client share links' deployment config in compose.snippet.yml.

The tunnel is the only path from the internet to the Pi, so its service must
never publish a port, must be pinned, and must refuse to start without its
token; the dashboard must know which hosts are internal.
"""

import re
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parent.parent.parent
SNIPPET = REPO / "deploy" / "compose.snippet.yml"


def _services() -> dict:
    return yaml.safe_load(SNIPPET.read_text())["services"]


def test_tunnel_service_is_pinned_publishes_nothing_and_needs_its_token():
    tunnel = _services()["seo-cockpit-tunnel"]
    assert re.fullmatch(r"cloudflare/cloudflared:\d{4}\.\d+\.\d+", tunnel["image"])
    assert "ports" not in tunnel
    assert tunnel["command"] == "tunnel --no-autoupdate run"
    assert tunnel["environment"]["TUNNEL_TOKEN"].startswith("${SEO_TUNNEL_TOKEN:?")


def test_dashboard_knows_its_internal_hosts_public_url_and_links_file():
    env = _services()["seo-cockpit-dashboard"]["environment"]
    assert "192.168.1.156:8091" in env["SEO_INTERNAL_HOSTS"]
    assert "https://clients.deimos.agency" in env["SEO_PUBLIC_BASE_URL"]
    assert "/config/share-links.json" in env["SEO_SHARE_LINKS_PATH"]
