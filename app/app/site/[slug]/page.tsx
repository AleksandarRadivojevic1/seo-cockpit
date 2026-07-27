import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import BrandBandChart from "../../../components/BrandBandChart";
import BrandRing from "../../../components/BrandRing";
import CountryMap from "../../../components/CountryMap";
import CwvPanel from "../../../components/CwvPanel";
import DemandGaps from "../../../components/DemandGaps";
import SerpCompetitors from "../../../components/SerpCompetitors";
import EmptyState from "../../../components/EmptyState";
// LighthouseRadar is kept alongside this: the two are interchangeable in the
// panel below, so switching back is a one-line change rather than an undo.
import LighthouseRings from "../../../components/LighthouseRings";
import SignalList from "../../../components/SignalList";
import NonBrandTable from "../../../components/NonBrandTable";
import TopPagesBar from "../../../components/TopPagesBar";
import TrendChart from "../../../components/TrendChart";
import type { TrendPoint } from "../../../components/TrendChart";
import { Badge } from "../../../components/ui/badge";
import { brandSeries, buildBrandBandSeries } from "../../../lib/analysis/brand";
import { buildBrandBreakdown, topPages } from "../../../lib/analysis/breakdown";
import { buildCountryBreakdown } from "../../../lib/analysis/geography";
import { buildDemandBreakdown } from "../../../lib/analysis/demand";
import { ownDomainFor } from "../../../lib/analysis/serp";
import { deriveSignals } from "../../../lib/analysis/signals";
import { addDaysUTC, formatISODateUTC, recentVsPrior, windowBounds } from "../../../lib/analysis/windows";
import {
  countryRowsInRange,
  demandKeywords,
  latestCwv,
  pageRowsInRange,
  queryRowsInRange,
  serpChecks,
  siteConfigBySlug,
  totalsInRange,
} from "../../../lib/db";
import type { TotalsRow } from "../../../lib/db";
import { buildSiteSummary } from "../../../lib/portfolio";
import type { SiteSummary } from "../../../lib/portfolio";
import { cn } from "../../../lib/utils";

type FreshnessLevel = SiteSummary["freshness"]["level"];

// Same small presentational maps as SiteCard.tsx's FreshnessPill. Two call
// sites isn't enough to justify pulling this into a shared module yet.
const FRESHNESS_STYLES: Record<FreshnessLevel, string> = {
  fresh: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400",
  stale: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400",
  broken: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400",
  none: "bg-muted text-muted-foreground",
};

const FRESHNESS_LABEL: Record<FreshnessLevel, string> = {
  fresh: "Fresh",
  stale: "Stale",
  broken: "Broken",
  none: "No data",
};

/**
 * One entry per calendar day from `start` to `end` inclusive. `totalsInRange`
 * only returns dates that have a row, so this walks the full window and
 * fills the gaps -- a date with a row contributes its real value (0
 * included), a date with no row contributes `null`. Same approach as
 * `buildSparkline` in lib/portfolio.ts; not reused directly because that one
 * is click-only and file-private, but the null-vs-zero contract is
 * identical and must stay identical.
 */
/**
 * The non-brand impressions comparison, in words.
 *
 * `hasPriorWindow` is not optional politeness. `deriveSignals` computes
 * `nonBrandImpressionsDelta` as `recent − prior`, and `prior` is 0 both when
 * the previous window measured zero non-brand impressions AND when it was
 * never collected at all. On optika-cajs, whose history starts inside the
 * current window, that rendered as "up 13 versus the previous one" — a
 * comparison against a period that does not exist. Caught in the browser,
 * not in a test, which is where this class of bug always shows up.
 *
 * Stated as an absolute count rather than a percentage: at 13 impressions a
 * window, a percentage swings hundreds of points on a change of two and reads
 * as precision the data cannot support.
 */
export function formatNonBrandDelta(delta: number, hasPriorWindow: boolean): string {
  if (!hasPriorWindow) return "no previous period to compare against";
  if (delta === 0) return "unchanged versus the previous period";
  return `${delta > 0 ? "up" : "down"} ${Math.abs(delta)} versus the previous period`;
}

export function buildTrendSeries(rows: TotalsRow[], start: string, end: string): TrendPoint[] {
  const byDate = new Map(rows.map((row) => [row.date, row]));
  const series: TrendPoint[] = [];
  for (let date = start; date <= end; date = addDaysUTC(date, 1)) {
    const row = byDate.get(date);
    series.push({
      date,
      clicks: row ? row.clicks : null,
      impressions: row ? row.impressions : null,
    });
  }
  return series;
}

/**
 * Per-site trend view -- name, freshness badge, one clicks/impressions
 * chart over the trailing 28-day window. Deliberately thin: this is the
 * 11b/11c slice that gets a real chart on real data landed now; tables,
 * the brand toggle, and the CWV panel are separate tasks.
 *
 * Server component (reads the DB directly via lib/db.ts) rendering a
 * client-only <TrendChart>; `connection()` opts this route out of
 * prerendering for the same reason app/page.tsx does -- the collector
 * writes seo.db from a separate container, so nothing here can safely
 * cache a build-time snapshot.
 */
export default async function SitePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  await connection();

  const { slug } = await params;
  const config = siteConfigBySlug(slug);
  if (!config) {
    notFound();
  }

  const asOf = formatISODateUTC(new Date());
  const summary = buildSiteSummary(config, asOf);
  const { recentStart, recentEnd, priorStart, priorEnd } = windowBounds(asOf);
  const rows = totalsInRange(config.property, recentStart, recentEnd);
  // Whether a prior window EXISTS, which is not the same as it being flat.
  // Without this the non-brand delta compares against a period that was
  // never collected and reports the whole current figure as growth.
  const hasPriorWindow = totalsInRange(config.property, priorStart, priorEnd).length > 0;
  const series = buildTrendSeries(rows, recentStart, recentEnd);

  const { recent, prior } = recentVsPrior(config.property, asOf);
  const signals = deriveSignals(recent, prior, config.brandToken);
  const bands = buildBrandBandSeries(
    rows,
    brandSeries(config.property, recentStart, recentEnd, config.brandToken),
    recentStart,
    recentEnd
  );

  const pages = topPages(pageRowsInRange(config.property, recentStart, recentEnd), 8);
  // Window total from totals_daily, NOT from summing query rows: the gap
  // between the two is exactly the anonymized segment BrandRing draws.
  const totalImpressions = rows.reduce((sum, row) => sum + row.impressions, 0);
  const breakdown = buildBrandBreakdown(
    signals.brandSplit.brand.impressions,
    signals.brandSplit.nonBrand.impressions,
    totalImpressions
  );
  const cwv = latestCwv(config.property);
  // Every query the site has EVER appeared for, not just this window: a
  // keyword it ranked for six months ago is still not an undiscovered gap.
  const everRanked = queryRowsInRange(config.property, "0000-01-01", "9999-12-31").map(
    (r) => r.query
  );
  const demand = buildDemandBreakdown(demandKeywords(config.property), everRanked);
  const serp = serpChecks(config.property);

  const countries = buildCountryBreakdown(
    countryRowsInRange(config.property, recentStart, recentEnd)
  );

  // "zero" (rows exist, all measured zero) and "not-collected" (no rows at
  // all) both mean "don't draw a chart" here, but they render different
  // copy -- collapsing them would be the exact conflation this project
  // forbids (see lib/portfolio.ts's DataState doc).
  const showChart = summary.dataState === "ok" || summary.dataState === "collecting";

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
      {/* An inline chevron, not a glyph or emoji: this is a navigation
          affordance rather than decoration, and the label carries the
          meaning on its own if the icon fails to paint. */}
      <Link
        href="/"
        className="flex w-fit items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <svg
          aria-hidden="true"
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          viewBox="0 0 24 24"
        >
          <path d="M15 18l-6-6 6-6" />
        </svg>
        Back to dashboard
      </Link>

      <header className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold text-zinc-900 dark:text-zinc-50">
            {config.displayName}
          </h1>
          <p className="truncate font-mono text-xs text-muted-foreground">{config.property}</p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <Link
            href={`/site/${slug}/proposal`}
            className="text-sm text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
          >
            Findings
          </Link>
          {/* Label stays English: this link lives on the dashboard, which is
              English by decision. Only the document it opens is Serbian. */}
          <Link
            href={`/site/${slug}/report`}
            className="text-sm text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
          >
            Client report (SR)
          </Link>
          <Badge className={cn("shrink-0", FRESHNESS_STYLES[summary.freshness.level])}>
            {FRESHNESS_LABEL[summary.freshness.level]}
          </Badge>
        </div>
      </header>

      <div className="rounded-xl border border-border bg-card p-4 text-card-foreground shadow-sm">
        {showChart ? (
          <TrendChart data={series} />
        ) : summary.dataState === "zero" ? (
          <EmptyState title="No impressions in the last 28 days" />
        ) : (
          <EmptyState title="Not collected yet" />
        )}
      </div>

      <section className="rounded-xl border border-border bg-card p-4 text-card-foreground shadow-sm">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Non-brand queries
          </h2>
          {signals.nonBrandQueries.length > 0 && (
            <span className="text-xs tabular-nums text-muted-foreground">
              {signals.nonBrandQueries.length}{" "}
              {signals.nonBrandQueries.length === 1 ? "query" : "queries"}
            </span>
          )}
        </div>
        <p className="pt-0.5 pb-2 text-xs text-muted-foreground/70">
          Queries that found this site without naming it, ranked by remaining upside.
        </p>
        <NonBrandTable entries={signals.nonBrandQueries} dataState={summary.dataState} />
      </section>

      {/* Two columns, not four: query text is the content here, and at
          quarter-width real keywords truncate to the point of uselessness. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <SignalList
          title="Rising"
          entries={signals.rising}
          metric="impressionsDelta"
          emptyMessage="No rising queries"
        />
        <SignalList
          title="Climbing"
          entries={signals.climbing}
          metric="positionDelta"
          emptyMessage="No climbing queries"
        />
        <SignalList
          title="Emerging"
          entries={signals.emerging}
          metric="impressions"
          emptyMessage="No emerging queries"
        />
        <SignalList
          title="Declining"
          entries={signals.declining}
          metric="impressionsDelta"
          emptyMessage="No declining queries"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-border bg-card p-4 text-card-foreground shadow-sm">
          <h2 className="pb-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Top pages
          </h2>
          <TopPagesBar pages={pages} dataState={summary.dataState} />
        </section>

        <div className="flex flex-col gap-4">
          <section className="rounded-xl border border-border bg-card p-4 text-card-foreground shadow-sm">
            <h2 className="pb-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              Impressions by query type
            </h2>
            <BrandRing breakdown={breakdown} />
          </section>

          {/* The ring answers "how much of this window was brand"; this
              answers "is the non-brand share growing", which is the only one
              of the two that reports on the work. */}
          <section className="rounded-xl border border-border bg-card p-4 text-card-foreground shadow-sm">
            <h2 className="pb-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              Query type over time
            </h2>
            {summary.dataState === "not-collected" ? (
              <EmptyState title="Not collected yet" />
            ) : (
              <>
                <p className="pb-3 text-sm text-muted-foreground">
                  Non-brand impressions{" "}
                  <span className="font-medium text-foreground">
                    {signals.brandSplit.nonBrand.impressions}
                  </span>{" "}
                  this window,{" "}
                  {formatNonBrandDelta(
                    signals.brandSplit.nonBrandImpressionsDelta,
                    hasPriorWindow
                  )}
                  .
                </p>
                <BrandBandChart data={bands} />
              </>
            )}
          </section>

          <section className="rounded-xl border border-border bg-card p-4 text-card-foreground shadow-sm">
            <h2 className="pb-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              Core Web Vitals
            </h2>
            <CwvPanel row={cwv} />
          </section>
        </div>
      </div>

      {/* Lighthouse sits beside Core Web Vitals conceptually but in its own
          row: both read the SAME cwv_snapshots row, so one timestamp covers
          the pair and they can never describe different moments. */}
      <section className="rounded-xl border border-border bg-card p-4 text-card-foreground shadow-sm">
        <h2 className="pb-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Lighthouse categories
        </h2>
        <LighthouseRings row={cwv} />
      </section>

      <section className="rounded-xl border border-border bg-card p-4 text-card-foreground shadow-sm">
        <h2 className="pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Demand you&apos;re missing
        </h2>
        <p className="pb-3 text-xs text-muted-foreground/70">
          Searches with real demand that this site does not appear for at all.
        </p>
        <DemandGaps breakdown={demand} />
      </section>

      <section className="rounded-xl border border-border bg-card p-4 text-card-foreground shadow-sm">
        <h2 className="pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Who ranks for what you&apos;re missing
        </h2>
        <p className="pb-3 text-xs text-muted-foreground/70">
          Live Google results for a sample of the gaps above, so you can see who would have to be
          displaced.
        </p>
        <SerpCompetitors checks={serp} ownDomain={ownDomainFor(config.property)} />
      </section>

      <section className="rounded-xl border border-border bg-card p-4 text-card-foreground shadow-sm">
        <h2 className="pb-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Impressions by country
        </h2>
        <CountryMap breakdown={countries} dataState={summary.dataState} />
      </section>
    </div>
  );
}
