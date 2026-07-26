import { createRef } from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { Area } from "../components/charts/area";
import { TimeSeriesChartInner } from "../components/charts/time-series-chart-shell";

/**
 * The area chart's copy of the gap fix, and the guard that keeps it alive.
 *
 * `@bklit/area-chart` ships `area.tsx` with a `getY` that returns 0 for a
 * datum with no numeric value and no `defined` accessor on either
 * `<AreaClosed>` or `<LinePath>` — so a date with no row is drawn at the
 * axis, identical to a measured zero. On these sites most days in a window
 * are genuinely missing, so shipping that would draw a fabricated traffic
 * collapse.
 *
 * This test exists because `shadcn add @bklit/area-chart` OVERWRITES the
 * patched file with upstream's version. That already happened once to
 * `series-path-utils.ts` (silently — the equivalent line-chart test caught
 * it). If this test fails after an install, re-apply the `defined` accessor
 * in `area.tsx`; do not weaken the assertion.
 */
describe("area chart gap rendering", () => {
  function renderAreaPaths(data: Record<string, unknown>[]): string[] {
    const containerRef = createRef<HTMLDivElement>();
    const html = renderToStaticMarkup(
      <TimeSeriesChartInner
        animationDuration={0}
        chartStatus="ready"
        clipPathId="test-clip"
        containerRef={containerRef}
        data={data}
        height={200}
        lines={[{ dataKey: "clicks", stroke: "red", strokeWidth: 2 }]}
        margin={{ top: 10, right: 10, bottom: 10, left: 10 }}
        width={300}
        xDataKey="date"
      >
        <Area animate={false} dataKey="clicks" />
      </TimeSeriesChartInner>
    );
    return [...html.matchAll(/<path[^>]*\sd="([^"]*)"/g)].map((m) => m[1]);
  }

  function maxMoveCommands(paths: string[]): number {
    return paths.reduce((max, d) => Math.max(max, (d.match(/M/g) ?? []).length), 0);
  }

  const continuous = Array.from({ length: 5 }, (_, i) => ({
    date: new Date(2026, 0, i + 1).toISOString(),
    clicks: i * 10 + 5,
  }));

  // Index 2 has no row at all -- a gap, not a zero.
  const withGap = Array.from({ length: 5 }, (_, i) => ({
    date: new Date(2026, 0, i + 1).toISOString(),
    clicks: i === 2 ? null : i * 10 + 5,
  }));

  // Index 2 was measured and really was zero -- must stay connected.
  const withMeasuredZero = Array.from({ length: 5 }, (_, i) => ({
    date: new Date(2026, 0, i + 1).toISOString(),
    clicks: i === 2 ? 0 : i * 10 + 5,
  }));

  it("draws each shape as one continuous run when no day is missing", () => {
    expect(maxMoveCommands(renderAreaPaths(continuous))).toBe(1);
  });

  it("breaks the shape around a missing day instead of dropping to the axis", () => {
    expect(maxMoveCommands(renderAreaPaths(withGap))).toBeGreaterThan(1);
  });

  it("keeps a measured zero connected, unlike a missing day", () => {
    // The whole point of the fix: 0 and null must not render alike.
    expect(maxMoveCommands(renderAreaPaths(withMeasuredZero))).toBe(1);
    expect(renderAreaPaths(withMeasuredZero)).not.toEqual(renderAreaPaths(withGap));
  });
});
