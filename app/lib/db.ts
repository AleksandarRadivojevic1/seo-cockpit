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
