import { describe, expect, it } from "vitest";

import {
  SR_LOCALE,
  formatCwvValueSr,
  formatDateSr,
  formatDecimalSr,
  formatIntSr,
  formatPercentSr,
  formatPeriodSr,
  pluralSr,
} from "../lib/report/format";

const CYRILLIC = /[Ѐ-ӿ]/;

describe("Serbian formatting", () => {
  it("pins the Latin locale tag", () => {
    // sr-RS without -Latn resolves to Cyrillic ("јул"). Verified against
    // Node's ICU on 2026-07-27. Neither client site uses Cyrillic.
    expect(SR_LOCALE).toBe("sr-Latn-RS");
  });

  it("formats decimals with a comma, not a point", () => {
    expect(formatDecimalSr(5.3)).toBe("5,3");
    expect(formatDecimalSr(30.45)).toBe("30,5");
  });

  it("formats integers without a decimal part", () => {
    expect(formatIntSr(223)).toBe("223");
    expect(formatIntSr(0)).toBe("0");
  });

  it("formats percentages with a comma", () => {
    expect(formatPercentSr(0.753)).toBe("75,3%");
  });

  it("formats dates in Serbian Latin", () => {
    const out = formatDateSr("2026-07-23");
    expect(out).toBe("23. jul 2026.");
    expect(out).not.toMatch(CYRILLIC);
  });

  it("collapses a period inside one month to a single month name", () => {
    expect(formatPeriodSr("2026-07-07", "2026-07-23")).toBe("7–23. jul 2026.");
  });

  it("spells both months when a period spans two", () => {
    expect(formatPeriodSr("2026-06-30", "2026-07-23")).toBe("30. jun – 23. jul 2026.");
  });

  it("spells both years when a period spans two", () => {
    expect(formatPeriodSr("2025-12-28", "2026-01-05")).toBe(
      "28. decembar 2025. – 5. januar 2026."
    );
  });

  it("selects the three Serbian plural forms", () => {
    const forms: [string, string, string] = ["klik", "klika", "klikova"];
    expect(pluralSr(1, forms)).toBe("klik");
    expect(pluralSr(33, forms)).toBe("klika");
    expect(pluralSr(5, forms)).toBe("klikova");
    expect(pluralSr(161, forms)).toBe("klik");
    expect(pluralSr(168, forms)).toBe("klikova");
    expect(pluralSr(0, forms)).toBe("klikova");
  });

  it("never emits Cyrillic from any formatter", () => {
    const all = [
      formatIntSr(223),
      formatDecimalSr(5.3),
      formatPercentSr(0.75),
      formatDateSr("2026-01-15"),
      formatPeriodSr("2026-01-15", "2026-02-03"),
    ].join(" ");
    expect(all).not.toMatch(CYRILLIC);
  });

  it("formats Core Web Vitals values with a decimal comma", () => {
    // The dashboard's formatMetricValue uses toFixed(3) and emits `0.000`.
    // A decimal point in the client's PDF was found by proofreading the
    // printed document, so it gets a test here.
    expect(formatCwvValueSr(0, "cls")).toBe("0,000");
    expect(formatCwvValueSr(0.083, "cls")).toBe("0,083");
    expect(formatCwvValueSr(3751, "lcp")).not.toContain(".000");
    expect(formatCwvValueSr(3751, "lcp")).toContain("ms");
    expect(formatCwvValueSr(212.6, "inp")).toBe("213 ms");
  });

  it("groups milliseconds the Serbian way and keeps the fraction comma-separated", () => {
    // In Serbian the dot is the THOUSANDS separator, so `4.991 ms` is right
    // and `4,991 ms` would read as a fraction. The two separators are
    // swapped relative to English, which is why only the fractional part
    // may carry a comma.
    expect(formatCwvValueSr(4991, "lcp")).toBe("4.991 ms");
    expect(formatCwvValueSr(0.083, "cls")).toBe("0,083");
    for (const s of [
      formatCwvValueSr(0.083, "cls"),
      formatCwvValueSr(4991, "lcp"),
      formatCwvValueSr(212, "inp"),
    ]) {
      expect(s).not.toMatch(CYRILLIC);
    }
  });

  it("parses ISO dates as UTC, not local time", () => {
    // A local-time parse shifts the day backwards in any timezone west of
    // Greenwich, which would silently misdate every report period.
    expect(formatDateSr("2026-07-01")).toBe("1. jul 2026.");
    expect(formatDateSr("2026-01-01")).toBe("1. januar 2026.");
  });
});
