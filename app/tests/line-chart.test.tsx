import { createRef } from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { LineChart } from "../components/charts/line-chart";
import { Line } from "../components/charts/line";
import { TimeSeriesChartInner } from "../components/charts/time-series-chart-shell";

/**
 * Task 11u smoke test: proves `@bklit/line-chart` (installed as the Bklit
 * registry compatibility check) actually renders under this app's React 19 /
 * Tailwind v4 / Next 16 stack. Not wired into the overview page — 11c owns
 * the real charts. Dummy data only.
 */
describe("Bklit line-chart smoke test", () => {
  const data = Array.from({ length: 7 }, (_, i) => ({
    date: new Date(2026, 0, i + 1).toISOString(),
    value: i * 10,
  }));

  it("renders without throwing and produces the chart's sized wrapper markup", () => {
    // `LineChart` sizes itself via `@visx/responsive`'s `ParentSize`, which
    // needs a `ResizeObserver` measurement to know its pixel dimensions
    // before it renders the inner SVG — unavailable during a pure
    // `renderToStaticMarkup` server pass (no browser, no DOM layout). So the
    // SSR output is legitimately the 0-sized wrapper; the real SVG paints
    // after client hydration measures the parent. What this test proves is
    // narrower but real: the whole Bklit `line-chart` + `Line` component
    // tree — @visx/curve, @visx/shape, motion, chart-context, and friends —
    // imports and renders under React 19 / Next 16 without throwing.
    const html = renderToStaticMarkup(
      <LineChart data={data} xDataKey="date" status="ready">
        <Line dataKey="value" animate={false} />
      </LineChart>
    );

    expect(html.length).toBeGreaterThan(0);
    expect(html).toContain('class="relative w-full"');
    expect(html).toContain("aspect-ratio");
  });
});

/**
 * Task 11b-min HARD PREREQUISITE: a missing y-value must break the line,
 * never plot at the axis (Bklit's default via `line.tsx`'s `getY` and the
 * animated `d3-shape` generator in `series-path-utils.ts`, neither of which
 * had a `.defined()`/`defined` accessor before this task).
 *
 * `<LineChart>` can't be exercised here the way the smoke test above notes
 * -- `ParentSize` needs a `ResizeObserver` measurement unavailable under
 * `renderToStaticMarkup`, so it always yields the 0-sized wrapper. Instead
 * this renders `TimeSeriesChartInner` directly with an explicit width/height
 * (the same inner component `<LineChart>` delegates to once `ParentSize`
 * has measured), which produces the real SVG synchronously -- no
 * ResizeObserver, no effects, needed.
 */
describe("gap rendering (task 11b-min HARD PREREQUISITE)", () => {
  function renderLinePathD(data: Record<string, unknown>[], animate: boolean): string | null {
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
        <Line animate={animate} dataKey="clicks" />
      </TimeSeriesChartInner>
    );
    // The series stroke is the only <path> with a real `d` in this markup
    // (no hover, no markers, no dash tail, no reveal clip at
    // animationDuration=0) -- covers both the static `<LinePath>` branch
    // (animate=false) and the animated `d3-shape` branch (animate=true,
    // the default actually painted in a real browser after mount).
    const match = html.match(/<path[^>]*\sd="([^"]*)"/);
    return match?.[1] ?? null;
  }

  function countMoveCommands(d: string | null): number {
    return d ? (d.match(/M/g) ?? []).length : 0;
  }

  const continuousData = Array.from({ length: 5 }, (_, i) => ({
    date: new Date(2026, 0, i + 1).toISOString(),
    clicks: i * 10,
  }));

  // Index 2 is a gap between a 2-point run and a 2-point run.
  const dataWithGap = Array.from({ length: 5 }, (_, i) => ({
    date: new Date(2026, 0, i + 1).toISOString(),
    clicks: i === 2 ? null : i * 10,
  }));

  it.each([
    ["static <LinePath> branch (animate=false)", false],
    ["animated d3-shape branch (animate=true, the real default)", true],
  ])("draws one continuous segment for a gap-free series -- %s", (_label, animate) => {
    expect(countMoveCommands(renderLinePathD(continuousData, animate))).toBe(1);
  });

  it.each([
    ["static <LinePath> branch (animate=false)", false],
    ["animated d3-shape branch (animate=true, the real default)", true],
  ])(
    "breaks into more than one path segment around an interior null, instead of dropping to the axis -- %s",
    (_label, animate) => {
      expect(countMoveCommands(renderLinePathD(dataWithGap, animate))).toBeGreaterThan(1);
    }
  );
});
