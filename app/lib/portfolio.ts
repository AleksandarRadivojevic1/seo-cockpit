import type Database from "better-sqlite3";

import type { CwvRow, SiteConfig } from "./db";
import { latestCwv, latestTotalsDate, totalsInRange } from "./db";
import { recentVsPrior, windowBounds } from "./analysis/windows";
import { deriveSignals } from "./analysis/signals";

export type DataState = "ok" | "collecting" | "empty";
export type CwvVerdict = "good" | "needs-work" | "poor" | "none";
export type FreshnessLevel = "fresh" | "stale" | "broken" | "none";

export interface SiteSummary {
  config: SiteConfig;
  dataState: DataState;
  clicks: { recent: number; prior: number; deltaPct: number | null };
  avgPosition: number | null;
  /**
   * Exactly 28 entries, oldest -> newest. A date with a totals_daily row is
   * its click count (a real 0 is measured data); a date with no row is
   * `null` ("not collected") — the two must never share a representation,
   * or a stale collector reads on-screen as a traffic collapse.
   */
  sparkline: (number | null)[];
  strikingCount: number;
  cwv: {
    verdict: CwvVerdict;
    lcp: number | null;
    inp: number | null;
    cls: number | null;
  };
  freshness: {
    latestDate: string | null;
    daysBehind: number | null;
    level: FreshnessLevel;
  };
}

/** Parses a "YYYY-MM-DD" string into a UTC-midnight Date (see lib/analysis/windows.ts). */
function parseISODateUTC(iso: string): Date {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

/** Formats a Date as "YYYY-MM-DD" using its UTC components. */
function formatISODateUTC(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Adds (or subtracts, for negative values) `days` to an ISO date string, in UTC. */
function addDaysUTC(iso: string, days: number): string {
  const date = parseISODateUTC(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return formatISODateUTC(date);
}

/** Whole UTC days from `earlier` to `later` (positive when `later` is after `earlier`). */
function daysBetweenUTC(earlier: string, later: string): number {
  const ms = parseISODateUTC(later).getTime() - parseISODateUTC(earlier).getTime();
  return Math.round(ms / 86_400_000);
}

/**
 * Percentage change from `prior` to `recent` (18.4 means +18.4%), unrounded.
 * Returns null when `prior` is 0 — there is no baseline to compare against.
 */
export function pctDelta(recent: number, prior: number): number | null {
  if (prior === 0) return null;
  return ((recent - prior) / prior) * 100;
}

/**
 * Worst Core Web Vitals verdict across whichever of LCP/INP/CLS are present.
 * A null row, or a row where all three metrics are null, is 'none' — never
 * rendered as "poor".
 */
export function cwvVerdict(row: CwvRow | null): CwvVerdict {
  if (!row) return "none";

  type MeasuredVerdict = "good" | "needs-work" | "poor";
  const verdicts: MeasuredVerdict[] = [];

  if (row.lcp_p75 != null) {
    verdicts.push(row.lcp_p75 <= 2500 ? "good" : row.lcp_p75 <= 4000 ? "needs-work" : "poor");
  }
  if (row.inp_p75 != null) {
    verdicts.push(row.inp_p75 <= 200 ? "good" : row.inp_p75 <= 500 ? "needs-work" : "poor");
  }
  if (row.cls_p75 != null) {
    verdicts.push(row.cls_p75 <= 0.1 ? "good" : row.cls_p75 <= 0.25 ? "needs-work" : "poor");
  }

  if (verdicts.length === 0) return "none";

  const rank: Record<MeasuredVerdict, number> = { good: 0, "needs-work": 1, poor: 2 };
  return verdicts.reduce((worst, v) => (rank[v] > rank[worst] ? v : worst));
}

/**
 * Freshness level from the most recent collected date, relative to `today`.
 * `latestDate === null` (no data ever collected) is its own 'none' state,
 * distinct from 'broken' (data collected once, then the collector died).
 */
export function freshness(latestDate: string | null, today: string): SiteSummary["freshness"] {
  if (latestDate === null) {
    return { latestDate: null, daysBehind: null, level: "none" };
  }

  const daysBehind = daysBetweenUTC(latestDate, today);
  const level: FreshnessLevel = daysBehind <= 4 ? "fresh" : daysBehind <= 9 ? "stale" : "broken";
  return { latestDate, daysBehind, level };
}

/**
 * Exactly one entry per date from `start` to `end` inclusive. A date with a
 * totals_daily row contributes its click count (0 included); a date with no
 * row contributes `null`, never 0 — see the SiteSummary["sparkline"] doc.
 */
function buildSparkline(
  rows: { date: string; clicks: number }[],
  start: string,
  end: string
): (number | null)[] {
  const clicksByDate = new Map(rows.map((r) => [r.date, r.clicks]));
  const sparkline: (number | null)[] = [];
  for (let date = start; date <= end; date = addDaysUTC(date, 1)) {
    sparkline.push(clicksByDate.has(date) ? clicksByDate.get(date)! : null);
  }
  return sparkline;
}

/**
 * Assembles everything the portfolio overview card needs for one site:
 * click totals + trend, impression-weighted avg position, a 28-day
 * sparkline, striking-distance count, CWV verdict, and freshness — all
 * derived from the already-tested lib/db.ts and lib/analysis/* helpers.
 */
export function buildSiteSummary(
  config: SiteConfig,
  asOf: string,
  db?: Database.Database
): SiteSummary {
  const { recentStart, recentEnd, priorStart, priorEnd } = windowBounds(asOf);

  const recentRows = totalsInRange(config.property, recentStart, recentEnd, db);
  const priorRows = totalsInRange(config.property, priorStart, priorEnd, db);

  const recentImpressions = recentRows.reduce((sum, r) => sum + r.impressions, 0);
  const priorImpressions = priorRows.reduce((sum, r) => sum + r.impressions, 0);

  const dataState: DataState =
    recentImpressions === 0 ? "empty" : priorImpressions === 0 ? "collecting" : "ok";

  const recentClicks = recentRows.reduce((sum, r) => sum + r.clicks, 0);
  const priorClicks = priorRows.reduce((sum, r) => sum + r.clicks, 0);
  const deltaPct = dataState === "ok" ? pctDelta(recentClicks, priorClicks) : null;

  const avgPosition =
    recentImpressions > 0
      ? recentRows.reduce((sum, r) => sum + r.position * r.impressions, 0) / recentImpressions
      : null;

  const sparkline = buildSparkline(recentRows, recentStart, recentEnd);

  const { recent, prior } = recentVsPrior(config.property, asOf, db);
  const strikingCount = deriveSignals(recent, prior, config.brandToken).strikingDistance.length;

  const cwvRow = latestCwv(config.property, db);
  const cwv = {
    verdict: cwvVerdict(cwvRow),
    lcp: cwvRow?.lcp_p75 ?? null,
    inp: cwvRow?.inp_p75 ?? null,
    cls: cwvRow?.cls_p75 ?? null,
  };

  const latestDate = latestTotalsDate(config.property, db);

  return {
    config,
    dataState,
    clicks: { recent: recentClicks, prior: priorClicks, deltaPct },
    avgPosition,
    sparkline,
    strikingCount,
    cwv,
    freshness: freshness(latestDate, asOf),
  };
}
