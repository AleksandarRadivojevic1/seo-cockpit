import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import CopyMarkdownButton from "../../../../components/CopyMarkdownButton";
import { formatISODateUTC } from "../../../../lib/analysis/windows";
import { siteConfigBySlug } from "../../../../lib/db";
import { buildReportData } from "../../../../lib/report/data";
import { toProposalMarkdown } from "../../../../lib/proposalMarkdown";

/**
 * Internal English findings page for one site.
 *
 * The page and the "copy as Markdown" button render from the SAME
 * serialized string, so what is copied can never disagree with what was on
 * screen. That string is built from `buildReportData`, which the Serbian
 * client report renders from too — so neither document can quote a number
 * the other lacks.
 */
export default async function ProposalPage({
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

  const markdown = toProposalMarkdown(buildReportData(config, formatISODateUTC(new Date())));

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6">
      <div className="flex items-center justify-between gap-3 print:hidden">
        <Link
          href={`/site/${slug}`}
          className="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <svg
            aria-hidden="true"
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            viewBox="0 0 24 24"
          >
            <path d="M15 18l-6-6 6-6" />
          </svg>
          Back to {config.displayName}
        </Link>
        <CopyMarkdownButton markdown={markdown} />
      </div>

      {/* Rendered from the same string the button copies. `whitespace-pre-wrap`
          keeps the Markdown readable as-is rather than parsing it: a findings
          document that a client may paste into their own tools should look
          on screen exactly like what they will receive. */}
      <article className="whitespace-pre-wrap font-mono text-sm leading-relaxed text-foreground">
        {markdown}
      </article>
    </div>
  );
}
