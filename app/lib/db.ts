import Database from "better-sqlite3";
import path from "node:path";

export interface TotalsRow {
  site: string;
  date: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface QueryRow {
  site: string;
  date: string;
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface SiteConfig {
  property: string;
  slug: string;
  displayName: string;
  brandToken: string;
}

export interface PageRow {
  site: string;
  date: string;
  page: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface RunRow {
  site: string;
  startedAt: string;
  finishedAt: string | null;
  rowsWritten: number | null;
  status: string;
  error: string | null;
}

export interface CwvRow {
  site: string;
  url: string;
  captured_at: string;
  lcp_p75: number | null;
  inp_p75: number | null;
  cls_p75: number | null;
  source: string | null;
  form_factor: string | null;
}

// One memoized readonly connection per resolved DB path, so repeated
// getDb() calls within the app reuse the same handle instead of
// reopening the file each time.
const connections = new Map<string, Database.Database>();

/**
 * Opens (or reuses) a readonly connection to the SQLite DB written by the
 * Python collector. Defaults to SEO_DB_PATH when no path is given.
 */
export function getDb(dbPath?: string): Database.Database {
  const resolvedPath = path.resolve(dbPath ?? requireDbPathFromEnv());

  const existing = connections.get(resolvedPath);
  if (existing) {
    return existing;
  }

  const db = new Database(resolvedPath, { readonly: true, fileMustExist: true });
  connections.set(resolvedPath, db);
  return db;
}

function requireDbPathFromEnv(): string {
  const envPath = process.env.SEO_DB_PATH;
  if (!envPath) {
    throw new Error(
      "getDb() requires a dbPath argument or the SEO_DB_PATH environment variable to be set."
    );
  }
  return envPath;
}

/** Distinct site values present in totals_daily, sorted ascending. */
export function listSites(db: Database.Database = getDb()): string[] {
  const rows = db
    .prepare<[], { site: string }>("SELECT DISTINCT site FROM totals_daily ORDER BY site")
    .all();
  return rows.map((row) => row.site);
}

/** query_daily rows for a site within an inclusive date range, ordered by date. */
export function queryRowsInRange(
  site: string,
  start: string,
  end: string,
  db: Database.Database = getDb()
): QueryRow[] {
  return db
    .prepare<[string, string, string], QueryRow>(
      `SELECT site, date, query, clicks, impressions, ctr, position
       FROM query_daily
       WHERE site = ? AND date BETWEEN ? AND ?
       ORDER BY date`
    )
    .all(site, start, end);
}

/** page_daily rows for a site within an inclusive date range, ordered by date. */
export function pageRowsInRange(
  site: string,
  start: string,
  end: string,
  db: Database.Database = getDb()
): PageRow[] {
  return db
    .prepare<[string, string, string], PageRow>(
      `SELECT site, date, page, clicks, impressions, ctr, position
       FROM page_daily
       WHERE site = ? AND date BETWEEN ? AND ?
       ORDER BY date`
    )
    .all(site, start, end);
}

/** totals_daily rows for a site within an inclusive date range, ordered by date. */
export function totalsInRange(
  site: string,
  start: string,
  end: string,
  db: Database.Database = getDb()
): TotalsRow[] {
  return db
    .prepare<[string, string, string], TotalsRow>(
      `SELECT site, date, clicks, impressions, ctr, position
       FROM totals_daily
       WHERE site = ? AND date BETWEEN ? AND ?
       ORDER BY date`
    )
    .all(site, start, end);
}

/** The most recent cwv_snapshots row for a site, or null if none exist. */
export function latestCwv(site: string, db: Database.Database = getDb()): CwvRow | null {
  const row = db
    .prepare<[string], CwvRow>(
      `SELECT site, url, captured_at, lcp_p75, inp_p75, cls_p75, source, form_factor
       FROM cwv_snapshots
       WHERE site = ?
       ORDER BY captured_at DESC
       LIMIT 1`
    )
    .get(site);
  return row ?? null;
}

/** All configured sites' display metadata, ordered by display_name. */
export function listSiteConfigs(db: Database.Database = getDb()): SiteConfig[] {
  return db
    .prepare<[], SiteConfig>(
      `SELECT property, slug, display_name AS displayName, brand_token AS brandToken
       FROM sites
       ORDER BY display_name`
    )
    .all();
}

/** A single site's display metadata by slug, or null if no site has that slug. */
export function siteConfigBySlug(
  slug: string,
  db: Database.Database = getDb()
): SiteConfig | null {
  const row = db
    .prepare<[string], SiteConfig>(
      `SELECT property, slug, display_name AS displayName, brand_token AS brandToken
       FROM sites
       WHERE slug = ?`
    )
    .get(slug);
  return row ?? null;
}

/**
 * The newest collection_runs row for each site that has ever run.
 *
 * A site configured in `sites` but absent from the result has simply never
 * run — that absence is the signal, and `lib/health.ts` turns it into a
 * 'never-run' state distinct from a failure. Deliberately no placeholder
 * row is synthesised here, because "never ran" and "ran and failed" are
 * different facts and must not arrive looking alike.
 */
export function latestRunPerSite(db: Database.Database = getDb()): RunRow[] {
  return db
    .prepare<[], RunRow>(
      `SELECT site,
              started_at   AS startedAt,
              finished_at  AS finishedAt,
              rows_written AS rowsWritten,
              status,
              error
       FROM collection_runs
       WHERE id IN (
         SELECT id FROM collection_runs cr
         WHERE cr.site = collection_runs.site
         ORDER BY started_at DESC, id DESC
         LIMIT 1
       )
       ORDER BY site`
    )
    .all();
}

/**
 * MAX(date) from totals_daily for one site, or null if the site has no rows.
 *
 * Deliberately its own query rather than derived from a recent window's
 * rows: if the collector died 40 days ago the recent window is empty, and
 * the caller must still be able to distinguish "collector broken" from "no
 * data at all".
 */
export function latestTotalsDate(site: string, db: Database.Database = getDb()): string | null {
  const row = db
    .prepare<[string], { maxDate: string | null }>(
      `SELECT MAX(date) AS maxDate FROM totals_daily WHERE site = ?`
    )
    .get(site);
  return row?.maxDate ?? null;
}
