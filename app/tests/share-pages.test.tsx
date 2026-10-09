import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The pages call connection(), which throws outside a request scope; under
// test there is no request, so only that one function is stubbed.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => {},
}));
import { renderToStaticMarkup } from "react-dom/server";
import BetterSqlite3 from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import SharedReportPage from "../app/share/[token]/page";
import SharedLivePage from "../app/share/[token]/live/page";
import ShareTabs from "../components/ShareTabs";
import { decideAccess } from "../lib/access";
import { internalShareReportUrl } from "../lib/report/pdf";
import { createShareLink, newShareToken } from "../lib/shareLinks";

const ENV_KEYS = ["SEO_DB_PATH", "SEO_SHARE_LINKS_PATH", "PORT"] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
let dir: string;
let token: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "share-pages-"));
  const dbPath = path.join(dir, "seo.db");
  const db = new BetterSqlite3(dbPath);
  db.exec(`
    CREATE TABLE totals_daily (site TEXT, date TEXT, clicks INT, impressions INT, ctr REAL, position REAL, PRIMARY KEY (site, date));
    CREATE TABLE query_daily (site TEXT, date TEXT, query TEXT, clicks INT, impressions INT, ctr REAL, position REAL, PRIMARY KEY (site, date, query));
    CREATE TABLE page_daily (site TEXT, date TEXT, page TEXT, clicks INT, impressions INT, ctr REAL, position REAL, PRIMARY KEY (site, date, page));
    CREATE TABLE cwv_snapshots (site TEXT, url TEXT, captured_at TEXT, lcp_p75 REAL, inp_p75 REAL, cls_p75 REAL, source TEXT, form_factor TEXT, lh_performance REAL, lh_accessibility REAL, lh_best_practices REAL, lh_seo REAL);
    CREATE TABLE demand_keywords (site TEXT, keyword TEXT, source TEXT, seed TEXT, suggest_rank INT, rising_pct REAL, rising_label TEXT, top_value REAL, volume INT, first_seen TEXT, last_seen TEXT, PRIMARY KEY (site, keyword, source));
    CREATE TABLE sites (property TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, brand_token TEXT NOT NULL, updated_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, language TEXT NOT NULL DEFAULT 'sr');
    INSERT INTO sites VALUES ('https://us-client.example/', 'us-client', 'US Client', 'usclient', '2026-10-09', 1, 'en');
    INSERT INTO sites VALUES ('https://other.example/', 'other', 'Other Client', 'other', '2026-10-09', 1, 'sr');
  `);
  db.close();
  process.env.SEO_DB_PATH = dbPath;
  process.env.SEO_SHARE_LINKS_PATH = path.join(dir, "share-links.json");
  token = createShareLink(process.env.SEO_SHARE_LINKS_PATH, {
    property: "https://us-client.example/",
    label: "owner",
  }).token;
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

function props(t: string, searchParams: Record<string, string> = {}) {
  return { params: Promise.resolve({ token: t }), searchParams: Promise.resolve(searchParams) };
}

/** Every href in the page, so a test can assert there is nowhere else to go. */
function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
}

describe("the client's report page", () => {
  it("renders the token's site, in the site's language", async () => {
    const html = renderToStaticMarkup(await SharedReportPage(props(token)));
    expect(html).toContain("US Client");
    expect(html).toContain('lang="en"');
    expect(html).toContain("SEO report");
    expect(html).not.toContain("Other Client");
  });

  it("switches language with ?lang=", async () => {
    const html = renderToStaticMarkup(await SharedReportPage(props(token, { lang: "sr" })));
    expect(html).toContain('lang="sr"');
  });

  it("links only to the client's own pages and the agency site", async () => {
    const html = renderToStaticMarkup(await SharedReportPage(props(token)));
    for (const href of hrefs(html)) {
      const ok = href.startsWith(`/share/${token}`) || href === "https://deimos.agency";
      expect(ok, href).toBe(true);
    }
    expect(hrefs(html)).toContain(`/share/${token}/live`);
    expect(hrefs(html)).toContain(`/share/${token}/report/pdf?lang=en`);
  });

  it("404s an unknown, malformed or revoked token", async () => {
    await expect(SharedReportPage(props(newShareToken()))).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    await expect(SharedReportPage(props("nope"))).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  });
});

describe("the client's live page", () => {
  it("404s an unknown token", async () => {
    await expect(SharedLivePage(props(newShareToken()))).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  });
});

describe("ShareTabs", () => {
  it("offers exactly the report and live data, marking the current one", () => {
    const html = renderToStaticMarkup(<ShareTabs token="tok" current="live" />);
    expect(hrefs(html)).toEqual(["/share/tok", "/share/tok/live"]);
    expect(html).toMatch(/aria-current="page"[^>]*>Live data</);
  });
});

describe("internalShareReportUrl", () => {
  it("prints the share page over loopback, which the proxy lets through on its token", () => {
    process.env.PORT = "3000";
    const url = internalShareReportUrl(token, "https://clients.deimos.agency/share/x/report/pdf", "sr");
    expect(url).toBe(`http://127.0.0.1:3000/share/${token}?lang=sr`);
    const parsed = new URL(url);
    expect(
      decideAccess(
        { method: "GET", pathname: parsed.pathname, host: parsed.host, authorization: null,
          renderToken: null, nextAction: false },
        { username: "acko", password: "pw" },
        "192.168.1.156:8091",
      ),
    ).toBe("share");
  });
});
