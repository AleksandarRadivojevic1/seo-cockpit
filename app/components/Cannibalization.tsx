import EmptyState from "./EmptyState";
import type { CannibalizationBreakdown } from "../lib/analysis/cannibalization";

/**
 * Queries where this site has more than one page competing, splitting clicks
 * and impressions. Canonical = the page that should win (most clicks); the
 * others are candidates to consolidate or redirect. Ranked by impressions at
 * stake. Sourced from the rolling 28-day query x page snapshot.
 *
 * The empty states are deliberately distinct: "not collected yet" (no snapshot
 * for this site) must never read the same as "no cannibalized queries" (a
 * collected snapshot with nothing competing).
 */
export default function Cannibalization({
  breakdown,
}: {
  breakdown: CannibalizationBreakdown;
}) {
  if (breakdown.notCollected) {
    return <EmptyState title="Cannibalization not collected yet" />;
  }
  if (breakdown.items.length === 0) {
    return <EmptyState title="No cannibalized queries" />;
  }
  return (
    <section className="space-y-4">
      {breakdown.items.map((item) => (
        <div key={item.query} className="rounded-lg border p-4">
          <div className="flex items-baseline justify-between gap-4">
            <h3 className="font-medium">{item.query}</h3>
            <span className="text-sm text-muted-foreground">
              {item.impressionsAtStake} impressions at stake
            </span>
          </div>
          <p className="mt-2 text-sm">
            <span className="text-muted-foreground">Should win: </span>
            <span className="break-all font-mono">{item.canonical.page}</span>{" "}
            ({item.canonical.clicks} clicks, pos {item.canonical.position.toFixed(1)})
          </p>
          <ul className="mt-1 space-y-1 text-sm text-muted-foreground">
            {item.competitors.map((c) => (
              <li key={c.page} className="break-all font-mono">
                {c.page} — {c.impressions} impr, pos {c.position.toFixed(1)}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
