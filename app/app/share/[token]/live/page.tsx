import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import ShareTabs from "../../../../components/ShareTabs";
import SiteDashboard from "../../../../components/SiteDashboard";
import { resolveShare } from "../../../../lib/shareScope";

type Props = { params: Promise<{ token: string }> };

const ROBOTS = { index: false, follow: false };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const share = resolveShare((await params).token);
  if (!share) return { robots: ROBOTS };
  return { title: `${share.config.displayName} — Live data`, robots: ROBOTS };
}

/**
 * The client's live data: the same dashboard as the admin site page, with the
 * client tabs instead of the admin header. English, read-only.
 */
export default async function SharedLivePage({ params }: Props) {
  await connection();
  const { token } = await params;
  const share = resolveShare(token);
  if (!share) notFound();

  return <SiteDashboard config={share.config} top={<ShareTabs token={token} current="live" />} />;
}
