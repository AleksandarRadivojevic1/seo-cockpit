/**
 * Seeds a demo SQLite database matching the collector's schema.
 *
 * Why this exists: the real seo.db is too thin to judge a layout against.
 * Across all three real sites only six queries clear the noise floor, and
 * four of those are the client's own brand name — so most panels render
 * empty everywhere. A design can't be reviewed against nothing.
 *
 * Run:  node --experimental-strip-types scripts/seed-demo-db.ts [outPath]
 * Then: SEO_DB_PATH=<outPath> npm run dev
 *
 * Dev-only. Never imported by the app, and the DB it writes is gitignored.
 */

import BetterSqlite3 from "better-sqlite3";

// Mirrors lib/analysis/windows.ts. Duplicated rather than imported because
// that module's extensionless relative imports don't resolve under node's
// type-stripping loader. Keep in sync; a drift here only mis-shapes demo
// data, it can't affect the app.
const WINDOW_DAYS = 28;
const LAG_DAYS = 3;

const SCHEMA = `
CREATE TABLE totals_daily (
  site TEXT NOT NULL, date TEXT NOT NULL, clicks INTEGER, impressions INTEGER,
  ctr REAL, position REAL, PRIMARY KEY (site, date));
CREATE TABLE query_daily (
  site TEXT NOT NULL, date TEXT NOT NULL, query TEXT NOT NULL, clicks INTEGER,
  impressions INTEGER, ctr REAL, position REAL, PRIMARY KEY (site, date, query));
CREATE TABLE page_daily (
  site TEXT NOT NULL, date TEXT NOT NULL, page TEXT NOT NULL, clicks INTEGER,
  impressions INTEGER, ctr REAL, position REAL, PRIMARY KEY (site, date, page));
CREATE TABLE country_daily (
  site TEXT NOT NULL, date TEXT NOT NULL, country TEXT NOT NULL, clicks INTEGER,
  impressions INTEGER, ctr REAL, position REAL, PRIMARY KEY (site, date, country));
CREATE TABLE cwv_snapshots (
  site TEXT NOT NULL, url TEXT NOT NULL, captured_at TEXT NOT NULL,
  lcp_p75 REAL, inp_p75 REAL, cls_p75 REAL, source TEXT NOT NULL, form_factor TEXT,
  lh_performance REAL, lh_accessibility REAL, lh_best_practices REAL, lh_seo REAL);
CREATE TABLE sites (
  property TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
  brand_token TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE collection_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, site TEXT NOT NULL, started_at TEXT NOT NULL,
  finished_at TEXT, rows_written INTEGER, status TEXT NOT NULL, error TEXT);
`;

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Deterministic 0..1 noise from a string, so re-running the seed produces
 * an identical database.
 */
function hashUnit(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000;
}

/**
 * Day-to-day wobble around a query's baseline.
 *
 * Constant daily values produce a dead-flat trend line pinned to the top of
 * the y-scale — an unrealistic demo, and one that could hide a genuine
 * charting bug.
 *
 * Keyed on the day's INDEX within its window, not on the date, so day 3 of
 * the prior window gets exactly the same factor as day 3 of the recent one.
 * Independent noise per date does not work here: at ±35% over 28 days the
 * random difference between two windows is routinely ~45 impressions, which
 * is far past RISING_MIN_DELTA (10) and silently drags flat queries into the
 * rising and declining lists. Sharing the pattern makes aggregate deltas
 * depend only on the baselines the fixtures declare.
 */
function wobble(query: string, dayIndex: number, spread: number): number {
  return 1 + (hashUnit(`${query}|${dayIndex}`) - 0.5) * 2 * spread;
}

/** Per-day figures for one query in one window. */
interface DayShape {
  impressions: number;
  clicks: number;
  position: number;
}

interface DemoQuery {
  query: string;
  recent: DayShape;
  /** null = the query didn't exist in the prior window, i.e. "emerging". */
  prior: DayShape | null;
}

/**
 * Demo queries for the rich site, built so every signal bucket has content.
 *
 * Values are per-day and get repeated across all 28 days of a window, so an
 * aggregate delta is 28x the per-day difference — comfortably past
 * RISING_MIN_DELTA (10) wherever a difference is intended.
 */
const RICH_QUERIES: DemoQuery[] = [
  // --- non-brand, off page 1: the opportunity list's main content ------
  // Spread of impressions and CTR so opportunity scores differ widely and
  // the ranking bar has something to show.
  // Prior impressions deliberately EQUAL recent for these: a per-day drift
  // of even 1 becomes a 28-impression aggregate delta, which would drag the
  // whole set into "rising" and make that list meaningless.
  { query: "sočiva cena", recent: { impressions: 42, clicks: 1, position: 18.4 }, prior: { impressions: 42, clicks: 1, position: 18.9 } },
  { query: "kontaktna sočiva online", recent: { impressions: 30, clicks: 0, position: 14.2 }, prior: { impressions: 30, clicks: 0, position: 15.0 } },
  { query: "naočare za vid cena", recent: { impressions: 24, clicks: 2, position: 12.1 }, prior: { impressions: 24, clicks: 2, position: 12.6 } },
  { query: "tečnost za sočiva", recent: { impressions: 18, clicks: 0, position: 19.7 }, prior: null },
  { query: "dioptrijske naočare", recent: { impressions: 14, clicks: 1, position: 11.3 }, prior: { impressions: 14, clicks: 1, position: 11.8 } },
  { query: "očni pregled leskovac", recent: { impressions: 11, clicks: 0, position: 16.8 }, prior: { impressions: 11, clicks: 0, position: 17.2 } },
  { query: "sunčane naočare popust", recent: { impressions: 9, clicks: 0, position: 20.0 }, prior: { impressions: 9, clicks: 0, position: 19.4 } },
  { query: "multifokalna sočiva", recent: { impressions: 6, clicks: 0, position: 13.5 }, prior: { impressions: 6, clicks: 0, position: 13.9 } },

  // --- rising: recent impressions well above prior --------------------
  { query: "optičar blizu mene", recent: { impressions: 26, clicks: 3, position: 6.2 }, prior: { impressions: 8, clicks: 1, position: 6.9 } },
  { query: "zamena stakala naočare", recent: { impressions: 19, clicks: 2, position: 8.1 }, prior: { impressions: 5, clicks: 0, position: 8.4 } },

  // --- climbing: position improved by >= 3 spots ----------------------
  { query: "naočare za računar", recent: { impressions: 15, clicks: 2, position: 4.5 }, prior: { impressions: 15, clicks: 1, position: 9.8 } },
  { query: "okviri za naočare", recent: { impressions: 12, clicks: 1, position: 7.0 }, prior: { impressions: 12, clicks: 1, position: 13.4 } },

  // --- declining: impressions collapsed, or position worsened ---------
  { query: "jeftine naočare", recent: { impressions: 7, clicks: 0, position: 22.5 }, prior: { impressions: 34, clicks: 2, position: 15.1 } },
  { query: "sočiva za astigmatizam", recent: { impressions: 5, clicks: 0, position: 26.0 }, prior: { impressions: 6, clicks: 0, position: 18.2 } },

  // --- emerging: absent from the prior window entirely ----------------
  { query: "naočare za decu", recent: { impressions: 21, clicks: 2, position: 9.4 }, prior: null },
  { query: "polarizovana sočiva", recent: { impressions: 13, clicks: 1, position: 7.7 }, prior: null },

  // --- brand terms, page 1: excluded from the non-brand panel ---------
  { query: "demo optika", recent: { impressions: 88, clicks: 31, position: 1.2 }, prior: { impressions: 88, clicks: 28, position: 1.3 } },
  { query: "demo optika leskovac", recent: { impressions: 35, clicks: 12, position: 2.1 }, prior: { impressions: 35, clicks: 11, position: 2.0 } },
];

/**
 * Thin site: real queries, no movement, and — deliberately — every one of
 * them is the brand name. This is the fixture for the non-brand panel's
 * "Every query is your own brand name" state, which is exactly what the two
 * real client sites look like.
 */
const THIN_QUERIES: DemoQuery[] = [
  { query: "demo saas", recent: { impressions: 9, clicks: 4, position: 1.4 }, prior: { impressions: 9, clicks: 4, position: 1.5 } },
  { query: "demo saas pricing", recent: { impressions: 4, clicks: 1, position: 3.2 }, prior: { impressions: 4, clicks: 1, position: 3.1 } },
];

interface DemoSite {
  property: string;
  slug: string;
  displayName: string;
  brandToken: string;
  queries: DemoQuery[];
  /** 'zero' writes real rows that all measure zero; 'none' writes no rows. */
  totals: "normal" | "zero" | "none";
}

const SITES: DemoSite[] = [
  {
    property: "https://demo-optika.test/",
    slug: "demo-optika",
    displayName: "Demo Optika",
    brandToken: "demo optika",
    queries: RICH_QUERIES,
    totals: "normal",
  },
  {
    property: "https://demo-saas.test/",
    slug: "demo-saas",
    displayName: "Demo SaaS",
    brandToken: "demo saas",
    queries: THIN_QUERIES,
    totals: "normal",
  },
  {
    property: "https://demo-zero.test/",
    slug: "demo-zero",
    displayName: "Demo Zero",
    brandToken: "demozero",
    queries: [],
    totals: "zero",
  },
  {
    property: "https://demo-blank.test/",
    slug: "demo-blank",
    displayName: "Demo Blank",
    brandToken: "demoblank",
    queries: [],
    totals: "none",
  },
];

function seed(outPath: string): void {
  const db = new BetterSqlite3(outPath);
  db.exec(SCHEMA);

  const asOf = todayUTC();
  const recentEnd = addDays(asOf, -LAG_DAYS);
  const recentStart = addDays(recentEnd, -(WINDOW_DAYS - 1));
  const priorEnd = addDays(recentStart, -1);
  const priorStart = addDays(priorEnd, -(WINDOW_DAYS - 1));

  const insertSite = db.prepare(
    "INSERT INTO sites (property, slug, display_name, brand_token, updated_at) VALUES (?, ?, ?, ?, ?)"
  );
  const insertQuery = db.prepare(
    "INSERT INTO query_daily (site, date, query, clicks, impressions, ctr, position) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  const insertTotals = db.prepare(
    "INSERT INTO totals_daily (site, date, clicks, impressions, ctr, position) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const insertRun = db.prepare(
    "INSERT INTO collection_runs (site, started_at, finished_at, rows_written, status, error) VALUES (?, ?, ?, ?, ?, ?)"
  );

  // totals_daily is written from the same per-day sums that produced the
  // query rows, so the header numbers and the query tables can never
  // disagree with each other.
  function writeTotals(
    site: DemoSite,
    date: string,
    clicks: number,
    impressions: number,
    weightedPosition: number
  ): void {
    if (site.totals === "none") return;
    if (site.totals === "zero") {
      insertTotals.run(site.property, date, 0, 0, 0, 0);
      return;
    }
    insertTotals.run(
      site.property,
      date,
      clicks,
      impressions,
      impressions > 0 ? clicks / impressions : 0,
      impressions > 0 ? weightedPosition / impressions : 0
    );
  }

  function seedWindow(
    site: DemoSite,
    start: string,
    end: string,
    pick: (q: DemoQuery) => DayShape | null
  ): void {
    let dayIndex = 0;
    for (let date = start; date <= end; date = addDays(date, 1), dayIndex++) {
      let clicks = 0;
      let impressions = 0;
      let weightedPosition = 0;

      for (const demo of site.queries) {
        const shape = pick(demo);
        if (!shape) continue;

        const dayImpressions = Math.max(
          1,
          Math.round(shape.impressions * wobble(demo.query, dayIndex, 0.35))
        );
        const dayClicks = Math.min(
          dayImpressions,
          Math.round(shape.clicks * wobble(`c${demo.query}`, dayIndex, 0.35))
        );
        const dayPosition = Number(
          (shape.position * wobble(`p${demo.query}`, dayIndex, 0.02)).toFixed(2)
        );

        insertQuery.run(
          site.property,
          date,
          demo.query,
          dayClicks,
          dayImpressions,
          dayImpressions > 0 ? dayClicks / dayImpressions : 0,
          dayPosition
        );
        clicks += dayClicks;
        impressions += dayImpressions;
        weightedPosition += dayPosition * dayImpressions;
      }

      writeTotals(site, date, clicks, impressions, weightedPosition);
    }
  }

  const now = new Date().toISOString();
  for (const site of SITES) {
    insertSite.run(site.property, site.slug, site.displayName, site.brandToken, now);
    seedWindow(site, priorStart, priorEnd, (q) => q.prior);
    seedWindow(site, recentStart, recentEnd, (q) => q.recent);
    insertRun.run(site.property, now, now, 100, "success", null);
  }

  db.close();

  console.log(`Seeded ${outPath}`);
  console.log(`  recent window ${recentStart} .. ${recentEnd}`);
  console.log(`  prior  window ${priorStart} .. ${priorEnd}`);
  for (const site of SITES) {
    console.log(`  /site/${site.slug}  (${site.queries.length} queries, totals=${site.totals})`);
  }
}

seed(process.argv[2] ?? "/tmp/seo-cockpit-demo.db");
