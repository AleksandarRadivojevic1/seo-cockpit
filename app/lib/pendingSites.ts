import type { RunRow, SiteConfig } from "./db";
import type { UserSite } from "./userSites";

export type UserSiteStatus = "pending" | "failed" | "collected";

export interface ClassifiedUserSite {
  site: UserSite;
  status: UserSiteStatus;
  error: string | null;
}

/**
 * Classify each dashboard-added site against what the collector has done.
 *
 * The dashboard cannot verify GSC access up front (credentials live only in
 * the collector), so a site's real status only becomes known after a run:
 *   - failed    — the latest collection_runs row for it failed (surface error)
 *   - collected — it is in the sites table (the collector has ingested it)
 *   - pending   — added but not yet picked up by a run
 * Collected sites already appear via the normal SiteStrip; callers filter them
 * out of the "awaiting collection" display.
 */
export function classifyUserSites(
  userSites: UserSite[],
  dbConfigs: SiteConfig[],
  latestRuns: RunRow[],
): ClassifiedUserSite[] {
  const configured = new Set(dbConfigs.map((c) => c.property));
  const runByProperty = new Map(latestRuns.map((r) => [r.site, r]));
  return userSites.map((site) => {
    const run = runByProperty.get(site.property);
    if (run?.status === "failed") {
      return { site, status: "failed" as const, error: run.error };
    }
    if (configured.has(site.property)) {
      return { site, status: "collected" as const, error: null };
    }
    return { site, status: "pending" as const, error: null };
  });
}
