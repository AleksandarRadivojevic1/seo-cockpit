#!/usr/bin/env python3
"""Print one page's on-page SEO facts as compact JSON, for an LLM agent.

Why: a raw HTML page is often 30-150k tokens of markup, scripts and inline
CSS, and an agent asked to read it pays for all of it on every call. The
facts that matter for a title/meta/content recommendation fit in ~1-3k
tokens. Extracting them is deterministic work, so it happens here, for
free, and the model only reads the result.

Standard library only, so it runs anywhere the agent's shell does:

    python3 agents/tools/page_facts.py https://optikacajs.rs/
    python3 agents/tools/page_facts.py --file saved.html --url https://optikacajs.rs/

Same honesty rule as the rest of seo-cockpit: a fact the page does not
state is null, never an empty string dressed up as a value.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.parse
import urllib.request
from html.parser import HTMLParser

USER_AGENT = "seo-cockpit-page-facts/1 (+https://deimos.agency)"
TEXT_LIMIT = 6000  # characters of visible body text: enough to judge a page, not to reprint it
LINK_LIMIT = 60
SKIP_TEXT_IN = {"script", "style", "noscript", "template", "svg", "head"}


class _Facts(HTMLParser):
    def __init__(self, base_url: str) -> None:
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.host = urllib.parse.urlsplit(base_url).netloc.lower()
        self.title: str | None = None
        self.meta: dict[str, str] = {}
        self.canonical: str | None = None
        self.hreflang: list[dict[str, str]] = []
        self.lang: str | None = None
        self.headings: list[dict[str, str]] = []
        self.links_internal: list[dict[str, str]] = []
        self.links_external = 0
        self.images = 0
        self.images_missing_alt = 0
        self.jsonld_types: list[str] = []
        self._text: list[str] = []
        self._stack: list[str] = []
        self._capture: str | None = None  # "title" | "h1".."h3" | "a" | "jsonld"
        self._buf: list[str] = []
        self._href: str | None = None

    # -- structure --------------------------------------------------------
    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        a = {k.lower(): (v or "") for k, v in attrs}
        self._stack.append(tag)
        if tag == "html" and a.get("lang"):
            self.lang = a["lang"]
        elif tag == "title" and self.title is None:
            self._start("title")
        elif tag == "meta":
            key = (a.get("name") or a.get("property") or "").lower()
            if key in {"description", "robots", "og:title", "og:description"} and "content" in a:
                self.meta[key] = a["content"].strip()
        elif tag == "link":
            rel = a.get("rel", "").lower().split()
            if "canonical" in rel and a.get("href"):
                self.canonical = self._abs(a["href"])
            if "alternate" in rel and a.get("hreflang") and a.get("href"):
                self.hreflang.append({"lang": a["hreflang"], "href": self._abs(a["href"])})
        elif tag in {"h1", "h2", "h3"}:
            self._start(tag)
        elif tag == "a" and a.get("href") and self._capture is None:
            href = self._abs(a["href"])
            parts = urllib.parse.urlsplit(href)
            if parts.scheme in {"http", "https"}:
                if parts.netloc.lower() == self.host:
                    self._href = href
                    self._start("a")
                else:
                    self.links_external += 1
        elif tag == "img":
            self.images += 1
            if not a.get("alt", "").strip():
                self.images_missing_alt += 1
        elif tag == "script" and a.get("type", "").lower() == "application/ld+json":
            self._start("jsonld")

    def handle_endtag(self, tag: str) -> None:
        if self._capture and (tag == self._capture or (self._capture == "jsonld" and tag == "script")):
            self._finish()
        if self._stack and self._stack[-1] == tag:
            self._stack.pop()
        elif tag in self._stack:  # tolerate unclosed children
            while self._stack and self._stack.pop() != tag:
                pass

    def handle_data(self, data: str) -> None:
        if self._capture:
            self._buf.append(data)
        if not any(t in SKIP_TEXT_IN for t in self._stack):
            self._text.append(data)

    # -- helpers ----------------------------------------------------------
    def _abs(self, href: str) -> str:
        return urllib.parse.urljoin(self.base_url, href.strip())

    def _start(self, what: str) -> None:
        self._capture, self._buf = what, []

    def _finish(self) -> None:
        what, text = self._capture, " ".join("".join(self._buf).split())
        self._capture, self._buf = None, []
        if what == "title":
            self.title = text or None
        elif what in {"h1", "h2", "h3"} and text:
            self.headings.append({"level": what, "text": text})
        elif what == "a":
            if len(self.links_internal) < LINK_LIMIT:
                self.links_internal.append({"href": self._href or "", "anchor": text or None})
            self._href = None
        elif what == "jsonld":
            self.jsonld_types.extend(_jsonld_types(text))

    def visible_text(self) -> str:
        return " ".join(" ".join(self._text).split())


def _jsonld_types(raw: str) -> list[str]:
    try:
        data = json.loads(raw)
    except ValueError:
        return []
    found: list[str] = []

    def walk(node: object) -> None:
        if isinstance(node, dict):
            t = node.get("@type")
            if isinstance(t, str):
                found.append(t)
            elif isinstance(t, list):
                found.extend(x for x in t if isinstance(x, str))
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(data)
    return found


def facts_from_html(html: str, url: str, status: int | None = None) -> dict:
    p = _Facts(url)
    p.feed(html)
    p.close()
    text = p.visible_text()
    words = len(re.findall(r"\w+", text))
    title = p.title
    desc = p.meta.get("description")
    return {
        "url": url,
        "status": status,
        "lang": p.lang,
        "title": title,
        "titleLength": len(title) if title is not None else None,
        "metaDescription": desc,
        "metaDescriptionLength": len(desc) if desc is not None else None,
        "robots": p.meta.get("robots"),
        "canonical": p.canonical,
        "hreflang": p.hreflang,
        "headings": p.headings,
        "h1Count": sum(1 for h in p.headings if h["level"] == "h1"),
        "wordCount": words,
        "textExcerpt": text[:TEXT_LIMIT],
        "textTruncated": len(text) > TEXT_LIMIT,
        "internalLinks": p.links_internal,
        "internalLinksTruncated": len(p.links_internal) >= LINK_LIMIT,
        "externalLinkCount": p.links_external,
        "images": p.images,
        "imagesMissingAlt": p.images_missing_alt,
        "schemaTypes": sorted(set(p.jsonld_types)),
    }


def fetch(url: str, timeout: int = 20) -> tuple[str, int, str]:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 - agent tool, URL from a ticket
        charset = resp.headers.get_content_charset() or "utf-8"
        return resp.read().decode(charset, errors="replace"), resp.status, resp.geturl()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("url", nargs="?", help="Page to fetch.")
    ap.add_argument("--file", help="Read HTML from this file instead of fetching.")
    ap.add_argument("--url", dest="base", help="Base URL when using --file.")
    args = ap.parse_args(argv)

    if args.file:
        if not (args.base or args.url):
            ap.error("--file needs --url (or a positional URL) to resolve links")
        with open(args.file, encoding="utf-8", errors="replace") as fh:
            out = facts_from_html(fh.read(), args.base or args.url)
    elif args.url:
        try:
            html, status, final = fetch(args.url)
        except Exception as e:  # surfaced as data: the agent must report it, not guess the page
            print(json.dumps({"url": args.url, "error": str(e)}, ensure_ascii=False))
            return 1
        out = facts_from_html(html, final, status)
    else:
        ap.error("give a URL or --file")
    print(json.dumps(out, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
