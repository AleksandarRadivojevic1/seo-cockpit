import { describe, expect, it } from "vitest";

import { buildTrendPaths } from "../lib/report/chart";
import type { TrendPointSr } from "../lib/report/data";

const p = (date: string, impressions: number | null): TrendPointSr => ({
  date,
  impressions,
  clicks: null,
});

describe("buildTrendPaths", () => {
  it("draws one continuous segment when nothing is missing", () => {
    const out = buildTrendPaths(
      [p("2026-07-01", 1), p("2026-07-02", 5), p("2026-07-03", 3)],
      300,
      60
    );
    expect(out.segments).toHaveLength(1);
    expect(out.segments[0].startsWith("M")).toBe(true);
  });

  it("breaks the path at a null instead of dropping it to the axis", () => {
    // The standing lesson: a gap is not a zero. A single path drawn through
    // a null would dive to the baseline and read as a crash in traffic.
    const out = buildTrendPaths(
      [p("2026-07-01", 5), p("2026-07-02", null), p("2026-07-03", 4)],
      300,
      60
    );
    expect(out.segments).toHaveLength(2);
    expect(out.segments[1].startsWith("M")).toBe(true);
  });

  it("draws a measured zero on the baseline, not as a gap", () => {
    const out = buildTrendPaths(
      [p("2026-07-01", 5), p("2026-07-02", 0), p("2026-07-03", 4)],
      300,
      60
    );
    expect(out.segments).toHaveLength(1);
    // The zero sits at the bottom of the box, y = height.
    expect(out.segments[0]).toContain("60.00");
  });

  it("scales the maximum to the top of the box", () => {
    const out = buildTrendPaths([p("2026-07-01", 0), p("2026-07-02", 20)], 300, 60);
    expect(out.max).toBe(20);
    expect(out.segments[0]).toContain("0.00");
  });

  it("returns no segments for an all-null series", () => {
    const out = buildTrendPaths([p("2026-07-01", null), p("2026-07-02", null)], 300, 60);
    expect(out.segments).toEqual([]);
  });

  it("returns no segments for an empty series", () => {
    expect(buildTrendPaths([], 300, 60).segments).toEqual([]);
  });

  it("emits a single collected point as its own segment", () => {
    const out = buildTrendPaths([p("2026-07-01", 5)], 300, 60);
    expect(out.segments).toHaveLength(1);
  });

  it("keeps an all-zero series on the baseline without dividing by zero", () => {
    const out = buildTrendPaths([p("2026-07-01", 0), p("2026-07-02", 0)], 300, 60);
    expect(out.max).toBe(0);
    expect(out.segments[0]).not.toContain("NaN");
    expect(out.segments[0]).toContain("60.00");
  });

  it("produces one segment per run of collected days", () => {
    const out = buildTrendPaths(
      [
        p("2026-07-01", 1),
        p("2026-07-02", null),
        p("2026-07-03", 2),
        p("2026-07-04", 3),
        p("2026-07-05", null),
        p("2026-07-06", 4),
      ],
      300,
      60
    );
    expect(out.segments).toHaveLength(3);
  });

  it("labels the first and last date in Serbian Latin", () => {
    const out = buildTrendPaths([p("2026-07-01", 1), p("2026-07-17", 2)], 300, 60);
    expect(out.ticks).toHaveLength(2);
    expect(out.ticks[0].label).toBe("1. jul");
    expect(out.ticks[1].label).toBe("17. jul");
    expect(out.ticks[1].x).toBe(300);
  });

  it("never emits Cyrillic in a tick label", () => {
    const out = buildTrendPaths([p("2026-01-05", 1), p("2026-02-09", 2)], 300, 60);
    for (const t of out.ticks) expect(t.label).not.toMatch(/[Ѐ-ӿ]/);
  });
});
