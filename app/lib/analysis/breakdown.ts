import type { PageRow } from "../db";

export interface PageTotal {
  page: string;
  clicks: number;
  impressions: number;
  /** Impression-weighted, matching how positions are averaged everywhere else. */
  position: number;
}

export interface BrandBreakdown {
  brandImpressions: number;
  nonBrandImpressions: number;
  /**
   * Impressions GSC counted in the site total but never attributed to a
   * named query. Not a rounding error — see `buildBrandBreakdown`.
   */
  anonymizedImpressions: number;
  totalImpressions: number;
}

/**
 * Aggregates per-day page rows into per-page totals, ranked by impressions.
 *
 * Position is impression-weighted rather than a plain mean: a page that
 * ranked 3rd on a day with 200 impressions and 40th on a day with 2 should
 * not average to 21.5.
 */
export function topPages(rows: PageRow[], limit: number): PageTotal[] {
  const byPage = new Map<string, { clicks: number; impressions: number; weighted: number }>();

  for (const row of rows) {
    const entry = byPage.get(row.page) ?? { clicks: 0, impressions: 0, weighted: 0 };
    entry.clicks += row.clicks;
    entry.impressions += row.impressions;
    entry.weighted += row.position * row.impressions;
    byPage.set(row.page, entry);
  }

  return [...byPage.entries()]
    .map(([page, e]) => ({
      page,
      clicks: e.clicks,
      impressions: e.impressions,
      position: e.impressions > 0 ? e.weighted / e.impressions : 0,
    }))
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, limit);
}

/**
 * Splits a window's impressions into brand, non-brand, and anonymized.
 *
 * GSC withholds the query for rare searches, so summing `query_daily` gives
 * materially less than `totals_daily` — measured on real data, 52 of Optika
 * Cajs's 212 impressions are attributable, leaving 75% unnamed. A two-slice
 * brand/non-brand chart would present that 75% as though it did not exist,
 * or silently rescale the two known slices to fill the circle. Both are
 * lies about the data, so the remainder is a first-class third segment.
 *
 * Clamped at zero: the two sources are separate GSC queries and could in
 * principle disagree, and a negative segment would be meaningless.
 */
export function buildBrandBreakdown(
  brandImpressions: number,
  nonBrandImpressions: number,
  totalImpressions: number
): BrandBreakdown {
  const named = brandImpressions + nonBrandImpressions;
  return {
    brandImpressions,
    nonBrandImpressions,
    anonymizedImpressions: Math.max(0, totalImpressions - named),
    totalImpressions: Math.max(totalImpressions, named),
  };
}
