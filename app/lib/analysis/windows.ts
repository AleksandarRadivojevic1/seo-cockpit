import type Database from "better-sqlite3";

import type { QueryRow } from "../db";
import { queryRowsInRange } from "../db";

/** Per-query totals aggregated over a date window. */
export interface AggregatedQuery {
  impressions: number;
  clicks: number;
  /**
   * Impression-weighted average position across the window:
   * sum(position_i * impressions_i) / sum(impressions_i).
   *
   * Edge case: if the query's total impressions across the window is 0
   * (all rows had impressions=0), the weighted average is undefined, so
   * we fall back to the plain arithmetic mean of the raw position values
   * instead (and to 0 if there were somehow no rows at all).
   */
  position: number;
}

/** Days between the "as of" date and the end of the recent window (freshness lag for GSC data). */
export const LAG_DAYS = 3;
/** Width, in days, of each comparison window (recent and prior). */
export const WINDOW_DAYS = 28;

/**
 * Groups query rows by `query` and sums impressions/clicks, computing the
 * impression-weighted average position per query (see AggregatedQuery).
 */
export function aggregateWindow(rows: QueryRow[]): Map<string, AggregatedQuery> {
  interface Accumulator {
    impressions: number;
    clicks: number;
    weightedPositionSum: number;
    positionSum: number;
    rowCount: number;
  }

  const accumulators = new Map<string, Accumulator>();

  for (const row of rows) {
    let acc = accumulators.get(row.query);
    if (!acc) {
      acc = { impressions: 0, clicks: 0, weightedPositionSum: 0, positionSum: 0, rowCount: 0 };
      accumulators.set(row.query, acc);
    }
    acc.impressions += row.impressions;
    acc.clicks += row.clicks;
    acc.weightedPositionSum += row.position * row.impressions;
    acc.positionSum += row.position;
    acc.rowCount += 1;
  }

  const result = new Map<string, AggregatedQuery>();
  for (const [query, acc] of accumulators) {
    const position =
      acc.impressions > 0
        ? acc.weightedPositionSum / acc.impressions
        : acc.rowCount > 0
          ? acc.positionSum / acc.rowCount
          : 0;
    result.set(query, { impressions: acc.impressions, clicks: acc.clicks, position });
  }
  return result;
}

/** Parses a "YYYY-MM-DD" string into a UTC-midnight Date. */
export function parseISODateUTC(iso: string): Date {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

/** Formats a Date as "YYYY-MM-DD" using its UTC components. */
export function formatISODateUTC(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Adds (or subtracts, for negative values) `days` to an ISO date string, in UTC. */
export function addDaysUTC(iso: string, days: number): string {
  const date = parseISODateUTC(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return formatISODateUTC(date);
}

/**
 * Computes the recent and prior comparison windows for a given "as of" date.
 *
 * - recentEnd   = asOf - LAG_DAYS
 * - recentStart = recentEnd - (WINDOW_DAYS - 1)   (28-day inclusive window)
 * - priorEnd    = recentStart - 1
 * - priorStart  = priorEnd - (WINDOW_DAYS - 1)     (28-day inclusive window, contiguous with recent)
 *
 * All math is done in UTC to avoid timezone drift.
 *
 * Example: asOf="2026-07-31" -> recent 2026-07-01..2026-07-28, prior 2026-06-03..2026-06-30.
 */
export function windowBounds(asOf: string): {
  recentStart: string;
  recentEnd: string;
  priorStart: string;
  priorEnd: string;
} {
  const recentEnd = addDaysUTC(asOf, -LAG_DAYS);
  const recentStart = addDaysUTC(recentEnd, -(WINDOW_DAYS - 1));
  const priorEnd = addDaysUTC(recentStart, -1);
  const priorStart = addDaysUTC(priorEnd, -(WINDOW_DAYS - 1));
  return { recentStart, recentEnd, priorStart, priorEnd };
}

/**
 * Fetches and aggregates query rows for `site` into the recent and prior
 * 28-day comparison windows relative to `asOf` (see windowBounds).
 */
export function recentVsPrior(
  site: string,
  asOf: string,
  db?: Database.Database
): { recent: Map<string, AggregatedQuery>; prior: Map<string, AggregatedQuery> } {
  const { recentStart, recentEnd, priorStart, priorEnd } = windowBounds(asOf);
  const recent = aggregateWindow(queryRowsInRange(site, recentStart, recentEnd, db));
  const prior = aggregateWindow(queryRowsInRange(site, priorStart, priorEnd, db));
  return { recent, prior };
}
