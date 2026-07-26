import EmptyState from "./EmptyState";
import { cn } from "../lib/utils";
import type { DemandBreakdown, DemandIntent } from "../lib/analysis/demand";

const INTENT_LABEL: Record<DemandIntent, string> = {
  commercial: "Buying",
  question: "Question",
  local: "Local",
  other: "General",
};

const INTENT_STYLE: Record<DemandIntent, string> = {
  commercial: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  local: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
  question: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  other: "bg-muted text-muted-foreground",
};

interface DemandGapsProps {
  breakdown: DemandBreakdown;
  limit?: number;
}

/**
 * Searches this site does not appear for at all.
 *
 * Search Console can only report queries the site HAS appeared for, so it
 * structurally cannot show this. Everything here comes from a demand source
 * (autocomplete, and Google Trends when it has been run).
 *
 * Deliberately unscored. No free source provides search volume, so a single
 * number would be a composite of proxies dressed up as a measurement. Gaps
 * are grouped by intent, with any real rising signal shown as itself.
 */
export default function DemandGaps({ breakdown, limit = 25 }: DemandGapsProps) {
  if (breakdown.notCollected) {
    return <EmptyState title="No demand keywords collected yet" />;
  }
  if (breakdown.gaps.length === 0) {
    // Distinct from the above: discovery HAS run, and the site covers
    // everything it found. That is a finding, not an absence.
    return <EmptyState title="You already rank for every keyword discovered" />;
  }

  const shown = breakdown.gaps.slice(0, limit);

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col divide-y divide-border">
        {shown.map((gap) => (
          <li key={gap.keyword} className="flex items-center justify-between gap-3 py-2">
            <span className="flex min-w-0 items-center gap-2">
              <span
                className={cn(
                  "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                  INTENT_STYLE[gap.intent]
                )}
              >
                {INTENT_LABEL[gap.intent]}
              </span>
              <span className="truncate text-sm">{gap.keyword}</span>
            </span>
            {/* Only a measured rising signal earns a number. Everything else
                shows nothing rather than a placeholder that would read as a
                measurement of zero. */}
            {gap.risingLabel ? (
              <span className="shrink-0 text-xs font-medium text-emerald-700 tabular-nums dark:text-emerald-400">
                {gap.risingLabel === "Breakout" ? "Breakout" : gap.risingLabel}
              </span>
            ) : null}
          </li>
        ))}
      </ul>

      <p className="text-xs text-muted-foreground/70">
        {breakdown.gaps.length.toLocaleString()} searches you don&apos;t appear for, of{" "}
        {breakdown.totalDiscovered.toLocaleString()} discovered
        {breakdown.covered > 0 ? ` (you already rank for ${breakdown.covered})` : ""}.{" "}
        {breakdown.byIntent.commercial > 0
          ? `${breakdown.byIntent.commercial} show buying intent. `
          : ""}
        Search Console can only report searches you already appear for, so these come from
        Google autocomplete. No free source provides search volume, so this list is grouped by
        intent rather than ranked by a score.
      </p>
    </div>
  );
}
