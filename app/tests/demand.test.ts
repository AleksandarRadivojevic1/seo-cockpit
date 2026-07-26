import { describe, expect, it } from "vitest";

import { buildDemandBreakdown, classifyIntent } from "../lib/analysis/demand";
import type { DemandRow } from "../lib/db";

function row(keyword: string, overrides: Partial<DemandRow> = {}): DemandRow {
  return {
    keyword,
    source: "autocomplete",
    seed: "s",
    suggestRank: 0,
    risingPct: null,
    risingLabel: null,
    topValue: null,
    volume: null,
    ...overrides,
  };
}

describe("classifyIntent", () => {
  it("recognises buying signals and question openers", () => {
    expect(classifyIntent("kontaktna sociva cena")).toBe("commercial");
    expect(classifyIntent("kako odabrati naocare")).toBe("question");
    expect(classifyIntent("optika leskovac")).toBe("local");
    expect(classifyIntent("naocare za sunce")).toBe("other");
  });

  it("classifies regardless of diacritics", () => {
    expect(classifyIntent("kontaktna sočiva cena")).toBe("commercial");
    expect(classifyIntent("zašto nositi naočare")).toBe("question");
  });
});

describe("buildDemandBreakdown", () => {
  it("treats a diacritic variant of a ranked query as covered, not a gap", () => {
    // THE test for this module. GSC reports whichever spelling was typed and
    // autocomplete returns both, so raw string comparison would report a
    // keyword as missing while the site already ranks for it.
    const b = buildDemandBreakdown([row("tečnost za sočiva")], ["tecnost za sociva"]);
    expect(b.gaps).toHaveLength(0);
    expect(b.covered).toBe(1);
  });

  it("keeps keywords the site does not rank for", () => {
    const b = buildDemandBreakdown([row("kontaktna sociva cena")], ["optika cajs"]);
    expect(b.gaps.map((g) => g.keyword)).toEqual(["kontaktna sociva cena"]);
    expect(b.byIntent.commercial).toBe(1);
  });

  it("sorts Breakout above any numeric percentage", () => {
    // Google withholds a number for Breakout precisely because growth is
    // off-scale. Sorting it below a plain percentage would invert the signal.
    const b = buildDemandBreakdown(
      [
        row("big pct", { risingPct: 900, risingLabel: "+900%" }),
        row("breakout term", { risingPct: null, risingLabel: "Breakout" }),
      ],
      []
    );
    expect(b.gaps[0].keyword).toBe("breakout term");
  });

  it("ranks commercial intent above other intents", () => {
    const b = buildDemandBreakdown(
      [row("kako nesto"), row("nesto cena"), row("plain term")],
      []
    );
    expect(b.gaps[0].intent).toBe("commercial");
  });

  it("does not treat a missing suggestRank as rank zero", () => {
    // Null sorting as 0 would rank an unmeasured term at the very top.
    const b = buildDemandBreakdown(
      [row("unmeasured", { suggestRank: null }), row("measured", { suggestRank: 5 })],
      []
    );
    expect(b.gaps[0].keyword).toBe("measured");
  });

  it("deduplicates keywords that differ only by diacritics", () => {
    const b = buildDemandBreakdown([row("sočiva"), row("sociva")], []);
    expect(b.gaps).toHaveLength(1);
    expect(b.totalDiscovered).toBe(1);
  });

  it("reports not-collected distinctly from zero gaps", () => {
    // "Nothing discovered yet" and "everything discovered is covered" are
    // different statements and must not render the same way.
    expect(buildDemandBreakdown([], []).notCollected).toBe(true);
    expect(buildDemandBreakdown([row("x")], ["x"]).notCollected).toBe(false);
  });

  it("never invents a volume", () => {
    const b = buildDemandBreakdown([row("x")], []);
    expect(b.gaps[0].volume).toBeNull();
  });
});
