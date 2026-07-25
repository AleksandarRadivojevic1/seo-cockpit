import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { LineChart } from "../components/charts/line-chart";
import { Line } from "../components/charts/line";

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
