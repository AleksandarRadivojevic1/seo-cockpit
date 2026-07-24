import { describe, expect, it } from "vitest";

import type { AggregatedQuery } from "../lib/analysis/windows";
import { opportunityScore } from "../lib/analysis/score";
import {
  deriveSignals,
  NOISE_FLOOR_IMPRESSIONS,
  POSITION_MOVE_MIN,
  RISING_MIN_DELTA,
  STRIKING_MAX_POS,
  STRIKING_MIN_POS,
} from "../lib/analysis/signals";

function agg(overrides: Partial<AggregatedQuery>): AggregatedQuery {
  return { impressions: 0, clicks: 0, position: 0, ...overrides };
}

describe("opportunityScore", () => {
  it("computes impressions × gapToPage1 × (1 − ctr) for an off-page-1 query", () => {
    // impressions=200, clicks=4 -> ctr=0.02, position=15 -> gapToPage1=5
    // score = 200 * 5 * 0.98 = 980
    const score = opportunityScore(agg({ impressions: 200, clicks: 4, position: 15 }));
    expect(score).toBeCloseTo(980, 10);
  });

  it("is 0 for a page-1 position (<=10), regardless of impressions/ctr", () => {
    expect(opportunityScore(agg({ impressions: 500, clicks: 10, position: 10 }))).toBe(0);
    expect(opportunityScore(agg({ impressions: 500, clicks: 10, position: 1 }))).toBe(0);
  });

  it("treats 0 impressions as ctr=0 without dividing by zero", () => {
    expect(opportunityScore(agg({ impressions: 0, clicks: 0, position: 15 }))).toBe(0);
  });
});

describe("deriveSignals", () => {
  const BRAND = "acme";

  function buildFixture() {
    const recent = new Map<string, AggregatedQuery>();
    const prior = new Map<string, AggregatedQuery>();

    // --- strikingDistance candidates ---
    // Inside [8,20], real impressions. Hand-computed opportunityScore:
    // "striking a" pos=10 -> gapToPage1=0 -> score=0 (boundary: <=10 is page-1, not counted below in ordering assertions except presence)
    recent.set("striking a", agg({ impressions: 300, clicks: 3, position: 10 }));
    // "striking b" pos=12 -> gap=2, ctr=10/500=0.02 -> score=500*2*0.98=980
    recent.set("striking b", agg({ impressions: 500, clicks: 10, position: 12 }));
    // "striking c" pos=20 -> gap=10, ctr=0/100=0 -> score=100*10*1=1000
    recent.set("striking c", agg({ impressions: 100, clicks: 0, position: 20 }));
    // Excluded: position < 8
    recent.set("too high", agg({ impressions: 900, clicks: 5, position: 5 }));
    // Excluded: position > 20
    recent.set("too low", agg({ impressions: 900, clicks: 5, position: 21 }));

    // --- rising / not rising ---
    recent.set("rising query", agg({ impressions: 100, clicks: 5, position: 25 }));
    prior.set("rising query", agg({ impressions: 80, clicks: 4, position: 25 }));
    // delta = 20 >= RISING_MIN_DELTA(10) -> rising

    recent.set("flat query", agg({ impressions: 105, clicks: 5, position: 25 }));
    prior.set("flat query", agg({ impressions: 100, clicks: 5, position: 25 }));
    // delta = 5 < 10 -> not rising

    // --- emerging ---
    recent.set("emerging query", agg({ impressions: 50, clicks: 1, position: 30 }));
    // no prior entry

    // --- climbing ---
    recent.set("climbing query", agg({ impressions: 60, clicks: 2, position: 14 }));
    prior.set("climbing query", agg({ impressions: 60, clicks: 2, position: 19 }));
    // positionDelta = 19 - 14 = 5 >= POSITION_MOVE_MIN(3) -> climbing

    // --- declining (position worsened) ---
    recent.set("declining query", agg({ impressions: 40, clicks: 1, position: 25 }));
    prior.set("declining query", agg({ impressions: 40, clicks: 1, position: 18 }));
    // positionDelta = 18 - 25 = -7 <= -3 -> declining

    // --- single-impression noise ---
    recent.set("noise query", agg({ impressions: 1, clicks: 0, position: 12 }));
    // no prior -> would otherwise be emerging AND in striking band, but impressions < NOISE_FLOOR

    // --- brand / non-brand ---
    recent.set("acme shoes", agg({ impressions: 1000, clicks: 100, position: 3 }));
    recent.set("Acme Reviews", agg({ impressions: 200, clicks: 20, position: 4 }));
    recent.set("running shoes", agg({ impressions: 300, clicks: 10, position: 7 }));
    prior.set("running shoes", agg({ impressions: 250, clicks: 8, position: 7 }));
    recent.set("best sneakers", agg({ impressions: 150, clicks: 5, position: 9 }));
    prior.set("best sneakers", agg({ impressions: 150, clicks: 5, position: 9 }));

    return { recent, prior };
  }

  it("includes queries in the [8,20] striking-distance band, ordered by opportunityScore desc, and excludes queries outside it", () => {
    const { recent, prior } = buildFixture();
    const { strikingDistance } = deriveSignals(recent, prior, BRAND);

    const queries = strikingDistance.map((e) => e.query);
    expect(queries).toContain("striking a");
    expect(queries).toContain("striking b");
    expect(queries).toContain("striking c");
    expect(queries).not.toContain("too high");
    expect(queries).not.toContain("too low");
    expect(queries).not.toContain("noise query"); // dropped by noise floor

    // Hand-computed scores: c=1000, b=980, a=0
    const scoresInOrder = strikingDistance
      .filter((e) => ["striking a", "striking b", "striking c"].includes(e.query))
      .map((e) => e.query);
    expect(scoresInOrder).toEqual(["striking c", "striking b", "striking a"]);

    const b = strikingDistance.find((e) => e.query === "striking b")!;
    expect(b.score).toBeCloseTo(980, 10);
    const c = strikingDistance.find((e) => e.query === "striking c")!;
    expect(c.score).toBeCloseTo(1000, 10);
  });

  it("rising: includes a query whose impressions rose >= RISING_MIN_DELTA, excludes one that rose less", () => {
    const { recent, prior } = buildFixture();
    const { rising } = deriveSignals(recent, prior, BRAND);

    const queries = rising.map((e) => e.query);
    expect(queries).toContain("rising query");
    expect(queries).not.toContain("flat query");

    const entry = rising.find((e) => e.query === "rising query")!;
    expect(entry.impressionsDelta).toBe(20);
    expect(RISING_MIN_DELTA).toBe(10);
  });

  it("emerging: includes a query present in recent but not prior (with null deltas), excludes noise", () => {
    const { recent, prior } = buildFixture();
    const { emerging } = deriveSignals(recent, prior, BRAND);

    const entry = emerging.find((e) => e.query === "emerging query");
    expect(entry).toBeDefined();
    expect(entry!.impressionsDelta).toBeNull();
    expect(entry!.positionDelta).toBeNull();

    expect(emerging.map((e) => e.query)).not.toContain("noise query");
  });

  it("climbing: includes a query whose position improved by >= POSITION_MOVE_MIN spots", () => {
    const { recent, prior } = buildFixture();
    const { climbing } = deriveSignals(recent, prior, BRAND);

    const entry = climbing.find((e) => e.query === "climbing query");
    expect(entry).toBeDefined();
    expect(entry!.positionDelta).toBe(5);
    expect(POSITION_MOVE_MIN).toBe(3);

    expect(climbing.map((e) => e.query)).not.toContain("flat query");
  });

  it("declining: includes a query whose position worsened by >= POSITION_MOVE_MIN spots", () => {
    const { recent, prior } = buildFixture();
    const { declining } = deriveSignals(recent, prior, BRAND);

    const entry = declining.find((e) => e.query === "declining query");
    expect(entry).toBeDefined();
    expect(entry!.positionDelta).toBe(-7);

    expect(declining.map((e) => e.query)).not.toContain("flat query");
  });

  it("declining: includes a query whose impressions dropped by >= RISING_MIN_DELTA even when position is stable/improved (impressions-only OR-branch)", () => {
    const recent = new Map<string, AggregatedQuery>();
    const prior = new Map<string, AggregatedQuery>();

    // impressionsDelta = 80 - 100 = -20 <= -RISING_MIN_DELTA(10) -> qualifies via impressions branch.
    // positionDelta = 15 - 15 = 0, which is >= 0, so the position branch (<= -POSITION_MOVE_MIN) does NOT fire.
    recent.set("impression drop query", agg({ impressions: 80, clicks: 2, position: 15 }));
    prior.set("impression drop query", agg({ impressions: 100, clicks: 3, position: 15 }));

    const { declining } = deriveSignals(recent, prior, BRAND);

    const entry = declining.find((e) => e.query === "impression drop query");
    expect(entry).toBeDefined();
    expect(entry!.impressionsDelta).toBe(-20);
    expect(entry!.positionDelta).toBe(0);
  });

  it("sort order: emerging/rising/climbing/declining each return multiple qualifying entries in their specified order", () => {
    const recent = new Map<string, AggregatedQuery>();
    const prior = new Map<string, AggregatedQuery>();

    // --- emerging: sorted by recent impressions desc ---
    recent.set("emerge high", agg({ impressions: 300, clicks: 5, position: 25 }));
    recent.set("emerge low", agg({ impressions: 50, clicks: 1, position: 25 }));

    // --- rising: sorted by impressionsDelta (recent-prior) desc ---
    recent.set("rise big", agg({ impressions: 200, clicks: 5, position: 25 }));
    prior.set("rise big", agg({ impressions: 150, clicks: 5, position: 25 })); // delta = 50
    recent.set("rise small", agg({ impressions: 120, clicks: 5, position: 25 }));
    prior.set("rise small", agg({ impressions: 100, clicks: 5, position: 25 })); // delta = 20

    // --- climbing: sorted by positionDelta (prior.position - recent.position) desc ---
    recent.set("climb big", agg({ impressions: 60, clicks: 2, position: 10 }));
    prior.set("climb big", agg({ impressions: 60, clicks: 2, position: 25 })); // positionDelta = 15
    recent.set("climb small", agg({ impressions: 60, clicks: 2, position: 20 }));
    prior.set("climb small", agg({ impressions: 60, clicks: 2, position: 25 })); // positionDelta = 5

    // --- declining: "worst first" = impressionsDelta asc (most negative first) ---
    recent.set("decline worse", agg({ impressions: 50, clicks: 1, position: 20 }));
    prior.set("decline worse", agg({ impressions: 100, clicks: 1, position: 20 })); // delta = -50
    recent.set("decline mild", agg({ impressions: 90, clicks: 1, position: 20 }));
    prior.set("decline mild", agg({ impressions: 100, clicks: 1, position: 20 })); // delta = -10

    const { emerging, rising, climbing, declining } = deriveSignals(recent, prior, BRAND);

    expect(emerging.map((e) => e.query)).toEqual(["emerge high", "emerge low"]);
    expect(rising.map((e) => e.query)).toEqual(["rise big", "rise small"]);
    expect(climbing.map((e) => e.query)).toEqual(["climb big", "climb small"]);
    expect(declining.map((e) => e.query)).toEqual(["decline worse", "decline mild"]);
  });

  it("single-impression noise: a query with recent impressions=1 is dropped from emerging/rising/striking lists", () => {
    const { recent, prior } = buildFixture();
    const signals = deriveSignals(recent, prior, BRAND);

    expect(NOISE_FLOOR_IMPRESSIONS).toBe(2);
    for (const list of [signals.emerging, signals.rising, signals.climbing, signals.declining, signals.strikingDistance]) {
      expect(list.map((e) => e.query)).not.toContain("noise query");
    }
  });

  it("brand/non-brand totals: sums recent impressions+clicks by case-insensitive substring brand match, and computes nonBrandImpressionsDelta", () => {
    const { recent, prior } = buildFixture();
    const { brandSplit } = deriveSignals(recent, prior, BRAND);

    // Brand queries (contain "acme", case-insensitive): "acme shoes" (1000/100), "Acme Reviews" (200/20)
    expect(brandSplit.brand.impressions).toBe(1200);
    expect(brandSplit.brand.clicks).toBe(120);

    // Non-brand recent queries include many from the fixture; spot-check via the sum of
    // "running shoes" (300) + "best sneakers" (150) plus all the other non-brand recent
    // queries set up above. Compute expected total directly from the fixture map to keep
    // this assertion honest as the fixture evolves.
    let expectedNonBrandImpressions = 0;
    let expectedNonBrandClicks = 0;
    for (const [query, row] of recent) {
      if (!query.toLowerCase().includes(BRAND)) {
        expectedNonBrandImpressions += row.impressions;
        expectedNonBrandClicks += row.clicks;
      }
    }
    expect(brandSplit.nonBrand.impressions).toBe(expectedNonBrandImpressions);
    expect(brandSplit.nonBrand.clicks).toBe(expectedNonBrandClicks);

    // nonBrandImpressionsDelta = recent non-brand impressions - prior non-brand impressions
    let expectedPriorNonBrandImpressions = 0;
    for (const [query, row] of prior) {
      if (!query.toLowerCase().includes(BRAND)) {
        expectedPriorNonBrandImpressions += row.impressions;
      }
    }
    expect(brandSplit.nonBrandImpressionsDelta).toBe(
      expectedNonBrandImpressions - expectedPriorNonBrandImpressions
    );
  });

  it("brandSplit totals are not affected by the noise floor (single-impression query still counted)", () => {
    const { recent, prior } = buildFixture();
    const { brandSplit } = deriveSignals(recent, prior, BRAND);

    // "noise query" (impressions=1) is non-brand and must still be reflected in nonBrand totals.
    let expectedNonBrandImpressions = 0;
    for (const [query, row] of recent) {
      if (!query.toLowerCase().includes(BRAND)) {
        expectedNonBrandImpressions += row.impressions;
      }
    }
    expect(brandSplit.nonBrand.impressions).toBe(expectedNonBrandImpressions);
    expect(expectedNonBrandImpressions).toBeGreaterThanOrEqual(1); // sanity: noise query's 1 impression is in there
  });
});
