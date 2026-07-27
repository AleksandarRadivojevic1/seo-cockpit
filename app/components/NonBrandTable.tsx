import EmptyState from "./EmptyState";
import type { SignalEntry } from "../lib/analysis/signals";
import type { SiteSummary } from "../lib/portfolio";

type DataState = SiteSummary["dataState"];

interface NonBrandTableProps {
  entries: SignalEntry[];
  /** Drives *which* empty state renders when `entries` is empty. */
  dataState: DataState;
}

function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

/**
 * Why this panel has nothing to show.
 *
 * Three genuinely different reasons, and they must never collapse into one
 * message. "Nothing was collected" says the pipeline hasn't reached this site.
 * "No impressions" says it was measured and the site was invisible. "Every
 * query is your own name" is the strongest *finding* of the three — it means
 * the site is only found by people already looking for it, which is precisely
 * the condition the demand-gap panel exists to fix. Rendering any of these as
 * another is the bug this project has now hit four times.
 */
function NonBrandEmpty({ dataState }: { dataState: DataState }) {
  if (dataState === "not-collected") {
    return <EmptyState title="Not collected yet" />;
  }
  if (dataState === "zero") {
    return <EmptyState title="No impressions in the last 28 days" />;
  }
  return (
    <EmptyState
      title="Every query is your own brand name"
      description="Nobody found this site except by searching for it directly. See the demand panel below for what it could be ranking for."
    />
  );
}

/**
 * Non-brand queries the site ranks for, ordered by remaining upside — the
 * per-site money view.
 *
 * Opportunity is shown as a bar relative to the top-scoring row, never as a
 * number: the score is `impressions × gapToPage1 × (1 − ctr)`, which is
 * unbounded and unitless, so a printed "912.4" would imply a precision and
 * an absolute scale it does not have. The three inputs that produce it sit
 * in the same row, so the ranking stays explainable from what's on screen.
 *
 * Rows already on page 1 score 0 and sort last. They are kept rather than
 * filtered because "you already rank here" is information; an empty bar is
 * the honest rendering of "no upside left", not of "no data".
 */
export default function NonBrandTable({ entries, dataState }: NonBrandTableProps) {
  if (entries.length === 0) {
    return <NonBrandEmpty dataState={dataState} />;
  }

  const ranked = [...entries].sort((a, b) => b.score - a.score || b.impressions - a.impressions);
  const topScore = ranked[0].score;

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[34rem] text-sm">
        <thead>
          <tr className="border-b border-border text-xs text-muted-foreground">
            <th className="py-2 pr-3 text-left font-medium">Query</th>
            <th className="py-2 px-3 text-right font-medium">Impr</th>
            <th className="py-2 px-3 text-right font-medium">Pos</th>
            <th className="py-2 px-3 text-right font-medium">CTR</th>
            <th className="py-2 pl-3 text-left font-medium">Opportunity</th>
          </tr>
        </thead>
        <tbody>
          {ranked.map((row) => (
            <tr key={row.query} className="border-b border-border/50 last:border-0">
              <td className="max-w-[16rem] truncate py-2 pr-3 text-foreground">{row.query}</td>
              <td className="py-2 px-3 text-right tabular-nums text-muted-foreground">
                {row.impressions}
              </td>
              <td className="py-2 px-3 text-right tabular-nums text-muted-foreground">
                {row.position.toFixed(1)}
              </td>
              <td className="py-2 px-3 text-right tabular-nums text-muted-foreground">
                {formatPercent(row.ctr)}
              </td>
              <td className="py-2 pl-3">
                <div className="h-1.5 w-full min-w-[6rem] overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-emerald-500 dark:bg-emerald-400"
                    style={{ width: `${topScore > 0 ? (row.score / topScore) * 100 : 0}%` }}
                  />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
