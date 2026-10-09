import { describe, expect, it } from "vitest";

import { reportFormat } from "../lib/report/format";

const en = reportFormat("en");
const sr = reportFormat("sr");

describe("English report formatting", () => {
  it("formats numbers the US way", () => {
    expect(en.int(1123)).toBe("1,123");
    expect(en.decimal(2.44)).toBe("2.4");
    expect(en.decimal(8.437, 2)).toBe("8.44");
    expect(en.percent(0.974)).toBe("97.4%");
    expect(en.percent(0.25)).toBe("25%");
  });

  it("writes dates month first, as UTC", () => {
    expect(en.date("2026-09-09")).toBe("September 9, 2026");
    expect(en.date("2026-01-01")).toBe("January 1, 2026");
  });

  it("collapses a period by shared month and year", () => {
    expect(en.period("2026-09-01", "2026-09-28")).toBe("September 1–28, 2026");
    expect(en.period("2026-09-09", "2026-10-06")).toBe("September 9 – October 6, 2026");
    expect(en.period("2026-12-20", "2027-01-05")).toBe("December 20, 2026 – January 5, 2027");
  });

  it("states a one-day span as that day", () => {
    expect(en.period("2026-09-09", "2026-09-09")).toBe("September 9, 2026");
  });

  it("uses two plural forms", () => {
    const clicks: [string, string, string] = ["click", "clicks", "clicks"];
    expect(en.plural(1, clicks)).toBe("click");
    expect(en.plural(2, clicks)).toBe("clicks");
    expect(en.plural(0, clicks)).toBe("clicks");
  });
});

describe("Serbian formatting through reportFormat", () => {
  it("is today's Serbian formatting", () => {
    expect(sr.int(1123)).toBe("1.123");
    expect(sr.decimal(2.44)).toBe("2,4");
    expect(sr.percent(0.974)).toBe("97,4%");
    expect(sr.date("2026-09-09")).toBe("9. septembar 2026.");
    expect(sr.period("2026-09-01", "2026-09-28")).toBe("1–28. septembar 2026.");
    expect(sr.period("2026-09-09", "2026-10-06")).toBe("9. septembar – 6. oktobar 2026.");
    expect(sr.period("2026-12-20", "2027-01-05")).toBe("20. decembar 2026. – 5. januar 2027.");
    expect(sr.plural(5, ["klik", "klika", "klikova"])).toBe("klikova");
  });
});
