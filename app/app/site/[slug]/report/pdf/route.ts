import { formatISODateUTC } from "../../../../../lib/analysis/windows";
import { siteConfigBySlug } from "../../../../../lib/db";
import { buildReportData } from "../../../../../lib/report/data";
import { formatPeriodSr } from "../../../../../lib/report/format";
import {
  contentDispositionAttachment,
  internalReportUrl,
  renderPdf,
  reportPdfFilename,
} from "../../../../../lib/report/pdf";
import { SR } from "../../../../../lib/report/sr";

/**
 * Downloads `/site/[slug]/report` as a PDF file.
 *
 * The button on the report used to call `window.print()`, which opens the
 * browser's print dialog and leaves the client to find "Save as PDF" in it.
 * No browser API can skip that dialog, so producing an actual file means
 * printing the page server-side — see `lib/report/pdf.ts` for why that is
 * chromium rather than a PDF library.
 *
 * The report data is loaded here only to name the file. The bytes come from
 * rendering the real page, so this route cannot disagree with what the
 * client sees on screen.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: RouteContext<"/site/[slug]/report/pdf">) {
  const { slug } = await ctx.params;

  const config = siteConfigBySlug(slug);
  if (!config) {
    return new Response("Not found", { status: 404 });
  }

  const data = buildReportData(config, formatISODateUTC(new Date()));
  const period =
    data.measuredStart && data.measuredEnd
      ? formatPeriodSr(data.measuredStart, data.measuredEnd)
      : SR.docTitle;

  let pdf: Buffer;
  try {
    pdf = await renderPdf(internalReportUrl(slug, request.url));
  } catch (err) {
    // Surfaced as text so the button can show a Serbian failure message
    // instead of downloading a zero-byte file the client would open and
    // find empty.
    console.error("[report-pdf] render failed", err);
    return new Response("PDF rendering failed", { status: 500 });
  }

  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(pdf.byteLength),
      "Content-Disposition": contentDispositionAttachment(
        reportPdfFilename(`${config.displayName} - ${SR.docTitle}`, period)
      ),
      // The window moves daily and the render is expensive; a cached copy
      // would hand a client last week's numbers under this week's filename.
      "Cache-Control": "no-store",
    },
  });
}
