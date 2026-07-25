import { afterAll, beforeAll, describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  getDb,
  latestCwv,
  latestTotalsDate,
  listSiteConfigs,
  listSites,
  pageRowsInRange,
  queryRowsInRange,
  siteConfigBySlug,
  totalsInRange,
} from "../lib/db";

const SITE_A = "sc-domain:alexrad.dev";
const SITE_B = "https://skedio.rs/";
const SITE_C = "https://optikacajs.rs/";

let fixturePath: string;

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seo-cockpit-db-test-"));
  fixturePath = path.join(dir, "fixture.db");

  // Separate write connection used only to seed the fixture DB.
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
      source TEXT, form_factor TEXT
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
  const insertPage = writeDb.prepare(
    "INSERT INTO page_daily (site, date, page, clicks, impressions, ctr, position) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  const insertCwv = writeDb.prepare(
    "INSERT INTO cwv_snapshots (site, url, captured_at, lcp_p75, inp_p75, cls_p75, source, form_factor) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const insertSite = writeDb.prepare(
    "INSERT INTO sites (property, slug, display_name, brand_token, updated_at) VALUES (?, ?, ?, ?, ?)"
  );

  // Chosen test range: 2026-01-05 .. 2026-01-10 (inclusive)
  // In-range dates for SITE_A
  const inRangeDates = ["2026-01-05", "2026-01-07", "2026-01-10"];
  // Out-of-range dates (just outside the range on both sides)
  const outOfRangeDates = ["2026-01-04", "2026-01-11"];

  for (const date of inRangeDates) {
    insertTotals.run(SITE_A, date, 10, 100, 0.1, 5.5);
    insertQuery.run(SITE_A, date, "keyword one", 3, 30, 0.1, 4.2);
    insertPage.run(SITE_A, date, "/page-one", 2, 20, 0.1, 3.5);
  }
  for (const date of outOfRangeDates) {
    insertTotals.run(SITE_A, date, 999, 9999, 0.9, 1.1);
    insertQuery.run(SITE_A, date, "keyword one", 999, 9999, 0.9, 1.1);
    insertPage.run(SITE_A, date, "/page-one", 999, 9999, 0.9, 1.1);
  }

  // SITE_B rows on the same in-range dates, to prove site filtering works.
  // SITE_B deliberately has no page_daily rows at all, to prove
  // pageRowsInRange returns [] for a site with no page rows.
  for (const date of inRangeDates) {
    insertTotals.run(SITE_B, date, 20, 200, 0.2, 6.5);
    insertQuery.run(SITE_B, date, "another keyword", 5, 50, 0.2, 3.3);
  }

  // CWV snapshots for SITE_A at two different captured_at values.
  insertCwv.run(SITE_A, "https://alexrad.dev/", "2026-01-05T00:00:00Z", 2.5, 200, 0.1, "crux", "PHONE");
  insertCwv.run(SITE_A, "https://alexrad.dev/", "2026-01-09T00:00:00Z", 2.1, 180, 0.05, "crux", "PHONE");
  // SITE_B has no cwv snapshots at all.

  // Site config rows. SITE_C is configured but has no totals_daily rows at
  // all, to prove latestTotalsDate distinguishes "no data" from "has data".
  insertSite.run(SITE_A, "alexrad", "Alexrad", "alexrad", "2026-01-10T00:00:00Z");
  insertSite.run(SITE_B, "skedio", "Skedio", "skedio", "2026-01-10T00:00:00Z");
  insertSite.run(SITE_C, "optika-cajs", "Optika Čajš", "optika", "2026-01-10T00:00:00Z");

  writeDb.close();
});

afterAll(() => {
  if (fixturePath) {
    fs.rmSync(path.dirname(fixturePath), { recursive: true, force: true });
  }
});

describe("listSites", () => {
  it("returns the distinct sites, sorted", () => {
    const db = getDb(fixturePath);
    expect(listSites(db)).toEqual([SITE_A, SITE_B].sort());
  });
});

describe("queryRowsInRange", () => {
  it("returns only in-range query rows for the given site, ordered by date", () => {
    const db = getDb(fixturePath);
    const rows = queryRowsInRange(SITE_A, "2026-01-05", "2026-01-10", db);

    expect(rows.map((r) => r.date)).toEqual(["2026-01-05", "2026-01-07", "2026-01-10"]);
    expect(rows.every((r) => r.site === SITE_A)).toBe(true);
    // Out-of-range dates and the out-of-range sentinel values must not appear.
    expect(rows.some((r) => r.clicks === 999)).toBe(false);
  });

  it("excludes rows from other sites", () => {
    const db = getDb(fixturePath);
    const rows = queryRowsInRange(SITE_A, "2026-01-05", "2026-01-10", db);
    expect(rows.some((r) => r.site === SITE_B)).toBe(false);
  });
});

describe("pageRowsInRange", () => {
  it("returns only in-range page rows for the given site, ordered by date", () => {
    const db = getDb(fixturePath);
    const rows = pageRowsInRange(SITE_A, "2026-01-05", "2026-01-10", db);

    expect(rows.map((r) => r.date)).toEqual(["2026-01-05", "2026-01-07", "2026-01-10"]);
    expect(rows.every((r) => r.site === SITE_A)).toBe(true);
    // Out-of-range dates and the out-of-range sentinel values must not appear.
    expect(rows.some((r) => r.clicks === 999)).toBe(false);
  });

  it("excludes rows from other sites", () => {
    const db = getDb(fixturePath);
    const rows = pageRowsInRange(SITE_A, "2026-01-05", "2026-01-10", db);
    expect(rows.some((r) => r.site === SITE_B)).toBe(false);
  });

  it("returns [] for a site with no page rows at all", () => {
    const db = getDb(fixturePath);
    const rows = pageRowsInRange(SITE_B, "2026-01-05", "2026-01-10", db);
    expect(rows).toEqual([]);
  });
});

describe("totalsInRange", () => {
  it("returns only in-range totals rows for the given site, ordered by date", () => {
    const db = getDb(fixturePath);
    const rows = totalsInRange(SITE_A, "2026-01-05", "2026-01-10", db);

    expect(rows.map((r) => r.date)).toEqual(["2026-01-05", "2026-01-07", "2026-01-10"]);
    expect(rows.every((r) => r.site === SITE_A)).toBe(true);
    expect(rows.some((r) => r.clicks === 999)).toBe(false);
  });

  it("excludes rows from other sites", () => {
    const db = getDb(fixturePath);
    const rows = totalsInRange(SITE_A, "2026-01-05", "2026-01-10", db);
    expect(rows.some((r) => r.site === SITE_B)).toBe(false);
  });
});

describe("latestCwv", () => {
  it("returns the snapshot with the newest captured_at", () => {
    const db = getDb(fixturePath);
    const snapshot = latestCwv(SITE_A, db);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.captured_at).toBe("2026-01-09T00:00:00Z");
    expect(snapshot?.lcp_p75).toBe(2.1);
  });

  it("returns null for a site with no snapshots", () => {
    const db = getDb(fixturePath);
    expect(latestCwv(SITE_B, db)).toBeNull();
  });
});

describe("listSiteConfigs", () => {
  it("returns all configured sites, ordered by display name, with camelCase fields", () => {
    const db = getDb(fixturePath);
    const configs = listSiteConfigs(db);

    expect(configs.map((c) => c.displayName)).toEqual(["Alexrad", "Optika Čajš", "Skedio"]);

    const alexrad = configs.find((c) => c.property === SITE_A)!;
    expect(alexrad).toEqual({
      property: SITE_A,
      slug: "alexrad",
      displayName: "Alexrad",
      brandToken: "alexrad",
    });
  });
});

describe("siteConfigBySlug", () => {
  it("returns the matching site config for a known slug", () => {
    const db = getDb(fixturePath);
    const config = siteConfigBySlug("skedio", db);

    expect(config).toEqual({
      property: SITE_B,
      slug: "skedio",
      displayName: "Skedio",
      brandToken: "skedio",
    });
  });

  it("returns null for a slug that doesn't exist", () => {
    const db = getDb(fixturePath);
    expect(siteConfigBySlug("no-such-slug", db)).toBeNull();
  });
});

describe("latestTotalsDate", () => {
  it("returns the MAX(date) across all totals_daily rows for a site with data", () => {
    const db = getDb(fixturePath);
    // SITE_A has an out-of-range row on 2026-01-11 -- latestTotalsDate looks
    // at the whole table, not just the 28-day window, so it must see it.
    expect(latestTotalsDate(SITE_A, db)).toBe("2026-01-11");
  });

  it("returns null for a configured site with no totals_daily rows at all", () => {
    const db = getDb(fixturePath);
    expect(latestTotalsDate(SITE_C, db)).toBeNull();
  });
});

describe("readonly enforcement", () => {
  it("rejects writes on a readonly connection", () => {
    const db = getDb(fixturePath);
    expect(() => {
      db.prepare(
        "INSERT INTO totals_daily (site, date, clicks, impressions, ctr, position) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(SITE_A, "2026-02-01", 1, 1, 1, 1);
    }).toThrow();
  });
});
