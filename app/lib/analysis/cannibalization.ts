/**
 * Cannibalization detection: queries where a site has more than one page
 * competing, splitting clicks and impressions. Pure logic over the collector's
 * rolling query x page snapshot, applied at render time so the thresholds tune
 * without a re-collect.
 */

/** One row of the query x page snapshot (see lib/db.ts queryPageSnapshot). */
export interface QueryPageRow {
  query: string;
  page: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/** A query is cannibalized when >=2 pages each clear MIN_IMPRESSIONS and the
 *  runner-up (2nd by impressions) holds at least RUNNER_UP_SHARE of the top. */
export const MIN_IMPRESSIONS = 10;
export const RUNNER_UP_SHARE = 0.2;

export interface CompetingPage {
  page: string;
  clicks: number;
  impressions: number;
  position: number;
}

export interface CannibalizedQuery {
  query: string;
  canonical: CompetingPage; // the page that should win (most clicks)
  competitors: CompetingPage[]; // the pages splitting the query
  impressionsAtStake: number; // sum of competitors' impressions
}

export interface CannibalizationBreakdown {
  notCollected: boolean;
  items: CannibalizedQuery[];
}

export function detectCannibalization(rows: QueryPageRow[]): CannibalizedQuery[] {
  const byQuery = new Map<string, CompetingPage[]>();
  for (const r of rows) {
    const list = byQuery.get(r.query) ?? [];
    list.push({
      page: r.page,
      clicks: r.clicks,
      impressions: r.impressions,
      position: r.position,
    });
    byQuery.set(r.query, list);
  }

  const out: CannibalizedQuery[] = [];
  for (const [query, pages] of byQuery) {
    const qualifying = pages.filter((p) => p.impressions >= MIN_IMPRESSIONS);
    if (qualifying.length < 2) continue;

    const byImpr = [...qualifying].sort((a, b) => b.impressions - a.impressions);
    if (byImpr[1].impressions < RUNNER_UP_SHARE * byImpr[0].impressions) continue;

    // canonical = most clicks; tie -> best (lowest) position
    const ranked = [...qualifying].sort(
      (a, b) => b.clicks - a.clicks || a.position - b.position,
    );
    const canonical = ranked[0];
    const competitors = ranked.slice(1);
    const impressionsAtStake = competitors.reduce((s, p) => s + p.impressions, 0);
    out.push({ query, canonical, competitors, impressionsAtStake });
  }

  return out.sort((a, b) => b.impressionsAtStake - a.impressionsAtStake);
}

export function buildCannibalization(
  rows: QueryPageRow[],
): CannibalizationBreakdown {
  if (rows.length === 0) return { notCollected: true, items: [] };
  return { notCollected: false, items: detectCannibalization(rows) };
}
