import { describe, expect, it } from "vitest";

import type { AggregatedQuery } from "../lib/analysis/windows";
import { opportunityScore } from "../lib/analysis/score";
import {
  deriveSignals,
  NOISE_FLOOR_IMPRESSIONS,
  POSITION_MOVE_MIN,
  RISING_MIN_DELTA,
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

    // --- non-brand queries at a spread of positions ---
    // Hand-computed opportunityScore for each:
    // pos=11 -> gap=1, ctr=3/300=0.01 -> score=300*1*0.99=297
    recent.set("offpage a", agg({ impressions: 300, clicks: 3, position: 11 }));
    // pos=12 -> gap=2, ctr=10/500=0.02 -> score=500*2*0.98=980
    recent.set("offpage b", agg({ impressions: 500, clicks: 10, position: 12 }));
    // pos=20 -> gap=10, ctr=0/100=0 -> score=100*10*1=1000
    recent.set("offpage c", agg({ impressions: 100, clicks: 0, position: 20 }));
    // Page 1, so score=0 -- these are the rows the old 11-20 band threw away
    // and the new list deliberately keeps: "you already rank here" is a
    // finding, not an absence.
    recent.set("page one nine", agg({ impressions: 900, clicks: 5, position: 9 }));
    recent.set("page one five", agg({ impressions: 900, clicks: 5, position: 5 }));
    // Past page 2 -- the old band excluded this outright, and on the real
    // portfolio it is exactly where the single genuine opportunity lives
    // ("tečnost za sočiva" at 30.5). gap=11, ctr=5/900 -> score=9845
    recent.set("deep but valuable", agg({ impressions: 900, clicks: 5, position: 21 }));

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
    // no prior -> would otherwise be emerging AND non-brand, but impressions < NOISE_FLOOR

    // --- brand / non-brand ---
    recent.set("acme shoes", agg({ impressions: 1000, clicks: 100, position: 3 }));
    recent.set("Acme Reviews", agg({ impressions: 200, clicks: 20, position: 4 }));
    recent.set("running shoes", agg({ impressions: 300, clicks: 10, position: 7 }));
    prior.set("running shoes", agg({ impressions: 250, clicks: 8, position: 7 }));
    recent.set("best sneakers", agg({ impressions: 150, clicks: 5, position: 9 }));
    prior.set("best sneakers", agg({ impressions: 150, clicks: 5, position: 9 }));

    return { recent, prior };
  }

  it("nonBrandQueries: excludes brand terms and keeps every non-brand query regardless of position", () => {
    const { recent, prior } = buildFixture();
    const { nonBrandQueries } = deriveSignals(recent, prior, BRAND);

    const queries = nonBrandQueries.map((e) => e.query);

    // Brand terms never appear, at any position or impression count.
    expect(queries).not.toContain("acme shoes");
    expect(queries).not.toContain("Acme Reviews");
    // Noise floor still applies.
    expect(queries).not.toContain("noise query");

    // The three positions the old 11-20 band would have accepted...
    expect(queries).toContain("offpage a");
    expect(queries).toContain("offpage b");
    expect(queries).toContain("offpage c");
    // ...and the ones it wrongly rejected. This is the whole point of the
    // change: on the real portfolio the band matched nothing while the only
    // query with real upside sat at position 30.5.
    expect(queries).toContain("deep but valuable");
    expect(queries).toContain("page one nine");
    expect(queries).toContain("page one five");
  });

  it("nonBrandQueries: sorts by opportunity score desc, breaking ties on impressions", () => {
    const { recent, prior } = buildFixture();
    const { nonBrandQueries } = deriveSignals(recent, prior, BRAND);

    const scores = nonBrandQueries.map((e) => e.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));

    // The deepest query carries the highest score and therefore leads.
    expect(nonBrandQueries[0].query).toBe("deep but valuable");
    expect(nonBrandQueries[0].score).toBeCloseTo(9845, 10);

    // "offpage b" (500 impr) and "emerging query" (50 impr) both score
    // exactly 980; impressions break the tie.
    const tied = nonBrandQueries.filter((e) => Math.abs(e.score - 980) < 1e-9).map((e) => e.query);
    expect(tied).toEqual(["offpage b", "emerging query"]);
  });

  it("nonBrandQueries: keeps page-1 queries with a zero score rather than dropping them", () => {
    const { recent, prior } = buildFixture();
    const { nonBrandQueries } = deriveSignals(recent, prior, BRAND);

    const pageOne = nonBrandQueries.find((e) => e.query === "page one nine")!;
    expect(pageOne.score).toBe(0);
    // Zero-score rows sort last, but they are present -- an empty opportunity
    // bar means "no upside left", which is not the same as "not ranking".
    const lastScores = nonBrandQueries.slice(-4).map((e) => e.score);
    expect(lastScores).toEqual([0, 0, 0, 0]);
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

  it("single-impression noise: a query with recent impressions=1 is dropped from every signal list", () => {
    const { recent, prior } = buildFixture();
    const signals = deriveSignals(recent, prior, BRAND);

    expect(NOISE_FLOOR_IMPRESSIONS).toBe(2);
    for (const list of [signals.emerging, signals.rising, signals.climbing, signals.declining, signals.nonBrandQueries]) {
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
