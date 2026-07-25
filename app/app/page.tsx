import { connection } from "next/server";

import EmptyState from "../components/EmptyState";
import SiteCard from "../components/SiteCard";
import { listSiteConfigs } from "../lib/db";
import { buildSiteSummary } from "../lib/portfolio";

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

/**
 * Portfolio overview — the dashboard's landing page. Server component, not
 * cached: the collector writes seo.db from a separate container, so nothing
 * inside Next could invalidate a cache. `connection()` opts this render out
 * of prerendering (see node_modules/next/dist/docs/.../functions/connection.md,
 * "Synchronous database drivers") so better-sqlite3 always reads at request
 * time instead of baking a stale snapshot into the build.
 */
export default async function Home() {
  await connection();

  const asOf = todayUTC();
  const configs = listSiteConfigs();
  const summaries = configs.map((config) => buildSiteSummary(config, asOf));
  const lastCollected = latestCollectedDate(summaries.map((s) => s.freshness.latestDate));

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
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {summaries.map((summary) => (
            <SiteCard key={summary.config.slug} summary={summary} />
          ))}
        </div>
      )}
    </div>
  );
}
