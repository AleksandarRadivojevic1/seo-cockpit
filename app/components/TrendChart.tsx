"use client";

import { curveMonotoneX } from "@visx/curve";

import { chartCssVars } from "./charts/chart-context";
import { Grid } from "./charts/grid";
import { Line, LineChart } from "./charts/line-chart";
import { XAxis } from "./charts/x-axis";
import { YAxis } from "./charts/y-axis";

// Bklit's palette is greyscale by design (globals.css sets --chart-1/--chart-2
// at chroma 0), so two series drawn from it differ only in lightness and are
// indistinguishable at 2px on a dark background. Clicks gets a real accent --
// it is the lead metric on the overview card too -- and impressions stays the
// muted grey. Both chosen to hold up in light and dark themes.
const CLICKS_STROKE = "oklch(0.74 0.15 165)";
const IMPRESSIONS_STROKE = chartCssVars.lineSecondary;

export interface TrendPoint {
  /** ISO "YYYY-MM-DD". */
  date: string;
  /**
   * `null` means no totals_daily row exists for this date (not collected);
   * a real 0 means a row exists and measured zero. The two must render
   * differently -- see the `defined` accessor patched into
   * charts/line.tsx and charts/series-path-utils.ts, which turns a `null`
   * entry into a break in the line instead of a drop to the axis.
   */
  clicks: number | null;
  impressions: number | null;
  // LineChart's data prop is Record<string, unknown>[] (it accepts
  // arbitrary series shapes); this index signature is just satisfying that
  // looser vendored type, not an invitation to stash extra fields here.
  [key: string]: unknown;
}

interface TrendChartProps {
  data: TrendPoint[];
}

/**
 * Clicks + impressions over the trailing window, built on the vendored
 * Bklit line chart. Impressions render on a secondary y-axis (`yAxisId`)
 * since it usually dwarfs clicks by an order of magnitude -- sharing one
 * axis would flatten the clicks line to the baseline.
 */
export default function TrendChart({ data }: TrendChartProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: CLICKS_STROKE }}
          />
          Clicks
        </span>
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: IMPRESSIONS_STROKE }}
          />
          Impressions (right axis)
        </span>
      </div>

      <LineChart
        aspectRatio="2.4 / 1"
        data={data}
        margin={{ top: 20, right: 52, bottom: 32, left: 44 }}
        status="ready"
        xDataKey="date"
      >
        <Grid horizontal />
        <XAxis />
        {/* Without axis labels a dual-scale chart is actively misleading: clicks
            (max ~3) and impressions (max ~20) get drawn at comparable heights
            with nothing to tell you the scales differ. */}
        <YAxis numTicks={4} />
        <YAxis numTicks={4} orientation="right" yAxisId="right" />
        {/* curveMonotoneX, never curveNatural (the vendored default): these
            series are mostly zeros with isolated spikes, and a natural spline
            overshoots between such points -- inventing peaks and dipping below
            zero, which is impossible for a click count. Monotone stays bounded
            by its data. */}
        <Line curve={curveMonotoneX} dataKey="clicks" stroke={CLICKS_STROKE} />
        <Line
          curve={curveMonotoneX}
          dataKey="impressions"
          stroke={IMPRESSIONS_STROKE}
          yAxisId="right"
        />
      </LineChart>
    </div>
  );
}
