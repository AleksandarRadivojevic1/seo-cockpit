import { describe, expect, it } from "vitest";

import { buildBrandBandSeries } from "../lib/analysis/brand";
import type { BrandSeriesEntry } from "../lib/analysis/brand";
import type { TotalsRow } from "../lib/db";

const SITE = "https://optikacajs.rs/";

function totals(date: string, impressions: number): TotalsRow {
  return { site: SITE, date, clicks: 0, impressions, ctr: 0, position: 0 };
}

function segment(impressions: number) {
  return { clicks: 0, impressions, position: null };
}

function entry(date: string, brand: number, nonBrand: number): BrandSeriesEntry {
  return { date, brand: segment(brand), nonBrand: segment(nonBrand) };
}

describe("buildBrandBandSeries", () => {
  it("makes the three bands sum to the day's real total", () => {
    // This is the whole point of the chart: the stack's height must equal
    // the impressions line, or the two charts on the page contradict.
    const out = buildBrandBandSeries(
      [totals("2026-07-20", 20)],
      [entry("2026-07-20", 8, 3)],
      "2026-07-20",
      "2026-07-20"
    );
    expect(out[0].brand).toBe(8);
    expect(out[0].nonBrand).toBe(3);
    expect(out[0].anonymized).toBe(9);
    expect(out[0].brand! + out[0].nonBrand! + out[0].anonymized!).toBe(out[0].total);
  });

  it("treats a collected day with no attributed query as fully anonymized", () => {
    // Real and common: optika-cajs has 4 named queries a day against ~13
    // impressions. Zero brand impressions here is a MEASUREMENT, not a gap.
    const out = buildBrandBandSeries([totals("2026-07-20", 12)], [], "2026-07-20", "2026-07-20");
    expect(out[0].brand).toBe(0);
    expect(out[0].nonBrand).toBe(0);
    expect(out[0].anonymized).toBe(12);
  });

  it("renders an uncollected day as null, never as three zero bands", () => {
    // The standing rule. A zero-height stack would read as "we measured, and
    // nobody searched" on a day nobody collected.
    const out = buildBrandBandSeries(
      [totals("2026-07-20", 5)],
      [entry("2026-07-20", 5, 0)],
      "2026-07-20",
      "2026-07-22"
    );
    expect(out).toHaveLength(3);
    expect(out[1]).toMatchObject({
      date: "2026-07-21",
      brand: null,
      nonBrand: null,
      anonymized: null,
      total: null,
    });
  });

  it("keeps a measured zero day as zeros, distinct from an uncollected one", () => {
    const out = buildBrandBandSeries([totals("2026-07-20", 0)], [], "2026-07-20", "2026-07-20");
    expect(out[0]).toMatchObject({ brand: 0, nonBrand: 0, anonymized: 0, total: 0 });
  });

  it("clamps the anonymized band at zero rather than going negative", () => {
    // query_daily is capped at 500 rows/day and GSC rounds, so the attributed
    // sum could in principle exceed the day's total. A negative band would
    // render as an inverted area and silently corrupt the stack.
    const out = buildBrandBandSeries(
      [totals("2026-07-20", 5)],
      [entry("2026-07-20", 4, 4)],
      "2026-07-20",
      "2026-07-20"
    );
    expect(out[0].anonymized).toBe(0);
  });

  it("covers every calendar day in the window, in order", () => {
    const out = buildBrandBandSeries([], [], "2026-07-20", "2026-07-23");
    expect(out.map((p) => p.date)).toEqual([
      "2026-07-20",
      "2026-07-21",
      "2026-07-22",
      "2026-07-23",
    ]);
  });

  it("ignores query rows on a date that was never collected", () => {
    // Defensive: query_daily and totals_daily are written in the same run, so
    // this should not happen — but if it did, inventing a total from query
    // rows would fabricate a measurement.
    const out = buildBrandBandSeries([], [entry("2026-07-20", 3, 1)], "2026-07-20", "2026-07-20");
    expect(out[0].total).toBeNull();
    expect(out[0].brand).toBeNull();
  });
});
