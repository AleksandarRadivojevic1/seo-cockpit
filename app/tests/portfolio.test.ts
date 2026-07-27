import { afterAll, beforeAll, describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { getDb, siteConfigBySlug } from "../lib/db";
import type { CwvRow, SiteConfig } from "../lib/db";
import { buildSiteSummary, cwvVerdict, freshness, pctDelta } from "../lib/portfolio";
import type { SiteSummary } from "../lib/portfolio";
import SiteCard from "../components/SiteCard";

describe("pctDelta", () => {
  it("returns a positive percentage for an increase", () => {
    expect(pctDelta(150, 100)).toBeCloseTo(50, 10);
  });

  it("returns a negative percentage for a decrease", () => {
    expect(pctDelta(50, 100)).toBeCloseTo(-50, 10);
  });

  it("returns null when prior is 0 (no baseline to compare against)", () => {
    expect(pctDelta(10, 0)).toBeNull();
    expect(pctDelta(0, 0)).toBeNull();
  });

  it("is unrounded", () => {
    // (110 - 100) / 100 * 100 = 10, but pick a case with a repeating decimal
    expect(pctDelta(100, 3)).toBeCloseTo(((100 - 3) / 3) * 100, 10);
  });
});

function cwvRow(overrides: Partial<CwvRow>): CwvRow {
  return {
    site: "site-a",
    url: "https://example.com/",
    captured_at: "2026-01-01T00:00:00Z",
    lcp_p75: null,
    inp_p75: null,
    cls_p75: null,
    source: "crux",
    form_factor: "PHONE",
    lh_performance: null,
    lh_accessibility: null,
    lh_best_practices: null,
    lh_seo: null,
    ...overrides,
  };
}

describe("cwvVerdict", () => {
  it("returns null-row as 'none'", () => {
    expect(cwvVerdict(null)).toBe("none");
  });

  it("returns 'none' when all three metrics are null", () => {
    expect(cwvVerdict(cwvRow({}))).toBe("none");
  });

  it("classifies a good row", () => {
    expect(cwvVerdict(cwvRow({ lcp_p75: 2000, inp_p75: 150, cls_p75: 0.05 }))).toBe("good");
  });

  it("classifies a needs-work row", () => {
    expect(cwvVerdict(cwvRow({ lcp_p75: 3000, inp_p75: 150, cls_p75: 0.05 }))).toBe("needs-work");
  });

  it("classifies a poor row", () => {
    expect(cwvVerdict(cwvRow({ lcp_p75: 5000, inp_p75: 150, cls_p75: 0.05 }))).toBe("poor");
  });

  it("worst metric wins across mixed values", () => {
    // LCP good, INP needs-work, CLS poor -> overall poor
    expect(cwvVerdict(cwvRow({ lcp_p75: 2000, inp_p75: 300, cls_p75: 0.3 }))).toBe("poor");
  });

  it("produces a verdict from a single present metric (LCP only)", () => {
    expect(cwvVerdict(cwvRow({ lcp_p75: 5000, inp_p75: null, cls_p75: null }))).toBe("poor");
    expect(cwvVerdict(cwvRow({ lcp_p75: 2000, inp_p75: null, cls_p75: null }))).toBe("good");
  });

  it("boundary values are inclusive on the good/needs-work/poor cutoffs", () => {
    expect(cwvVerdict(cwvRow({ lcp_p75: 2500, inp_p75: null, cls_p75: null }))).toBe("good");
    expect(cwvVerdict(cwvRow({ lcp_p75: 2501, inp_p75: null, cls_p75: null }))).toBe("needs-work");
    expect(cwvVerdict(cwvRow({ lcp_p75: 4000, inp_p75: null, cls_p75: null }))).toBe("needs-work");
    expect(cwvVerdict(cwvRow({ lcp_p75: 4001, inp_p75: null, cls_p75: null }))).toBe("poor");
  });
});

describe("freshness", () => {
  const today = "2026-02-15";

  it("is 'fresh' at 4 days behind (boundary)", () => {
    expect(freshness("2026-02-11", today)).toEqual({
      latestDate: "2026-02-11",
      daysBehind: 4,
      level: "fresh",
    });
  });

  it("is 'stale' at 5 days behind (boundary)", () => {
    expect(freshness("2026-02-10", today)).toEqual({
      latestDate: "2026-02-10",
      daysBehind: 5,
      level: "stale",
    });
  });

  it("is 'stale' at 9 days behind (boundary)", () => {
    expect(freshness("2026-02-06", today)).toEqual({
      latestDate: "2026-02-06",
      daysBehind: 9,
      level: "stale",
    });
  });

  it("is 'broken' at 10 days behind (boundary)", () => {
    expect(freshness("2026-02-05", today)).toEqual({
      latestDate: "2026-02-05",
      daysBehind: 10,
      level: "broken",
    });
  });

  it("is 'none' when latestDate is null", () => {
    expect(freshness(null, today)).toEqual({ latestDate: null, daysBehind: null, level: "none" });
  });
});

describe("buildSiteSummary", () => {
  const SITE_OK = "sc-domain:ok-site.test";
  const SITE_COLLECTING = "sc-domain:collecting-site.test";
  // Never collected: zero totals_daily rows at all in the recent window.
  const SITE_NOT_COLLECTED = "sc-domain:not-collected-site.test";
  // Collected, but every collected row is a measured zero -- this is the
  // "zero" state, distinct from SITE_NOT_COLLECTED's "not-collected". GSC
  // genuinely returns explicit zero-impression rows (the audit found 4 such
  // rows for alexrad), so this is the realistic shape, not an edge case.
  const SITE_ZERO = "sc-domain:zero-site.test";

  // asOf = 2026-02-15 -> recentEnd = 2026-02-12, recentStart = 2026-01-16
  //                      priorEnd  = 2026-01-15, priorStart  = 2025-12-19
  const AS_OF = "2026-02-15";

  let fixturePath: string;

  beforeAll(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seo-cockpit-portfolio-test-"));
    fixturePath = path.join(dir, "fixture.db");

    const writeDb = new BetterSqlite3(fixturePath);
    writeDb.exec(`
      CREATE TABLE totals_daily (
        site TEXT, date TEXT, clicks INT, impressions INT, ctr REAL, position REAL,
        PRIMARY KEY (site, date)
      );
      CREATE TABLE query_daily (
        site TEXT, date TEXT, query TEXT, clicks INT, impressions INT, ctr REAL, position REAL,
        PRIMARY KEY (site, date, query)
      );
      CREATE TABLE page_daily (
        site TEXT, date TEXT, page TEXT, clicks INT, impressions INT, ctr REAL, position REAL,
        PRIMARY KEY (site, date, page)
      );
      CREATE TABLE cwv_snapshots (
        site TEXT, url TEXT, captured_at TEXT, lcp_p75 REAL, inp_p75 REAL, cls_p75 REAL,
        source TEXT, form_factor TEXT,
        lh_performance REAL, lh_accessibility REAL, lh_best_practices REAL, lh_seo REAL
      );
      CREATE TABLE country_daily (
        site TEXT, date TEXT, country TEXT, clicks INT, impressions INT, ctr REAL, position REAL,
        PRIMARY KEY (site, date, country)
      );
      CREATE TABLE collection_runs (
        id INTEGER PRIMARY KEY, site TEXT, started_at TEXT, finished_at TEXT,
        rows_written INT, status TEXT, error TEXT
      );
      CREATE TABLE sites (
        property TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        brand_token TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    const insertTotals = writeDb.prepare(
      "INSERT INTO totals_daily (site, date, clicks, impressions, ctr, position) VALUES (?, ?, ?, ?, ?, ?)"
    );
    const insertQuery = writeDb.prepare(
      "INSERT INTO query_daily (site, date, query, clicks, impressions, ctr, position) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    const insertCwv = writeDb.prepare(
      "INSERT INTO cwv_snapshots (site, url, captured_at, lcp_p75, inp_p75, cls_p75, source, form_factor) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    const insertSite = writeDb.prepare(
      "INSERT INTO sites (property, slug, display_name, brand_token, updated_at) VALUES (?, ?, ?, ?, ?)"
    );

    insertSite.run(SITE_OK, "ok-site", "Ok Site", "oksite", "2026-02-15T00:00:00Z");
    insertSite.run(SITE_COLLECTING, "collecting-site", "Collecting Site", "collecting", "2026-02-15T00:00:00Z");
    insertSite.run(
      SITE_NOT_COLLECTED,
      "not-collected-site",
      "Not Collected Site",
      "notcollected",
      "2026-02-15T00:00:00Z"
    );
    insertSite.run(SITE_ZERO, "zero-site", "Zero Site", "zero", "2026-02-15T00:00:00Z");

    // SITE_OK: three rows in the recent window (2026-01-16..2026-02-12),
    // deliberately weighted so the impression-weighted average position
    // differs sharply from the plain mean of the position column
    // ((2+30+20)/3 ~= 17.3 plain vs ~19.9 weighted). The middle row has
    // clicks=0 but impressions=5 -- a genuine measured zero-click day, which
    // must appear in the sparkline as 0, never as null. Every other date in
    // the window (including the 23 trailing days after 2026-01-20, all the
    // way to recentEnd) has no row at all -> sparkline null, not 0 -- this is
    // the "stale site's uncollected tail" case from the amended brief.
    insertTotals.run(SITE_OK, "2026-01-16", 3, 10, 0.3, 2);
    insertTotals.run(SITE_OK, "2026-01-18", 0, 5, 0, 30);
    insertTotals.run(SITE_OK, "2026-01-20", 50, 1000, 0.05, 20);
    // One prior-window row so dataState is 'ok' and deltaPct is computable.
    insertTotals.run(SITE_OK, "2025-12-19", 20, 100, 0.2, 5);
    // One non-brand query (brand_token for this site is "oksite") and one
    // brand query, so the count proves the brand filter actually runs.
    insertQuery.run(SITE_OK, "2026-01-16", "non-brand query", 1, 20, 0.05, 15);
    insertQuery.run(SITE_OK, "2026-01-16", "oksite reviews", 2, 30, 0.066, 4);
    insertCwv.run(SITE_OK, "https://ok-site.test/", "2026-02-01T00:00:00Z", 5000, 150, 0.05, "crux", "PHONE");

    // SITE_COLLECTING: impressions in the recent window, but nothing at all
    // in the prior window -> dataState 'collecting', deltaPct must be null.
    insertTotals.run(SITE_COLLECTING, "2026-01-16", 5, 40, 0.125, 15);

    // SITE_NOT_COLLECTED: no totals_daily rows in the recent window at all ->
    // 'not-collected'. (No inserts for SITE_NOT_COLLECTED.)

    // SITE_ZERO: rows *do* exist for every date in the recent window, but
    // every one measured 0 clicks and 0 impressions -> 'zero', which must
    // resolve and render differently from SITE_NOT_COLLECTED's 'not-collected'
    // even though both look "empty" if you only sum impressions.
    insertTotals.run(SITE_ZERO, "2026-01-16", 0, 0, 0, 0);
    insertTotals.run(SITE_ZERO, "2026-01-17", 0, 0, 0, 0);
    insertTotals.run(SITE_ZERO, "2026-01-18", 0, 0, 0, 0);
    insertTotals.run(SITE_ZERO, "2026-01-19", 0, 0, 0, 0);

    writeDb.close();
  });

  afterAll(() => {
    if (fixturePath) {
      fs.rmSync(path.dirname(fixturePath), { recursive: true, force: true });
    }
  });

  function configFor(slug: string): SiteConfig {
    const db = getDb(fixturePath);
    const config = siteConfigBySlug(slug, db);
    if (!config) throw new Error(`no fixture site config for slug ${slug}`);
    return config;
  }

  it("resolves dataState 'ok' when both windows have impressions", () => {
    const summary = buildSiteSummary(configFor("ok-site"), AS_OF, getDb(fixturePath));
    expect(summary.dataState).toBe("ok");
  });

  it("resolves dataState 'collecting' when the prior window has 0 impressions", () => {
    const summary = buildSiteSummary(configFor("collecting-site"), AS_OF, getDb(fixturePath));
    expect(summary.dataState).toBe("collecting");
  });

  it("resolves dataState 'not-collected' when the recent window has no rows at all", () => {
    const summary = buildSiteSummary(configFor("not-collected-site"), AS_OF, getDb(fixturePath));
    expect(summary.dataState).toBe("not-collected");
  });

  it("resolves dataState 'zero' when the recent window has rows but every one measured 0 impressions", () => {
    const summary = buildSiteSummary(configFor("zero-site"), AS_OF, getDb(fixturePath));
    expect(summary.dataState).toBe("zero");
  });

  it("distinguishes 'zero' from 'not-collected' -- both sum to 0 impressions but must not collapse", () => {
    const zero = buildSiteSummary(configFor("zero-site"), AS_OF, getDb(fixturePath));
    const notCollected = buildSiteSummary(configFor("not-collected-site"), AS_OF, getDb(fixturePath));
    expect(zero.dataState).toBe("zero");
    expect(notCollected.dataState).toBe("not-collected");
    expect(zero.dataState).not.toBe(notCollected.dataState);
  });

  it("produces a sparkline of exactly 28 entries, oldest to newest, distinguishing a real 0 from a gap's null", () => {
    const summary = buildSiteSummary(configFor("ok-site"), AS_OF, getDb(fixturePath));
    expect(summary.sparkline).toHaveLength(28);
    // 2026-01-16 is index 0: clicks=3.
    expect(summary.sparkline[0]).toBe(3);
    // 2026-01-18 is index 2: clicks=0, but the row exists (impressions=5) --
    // this must be the number 0, not null.
    expect(summary.sparkline[2]).toBe(0);
    // 2026-01-20 is index 4: clicks=50.
    expect(summary.sparkline[4]).toBe(50);
    // Every other index (including indexes 1 and 3, the gaps between the
    // three real rows, and 5..27, the uncollected tail after the site's
    // last row through recentEnd) has no totals_daily row at all and must
    // be null -- never a false 0.
    const realDataIndexes = new Set([0, 2, 4]);
    summary.sparkline.forEach((value, i) => {
      if (!realDataIndexes.has(i)) expect(value).toBeNull();
    });
    // The trailing uncollected days specifically (a stale site's tail).
    for (let i = 5; i < 28; i++) {
      expect(summary.sparkline[i]).toBeNull();
    }
  });

  it("computes avgPosition as impression-weighted, not a plain mean", () => {
    const summary = buildSiteSummary(configFor("ok-site"), AS_OF, getDb(fixturePath));
    // (2*10 + 30*5 + 20*1000) / (10 + 5 + 1000) = 20170 / 1015
    const expectedWeighted = (2 * 10 + 30 * 5 + 20 * 1000) / (10 + 5 + 1000);
    const plainMean = (2 + 30 + 20) / 3; // what a buggy simple-average implementation would give
    expect(summary.avgPosition).toBeCloseTo(expectedWeighted, 10);
    expect(summary.avgPosition).not.toBeCloseTo(plainMean, 1);
  });

  it("sets deltaPct to null for a 'collecting' site even though clicks are non-zero", () => {
    const summary = buildSiteSummary(configFor("collecting-site"), AS_OF, getDb(fixturePath));
    expect(summary.clicks.recent).toBe(5);
    expect(summary.clicks.prior).toBe(0);
    expect(summary.clicks.deltaPct).toBeNull();
  });

  it("computes deltaPct for an 'ok' site", () => {
    const summary = buildSiteSummary(configFor("ok-site"), AS_OF, getDb(fixturePath));
    expect(summary.clicks.recent).toBe(53);
    expect(summary.clicks.prior).toBe(20);
    expect(summary.clicks.deltaPct).toBeCloseTo(((53 - 20) / 20) * 100, 10);
  });

  it("renders an all-null sparkline (never a false 0) and null avgPosition for a 'not-collected' site", () => {
    const summary = buildSiteSummary(configFor("not-collected-site"), AS_OF, getDb(fixturePath));
    expect(summary.avgPosition).toBeNull();
    expect(summary.sparkline).toHaveLength(28);
    expect(summary.sparkline.every((v) => v === null)).toBe(true);
  });

  it("renders a sparkline of real (measured) zeroes, not nulls, and null avgPosition for a 'zero' site", () => {
    const summary = buildSiteSummary(configFor("zero-site"), AS_OF, getDb(fixturePath));
    expect(summary.avgPosition).toBeNull();
    expect(summary.sparkline).toHaveLength(28);
    // Indexes 0-3 (2026-01-16..19) have real totals_daily rows with 0 clicks
    // -- these must be the number 0, distinguishing "measured, and it was
    // zero" from "not measured" (null) for the trailing uncollected days.
    for (let i = 0; i < 4; i++) {
      expect(summary.sparkline[i]).toBe(0);
    }
    for (let i = 4; i < 28; i++) {
      expect(summary.sparkline[i]).toBeNull();
    }
  });

  it("wires nonBrandCount from deriveSignals, excluding brand queries", () => {
    const summary = buildSiteSummary(configFor("ok-site"), AS_OF, getDb(fixturePath));
    expect(summary.nonBrandCount).toBe(1);
  });

  it("treats a nonBrandCount of 0 as a valid measurement, not an error", () => {
    const summary = buildSiteSummary(configFor("collecting-site"), AS_OF, getDb(fixturePath));
    expect(summary.nonBrandCount).toBe(0);
  });

  it("wires cwv from the latest cwv_snapshots row", () => {
    const summary = buildSiteSummary(configFor("ok-site"), AS_OF, getDb(fixturePath));
    expect(summary.cwv).toEqual({ verdict: "poor", lcp: 5000, inp: 150, cls: 0.05 });
  });

  it("reports cwv verdict 'none' when there is no cwv_snapshots row", () => {
    const summary = buildSiteSummary(configFor("collecting-site"), AS_OF, getDb(fixturePath));
    expect(summary.cwv).toEqual({ verdict: "none", lcp: null, inp: null, cls: null });
  });

  it("derives freshness from latestTotalsDate", () => {
    const summary = buildSiteSummary(configFor("ok-site"), AS_OF, getDb(fixturePath));
    // Latest totals_daily row for SITE_OK is 2026-01-20; asOf is 2026-02-15 -> 26 days behind.
    expect(summary.freshness.latestDate).toBe("2026-01-20");
    expect(summary.freshness.level).toBe("broken");
  });

  it("reports freshness 'none' for a site with no totals_daily rows at all", () => {
    const summary = buildSiteSummary(configFor("not-collected-site"), AS_OF, getDb(fixturePath));
    expect(summary.freshness).toEqual({ latestDate: null, daysBehind: null, level: "none" });
  });

  it("reports a real freshness level (not 'none') for a 'zero' site -- rows exist even though they're all 0", () => {
    const summary = buildSiteSummary(configFor("zero-site"), AS_OF, getDb(fixturePath));
    // Latest totals_daily row for SITE_ZERO is 2026-01-19; asOf is 2026-02-15 -> 27 days behind.
    expect(summary.freshness.latestDate).toBe("2026-01-19");
    expect(summary.freshness.level).toBe("broken");
  });
});

describe("SiteCard", () => {
  const CARD_CONFIG: SiteConfig = {
    property: "https://example.com/",
    slug: "example",
    displayName: "Example",
    brandToken: "example",
  };

  function baseSummary(overrides: Partial<SiteSummary> = {}): SiteSummary {
    return {
      config: CARD_CONFIG,
      dataState: "ok",
      clicks: { recent: 100, prior: 80, deltaPct: 25 },
      avgPosition: 12.3,
      sparkline: Array.from({ length: 28 }, (_, i) => i),
      nonBrandCount: 3,
      cwv: { verdict: "good", lcp: 2000, inp: 150, cls: 0.05 },
      freshness: { latestDate: "2026-02-14", daysBehind: 1, level: "fresh" },
      ...overrides,
    };
  }

  function renderCard(summary: SiteSummary): string {
    return renderToStaticMarkup(createElement(SiteCard, { summary }));
  }

  it("shows the delta for an 'ok' site", () => {
    const html = renderCard(baseSummary());
    expect(html).toContain("25.0%");
    expect(html).not.toContain("no comparison yet");
  });

  it("shows no delta and shows 'no comparison yet' for a 'collecting' site", () => {
    const html = renderCard(
      baseSummary({
        dataState: "collecting",
        clicks: { recent: 40, prior: 0, deltaPct: null },
      })
    );
    expect(html).toContain("no comparison yet");
    expect(html).not.toContain("▲");
    expect(html).not.toContain("▼");
  });

  it("shows 'No impressions in the last 28 days' and renders no <polyline for a 'zero' site", () => {
    const html = renderCard(
      baseSummary({
        dataState: "zero",
        clicks: { recent: 0, prior: 0, deltaPct: null },
        avgPosition: null,
        // Rows exist (measured zeroes), unlike the 'not-collected' case below.
        sparkline: Array(28).fill(0),
        nonBrandCount: 0,
        cwv: { verdict: "none", lcp: null, inp: null, cls: null },
      })
    );
    expect(html).toContain("No impressions in the last 28 days");
    expect(html).not.toContain("Not collected yet");
    expect(html).not.toContain("<polyline");
  });

  it("shows 'Not collected yet' and renders no <polyline for a 'not-collected' site", () => {
    const html = renderCard(
      baseSummary({
        dataState: "not-collected",
        clicks: { recent: 0, prior: 0, deltaPct: null },
        avgPosition: null,
        sparkline: Array(28).fill(null),
        nonBrandCount: 0,
        cwv: { verdict: "none", lcp: null, inp: null, cls: null },
      })
    );
    expect(html).toContain("Not collected yet");
    expect(html).not.toContain("No impressions in the last 28 days");
    expect(html).not.toContain("<polyline");
  });

  it("renders different copy for 'zero' vs 'not-collected' -- they must never look the same", () => {
    const zeroHtml = renderCard(
      baseSummary({
        dataState: "zero",
        clicks: { recent: 0, prior: 0, deltaPct: null },
        avgPosition: null,
        sparkline: Array(28).fill(0),
        nonBrandCount: 0,
        cwv: { verdict: "none", lcp: null, inp: null, cls: null },
      })
    );
    const notCollectedHtml = renderCard(
      baseSummary({
        dataState: "not-collected",
        clicks: { recent: 0, prior: 0, deltaPct: null },
        avgPosition: null,
        sparkline: Array(28).fill(null),
        nonBrandCount: 0,
        cwv: { verdict: "none", lcp: null, inp: null, cls: null },
      })
    );
    expect(zeroHtml).not.toEqual(notCollectedHtml);
  });

  function countOccurrences(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
  }

  it("breaks the sparkline into more than one <polyline> around an interior null (a gap, not a bridge)", () => {
    // Index 14 is a gap between two runs of 14 and 13 real values.
    const sparkline = Array.from({ length: 28 }, (_, i) => (i === 14 ? null : i + 1));
    const html = renderCard(baseSummary({ sparkline }));
    expect(countOccurrences(html, "<polyline")).toBe(2);
  });

  it("uses the positive/green stroke colour for a rising site's sparkline", () => {
    const html = renderCard(baseSummary({ clicks: { recent: 120, prior: 80, deltaPct: 50 } }));
    expect(html).toContain("text-emerald-600");
    expect(html).not.toContain("text-red-600");
  });

  it("uses the negative/red stroke colour for a falling site's sparkline", () => {
    const html = renderCard(baseSummary({ clicks: { recent: 40, prior: 80, deltaPct: -50 } }));
    expect(html).toContain("text-red-600");
    expect(html).not.toContain("text-emerald-600");
  });

  it("renders the 'broken' freshness state for a site 12 days behind", () => {
    const html = renderCard(
      baseSummary({
        freshness: { latestDate: "2026-02-02", daysBehind: 12, level: "broken" },
      })
    );
    expect(html).toContain("Broken");
  });

  it("renders 'No data' (never a poor/red colour) for a 'none' cwv verdict", () => {
    const html = renderCard(
      baseSummary({
        cwv: { verdict: "none", lcp: null, inp: null, cls: null },
      })
    );
    expect(html).toContain("No data");
    expect(html).not.toContain("text-red-700");
  });
});
