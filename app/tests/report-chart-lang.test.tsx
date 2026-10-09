import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import ReportChart from "../components/report/ReportChart";

const points = [
  { date: "2026-09-09", impressions: 1234, clicks: 10 },
  { date: "2026-09-10", impressions: 900, clicks: 8 },
];

describe("ReportChart language", () => {
  it("labels and numbers the chart in English", () => {
    const html = renderToStaticMarkup(<ReportChart points={points} lang="en" />);
    expect(html).toContain('aria-label="Impressions over time"');
    expect(html).toContain("1,234");
    expect(html).toContain("September 9");
  });

  it("stays Serbian by default", () => {
    const html = renderToStaticMarkup(<ReportChart points={points} />);
    expect(html).toContain('aria-label="Prikazi kroz vreme"');
    expect(html).toContain("1.234");
    expect(html).toContain("9. septembar");
  });
});
