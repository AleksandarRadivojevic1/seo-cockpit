"use client";

import { curveMonotoneX } from "@visx/curve";

import { Area, AreaChart } from "./charts/area-chart";
import { Grid } from "./charts/grid";
import { ChartTooltip } from "./charts/tooltip";
import { XAxis } from "./charts/x-axis";
import { YAxis } from "./charts/y-axis";

const CLICKS_STROKE = "oklch(0.74 0.15 165)";

export interface PortfolioPoint {
  date: string;
  /** null = no site collected that date; a real 0 is a measured zero. */
  clicks: number | null;
  [key: string]: unknown;
}

interface PortfolioTrendProps {
  data: PortfolioPoint[];
}

/**
 * Portfolio-wide clicks over the trailing window.
 *
 * One series, one axis — unlike the per-site chart this is not trying to
 * compare two magnitudes, so a second scale would add chrome without
 * adding meaning.
 *
 * `aspectRatio=""` is required, not optional: AreaChart declares
 * `aspectRatio = "2 / 1"` as a default parameter, so omitting the prop
 * still applies 2/1 and the chart overflows its sized parent. See
 * TrendChart.tsx for the full note.
 */
export default function PortfolioTrend({ data }: PortfolioTrendProps) {
  return (
    <div className="h-48 w-full sm:h-56">
      <AreaChart
        aspectRatio=""
        className="h-full"
        data={data}
        margin={{ top: 16, right: 16, bottom: 28, left: 40 }}
        status="ready"
        xDataKey="date"
      >
        <Grid horizontal />
        <XAxis />
        <YAxis numTicks={4} />
        <ChartTooltip />
        <Area
          curve={curveMonotoneX}
          dataKey="clicks"
          fill={CLICKS_STROKE}
          fillOpacity={0.22}
          stroke={CLICKS_STROKE}
        />
      </AreaChart>
    </div>
  );
}
