import { describe, expect, it } from "vitest";
import { classifyUserSites } from "../lib/pendingSites";
import type { UserSite } from "../lib/userSites";
import type { RunRow, SiteConfig } from "../lib/db";

const mk = (slug: string, property: string): UserSite => ({
  property,
  slug,
  displayName: slug,
  brandToken: slug,
  discoverSeeds: [],
  trendSeeds: [],
  serpLocation: null,
  addedAt: "2026-09-14T00:00:00Z",
});

describe("classifyUserSites", () => {
  it("pending when not yet in the sites table and no run", () => {
    const site = mk("a", "sc-domain:a.com");
    const out = classifyUserSites([site], [], []);
    expect(out).toEqual([{ site, status: "pending", error: null }]);
  });

  it("failed when the latest run failed", () => {
    const runs: RunRow[] = [
      {
        site: "sc-domain:a.com",
        startedAt: "x",
        finishedAt: "y",
        rowsWritten: 0,
        status: "failed",
        error: "User does not have sufficient permission",
      },
    ];
    const out = classifyUserSites([mk("a", "sc-domain:a.com")], [], runs);
    expect(out[0].status).toBe("failed");
    expect(out[0].error).toBe("User does not have sufficient permission");
  });

  it("collected when present in the sites table with a successful run", () => {
    const cfgs: SiteConfig[] = [
      { property: "sc-domain:a.com", slug: "a", displayName: "a", brandToken: "a" },
    ];
    const runs: RunRow[] = [
      {
        site: "sc-domain:a.com",
        startedAt: "x",
        finishedAt: "y",
        rowsWritten: 10,
        status: "success",
        error: null,
      },
    ];
    const out = classifyUserSites([mk("a", "sc-domain:a.com")], cfgs, runs);
    expect(out[0].status).toBe("collected");
  });
});
