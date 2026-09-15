import { describe, it, expect } from "vitest";

import {
  detectCannibalization,
  buildCannibalization,
} from "../lib/analysis/cannibalization";

const row = (
  query: string,
  page: string,
  clicks: number,
  impressions: number,
  position: number,
) => ({ query, page, clicks, impressions, ctr: 0, position });

describe("detectCannibalization", () => {
  it("flags a query where two pages clear the floor and the runner-up holds 20% share", () => {
    const out = detectCannibalization([
      row("q", "p1", 10, 100, 3),
      row("q", "p2", 1, 20, 8), // 20% of 100 -> included
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].canonical.page).toBe("p1"); // most clicks
    expect(out[0].competitors.map((c) => c.page)).toEqual(["p2"]);
    expect(out[0].impressionsAtStake).toBe(20);
  });

  it("excludes a page below the impression floor (only one qualifies)", () => {
    expect(
      detectCannibalization([row("q", "p1", 5, 100, 3), row("q", "p2", 0, 9, 8)]),
    ).toEqual([]);
  });

  it("excludes when the runner-up is below the 20% share (19 of 100)", () => {
    expect(
      detectCannibalization([row("q", "p1", 5, 100, 3), row("q", "p2", 0, 19, 8)]),
    ).toEqual([]);
  });

  it("breaks a clicks tie by best (lowest) position when choosing canonical", () => {
    const out = detectCannibalization([
      row("q", "p1", 3, 50, 9),
      row("q", "p2", 3, 50, 2),
    ]);
    expect(out[0].canonical.page).toBe("p2");
  });

  it("ranks queries by impressions at stake, descending", () => {
    const out = detectCannibalization([
      row("small", "a", 5, 100, 3),
      row("small", "b", 1, 30, 8),
      row("big", "c", 5, 100, 3),
      row("big", "d", 1, 90, 8),
    ]);
    expect(out.map((q) => q.query)).toEqual(["big", "small"]);
  });

  it("does not flag a single-page query", () => {
    expect(detectCannibalization([row("q", "p1", 5, 100, 3)])).toEqual([]);
  });
});

describe("buildCannibalization", () => {
  it("reports notCollected when there are no snapshot rows", () => {
    expect(buildCannibalization([])).toEqual({ notCollected: true, items: [] });
  });

  it("reports collected-but-empty when rows exist but none cannibalize", () => {
    expect(buildCannibalization([row("q", "p1", 5, 100, 3)])).toEqual({
      notCollected: false,
      items: [],
    });
  });
});
