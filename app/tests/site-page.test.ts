import { describe, expect, it } from "vitest";

import { buildTrendSeries } from "../app/site/[slug]/page";
import type { TotalsRow } from "../lib/db";

function totalsRow(overrides: Partial<TotalsRow>): TotalsRow {
  return {
    site: "example.com",
    date: "2026-07-01",
    clicks: 0,
    impressions: 0,
    ctr: 0,
    position: 0,
    ...overrides,
  };
}

describe("buildTrendSeries", () => {
  it("emits one entry per calendar day in the range, inclusive", () => {
    const series = buildTrendSeries([], "2026-07-01", "2026-07-05");
    expect(series.map((p) => p.date)).toEqual([
      "2026-07-01",
      "2026-07-02",
      "2026-07-03",
      "2026-07-04",
      "2026-07-05",
    ]);
  });

  it("fills a date with no totals_daily row as null, not 0", () => {
    const rows = [totalsRow({ date: "2026-07-01", clicks: 5, impressions: 50 })];
    const series = buildTrendSeries(rows, "2026-07-01", "2026-07-03");

    expect(series[0]).toEqual({ date: "2026-07-01", clicks: 5, impressions: 50 });
    // 07-02 and 07-03 have no row -- must be null, never bridged to a
    // number and never coerced to 0.
    expect(series[1]).toEqual({ date: "2026-07-02", clicks: null, impressions: null });
    expect(series[2]).toEqual({ date: "2026-07-03", clicks: null, impressions: null });
  });

  it("keeps a measured zero row as 0, distinct from a missing (null) day", () => {
    const rows = [totalsRow({ date: "2026-07-02", clicks: 0, impressions: 0 })];
    const series = buildTrendSeries(rows, "2026-07-01", "2026-07-03");

    expect(series[0]).toEqual({ date: "2026-07-01", clicks: null, impressions: null });
    // A real row with clicks=0/impressions=0 ("measured zero") must stay 0,
    // not collapse into the same null representation as the missing days
    // either side of it.
    expect(series[1]).toEqual({ date: "2026-07-02", clicks: 0, impressions: 0 });
    expect(series[2]).toEqual({ date: "2026-07-03", clicks: null, impressions: null });
  });

  it("clicks and impressions are filled independently", () => {
    const rows = [totalsRow({ date: "2026-07-01", clicks: 3, impressions: 0 })];
    const series = buildTrendSeries(rows, "2026-07-01", "2026-07-01");
    expect(series[0]).toEqual({ date: "2026-07-01", clicks: 3, impressions: 0 });
  });
});
