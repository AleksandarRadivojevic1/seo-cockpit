import type { AggregatedQuery } from "./windows";

/**
 * Opportunity score for a query row: how much upside remains in pushing it
 * onto (or further up) page 1.
 *
 *   score = impressions × gapToPage1 × (1 − ctr)
 *
 * where:
 *   - ctr = clicks / impressions (0 if impressions is 0)
 *   - gapToPage1 = max(0, position − 10)
 *
 * `gapToPage1` is this controller's chosen reading of the brief's
 * "gap to page 1": positions already on page 1 (≤10) have zero gap and
 * therefore score 0 — the metric is deliberately built to surface
 * off-page-1 keywords (positions 11+) rather than to rank page-1 queries
 * against each other.
 */
export function opportunityScore(row: AggregatedQuery): number {
  const ctr = row.impressions > 0 ? row.clicks / row.impressions : 0;
  const gapToPage1 = Math.max(0, row.position - 10);
  return row.impressions * gapToPage1 * (1 - ctr);
}
