import { afterEach, describe, expect, it } from "vitest";

import { contentDispositionAttachment, internalReportUrl, reportPdfFilenameFor } from "../lib/report/pdf";

const ORIGINAL = { PORT: process.env.PORT, PW: process.env.SEO_DASHBOARD_PASSWORD };

afterEach(() => {
  if (ORIGINAL.PORT === undefined) delete process.env.PORT;
  else process.env.PORT = ORIGINAL.PORT;
  if (ORIGINAL.PW === undefined) delete process.env.SEO_DASHBOARD_PASSWORD;
  else process.env.SEO_DASHBOARD_PASSWORD = ORIGINAL.PW;
});

describe("reportPdfFilenameFor", () => {
  it("names the English PDF in English", () => {
    expect(reportPdfFilenameFor("Optika Cajs", "en", "2026-09-09", "2026-10-06")).toBe(
      "Optika Cajs - SEO report - September 9 – October 6, 2026.pdf",
    );
  });

  it("names the Serbian PDF exactly as before", () => {
    expect(reportPdfFilenameFor("Optika Cajs", "sr", "2026-09-09", "2026-10-06")).toBe(
      "Optika Cajs - SEO izveštaj - 9. septembar – 6. oktobar 2026.pdf",
    );
  });

  it("keeps a Serbian site name in an English filename, with an ASCII fallback", () => {
    const name = reportPdfFilenameFor("Optika Čajš", "en", "2026-09-09", "2026-10-06");
    expect(name).toBe("Optika Čajš - SEO report - September 9 – October 6, 2026.pdf");
    expect(contentDispositionAttachment(name)).toContain("filename*=UTF-8''");
  });
});

describe("internalReportUrl with a language", () => {
  it("adds lang when auth is off", () => {
    delete process.env.SEO_DASHBOARD_PASSWORD;
    process.env.PORT = "3000";
    expect(internalReportUrl("skedio", "http://localhost:3000/", "en")).toBe(
      "http://127.0.0.1:3000/site/skedio/report?lang=en",
    );
  });

  it("adds lang before the render token when auth is on", () => {
    process.env.SEO_DASHBOARD_PASSWORD = "pw";
    process.env.PORT = "3000";
    expect(internalReportUrl("skedio", "http://localhost:3000/", "en")).toMatch(
      /^http:\/\/127\.0\.0\.1:3000\/site\/skedio\/report\?lang=en&render=[\w-]+$/,
    );
  });
});
