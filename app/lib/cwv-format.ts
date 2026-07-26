export type MetricVerdict = "good" | "needs-work" | "poor" | "not-measured";

export type MetricKey = "lcp" | "inp" | "cls";

/** Core Web Vitals "good" / "needs improvement" p75 thresholds. */
const THRESHOLDS: Record<MetricKey, { good: number; poor: number }> = {
  lcp: { good: 2500, poor: 4000 },
  inp: { good: 200, poor: 500 },
  cls: { good: 0.1, poor: 0.25 },
};

const VERDICT_LABEL: Record<MetricVerdict, string> = {
  good: "good",
  "needs-work": "needs work",
  poor: "poor",
  "not-measured": "not measured",
};

/**
 * Verdict for one metric.
 *
 * `null` is "not-measured" and deliberately NOT a verdict. A zero, by
 * contrast, is a real measurement and usually the best possible one — a
 * CLS of 0 means nothing shifted. Collapsing the two (via `!value` or
 * `?? 0`) would print "good" over metrics nobody measured, which is the
 * more dangerous direction of this project's recurring bug.
 *
 * Shared by the on-screen panel and the client-facing proposal markdown so
 * the two can never disagree about what a number means.
 */
export function metricVerdict(value: number | null, metric: MetricKey): MetricVerdict {
  if (value === null) return "not-measured";
  const { good, poor } = THRESHOLDS[metric];
  return value <= good ? "good" : value <= poor ? "needs-work" : "poor";
}

/** Human-readable verdict, for prose rather than a coloured pill. */
export function metricVerdictFor(value: number | null, metric: MetricKey): string {
  return VERDICT_LABEL[metricVerdict(value, metric)];
}

export function formatMetricValue(value: number | null, metric: MetricKey): string {
  if (value === null) return "Not measured";
  if (metric === "cls") return value.toFixed(3);
  return `${Math.round(value)} ms`;
}
