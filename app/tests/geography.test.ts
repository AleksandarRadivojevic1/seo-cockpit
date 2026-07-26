import { describe, expect, it } from "vitest";

import {
  binLabel,
  buildCountryBreakdown,
  COUNTRY_BIN_COUNT,
  countryBin,
} from "../lib/analysis/geography";
import { lookupCountry } from "../lib/iso-3166";
import type { CountryRow } from "../lib/db";

function row(country: string, impressions: number, clicks = 0): CountryRow {
  return { country, impressions, clicks };
}

describe("countryBin", () => {
  it("separates one impression from none", () => {
    // THE test for this module. On real data six countries sit at exactly 1
    // impression while Serbia has 214; if these collapse to the same bin the
    // map reports six real markets as absences.
    expect(countryBin(0)).toBe(-1);
    expect(countryBin(1)).toBe(0);
    expect(countryBin(1)).not.toBe(countryBin(0));
  });

  it("treats a negative count as no impressions rather than a low bin", () => {
    expect(countryBin(-5)).toBe(-1);
  });

  it("places counts in ascending bins at the real boundaries", () => {
    expect([2, 3, 10, 11, 50, 51, 214].map(countryBin)).toEqual([0, 1, 1, 2, 2, 3, 3]);
  });

  it("never returns a bin beyond the palette", () => {
    for (const n of [1, 9, 99, 100_000]) {
      expect(countryBin(n)).toBeLessThan(COUNTRY_BIN_COUNT);
    }
  });
});

describe("binLabel", () => {
  it("labels the no-impressions state distinctly from the lowest bin", () => {
    expect(binLabel(-1)).toBe("No impressions");
    expect(binLabel(0)).not.toBe(binLabel(-1));
  });

  it("reads as contiguous ranges with an open top bin", () => {
    expect([0, 1, 2, 3].map(binLabel)).toEqual(["1–2", "3–10", "11–50", "51+"]);
  });
});

describe("buildCountryBreakdown", () => {
  it("sums a country's rows and ranks by impressions", () => {
    const b = buildCountryBreakdown([row("srb", 200, 30), row("deu", 3), row("srb", 14, 3)]);

    expect(b.countries.map((c) => c.code)).toEqual(["srb", "deu"]);
    expect(b.countries[0].impressions).toBe(214);
    expect(b.countries[0].clicks).toBe(33);
    expect(b.totalImpressions).toBe(217);
    expect(b.totalClicks).toBe(33);
    expect(b.countryCount).toBe(2);
  });

  it("resolves display names and atlas keys from the ISO table", () => {
    const b = buildCountryBreakdown([row("srb", 10), row("deu", 1)]);
    expect(b.countries[0].name).toBe("Serbia");
    expect(b.countries[0].atlasKey).toBe("688");
    expect(b.countries[1].name).toBe("Germany");
  });

  it("joins Kosovo by feature name, since the atlas gives it no numeric id", () => {
    // GSC reports Kosovo as `xkk`, which is not an ISO 3166-1 assignment, and
    // world-atlas ships the geometry with no `id` at all. A numeric-only join
    // drops it silently — and it is present in this project's real data.
    const b = buildCountryBreakdown([row("xkk", 1)]);
    expect(b.countries[0].atlasKey).toBe("Kosovo");
    expect(b.unmapped).toHaveLength(0);
  });

  it("keeps a code it cannot recognise, counting it toward the total", () => {
    // GSC's `zzz` unknown-region bucket. Dropping it would shrink the
    // denominator every share is measured against.
    const b = buildCountryBreakdown([row("srb", 90), row("zzz", 10)]);

    expect(b.totalImpressions).toBe(100);
    expect(b.countries.map((c) => c.code)).toContain("zzz");
    expect(b.unmapped.map((c) => c.code)).toEqual(["zzz"]);
    expect(b.unmapped[0].name).toBe("ZZZ");
    expect(b.countries.find((c) => c.code === "srb")?.share).toBeCloseTo(0.9);
  });

  it("computes shares against the country total, which IS the site total", () => {
    // GSC does not anonymize country the way it anonymizes queries: on real
    // data these rows reconcile exactly with totals_daily, so shares sum to 1
    // and there is no unattributed remainder to carry.
    const b = buildCountryBreakdown([row("srb", 214), row("deu", 3), row("usa", 1)]);
    const sum = b.countries.reduce((acc, c) => acc + c.share, 0);
    expect(sum).toBeCloseTo(1);
  });

  it("returns an empty breakdown without dividing by zero", () => {
    const b = buildCountryBreakdown([]);
    expect(b.countries).toEqual([]);
    expect(b.totalImpressions).toBe(0);
    expect(b.countryCount).toBe(0);
  });

  it("does not count a measured-zero country toward countryCount", () => {
    const b = buildCountryBreakdown([row("srb", 5), row("deu", 0)]);
    expect(b.countryCount).toBe(1);
    expect(b.countries).toHaveLength(2);
  });
});

describe("iso-3166 table", () => {
  it("maps every country code seen in the real database", () => {
    const observed = [
      "srb", "deu", "xkk", "usa", "swe", "per",
      "hrv", "bih", "bgr", "esp", "can", "vnm",
      "uga", "mex", "ind", "col",
    ];
    for (const code of observed) {
      const iso = lookupCountry(code);
      expect(iso, `${code} should resolve`).not.toBeNull();
      expect(iso?.key, `${code} should have an atlas feature`).not.toBe("");
    }
  });

  it("preserves the atlas's zero-padded numeric ids", () => {
    // Bosnia is "070" in world-atlas. Stripping the leading zero produces a
    // key that matches no feature, and the country vanishes from the map.
    expect(lookupCountry("bih")?.key).toBe("070");
  });

  it("returns null for a code it has no entry for", () => {
    expect(lookupCountry("zzz")).toBeNull();
  });
});
