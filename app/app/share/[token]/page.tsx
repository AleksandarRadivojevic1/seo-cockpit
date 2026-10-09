import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import ShareTabs from "../../../components/ShareTabs";
import LanguageSwitch from "../../../components/report/LanguageSwitch";
import PrintButton from "../../../components/report/PrintButton";
import ReportDocument from "../../../components/report/ReportDocument";
import { formatISODateUTC } from "../../../lib/analysis/windows";
import { siteLanguage } from "../../../lib/db";
import { buildReportData } from "../../../lib/report/data";
import { reportStrings, resolveReportLanguage } from "../../../lib/report/language";
import { resolveShare } from "../../../lib/shareScope";

type Props = {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const ROBOTS = { index: false, follow: false };

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const share = resolveShare((await params).token);
  if (!share) return { robots: ROBOTS };
  const lang = resolveReportLanguage((await searchParams).lang, siteLanguage(share.config.property));
  return { title: `${share.config.displayName} — ${reportStrings(lang).docTitle}`, robots: ROBOTS };
}

/**
 * The client's report, reached by a share link. The token alone decides the
 * site (resolveShare); an invalid, revoked or removed-site token is a 404.
 */
export default async function SharedReportPage({ params, searchParams }: Props) {
  await connection();
  const { token } = await params;
  const share = resolveShare(token);
  if (!share) notFound();

  const lang = resolveReportLanguage((await searchParams).lang, siteLanguage(share.config.property));
  const t = reportStrings(lang);
  const data = buildReportData(share.config, formatISODateUTC(new Date()));
  const base = `/share/${token}`;

  return (
    <ReportDocument
      data={data}
      lang={lang}
      toolbar={
        <>
          <div className="mr-auto">
            <ShareTabs token={token} current="report" />
          </div>
          <LanguageSwitch current={lang} hrefFor={(l) => `${base}?lang=${l}`} />
          <PrintButton
            href={`${base}/report/pdf?lang=${lang}`}
            labels={{ print: t.print, busy: t.printBusy, error: t.printError }}
          />
        </>
      }
    />
  );
}
