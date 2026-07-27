import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import SignalList from "../components/SignalList";
import NonBrandTable from "../components/NonBrandTable";
import type { SignalEntry } from "../lib/analysis/signals";

function entry(overrides: Partial<SignalEntry> & { query: string }): SignalEntry {
  return {
    impressions: 20,
    clicks: 1,
    position: 15,
    ctr: 0.05,
    impressionsDelta: 0,
    positionDelta: 0,
    score: 100,
    ...overrides,
  };
}

function render(element: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(element);
}

describe("NonBrandTable", () => {
  it("orders rows by opportunity score, highest first", () => {
    const html = render(
      createElement(NonBrandTable, {
        entries: [
          entry({ query: "low-value", score: 10 }),
          entry({ query: "high-value", score: 900 }),
          entry({ query: "mid-value", score: 300 }),
        ],
        dataState: "ok",
      })
    );

    expect(html.indexOf("high-value")).toBeLessThan(html.indexOf("mid-value"));
    expect(html.indexOf("mid-value")).toBeLessThan(html.indexOf("low-value"));
  });

  it("shows the inputs that produce the score, so the ranking is explainable", () => {
    const html = render(
      createElement(NonBrandTable, {
        entries: [entry({ query: "sočiva cena", impressions: 42, position: 18.4, ctr: 0.024 })],
        dataState: "ok",
      })
    );

    expect(html).toContain("sočiva cena");
    expect(html).toContain("42");
    expect(html).toContain("18.4");
    expect(html).toContain("2.4%");
  });

  it("does not print the raw opportunity score as a number", () => {
    // The score is unbounded and unitless (impressions x gap x (1-ctr)), so
    // a bare "912.4" implies a precision and a scale it does not have. The
    // bar carries the ranking instead.
    const html = render(
      createElement(NonBrandTable, {
        entries: [entry({ query: "q", score: 912.4 })],
        dataState: "ok",
      })
    );

    expect(html).not.toContain("912.4");
    expect(html).not.toContain("912");
  });

  it("scales each bar against the top-scoring row", () => {
    const html = render(
      createElement(NonBrandTable, {
        entries: [entry({ query: "top", score: 400 }), entry({ query: "half", score: 200 })],
        dataState: "ok",
      })
    );

    expect(html).toContain("width:100%");
    expect(html).toContain("width:50%");
  });
});

describe("NonBrandTable empty states", () => {
  // Three different reasons a panel can be empty. Collapsing any pair would
  // repeat this project's most-repeated bug: telling Alex nothing was
  // collected when the honest answer is "collected, and every query is the
  // brand name" -- which is a finding, and on these sites the most important
  // one the dashboard can report.
  function emptyHtml(dataState: "ok" | "zero" | "not-collected"): string {
    return render(createElement(NonBrandTable, { entries: [], dataState }));
  }

  it("says every query is brand when data exists but none is non-brand", () => {
    const html = emptyHtml("ok");
    expect(html).toMatch(/own brand name/i);
    expect(html).not.toMatch(/not collected/i);
    expect(html).not.toMatch(/no impressions/i);
  });

  it("says impressions were zero when the site measured zero", () => {
    expect(emptyHtml("zero")).toMatch(/no impressions/i);
  });

  it("says not collected only when nothing was collected", () => {
    expect(emptyHtml("not-collected")).toMatch(/not collected/i);
  });

  it("renders all three reasons differently from each other", () => {
    const band = emptyHtml("ok");
    const zero = emptyHtml("zero");
    const notCollected = emptyHtml("not-collected");

    expect(new Set([band, zero, notCollected]).size).toBe(3);
  });
});

describe("SignalList", () => {
  it("renders each entry's query and its metric", () => {
    const html = render(
      createElement(SignalList, {
        title: "Rising",
        entries: [entry({ query: "optičar blizu mene", impressionsDelta: 504 })],
        metric: "impressionsDelta",
        emptyMessage: "No rising queries",
      })
    );

    expect(html).toContain("optičar blizu mene");
    expect(html).toContain("+504");
  });

  it("signs a negative delta explicitly", () => {
    const html = render(
      createElement(SignalList, {
        title: "Declining",
        entries: [entry({ query: "jeftine naočare", impressionsDelta: -756 })],
        metric: "impressionsDelta",
        emptyMessage: "No declining queries",
      })
    );

    expect(html).toContain("−756");
  });

  it("renders a position move in spots, not impressions", () => {
    const html = render(
      createElement(SignalList, {
        title: "Climbing",
        entries: [entry({ query: "naočare za računar", positionDelta: 5.3 })],
        metric: "positionDelta",
        emptyMessage: "No climbing queries",
      })
    );

    expect(html).toContain("5.3");
    expect(html).toMatch(/spot/i);
  });

  it("renders plain impressions for emerging queries, which have no delta", () => {
    // Emerging queries are absent from the prior window, so their deltas are
    // null by construction -- rendering "+null" or "+0" would both be lies.
    const html = render(
      createElement(SignalList, {
        title: "Emerging",
        entries: [entry({ query: "naočare za decu", impressions: 588, impressionsDelta: null })],
        metric: "impressions",
        emptyMessage: "No emerging queries",
      })
    );

    expect(html).toContain("588");
    expect(html).not.toContain("+null");
    expect(html).not.toContain("NaN");
  });

  it("caps the visible rows and says how many more there are", () => {
    const entries = Array.from({ length: 14 }, (_, i) =>
      entry({ query: `query-${i}`, impressionsDelta: 100 - i })
    );
    const html = render(
      createElement(SignalList, {
        title: "Rising",
        entries,
        metric: "impressionsDelta",
        emptyMessage: "No rising queries",
      })
    );

    expect(html).toContain("query-0");
    expect(html).toContain("query-9");
    expect(html).not.toContain("query-10");
    expect(html).toContain("4 more");
  });

  it("shows its empty message when there are no entries", () => {
    const html = render(
      createElement(SignalList, {
        title: "Rising",
        entries: [],
        metric: "impressionsDelta",
        emptyMessage: "No rising queries",
      })
    );

    expect(html).toContain("No rising queries");
  });
});
