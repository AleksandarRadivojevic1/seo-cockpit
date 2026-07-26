import EmptyState from "./EmptyState";
import { STRIKING_MAX_POS, STRIKING_MIN_POS } from "../lib/analysis/signals";
import type { SignalEntry } from "../lib/analysis/signals";
import type { SiteSummary } from "../lib/portfolio";

type DataState = SiteSummary["dataState"];

interface StrikingTableProps {
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
 * message. "Collected, and no query sits in the band" is a *finding* — it
 * tells Alex his queries are on page 1 or buried past page 2. "Nothing was
 * collected" tells him the pipeline hasn't reached this site. Rendering the
 * first as the second is the bug this project has now hit four times.
 */
function StrikingEmpty({ dataState }: { dataState: DataState }) {
  if (dataState === "not-collected") {
    return <EmptyState title="Not collected yet" />;
  }
  if (dataState === "zero") {
    return <EmptyState title="No impressions in the last 28 days" />;
  }
  return (
    <EmptyState
      title={`No queries in striking distance`}
      description={`Nothing currently ranks between positions ${STRIKING_MIN_POS} and ${STRIKING_MAX_POS}.`}
    />
  );
}

/**
 * Queries ranked by remaining upside — the per-site money view.
 *
 * Opportunity is shown as a bar relative to the top-scoring row, never as a
 * number: the score is `impressions × gapToPage1 × (1 − ctr)`, which is
 * unbounded and unitless, so a printed "912.4" would imply a precision and
 * an absolute scale it does not have. The three inputs that produce it sit
 * in the same row, so the ranking stays explainable from what's on screen.
 */
export default function StrikingTable({ entries, dataState }: StrikingTableProps) {
  if (entries.length === 0) {
    return <StrikingEmpty dataState={dataState} />;
  }

  const ranked = [...entries].sort((a, b) => b.score - a.score);
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
