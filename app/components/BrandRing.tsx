"use client";

import EmptyState from "./EmptyState";
import { PieChart } from "./charts/pie-chart";
import { PieSlice } from "./charts/pie-slice";
import type { BrandBreakdown } from "../lib/analysis/breakdown";

interface BrandRingProps {
  breakdown: BrandBreakdown;
}

const SEGMENT_COLORS = {
  brand: "oklch(0.74 0.15 165)",
  nonBrand: "oklch(0.72 0.13 250)",
  anonymized: "oklch(0.55 0 0)",
} as const;

interface Segment {
  key: keyof typeof SEGMENT_COLORS;
  label: string;
  value: number;
  note?: string;
}

/**
 * Brand vs non-brand vs anonymized impressions, on Bklit's pie chart.
 *
 * Deliberately PieChart and not RingChart. Bklit's ring chart draws
 * concentric progress arcs (`innerRadius + index * strokeWidth`, each its
 * own `value / maxValue`) — the activity-rings shape. That reads as three
 * independent metrics, which is exactly the wrong claim here: these three
 * numbers are parts of one whole and must visibly sum to it. A pie's
 * slices are shares of a single circle, so the geometry itself carries the
 * "these add up" meaning.
 *
 * The third segment is not decoration. GSC withholds the query for rare
 * searches, so brand + non-brand is materially LESS than the site total —
 * 75% of Optika Cajs's impressions are unattributed on real data. A
 * two-slice chart would either drop that majority or rescale the two known
 * slices to fill the circle.
 */
export default function BrandRing({ breakdown }: BrandRingProps) {
  const { brandImpressions, nonBrandImpressions, anonymizedImpressions, totalImpressions } =
    breakdown;

  if (totalImpressions === 0) {
    return <EmptyState title="No impressions in the last 28 days" />;
  }

  const segments: Segment[] = [
    { key: "brand", label: "Brand", value: brandImpressions },
    { key: "nonBrand", label: "Non-brand", value: nonBrandImpressions },
    {
      key: "anonymized",
      label: "Anonymized",
      value: anonymizedImpressions,
      note: "Google withholds the query for rare searches",
    },
  ];

  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:gap-6">
      <div className="h-32 w-32 shrink-0">
        <PieChart
          data={segments.map((segment) => ({
            label: segment.label,
            value: segment.value,
            color: SEGMENT_COLORS[segment.key],
          }))}
          innerRadius={38}
          padAngle={0.02}
          cornerRadius={2}
        >
          {segments.map((segment, index) => (
            <PieSlice key={segment.key} index={index} />
          ))}
        </PieChart>
      </div>

      <ul className="flex w-full min-w-0 flex-col gap-2">
        {segments.map((segment) => (
          <li key={segment.key} className="flex flex-col">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="flex min-w-0 items-center gap-2">
                <span
                  aria-hidden="true"
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: SEGMENT_COLORS[segment.key] }}
                />
                <span className="truncate text-foreground">{segment.label}</span>
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {segment.value}
                <span className="pl-1.5 text-xs">
                  {Math.round((segment.value / totalImpressions) * 100)}%
                </span>
              </span>
            </div>
            {segment.note && (
              <span className="pl-4 text-xs text-muted-foreground/70">{segment.note}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
