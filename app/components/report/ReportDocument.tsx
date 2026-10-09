import type { ReactNode } from "react";

import ReportChart from "./ReportChart";
import ReportTable from "./ReportTable";
import type { ReportData } from "../../lib/report/data";
import { reportFormat } from "../../lib/report/format";
import { reportStrings, type ReportLanguage } from "../../lib/report/language";

/** A share of the total, or an em dash when the total is zero. */
function share(value: number, total: number, percent: (fraction: number) => string): string {
  return total > 0 ? percent(value / total) : "—";
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
      <path d={up ? "M5 2 8.5 7.5H1.5z" : "M5 8 1.5 2.5h7z"} fill="currentColor" />
    </svg>
  );
}

/** One before→after line in the growth section. A percentage rides along for
 *  clicks and impressions; a zero baseline shows "new" instead of an infinite
 *  number. Position passes `deltaPct: undefined` — its direction is carried by
 *  the numbers alone, since a "−60%" on a rank that improved reads as a loss. */
function GrowthRow({
  label,
  before,
  after,
  deltaPct,
  newLabel,
  percent,
}: {
  label: string;
  before: string;
  after: string;
  deltaPct?: number | null;
  newLabel: string;
  percent: (fraction: number) => string;
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
          <span className="rb-delta">{newLabel}</span>
        ) : deltaPct === 0 ? null : (
          <span className={`rb-delta${deltaPct > 0 ? " up" : ""}`}>
            <Caret up={deltaPct > 0} />
            {percent(Math.abs(deltaPct) / 100)}
          </span>
        )}
      </span>
    </div>
  );
}

/**
 * The client report document, in Serbian or English.
 *
 * A print document that happens to be served over HTTP: light colours are
 * literals rather than theme variables, the only interactive elements live in
 * the screen-only `toolbar`, and every section is `break-inside-avoid` so the
 * PDF never splits a finding across a page.
 *
 * `lang` is declared on the root so hyphenation, screen readers and the PDF
 * know the language; the root layout's `<html lang="en">` is wrong for a
 * Serbian report. The admin report page and piece 2's share page both render
 * this component; only their `toolbar` differs.
 */
export default function ReportDocument({
  data: d,
  lang,
  toolbar,
}: {
  data: ReportData;
  lang: ReportLanguage;
  toolbar?: ReactNode;
}) {
  const t = reportStrings(lang);
  const f = reportFormat(lang);
  // The measured span, not the nominal 28 days: optika-cajs once held 17, and
  // a header claiming 28 would have been false.
  const period = d.measuredStart && d.measuredEnd ? f.period(d.measuredStart, d.measuredEnd) : "—";

  return (
    <div lang={lang} className="report mx-auto w-full max-w-[210mm] bg-white text-neutral-900">
      {toolbar ? (
        <div className="flex items-center justify-end gap-4 p-4 print:hidden">{toolbar}</div>
      ) : null}

      {/* Page 1 — dark branded cover (full-bleed in print via @page cover). */}
      <div className="report-cover">
        <div className="rc-brand">
          <span className="deimos-logo rc-logo" role="img" aria-label="Deimos" />
        </div>
        <div className="rc-mid">
          <div className="rc-doctype">{t.docTitle}</div>
          <h1 className="rc-client">
            {d.siteName}
            <span className="serif">{period}</span>
          </h1>
          <hr className="rc-rule" />
        </div>
        <div className="rc-foot">
          <div>
            <div className="label">{t.preparedBy}</div>
            <strong>{t.author}</strong>
          </div>
          <div style={{ textAlign: "right" }}>
            <a href={`https://${t.authorSite}`}>{t.authorSite}</a>
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
            {d.siteName} · {t.docTitle} · {period}
          </div>
        </div>

        {/* "Nothing was collected" and "everything was collected and the answer
            is zero" are different statements about the world, and the client
            deserves the honest one. */}
        {d.dataState === "not-collected" && <p className="rb-lead">{t.notCollected}</p>}
        {d.dataState === "zero" && <p className="rb-lead">{t.measuredZero}</p>}

        <section className="mb-8 break-inside-avoid">
          <h2 className="rb-sec">{t.summary}</h2>
          <div className="rb-kpis">
            <div className="rb-kpi">
              <div className="n">{f.int(d.clicks.recent)}</div>
              <div className="u">{f.plural(d.clicks.recent, t.clicks)}</div>
              {/* The one directional comparison gets the compact caret chip;
                  the non-directional shapes (no prior window, prior-with-no-
                  clicks, flat) are stated in full below, never as a 0%. */}
              {d.hasPriorWindow && d.clicks.deltaPct !== null && d.clicks.deltaPct !== 0 && (
                <div className={`rb-delta${d.clicks.deltaPct > 0 ? " up" : ""}`}>
                  <Caret up={d.clicks.deltaPct > 0} />
                  {f.percent(Math.abs(d.clicks.deltaPct) / 100)}
                </div>
              )}
            </div>
            <div className="rb-kpi">
              <div className="n">{f.int(d.impressions)}</div>
              <div className="u">{f.plural(d.impressions, t.impressions)}</div>
            </div>
            <div className="rb-kpi">
              <div className="n">{d.avgPosition === null ? "—" : f.decimal(d.avgPosition)}</div>
              <div className="u">{t.avgPosition}</div>
            </div>
          </div>
          {/* Three shapes, three sentences, no silence: no prior window at all,
              a prior window with no clicks to divide by, and a flat comparison. */}
          {!d.hasPriorWindow
            ? d.measuredStart && (
                <p className="mt-3 text-xs italic text-neutral-500">
                  {t.noPrior(f.date(d.measuredStart))}
                </p>
              )
            : d.clicks.deltaPct === null ? (
                <p className="mt-3 text-xs italic text-neutral-500">
                  {t.colClicks}: {t.noPriorClicks}
                </p>
              ) : (
                d.clicks.deltaPct === 0 && (
                  <p className="mt-3 text-xs italic text-neutral-500">
                    {t.colClicks}: {t.noChange}
                  </p>
                )
              )}
        </section>

        <section className="mb-8 break-inside-avoid">
          <h2 className="rb-sec">{t.growth}</h2>
          {d.growth === null ? (
            <p className="text-sm text-neutral-500">{t.growthEmpty}</p>
          ) : (
            <>
              <p className="mb-4 text-sm text-neutral-600">
                {t.growthLead(
                  `${f.int(Math.round(d.growth.durationDays / 30))} ${f.plural(
                    Math.round(d.growth.durationDays / 30),
                    t.months
                  )}`
                )}
              </p>
              <div className="rb-growth">
                <GrowthRow
                  label={t.growthClicks}
                  before={f.int(d.growth.clicks.before)}
                  after={f.int(d.growth.clicks.after)}
                  deltaPct={d.growth.clicks.deltaPct}
                  newLabel={t.growthNew}
                  percent={f.percent}
                />
                <GrowthRow
                  label={t.growthImpressions}
                  before={f.int(d.growth.impressions.before)}
                  after={f.int(d.growth.impressions.after)}
                  deltaPct={d.growth.impressions.deltaPct}
                  newLabel={t.growthNew}
                  percent={f.percent}
                />
                <GrowthRow
                  label={t.growthPosition}
                  before={d.growth.position.before === null ? "—" : f.decimal(d.growth.position.before)}
                  after={d.growth.position.after === null ? "—" : f.decimal(d.growth.position.after)}
                  newLabel={t.growthNew}
                  percent={f.percent}
                />
              </div>
            </>
          )}
        </section>

        <section className="mb-8 break-inside-avoid">
          <h2 className="rb-sec">{t.trend}</h2>
          {d.trend.length > 1 ? (
            <ReportChart points={d.trend} lang={lang} />
          ) : (
            <p className="text-sm text-neutral-500">{t.trendEmpty}</p>
          )}
        </section>

        <section className="mb-8 break-inside-avoid">
          <h2 className="rb-sec">{t.opportunities}</h2>
          {d.opportunities.length === 0 ? (
            <p className="text-sm text-neutral-500">{t.opportunitiesEmpty}</p>
          ) : (
            <>
              <p className="mb-3 text-sm text-neutral-600">{t.opportunitiesLead}</p>
              <ReportTable
                head={[t.colQuery, t.colPosition, t.colImpressions, t.colCtr]}
                numeric={[false, true, true, true]}
                rows={d.opportunities.map((o) => [
                  o.query,
                  f.decimal(o.position),
                  f.int(o.impressions),
                  f.percent(o.ctr),
                ])}
              />
            </>
          )}
        </section>

        <section className="mb-8 break-inside-avoid">
          <h2 className="rb-sec">{t.movement}</h2>
          {d.rising.length === 0 && d.declining.length === 0 ? (
            <p className="text-sm text-neutral-500">{t.movementEmpty}</p>
          ) : (
            <dl className="text-sm">
              <div className="mb-1.5">
                <dt className="inline font-medium">{t.movementRising}: </dt>
                <dd className="inline text-neutral-600">
                  {d.rising.length === 0 ? t.movementNone : d.rising.map((e) => e.query).join(", ")}
                </dd>
              </div>
              <div>
                <dt className="inline font-medium">{t.movementDeclining}: </dt>
                <dd className="inline text-neutral-600">
                  {d.declining.length === 0
                    ? t.movementNone
                    : d.declining.map((e) => e.query).join(", ")}
                </dd>
              </div>
            </dl>
          )}
        </section>

        <section className="mb-8 break-inside-avoid">
          <h2 className="rb-sec">{t.sources}</h2>
          <ReportTable
            head={["", t.colImpressions, ""]}
            numeric={[false, true, true]}
            rows={[
              [
                t.sourceBrand,
                f.int(d.breakdown.brandImpressions),
                share(d.breakdown.brandImpressions, d.breakdown.totalImpressions, f.percent),
              ],
              [
                t.sourceNonBrand,
                f.int(d.breakdown.nonBrandImpressions),
                share(d.breakdown.nonBrandImpressions, d.breakdown.totalImpressions, f.percent),
              ],
              [
                t.sourceAnonymous,
                f.int(d.breakdown.anonymizedImpressions),
                share(d.breakdown.anonymizedImpressions, d.breakdown.totalImpressions, f.percent),
              ],
            ]}
          />
          <p className="mt-3 text-xs italic text-neutral-500">{t.sourcesNote}</p>
        </section>

        <section className="mb-8 break-inside-avoid">
          <h2 className="rb-sec">{t.pages}</h2>
          {d.topPages.length === 0 ? (
            <p className="text-sm text-neutral-500">{t.pagesEmpty}</p>
          ) : (
            <ReportTable
              head={[t.colPage, t.colClicks, t.colImpressions, t.colPosition]}
              numeric={[false, true, true, true]}
              rows={d.topPages.map((p) => [
                pathOf(p.page),
                f.int(p.clicks),
                f.int(p.impressions),
                f.decimal(p.position),
              ])}
            />
          )}
        </section>

        <section className="mb-8">
          <h2 className="rb-sec">{t.demand}</h2>
          {d.demand.notCollected || d.demand.gaps.length === 0 ? (
            <p className="text-sm text-neutral-500">{t.demandEmpty}</p>
          ) : (
            <>
              <p className="mb-3 text-sm text-neutral-600">
                {t.demandLead(d.demand.gaps.length, f.plural(d.demand.gaps.length, t.keywords))}
              </p>
              <ReportTable
                head={[t.colQuery, ""]}
                rows={d.demand.gaps.slice(0, 20).map((g) => [g.keyword, t.demandIntent[g.intent]])}
              />
            </>
          )}
        </section>

        <section className="mb-8">
          <h2 className="rb-sec">{t.competitors}</h2>
          {d.serpState === "not-checked" ? (
            <p className="text-sm text-neutral-500">{t.competitorsEmpty}</p>
          ) : d.competitors.length === 0 ? (
            <p className="text-sm text-neutral-500">{t.competitorsEmptySerp}</p>
          ) : (
            <>
              <p className="mb-3 text-sm text-neutral-600">{t.competitorsLead}</p>
              <ReportTable
                head={[t.colDomain, t.colAppearances, t.colBest]}
                numeric={[false, true, true]}
                rows={d.competitors
                  .slice(0, 10)
                  .map((c) => [c.domain, f.int(c.appearances), f.int(c.bestPosition)])}
              />
            </>
          )}
        </section>

        <footer className="rb-foot">
          <span>{t.authorSite}</span>
          <span>{d.siteName}</span>
        </footer>
      </div>
    </div>
  );
}
