import { connection } from "next/server";

import EmptyState from "../components/EmptyState";
import HealthPanel from "../components/HealthPanel";
import KpiRow from "../components/KpiRow";
import OpportunityList from "../components/OpportunityList";
import PortfolioTrend from "../components/PortfolioTrend";
import type { PortfolioPoint } from "../components/PortfolioTrend";
import SiteStrip from "../components/SiteStrip";
import { deriveSignals } from "../lib/analysis/signals";
import { addDaysUTC, recentVsPrior, windowBounds } from "../lib/analysis/windows";
import { latestRunPerSite, listSiteConfigs, totalsInRange } from "../lib/db";
import { buildCollectorHealth } from "../lib/health";
import { mergeDailySeries, portfolioTotals, rankOpportunities } from "../lib/overview";
import { buildSiteSummary } from "../lib/portfolio";

/** Highest-upside queries listed on the overview. */
const OPPORTUNITY_LIMIT = 6;

/** Current UTC date as "YYYY-MM-DD", matching lib/analysis/windows.ts. */
function todayUTC(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Most recent totals_daily date across every site, or null if none have data yet. */
function latestCollectedDate(latestDates: (string | null)[]): string | null {
  return latestDates.reduce<string | null>((latest, date) => {
    if (!date) return latest;
    if (!latest || date > latest) return date;
    return latest;
  }, null);
}

// The collector's daily cron slot, in UTC (collector/seocockpit/schedule.py
// pins CronTrigger to UTC for exactly this reason), plus how late a run may
// be before the panel calls it missing. Overridable so a changed collector
// schedule doesn't silently make the health panel lie.
function scheduleConfig() {
  return {
    hourUtc: Number(process.env.COLLECTOR_SCHEDULE_HOUR ?? 3),
    graceHours: Number(process.env.COLLECTOR_GRACE_HOURS ?? 2),
  };
}

/**
 * Portfolio overview — the dashboard's landing page. Server component, not
 * cached: the collector writes seo.db from a separate container, so nothing
 * inside Next could invalidate a cache. `connection()` opts this render out
 * of prerendering (see node_modules/next/dist/docs/.../functions/connection.md,
 * "Synchronous database drivers") so better-sqlite3 always reads at request
 * time instead of baking a stale snapshot into the build.
 *
 * Ordered to answer two questions before anything else: how is the
 * portfolio doing, and what should be worked on next. Per-site detail lives
 * on /site/<slug>, so this page carries a compact strip rather than
 * restating those numbers in full cards.
 */
export default async function Home() {
  await connection();

  const asOf = todayUTC();
  const now = new Date();
  const configs = listSiteConfigs();
  const summaries = configs.map((config) => buildSiteSummary(config, asOf));
  const lastCollected = latestCollectedDate(summaries.map((s) => s.freshness.latestDate));
  const health = buildCollectorHealth(latestRunPerSite(), configs, now, scheduleConfig());

  const { recentStart, recentEnd } = windowBounds(asOf);
  const totals = portfolioTotals(summaries);

  // Impressions and the weighted mean position both need the raw window
  // rows, which SiteSummary doesn't carry.
  let totalImpressions = 0;
  let weightedPositionSum = 0;
  for (const config of configs) {
    for (const row of totalsInRange(config.property, recentStart, recentEnd)) {
      totalImpressions += row.impressions;
      weightedPositionSum += row.position * row.impressions;
    }
  }
  const avgPosition = totalImpressions > 0 ? weightedPositionSum / totalImpressions : null;

  const mergedClicks = mergeDailySeries(summaries.map((s) => s.sparkline));
  const trend: PortfolioPoint[] = mergedClicks.map((clicks, i) => ({
    date: addDaysUTC(recentStart, i),
    clicks,
  }));

  const opportunities = rankOpportunities(
    configs.map((config) => {
      const { recent, prior } = recentVsPrior(config.property, asOf);
      const signals = deriveSignals(recent, prior, config.brandToken);
      return {
        slug: config.slug,
        name: config.displayName,
        entries: signals.nonBrandQueries,
      };
    }),
    OPPORTUNITY_LIMIT
  );

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">SEO Cockpit</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {lastCollected ? `Last collected ${lastCollected}` : "No data collected yet"}
        </p>
      </header>

      {summaries.length === 0 ? (
        <EmptyState
          title="No sites configured"
          description="Add a site to collector/sites.yaml to get started."
        />
      ) : (
        <>
          <KpiRow
            totals={totals}
            avgPosition={avgPosition}
            totalImpressions={totalImpressions}
          />

          <section className="rounded-xl border border-border bg-card p-4 text-card-foreground shadow-sm">
            <h2 className="pb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              Portfolio clicks / 28d
            </h2>
            <PortfolioTrend data={trend} />
          </section>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <section className="rounded-xl border border-border bg-card p-4 text-card-foreground shadow-sm">
              <h2 className="pb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                Top opportunities
              </h2>
              <OpportunityList entries={opportunities} />
            </section>

            <div className="flex flex-col gap-4">
              <HealthPanel health={health} now={now} />
              <section className="flex flex-col gap-2">
                <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  Sites
                </h2>
                <SiteStrip summaries={summaries} />
              </section>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
