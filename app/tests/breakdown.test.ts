import { describe, expect, it } from "vitest";

import { buildBrandBreakdown, topPages } from "../lib/analysis/breakdown";
import type { PageRow } from "../lib/db";

function pageRow(overrides: Partial<PageRow> & { page: string }): PageRow {
  return {
    site: "https://example.test/",
    date: "2026-07-01",
    clicks: 0,
    impressions: 0,
    ctr: 0,
    position: 10,
    ...overrides,
  };
}

describe("topPages", () => {
  it("sums a page's rows across days", () => {
    const totals = topPages(
      [
        pageRow({ page: "/a", date: "2026-07-01", clicks: 2, impressions: 20 }),
        pageRow({ page: "/a", date: "2026-07-02", clicks: 3, impressions: 30 }),
      ],
      10
    );

    expect(totals).toHaveLength(1);
    expect(totals[0]).toMatchObject({ page: "/a", clicks: 5, impressions: 50 });
  });

  it("ranks by impressions and applies the limit", () => {
    const totals = topPages(
      [
        pageRow({ page: "/small", impressions: 5 }),
        pageRow({ page: "/big", impressions: 500 }),
        pageRow({ page: "/mid", impressions: 50 }),
      ],
      2
    );

    expect(totals.map((t) => t.page)).toEqual(["/big", "/mid"]);
  });

  it("weights position by impressions, not by day", () => {
    // 3rd on a 200-impression day and 40th on a 2-impression day is a page
    // that effectively ranks ~3rd, not ~21st.
    const totals = topPages(
      [
        pageRow({ page: "/a", date: "2026-07-01", impressions: 200, position: 3 }),
        pageRow({ page: "/a", date: "2026-07-02", impressions: 2, position: 40 }),
      ],
      10
    );

    expect(totals[0].position).toBeCloseTo((200 * 3 + 2 * 40) / 202, 5);
    expect(totals[0].position).toBeLessThan(4);
  });

  it("reports position 0 rather than dividing by zero for an all-zero page", () => {
    const totals = topPages([pageRow({ page: "/a", impressions: 0, position: 0 })], 10);

    expect(totals[0].position).toBe(0);
    expect(Number.isNaN(totals[0].position)).toBe(false);
  });
});

describe("buildBrandBreakdown", () => {
  it("treats the unattributed remainder as its own segment", () => {
    // Optika Cajs's real numbers: 212 total, 52 named.
    const breakdown = buildBrandBreakdown(40, 12, 212);

    expect(breakdown.anonymizedImpressions).toBe(160);
    expect(breakdown.totalImpressions).toBe(212);
  });

  it("keeps the three segments summing to the total", () => {
    const b = buildBrandBreakdown(40, 12, 212);

    expect(b.brandImpressions + b.nonBrandImpressions + b.anonymizedImpressions).toBe(
      b.totalImpressions
    );
  });

  it("does not rescale the known slices to fill the circle", () => {
    // The failure mode this guards: dropping the remainder and letting
    // 40 + 12 become "77% brand / 23% non-brand" of a 212-impression window.
    const b = buildBrandBreakdown(40, 12, 212);

    expect(b.brandImpressions / b.totalImpressions).toBeCloseTo(40 / 212, 5);
    expect(b.brandImpressions / b.totalImpressions).not.toBeCloseTo(40 / 52, 2);
  });

  it("clamps a negative remainder to zero", () => {
    // The two figures come from separate GSC queries and could disagree; a
    // negative segment would be meaningless.
    const b = buildBrandBreakdown(40, 30, 50);

    expect(b.anonymizedImpressions).toBe(0);
    expect(b.totalImpressions).toBe(70);
  });

  it("handles a window with no impressions at all", () => {
    const b = buildBrandBreakdown(0, 0, 0);

    expect(b).toMatchObject({
      brandImpressions: 0,
      nonBrandImpressions: 0,
      anonymizedImpressions: 0,
      totalImpressions: 0,
    });
  });
});
