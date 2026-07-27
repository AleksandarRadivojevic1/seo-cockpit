import { notFound } from "next/navigation";
import { connection } from "next/server";
import type { Metadata } from "next";

import PrintButton from "../../../../components/report/PrintButton";
import ReportChart from "../../../../components/report/ReportChart";
import ReportTable from "../../../../components/report/ReportTable";
import { formatISODateUTC } from "../../../../lib/analysis/windows";
import { siteConfigBySlug } from "../../../../lib/db";
import { buildReportData } from "../../../../lib/report/data";
import {
  formatDateSr,
  formatDecimalSr,
  formatIntSr,
  formatPercentSr,
  formatPeriodSr,
  pluralSr,
} from "../../../../lib/report/format";
import { SR } from "../../../../lib/report/sr";

/** A share of the total, or an em dash when the total is zero. */
function share(value: number, total: number): string {
  return total > 0 ? formatPercentSr(value / total) : "—";
}

/** Full URLs are unreadable in a table column; the path is what identifies a page. */
function pathOf(url: string): string {
  try {
    const { pathname, search } = new URL(url);
    return `${pathname}${search}` || "/";
  } catch {
    return url;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const config = siteConfigBySlug(slug);
  if (!config) return { title: SR.docTitle };

  const data = buildReportData(config, formatISODateUTC(new Date()));
  const period =
    data.measuredStart && data.measuredEnd
      ? formatPeriodSr(data.measuredStart, data.measuredEnd)
      : "";

  // The browser derives the saved PDF's filename from the document title,
  // so the title is what the client ends up with on disk.
  return { title: `${config.displayName} — ${SR.docTitle} — ${period}` };
}

/**
 * The per-site Serbian client report.
 *
 * A print document that happens to be served over HTTP: light colours are
 * literals rather than theme variables, the only interactive element is the
 * print button, and every section is `break-inside-avoid` so the PDF never
 * splits a finding across a page. PDF production is the browser's own print
 * dialog — no headless Chromium on the Pi for a document made by hand twice
 * a month.
 */
export default async function ReportPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  await connection();

  const { slug } = await params;
  const config = siteConfigBySlug(slug);
  if (!config) {
    notFound();
  }

  const d = buildReportData(config, formatISODateUTC(new Date()));
  // The measured span, not the nominal 28 days: optika-cajs holds 17, and a
  // header claiming 28 would be false on the first site this is used for.
  const period =
    d.measuredStart && d.measuredEnd ? formatPeriodSr(d.measuredStart, d.measuredEnd) : "—";

  return (
    <div className="report mx-auto w-full max-w-[210mm] bg-white px-10 py-10 text-neutral-900">
      <div className="mb-6 flex justify-end print:hidden">
        <PrintButton />
      </div>

      <header className="mb-8">
        <div className="mb-3 h-[3px] w-10 bg-[#1b4f8f]" />
        <h1 className="text-3xl font-semibold tracking-tight">{d.siteName}</h1>
        <p className="mt-1 text-sm text-neutral-500">{config.property}</p>
        <div className="mt-4 flex items-end justify-between border-b border-neutral-200 pb-3 text-xs text-neutral-500">
          <div>
            {SR.period}
            <span className="block text-sm font-medium text-neutral-900">{period}</span>
          </div>
          <div className="text-right">
            {SR.preparedBy}
            <span className="block text-sm font-medium text-neutral-900">{SR.author}</span>
          </div>
        </div>
      </header>

      {/* "Nothing was collected" and "everything was collected and the answer
          is zero" are different statements about the world, and the client
          deserves the honest one. */}
      {d.dataState === "not-collected" && (
        <p className="mb-6 border-l-2 border-neutral-300 pl-3 text-sm">{SR.notCollected}</p>
      )}
      {d.dataState === "zero" && (
        <p className="mb-6 border-l-2 border-neutral-300 pl-3 text-sm">{SR.measuredZero}</p>
      )}

      <section className="mb-8 break-inside-avoid">
        <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.1em] text-neutral-400">
          {SR.summary}
        </h2>
        <div className="flex gap-10">
          <div>
            <div className="text-3xl font-semibold tracking-tight">
              {formatIntSr(d.clicks.recent)}
            </div>
            <div className="mt-1 text-xs text-neutral-500">
              {pluralSr(d.clicks.recent, SR.clicks)}
            </div>
          </div>
          <div>
            <div className="text-3xl font-semibold tracking-tight">
              {formatIntSr(d.impressions)}
            </div>
            <div className="mt-1 text-xs text-neutral-500">
              {pluralSr(d.impressions, SR.impressions)}
            </div>
          </div>
          <div>
            <div className="text-3xl font-semibold tracking-tight">
              {d.avgPosition === null ? "—" : formatDecimalSr(d.avgPosition)}
            </div>
            <div className="mt-1 text-xs text-neutral-500">{SR.avgPosition}</div>
          </div>
        </div>
        {!d.hasPriorWindow && d.measuredStart && (
          <p className="mt-3 text-xs italic text-neutral-500">
            {SR.noPrior(formatDateSr(d.measuredStart))}
          </p>
        )}
      </section>

      <section className="mb-8 break-inside-avoid">
        <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.1em] text-neutral-400">
          {SR.trend}
        </h2>
        {d.trend.length > 1 ? (
          <ReportChart points={d.trend} />
        ) : (
          <p className="text-sm text-neutral-500">{SR.trendEmpty}</p>
        )}
      </section>

      <section className="mb-8 break-inside-avoid">
        <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.1em] text-neutral-400">
          {SR.opportunities}
        </h2>
        {d.opportunities.length === 0 ? (
          <p className="text-sm text-neutral-500">{SR.opportunitiesEmpty}</p>
        ) : (
          <>
            <p className="mb-3 text-sm text-neutral-600">{SR.opportunitiesLead}</p>
            <ReportTable
              head={[SR.colQuery, SR.colPosition, SR.colImpressions, SR.colCtr]}
              numeric={[false, true, true, true]}
              rows={d.opportunities.map((o) => [
                o.query,
                formatDecimalSr(o.position),
                formatIntSr(o.impressions),
                formatPercentSr(o.ctr),
              ])}
            />
          </>
        )}
      </section>

      <section className="mb-8 break-inside-avoid">
        <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.1em] text-neutral-400">
          {SR.movement}
        </h2>
        {d.rising.length === 0 && d.declining.length === 0 ? (
          <p className="text-sm text-neutral-500">{SR.movementEmpty}</p>
        ) : (
          <dl className="text-sm">
            <div className="mb-1.5">
              <dt className="inline font-medium">{SR.movementRising}: </dt>
              <dd className="inline text-neutral-600">
                {d.rising.length === 0
                  ? SR.movementNone
                  : d.rising.map((e) => e.query).join(", ")}
              </dd>
            </div>
            <div>
              <dt className="inline font-medium">{SR.movementDeclining}: </dt>
              <dd className="inline text-neutral-600">
                {d.declining.length === 0
                  ? SR.movementNone
                  : d.declining.map((e) => e.query).join(", ")}
              </dd>
            </div>
          </dl>
        )}
      </section>

      <section className="mb-8 break-inside-avoid">
        <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.1em] text-neutral-400">
          {SR.sources}
        </h2>
        <ReportTable
          head={["", SR.colImpressions, ""]}
          numeric={[false, true, true]}
          rows={[
            [
              SR.sourceBrand,
              formatIntSr(d.breakdown.brandImpressions),
              share(d.breakdown.brandImpressions, d.breakdown.totalImpressions),
            ],
            [
              SR.sourceNonBrand,
              formatIntSr(d.breakdown.nonBrandImpressions),
              share(d.breakdown.nonBrandImpressions, d.breakdown.totalImpressions),
            ],
            [
              SR.sourceAnonymous,
              formatIntSr(d.breakdown.anonymizedImpressions),
              share(d.breakdown.anonymizedImpressions, d.breakdown.totalImpressions),
            ],
          ]}
        />
        <p className="mt-3 text-xs italic text-neutral-500">{SR.sourcesNote}</p>
      </section>

      <section className="mb-8 break-inside-avoid">
        <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.1em] text-neutral-400">
          {SR.pages}
        </h2>
        {d.topPages.length === 0 ? (
          <p className="text-sm text-neutral-500">{SR.pagesEmpty}</p>
        ) : (
          <ReportTable
            head={[SR.colPage, SR.colClicks, SR.colImpressions, SR.colPosition]}
            numeric={[false, true, true, true]}
            rows={d.topPages.map((p) => [
              pathOf(p.page),
              formatIntSr(p.clicks),
              formatIntSr(p.impressions),
              formatDecimalSr(p.position),
            ])}
          />
        )}
      </section>

      <footer className="mt-10 flex justify-between border-t border-neutral-200 pt-3 text-[10px] text-neutral-400">
        <span>{SR.authorSite}</span>
        <span>{d.siteName}</span>
      </footer>
    </div>
  );
}
