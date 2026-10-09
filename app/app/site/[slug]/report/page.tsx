import { notFound } from "next/navigation";
import { connection } from "next/server";
import type { Metadata } from "next";

import LanguageSwitch from "../../../../components/report/LanguageSwitch";
import PrintButton from "../../../../components/report/PrintButton";
import ReportDocument from "../../../../components/report/ReportDocument";
import { formatISODateUTC } from "../../../../lib/analysis/windows";
import { siteConfigBySlug, siteLanguage } from "../../../../lib/db";
import { buildReportData } from "../../../../lib/report/data";
import { reportFormat } from "../../../../lib/report/format";
import { reportStrings, resolveReportLanguage } from "../../../../lib/report/language";

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { slug } = await params;
  const config = siteConfigBySlug(slug);
  if (!config) return { title: reportStrings("sr").docTitle };

  const lang = resolveReportLanguage((await searchParams).lang, siteLanguage(config.property));
  const data = buildReportData(config, formatISODateUTC(new Date()));
  const period =
    data.measuredStart && data.measuredEnd
      ? reportFormat(lang).period(data.measuredStart, data.measuredEnd)
      : "";

  // The browser derives a print-dialog PDF's filename from the document title.
  return { title: `${config.displayName} — ${reportStrings(lang).docTitle} — ${period}` };
}

/**
 * The per-site client report, in the site's language unless `?lang=` asks
 * for the other one. The document itself is `ReportDocument`; this page
 * loads the data, resolves the language, and supplies the screen-only
 * toolbar (language switch and PDF download).
 */
export default async function ReportPage({ params, searchParams }: Props) {
  await connection();

  const { slug } = await params;
  const config = siteConfigBySlug(slug);
  if (!config) {
    notFound();
  }

  const lang = resolveReportLanguage((await searchParams).lang, siteLanguage(config.property));
  const t = reportStrings(lang);
  const data = buildReportData(config, formatISODateUTC(new Date()));
  const base = `/site/${slug}/report`;

  return (
    <ReportDocument
      data={data}
      lang={lang}
      toolbar={
        <>
          <LanguageSwitch current={lang} hrefFor={(l) => `${base}?lang=${l}`} />
          <PrintButton
            href={`${base}/pdf?lang=${lang}`}
            labels={{ print: t.print, busy: t.printBusy, error: t.printError }}
          />
        </>
      }
    />
  );
}
