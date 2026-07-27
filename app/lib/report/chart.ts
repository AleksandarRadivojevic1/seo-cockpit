import { SR_LOCALE } from "./format";
import type { TrendPointSr } from "./data";

export interface TrendPaths {
  /** One `d` attribute per unbroken run of collected days. */
  segments: string[];
  max: number;
  ticks: { x: number; label: string }[];
}

const DAY_MONTH = new Intl.DateTimeFormat(SR_LOCALE, {
  day: "numeric",
  month: "long",
  timeZone: "UTC",
});

function shortDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return DAY_MONTH.format(new Date(Date.UTC(y, m - 1, d)));
}

/**
 * Builds the client report's impressions line as plain SVG path data.
 *
 * Deliberately NOT the dashboard's chart. The vendored Bklit charts draw
 * inside `@visx/responsive`'s `ParentSize`, which waits on a ResizeObserver
 * before it renders anything, and gate their entry animation on an
 * `isLoaded` flag. Neither is guaranteed to have settled when the browser
 * takes its print snapshot, so the chart can print at screen width or
 * half-drawn — silently, and differently per browser. A printed page cannot
 * use a tooltip, a hover state or an animation, so every visx feature here
 * is pure print risk for no benefit.
 *
 * `null` breaks the line; a real `0` sits on the baseline. Conflating the
 * two is this project's most-repeated defect.
 */
export function buildTrendPaths(
  points: TrendPointSr[],
  width: number,
  height: number
): TrendPaths {
  if (points.length === 0) return { segments: [], max: 0, ticks: [] };

  const values = points.map((pt) => pt.impressions).filter((v): v is number => v !== null);
  if (values.length === 0) return { segments: [], max: 0, ticks: [] };

  const max = Math.max(...values);
  const stepX = points.length > 1 ? width / (points.length - 1) : 0;
  // An all-zero series has max 0; dividing by it yields NaN and the path
  // silently disappears. Flat on the baseline is the honest render.
  const y = (v: number) => (max === 0 ? height : height - (v / max) * height);

  const segments: string[] = [];
  let current: string[] = [];

  points.forEach((pt, i) => {
    if (pt.impressions === null) {
      if (current.length > 0) segments.push(current.join(" "));
      current = [];
      return;
    }
    const px = (stepX * i).toFixed(2);
    const py = y(pt.impressions).toFixed(2);
    current.push(`${current.length === 0 ? "M" : "L"}${px},${py}`);
  });
  if (current.length > 0) segments.push(current.join(" "));

  const ticks =
    points.length > 1
      ? [
          { x: 0, label: shortDate(points[0].date) },
          { x: width, label: shortDate(points[points.length - 1].date) },
        ]
      : [{ x: 0, label: shortDate(points[0].date) }];

  return { segments, max, ticks };
}
