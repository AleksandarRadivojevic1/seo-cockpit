import { describe, expect, it } from "vitest";

import { SR } from "../lib/report/sr";

const CYRILLIC = /[Ѐ-ӿ]/;

/** Every literal string reachable in the strings object. Functions are skipped. */
function allStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(allStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(allStrings);
  return [];
}

describe("Serbian report strings", () => {
  it("is written in Latin script throughout", () => {
    // Both client sites publish in Latin. A stray Cyrillic string would
    // read as a different language on the same page.
    for (const s of allStrings(SR)) expect(s).not.toMatch(CYRILLIC);
  });

  it("keeps the three plural forms for every counted noun", () => {
    expect(SR.clicks).toHaveLength(3);
    expect(SR.impressions).toHaveLength(3);
    expect(SR.keywords).toHaveLength(3);
  });

  it("contains no emoji", () => {
    // Standing project rule: plain professional labels only.
    const emoji = /\p{Extended_Pictographic}/u;
    for (const s of allStrings(SR)) expect(s).not.toMatch(emoji);
  });

  it("names the author and site for the header", () => {
    expect(SR.author).toBe("Aleksandar Radivojević");
    expect(SR.authorSite).toBe("alexrad.dev");
  });

  it("distinguishes never-collected from measured-zero", () => {
    // The distinction this project keeps having to re-learn: a collection
    // gap and a genuine zero must never read the same to a client.
    expect(SR.notCollected).not.toBe(SR.measuredZero);
    expect(SR.measuredZero).toContain("stvarna nula");
  });

  it("states an absent comparison rather than implying no change", () => {
    expect(SR.noPrior("7. jul 2026.")).toContain("Nema prethodnog perioda");
    expect(SR.noPrior("7. jul 2026.")).toContain("7. jul 2026.");
    expect(SR.noPrior("7. jul 2026.")).not.toBe(SR.noChange);
  });
});
