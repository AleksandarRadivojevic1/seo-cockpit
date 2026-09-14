import type { ClassifiedUserSite } from "../lib/pendingSites";
import { removeSite } from "../app/sites/actions";

/**
 * Dashboard-added sites that have not yet been collected — shown so a
 * just-added site is visibly acknowledged before the nightly run picks it up,
 * and so a run that failed (e.g. the service account lacks access) surfaces its
 * error. Collected sites are filtered out; they appear via the normal SiteStrip.
 */
export default function PendingSites({ entries }: { entries: ClassifiedUserSite[] }) {
  const shown = entries.filter((e) => e.status !== "collected");
  if (shown.length === 0) return null;

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Awaiting collection
      </h2>
      <ul className="flex flex-col gap-2">
        {shown.map((e) => (
          <li
            key={e.site.slug}
            className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-3 text-sm"
          >
            <div className="flex min-w-0 flex-col">
              <span className="font-medium text-card-foreground">{e.site.displayName}</span>
              <span className="truncate text-muted-foreground">{e.site.property}</span>
              {e.status === "pending" ? (
                <span className="text-muted-foreground/70">
                  Pending — collects on the next nightly run (03:00 UTC).
                </span>
              ) : (
                <span className="text-destructive">Failed: {e.error}</span>
              )}
            </div>
            <form action={removeSite}>
              <input type="hidden" name="slug" value={e.site.slug} />
              <button
                type="submit"
                className="shrink-0 text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
              >
                Remove
              </button>
            </form>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground/70">
        Removing stops future collection; already-collected history is kept.
      </p>
    </section>
  );
}
