import type Database from "better-sqlite3";

import { buildCannibalization } from "./analysis/cannibalization";
import type { CannibalizedQuery } from "./analysis/cannibalization";
import type { DemandGap, DemandIntent } from "./analysis/demand";
import type { DomainTally, SerpState } from "./analysis/serp";
import { foldDiacritics } from "./analysis/brand";
import { deriveSignals, toEntry } from "./analysis/signals";
import type { SignalEntry } from "./analysis/signals";
import { recentVsPrior } from "./analysis/windows";
import type { AggregatedQuery } from "./analysis/windows";
import { getDb, latestCwv, queryPageSnapshot, siteLanguage } from "./db";
import type { SiteConfig } from "./db";
import type { DataState } from "./portfolio";
import { buildReportData } from "./report/data";
import type { GrowthResult } from "./report/growth";
import type { ReportLanguage } from "./report/language";

/**
 * A compact, self-describing JSON digest of one site, for LLM agents.
 *
 * WHY THIS EXISTS. Agents must not re-derive findings from the raw tables:
 * that costs tokens on every run, and an agent's arithmetic would drift from
 * the dashboard's. So the digest is built from `buildReportData` -- the same
 * function the Serbian client report and the English proposal render from --
 * plus the three things those documents leave out (emerging and climbing
 * queries, cannibalization, CWV). An agent quoting this digest therefore
 * cannot cite a number the dashboard does not show.
 *
 * Read-only like the rest of the dashboard. Agents write their output to
 * their own ticket system, never to seo.db: the collector stays its only
 * writer.
 *
 * Caps keep a site's digest to a few thousand tokens. Raise them here, not
 * in an agent prompt, so every agent reads the same view.
 */
export const DIGEST_VERSION = 1;

export const DIGEST_LIMITS = {
  opportunities: 15,
  signal: 10,
  demandGaps: 30,
  cannibalization: 5,
  competitors: 5,
  topPages: 10,
  /** Queries one request may track; more is a sign the caller wants a data dump. */
  tracked: 20,
} as const;

/**
 * Travels with the data, so an agent reading a digest out of context still
 * gets the rules. Each line is a mistake the dashboard already refuses to make.
 */
export const DIGEST_SEMANTICS: readonly string[] = [
  "null means NOT MEASURED. It is never zero. Never write a null as 0, 'none' or 'flat'.",
  "Windows: 'recent' is the last 28 days ending 3 days ago (GSC lag); 'prior' is the 28 days before it.",
  "position: impression-weighted average rank, lower is better. positionDelta > 0 means the query moved UP.",
  "opportunities: non-brand queries off page 1, ranked by score = impressions x (position - 10) x (1 - ctr). Page-1 queries score 0 by design.",
  "demandGaps: keywords discovered from Google autocomplete / Trends that the site has never appeared for in GSC. There is no search volume unless 'volume' is a number; suggestRank is Google's suggestion order, a weak popularity hint, not a volume.",
  "risingLabel 'Breakout' means Google Trends withheld a percentage because growth was off-scale: it is the strongest rising signal.",
  "competitors come from metered SerpApi checks at one point in time; serpState 'not-checked' means no check has run, not that nobody ranks.",
  "Brand queries contain the site's brandToken. Non-brand growth is the real measure of SEO progress.",
  "tracked: queries the caller asked about by name, reported whatever their rank. inRecentWindow false means GSC recorded no impressions for it in the recent window.",
];

export interface DigestQuery {
  query: string;
  position: number;
  impressions: number;
  clicks: number;
  ctr: number;
  /** recent - prior impressions; null when the query is new (emerging). */
  impressionsDelta: number | null;
  /** prior - recent position, POSITIVE = improved; null when emerging. */
  positionDelta: number | null;
  score: number;
}

export interface DigestGap {
  keyword: string;
  intent: DemandIntent;
  source: string;
  suggestRank: number | null;
  risingPct: number | null;
  risingLabel: string | null;
  volume: number | null;
}

/**
 * One query looked up by name. Exists because the top-N lists drop a query
 * the moment it succeeds: a fix that lifts it onto page 1 takes its score to
 * zero and it leaves `opportunities`. Checking whether shipped work paid off
 * needs the query itself, not whatever the lists still contain.
 */
export interface TrackedQuery {
  /** As requested. `entry.query` holds the spelling GSC actually recorded. */
  requested: string;
  inRecentWindow: boolean;
  entry: DigestQuery | null;
}

export interface AgentDigest {
  version: typeof DIGEST_VERSION;
  asOf: string;
  semantics: readonly string[];
  /** `language` is the client's: write anything client-facing in it. */
  site: {
    slug: string;
    name: string;
    property: string;
    brandToken: string;
    language: ReportLanguage;
  };
  window: {
    start: string;
    end: string;
    measuredStart: string | null;
    measuredEnd: string | null;
    measuredDays: number;
    hasPriorWindow: boolean;
  };
  dataState: DataState;
  totals: {
    clicks: { recent: number; prior: number; deltaPct: number | null };
    impressions: number;
    avgPosition: number | null;
    brandImpressions: number;
    nonBrandImpressions: number;
    anonymizedImpressions: number;
    /** recent - prior non-brand impressions: the SEO-progress number. */
    nonBrandImpressionsDelta: number;
    /** Non-brand queries the site ranks for at all, past the noise floor. */
    nonBrandQueryCount: number;
  };
  opportunities: DigestQuery[];
  rising: DigestQuery[];
  emerging: DigestQuery[];
  climbing: DigestQuery[];
  declining: DigestQuery[];
  topPages: { page: string; clicks: number; impressions: number; position: number }[];
  demand: {
    notCollected: boolean;
    totalDiscovered: number;
    covered: number;
    gapsByIntent: Record<DemandIntent, number>;
    /** Ordered as the dashboard orders them: rising first, then commercial > local > question > other. */
    gaps: DigestGap[];
  };
  cannibalization: { notCollected: boolean; items: CannibalizedQuery[] };
  serp: { state: SerpState; competitors: DomainTally[] };
  cwv: {
    url: string;
    capturedAt: string;
    source: string | null;
    formFactor: string | null;
    lcpP75: number | null;
    inpP75: number | null;
    clsP75: number | null;
    lighthouse: {
      performance: number | null;
      accessibility: number | null;
      bestPractices: number | null;
      seo: number | null;
    };
  } | null;
  growth: GrowthResult | null;
  tracked: TrackedQuery[];
}

/** Rounds a measurement without ever turning null into a number. */
function round(value: number | null, digits: number): number | null {
  if (value === null) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function toQuery(e: SignalEntry): DigestQuery {
  return {
    query: e.query,
    position: round(e.position, 1) as number,
    impressions: e.impressions,
    clicks: e.clicks,
    ctr: round(e.ctr, 3) as number,
    impressionsDelta: e.impressionsDelta,
    positionDelta: round(e.positionDelta, 1),
    score: Math.round(e.score),
  };
}

function toGap(g: DemandGap): DigestGap {
  return {
    keyword: g.keyword,
    intent: g.intent,
    source: g.source,
    suggestRank: g.suggestRank,
    risingPct: g.risingPct,
    risingLabel: g.risingLabel,
    volume: g.volume,
  };
}

/**
 * Looks each requested query up in the recent window, diacritic-folded the
 * way the dashboard matches demand gaps (Serbian users type both `sočiva`
 * and `sociva`). When several spellings fold together, the one with the most
 * impressions is reported -- never a sum, which no dashboard panel shows.
 *
 * Deliberately ignores the noise floor: the caller already decided this query
 * matters, and a fix that took it from 1 impression to 0 is the answer.
 */
function trackQueries(
  requested: string[],
  recent: Map<string, AggregatedQuery>,
  prior: Map<string, AggregatedQuery>
): TrackedQuery[] {
  // foldDiacritics does not lowercase; isBrand lowercases first, and so must
  // this, or "Tečnost" typed by an agent would miss GSC's "tečnost".
  const fold = (s: string) => foldDiacritics(s.trim().toLowerCase());
  const byFolded = new Map<string, string>();
  for (const [query, row] of recent) {
    const key = fold(query);
    const held = byFolded.get(key);
    if (!held || (recent.get(held) as AggregatedQuery).impressions < row.impressions) {
      byFolded.set(key, query);
    }
  }

  const seen = new Set<string>();
  const out: TrackedQuery[] = [];
  for (const raw of requested) {
    const wanted = raw.trim();
    const key = fold(wanted);
    if (!wanted || seen.has(key)) continue;
    seen.add(key);
    if (out.length >= DIGEST_LIMITS.tracked) break;

    const match = byFolded.get(key);
    out.push(
      match
        ? {
            requested: wanted,
            inRecentWindow: true,
            entry: toQuery(toEntry(match, recent.get(match) as AggregatedQuery, prior.get(match))),
          }
        : { requested: wanted, inRecentWindow: false, entry: null }
    );
  }
  return out;
}

export function buildAgentDigest(
  config: SiteConfig,
  asOf: string,
  db: Database.Database = getDb(),
  options: { track?: string[] } = {}
): AgentDigest {
  const report = buildReportData(config, asOf, db);

  // Emerging and climbing are not in the client documents, so they are
  // derived here with the same function and the same windows the dashboard
  // uses -- not recomputed some other way.
  const { recent, prior } = recentVsPrior(config.property, asOf, db);
  const signals = deriveSignals(recent, prior, config.brandToken);

  const cannibalization = buildCannibalization(queryPageSnapshot(config.property, db));
  const cwv = latestCwv(config.property, db);

  return {
    version: DIGEST_VERSION,
    asOf,
    semantics: DIGEST_SEMANTICS,
    site: {
      slug: config.slug,
      name: config.displayName,
      property: config.property,
      brandToken: config.brandToken,
      language: siteLanguage(config.property, db),
    },
    window: {
      start: report.window.start,
      end: report.window.end,
      measuredStart: report.measuredStart,
      measuredEnd: report.measuredEnd,
      measuredDays: report.measuredDays,
      hasPriorWindow: report.hasPriorWindow,
    },
    dataState: report.dataState,
    totals: {
      clicks: {
        recent: report.clicks.recent,
        prior: report.clicks.prior,
        deltaPct: round(report.clicks.deltaPct, 1),
      },
      impressions: report.impressions,
      avgPosition: round(report.avgPosition, 1),
      brandImpressions: report.breakdown.brandImpressions,
      nonBrandImpressions: report.breakdown.nonBrandImpressions,
      anonymizedImpressions: report.breakdown.anonymizedImpressions,
      nonBrandImpressionsDelta: signals.brandSplit.nonBrandImpressionsDelta,
      nonBrandQueryCount: signals.nonBrandQueries.length,
    },
    opportunities: signals.nonBrandQueries
      .filter((e) => e.score > 0)
      .slice(0, DIGEST_LIMITS.opportunities)
      .map(toQuery),
    rising: signals.rising.slice(0, DIGEST_LIMITS.signal).map(toQuery),
    emerging: signals.emerging.slice(0, DIGEST_LIMITS.signal).map(toQuery),
    climbing: signals.climbing.slice(0, DIGEST_LIMITS.signal).map(toQuery),
    declining: signals.declining.slice(0, DIGEST_LIMITS.signal).map(toQuery),
    topPages: report.topPages.slice(0, DIGEST_LIMITS.topPages).map((p) => ({
      page: p.page,
      clicks: p.clicks,
      impressions: p.impressions,
      position: round(p.position, 1) as number,
    })),
    demand: {
      notCollected: report.demand.notCollected,
      totalDiscovered: report.demand.totalDiscovered,
      covered: report.demand.covered,
      gapsByIntent: report.demand.byIntent,
      gaps: report.demand.gaps.slice(0, DIGEST_LIMITS.demandGaps).map(toGap),
    },
    cannibalization: {
      notCollected: cannibalization.notCollected,
      items: cannibalization.items.slice(0, DIGEST_LIMITS.cannibalization),
    },
    serp: {
      state: report.serpState,
      competitors: report.competitors.slice(0, DIGEST_LIMITS.competitors),
    },
    cwv: cwv
      ? {
          url: cwv.url,
          capturedAt: cwv.captured_at,
          source: cwv.source,
          formFactor: cwv.form_factor,
          lcpP75: cwv.lcp_p75,
          inpP75: cwv.inp_p75,
          clsP75: cwv.cls_p75,
          lighthouse: {
            performance: cwv.lh_performance,
            accessibility: cwv.lh_accessibility,
            bestPractices: cwv.lh_best_practices,
            seo: cwv.lh_seo,
          },
        }
      : null,
    growth: report.growth,
    tracked: trackQueries(options.track ?? [], recent, prior),
  };
}
