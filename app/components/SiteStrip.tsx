import Link from "next/link";

import { cn } from "../lib/utils";
import type { SiteSummary } from "../lib/portfolio";

interface SiteStripProps {
  summaries: SiteSummary[];
}

type FreshnessLevel = SiteSummary["freshness"]["level"];

const FRESHNESS_DOT: Record<FreshnessLevel, string> = {
  fresh: "bg-emerald-500 dark:bg-emerald-400",
  stale: "bg-amber-500 dark:bg-amber-400",
  broken: "bg-red-500 dark:bg-red-400",
  none: "bg-muted-foreground/40",
};

// Only the two states with nothing to count replace the click figure. A
// 'collecting' site has real clicks worth showing -- it just has no prior
// window to compare against, which is a statement about the comparison,
// not about the traffic.
const DATA_STATE_NOTE: Record<SiteSummary["dataState"], string | null> = {
  ok: null,
  collecting: null,
  zero: "no impressions",
  "not-collected": "not collected",
};

/**
 * Compact per-site row: enough to see which site needs attention and click
 * through, without repeating the detail the per-site page already owns.
 *
 * Replaces the full cards on the overview. With the portfolio KPIs, trend
 * and cross-site opportunities above it, three large cards restating the
 * same numbers pushed the actual answers below the fold.
 */
export default function SiteStrip({ summaries }: SiteStripProps) {
  return (
    // Single column: this sits in a half-width sidebar next to the
    // opportunity list, where multi-column truncated site names to
    // "Optika C…" and stopped being scannable.
    <ul className="flex flex-col gap-2">
      {summaries.map((summary) => {
        const note = DATA_STATE_NOTE[summary.dataState];
        return (
          <li key={summary.config.slug}>
            <Link
              href={`/site/${summary.config.slug}`}
              className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2.5 text-card-foreground transition-colors hover:bg-muted/50"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span
                  aria-hidden="true"
                  className={cn(
                    "h-1.5 w-1.5 shrink-0 rounded-full",
                    FRESHNESS_DOT[summary.freshness.level]
                  )}
                />
                <span className="truncate text-sm text-foreground">
                  {summary.config.displayName}
                </span>
              </span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {note ?? `${summary.clicks.recent} clicks`}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
