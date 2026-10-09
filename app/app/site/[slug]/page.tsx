import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import ShareLinkForm from "../../../components/ShareLinkForm";
import SiteDashboard from "../../../components/SiteDashboard";
import { siteConfigBySlug } from "../../../lib/db";

// Tests import these helpers from this page; they live with the dashboard now.
export { buildTrendSeries, formatNonBrandDelta } from "../../../components/SiteDashboard";

/**
 * The admin view of one site: the shared dashboard plus the admin header
 * (back to the overview, the findings page, the client report). The client's
 * Live data view renders the same dashboard without any of these.
 */
export default async function SitePage({
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

  return (
    <SiteDashboard
      config={config}
      afterHeader={<ShareLinkForm slug={slug} />}
      top={
        // An inline chevron, not a glyph or emoji: this is a navigation
        // affordance rather than decoration, and the label carries the
        // meaning on its own if the icon fails to paint.
        <Link
          href="/"
          className="flex w-fit items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
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
          Back to dashboard
        </Link>
      }
      headerLinks={
        <>
          <Link
            href={`/site/${slug}/proposal`}
            className="text-sm text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
          >
            Findings
          </Link>
          {/* English on the English dashboard; the report it opens is in the
              site's language, with an SR / EN switch. */}
          <Link
            href={`/site/${slug}/report`}
            className="text-sm text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
          >
            Client report
          </Link>
        </>
      }
    />
  );
}
