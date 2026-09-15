import { describe, expect, it } from "vitest";

import { computeGrowth, GROWTH_WINDOW_DAYS } from "../lib/report/growth";
import { addDaysUTC } from "../lib/analysis/windows";
import type { TotalsRow } from "../lib/db";

/** A contiguous run of daily rows starting at `start`, each day identical. */
function series(
  start: string,
  days: number,
  per: { clicks: number; impressions: number; position: number }
): TotalsRow[] {
  const rows: TotalsRow[] = [];
  for (let i = 0; i < days; i++) {
    rows.push({
      site: "s",
      date: addDaysUTC(start, i),
      clicks: per.clicks,
      impressions: per.impressions,
      ctr: 0,
      position: per.position,
    });
  }
  return rows;
}

describe("computeGrowth", () => {
  it("returns null with no rows", () => {
    expect(computeGrowth([])).toBeNull();
  });

  it("returns null when history is shorter than two windows", () => {
    // 59 days cannot hold two non-overlapping 30-day windows.
    const rows = series("2026-01-01", 59, { clicks: 1, impressions: 10, position: 5 });
    expect(computeGrowth(rows)).toBeNull();
  });

  it("compares the first and last window at exactly two windows of history", () => {
    // 60 days: before = days 1..30, after = days 31..60 (adjacent, no overlap).
    const before = series("2026-01-01", 30, { clicks: 1, impressions: 10, position: 12 });
    const after = series(addDaysUTC("2026-01-01", 30), 30, { clicks: 5, impressions: 40, position: 4 });
    const g = computeGrowth([...before, ...after]);
    expect(g).not.toBeNull();
    expect(g!.beforeStart).toBe("2026-01-01");
    expect(g!.beforeEnd).toBe(addDaysUTC("2026-01-01", 29));
    expect(g!.afterStart).toBe(addDaysUTC("2026-01-01", 30));
    expect(g!.afterEnd).toBe(addDaysUTC("2026-01-01", 59));
    expect(g!.durationDays).toBe(60);
    // 30 days × (1 vs 5) clicks = 30 → 150, +400%.
    expect(g!.clicks).toEqual({ before: 30, after: 150, deltaPct: 400 });
    // 30 days × (10 vs 40) impressions = 300 → 1200, +300%.
    expect(g!.impressions).toEqual({ before: 300, after: 1200, deltaPct: 300 });
    // Weighted position: uniform, so equal to the per-row value.
    expect(g!.position.before).toBeCloseTo(12);
    expect(g!.position.after).toBeCloseTo(4);
  });

  it("ignores rows between the two windows (only the extremes count)", () => {
    // A long middle stretch should not affect before/after, only the ends.
    const before = series("2026-01-01", 30, { clicks: 2, impressions: 20, position: 10 });
    const middle = series(addDaysUTC("2026-01-01", 30), 40, { clicks: 99, impressions: 999, position: 1 });
    const after = series(addDaysUTC("2026-01-01", 70), 30, { clicks: 8, impressions: 80, position: 3 });
    const g = computeGrowth([...before, ...middle, ...after])!;
    expect(g.clicks.before).toBe(60); // 30 × 2, not touched by the middle
    expect(g.clicks.after).toBe(240); // 30 × 8
    expect(g.durationDays).toBe(100);
  });

  it("reports null deltaPct when the baseline window has zero of a metric", () => {
    // Before window has no clicks — growth from nothing has no percentage.
    const before = series("2026-01-01", 30, { clicks: 0, impressions: 5, position: 20 });
    const after = series(addDaysUTC("2026-01-01", 30), 30, { clicks: 7, impressions: 50, position: 6 });
    const g = computeGrowth([...before, ...after])!;
    expect(g.clicks.before).toBe(0);
    expect(g.clicks.after).toBe(210);
    expect(g.clicks.deltaPct).toBeNull();
    // Impressions had a baseline, so the percentage is defined.
    expect(g.impressions.deltaPct).not.toBeNull();
  });

  it("yields a null window position when that window collected no impressions", () => {
    const before = series("2026-01-01", 30, { clicks: 0, impressions: 0, position: 0 });
    const after = series(addDaysUTC("2026-01-01", 30), 30, { clicks: 3, impressions: 30, position: 5 });
    const g = computeGrowth([...before, ...after])!;
    expect(g.position.before).toBeNull();
    expect(g.position.after).toBeCloseTo(5);
  });

  it("weights position by impressions within a window", () => {
    // After window: two different days, position weighted by impressions.
    const before = series("2026-01-01", 30, { clicks: 1, impressions: 10, position: 10 });
    const after: TotalsRow[] = [
      { site: "s", date: addDaysUTC("2026-01-01", 30), clicks: 1, impressions: 90, ctr: 0, position: 2 },
      { site: "s", date: addDaysUTC("2026-01-01", 59), clicks: 1, impressions: 10, ctr: 0, position: 12 },
    ];
    const g = computeGrowth([...before, ...after])!;
    // (2×90 + 12×10) / 100 = (180 + 120) / 100 = 3.0
    expect(g.position.after).toBeCloseTo(3);
  });

  it("uses the window size constant by default", () => {
    expect(GROWTH_WINDOW_DAYS).toBe(30);
  });
});
