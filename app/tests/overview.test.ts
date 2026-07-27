import { describe, expect, it } from "vitest";

import { mergeDailySeries, portfolioTotals, rankOpportunities } from "../lib/overview";
import type { SignalEntry } from "../lib/analysis/signals";
import type { SiteSummary } from "../lib/portfolio";

function entry(overrides: Partial<SignalEntry> & { query: string }): SignalEntry {
  return {
    impressions: 10,
    clicks: 0,
    position: 15,
    ctr: 0,
    impressionsDelta: null,
    positionDelta: null,
    score: 100,
    ...overrides,
  };
}

function summary(overrides: Partial<SiteSummary>): SiteSummary {
  return {
    config: { property: "p", slug: "s", displayName: "S", brandToken: "s" },
    dataState: "ok",
    clicks: { recent: 0, prior: 0, deltaPct: null },
    avgPosition: null,
    sparkline: [],
    nonBrandCount: 0,
    cwv: { verdict: "none", lcp: null, inp: null, cls: null },
    freshness: { latestDate: null, daysBehind: null, level: "none" },
    ...overrides,
  } as SiteSummary;
}

describe("mergeDailySeries", () => {
  it("sums across sites for a date every site collected", () => {
    expect(mergeDailySeries([[1, 2], [10, 20]])).toEqual([11, 22]);
  });

  it("keeps a date null only when NO site collected it", () => {
    expect(mergeDailySeries([[null, 5], [null, 7]])).toEqual([null, 12]);
  });

  it("sums the sites that did collect when only some are missing", () => {
    // Treating the missing site as 0 would invent data; treating the whole
    // day as uncollected would erase the site that did report.
    expect(mergeDailySeries([[null, 5], [3, 7]])).toEqual([3, 12]);
  });

  it("preserves a measured zero as 0, distinct from a gap", () => {
    const merged = mergeDailySeries([[0, null], [0, null]]);
    expect(merged[0]).toBe(0);
    expect(merged[1]).toBeNull();
    expect(merged[0]).not.toBe(merged[1]);
  });

  it("returns an empty series when there are no sites", () => {
    expect(mergeDailySeries([])).toEqual([]);
  });
});

describe("portfolioTotals", () => {
  it("sums clicks across sites and computes the delta", () => {
    const totals = portfolioTotals([
      summary({ clicks: { recent: 30, prior: 20, deltaPct: 50 } }),
      summary({ clicks: { recent: 10, prior: 20, deltaPct: -50 } }),
    ]);

    expect(totals.clicks.recent).toBe(40);
    expect(totals.clicks.prior).toBe(40);
    expect(totals.clicks.deltaPct).toBe(0);
  });

  it("reports a null delta when there is no prior baseline", () => {
    const totals = portfolioTotals([
      summary({ clicks: { recent: 30, prior: 0, deltaPct: null } }),
    ]);

    expect(totals.clicks.deltaPct).toBeNull();
  });

  it("counts sites with no data separately from active ones", () => {
    const totals = portfolioTotals([
      summary({ dataState: "ok" }),
      summary({ dataState: "zero" }),
      summary({ dataState: "not-collected" }),
    ]);

    expect(totals.siteCount).toBe(3);
    expect(totals.activeSiteCount).toBe(1);
  });
});

describe("rankOpportunities", () => {
  it("ranks across sites and attributes each entry to its site", () => {
    const ranked = rankOpportunities(
      [
        { slug: "a", name: "Site A", entries: [entry({ query: "low", score: 5 })] },
        { slug: "b", name: "Site B", entries: [entry({ query: "high", score: 500 })] },
      ],
      10
    );

    expect(ranked.map((r) => r.query)).toEqual(["high", "low"]);
    expect(ranked[0].siteName).toBe("Site B");
    expect(ranked[0].siteSlug).toBe("b");
  });

  it("drops zero-score entries rather than listing them", () => {
    // gapToPage1 is 0 for anything already on page 1, so a 0 score means
    // "no upside left", not "a little upside".
    const ranked = rankOpportunities(
      [
        {
          slug: "a",
          name: "Site A",
          entries: [entry({ query: "page-one", score: 0 }), entry({ query: "real", score: 41 })],
        },
      ],
      10
    );

    expect(ranked.map((r) => r.query)).toEqual(["real"]);
  });

  it("applies the limit", () => {
    const entries = Array.from({ length: 20 }, (_, i) =>
      entry({ query: `q${i}`, score: i + 1 })
    );
    const ranked = rankOpportunities([{ slug: "a", name: "A", entries }], 5);

    expect(ranked).toHaveLength(5);
    expect(ranked[0].query).toBe("q19");
  });

  it("returns nothing when every query is already on page 1", () => {
    const ranked = rankOpportunities(
      [{ slug: "a", name: "A", entries: [entry({ query: "brand", score: 0 })] }],
      10
    );

    expect(ranked).toEqual([]);
  });
});
