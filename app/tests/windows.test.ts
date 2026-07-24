import { afterAll, beforeAll, describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getDb } from "../lib/db";
import type { QueryRow } from "../lib/db";
import { aggregateWindow, recentVsPrior, windowBounds } from "../lib/analysis/windows";

function row(overrides: Partial<QueryRow>): QueryRow {
  return {
    site: "site-a",
    date: "2026-01-01",
    query: "x",
    clicks: 0,
    impressions: 0,
    ctr: 0,
    position: 0,
    ...overrides,
  };
}

describe("aggregateWindow", () => {
  it("sums clicks/impressions and computes the impression-weighted average position", () => {
    const rows: QueryRow[] = [
      row({ query: "x", date: "2026-01-01", impressions: 100, clicks: 5, position: 10 }),
      row({ query: "x", date: "2026-01-02", impressions: 300, clicks: 15, position: 6 }),
      row({ query: "y", date: "2026-01-01", impressions: 50, clicks: 2, position: 3 }),
    ];

    const result = aggregateWindow(rows);

    expect(result.size).toBe(2);

    const x = result.get("x");
    expect(x).toBeDefined();
    expect(x!.impressions).toBe(400);
    expect(x!.clicks).toBe(20);
    // (100*10 + 300*6) / 400 = (1000 + 1800) / 400 = 7.0
    expect(x!.position).toBeCloseTo(7.0, 10);

    const y = result.get("y");
    expect(y).toBeDefined();
    expect(y!.impressions).toBe(50);
    expect(y!.clicks).toBe(2);
    expect(y!.position).toBeCloseTo(3.0, 10);
  });

  it("falls back to the plain arithmetic mean of positions when total impressions is 0", () => {
    const rows: QueryRow[] = [
      row({ query: "z", date: "2026-01-01", impressions: 0, clicks: 0, position: 10 }),
      row({ query: "z", date: "2026-01-02", impressions: 0, clicks: 0, position: 20 }),
    ];

    const result = aggregateWindow(rows);
    const z = result.get("z");
    expect(z).toBeDefined();
    expect(z!.impressions).toBe(0);
    expect(z!.clicks).toBe(0);
    // arithmetic mean of [10, 20] = 15
    expect(z!.position).toBeCloseTo(15, 10);
  });

  it("returns an empty map for no rows", () => {
    expect(aggregateWindow([]).size).toBe(0);
  });
});

describe("windowBounds", () => {
  it("matches the worked example for asOf=2026-07-31", () => {
    const bounds = windowBounds("2026-07-31");
    expect(bounds).toEqual({
      recentStart: "2026-07-01",
      recentEnd: "2026-07-28",
      priorStart: "2026-06-03",
      priorEnd: "2026-06-30",
    });
  });

  it("produces exactly 28-day inclusive, contiguous windows", () => {
    const bounds = windowBounds("2026-07-31");

    const daysBetweenInclusive = (start: string, end: string) => {
      const [sy, sm, sd] = start.split("-").map(Number);
      const [ey, em, ed] = end.split("-").map(Number);
      const startMs = Date.UTC(sy, sm - 1, sd);
      const endMs = Date.UTC(ey, em - 1, ed);
      return Math.round((endMs - startMs) / 86_400_000) + 1;
    };

    expect(daysBetweenInclusive(bounds.recentStart, bounds.recentEnd)).toBe(28);
    expect(daysBetweenInclusive(bounds.priorStart, bounds.priorEnd)).toBe(28);

    // prior window ends exactly one day before the recent window starts
    const dayBeforeRecentStart = (() => {
      const [y, m, d] = bounds.recentStart.split("-").map(Number);
      const date = new Date(Date.UTC(y, m - 1, d));
      date.setUTCDate(date.getUTCDate() - 1);
      return date.toISOString().slice(0, 10);
    })();
    expect(bounds.priorEnd).toBe(dayBeforeRecentStart);
  });

  it("handles a month/year boundary correctly via UTC math (asOf near March 1)", () => {
    // asOf = 2026-03-02 (not a leap year: Feb 2026 has 28 days)
    // recentEnd = asOf - 3 = 2026-02-27
    // recentStart = recentEnd - 27 = 2026-01-31
    // priorEnd = recentStart - 1 = 2026-01-30
    // priorStart = priorEnd - 27 = 2026-01-03
    const bounds = windowBounds("2026-03-02");
    expect(bounds).toEqual({
      recentStart: "2026-01-31",
      recentEnd: "2026-02-27",
      priorStart: "2026-01-03",
      priorEnd: "2026-01-30",
    });
  });
});

describe("recentVsPrior", () => {
  const SITE = "site-fixture";
  let fixturePath: string;

  beforeAll(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seo-cockpit-windows-test-"));
    fixturePath = path.join(dir, "fixture.db");

    const writeDb = new BetterSqlite3(fixturePath);
    writeDb.exec(`
      CREATE TABLE query_daily (
        site TEXT, date TEXT, query TEXT, clicks INT, impressions INT, ctr REAL, position REAL,
        PRIMARY KEY (site, date, query)
      );
    `);

    const insert = writeDb.prepare(
      "INSERT INTO query_daily (site, date, query, clicks, impressions, ctr, position) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );

    // asOf = 2026-07-31 -> recent 2026-07-01..2026-07-28, prior 2026-06-03..2026-06-30
    // Recent-window row
    insert.run(SITE, "2026-07-15", "recent query", 4, 40, 0.1, 8);
    // Prior-window row
    insert.run(SITE, "2026-06-15", "prior query", 2, 20, 0.1, 12);
    // Outside both windows (before prior, and after recent/after asOf)
    insert.run(SITE, "2026-05-01", "outside query", 99, 999, 0.9, 1);
    insert.run(SITE, "2026-07-30", "too recent query", 99, 999, 0.9, 1);

    writeDb.close();
  });

  afterAll(() => {
    if (fixturePath) {
      fs.rmSync(path.dirname(fixturePath), { recursive: true, force: true });
    }
  });

  it("splits rows into recent and prior windows, excluding rows outside both", () => {
    const db = getDb(fixturePath);
    const { recent, prior } = recentVsPrior(SITE, "2026-07-31", db);

    expect(recent.has("recent query")).toBe(true);
    expect(recent.has("prior query")).toBe(false);
    expect(recent.has("outside query")).toBe(false);
    expect(recent.has("too recent query")).toBe(false);

    expect(prior.has("prior query")).toBe(true);
    expect(prior.has("recent query")).toBe(false);
    expect(prior.has("outside query")).toBe(false);
    expect(prior.has("too recent query")).toBe(false);
  });
});
