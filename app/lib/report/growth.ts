import { addDaysUTC, parseISODateUTC } from "../analysis/windows";
import type { TotalsRow } from "../db";

/** The before/after window length. A month reads as "the start vs now" to a
 *  client, and two of them is the smallest span that is a comparison rather
 *  than noise. */
export const GROWTH_WINDOW_DAYS = 30;

export interface GrowthMetric {
  before: number;
  after: number;
  /**
   * Percent change, or `null` when the baseline is zero. Growth from nothing
   * has no meaningful percentage; the report shows the before→after pair
   * instead of a fabricated or infinite number.
   */
  deltaPct: number | null;
}

export interface GrowthResult {
  beforeStart: string;
  beforeEnd: string;
  afterStart: string;
  afterEnd: string;
  /** Inclusive calendar span from the first collected day to the last — how
   *  long the work has been running, which is the client's "vreme". */
  durationDays: number;
  clicks: GrowthMetric;
  impressions: GrowthMetric;
  /**
   * Weighted average position in each window; lower is better. Deliberately
   * carries no percentage — a position is shown as before→after, because a
   * "−60%" on a rank that improved from 12 to 5 reads as a loss.
   * `null` when a window collected no impressions to weight.
   */
  position: { before: number | null; after: number | null };
}

/** Inclusive day count between two ISO dates, e.g. same day = 1. */
function daysInclusive(startISO: string, endISO: string): number {
  const ms = parseISODateUTC(endISO).getTime() - parseISODateUTC(startISO).getTime();
  return Math.round(ms / 86_400_000) + 1;
}

function windowMetrics(rows: TotalsRow[], start: string, end: string) {
  let clicks = 0;
  let impressions = 0;
  let weightedPosition = 0;
  for (const r of rows) {
    if (r.date >= start && r.date <= end) {
      clicks += r.clicks;
      impressions += r.impressions;
      weightedPosition += r.position * r.impressions;
    }
  }
  return {
    clicks,
    impressions,
    position: impressions > 0 ? weightedPosition / impressions : null,
  };
}

function pctChange(before: number, after: number): number | null {
  return before > 0 ? ((after - before) / before) * 100 : null;
}

/**
 * The engagement-long growth story: the first `windowDays` of collected data
 * (the baseline when the work began) against the last `windowDays` (now).
 *
 * Adaptive by design — the baseline sits at the start of whatever history
 * exists, not a fixed months-ago point, so a two-month client and a
 * six-month client each get an honest before/after. Returns `null` when the
 * history cannot hold two non-overlapping windows: a trend invented over
 * three weeks of data is exactly the null-vs-zero dishonesty this project
 * keeps relearning.
 *
 * Windows are cut by date, not by row count, so gaps (uncollected days)
 * shrink a window's totals rather than pulling in rows from outside it.
 */
export function computeGrowth(
  rows: TotalsRow[],
  windowDays: number = GROWTH_WINDOW_DAYS
): GrowthResult | null {
  if (rows.length === 0) return null;

  const dates = rows.map((r) => r.date).sort();
  const first = dates[0];
  const last = dates[dates.length - 1];
  const durationDays = daysInclusive(first, last);
  if (durationDays < windowDays * 2) return null;

  const beforeStart = first;
  const beforeEnd = addDaysUTC(first, windowDays - 1);
  const afterEnd = last;
  const afterStart = addDaysUTC(last, -(windowDays - 1));

  const before = windowMetrics(rows, beforeStart, beforeEnd);
  const after = windowMetrics(rows, afterStart, afterEnd);

  return {
    beforeStart,
    beforeEnd,
    afterStart,
    afterEnd,
    durationDays,
    clicks: { before: before.clicks, after: after.clicks, deltaPct: pctChange(before.clicks, after.clicks) },
    impressions: {
      before: before.impressions,
      after: after.impressions,
      deltaPct: pctChange(before.impressions, after.impressions),
    },
    position: { before: before.position, after: after.position },
  };
}
