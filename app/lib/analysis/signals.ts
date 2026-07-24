import type { AggregatedQuery } from "./windows";
import { opportunityScore } from "./score";

/** Drop single-impression one-offs: recent-window impressions below this are noise. */
export const NOISE_FLOOR_IMPRESSIONS = 2;
/** Minimum recent−prior impressions increase to count as "rising" (also used, negated, for "declining" impression drops). */
export const RISING_MIN_DELTA = 10;
/** Minimum position change (spots) for a query to count as "climbing" or "declining". */
export const POSITION_MOVE_MIN = 3;
/** Inclusive lower bound of the "striking distance" position band. */
export const STRIKING_MIN_POS = 8;
/** Inclusive upper bound of the "striking distance" position band. */
export const STRIKING_MAX_POS = 20;
/** Cap on the number of entries returned per signal list. */
export const TOP_N = 50;

export interface SignalEntry {
  query: string;
  impressions: number; // recent-window impressions
  clicks: number; // recent
  position: number; // recent (impression-weighted)
  ctr: number; // recent clicks/impressions (0 if impressions 0)
  impressionsDelta: number | null; // recent−prior (null if not in prior, i.e. emerging)
  positionDelta: number | null; // prior.position − recent.position (POSITIVE = improved/moved up); null if emerging
  score: number; // opportunityScore(recent)
}

export interface BrandTotals {
  impressions: number;
  clicks: number;
}

export interface BrandSplit {
  brand: BrandTotals; // recent-window brand totals
  nonBrand: BrandTotals; // recent-window non-brand totals
  nonBrandImpressionsDelta: number; // recent nonBrand impr − prior nonBrand impr (the "non-brand growth" SEO-progress metric)
}

export interface Signals {
  emerging: SignalEntry[];
  rising: SignalEntry[];
  climbing: SignalEntry[];
  declining: SignalEntry[];
  strikingDistance: SignalEntry[];
  brandSplit: BrandSplit;
}

function ctrOf(row: AggregatedQuery): number {
  return row.impressions > 0 ? row.clicks / row.impressions : 0;
}

function toEntry(
  query: string,
  recentRow: AggregatedQuery,
  priorRow: AggregatedQuery | undefined
): SignalEntry {
  const impressionsDelta = priorRow ? recentRow.impressions - priorRow.impressions : null;
  const positionDelta = priorRow ? priorRow.position - recentRow.position : null;
  return {
    query,
    impressions: recentRow.impressions,
    clicks: recentRow.clicks,
    position: recentRow.position,
    ctr: ctrOf(recentRow),
    impressionsDelta,
    positionDelta,
    score: opportunityScore(recentRow),
  };
}

/** True if `query` contains `brandToken` as a case-insensitive substring (both trimmed/lowercased). */
function isBrand(query: string, brandToken: string): boolean {
  return query.trim().toLowerCase().includes(brandToken.trim().toLowerCase());
}

/**
 * Derives all opportunity/movement signals from a recent-vs-prior window pair.
 *
 * The NOISE_FLOOR_IMPRESSIONS floor is applied to recent-window presence for
 * every signal *list* (emerging/rising/climbing/declining/strikingDistance) —
 * a query with fewer than NOISE_FLOOR_IMPRESSIONS recent impressions is
 * dropped from all of them. brandSplit is a totals metric over the whole
 * window and deliberately does NOT apply the noise floor, so every query
 * (including single-impression ones) contributes to the brand/non-brand
 * sums.
 */
export function deriveSignals(
  recent: Map<string, AggregatedQuery>,
  prior: Map<string, AggregatedQuery>,
  brandToken: string
): Signals {
  const emerging: SignalEntry[] = [];
  const rising: SignalEntry[] = [];
  const climbing: SignalEntry[] = [];
  const declining: SignalEntry[] = [];
  const strikingDistance: SignalEntry[] = [];

  for (const [query, recentRow] of recent) {
    if (recentRow.impressions < NOISE_FLOOR_IMPRESSIONS) continue;

    const priorRow = prior.get(query);

    if (!priorRow) {
      emerging.push(toEntry(query, recentRow, undefined));
    } else {
      const entry = toEntry(query, recentRow, priorRow);
      const impressionsDelta = entry.impressionsDelta as number;
      const positionDelta = entry.positionDelta as number;

      if (impressionsDelta >= RISING_MIN_DELTA) {
        rising.push(entry);
      }
      if (positionDelta >= POSITION_MOVE_MIN) {
        climbing.push(entry);
      }
      if (impressionsDelta <= -RISING_MIN_DELTA || positionDelta <= -POSITION_MOVE_MIN) {
        declining.push(entry);
      }
    }

    if (recentRow.position >= STRIKING_MIN_POS && recentRow.position <= STRIKING_MAX_POS) {
      strikingDistance.push(toEntry(query, recentRow, priorRow));
    }
  }

  emerging.sort((a, b) => b.impressions - a.impressions);
  rising.sort((a, b) => (b.impressionsDelta as number) - (a.impressionsDelta as number));
  climbing.sort((a, b) => (b.positionDelta as number) - (a.positionDelta as number));
  // "Worst first": biggest impression drop first, then biggest position worsening as tiebreaker
  // (both impressionsDelta and positionDelta are more negative the worse things got).
  declining.sort((a, b) => {
    const impressionsDiff = (a.impressionsDelta as number) - (b.impressionsDelta as number);
    if (impressionsDiff !== 0) return impressionsDiff;
    return (a.positionDelta as number) - (b.positionDelta as number);
  });
  strikingDistance.sort((a, b) => b.score - a.score);

  const brand: BrandTotals = { impressions: 0, clicks: 0 };
  const nonBrand: BrandTotals = { impressions: 0, clicks: 0 };
  let priorNonBrandImpressions = 0;

  for (const [query, row] of recent) {
    if (isBrand(query, brandToken)) {
      brand.impressions += row.impressions;
      brand.clicks += row.clicks;
    } else {
      nonBrand.impressions += row.impressions;
      nonBrand.clicks += row.clicks;
    }
  }

  for (const [query, row] of prior) {
    if (!isBrand(query, brandToken)) {
      priorNonBrandImpressions += row.impressions;
    }
  }

  const brandSplit: BrandSplit = {
    brand,
    nonBrand,
    nonBrandImpressionsDelta: nonBrand.impressions - priorNonBrandImpressions,
  };

  return {
    emerging: emerging.slice(0, TOP_N),
    rising: rising.slice(0, TOP_N),
    climbing: climbing.slice(0, TOP_N),
    declining: declining.slice(0, TOP_N),
    strikingDistance: strikingDistance.slice(0, TOP_N),
    brandSplit,
  };
}
