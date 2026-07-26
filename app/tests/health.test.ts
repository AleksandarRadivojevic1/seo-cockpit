import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import HealthPanel from "../components/HealthPanel";
import { buildCollectorHealth, relativeTimeFrom } from "../lib/health";
import type { RunRow, SiteConfig } from "../lib/db";

const SITE_A = "sc-domain:alexrad.dev";
const SITE_B = "https://skedio.rs/";

const CONFIGS: SiteConfig[] = [
  { property: SITE_A, slug: "alexrad", displayName: "Alexrad", brandToken: "alexrad" },
  { property: SITE_B, slug: "skedio", displayName: "Skedio", brandToken: "skedio" },
];

// Collector fires daily at 03:00 UTC; a run may be up to 2h late before the
// panel calls it missing.
const SCHEDULE = { hourUtc: 3, graceHours: 2 };

function run(overrides: Partial<RunRow> & { site: string }): RunRow {
  return {
    startedAt: "2026-07-26T03:00:00+00:00",
    finishedAt: "2026-07-26T03:00:10+00:00",
    rowsWritten: 40,
    status: "success",
    error: null,
    ...overrides,
  };
}

/** Both sites collected successfully at today's 03:00 slot. */
function healthyRuns(): RunRow[] {
  return [run({ site: SITE_A }), run({ site: SITE_B })];
}

describe("global collector state", () => {
  it("is never-run when no run has ever been recorded", () => {
    const health = buildCollectorHealth([], CONFIGS, new Date("2026-07-26T09:48:00Z"), SCHEDULE);

    expect(health.state).toBe("never-run");
    expect(health.lastRunAt).toBeNull();
  });

  it("is ok when a run finished after the most recent expected slot", () => {
    const health = buildCollectorHealth(
      healthyRuns(),
      CONFIGS,
      new Date("2026-07-26T09:48:00Z"),
      SCHEDULE
    );

    expect(health.state).toBe("ok");
    expect(health.hoursOverdue).toBeNull();
  });

  it("is not-running when the slot passed, the grace expired, and no run came", () => {
    // The real state on 2026-07-26: last run was the previous morning's
    // manual backfill, and today's 03:00 slot came and went.
    const health = buildCollectorHealth(
      [run({ site: SITE_A, startedAt: "2026-07-25T10:30:32Z", finishedAt: "2026-07-25T10:30:42Z" })],
      CONFIGS,
      new Date("2026-07-26T09:48:00Z"),
      SCHEDULE
    );

    expect(health.state).toBe("not-running");
    expect(health.lastRunAt).toBe("2026-07-25T10:30:42Z");
    // 09:48 is 4.8h past the 05:00 deadline.
    expect(health.hoursOverdue).toBeCloseTo(4.8, 1);
  });

  it("stays ok inside the grace window before declaring a run missing", () => {
    // 04:00 is past the 03:00 slot but inside the 2h grace: the run may be
    // late or still in flight. Warning here would be crying wolf, and a
    // panel that cries wolf gets ignored.
    const health = buildCollectorHealth(
      [run({ site: SITE_A, startedAt: "2026-07-25T03:00:00Z", finishedAt: "2026-07-25T03:00:10Z" })],
      CONFIGS,
      new Date("2026-07-26T04:00:00Z"),
      SCHEDULE
    );

    expect(health.state).toBe("ok");
  });

  it("measures against yesterday's slot when now is before today's", () => {
    // 01:00 UTC: today's 03:00 slot hasn't happened yet, so the run that
    // matters is yesterday's. A naive "today at 03:00" would report every
    // night between midnight and 03:00 as a missed run.
    const health = buildCollectorHealth(
      [run({ site: SITE_A, startedAt: "2026-07-25T03:00:00Z", finishedAt: "2026-07-25T03:00:10Z" })],
      CONFIGS,
      new Date("2026-07-26T01:00:00Z"),
      SCHEDULE
    );

    expect(health.state).toBe("ok");
  });
});

describe("run health is not data freshness", () => {
  it("reports a successful run that wrote zero rows as healthy", () => {
    // LAG_DAYS = 3, so a perfectly healthy run routinely returns no new
    // rows and leaves totals_daily looking days old. The freshness badge
    // owns that axis. Rendering it here as a fault would train Alex to
    // ignore the indicator, which defeats the entire feature.
    const health = buildCollectorHealth(
      [
        run({ site: SITE_A, rowsWritten: 0 }),
        run({ site: SITE_B, rowsWritten: 0 }),
      ],
      CONFIGS,
      new Date("2026-07-26T09:48:00Z"),
      SCHEDULE
    );

    expect(health.state).toBe("ok");
    expect(health.sites.map((s) => s.state)).toEqual(["ok", "ok"]);
  });
});

describe("per-site state", () => {
  it("is failed with the recorded error when the last run failed", () => {
    const health = buildCollectorHealth(
      [run({ site: SITE_A, status: "failed", rowsWritten: 0, error: "GSC 403: forbidden" }), run({ site: SITE_B })],
      CONFIGS,
      new Date("2026-07-26T09:48:00Z"),
      SCHEDULE
    );

    const siteA = health.sites.find((s) => s.site === SITE_A);
    expect(siteA?.state).toBe("failed");
    expect(siteA?.error).toBe("GSC 403: forbidden");
  });

  it("is cwv-degraded, not failed, when only the CWV fetch failed", () => {
    // Task 11d records a CWV-only failure as status=success with a 'cwv:'
    // error, precisely so the search data isn't condemned with it. Showing
    // this site as failed would throw away that distinction.
    const health = buildCollectorHealth(
      [run({ site: SITE_A, error: "cwv: PSI timed out" }), run({ site: SITE_B })],
      CONFIGS,
      new Date("2026-07-26T09:48:00Z"),
      SCHEDULE
    );

    const siteA = health.sites.find((s) => s.site === SITE_A);
    expect(siteA?.state).toBe("cwv-degraded");
    expect(siteA?.error).toBe("cwv: PSI timed out");
  });

  it("is never-run for a configured site with no run row", () => {
    const health = buildCollectorHealth(
      [run({ site: SITE_A })],
      CONFIGS,
      new Date("2026-07-26T09:48:00Z"),
      SCHEDULE
    );

    const siteB = health.sites.find((s) => s.site === SITE_B);
    expect(siteB?.state).toBe("never-run");
    expect(siteB?.lastRunAt).toBeNull();
  });

  it("distinguishes never-run from failed", () => {
    const health = buildCollectorHealth(
      [run({ site: SITE_A, status: "failed", error: "GSC 403" })],
      CONFIGS,
      new Date("2026-07-26T09:48:00Z"),
      SCHEDULE
    );

    const failed = health.sites.find((s) => s.site === SITE_A);
    const neverRun = health.sites.find((s) => s.site === SITE_B);
    expect(failed?.state).not.toBe(neverRun?.state);
  });

  it("treats a run that started long ago and never finished as failed", () => {
    // start_run writes status='running'; if the process dies mid-run that
    // row stays 'running' forever. Falling through to 'ok' would make a
    // crashed collector look healthy.
    const health = buildCollectorHealth(
      [run({ site: SITE_A, status: "running", finishedAt: null, rowsWritten: null, startedAt: "2026-07-20T03:00:00Z" })],
      CONFIGS,
      new Date("2026-07-26T09:48:00Z"),
      SCHEDULE
    );

    const siteA = health.sites.find((s) => s.site === SITE_A);
    expect(siteA?.state).toBe("failed");
    expect(siteA?.error).toMatch(/never finished/i);
  });

  it("treats a currently in-flight run as ok", () => {
    const health = buildCollectorHealth(
      [run({ site: SITE_A, status: "running", finishedAt: null, rowsWritten: null, startedAt: "2026-07-26T03:00:05Z" })],
      CONFIGS,
      new Date("2026-07-26T03:00:30Z"),
      SCHEDULE
    );

    expect(health.sites.find((s) => s.site === SITE_A)?.state).toBe("ok");
  });
});

describe("the two axes stay separate", () => {
  it("reports the collector not-running while the site's own last run reads ok", () => {
    // This is the whole design in one assertion: 'did it run' and 'what
    // happened when it ran' are different questions, and blending them
    // would hide a dead scheduler behind three green sites.
    const health = buildCollectorHealth(
      [
        run({ site: SITE_A, startedAt: "2026-07-25T10:30:32Z", finishedAt: "2026-07-25T10:30:42Z" }),
        run({ site: SITE_B, startedAt: "2026-07-25T10:30:42Z", finishedAt: "2026-07-25T10:30:58Z" }),
      ],
      CONFIGS,
      new Date("2026-07-26T09:48:00Z"),
      SCHEDULE
    );

    expect(health.state).toBe("not-running");
    expect(health.sites.map((s) => s.state)).toEqual(["ok", "ok"]);
  });

  it("keeps the collector ok when it ran and every site failed", () => {
    const health = buildCollectorHealth(
      [
        run({ site: SITE_A, status: "failed", error: "GSC 403" }),
        run({ site: SITE_B, status: "failed", error: "GSC 403" }),
      ],
      CONFIGS,
      new Date("2026-07-26T09:48:00Z"),
      SCHEDULE
    );

    expect(health.state).toBe("ok");
    expect(health.sites.map((s) => s.state)).toEqual(["failed", "failed"]);
  });
});

describe("relativeTimeFrom", () => {
  const NOW = new Date("2026-07-26T09:48:00Z");

  it("renders sub-hour, hour and day scales", () => {
    expect(relativeTimeFrom("2026-07-26T09:30:00Z", NOW)).toBe("18m ago");
    expect(relativeTimeFrom("2026-07-26T03:48:00Z", NOW)).toBe("6h ago");
    expect(relativeTimeFrom("2026-07-24T09:48:00Z", NOW)).toBe("2d ago");
  });

  it("reads 'just now' rather than '0m ago'", () => {
    expect(relativeTimeFrom("2026-07-26T09:47:45Z", NOW)).toBe("just now");
  });
});

describe("HealthPanel", () => {
  const NOW = new Date("2026-07-26T09:48:00Z");

  function render(runs: RunRow[], now: Date = NOW): string {
    const health = buildCollectorHealth(runs, CONFIGS, now, SCHEDULE);
    return renderToStaticMarkup(createElement(HealthPanel, { health, now }));
  }

  it("renders even when everything is healthy", () => {
    // An indicator that disappears when healthy can't be told apart from one
    // that broke or was removed -- the same absence-of-signal problem the
    // panel exists to solve.
    const html = render(healthyRuns());

    expect(html).toContain("Collector");
    expect(html).not.toMatch(/not running/i);
  });

  it("names the missed slot and dates it from the slot, not the grace deadline", () => {
    // At 09:48 the 03:00 slot was 6h ago, while hoursOverdue (measured from
    // the 05:00 grace deadline) is 4.8. Reporting the latter as "missed Nh
    // ago" would understate the gap by the whole grace period.
    const html = render([
      run({ site: SITE_A, startedAt: "2026-07-25T10:30:32Z", finishedAt: "2026-07-25T10:30:42Z" }),
    ]);

    expect(html).toMatch(/not running/i);
    expect(html).toContain("03:00 UTC");
    expect(html).toContain("6h ago");
    expect(html).not.toContain("4h ago");
  });

  it("surfaces a failed site's error text rather than just a red dot", () => {
    // A failure with the reason hidden is barely better than no panel.
    const html = render([
      run({ site: SITE_A, status: "failed", rowsWritten: 0, error: "GSC 403: forbidden" }),
      run({ site: SITE_B }),
    ]);

    expect(html).toContain("GSC 403: forbidden");
  });

  it("renders a CWV-only failure differently from a full failure", () => {
    const degraded = render([run({ site: SITE_A, error: "cwv: PSI timed out" }), run({ site: SITE_B })]);
    const failed = render([run({ site: SITE_A, status: "failed", error: "GSC 403" }), run({ site: SITE_B })]);

    expect(degraded).not.toBe(failed);
    expect(degraded).toMatch(/cwv/i);
  });

  it("labels a never-run site distinctly from a failed one", () => {
    const html = render([run({ site: SITE_A, status: "failed", error: "GSC 403" })]);

    expect(html).toMatch(/never run/i);
  });
})
