import { cn } from "../lib/utils";
import type { PortfolioTotals } from "../lib/overview";

interface KpiRowProps {
  totals: PortfolioTotals;
  /** Impression-weighted mean position across the portfolio, or null. */
  avgPosition: number | null;
  totalImpressions: number;
}

function DeltaPill({ deltaPct }: { deltaPct: number | null }) {
  if (deltaPct === null) {
    // No prior baseline is not a flat trend. Saying "0%" would claim a
    // comparison that was never possible.
    return <span className="text-xs text-muted-foreground">no comparison yet</span>;
  }

  const rounded = Math.round(deltaPct * 10) / 10;
  const direction = rounded === 0 ? "neutral" : rounded > 0 ? "up" : "down";
  const color = {
    up: "text-emerald-600 dark:text-emerald-400",
    down: "text-red-600 dark:text-red-400",
    neutral: "text-muted-foreground",
  }[direction];
  const arrow = { up: "▲", down: "▼", neutral: "–" }[direction];

  return (
    <span className={cn("text-xs tabular-nums", color)}>
      {arrow} {Math.abs(rounded)}%
    </span>
  );
}

function Kpi({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs tracking-wide text-muted-foreground uppercase">{label}</span>
      <span className="text-2xl font-semibold tabular-nums text-foreground">{value}</span>
      {children}
    </div>
  );
}

/**
 * Portfolio headline numbers for the trailing 28-day window.
 *
 * Deliberately reports clicks first: it is the only figure here that maps
 * directly to business outcome, and it leads the site cards for the same
 * reason.
 */
export default function KpiRow({ totals, avgPosition, totalImpressions }: KpiRowProps) {
  return (
    <div className="grid grid-cols-2 gap-4 rounded-xl border border-border bg-card p-4 text-card-foreground shadow-sm sm:grid-cols-4">
      <Kpi label="Clicks / 28d" value={String(totals.clicks.recent)}>
        <DeltaPill deltaPct={totals.clicks.deltaPct} />
      </Kpi>
      <Kpi label="Impressions / 28d" value={String(totalImpressions)} />
      <Kpi
        label="Avg position"
        value={avgPosition === null ? "—" : avgPosition.toFixed(1)}
      />
      <Kpi label="Sites" value={`${totals.activeSiteCount} / ${totals.siteCount}`}>
        <span className="text-xs text-muted-foreground">reporting data</span>
      </Kpi>
    </div>
  );
}
