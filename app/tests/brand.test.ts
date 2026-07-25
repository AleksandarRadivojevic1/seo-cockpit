import { afterAll, beforeAll, describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getDb } from "../lib/db";
import { brandSeries, foldDiacritics, isBrand } from "../lib/analysis/brand";

describe("foldDiacritics", () => {
  it("NFD-normalizes and strips combining marks", () => {
    expect(foldDiacritics("čajš")).toBe("cajs");
  });

  it("returns an ASCII string unchanged", () => {
    expect(foldDiacritics("hello world")).toBe("hello world");
  });
});

describe("isBrand", () => {
  const TOKEN = "cajs";

  // Real queries from the 2026-07-25 backfill (see task-11a brief): with no
  // diacritic folding and brandToken="optika", "optika leskovac" (a generic
  // city search) and "optika sunce" (a competitor) were both misclassified
  // as brand, while bare "cajs" was misclassified as non-brand.
  it("classifies brand queries", () => {
    expect(isBrand("optika cajs", TOKEN)).toBe(true);
    expect(isBrand("cajs optika", TOKEN)).toBe(true);
    expect(isBrand("cajs", TOKEN)).toBe(true);
    // Accented spelling must still fold to match the unaccented token.
    expect(isBrand("optika čajš", TOKEN)).toBe(true);
  });

  it("classifies non-brand queries (generic + competitor)", () => {
    expect(isBrand("optika leskovac", TOKEN)).toBe(false);
    expect(isBrand("optika sunce", TOKEN)).toBe(false);
    expect(isBrand("tečnost za sočiva", TOKEN)).toBe(false);
  });
});

describe("brandSeries", () => {
  const SITE = "https://optikacajs.rs/";
  const TOKEN = "cajs";
  let fixturePath: string;

  beforeAll(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seo-cockpit-brand-test-"));
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

    // 2026-02-01: both brand and non-brand rows, with deliberately different
    // per-segment weighted positions. A (wrong) globally-weighted
    // implementation would compute one shared value for both segments
    // ((100*5 + 100*3 + 50*20 + 50*10) / 300 = 7.6667 for both) instead of
    // the correct per-segment values below, so this fails under that bug.
    insert.run(SITE, "2026-02-01", "optika cajs", 10, 100, 0.1, 5);
    insert.run(SITE, "2026-02-01", "cajs", 5, 100, 0.05, 3);
    // brand weighted position = (100*5 + 100*3) / 200 = 4
    insert.run(SITE, "2026-02-01", "tecnost za sociva", 1, 50, 0.02, 20);
    insert.run(SITE, "2026-02-01", "optika leskovac", 2, 50, 0.04, 10);
    // nonBrand weighted position = (50*20 + 50*10) / 100 = 15

    // 2026-02-02: a "zero-click date" -- query_daily rows were collected
    // (this day is NOT a gap), but the only row has 0 clicks. It is also
    // non-brand only, so the brand segment for this date has no
    // impressions at all and must come back as {0, 0, null}.
    insert.run(SITE, "2026-02-02", "optika sunce", 0, 10, 0, 8);

    // 2026-02-03: a gap date -- no query_daily rows at all. Must be
    // entirely absent from the result, not emitted with zeros. If this
    // were conflated with the zero-click date above, both would either
    // appear or both would be omitted; the fixture makes sure the test
    // distinguishes them.

    writeDb.close();
  });

  afterAll(() => {
    if (fixturePath) {
      fs.rmSync(path.dirname(fixturePath), { recursive: true, force: true });
    }
  });

  it("computes per-date, per-segment totals with impression-weighted position", () => {
    const db = getDb(fixturePath);
    const series = brandSeries(SITE, "2026-02-01", "2026-02-03", TOKEN, db);

    const day1 = series.find((e) => e.date === "2026-02-01")!;
    expect(day1).toBeDefined();

    expect(day1.brand.clicks).toBe(15);
    expect(day1.brand.impressions).toBe(200);
    expect(day1.brand.position).toBeCloseTo(4, 10);

    expect(day1.nonBrand.clicks).toBe(3);
    expect(day1.nonBrand.impressions).toBe(100);
    expect(day1.nonBrand.position).toBeCloseTo(15, 10);

    // Proves per-segment (not global) weighting: the two segments have
    // different positions on the same date.
    expect(day1.brand.position).not.toBeCloseTo(day1.nonBrand.position as number, 5);
  });

  it("represents a segment with no impressions that day as {0, 0, null}, distinct from an omitted (gap) date", () => {
    const db = getDb(fixturePath);
    const series = brandSeries(SITE, "2026-02-01", "2026-02-03", TOKEN, db);

    const day2 = series.find((e) => e.date === "2026-02-02")!;
    expect(day2).toBeDefined();
    // No brand query at all on this date -> brand segment has no impressions.
    expect(day2.brand).toEqual({ clicks: 0, impressions: 0, position: null });
    // The non-brand row was collected (clicks=0, impressions=10) -- this is
    // a real "zero clicks" measurement, not an absent segment.
    expect(day2.nonBrand).toEqual({ clicks: 0, impressions: 10, position: 8 });
  });

  it("omits a date inside the range with no query_daily rows at all (gap date)", () => {
    const db = getDb(fixturePath);
    const series = brandSeries(SITE, "2026-02-01", "2026-02-03", TOKEN, db);

    expect(series.map((e) => e.date)).toEqual(["2026-02-01", "2026-02-02"]);
    expect(series.some((e) => e.date === "2026-02-03")).toBe(false);
  });

  it("orders entries by date ascending", () => {
    const db = getDb(fixturePath);
    const series = brandSeries(SITE, "2026-02-01", "2026-02-03", TOKEN, db);

    const dates = series.map((e) => e.date);
    const sorted = [...dates].sort();
    expect(dates).toEqual(sorted);
  });
});
