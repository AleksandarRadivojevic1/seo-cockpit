import { afterAll, beforeAll, describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  getDb,
  latestCwv,
  listSites,
  queryRowsInRange,
  totalsInRange,
} from "../lib/db";

const SITE_A = "sc-domain:alexrad.dev";
const SITE_B = "https://skedio.rs/";

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

  // Chosen test range: 2026-01-05 .. 2026-01-10 (inclusive)
  // In-range dates for SITE_A
  const inRangeDates = ["2026-01-05", "2026-01-07", "2026-01-10"];
  // Out-of-range dates (just outside the range on both sides)
  const outOfRangeDates = ["2026-01-04", "2026-01-11"];

  for (const date of inRangeDates) {
    insertTotals.run(SITE_A, date, 10, 100, 0.1, 5.5);
    insertQuery.run(SITE_A, date, "keyword one", 3, 30, 0.1, 4.2);
  }
  for (const date of outOfRangeDates) {
    insertTotals.run(SITE_A, date, 999, 9999, 0.9, 1.1);
    insertQuery.run(SITE_A, date, "keyword one", 999, 9999, 0.9, 1.1);
  }

  // SITE_B rows on the same in-range dates, to prove site filtering works.
  for (const date of inRangeDates) {
    insertTotals.run(SITE_B, date, 20, 200, 0.2, 6.5);
    insertQuery.run(SITE_B, date, "another keyword", 5, 50, 0.2, 3.3);
  }

  // CWV snapshots for SITE_A at two different captured_at values.
  insertCwv.run(SITE_A, "https://alexrad.dev/", "2026-01-05T00:00:00Z", 2.5, 200, 0.1, "crux", "PHONE");
  insertCwv.run(SITE_A, "https://alexrad.dev/", "2026-01-09T00:00:00Z", 2.1, 180, 0.05, "crux", "PHONE");
  // SITE_B has no cwv snapshots at all.

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
