import { cn } from "../lib/utils";
import { relativeTimeFrom } from "../lib/health";
import type { CollectorHealth, CollectorState, SiteHealth, SiteRunState } from "../lib/health";
import { Badge } from "./ui/badge";

interface HealthPanelProps {
  health: CollectorHealth;
  /** Passed in rather than read from the clock, so the render is deterministic. */
  now: Date;
}

// Status semantics shadcn's neutral theme has no token for, so they stay
// explicit Tailwind colors — matching SiteCard's freshness/CWV pills. The
// two "nothing has happened yet" states use the muted token instead of a
// colour, because they are chrome states, not warnings.
const COLLECTOR_STYLES: Record<CollectorState, string> = {
  ok: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400",
  "not-running": "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400",
  "never-run": "bg-muted text-muted-foreground",
};

const SITE_STYLES: Record<SiteRunState, string> = {
  ok: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400",
  failed: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400",
  "cwv-degraded": "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400",
  "never-run": "bg-muted text-muted-foreground",
};

const SITE_LABEL: Record<SiteRunState, string> = {
  ok: "ok",
  failed: "failed",
  "cwv-degraded": "CWV only",
  "never-run": "never run",
};

/** Truncated so one long stack trace can't push the site cards off-screen. */
const MAX_ERROR_CHARS = 160;

function truncate(text: string): string {
  return text.length <= MAX_ERROR_CHARS ? text : `${text.slice(0, MAX_ERROR_CHARS - 1)}…`;
}

/**
 * The one-line summary of whether the collector is running at all.
 *
 * Kept textually separate from the per-site chips below it: this line answers
 * "did it run", they answer "what happened when it did". A dead scheduler
 * writes no failed row, so those three green chips are exactly what a broken
 * collector looks like — this line is the only thing that can say otherwise.
 */
function CollectorLine({ health, now }: HealthPanelProps) {
  if (health.state === "never-run") {
    return (
      <p className="text-sm text-muted-foreground">
        No collection run has been recorded yet.
      </p>
    );
  }

  const lastRun = health.lastRunAt
    ? `last run ${relativeTimeFrom(health.lastRunAt, now)}`
    : "never run";

  if (health.state === "not-running") {
    // Name the slot that was missed and how long ago it was, rather than
    // reporting hoursOverdue — that is measured from the grace deadline, so
    // rendering it as "missed Nh ago" would understate the gap by the whole
    // grace period. The grace window is an internal anti-crying-wolf
    // mechanism, not a number Alex needs to reason about.
    const slot = new Date(health.expectedSlot);
    const slotLabel = `${String(slot.getUTCHours()).padStart(2, "0")}:${String(
      slot.getUTCMinutes()
    ).padStart(2, "0")} UTC`;

    return (
      <p className="text-sm text-red-700 dark:text-red-400">
        Not running — no run since the {slotLabel} slot{" "}
        {relativeTimeFrom(health.expectedSlot, now)}.{" "}
        <span className="text-muted-foreground">({lastRun})</span>
      </p>
    );
  }

  const failing = health.sites.filter((s) => s.state === "failed").length;
  return (
    <p className="text-sm text-muted-foreground">
      Ran {relativeTimeFrom(health.lastRunAt!, now)} ·{" "}
      {failing === 0
        ? `all ${health.sites.length} sites ok`
        : `${failing} of ${health.sites.length} sites failing`}
    </p>
  );
}

function SiteChip({ site }: { site: SiteHealth }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span className="text-foreground">{site.displayName}</span>
      <Badge className={cn("shrink-0", SITE_STYLES[site.state])}>{SITE_LABEL[site.state]}</Badge>
    </span>
  );
}

/**
 * Collector health strip for the overview page.
 *
 * Always rendered, including when everything is fine: an indicator that
 * vanishes while healthy cannot be told apart from one that broke or was
 * removed, which is the same absence-of-signal failure the panel exists to
 * catch. When healthy it collapses to a single quiet line.
 *
 * Reports *run* health only. Data freshness is a separate axis owned by the
 * per-site freshness badge, and the two legitimately disagree: GSC's ~3-day
 * finalization lag means a healthy run routinely writes no new rows.
 */
export default function HealthPanel({ health, now }: HealthPanelProps) {
  const problems = health.sites.filter((site) => site.error !== null && site.state !== "ok");

  return (
    <section
      aria-label="Collector health"
      className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Collector
        </h2>
        <Badge className={cn("shrink-0", COLLECTOR_STYLES[health.state])}>
          {health.state === "ok" ? "Running" : health.state === "not-running" ? "Not running" : "Never run"}
        </Badge>
      </div>

      <CollectorLine health={health} now={now} />

      {health.sites.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1">
          {health.sites.map((site) => (
            <SiteChip key={site.site} site={site} />
          ))}
        </div>
      )}

      {problems.length > 0 && (
        <ul className="flex flex-col gap-1 pt-1">
          {problems.map((site) => (
            <li key={site.site} className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{site.displayName}</span>{" "}
              {truncate(site.error!)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
