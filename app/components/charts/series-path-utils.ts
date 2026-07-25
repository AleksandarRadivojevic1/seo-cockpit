import { line as d3Line } from "d3-shape";

// biome-ignore lint/suspicious/noExplicitAny: d3 curve factory type
type CurveFactory = any;

export interface SeriesPathPoint {
  x: number;
  y: number;
  key: string;
  /**
   * False when the source datum has no numeric value for this series (no
   * row for that date, as opposed to a row whose value is really 0).
   * `seriesPathFromPoints` passes this straight to d3's `line().defined()`
   * so those points break the path instead of drawing a false line to
   * `y=0`. This is the animated-path counterpart to the `defined` accessor
   * on `<LinePath>` in `line.tsx` -- `animate` defaults to `true`, so once
   * mounted a chart renders through *this* path, not the static one, and
   * the gap fix has to live here too or it never takes effect in the
   * browser.
   */
  defined: boolean;
}

export function computeSeriesPathPoints(
  data: Record<string, unknown>[],
  xAccessor: (datum: Record<string, unknown>) => Date,
  xScale: (value: Date) => number | undefined,
  yScale: (value: number) => number | undefined,
  dataKey: string
): SeriesPathPoint[] {
  return data.map((datum, index) => {
    const xValue = xAccessor(datum);
    const yValue = datum[dataKey];
    const isDefined = typeof yValue === "number";
    return {
      x: xScale(xValue) ?? 0,
      y: isDefined ? (yScale(yValue) ?? 0) : 0,
      key: String(xValue.getTime?.() ?? index),
      defined: isDefined,
    };
  });
}

export function interpolateSeriesPathPoints(
  from: SeriesPathPoint[],
  to: SeriesPathPoint[],
  progress: number
): SeriesPathPoint[] {
  if (progress >= 1) {
    return to;
  }
  if (progress <= 0) {
    return from.length > 0 ? from : to;
  }

  const fromByKey = new Map(from.map((point) => [point.key, point]));

  return to.map((target, index) => {
    const source = fromByKey.get(target.key);
    if (source) {
      return {
        key: target.key,
        x: source.x + (target.x - source.x) * progress,
        y: source.y + (target.y - source.y) * progress,
        // Definedness is categorical (a real value vs. no row), not
        // something to blend mid-transition -- always take it from the
        // target frame.
        defined: target.defined,
      };
    }

    const previousTarget = index > 0 ? to[index - 1] : undefined;
    const previousSource = previousTarget
      ? fromByKey.get(previousTarget.key)
      : undefined;
    const nextTarget = index < to.length - 1 ? to[index + 1] : undefined;
    const nextSource = nextTarget ? fromByKey.get(nextTarget.key) : undefined;
    const anchor = previousSource ?? nextSource ?? from[0] ?? target;

    return {
      key: target.key,
      x: anchor.x + (target.x - anchor.x) * progress,
      y: anchor.y + (target.y - anchor.y) * progress,
      defined: target.defined,
    };
  });
}

export function seriesPathFromPoints(
  points: SeriesPathPoint[],
  curve: CurveFactory
): string {
  if (points.length === 0) {
    return "";
  }

  const generator = d3Line<SeriesPathPoint>()
    .x((point) => point.x)
    .y((point) => point.y)
    .defined((point) => point.defined)
    .curve(curve);

  return generator(points) ?? "";
}

export function seriesPathTransitionSignature({
  renderData,
  xAccessor,
  dataKey,
  innerWidth,
  xDomainMin,
  xDomainMax,
}: {
  renderData: Record<string, unknown>[];
  xAccessor: (datum: Record<string, unknown>) => Date;
  dataKey: string;
  innerWidth: number;
  xDomainMin: number;
  xDomainMax: number;
}): string {
  const values = renderData.map((datum) => {
    const xValue = xAccessor(datum);
    const yValue = datum[dataKey];
    return `${xValue.getTime()}:${typeof yValue === "number" ? yValue : ""}`;
  });

  return `${innerWidth}|${xDomainMin}|${xDomainMax}|${values.join(",")}`;
}
