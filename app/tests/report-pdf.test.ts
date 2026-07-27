import { afterEach, describe, expect, it } from "vitest";

import {
  contentDispositionAttachment,
  internalReportUrl,
  pdfRenderEnv,
  reportPdfFilename,
  resolveChromium,
} from "../lib/report/pdf";

const ORIGINAL_PORT = process.env.PORT;
const ORIGINAL_CHROMIUM = process.env.CHROMIUM_PATH;

afterEach(() => {
  if (ORIGINAL_PORT === undefined) delete process.env.PORT;
  else process.env.PORT = ORIGINAL_PORT;
  if (ORIGINAL_CHROMIUM === undefined) delete process.env.CHROMIUM_PATH;
  else process.env.CHROMIUM_PATH = ORIGINAL_CHROMIUM;
});

describe("reportPdfFilename", () => {
  it("names the file after the site and the period", () => {
    expect(reportPdfFilename("Optika Cajs - SEO izveštaj", "7–23. jul 2026.")).toBe(
      "Optika Cajs - SEO izveštaj - 7–23. jul 2026.pdf"
    );
  });

  it("strips characters a filesystem would reject", () => {
    const out = reportPdfFilename('a/b\\c:d*e?f"g<h>i|j', "jul");
    expect(out).not.toMatch(/[/\\:*?"<>|]/);
    expect(out.endsWith(".pdf")).toBe(true);
  });

  it("does not leave a double extension when the period ends in a dot", () => {
    // Serbian writes a trailing dot after the year, so this is the normal
    // case, not an edge one: "…2026..pdf" looks like a bug to the client.
    expect(reportPdfFilename("Skedio", "27. jun – 23. jul 2026.")).toBe(
      "Skedio - 27. jun – 23. jul 2026.pdf"
    );
  });
});

describe("contentDispositionAttachment", () => {
  it("carries the Serbian name in the RFC 5987 parameter", () => {
    const header = contentDispositionAttachment("Optika Cajs - SEO izveštaj.pdf");
    expect(header).toContain("attachment;");
    expect(header).toContain(`filename*=UTF-8''${encodeURIComponent("Optika Cajs - SEO izveštaj.pdf")}`);
  });

  it("keeps the ASCII fallback readable rather than mangled", () => {
    const header = contentDispositionAttachment("izveštaj — Đorđe.pdf");
    const ascii = /filename="([^"]+)"/.exec(header)?.[1] ?? "";
    // đ has no combining form, so NFD alone would delete it outright.
    expect(ascii).toContain("izvestaj");
    expect(ascii).toContain("Djordje");
    expect(ascii).toMatch(/^[\x20-\x7e]*$/);
  });

  it("never emits a quote that would truncate the header", () => {
    const header = contentDispositionAttachment('we"ird.pdf');
    const ascii = /filename="([^"]+)"/.exec(header)?.[1] ?? "";
    expect(ascii).not.toContain('"');
  });
});

describe("internalReportUrl", () => {
  it("targets loopback on the port the server binds, not the request origin", () => {
    // The container publishes on a host port it cannot route back to, so
    // printing must not go out to the LAN and back.
    process.env.PORT = "3000";
    expect(internalReportUrl("optika-cajs", "http://192.168.1.156:8091/site/x/report/pdf")).toBe(
      "http://127.0.0.1:3000/site/optika-cajs/report"
    );
  });

  it("falls back to the request port when PORT is unset", () => {
    delete process.env.PORT;
    expect(internalReportUrl("skedio", "http://localhost:4000/site/x/report/pdf")).toBe(
      "http://127.0.0.1:4000/site/skedio/report"
    );
  });
});

describe("pdfRenderEnv", () => {
  it("points HOME at a writable scratch directory", () => {
    // The container runs as a bare uid with no passwd entry, so the
    // inherited HOME is "/" and chromium's crashpad handler kills the
    // browser — while still reporting exit code 0 and no PDF.
    const env = pdfRenderEnv("/tmp/seo-report-abc");
    expect(env.HOME).toBe("/tmp/seo-report-abc");
    expect(env.XDG_CONFIG_HOME?.startsWith("/tmp/seo-report-abc")).toBe(true);
    expect(env.XDG_CACHE_HOME?.startsWith("/tmp/seo-report-abc")).toBe(true);
  });

  it("keeps the rest of the environment, so PATH and PORT survive", () => {
    process.env.PORT = "3000";
    expect(pdfRenderEnv("/tmp/x").PORT).toBe("3000");
    expect(pdfRenderEnv("/tmp/x").PATH).toBe(process.env.PATH);
  });
});

describe("resolveChromium", () => {
  it("fails with an actionable message rather than a spawn ENOENT", () => {
    process.env.CHROMIUM_PATH = "/nonexistent/chromium";
    return expect(resolveChromium()).rejects.toThrow(/CHROMIUM_PATH/);
  });
});
