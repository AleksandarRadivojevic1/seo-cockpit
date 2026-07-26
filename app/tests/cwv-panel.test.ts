import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import CwvPanel, { formatMetric, metricVerdict } from "../components/CwvPanel";
import TopPagesBar, { displayPath } from "../components/TopPagesBar";
import BrandRing from "../components/BrandRing";
import { buildBrandBreakdown } from "../lib/analysis/breakdown";
import type { CwvRow } from "../lib/db";

function cwvRow(overrides: Partial<CwvRow> = {}): CwvRow {
  return {
    site: "https://example.test/",
    url: "https://example.test/",
    captured_at: "2026-07-25T00:00:00+00:00",
    lcp_p75: 3001,
    inp_p75: null,
    cls_p75: 0,
    source: "psi",
    form_factor: "PHONE",
    ...overrides,
  };
}

describe("metricVerdict", () => {
  it("treats a measured zero as a real, good result", () => {
    // CLS 0 means nothing shifted -- the best possible outcome, and the
    // actual value on all three real sites.
    expect(metricVerdict(0, "cls")).toBe("good");
  });

  it("treats null as not-measured, never as a verdict", () => {
    // PSI has no lab INP, so inp_p75 is null for every PSI-sourced row.
    // Scoring that "good" would invent a passing grade for an unmeasured
    // metric -- the dangerous direction of the null-vs-zero bug.
    expect(metricVerdict(null, "inp")).toBe("not-measured");
  });

  it("distinguishes zero from null", () => {
    expect(metricVerdict(0, "cls")).not.toBe(metricVerdict(null, "cls"));
  });

  it("applies the standard thresholds", () => {
    expect(metricVerdict(2500, "lcp")).toBe("good");
    expect(metricVerdict(3001, "lcp")).toBe("needs-work");
    expect(metricVerdict(4966, "lcp")).toBe("poor");
  });
});

describe("formatMetric", () => {
  it("renders a measured zero as a number, not as absent", () => {
    expect(formatMetric(0, "cls")).toBe("0.000");
  });

  it("says so when a metric was not measured", () => {
    expect(formatMetric(null, "inp")).toBe("Not measured");
  });
});

describe("CwvPanel", () => {
  it("shows a zero CLS and an unmeasured INP differently", () => {
    const html = renderToStaticMarkup(createElement(CwvPanel, { row: cwvRow() }));

    expect(html).toContain("0.000");
    expect(html).toContain("Not measured");
  });

  it("discloses that PSI numbers are lab data, not field data", () => {
    const html = renderToStaticMarkup(
      createElement(CwvPanel, { row: cwvRow({ source: "psi" }) })
    );

    expect(html).toMatch(/lab data/i);
  });

  it("describes CrUX numbers as real field data instead", () => {
    const html = renderToStaticMarkup(
      createElement(CwvPanel, { row: cwvRow({ source: "crux", inp_p75: 180 }) })
    );

    expect(html).toMatch(/field p75/i);
    expect(html).not.toMatch(/lab data/i);
  });

  it("renders an empty state when nothing was collected", () => {
    const html = renderToStaticMarkup(createElement(CwvPanel, { row: null }));

    expect(html).toMatch(/no core web vitals/i);
  });
});

describe("displayPath", () => {
  it("strips the origin", () => {
    expect(displayPath("https://optikacajs.rs/kontakt")).toBe("/kontakt");
  });

  it("renders the homepage as /", () => {
    expect(displayPath("https://optikacajs.rs/")).toBe("/");
  });

  it("falls back to the raw value for an unparseable URL", () => {
    expect(displayPath("not a url")).toBe("not a url");
  });
});

describe("TopPagesBar", () => {
  it("scales bars against the top page", () => {
    const html = renderToStaticMarkup(
      createElement(TopPagesBar, {
        pages: [
          { page: "https://x.test/", clicks: 25, impressions: 200, position: 3 },
          { page: "https://x.test/b", clicks: 0, impressions: 100, position: 9 },
        ],
        dataState: "ok",
      })
    );

    expect(html).toContain("width:100%");
    expect(html).toContain("width:50%");
  });

  it("separates 'no page data' from 'not collected'", () => {
    const noPages = renderToStaticMarkup(
      createElement(TopPagesBar, { pages: [], dataState: "ok" })
    );
    const notCollected = renderToStaticMarkup(
      createElement(TopPagesBar, { pages: [], dataState: "not-collected" })
    );

    expect(noPages).toMatch(/no page data/i);
    expect(noPages).not.toBe(notCollected);
  });
});

describe("BrandRing", () => {
  it("draws and labels the anonymized remainder", () => {
    const html = renderToStaticMarkup(
      createElement(BrandRing, { breakdown: buildBrandBreakdown(40, 12, 212) })
    );

    expect(html).toMatch(/anonymized/i);
    expect(html).toContain("160");
    // The share must be of the real total, not of the attributable subset.
    expect(html).toContain("75%");
  });

  it("explains why the remainder exists", () => {
    const html = renderToStaticMarkup(
      createElement(BrandRing, { breakdown: buildBrandBreakdown(40, 12, 212) })
    );

    expect(html).toMatch(/withholds the query/i);
  });

  it("renders three arc segments, not two", () => {
    const html = renderToStaticMarkup(
      createElement(BrandRing, { breakdown: buildBrandBreakdown(40, 12, 212) })
    );

    expect(html.match(/<circle/g)).toHaveLength(3);
  });

  it("shows an empty state for a window with no impressions", () => {
    const html = renderToStaticMarkup(
      createElement(BrandRing, { breakdown: buildBrandBreakdown(0, 0, 0) })
    );

    expect(html).toMatch(/no impressions/i);
  });
});
