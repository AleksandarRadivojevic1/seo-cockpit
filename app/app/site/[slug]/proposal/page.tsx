import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import CopyMarkdownButton from "../../../../components/CopyMarkdownButton";
import { buildBrandBreakdown, topPages } from "../../../../lib/analysis/breakdown";
import { deriveSignals } from "../../../../lib/analysis/signals";
import { formatISODateUTC, recentVsPrior, windowBounds } from "../../../../lib/analysis/windows";
import {
  latestCwv,
  pageRowsInRange,
  siteConfigBySlug,
  totalsInRange,
} from "../../../../lib/db";
import { buildSiteSummary } from "../../../../lib/portfolio";
import { toProposalMarkdown } from "../../../../lib/proposalMarkdown";
import type { ProposalInput } from "../../../../lib/proposalMarkdown";

/** Opportunities carried into a client-facing document. */
const PROPOSAL_LIMIT = 10;

/**
 * Print-optimized findings page for one site.
 *
 * The page and the "copy as Markdown" button render from the SAME
 * serialized input, so the document a client receives can never disagree
 * with what was on screen. The markdown is the source of truth; this page
 * is a styled view of it.
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

  const asOf = formatISODateUTC(new Date());
  const summary = buildSiteSummary(config, asOf);
  const { recentStart, recentEnd } = windowBounds(asOf);
  const rows = totalsInRange(config.property, recentStart, recentEnd);
  const { recent, prior } = recentVsPrior(config.property, asOf);
  const signals = deriveSignals(recent, prior, config.brandToken);

  const totalImpressions = rows.reduce((sum, row) => sum + row.impressions, 0);
  const weightedPosition = rows.reduce((sum, row) => sum + row.position * row.impressions, 0);

  // Same rule as the overview's opportunity list: rank by upside across
  // every query rather than the striking band, which is empty on these
  // sites and would leave a client document with nothing in its most
  // important section.
  const opportunities = [...signals.strikingDistance, ...signals.emerging, ...signals.rising]
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, PROPOSAL_LIMIT);

  const input: ProposalInput = {
    siteName: config.displayName,
    property: config.property,
    window: { start: recentStart, end: recentEnd },
    dataState: summary.dataState,
    clicks: summary.clicks,
    impressions: totalImpressions,
    avgPosition: totalImpressions > 0 ? weightedPosition / totalImpressions : null,
    breakdown: buildBrandBreakdown(
      signals.brandSplit.brand.impressions,
      signals.brandSplit.nonBrand.impressions,
      totalImpressions
    ),
    opportunities,
    rising: signals.rising,
    declining: signals.declining,
    topPages: topPages(pageRowsInRange(config.property, recentStart, recentEnd), 10),
    cwv: latestCwv(config.property),
  };

  const markdown = toProposalMarkdown(input);

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
