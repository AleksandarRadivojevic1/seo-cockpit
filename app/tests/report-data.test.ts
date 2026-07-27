import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { buildReportData } from "../lib/report/data";
import type { SiteConfig } from "../lib/db";

const CONFIG: SiteConfig = {
  property: "https://example.rs/",
  slug: "example",
  displayName: "Primer",
  brandToken: "primer",
};

/**
 * Mirrors the real collector schema. These fixtures are a hand-maintained
 * copy and have drifted silently before (11d added lh_* and country_daily
 * and the app's fixtures did not follow for weeks), so they include every
 * column the queries touch.
 */
function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
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
    CREATE TABLE demand_keywords (
      site TEXT, keyword TEXT, source TEXT, seed TEXT, suggest_rank INT,
      rising_pct REAL, rising_label TEXT, top_value REAL, volume INT,
      first_seen TEXT, last_seen TEXT,
      PRIMARY KEY (site, keyword, source)
    );
  `);
  return db;
}

/** `days` consecutive days of totals ending at `endISO`, inclusive. */
function seedTotals(db: Database.Database, endISO: string, days: number): void {
  const stmt = db.prepare(
    "INSERT INTO totals_daily (site, date, clicks, impressions, ctr, position) VALUES (?, date(?, ?), 2, 10, 0.2, 4.0)"
  );
  for (let i = 0; i < days; i += 1) stmt.run(CONFIG.property, endISO, `-${i} day`);
}

describe("buildReportData", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it("reports the days actually collected, not the nominal 28", () => {
    // optika-cajs holds 17 days inside a 28-day window. A header saying
    // "poslednjih 28 dana" would be false on the first real site.
    seedTotals(db, "2026-07-23", 17);
    const data = buildReportData(CONFIG, "2026-07-26", db);
    expect(data.measuredDays).toBe(17);
    expect(data.measuredStart).toBe("2026-07-07");
    expect(data.measuredEnd).toBe("2026-07-23");
  });

  it("flags an absent prior window instead of reporting no change", () => {
    seedTotals(db, "2026-07-23", 17);
    const data = buildReportData(CONFIG, "2026-07-26", db);
    expect(data.hasPriorWindow).toBe(false);
    expect(data.clicks.deltaPct).toBeNull();
  });

  it("reports a prior window when one exists", () => {
    seedTotals(db, "2026-07-23", 60);
    const data = buildReportData(CONFIG, "2026-07-26", db);
    expect(data.hasPriorWindow).toBe(true);
    expect(data.clicks.deltaPct).not.toBeNull();
  });

  it("returns a trend point per measured day, with null for a gap", () => {
    const ins = db.prepare(
      "INSERT INTO totals_daily (site, date, clicks, impressions, ctr, position) VALUES (?,?,?,?,?,?)"
    );
    ins.run(CONFIG.property, "2026-07-20", 1, 5, 0.2, 3);
    ins.run(CONFIG.property, "2026-07-22", 0, 0, 0, 0);
    // asOf must be the last data date + LAG_DAYS (3): windowBounds ends the
    // recent window three days behind asOf because GSC reports with that
    // lag. An asOf of 07-23 would put the 07-22 row outside the window.
    const data = buildReportData(CONFIG, "2026-07-25", db);
    const byDate = new Map(data.trend.map((p) => [p.date, p.impressions]));
    expect(byDate.get("2026-07-20")).toBe(5);
    expect(byDate.get("2026-07-21")).toBeNull(); // never collected
    expect(byDate.get("2026-07-22")).toBe(0); // measured zero
  });

  it("excludes brand queries and page-1 rows from opportunities", () => {
    seedTotals(db, "2026-07-23", 17);
    const q = db.prepare(
      "INSERT INTO query_daily (site, date, query, clicks, impressions, ctr, position) VALUES (?,?,?,?,?,?,?)"
    );
    q.run(CONFIG.property, "2026-07-20", "primer", 5, 20, 0.25, 2.0);
    q.run(CONFIG.property, "2026-07-20", "naocare cena", 0, 8, 0, 30.5);
    const data = buildReportData(CONFIG, "2026-07-26", db);
    const queries = data.opportunities.map((o) => o.query);
    expect(queries).toContain("naocare cena");
    expect(queries).not.toContain("primer");
  });

  it("marks demand as not collected when discovery has never run", () => {
    seedTotals(db, "2026-07-23", 17);
    expect(buildReportData(CONFIG, "2026-07-26", db).demand.notCollected).toBe(true);
  });

  it("reports serpState not-checked when the SERP tables do not exist", () => {
    // Any database predating Task 2.5 has no serp_checks table at all.
    seedTotals(db, "2026-07-23", 17);
    const data = buildReportData(CONFIG, "2026-07-26", db);
    expect(data.serpState).toBe("not-checked");
    expect(data.competitors).toEqual([]);
  });

  it("distinguishes a measured-zero site from a never-collected one", () => {
    const zero = db.prepare(
      "INSERT INTO totals_daily (site, date, clicks, impressions, ctr, position) VALUES (?,?,0,0,0,0)"
    );
    for (let i = 0; i < 5; i += 1) zero.run(CONFIG.property, `2026-07-1${i}`);
    expect(buildReportData(CONFIG, "2026-07-20", db).dataState).toBe("zero");

    const empty = buildReportData(
      { ...CONFIG, property: "https://nothing.rs/" },
      "2026-07-20",
      db
    );
    expect(empty.dataState).toBe("not-collected");
  });

  it("leaves avgPosition null rather than zero when nothing was measured", () => {
    const data = buildReportData(CONFIG, "2026-07-26", db);
    expect(data.avgPosition).toBeNull();
    expect(data.impressions).toBe(0);
  });

  it("weights average position by impressions, not by day", () => {
    const ins = db.prepare(
      "INSERT INTO totals_daily (site, date, clicks, impressions, ctr, position) VALUES (?,?,?,?,?,?)"
    );
    // 100 impressions at position 2, 1 impression at position 40. A plain
    // mean would read 21; the impression-weighted value is ~2.4.
    ins.run(CONFIG.property, "2026-07-20", 0, 100, 0, 2);
    ins.run(CONFIG.property, "2026-07-21", 0, 1, 0, 40);
    // Last data date + LAG_DAYS, as above.
    const data = buildReportData(CONFIG, "2026-07-24", db);
    expect(data.avgPosition).toBeCloseTo((100 * 2 + 1 * 40) / 101, 5);
  });

  it("has an empty trend rather than throwing when nothing was collected", () => {
    const data = buildReportData(CONFIG, "2026-07-26", db);
    expect(data.trend).toEqual([]);
    expect(data.measuredStart).toBeNull();
    expect(data.measuredEnd).toBeNull();
  });
});
