import type Database from "better-sqlite3";

import { queryRowsInRange } from "../db";
import type { TotalsRow } from "../db";
import { addDaysUTC } from "./windows";

/**
 * NFD-normalizes `s` and strips combining marks (accents/diacritics), so
 * e.g. "čajš" and "cajs" compare equal after folding. Required because real
 * GSC queries arrive in both accented and unaccented spellings, and plain
 * substring matching on the raw strings misses that.
 */
export function foldDiacritics(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * True if `query` contains `brandToken` as a case-insensitive substring once
 * both are diacritic-folded and trimmed/lowercased. Diacritic folding is
 * applied to both sides so a token typed without accents (e.g. "cajs") still
 * matches queries typed with them (e.g. "čajš"), and vice versa.
 */
export function isBrand(query: string, brandToken: string): boolean {
  const foldedQuery = foldDiacritics(query.trim().toLowerCase());
  const foldedToken = foldDiacritics(brandToken.trim().toLowerCase());
  return foldedQuery.includes(foldedToken);
}

/** Per-date, per-segment (brand vs non-brand) click/impression/position totals. */
export interface BrandSeriesEntry {
  date: string;
  brand: { clicks: number; impressions: number; position: number | null };
  nonBrand: { clicks: number; impressions: number; position: number | null };
}

interface SegmentAccumulator {
  clicks: number;
  impressions: number;
  weightedPositionSum: number;
}

function emptySegmentAccumulator(): SegmentAccumulator {
  return { clicks: 0, impressions: 0, weightedPositionSum: 0 };
}

function finalizeSegment(acc: SegmentAccumulator): BrandSeriesEntry["brand"] {
  return {
    clicks: acc.clicks,
    impressions: acc.impressions,
    position: acc.impressions > 0 ? acc.weightedPositionSum / acc.impressions : null,
  };
}

/**
 * Builds a daily brand/non-brand time series for `site` from `query_daily`
 * rows in [start, end].
 *
 * - One entry per date that has at least one query_daily row. Dates with no
 *   rows at all are omitted entirely (never emitted as zeros) -- a day with
 *   no collected data and a day with genuinely zero clicks are different
 *   facts, and conflating them would let a chart draw a false cliff to zero
 *   for uncollected days.
 * - Within an emitted entry, a segment with no impressions that day is
 *   `{ clicks: 0, impressions: 0, position: null }`.
 * - `position` is impression-weighted within that date AND segment:
 *   sum(position * impressions) / sum(impressions) over that segment's
 *   queries for that day; `null` when the segment has no impressions.
 * - Entries are ordered by date ascending (queryRowsInRange already orders
 *   by date, and Map insertion order preserves first-seen date order).
 */
export function brandSeries(
  site: string,
  start: string,
  end: string,
  brandToken: string,
  db?: Database.Database
): BrandSeriesEntry[] {
  const rows = queryRowsInRange(site, start, end, db);

  const byDate = new Map<string, { brand: SegmentAccumulator; nonBrand: SegmentAccumulator }>();

  for (const row of rows) {
    let entry = byDate.get(row.date);
    if (!entry) {
      entry = { brand: emptySegmentAccumulator(), nonBrand: emptySegmentAccumulator() };
      byDate.set(row.date, entry);
    }

    const segment = isBrand(row.query, brandToken) ? entry.brand : entry.nonBrand;
    segment.clicks += row.clicks;
    segment.impressions += row.impressions;
    segment.weightedPositionSum += row.position * row.impressions;
  }

  const result: BrandSeriesEntry[] = [];
  for (const [date, entry] of byDate) {
    result.push({
      date,
      brand: finalizeSegment(entry.brand),
      nonBrand: finalizeSegment(entry.nonBrand),
    });
  }
  result.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return result;
}

/**
 * One entry per calendar day, splitting the day's impressions into the three
 * groups that actually exist: queries carrying the brand token, queries that
 * do not, and impressions Google never attributed to any query at all.
 *
 * **Why the third band is not optional.** `brandSeries` reads `query_daily`,
 * and GSC withholds the query for rare searches — so brand + non-brand is
 * systematically *less* than `totals_daily`, by 74.9% on optika-cajs and
 * 47.1% on skedio (measured 2026-07-27). Charting only the two attributed
 * bands would draw a quarter of the site's real traffic and read as a
 * collapse; the missing three quarters are not absent, merely unlabelled.
 * With the third band the stack's height equals the impressions line exactly,
 * so this chart and the trend chart above it cannot appear to disagree.
 *
 * The gap is genuinely Google's and not our own truncation: `gsc.py` caps
 * `query_daily` at 500 rows per day and the busiest real day holds 4.
 *
 * `null` on every field means the day was never collected and the stack must
 * break, exactly as `buildTrendSeries` does. A day that WAS collected and
 * attributed nothing is three real zeros — the distinction this project has
 * now got wrong four times.
 */
export interface BrandBandPoint {
  date: string;
  brand: number | null;
  nonBrand: number | null;
  /** `total − (brand + nonBrand)`: impressions Google did not attribute. */
  anonymized: number | null;
  total: number | null;
  // The vendored chart's data prop is Record<string, unknown>[].
  [key: string]: unknown;
}

export function buildBrandBandSeries(
  totals: TotalsRow[],
  brand: BrandSeriesEntry[],
  start: string,
  end: string
): BrandBandPoint[] {
  const totalsByDate = new Map(totals.map((row) => [row.date, row]));
  const brandByDate = new Map(brand.map((entry) => [entry.date, entry]));

  const series: BrandBandPoint[] = [];
  for (let date = start; date <= end; date = addDaysUTC(date, 1)) {
    const row = totalsByDate.get(date);
    if (!row) {
      // No totals row: the day was not collected. Query rows alone would
      // fabricate a total, so they are deliberately ignored here.
      series.push({ date, brand: null, nonBrand: null, anonymized: null, total: null });
      continue;
    }

    const split = brandByDate.get(date);
    const brandImpressions = split ? split.brand.impressions : 0;
    const nonBrandImpressions = split ? split.nonBrand.impressions : 0;
    series.push({
      date,
      brand: brandImpressions,
      nonBrand: nonBrandImpressions,
      // Clamped: a negative band would render as an inverted area and
      // silently break the "bands sum to the total" guarantee.
      anonymized: Math.max(0, row.impressions - brandImpressions - nonBrandImpressions),
      total: row.impressions,
    });
  }
  return series;
}
