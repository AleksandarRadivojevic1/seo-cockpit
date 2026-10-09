import { describe, expect, it } from "vitest";

import { SR } from "../lib/report/sr";

describe("report section copy", () => {
  it("states the anonymized share rather than hiding it", () => {
    // Three quarters of optika-cajs's impressions have no query attached.
    // Presenting brand vs non-brand as the whole picture overstates what
    // is known, so the note is mandatory wherever the split appears.
    expect(SR.sourcesNote).toContain("retke upite");
    expect(SR.sourceAnonymous.length).toBeGreaterThan(0);
  });

  it("gives every section a distinct empty state", () => {
    const empties = [
      SR.opportunitiesEmpty,
      SR.movementEmpty,
      SR.pagesEmpty,
      SR.trendEmpty,
    ];
    expect(new Set(empties).size).toBe(empties.length);
  });

  it("never labels an empty section by omitting it", () => {
    for (const s of [SR.opportunitiesEmpty, SR.movementEmpty, SR.pagesEmpty]) {
      expect(s.trim().length).toBeGreaterThan(10);
    }
  });
});

describe("site speed is not part of the SEO report", () => {
  // Page speed (Core Web Vitals from CrUX, or a single PageSpeed Insights lab
  // run) describes how the site performs, not how it ranks, and the report is
  // about search. It stays on the dashboard, not in the client document.
  it("has no site-speed copy left in the report strings", () => {
    const speedKeys = Object.keys(SR).filter((k) => k.toLowerCase().startsWith("cwv"));
    expect(speedKeys).toEqual([]);
    expect(JSON.stringify(SR)).not.toMatch(/PageSpeed|Chrome UX Report|Brzina sajta/);
  });
});
