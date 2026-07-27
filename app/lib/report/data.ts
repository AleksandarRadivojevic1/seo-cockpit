import type Database from "better-sqlite3";

import { buildBrandBreakdown, topPages } from "../analysis/breakdown";
import { buildDemandBreakdown } from "../analysis/demand";
import { ownDomainFor, rankCompetitors, serpState } from "../analysis/serp";
import { deriveSignals } from "../analysis/signals";
import { addDaysUTC, recentVsPrior, windowBounds } from "../analysis/windows";
import {
  demandKeywords,
  getDb,
  latestCwv,
  pageRowsInRange,
  queryRowsInRange,
  serpChecks,
  totalsInRange,
} from "../db";
import type { CwvRow, SiteConfig } from "../db";
import { buildSiteSummary } from "../portfolio";
import type { DataState } from "../portfolio";
import type { BrandBreakdown, PageTotal } from "../analysis/breakdown";
import type { DemandBreakdown } from "../analysis/demand";
import type { DomainTally, SerpState } from "../analysis/serp";
import type { SignalEntry } from "../analysis/signals";

/** Rows carried into a client-facing document — findings, not a data dump. */
export const REPORT_LIMIT = 10;

export interface TrendPointSr {
  date: string;
  /** `null` = no row collected for this date. A real `0` is a measured zero. */
  impressions: number | null;
  clicks: number | null;
}

export interface ReportData {
  siteName: string;
  property: string;
  /** The nominal 28-day window the signals were derived over. */
  window: { start: string; end: string };
  /** The dates actually present in `totals_daily`, which may be a shorter span. */
  measuredStart: string | null;
  measuredEnd: string | null;
  measuredDays: number;
  /**
   * False when nothing at all was collected before the recent window.
   * Distinct from a flat comparison: the report must say "no prior period"
   * rather than printing a fabricated 0%.
   */
  hasPriorWindow: boolean;
  dataState: DataState;
  clicks: { recent: number; prior: number; deltaPct: number | null };
  impressions: number;
  avgPosition: number | null;
  breakdown: BrandBreakdown;
  opportunities: SignalEntry[];
  rising: SignalEntry[];
  declining: SignalEntry[];
  topPages: PageTotal[];
  trend: TrendPointSr[];
  demand: DemandBreakdown;
  competitors: DomainTally[];
  serpState: SerpState;
  cwv: CwvRow | null;
}

/**
 * Every fact the Serbian client report and the English internal proposal
 * both quote.
 *
 * T12 kept the proposal page honest by rendering the page and its copy
 * button from one serialized string, so a client document could never
 * disagree with the screen. A styled Serbian document cannot share a string
 * with an English Markdown blob, so the shared source moved down a layer to
 * this function: neither route can quote a number the other lacks.
 */
export function buildReportData(
  config: SiteConfig,
  asOf: string,
  db: Database.Database = getDb()
): ReportData {
  const summary = buildSiteSummary(config, asOf, db);
  const { recentStart, recentEnd, priorStart, priorEnd } = windowBounds(asOf);
  const rows = totalsInRange(config.property, recentStart, recentEnd, db);
  const { recent, prior } = recentVsPrior(config.property, asOf, db);
  const signals = deriveSignals(recent, prior, config.brandToken);

  const totalImpressions = rows.reduce((sum, r) => sum + r.impressions, 0);
  const weighted = rows.reduce((sum, r) => sum + r.position * r.impressions, 0);

  // What was actually collected, which is not the same as the window asked
  // for. Rows arrive ordered by date, but sort anyway rather than depend on
  // a caller's ORDER BY for a claim printed in a client's document header.
  const dates = rows.map((r) => r.date).sort();
  const measuredStart = dates.length > 0 ? dates[0] : null;
  const measuredEnd = dates.length > 0 ? dates[dates.length - 1] : null;

  // A prior window exists only if a row predates the recent window. An
  // empty prior is not a flat delta — see ReportData.hasPriorWindow.
  const hasPriorWindow =
    totalsInRange(config.property, priorStart, priorEnd, db).length > 0;

  const byDate = new Map(rows.map((r) => [r.date, r]));
  const trend: TrendPointSr[] = [];
  if (measuredStart && measuredEnd) {
    for (let d = measuredStart; d <= measuredEnd; d = addDaysUTC(d, 1)) {
      const row = byDate.get(d);
      trend.push({
        date: d,
        impressions: row ? row.impressions : null,
        clicks: row ? row.clicks : null,
      });
    }
  }

  const checks = serpChecks(config.property, db);

  return {
    siteName: config.displayName,
    property: config.property,
    window: { start: recentStart, end: recentEnd },
    measuredStart,
    measuredEnd,
    measuredDays: rows.length,
    hasPriorWindow,
    dataState: summary.dataState,
    clicks: {
      recent: summary.clicks.recent,
      prior: summary.clicks.prior,
      deltaPct: hasPriorWindow ? summary.clicks.deltaPct : null,
    },
    impressions: totalImpressions,
    avgPosition: totalImpressions > 0 ? weighted / totalImpressions : null,
    breakdown: buildBrandBreakdown(
      signals.brandSplit.brand.impressions,
      signals.brandSplit.nonBrand.impressions,
      totalImpressions
    ),
    // Same rule as the overview's opportunity list: non-brand queries with
    // upside remaining. A client document's most important section must not
    // list the client's own name back at them as an "opportunity".
    opportunities: signals.nonBrandQueries.filter((e) => e.score > 0).slice(0, REPORT_LIMIT),
    rising: signals.rising,
    declining: signals.declining,
    topPages: topPages(
      pageRowsInRange(config.property, recentStart, recentEnd, db),
      REPORT_LIMIT
    ),
    trend,
    demand: buildDemandBreakdown(
      demandKeywords(config.property, db),
      // Compared against every query ever seen, not the trailing window: a
      // keyword ranked for six months ago is not an undiscovered gap.
      queryRowsInRange(config.property, "0000-01-01", recentEnd, db).map((r) => r.query)
    ),
    competitors: rankCompetitors(checks, ownDomainFor(config.property)),
    serpState: serpState(checks),
    cwv: latestCwv(config.property, db),
  };
}
