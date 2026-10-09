import Link from "next/link";
import { connection } from "next/server";

import UserSitesFileNotice from "../../../components/UserSitesFileNotice";
import { loadUserSites, userSitesFileError } from "../../../lib/userSites";
import AddSiteForm from "./AddSiteForm";

export default async function AddSitePage() {
  // Read at request time: the file changes without a rebuild.
  await connection();
  const filePath = process.env.SEO_USER_SITES_PATH;
  const file = loadUserSites(filePath);
  const notice =
    file.state === "malformed" && filePath ? userSitesFileError(filePath, file.error) : null;

  return (
    <div className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-1">
        <Link href="/" className="text-xs text-muted-foreground hover:text-foreground">
          ← Back to overview
        </Link>
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">Add a site</h1>
        <p className="text-sm text-muted-foreground">
          Register a Search Console property to monitor. It starts collecting on
          the next nightly run and backfills about 90 days of history.
        </p>
      </header>

      <UserSitesFileNotice message={notice} />

      <section className="rounded-xl border border-border bg-card p-4 text-card-foreground shadow-sm">
        <AddSiteForm />
      </section>
    </div>
  );
}
