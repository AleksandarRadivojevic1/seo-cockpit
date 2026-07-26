"use client";

import EmptyState from "./EmptyState";
import { BarChart } from "./charts/bar-chart";
import { Bar } from "./charts/bar";
import { BarYAxis } from "./charts/bar-y-axis";
import { ChartTooltip } from "./charts/tooltip";
import type { PageTotal } from "../lib/analysis/breakdown";
import type { SiteSummary } from "../lib/portfolio";

interface TopPagesBarProps {
  pages: PageTotal[];
  dataState: SiteSummary["dataState"];
}

const BAR_FILL = "oklch(0.74 0.15 165)";

/** Row height per bar, so the chart grows with the number of pages. */
const ROW_HEIGHT = 34;

/**
 * Strips the origin so the list reads as paths. The homepage collapses to
 * "/" rather than rendering as an empty string.
 */
export function displayPath(url: string): string {
  try {
    const { pathname, search } = new URL(url);
    return `${pathname}${search}` || "/";
  } catch {
    // page_daily stores whatever GSC returned; if it isn't a parseable URL,
    // showing it verbatim beats hiding the row.
    return url;
  }
}

/**
 * Top pages by impressions, on Bklit's bar chart.
 *
 * Horizontal orientation is load-bearing, not a style choice: the
 * categories here are URL paths, which are long and share a prefix. On a
 * vertical chart they sit under the x-axis where they must be truncated or
 * rotated to fit; horizontally they run along the y-axis with room to be
 * read. Height scales with row count so bars keep a consistent thickness
 * whether a site has three pages or eight.
 */
export default function TopPagesBar({ pages, dataState }: TopPagesBarProps) {
  if (pages.length === 0) {
    if (dataState === "not-collected") return <EmptyState title="Not collected yet" />;
    if (dataState === "zero") {
      return <EmptyState title="No impressions in the last 28 days" />;
    }
    return <EmptyState title="No page data in the last 28 days" />;
  }

  const data = pages.map((page) => ({
    page: displayPath(page.page),
    impressions: page.impressions,
    clicks: page.clicks,
  }));

  return (
    <div style={{ height: pages.length * ROW_HEIGHT + 40 }} className="w-full">
      {/* aspectRatio="" is required: BarChart declares `aspectRatio = "2 / 1"`
          as a default parameter, so omitting the prop still applies 2/1 and
          the chart overflows this sized parent. See TrendChart.tsx. */}
      <BarChart
        aspectRatio=""
        className="h-full"
        data={data}
        margin={{ top: 8, right: 16, bottom: 24, left: 148 }}
        orientation="horizontal"
        xDataKey="page"
      >
        {/* BarYAxis, NOT the time-series YAxis: that one resolves ticks
            through a time scale and throws "xScale is not a function"
            against a bar chart's band scale.

            No BarXAxis: neither bar axis is orientation-aware, so on a
            horizontal chart BarXAxis re-renders the CATEGORY labels along
            the bottom, where they overlap into an unreadable smear. The
            value axis earns little here anyway — bar length plus the
            tooltip already carry it, and the paths are the content. */}
        <BarYAxis />
        <ChartTooltip />
        <Bar dataKey="impressions" fill={BAR_FILL} />
      </BarChart>
    </div>
  );
}
