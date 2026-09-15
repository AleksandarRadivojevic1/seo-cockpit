import { notFound } from "next/navigation";
import { connection } from "next/server";
import type { Metadata } from "next";

import PrintButton from "../../../../components/report/PrintButton";
import ReportChart from "../../../../components/report/ReportChart";
import ReportTable from "../../../../components/report/ReportTable";
import { formatISODateUTC } from "../../../../lib/analysis/windows";
import { metricVerdict } from "../../../../lib/cwv-format";
import { siteConfigBySlug } from "../../../../lib/db";
import { buildReportData } from "../../../../lib/report/data";
import {
  formatCwvValueSr,
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

/** Directional caret for a metric delta — a drawn mark, not a ▲/▼ glyph. */
function Caret({ up }: { up: boolean }) {
  return (
    <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path
        d={up ? "M5 2 8.5 7.5H1.5z" : "M5 8 1.5 2.5h7z"}
        fill="currentColor"
      />
    </svg>
  );
}

/** One before→after line in the growth section. A percentage rides along for
 *  clicks and impressions; a zero baseline shows "novo" instead of an infinite
 *  number. Position passes `deltaPct: undefined` — its direction is carried by
 *  the numbers alone, since a "−60%" on a rank that improved reads as a loss. */
function GrowthRow({
  label,
  before,
  after,
  deltaPct,
}: {
  label: string;
  before: string;
  after: string;
  deltaPct?: number | null;
}) {
  return (
    <div className="rb-growth-row">
      <span className="lbl">{label}</span>
      <span className="val">
        <span className="from">{before}</span>
        <span className="arw">→</span>
        {after}
      </span>
      <span className="chg">
        {deltaPct === undefined ? null : deltaPct === null ? (
          <span className="rb-delta">{SR.growthNew}</span>
        ) : deltaPct === 0 ? null : (
          <span className={`rb-delta${deltaPct > 0 ? " up" : ""}`}>
            <Caret up={deltaPct > 0} />
            {formatPercentSr(Math.abs(deltaPct) / 100)}
          </span>
        )}
      </span>
    </div>
  );
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
    <div className="report mx-auto w-full max-w-[210mm] bg-white text-neutral-900">
      <div className="flex justify-end p-4 print:hidden">
        <PrintButton href={`/site/${slug}/report/pdf`} />
      </div>

      {/* Page 1 — dark branded cover (full-bleed in print via @page cover). */}
      <div className="report-cover">
        <div className="rc-brand">
          <span className="deimos-logo rc-logo" role="img" aria-label="Deimos" />
        </div>
        <div className="rc-mid">
          <div className="rc-doctype">{SR.docTitle}</div>
          <h1 className="rc-client">
            {d.siteName}
            <span className="serif">{period}</span>
          </h1>
          <hr className="rc-rule" />
        </div>
        <div className="rc-foot">
          <div>
            <div className="label">{SR.preparedBy}</div>
            <strong>{SR.author}</strong>
          </div>
          <div style={{ textAlign: "right" }}>
            <a href={`https://${SR.authorSite}`}>{SR.authorSite}</a>
          </div>
        </div>
      </div>

      {/* Page 2+ — light printable body. */}
      <div className="report-body">
        <div className="rb-head">
          <div className="wm">
            <span className="deimos-logo rb-logo" role="img" aria-label="Deimos" />
          </div>
          <div className="pg">
            {d.siteName} · {SR.docTitle} · {period}
          </div>
        </div>

        {/* "Nothing was collected" and "everything was collected and the answer
            is zero" are different statements about the world, and the client
            deserves the honest one. */}
        {d.dataState === "not-collected" && (
          <p className="rb-lead">{SR.notCollected}</p>
        )}
        {d.dataState === "zero" && (
          <p className="rb-lead">{SR.measuredZero}</p>
        )}

        <section className="mb-8 break-inside-avoid">
          <h2 className="rb-sec">
            {SR.summary}
          </h2>
          <div className="rb-kpis">
            <div className="rb-kpi">
              <div className="n">{formatIntSr(d.clicks.recent)}</div>
              <div className="u">{pluralSr(d.clicks.recent, SR.clicks)}</div>
              {/* The one directional comparison gets the compact caret chip;
                  the non-directional shapes (no prior window, prior-with-no-
                  clicks, flat) are stated in full below, never as a 0%. */}
              {d.hasPriorWindow &&
                d.clicks.deltaPct !== null &&
                d.clicks.deltaPct !== 0 && (
                  <div className={`rb-delta${d.clicks.deltaPct > 0 ? " up" : ""}`}>
                    <Caret up={d.clicks.deltaPct > 0} />
                    {formatPercentSr(Math.abs(d.clicks.deltaPct) / 100)}
                  </div>
                )}
            </div>
            <div className="rb-kpi">
              <div className="n">{formatIntSr(d.impressions)}</div>
              <div className="u">{pluralSr(d.impressions, SR.impressions)}</div>
            </div>
            <div className="rb-kpi">
              <div className="n">
                {d.avgPosition === null ? "—" : formatDecimalSr(d.avgPosition)}
              </div>
              <div className="u">{SR.avgPosition}</div>
            </div>
          </div>
          {/* Three shapes, three sentences, no silence: no prior window at all,
              a prior window with no clicks to divide by, and a flat comparison.
              The real directional change is shown as the chip above; the rest
              are spelled out here so the client never guesses which one they are
              looking at. */}
          {!d.hasPriorWindow
            ? d.measuredStart && (
                <p className="mt-3 text-xs italic text-neutral-500">
                  {SR.noPrior(formatDateSr(d.measuredStart))}
                </p>
              )
            : d.clicks.deltaPct === null ? (
                <p className="mt-3 text-xs italic text-neutral-500">
                  {SR.colClicks}: {SR.noPriorClicks}
                </p>
              ) : (
                d.clicks.deltaPct === 0 && (
                  <p className="mt-3 text-xs italic text-neutral-500">
                    {SR.colClicks}: {SR.noChange}
                  </p>
                )
              )}
        </section>

        <section className="mb-8 break-inside-avoid">
          <h2 className="rb-sec">{SR.growth}</h2>
          {d.growth === null ? (
            <p className="text-sm text-neutral-500">{SR.growthEmpty}</p>
          ) : (
            <>
              <p className="mb-4 text-sm text-neutral-600">
                {SR.growthLead(
                  `${formatIntSr(Math.round(d.growth.durationDays / 30))} ${pluralSr(
                    Math.round(d.growth.durationDays / 30),
                    SR.months
                  )}`
                )}
              </p>
              <div className="rb-growth">
                <GrowthRow
                  label={SR.growthClicks}
                  before={formatIntSr(d.growth.clicks.before)}
                  after={formatIntSr(d.growth.clicks.after)}
                  deltaPct={d.growth.clicks.deltaPct}
                />
                <GrowthRow
                  label={SR.growthImpressions}
                  before={formatIntSr(d.growth.impressions.before)}
                  after={formatIntSr(d.growth.impressions.after)}
                  deltaPct={d.growth.impressions.deltaPct}
                />
                <GrowthRow
                  label={SR.growthPosition}
                  before={
                    d.growth.position.before === null
                      ? "—"
                      : formatDecimalSr(d.growth.position.before)
                  }
                  after={
                    d.growth.position.after === null
                      ? "—"
                      : formatDecimalSr(d.growth.position.after)
                  }
                />
              </div>
            </>
          )}
        </section>

        <section className="mb-8 break-inside-avoid">
          <h2 className="rb-sec">
            {SR.trend}
          </h2>
          {d.trend.length > 1 ? (
            <ReportChart points={d.trend} />
          ) : (
            <p className="text-sm text-neutral-500">{SR.trendEmpty}</p>
          )}
        </section>

        <section className="mb-8 break-inside-avoid">
          <h2 className="rb-sec">
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
          <h2 className="rb-sec">
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
          <h2 className="rb-sec">
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
          <h2 className="rb-sec">
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

        <section className="mb-8">
          <h2 className="rb-sec">
            {SR.demand}
          </h2>
          {d.demand.notCollected || d.demand.gaps.length === 0 ? (
            <p className="text-sm text-neutral-500">{SR.demandEmpty}</p>
          ) : (
            <>
              <p className="mb-3 text-sm text-neutral-600">
                {SR.demandLead(d.demand.gaps.length, pluralSr(d.demand.gaps.length, SR.keywords))}
              </p>
              <ReportTable
                head={[SR.colQuery, ""]}
                rows={d.demand.gaps.slice(0, 20).map((g) => [g.keyword, SR.demandIntent[g.intent]])}
              />
            </>
          )}
        </section>

        <section className="mb-8">
          <h2 className="rb-sec">
            {SR.competitors}
          </h2>
          {d.serpState === "not-checked" ? (
            <p className="text-sm text-neutral-500">{SR.competitorsEmpty}</p>
          ) : d.competitors.length === 0 ? (
            <p className="text-sm text-neutral-500">{SR.competitorsEmptySerp}</p>
          ) : (
            <>
              <p className="mb-3 text-sm text-neutral-600">{SR.competitorsLead}</p>
              <ReportTable
                head={[SR.colDomain, SR.colAppearances, SR.colBest]}
                numeric={[false, true, true]}
                rows={d.competitors
                  .slice(0, 10)
                  .map((c) => [c.domain, formatIntSr(c.appearances), formatIntSr(c.bestPosition)])}
              />
            </>
          )}
        </section>

        <section className="mb-8 break-inside-avoid">
          <h2 className="rb-sec">
            {SR.cwv}
          </h2>
          {!d.cwv ? (
            <p className="text-sm text-neutral-500">{SR.cwvEmpty}</p>
          ) : (
            <>
              <dl className="text-sm">
                {(
                  [
                    ["LCP", d.cwv.lcp_p75, "lcp"],
                    ["INP", d.cwv.inp_p75, "inp"],
                    ["CLS", d.cwv.cls_p75, "cls"],
                  ] as const
                ).map(([label, value, key]) => (
                  <div key={label} className="flex gap-2 py-0.5">
                    <dt className="w-12 font-medium">{label}</dt>
                    <dd className="text-neutral-600">
                      {value === null ? (
                        SR.cwvNotMeasured
                      ) : (
                        <>
                          {formatCwvValueSr(value, key)}{" "}
                          <span className="text-neutral-400">
                            ({SR.cwvVerdict[metricVerdict(value, key)]})
                          </span>
                        </>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="mt-3 text-xs italic text-neutral-500">
                {d.cwv.source === "psi" ? SR.cwvLab : SR.cwvField}
              </p>
            </>
          )}
        </section>

        <footer className="rb-foot">
          <span>{SR.authorSite}</span>
          <span>{d.siteName}</span>
        </footer>
      </div>
    </div>
  );
}
