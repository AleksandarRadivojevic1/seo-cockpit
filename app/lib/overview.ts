import type { SignalEntry } from "./analysis/signals";
import type { SiteSummary } from "./portfolio";

export interface PortfolioTotals {
  clicks: { recent: number; prior: number; deltaPct: number | null };
  siteCount: number;
  /** Sites currently contributing any recent-window clicks or impressions. */
  activeSiteCount: number;
}

export interface OpportunityEntry extends SignalEntry {
  siteSlug: string;
  siteName: string;
}

/**
 * Merges per-site daily click series into one portfolio series.
 *
 * The null rule is the whole reason this is a function rather than a
 * `reduce` inline: a date is `null` ONLY when no site has a row for it. If
 * even one site collected that day, the portfolio value is the sum of the
 * sites that did — treating the others as 0 there would be a guess, but
 * treating the whole day as uncollected would erase real data. Summing
 * nulls as zeros is what makes a stale collector look like a traffic
 * collapse, which is the failure this project keeps guarding against.
 *
 * Every input series must already be aligned to the same 28 dates (they
 * are — `buildSiteSummary` builds them from one shared window).
 */
export function mergeDailySeries(seriesPerSite: (number | null)[][]): (number | null)[] {
  if (seriesPerSite.length === 0) return [];

  const length = seriesPerSite[0].length;
  const merged: (number | null)[] = [];

  for (let i = 0; i < length; i++) {
    let sum = 0;
    let anyCollected = false;
    for (const series of seriesPerSite) {
      const value = series[i];
      if (typeof value === "number") {
        sum += value;
        anyCollected = true;
      }
    }
    merged.push(anyCollected ? sum : null);
  }

  return merged;
}

/** Percentage change from `prior` to `recent`; null when there is no baseline. */
function deltaPct(recent: number, prior: number): number | null {
  if (prior === 0) return null;
  return ((recent - prior) / prior) * 100;
}

/** Portfolio-wide click totals and how many sites are actually producing. */
export function portfolioTotals(summaries: SiteSummary[]): PortfolioTotals {
  const recent = summaries.reduce((sum, s) => sum + s.clicks.recent, 0);
  const prior = summaries.reduce((sum, s) => sum + s.clicks.prior, 0);

  return {
    clicks: { recent, prior, deltaPct: deltaPct(recent, prior) },
    siteCount: summaries.length,
    // 'ok' and 'collecting' both mean the site returned data this window;
    // 'zero' and 'not-collected' do not, and are different from each other
    // but identical for this count.
    activeSiteCount: summaries.filter(
      (s) => s.dataState === "ok" || s.dataState === "collecting"
    ).length,
  };
}

/**
 * Ranks queries across every site by opportunity score.
 *
 * Callers pass `signals.nonBrandQueries`, so brand terms never appear here:
 * "you rank second for your own company name" is not an opportunity.
 *
 * Entries scoring 0 are dropped rather than listed: `gapToPage1` is 0 for
 * anything already on page 1, so a zero score means "no upside from
 * ranking higher", not "small upside". The per-site table keeps those rows
 * (ranking already is worth seeing); a cross-site *opportunity* list does not.
 */
export function rankOpportunities(
  perSite: { slug: string; name: string; entries: SignalEntry[] }[],
  limit: number
): OpportunityEntry[] {
  return perSite
    .flatMap(({ slug, name, entries }) =>
      entries.map((entry) => ({ ...entry, siteSlug: slug, siteName: name }))
    )
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
