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
