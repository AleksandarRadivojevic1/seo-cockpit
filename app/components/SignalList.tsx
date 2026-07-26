import EmptyState from "./EmptyState";
import type { SignalEntry } from "../lib/analysis/signals";

/** Which field of a SignalEntry this list ranks and displays. */
export type SignalMetric = "impressionsDelta" | "positionDelta" | "impressions";

interface SignalListProps {
  title: string;
  entries: SignalEntry[];
  metric: SignalMetric;
  emptyMessage: string;
}

/** Rows shown before collapsing into a "+N more" line. */
const VISIBLE_ROWS = 10;

// U+2212 MINUS SIGN, not a hyphen: it aligns with digits in tabular-nums
// and reads as arithmetic rather than as a dash in a keyword.
const MINUS = "−";

function signed(value: number): string {
  return value < 0 ? `${MINUS}${Math.abs(value)}` : `+${value}`;
}

/**
 * Renders one entry's metric.
 *
 * `impressions` is deliberately unsigned: it's used for the emerging list,
 * whose queries are absent from the prior window, so their deltas are null
 * by construction. Rendering "+0" there would claim no change, and "+null"
 * would be nonsense — the honest figure is the raw impression count.
 */
function metricLabel(entry: SignalEntry, metric: SignalMetric): string {
  if (metric === "impressions") {
    return `${entry.impressions}`;
  }
  if (metric === "positionDelta") {
    const delta = entry.positionDelta ?? 0;
    return `${signed(Number(delta.toFixed(1)))} spots`;
  }
  return signed(entry.impressionsDelta ?? 0);
}

function metricValue(entry: SignalEntry, metric: SignalMetric): number {
  if (metric === "impressions") return entry.impressions;
  if (metric === "positionDelta") return entry.positionDelta ?? 0;
  return entry.impressionsDelta ?? 0;
}

/**
 * A compact ranked list of queries for one signal (rising, climbing,
 * emerging, declining).
 *
 * Deliberately generic over the metric rather than four near-identical
 * components: the only real difference between these lists is which number
 * they rank by and how it reads.
 */
export default function SignalList({ title, entries, metric, emptyMessage }: SignalListProps) {
  // Sort by absolute magnitude so a declining list leads with the biggest
  // drop rather than the smallest.
  const ranked = [...entries].sort(
    (a, b) => Math.abs(metricValue(b, metric)) - Math.abs(metricValue(a, metric))
  );
  const visible = ranked.slice(0, VISIBLE_ROWS);
  const hidden = ranked.length - visible.length;

  return (
    <section className="flex flex-col rounded-xl border border-border bg-card p-4 text-card-foreground shadow-sm">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {title}
        </h2>
        {entries.length > 0 && (
          <span className="text-xs tabular-nums text-muted-foreground">{entries.length}</span>
        )}
      </div>

      {visible.length === 0 ? (
        <EmptyState title={emptyMessage} />
      ) : (
        <ul className="mt-2 flex flex-col">
          {visible.map((row) => (
            <li
              key={row.query}
              className="flex items-baseline justify-between gap-3 border-b border-border/50 py-1.5 text-sm last:border-0"
            >
              <span className="min-w-0 truncate text-foreground">{row.query}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {metricLabel(row, metric)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {hidden > 0 && (
        <p className="pt-2 text-xs text-muted-foreground">{hidden} more</p>
      )}
    </section>
  );
}
