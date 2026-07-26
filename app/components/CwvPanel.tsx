import EmptyState from "./EmptyState";
import { cn } from "../lib/utils";
import type { CwvRow } from "../lib/db";

export type MetricVerdict = "good" | "needs-work" | "poor" | "not-measured";

const VERDICT_STYLES: Record<MetricVerdict, string> = {
  good: "text-emerald-700 dark:text-emerald-400",
  "needs-work": "text-amber-700 dark:text-amber-400",
  poor: "text-red-700 dark:text-red-400",
  "not-measured": "text-muted-foreground",
};

/** Core Web Vitals "good"/"needs improvement" p75 thresholds. */
const THRESHOLDS = {
  lcp: { good: 2500, poor: 4000 },
  inp: { good: 200, poor: 500 },
  cls: { good: 0.1, poor: 0.25 },
} as const;

/**
 * Verdict for one metric.
 *
 * `null` is "not-measured" and is deliberately NOT a verdict. A zero, by
 * contrast, is a real measurement and usually the best possible one — a CLS
 * of 0 means nothing shifted. Collapsing the two (via `!value` or `?? 0`)
 * would print "good" over metrics nobody measured, which is the more
 * dangerous direction of this project's recurring bug.
 */
export function metricVerdict(
  value: number | null,
  metric: keyof typeof THRESHOLDS
): MetricVerdict {
  if (value === null) return "not-measured";
  const { good, poor } = THRESHOLDS[metric];
  return value <= good ? "good" : value <= poor ? "needs-work" : "poor";
}

export function formatMetric(value: number | null, metric: keyof typeof THRESHOLDS): string {
  if (value === null) return "Not measured";
  if (metric === "cls") return value.toFixed(3);
  return `${Math.round(value)} ms`;
}

interface CwvPanelProps {
  row: CwvRow | null;
}

const METRICS = [
  { key: "lcp", label: "LCP", field: "lcp_p75" },
  { key: "inp", label: "INP", field: "inp_p75" },
  { key: "cls", label: "CLS", field: "cls_p75" },
] as const;

/**
 * Core Web Vitals for the site's homepage.
 *
 * `source` matters and is shown: 'crux' is real field p75 data from actual
 * visitors, while 'psi' is a single lab run standing in for it. Presenting
 * a lab number as though it were field data would overstate what is known,
 * and every site currently falls back to PSI because none has enough
 * traffic for CrUX.
 */
export default function CwvPanel({ row }: CwvPanelProps) {
  if (!row) {
    return <EmptyState title="No Core Web Vitals collected yet" />;
  }

  const isLab = row.source === "psi";

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-3 gap-3">
        {METRICS.map(({ key, label, field }) => {
          const value = row[field] as number | null;
          const verdict = metricVerdict(value, key);
          return (
            <div key={key} className="flex flex-col gap-0.5">
              <span className="text-xs text-muted-foreground uppercase">{label}</span>
              <span className={cn("text-lg font-semibold tabular-nums", VERDICT_STYLES[verdict])}>
                {formatMetric(value, key)}
              </span>
            </div>
          );
        })}
      </div>

      <p className="text-xs text-muted-foreground/70">
        {isLab
          ? "Lab data from a single PageSpeed Insights run — this site has too little traffic for Chrome UX Report field data. INP has no lab equivalent."
          : "Field p75 from the Chrome UX Report, based on real visits."}
      </p>
    </div>
  );
}
