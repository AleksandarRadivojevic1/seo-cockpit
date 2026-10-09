import Link from "next/link";
import { connection } from "next/server";

import UserSitesFileNotice from "../../../components/UserSitesFileNotice";
import { revokeShareLinkAction } from "../actions";
import { listRetiredSiteConfigs, listSiteConfigs } from "../../../lib/db";
import { buildShareLinkRows } from "../../../lib/shareLinkRows";
import { loadShareLinks, shareLinksFileError } from "../../../lib/shareLinks";

const STATUS_STYLE = {
  active: "text-emerald-700 dark:text-emerald-400",
  revoked: "text-muted-foreground",
  "site removed": "text-amber-700 dark:text-amber-400",
} as const;

/**
 * Every client share link: who it's for, which site, when it was created,
 * and whether it still works. Links are created on each site's page; the URL
 * is shown only then, so this page lists links without their URLs.
 */
export default async function ShareLinksPage() {
  await connection();
  const filePath = process.env.SEO_SHARE_LINKS_PATH;
  const file = loadShareLinks(filePath);
  const rows =
    file.state === "ok" ? buildShareLinkRows(file.links, listSiteConfigs(), listRetiredSiteConfigs()) : [];
  const notice =
    file.state === "malformed" && filePath ? shareLinksFileError(filePath, file.error) : null;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-1">
        <Link href="/" className="text-xs text-muted-foreground hover:text-foreground">
          ← Back to overview
        </Link>
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">Share links</h1>
        <p className="text-sm text-muted-foreground">
          Each link opens one site’s report and live data for a client, without a password. Links
          never expire; revoke one to stop it working. Create links on a site’s page.
        </p>
      </header>

      <UserSitesFileNotice message={notice} />

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No share links yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground uppercase">
            <tr>
              <th className="pb-2 font-medium">Label</th>
              <th className="pb-2 font-medium">Site</th>
              <th className="pb-2 font-medium">Created</th>
              <th className="pb-2 font-medium">Status</th>
              <th className="pb-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-border">
                <td className="py-2">{row.label}</td>
                <td className="py-2">{row.siteName}</td>
                <td className="py-2 tabular-nums">{row.created}</td>
                <td className={`py-2 ${STATUS_STYLE[row.status]}`}>{row.status}</td>
                <td className="py-2 text-right">
                  {row.status === "active" ? (
                    <form action={revokeShareLinkAction}>
                      <input type="hidden" name="id" value={row.id} />
                      <button
                        type="submit"
                        className="text-xs text-muted-foreground underline underline-offset-4 hover:text-destructive"
                      >
                        Revoke
                      </button>
                    </form>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
