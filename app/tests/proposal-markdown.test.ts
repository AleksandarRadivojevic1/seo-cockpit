import { describe, expect, it } from "vitest";

import { toProposalMarkdown } from "../lib/proposalMarkdown";
import type { ProposalInput } from "../lib/proposalMarkdown";
import { buildBrandBreakdown } from "../lib/analysis/breakdown";
import type { SignalEntry } from "../lib/analysis/signals";

function entry(overrides: Partial<SignalEntry> & { query: string }): SignalEntry {
  return {
    impressions: 20,
    clicks: 1,
    position: 15,
    ctr: 0.05,
    impressionsDelta: null,
    positionDelta: null,
    score: 100,
    ...overrides,
  };
}

function input(overrides: Partial<ProposalInput> = {}): ProposalInput {
  return {
    siteName: "Optika Cajs",
    property: "https://optikacajs.rs/",
    window: { start: "2026-06-26", end: "2026-07-23" },
    dataState: "ok",
    clicks: { recent: 32, prior: 16, deltaPct: 100 },
    impressions: 212,
    avgPosition: 5.3,
    breakdown: buildBrandBreakdown(40, 12, 212),
    opportunities: [entry({ query: "tečnost za sočiva", position: 30.5, impressions: 2, score: 41 })],
    rising: [],
    declining: [],
    topPages: [{ page: "https://optikacajs.rs/", clicks: 25, impressions: 155, position: 3.1 }],
    cwv: {
      site: "https://optikacajs.rs/",
      url: "https://optikacajs.rs/",
      captured_at: "2026-07-25T00:00:00+00:00",
      lcp_p75: 3001,
      inp_p75: null,
      cls_p75: 0,
      source: "psi",
      form_factor: "PHONE",
    },
    ...overrides,
  };
}

describe("toProposalMarkdown", () => {
  it("heads the document with the site and the window it covers", () => {
    const md = toProposalMarkdown(input());

    expect(md).toContain("# Optika Cajs");
    expect(md).toContain("2026-06-26");
    expect(md).toContain("2026-07-23");
  });

  it("lists opportunities with the position and impressions behind each one", () => {
    const md = toProposalMarkdown(input());

    expect(md).toContain("tečnost za sočiva");
    expect(md).toContain("30.5");
    expect(md).toMatch(/## .*Opportunit/i);
  });

  it("states plainly when there are no opportunities rather than omitting the section", () => {
    // A findings document that silently drops empty sections lets the
    // reader assume they were never checked. Saying "none found" is a
    // finding; an absent heading is ambiguous.
    const md = toProposalMarkdown(input({ opportunities: [] }));

    expect(md).toMatch(/## .*Opportunit/i);
    expect(md).toMatch(/none|no quer/i);
  });

  it("discloses the anonymized share instead of implying the split is complete", () => {
    // 160 of 212 impressions have no query attached. A proposal that
    // presented 40/12 as the whole picture would overstate what is known
    // about this site to a client.
    const md = toProposalMarkdown(input());

    expect(md).toContain("160");
    expect(md).toMatch(/75%/);
    expect(md).toMatch(/withholds|anonymi/i);
  });

  it("marks an unmeasured metric as unmeasured, never as a passing score", () => {
    const md = toProposalMarkdown(input());

    expect(md).toMatch(/INP.*[Nn]ot measured/);
    // CLS 0 is a real, good measurement and must still appear as a number.
    expect(md).toContain("0.000");
  });

  it("does not append a redundant verdict to an unmeasured metric", () => {
    const md = toProposalMarkdown(input());

    expect(md).not.toMatch(/Not measured\*\* \(not measured\)/);
    // A measured metric still carries its verdict.
    expect(md).toMatch(/3001 ms\*\* \(needs work\)/);
  });

  it("says the CWV figures are lab data when they came from PSI", () => {
    const md = toProposalMarkdown(input());

    expect(md).toMatch(/lab/i);
  });

  it("does not claim a trend when there is no prior baseline", () => {
    const md = toProposalMarkdown(
      input({ clicks: { recent: 32, prior: 0, deltaPct: null } })
    );

    expect(md).not.toContain("+Infinity");
    expect(md).not.toContain("NaN");
    expect(md).toMatch(/no comparison|first window|no prior/i);
  });

  it("leads with a caveat when the site has not been collected", () => {
    const md = toProposalMarkdown(input({ dataState: "not-collected" }));

    expect(md).toMatch(/collection gap/i);
    // "Leads with" is the point: a caveat printed under the numbers is one
    // the reader has already formed an impression without.
    expect(md.indexOf("collection gap")).toBeLessThan(md.indexOf("## Summary"));
  });

  it("distinguishes a measured zero from missing collection", () => {
    const zero = toProposalMarkdown(input({ dataState: "zero", clicks: { recent: 0, prior: 0, deltaPct: null } }));
    const missing = toProposalMarkdown(input({ dataState: "not-collected" }));

    expect(zero).not.toBe(missing);
    expect(zero).toMatch(/no impressions/i);
  });

  it("emits no raw opportunity score, which is unitless", () => {
    const md = toProposalMarkdown(input());

    expect(md).not.toContain("41");
  });

  it("produces markdown a reader can paste without cleanup", () => {
    const md = toProposalMarkdown(input());

    expect(md.startsWith("# ")).toBe(true);
    expect(md.endsWith("\n")).toBe(true);
    expect(md).not.toMatch(/\n{3,}/); // no runs of blank lines
    expect(md).not.toContain("undefined");
    expect(md).not.toContain("[object Object]");
  });
});
