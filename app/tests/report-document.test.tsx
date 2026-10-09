import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import LanguageSwitch from "../components/report/LanguageSwitch";
import PrintButton from "../components/report/PrintButton";
import ReportDocument from "../components/report/ReportDocument";
import type { SignalEntry } from "../lib/analysis/signals";
import type { ReportData } from "../lib/report/data";

function entry(query: string, impressions: number, position: number, ctr: number): SignalEntry {
  return {
    query,
    impressions,
    clicks: Math.round(impressions * ctr),
    position,
    ctr,
    impressionsDelta: 100,
    positionDelta: 1.5,
    score: 10,
  };
}

// Every section populated, and Serbian letters in the things that are never
// translated: the site name and the queries.
const DATA: ReportData = {
  siteName: "Optika Čajš",
  property: "https://optikacajs.rs/",
  window: { start: "2026-09-09", end: "2026-10-06" },
  measuredStart: "2026-09-09",
  measuredEnd: "2026-10-06",
  measuredDays: 28,
  hasPriorWindow: true,
  dataState: "ok",
  clicks: { recent: 1123, prior: 900, deltaPct: 24.8 },
  impressions: 45210,
  avgPosition: 8.43,
  breakdown: {
    brandImpressions: 12000,
    nonBrandImpressions: 20000,
    anonymizedImpressions: 13210,
    totalImpressions: 45210,
  },
  opportunities: [entry("naočare za sunce", 1500, 12.4, 0.012)],
  rising: [entry("kontaktna sočiva", 800, 9.1, 0.03)],
  declining: [],
  topPages: [{ page: "https://optikacajs.rs/naocare", clicks: 300, impressions: 9000, position: 5.2 }],
  trend: [
    { date: "2026-09-09", impressions: 1200, clicks: 30 },
    { date: "2026-09-10", impressions: null, clicks: null },
    { date: "2026-09-11", impressions: 1500, clicks: 41 },
  ],
  demand: {
    gaps: [
      {
        keyword: "dioptrijske naočare cena",
        intent: "commercial",
        source: "autocomplete",
        suggestRank: 1,
        risingPct: null,
        risingLabel: null,
        volume: null,
      },
    ],
    covered: 4,
    totalDiscovered: 5,
    byIntent: { commercial: 1, question: 0, local: 0, other: 0 },
    notCollected: false,
  },
  competitors: [{ domain: "diopta.rs", kind: "competitor", appearances: 5, bestPosition: 1 }],
  serpState: "ok",
  growth: {
    beforeStart: "2026-07-01",
    beforeEnd: "2026-07-30",
    afterStart: "2026-09-07",
    afterEnd: "2026-10-06",
    durationDays: 98,
    clicks: { before: 68, after: 85, deltaPct: 25 },
    impressions: { before: 569, after: 1123, deltaPct: 97.4 },
    position: { before: 12.1, after: 8.4 },
  },
};

// Text that is never translated and legitimately carries Serbian letters.
const NEVER_TRANSLATED = [
  "Optika Čajš",
  "naočare za sunce",
  "kontaktna sočiva",
  "dioptrijske naočare cena",
  "Aleksandar Radivojević",
];

const SERBIAN_WORDS = [
  "Sažetak", "Napredak", "Prikazi", "Prilike", "Kretanje", "Konkurencija",
  "izveštaj", "Najposećenije", "Tražnja", "klikova", "prikaza", "pozicija",
];

function render(lang: "sr" | "en", data: ReportData = DATA): string {
  return renderToStaticMarkup(<ReportDocument data={data} lang={lang} />);
}

describe("ReportDocument in English", () => {
  const html = render("en");

  it("declares its language and uses the English copy", () => {
    expect(html).toContain('lang="en"');
    for (const heading of ["SEO report", "Summary", "Progress", "Impressions over time",
      "Opportunities", "Movement", "Where impressions come from", "Most visited pages",
      "Demand you’re not reaching", "Competitors"]) {
      expect(html).toContain(heading);
    }
  });

  it("formats numbers and the period the US way", () => {
    expect(html).toContain("1,123");
    expect(html).toContain("45,210");
    expect(html).toContain("September 9 – October 6, 2026");
  });

  it("contains no Serbian outside names and queries", () => {
    let text = html;
    for (const kept of NEVER_TRANSLATED) text = text.split(kept).join("");
    for (const word of SERBIAN_WORDS) expect(text, word).not.toContain(word);
    expect(text).not.toMatch(/[čćđšž]/i);
  });

  it("keeps the names and queries untouched", () => {
    for (const kept of NEVER_TRANSLATED) expect(html).toContain(kept);
  });

  it("states missing data honestly, in English", () => {
    expect(render("en", { ...DATA, dataState: "not-collected" })).toContain(
      "No search data has been collected for this site yet",
    );
    expect(render("en", { ...DATA, dataState: "zero" })).toContain("a real zero");
  });
});

describe("ReportDocument in Serbian", () => {
  const html = render("sr");

  it("is today's Serbian report", () => {
    expect(html).toContain('lang="sr"');
    for (const heading of ["SEO izveštaj", "Sažetak", "Napredak", "Prikazi kroz vreme",
      "Prilike", "Kretanje", "Konkurencija"]) {
      expect(html).toContain(heading);
    }
    expect(html).toContain("1.123");
    expect(html).toContain("9. septembar – 6. oktobar 2026.");
  });
});

describe("report toolbar", () => {
  it("is only rendered when the page passes one", () => {
    expect(render("en")).not.toContain("print:hidden");
    const withToolbar = renderToStaticMarkup(
      <ReportDocument data={DATA} lang="en" toolbar={<span>tools</span>} />,
    );
    expect(withToolbar).toContain("print:hidden");
    expect(withToolbar).toContain("tools");
  });

  it("switch links to both languages and marks the current one", () => {
    const html = renderToStaticMarkup(
      <LanguageSwitch current="en" hrefFor={(l) => `/site/x/report?lang=${l}`} />,
    );
    expect(html).toContain('href="/site/x/report?lang=sr"');
    expect(html).toContain('href="/site/x/report?lang=en"');
    expect(html).toMatch(/aria-current="true"[^>]*>EN</);
  });

  it("PDF button uses the labels and link it is given", () => {
    const html = renderToStaticMarkup(
      <PrintButton
        href="/site/x/report/pdf?lang=en"
        labels={{ print: "Download PDF", busy: "Preparing PDF…", error: "Failed" }}
      />,
    );
    expect(html).toContain('href="/site/x/report/pdf?lang=en"');
    expect(html).toContain("Download PDF");
  });
});
