import type Database from "better-sqlite3";

import { queryRowsInRange } from "../db";

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
