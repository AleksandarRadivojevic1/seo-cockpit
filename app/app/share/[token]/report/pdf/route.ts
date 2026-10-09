import { formatISODateUTC } from "../../../../../lib/analysis/windows";
import { siteLanguage } from "../../../../../lib/db";
import { buildReportData } from "../../../../../lib/report/data";
import { resolveReportLanguage } from "../../../../../lib/report/language";
import {
  contentDispositionAttachment,
  internalShareReportUrl,
  renderPdf,
  reportPdfFilenameFor,
} from "../../../../../lib/report/pdf";
import { resolveShare } from "../../../../../lib/shareScope";

/**
 * The client's report as a PDF: prints `/share/<token>` in the requested
 * language, the same way the admin PDF prints the admin report.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: RouteContext<"/share/[token]/report/pdf">) {
  const { token } = await ctx.params;
  const share = resolveShare(token);
  if (!share) {
    return new Response("Not found", { status: 404 });
  }

  const lang = resolveReportLanguage(
    new URL(request.url).searchParams.get("lang"),
    siteLanguage(share.config.property)
  );
  const data = buildReportData(share.config, formatISODateUTC(new Date()));

  let pdf: Buffer;
  try {
    pdf = await renderPdf(internalShareReportUrl(token, request.url, lang));
  } catch (err) {
    console.error("[share-pdf] render failed", err);
    return new Response("PDF rendering failed", { status: 500 });
  }

  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(pdf.byteLength),
      "Content-Disposition": contentDispositionAttachment(
        reportPdfFilenameFor(share.config.displayName, lang, data.measuredStart, data.measuredEnd)
      ),
      "Cache-Control": "no-store",
    },
  });
}
