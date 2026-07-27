import { describe, expect, it } from "vitest";

import { SR } from "../lib/report/sr";

describe("Phase 2 report sections", () => {
  it("distinguishes never-checked from checked-but-empty for SERPs", () => {
    // "not-checked" and "empty-serp" are different claims about the world.
    expect(SR.competitorsEmpty).not.toBe(SR.competitorsEmptySerp);
  });

  it("discloses lab-vs-field measurement for Core Web Vitals", () => {
    expect(SR.cwvLab).toContain("PageSpeed Insights");
    expect(SR.cwvField).toContain("Chrome UX Report");
    expect(SR.cwvLab).not.toBe(SR.cwvField);
  });

  it("has a Serbian label for every demand intent", () => {
    for (const k of ["commercial", "local", "question", "other"] as const) {
      expect(SR.demandIntent[k].length).toBeGreaterThan(0);
    }
  });

  it("has a Serbian label for every member of MetricVerdict", () => {
    // The union has four members, not three. Indexing it with a missing
    // key would print `undefined` in a document a client keeps.
    for (const k of ["good", "needs-work", "poor", "not-measured"] as const) {
      expect(SR.cwvVerdict[k].length).toBeGreaterThan(0);
    }
  });

  it("agrees on plural form with the count it is given", () => {
    // 429 -> "other" -> "ključnih reči"; the lead sentence takes the noun
    // as an argument rather than hardcoding one form.
    expect(SR.demandLead(429, "ključnih reči")).toContain("429 ključnih reči");
  });
});
