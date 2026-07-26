"use client";

import { useState } from "react";

import {
  Legend,
  LegendItem,
  LegendLabel,
  LegendMarker,
  LegendProgress,
  useLegendItem,
} from "./charts/legend";
import { Ring } from "./charts/ring";
import { RingChart } from "./charts/ring-chart";
import EmptyState from "./EmptyState";
import { cn } from "../lib/utils";
import type { CwvRow } from "../lib/db";

/**
 * Identity colours — which category, not how good the score is. Validated as a
 * categorical palette against both the light and dark chart surfaces (OKLCH
 * lightness band, chroma floor, CVD separation, contrast). Every ring is also
 * labelled in the legend, so identity never rests on colour alone.
 */
const CATEGORIES = [
  { key: "performance", label: "Performance", short: "Performance", field: "lh_performance", color: "#059669" },
  { key: "accessibility", label: "Accessibility", short: "Accessibility", field: "lh_accessibility", color: "#3b82f6" },
  // "Best Practices" is the only label long enough to crowd its row, so it is
  // the only one abbreviated. The caption expands BP so the short form never
  // has to be guessed at.
  { key: "bestPractices", label: "Best Practices", short: "BP", field: "lh_best_practices", color: "#d97706" },
  { key: "seo", label: "SEO", short: "SEO", field: "lh_seo", color: "#a855f7" },
] as const;

/** True when any rendered label is an abbreviation needing expansion. */
const ABBREVIATED = CATEGORIES.filter((c) => c.short !== c.label);

/** Google's published Lighthouse bands. */
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

/**
 * The score, graded against Google's bands.
 *
 * Replaces Bklit's `LegendValue` because that renders one class for every row,
 * and the grade colour has to vary per row. `showPercentage` is also omitted
 * deliberately: the legend computes `value / maxValue * 100`, and maxValue is
 * 100 here, so it would print "84" beside "84%".
 */
function ScoreValue() {
  const { item } = useLegendItem();
  return (
    <span
      className={cn(
        "ml-auto text-lg font-semibold tabular-nums",
        VERDICT_STYLES[scoreVerdict(item.value)]
      )}
    >
      {Math.round(item.value)}
    </span>
  );
}

interface LighthouseRingsProps {
  row: CwvRow | null;
}

/**
 * Lighthouse category scores as four independent progress rings.
 *
 * WHY RINGS RATHER THAN A RADAR. `RingChart` draws concentric arcs, each
 * scaled `value / maxValue` independently of the others. That was the exact
 * reason it was REJECTED for the brand split in 11c — brand, non-brand and
 * anonymized are parts of one whole and must visibly sum to it, which
 * independent arcs deny. Here the claim inverts: four Lighthouse categories
 * are unrelated 0-100 scores that sum to nothing, so independent arcs are the
 * honest shape. It also reads where a radar does not — on real data the scores
 * are 84/91/100/100, which draws as a near-perfect diamond whose shape carries
 * almost none of the information.
 *
 * Reads the SAME snapshot as CwvPanel and never falls back to an older row
 * that happens to have categories; see LighthouseRadar for the full rationale.
 */
export default function LighthouseRings({ row }: LighthouseRingsProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  if (!row) {
    return <EmptyState title="No Lighthouse scores collected yet" />;
  }

  const scores = CATEGORIES.map((c) => ({
    ...c,
    // NULL means never fetched; 0 is a real Lighthouse score. `?? 0` here
    // would draw a full-length "catastrophic" ring over a missing measurement.
    value: row[c.field] as number | null,
  }));

  const measured = scores.filter((s) => s.value !== null);
  const missing = scores.filter((s) => s.value === null);

  if (measured.length === 0) {
    return <EmptyState title="Lighthouse categories not measured in the latest run" />;
  }

  // Full labels: the legend has room for them. The centre overlay below uses
  // the short form instead, because there the label sits beside the score.
  const rings = measured.map((s) => ({
    label: s.label,
    value: s.value as number,
    maxValue: 100,
    color: s.color,
  }));

  const hovered = hoveredIndex === null ? null : measured[hoveredIndex];

  return (
    <div className="grid items-center gap-6 sm:grid-cols-[minmax(0,240px)_minmax(0,1fr)]">
      <div className="relative mx-auto w-full max-w-[240px]">
        <RingChart
          data={rings}
          hoveredIndex={hoveredIndex}
          onHoverChange={setHoveredIndex}
          strokeWidth={14}
          ringGap={7}
          baseInnerRadius={38}
        >
          {rings.map((r, i) => (
            <Ring key={r.label} index={i} />
          ))}
        </RingChart>

        {/* Own centre overlay rather than <RingCenter>. RingCenter only calls
            its custom renderer while a ring is hovered (`children &&
            hoveredData`) and otherwise falls back to its default, which prints
            the SUM of the rings — 375 across four Lighthouse scores, a number
            that means nothing. Driving it from our own hover state keeps the
            hole empty at rest. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-0.5"
        >
          {hovered ? (
            <>
              <span
                className={cn(
                  "text-2xl font-semibold tabular-nums",
                  VERDICT_STYLES[scoreVerdict(hovered.value as number)]
                )}
              >
                {Math.round(hovered.value as number)}
              </span>
              {/* Short form here: the centre is only as wide as the ring hole,
                  so "Best Practices" wraps into the score. */}
              <span className="text-[11px] text-muted-foreground">{hovered.short}</span>
            </>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Legend
          items={rings}
          hoveredIndex={hoveredIndex}
          onHoverChange={setHoveredIndex}
        >
          <LegendItem className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <LegendMarker />
              <LegendLabel />
              <ScoreValue />
            </div>
            <LegendProgress />
          </LegendItem>
        </Legend>

        {missing.length > 0 ? (
          <ul className="flex flex-col gap-1 px-2">
            {missing.map((m) => (
              <li
                key={m.key}
                className="flex items-center justify-between gap-2 text-sm text-muted-foreground"
              >
                <span className="flex items-center gap-2">
                  <span className="inline-block size-2.5 rounded-[2px] bg-muted" />
                  {m.label}
                </span>
                <span>Not measured</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <p className="text-xs text-muted-foreground/70 sm:col-span-2">
        {ABBREVIATED.map((c) => `${c.short} = ${c.label}. `).join("")}
        Ring colour identifies the category; the score is graded good (90+) / needs work (50-89) /
        poor. Lighthouse lab scores from a single PageSpeed Insights run — not field data, and a lab
        run varies between measurements.
        {missing.length > 0
          ? ` ${missing.map((m) => m.label).join(", ")} ${
              missing.length === 1 ? "was" : "were"
            } not returned by this run and ${missing.length === 1 ? "has" : "have"} no ring.`
          : ""}
      </p>
    </div>
  );
}
