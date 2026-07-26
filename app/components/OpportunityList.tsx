import Link from "next/link";

import EmptyState from "./EmptyState";
import type { OpportunityEntry } from "../lib/overview";

interface OpportunityListProps {
  entries: OpportunityEntry[];
}

/**
 * Highest-upside queries across the whole portfolio.
 *
 * Ranked by opportunity score with a bar relative to the top row, matching
 * the per-site striking table — the score is unbounded and unitless, so a
 * printed number would imply a scale it does not have.
 *
 * Unlike that table this is NOT restricted to the striking-distance band.
 * On the real portfolio the band is empty everywhere while one query still
 * carries genuine upside, and a home page that hid it behind a position
 * filter would answer "what should I work on?" with silence.
 */
export default function OpportunityList({ entries }: OpportunityListProps) {
  if (entries.length === 0) {
    return (
      <EmptyState
        title="No ranking upside detected"
        description="Every tracked query is already on page 1, or has too few impressions to rank."
      />
    );
  }

  const top = entries[0].score;

  return (
    <ul className="flex flex-col">
      {entries.map((entry) => (
        <li
          key={`${entry.siteSlug}:${entry.query}`}
          className="flex flex-col gap-1 border-b border-border/50 py-2 last:border-0"
        >
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate text-sm text-foreground">{entry.query}</span>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              pos {entry.position.toFixed(1)} · {entry.impressions} impr
            </span>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href={`/site/${entry.siteSlug}`}
              className="shrink-0 text-xs text-muted-foreground underline-offset-2 hover:underline"
            >
              {entry.siteName}
            </Link>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-emerald-500 dark:bg-emerald-400"
                style={{ width: `${top > 0 ? (entry.score / top) * 100 : 0}%` }}
              />
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
