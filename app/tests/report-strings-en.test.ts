import { describe, expect, it } from "vitest";

import { EN } from "../lib/report/en";
import { reportStrings } from "../lib/report/language";
import { SR } from "../lib/report/sr";

const SERBIAN_LETTERS = /[čćđšž]/i;

describe("English report strings", () => {
  it("has exactly the Serbian entries", () => {
    expect(Object.keys(EN).sort()).toEqual(Object.keys(SR).sort());
    expect(Object.keys(EN.demandIntent).sort()).toEqual(Object.keys(SR.demandIntent).sort());
  });

  it("leaves nothing empty, including plural slots and intents", () => {
    for (const [key, value] of Object.entries(EN)) {
      if (typeof value === "string") expect(value.trim(), key).not.toBe("");
      if (Array.isArray(value)) for (const form of value) expect(form.trim(), key).not.toBe("");
    }
    for (const label of Object.values(EN.demandIntent)) expect(label.trim()).not.toBe("");
  });

  it("builds its sentences around the values it is given", () => {
    expect(EN.growthLead("3 months")).toContain("3 months");
    expect(EN.noPrior("September 9, 2026")).toContain("September 9, 2026");
    expect(EN.vsPrior("25%", true)).toContain("25%");
    expect(EN.vsPrior("25%", true)).not.toBe(EN.vsPrior("25%", false));
    expect(EN.demandLead(12, "keywords")).toContain("12 keywords");
  });

  it("contains no Serbian letters outside the author's name", () => {
    const { author, ...rest } = EN;
    const sentences = [
      EN.growthLead("3 months"),
      EN.noPrior("September 9, 2026"),
      EN.vsPrior("25%", true),
      EN.vsPrior("25%", false),
      EN.demandLead(12, "keywords"),
    ].join(" ");
    expect(JSON.stringify(rest)).not.toMatch(SERBIAN_LETTERS);
    expect(sentences).not.toMatch(SERBIAN_LETTERS);
    expect(author).toBe(SR.author);
  });

  it("keeps the names and terms that are never translated", () => {
    expect(EN.authorSite).toBe(SR.authorSite);
    expect(EN.colCtr).toBe("CTR");
  });
});

describe("reportStrings", () => {
  it("returns the strings for each language", () => {
    expect(reportStrings("sr")).toBe(SR);
    expect(reportStrings("en")).toBe(EN);
  });
});
