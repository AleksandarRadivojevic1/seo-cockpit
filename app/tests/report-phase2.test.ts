import { describe, expect, it } from "vitest";

import { SR } from "../lib/report/sr";

describe("Phase 2 report sections", () => {
  it("distinguishes never-checked from checked-but-empty for SERPs", () => {
    // "not-checked" and "empty-serp" are different claims about the world.
    expect(SR.competitorsEmpty).not.toBe(SR.competitorsEmptySerp);
  });

  it("has a Serbian label for every demand intent", () => {
    for (const k of ["commercial", "local", "question", "other"] as const) {
      expect(SR.demandIntent[k].length).toBeGreaterThan(0);
    }
  });

  it("agrees on plural form with the count it is given", () => {
    // 429 -> "other" -> "ključnih reči"; the lead sentence takes the noun
    // as an argument rather than hardcoding one form.
    expect(SR.demandLead(429, "ključnih reči")).toContain("429 ključnih reči");
  });
});
