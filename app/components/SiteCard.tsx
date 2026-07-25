import Link from "next/link";

import { cn } from "../lib/utils";
import type { SiteSummary } from "../lib/portfolio";
import { Badge } from "./ui/badge";
import EmptyState from "./EmptyState";

interface SiteCardProps {
  summary: SiteSummary;
}

type FreshnessLevel = SiteSummary["freshness"]["level"];
type CwvVerdict = SiteSummary["cwv"]["verdict"];

// "fresh"/"stale"/"broken" (and CWV's good/needs-work/poor below) are status
// semantics shadcn's neutral theme has no token for, so they stay explicit
// Tailwind colors; "none" ("not collected") is a neutral chrome state and
// uses the shadcn muted token like everything else in that role.
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

const CWV_STYLES: Record<CwvVerdict, string> = {
  good: "text-emerald-700 dark:text-emerald-400",
  "needs-work": "text-amber-700 dark:text-amber-400",
  poor: "text-red-700 dark:text-red-400",
  none: "text-muted-foreground",
};

const CWV_LABEL: Record<CwvVerdict, string> = {
  good: "Good",
  "needs-work": "Needs work",
  poor: "Poor",
  none: "No data",
};

type TrendDirection = "up" | "down" | "neutral";

/** Rising (positive delta) is "up", falling is "down"; null or exactly 0 is neutral. */
function trendDirection(deltaPct: number | null): TrendDirection {
  if (deltaPct === null || deltaPct === 0) return "neutral";
  return deltaPct > 0 ? "up" : "down";
}

// Shared between the delta text and the sparkline stroke, so a card carries
// one consistent trend signal instead of a grey chart beside a coloured number.
const TREND_COLOR: Record<TrendDirection, string> = {
  up: "text-emerald-600 dark:text-emerald-400",
  down: "text-red-600 dark:text-red-400",
  neutral: "text-muted-foreground",
};

const TREND_ARROW: Record<TrendDirection, string> = { up: "▲", down: "▼", neutral: "–" };

function FreshnessPill({ freshness }: { freshness: SiteSummary["freshness"] }) {
  return (
    <Badge className={cn("shrink-0", FRESHNESS_STYLES[freshness.level])}>
      {FRESHNESS_LABEL[freshness.level]}
    </Badge>
  );
}

/**
 * Full-width inline SVG sparkline — no chart library, keeps the arm64 image
 * small. `null` entries ("not collected") are not plotted: each run of
 * consecutive non-null values becomes its own `<polyline>` so a gap reads as
 * an absence rather than a drop to zero, and an isolated value between two
 * gaps still renders (as a dot) rather than silently vanishing. The stroke
 * colour follows the trend, matching the delta text beside it.
 */
function Sparkline({
  values,
  deltaPct,
}: {
  values: (number | null)[];
  deltaPct: number | null;
}) {
  const nonNull = values.filter((v): v is number => v !== null);
  if (nonNull.length === 0) return null;

  const width = 100;
  const height = 38;
  const max = Math.max(...nonNull, 1);
  const lastIndex = Math.max(values.length - 1, 1);

  const x = (i: number) => (i / lastIndex) * width;
  const y = (v: number) => height - (v / max) * height;

  const runs: { i: number; v: number }[][] = [];
  let current: { i: number; v: number }[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null) {
      if (current.length > 0) {
        runs.push(current);
        current = [];
      }
      continue;
    }
    current.push({ i, v });
  }
  if (current.length > 0) runs.push(current);

  const colorClass = TREND_COLOR[trendDirection(deltaPct)];

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={cn("h-[38px] w-full", colorClass)}
      aria-hidden="true"
    >
      {runs.map((run, runIndex) =>
        run.length === 1 ? (
          <circle key={runIndex} cx={x(run[0].i)} cy={y(run[0].v)} r={1.5} fill="currentColor" />
        ) : (
          <polyline
            key={runIndex}
            points={run.map((p) => `${x(p.i).toFixed(2)},${y(p.v).toFixed(2)}`).join(" ")}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
          />
        )
      )}
    </svg>
  );
}

function formatClicks(n: number): string {
  return n.toLocaleString("en-US");
}

/** Percent delta pill, or a neutral "no comparison yet" pill while collecting. */
function DeltaIndicator({ summary }: { summary: SiteSummary }) {
  if (summary.dataState === "collecting") {
    return (
      <Badge variant="secondary" className={cn("shrink-0", TREND_COLOR.neutral)}>
        no comparison yet
      </Badge>
    );
  }

  const delta = summary.clicks.deltaPct;
  if (delta === null) return null;

  const direction = trendDirection(delta);

  return (
    <span className={cn("shrink-0 text-sm font-medium tabular-nums", TREND_COLOR[direction])}>
      {TREND_ARROW[direction]} {Math.abs(delta).toFixed(1)}%
    </span>
  );
}

function FooterStat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="text-sm font-medium text-foreground">{children}</p>
    </div>
  );
}

/**
 * Presentational site overview card. Takes a fully-computed SiteSummary and
 * renders it — no DB access here, so the thresholds and state logic in
 * lib/portfolio.ts stay independently testable (and reusable from Task 13's
 * per-site view).
 */
export default function SiteCard({ summary }: SiteCardProps) {
  const { config } = summary;

  return (
    <Link
      href={`/site/${config.slug}`}
      className={cn(
        "flex flex-col gap-3 rounded-xl border border-border bg-card p-4 text-card-foreground shadow-sm transition",
        "hover:border-foreground/20 hover:shadow-md"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate font-semibold text-foreground">{config.displayName}</h2>
          <p className="truncate font-mono text-xs text-muted-foreground">{config.property}</p>
        </div>
        <FreshnessPill freshness={summary.freshness} />
      </div>

      {summary.dataState === "empty" ? (
        <EmptyState title="No search data yet" />
      ) : (
        <>
          <Sparkline values={summary.sparkline} deltaPct={summary.clicks.deltaPct} />

          <div className="flex items-end justify-between gap-2">
            <div>
              <span className="text-2xl font-semibold tabular-nums text-foreground">
                {formatClicks(summary.clicks.recent)}
              </span>{" "}
              <span className="text-xs text-muted-foreground">clicks / 28d</span>
            </div>
            <DeltaIndicator summary={summary} />
          </div>

          <div className="grid grid-cols-3 gap-2 border-t border-border pt-3">
            <FooterStat label="Avg pos">
              {summary.avgPosition !== null ? summary.avgPosition.toFixed(1) : "—"}
            </FooterStat>
            <FooterStat label="Striking">{summary.strikingCount}</FooterStat>
            <FooterStat label="CWV">
              <span className={CWV_STYLES[summary.cwv.verdict]}>
                {CWV_LABEL[summary.cwv.verdict]}
              </span>
            </FooterStat>
          </div>
        </>
      )}
    </Link>
  );
}
