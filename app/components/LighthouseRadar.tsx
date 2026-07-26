"use client";

import { RadarArea } from "./charts/radar-area";
import { RadarAxis } from "./charts/radar-axis";
import { RadarChart } from "./charts/radar-chart";
import { RadarGrid } from "./charts/radar-grid";
import { RadarLabels } from "./charts/radar-labels";
import EmptyState from "./EmptyState";
import { cn } from "../lib/utils";
import type { CwvRow } from "../lib/db";

/** Matches the emerald the trend chart uses for its primary series. */
const AREA_COLOR = "oklch(0.74 0.15 165)";

const CATEGORIES = [
  { key: "performance", label: "Performance", field: "lh_performance" },
  { key: "accessibility", label: "Accessibility", field: "lh_accessibility" },
  { key: "bestPractices", label: "Best Practices", field: "lh_best_practices" },
  { key: "seo", label: "SEO", field: "lh_seo" },
] as const;

/**
 * A Lighthouse score's verdict, using Google's own published bands.
 * Deliberately separate from `metricVerdict` in cwv-format: those thresholds
 * are per-metric millisecond/unitless cutoffs, these are a single 0-100 scale.
 */
function scoreVerdict(score: number): "good" | "needs-work" | "poor" {
  if (score >= 90) return "good";
  if (score >= 50) return "needs-work";
  return "poor";
}

const VERDICT_STYLES = {
  good: "text-emerald-700 dark:text-emerald-400",
  "needs-work": "text-amber-700 dark:text-amber-400",
  poor: "text-red-700 dark:text-red-400",
} as const;

interface LighthouseRadarProps {
  row: CwvRow | null;
}

/**
 * Lighthouse category scores as a radar, plus the four numbers.
 *
 * READS THE SAME SNAPSHOT AS CwvPanel — deliberately. It does not search back
 * for an older row that happens to have category scores. Snapshots written
 * before the collector requested all four categories carry NULLs, and falling
 * back to one of those would show last week's shape beside today's LCP with
 * nothing on screen saying so. An honest "not measured" beats a stale polygon.
 *
 * The numbers are shown alongside the shape because at these values the shape
 * alone cannot carry the difference: on real data three of four axes sit at
 * 100 for every site, so every polygon is a near-perfect square and the whole
 * spread lives in the Performance corner.
 */
export default function LighthouseRadar({ row }: LighthouseRadarProps) {
  if (!row) {
    return <EmptyState title="No Lighthouse scores collected yet" />;
  }

  const scores = CATEGORIES.map((c) => ({
    ...c,
    // NULL means the category was never fetched. 0 is a real Lighthouse score,
    // so `?? 0` here would print a catastrophic result over a missing one.
    value: row[c.field] as number | null,
  }));

  const measured = scores.filter((s) => s.value !== null);
  const missing = scores.filter((s) => s.value === null);

  if (measured.length === 0) {
    return (
      <EmptyState title="Lighthouse categories not measured in the latest run" />
    );
  }

  // Only measured categories become axes. An unmeasured one plotted at the
  // centre would read as a zero score, which is the exact inversion of what a
  // missing value means.
  const metrics = measured.map((s) => ({ key: s.key, label: s.label }));
  const values = Object.fromEntries(measured.map((s) => [s.key, s.value as number]));

  return (
    <div className="grid items-center gap-6 sm:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
      {/* A radar needs at least 3 axes to enclose an area; below that the
          numbers are the whole story and a 2-point polygon is noise.

          Sized by a max-width square rather than a fixed height: RadarChart's
          own wrapper is `aspect-square w-full`, so giving it a full-width
          parent draws a small circle stranded in a wide box. */}
      {metrics.length >= 3 ? (
        <div className="mx-auto w-full max-w-[300px]">
          <RadarChart
            data={[{ label: "Lighthouse", color: AREA_COLOR, values }]}
            metrics={metrics}
            margin={64}
          >
            <RadarGrid />
            <RadarAxis />
            <RadarLabels offset={16} />
            <RadarArea index={0} />
          </RadarChart>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-x-4 gap-y-3">
        {scores.map((s) => (
          <div key={s.key} className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">{s.label}</span>
            <span
              className={cn(
                "text-lg font-semibold tabular-nums",
                s.value === null
                  ? "text-muted-foreground"
                  : VERDICT_STYLES[scoreVerdict(s.value)]
              )}
            >
              {s.value === null ? "Not measured" : Math.round(s.value)}
            </span>
          </div>
        ))}
      </div>

      <p className="text-xs text-muted-foreground/70 sm:col-span-2">
        {missing.length > 0
          ? `Lighthouse lab scores from a single PageSpeed Insights run. ${missing
              .map((m) => m.label)
              .join(", ")} ${missing.length === 1 ? "was" : "were"} not returned by this run and ${
              missing.length === 1 ? "is" : "are"
            } left off the chart rather than plotted as zero.`
          : "Lighthouse lab scores from a single PageSpeed Insights run, scored 0-100. Not field data — a lab run varies between measurements."}
      </p>
    </div>
  );
}
