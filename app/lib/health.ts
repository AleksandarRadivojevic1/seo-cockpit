import type { RunRow, SiteConfig } from "./db";

/**
 * Whether the collector is running at all.
 *
 * Deliberately separate from {@link SiteRunState}: this answers "did a run
 * happen", not "what happened when it did". The dangerous failure is a dead
 * scheduler, which writes no `failed` row — so every site's last run stays
 * `success` forever while the data quietly rots. Health therefore has to be
 * derived from *when a run last happened*, not from the status of whatever
 * run happened last.
 */
export type CollectorState = "ok" | "not-running" | "never-run";

/** What happened to one site on the most recent run that did occur. */
export type SiteRunState = "ok" | "failed" | "cwv-degraded" | "never-run";

export interface SiteHealth {
  site: string;
  displayName: string;
  state: SiteRunState;
  /** When that run ended (or started, if it never finished). */
  lastRunAt: string | null;
  rowsWritten: number | null;
  error: string | null;
}

export interface CollectorHealth {
  state: CollectorState;
  /** Newest run end across all sites, or null if nothing has ever run. */
  lastRunAt: string | null;
  /** The scheduled slot the verdict was measured against, ISO 8601. */
  expectedSlot: string;
  /** Hours past the grace deadline, or null when the collector is not overdue. */
  hoursOverdue: number | null;
  sites: SiteHealth[];
}

export interface ScheduleConfig {
  /** Hour of the daily run, UTC — matches collector SCHEDULE_TIMEZONE. */
  hourUtc: number;
  /** How late a run may be before it counts as missing. */
  graceHours: number;
}

const MS_PER_HOUR = 3_600_000;
const MS_PER_MINUTE = 60_000;

/**
 * "6h ago" / "18m ago" / "2d ago" for a timestamp relative to `now`.
 *
 * Takes `now` explicitly rather than reading the clock so the panel renders
 * deterministically on the server and stays testable. Coarse by design: the
 * question this answers is "is the collector keeping up", and a precise
 * duration would imply a precision the daily cadence doesn't have.
 */
export function relativeTimeFrom(iso: string, now: Date): string {
  const elapsed = now.getTime() - new Date(iso).getTime();
  if (elapsed < MS_PER_MINUTE) return "just now";
  if (elapsed < MS_PER_HOUR) return `${Math.floor(elapsed / MS_PER_MINUTE)}m ago`;
  if (elapsed < 24 * MS_PER_HOUR) return `${Math.floor(elapsed / MS_PER_HOUR)}h ago`;
  return `${Math.floor(elapsed / (24 * MS_PER_HOUR))}d ago`;
}

/**
 * The most recent scheduled slot at or before `now`.
 *
 * Rolls back to yesterday when `now` is earlier in the day than the slot —
 * otherwise every night between midnight and 03:00 would be reported as a
 * missed run.
 */
function lastExpectedSlot(now: Date, hourUtc: number): Date {
  const slot = new Date(now);
  slot.setUTCHours(hourUtc, 0, 0, 0);
  if (slot > now) {
    slot.setUTCDate(slot.getUTCDate() - 1);
  }
  return slot;
}

/** When a run last produced a timestamp: its end, or its start if it never ended. */
function runEndedAt(run: RunRow): string {
  return run.finishedAt ?? run.startedAt;
}

function resolveSiteState(run: RunRow, slot: Date): { state: SiteRunState; error: string | null } {
  if (run.status === "failed") {
    return { state: "failed", error: run.error };
  }

  if (run.status === "running") {
    // `start_run` writes 'running' and only `finish_run` clears it, so a
    // process that dies mid-run leaves this row behind forever. A recent
    // one is genuinely in flight; an old one is a crash wearing a healthy
    // status, and falling through to 'ok' would hide it.
    if (new Date(run.startedAt) >= slot) {
      return { state: "ok", error: null };
    }
    return {
      state: "failed",
      error: `Run started ${run.startedAt} and never finished`,
    };
  }

  // Task 11d records a CWV-only failure as a successful run carrying a
  // 'cwv:' error, so the search data isn't condemned along with it. Keep
  // that distinction visible rather than collapsing it into 'failed'.
  if (run.error?.startsWith("cwv:")) {
    return { state: "cwv-degraded", error: run.error };
  }

  return { state: "ok", error: run.error };
}

/**
 * Builds the overview page's collector health panel state.
 *
 * Pure: every input is passed in, including `now`, so the schedule
 * arithmetic is directly testable without freezing clocks.
 *
 * Note what this deliberately does NOT look at: `totals_daily` dates. Run
 * health and data freshness are different axes that legitimately disagree —
 * GSC's ~3-day finalization lag means a perfectly healthy run routinely
 * writes zero new rows and leaves the newest data days old. The freshness
 * badge owns that; conflating them here would cry wolf on a working
 * collector and teach Alex to ignore the panel.
 */
export function buildCollectorHealth(
  runs: RunRow[],
  configs: SiteConfig[],
  now: Date,
  schedule: ScheduleConfig
): CollectorHealth {
  const slot = lastExpectedSlot(now, schedule.hourUtc);
  const deadline = new Date(slot.getTime() + schedule.graceHours * MS_PER_HOUR);
  const runBySite = new Map(runs.map((run) => [run.site, run]));

  const sites: SiteHealth[] = configs.map((config) => {
    const run = runBySite.get(config.property);
    if (!run) {
      // Absent from collection_runs entirely: configured, never collected.
      // Not the same fact as a failure, and must not render like one.
      return {
        site: config.property,
        displayName: config.displayName,
        state: "never-run",
        lastRunAt: null,
        rowsWritten: null,
        error: null,
      };
    }

    const { state, error } = resolveSiteState(run, slot);
    return {
      site: config.property,
      displayName: config.displayName,
      state,
      lastRunAt: runEndedAt(run),
      rowsWritten: run.rowsWritten,
      error,
    };
  });

  const lastRunAt = runs.reduce<string | null>((latest, run) => {
    const ended = runEndedAt(run);
    return latest === null || ended > latest ? ended : latest;
  }, null);

  if (lastRunAt === null) {
    return {
      state: "never-run",
      lastRunAt: null,
      expectedSlot: slot.toISOString(),
      hoursOverdue: null,
      sites,
    };
  }

  const ranSinceSlot = new Date(lastRunAt) >= slot;
  const pastDeadline = now >= deadline;

  return {
    state: !ranSinceSlot && pastDeadline ? "not-running" : "ok",
    lastRunAt,
    expectedSlot: slot.toISOString(),
    hoursOverdue:
      !ranSinceSlot && pastDeadline
        ? (now.getTime() - deadline.getTime()) / MS_PER_HOUR
        : null,
    sites,
  };
}
