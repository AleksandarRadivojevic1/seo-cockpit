"use client";

import { curveMonotoneX } from "@visx/curve";

import { SEGMENT_COLORS } from "./BrandRing";
import { Area, AreaChart } from "./charts/area-chart";
import { Grid } from "./charts/grid";
import { ChartTooltip } from "./charts/tooltip";
import { XAxis } from "./charts/x-axis";
import { YAxis } from "./charts/y-axis";
import type { BrandBandPoint } from "../lib/analysis/brand";

interface BrandBandChartProps {
  data: BrandBandPoint[];
}

/**
 * The band boundaries, as cumulative sums. The vendored `Area` fills from the
 * baseline up to its `dataKey`, so a stack is drawn by plotting the running
 * total for each band and painting the largest first — the smaller ones cover
 * it, and the visible slab between two boundaries is that band's value.
 *
 * `null` propagates: a day that was never collected must break every band, so
 * the whole stack disappears there rather than collapsing to the axis.
 */
interface StackedPoint extends BrandBandPoint {
  /** brand */
  band1: number | null;
  /** brand + non-brand */
  band2: number | null;
  /** brand + non-brand + anonymized === the day's real total */
  band3: number | null;
}

function stack(data: BrandBandPoint[]): StackedPoint[] {
  return data.map((point) => {
    if (point.brand === null || point.nonBrand === null || point.anonymized === null) {
      return { ...point, band1: null, band2: null, band3: null };
    }
    return {
      ...point,
      band1: point.brand,
      band2: point.brand + point.nonBrand,
      band3: point.brand + point.nonBrand + point.anonymized,
    };
  });
}

const LEGEND = [
  { key: "brand" as const, label: "Brand" },
  { key: "nonBrand" as const, label: "Non-brand" },
  { key: "anonymized" as const, label: "Anonymized" },
];

/**
 * Where a site's impressions came from, day by day.
 *
 * The companion to `BrandRing`, which answers the same question for the
 * window as a whole. The ring cannot show whether non-brand traffic — the
 * part SEO actually moves — is growing; that is the retainer question, and it
 * needs a time axis.
 *
 * The third band is the load-bearing one. Google withholds the query for rare
 * searches, so the two attributed bands cover only a quarter of optika-cajs's
 * impressions. Charting just those would draw a fraction of the site's real
 * traffic; including the unattributed remainder makes the stack's height equal
 * the impressions line on the trend chart above, so the two cannot appear to
 * contradict each other.
 */
export default function BrandBandChart({ data }: BrandBandChartProps) {
  const stacked = stack(data);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        {LEGEND.map((item) => (
          <span key={item.key} className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: SEGMENT_COLORS[item.key] }}
            />
            {item.label}
          </span>
        ))}
      </div>

      {/* Same fixed height and margins as TrendChart: the two charts stack in
          one column and are read against each other, so a different height
          would imply a different scale. */}
      <div className="h-56 w-full sm:h-64">
        <AreaChart
          aspectRatio=""
          className="h-full"
          data={stacked}
          margin={{ top: 20, right: 20, bottom: 32, left: 44 }}
          status="ready"
          xDataKey="date"
        >
          <Grid horizontal />
          <XAxis />
          <YAxis numTicks={4} />
          <ChartTooltip />
          {/* Painted largest first so each smaller band sits on top. Opaque
              fills, not translucent: overlapping alpha would make the middle
              band a blend of two colours and stop matching the ring's key. */}
          <Area
            curve={curveMonotoneX}
            dataKey="band3"
            fill={SEGMENT_COLORS.anonymized}
            fillOpacity={1}
            stroke={SEGMENT_COLORS.anonymized}
          />
          <Area
            curve={curveMonotoneX}
            dataKey="band2"
            fill={SEGMENT_COLORS.nonBrand}
            fillOpacity={1}
            stroke={SEGMENT_COLORS.nonBrand}
          />
          <Area
            curve={curveMonotoneX}
            dataKey="band1"
            fill={SEGMENT_COLORS.brand}
            fillOpacity={1}
            stroke={SEGMENT_COLORS.brand}
          />
        </AreaChart>
      </div>

      <p className="text-xs text-muted-foreground">
        Google withholds the search term for rare queries, so the anonymized band is impressions
        it counted but never attributed — not traffic that is missing.
      </p>
    </div>
  );
}
