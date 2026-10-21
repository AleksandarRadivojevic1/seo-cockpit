import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DIGEST_LIMITS, DIGEST_SEMANTICS, buildAgentDigest } from "../lib/agentDigest";
import type { SiteConfig } from "../lib/db";
import { buildReportData } from "../lib/report/data";

const CONFIG: SiteConfig = {
  property: "https://example.rs/",
  slug: "example",
  displayName: "Primer",
  brandToken: "primer",
};

// asOf 2026-07-26 -> recent window 2026-06-26..2026-07-23, prior 2026-05-29..2026-06-25.
const AS_OF = "2026-07-26";
const RECENT_DAY = "2026-07-20";
const PRIOR_DAY = "2026-06-10";

/** Every column the digest's queries touch, mirroring the collector schema. */
const SCHEMA = `
  CREATE TABLE totals_daily (
    site TEXT, date TEXT, clicks INT, impressions INT, ctr REAL, position REAL,
    PRIMARY KEY (site, date));
  CREATE TABLE query_daily (
    site TEXT, date TEXT, query TEXT, clicks INT, impressions INT, ctr REAL, position REAL,
    PRIMARY KEY (site, date, query));
  CREATE TABLE page_daily (
    site TEXT, date TEXT, page TEXT, clicks INT, impressions INT, ctr REAL, position REAL,
    PRIMARY KEY (site, date, page));
  CREATE TABLE cwv_snapshots (
    site TEXT, url TEXT, captured_at TEXT, lcp_p75 REAL, inp_p75 REAL, cls_p75 REAL,
    source TEXT, form_factor TEXT,
    lh_performance REAL, lh_accessibility REAL, lh_best_practices REAL, lh_seo REAL);
  CREATE TABLE demand_keywords (
    site TEXT, keyword TEXT, source TEXT, seed TEXT, suggest_rank INT,
    rising_pct REAL, rising_label TEXT, top_value REAL, volume INT,
    first_seen TEXT, last_seen TEXT,
    PRIMARY KEY (site, keyword, source));
  CREATE TABLE query_page_snapshot (
    site TEXT, query TEXT, page TEXT, clicks INTEGER, impressions INTEGER,
    ctr REAL, position REAL, window_start TEXT, window_end TEXT, captured_at TEXT,
    PRIMARY KEY (site, query, page));
  CREATE TABLE sites (
    property TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
    brand_token TEXT NOT NULL, updated_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
`;

function makeDb(): Database.Database {
  const db = new BetterSqlite3(":memory:");
  db.exec(SCHEMA);
  return db;
}

function query(
  db: Database.Database,
  date: string,
  q: string,
  impressions: number,
  position: number,
  clicks = 0
): void {
  db.prepare(
    "INSERT INTO query_daily (site, date, query, clicks, impressions, ctr, position) VALUES (?,?,?,?,?,?,?)"
  ).run(CONFIG.property, date, q, clicks, impressions, impressions > 0 ? clicks / impressions : 0, position);
}

function totals(db: Database.Database, date: string, impressions: number): void {
  db.prepare(
    "INSERT INTO totals_daily (site, date, clicks, impressions, ctr, position) VALUES (?,?,?,?,?,?)"
  ).run(CONFIG.property, date, 1, impressions, 1 / impressions, 12.0);
}

function demand(db: Database.Database, keyword: string, suggestRank: number | null): void {
  db.prepare(
    `INSERT INTO demand_keywords (site, keyword, source, seed, suggest_rank, rising_pct,
       rising_label, top_value, volume, first_seen, last_seen)
     VALUES (?, ?, 'autocomplete', 'naocare', ?, NULL, NULL, NULL, NULL, '2026-07-01', '2026-07-20')`
  ).run(CONFIG.property, keyword, suggestRank);
}

describe("buildAgentDigest", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it("keeps every unmeasured value null through a JSON round trip", () => {
    // An agent reads this over HTTP. JSON.stringify drops `undefined`, so a
    // field that was undefined rather than null would vanish and read as
    // "absent" -- the agent would then guess. Every gap must survive as null.
    const digest = JSON.parse(JSON.stringify(buildAgentDigest(CONFIG, AS_OF, db)));

    expect(digest.dataState).toBe("not-collected");
    expect(digest.totals.avgPosition).toBeNull();
    expect(digest.totals.clicks.deltaPct).toBeNull();
    expect(digest.window.measuredStart).toBeNull();
    expect(digest.cwv).toBeNull();
    expect(digest.growth).toBeNull();
    expect(digest.demand.notCollected).toBe(true);
    expect(digest.cannibalization.notCollected).toBe(true);
    expect(digest.serp.state).toBe("not-checked");
  });

  it("carries the reading rules with the data", () => {
    const digest = buildAgentDigest(CONFIG, AS_OF, db);
    expect(digest.semantics).toEqual(DIGEST_SEMANTICS);
    expect(digest.semantics.some((s) => s.startsWith("null means NOT MEASURED"))).toBe(true);
  });

  it("quotes the same totals as the client report", () => {
    // The whole point of building on buildReportData: an agent's ticket can
    // never cite a number the client's PDF disagrees with.
    totals(db, RECENT_DAY, 40);
    totals(db, PRIOR_DAY, 20);
    query(db, RECENT_DAY, "naocare cena", 8, 30.5);

    const digest = buildAgentDigest(CONFIG, AS_OF, db);
    const report = buildReportData(CONFIG, AS_OF, db);

    expect(digest.totals.impressions).toBe(report.impressions);
    expect(digest.totals.clicks.recent).toBe(report.clicks.recent);
    expect(digest.totals.nonBrandImpressions).toBe(report.breakdown.nonBrandImpressions);
    expect(digest.opportunities.map((o) => o.query)).toEqual(
      report.opportunities.map((o) => o.query)
    );
  });

  it("lists non-brand, off-page-1 opportunities only", () => {
    query(db, RECENT_DAY, "primer optika", 20, 2.0, 5); // brand
    query(db, RECENT_DAY, "optika leskovac", 15, 8.7); // page 1: score 0
    query(db, RECENT_DAY, "tecnost za sociva", 12, 30.5); // the real upside

    const names = buildAgentDigest(CONFIG, AS_OF, db).opportunities.map((o) => o.query);
    expect(names).toEqual(["tecnost za sociva"]);
  });

  it("reports a new query as emerging with null deltas, not zero", () => {
    query(db, RECENT_DAY, "naocare za racunar", 6, 18.2);

    const [entry] = buildAgentDigest(CONFIG, AS_OF, db).emerging;
    expect(entry.query).toBe("naocare za racunar");
    expect(entry.impressionsDelta).toBeNull();
    expect(entry.positionDelta).toBeNull();
  });

  it("reports climbing queries with a positive delta, rounded to one decimal", () => {
    query(db, PRIOR_DAY, "kontaktna sociva", 10, 25.33);
    query(db, RECENT_DAY, "kontaktna sociva", 12, 14.11);

    const [entry] = buildAgentDigest(CONFIG, AS_OF, db).climbing;
    expect(entry.query).toBe("kontaktna sociva");
    expect(entry.position).toBe(14.1);
    expect(entry.positionDelta).toBe(11.2);
  });

  it("caps every list so a digest stays a few thousand tokens", () => {
    for (let i = 0; i < 40; i += 1) query(db, RECENT_DAY, `upit ${i}`, 10 + i, 20 + i);
    for (let i = 0; i < 50; i += 1) demand(db, `kljucna rec ${i}`, i);

    const digest = buildAgentDigest(CONFIG, AS_OF, db);
    expect(digest.opportunities).toHaveLength(DIGEST_LIMITS.opportunities);
    expect(digest.emerging).toHaveLength(DIGEST_LIMITS.signal);
    expect(digest.demand.gaps).toHaveLength(DIGEST_LIMITS.demandGaps);
    // The counts stay whole even when the list is capped.
    expect(digest.totals.nonBrandQueryCount).toBe(40);
    expect(digest.demand.totalDiscovered).toBe(50);
  });

  it("drops a demand keyword the site already ranks for, across diacritics", () => {
    query(db, RECENT_DAY, "sociva cena", 5, 22.0);
    demand(db, "sočiva cena", 1);
    demand(db, "naočare za sunce", 2);

    const digest = buildAgentDigest(CONFIG, AS_OF, db);
    expect(digest.demand.gaps.map((g) => g.keyword)).toEqual(["naočare za sunce"]);
    expect(digest.demand.covered).toBe(1);
    // No source has measured volume: it stays null, never 0.
    expect(digest.demand.gaps[0].volume).toBeNull();
  });

  it("includes cannibalized queries from the query x page snapshot", () => {
    const ins = db.prepare(
      `INSERT INTO query_page_snapshot VALUES (?, 'naocare', ?, ?, ?, 0.0, ?, '2026-06-26', '2026-07-23', '2026-07-24T03:00:00')`
    );
    ins.run(CONFIG.property, "https://example.rs/", 3, 40, 9.0);
    ins.run(CONFIG.property, "https://example.rs/naocare/", 1, 30, 14.0);

    const digest = buildAgentDigest(CONFIG, AS_OF, db);
    expect(digest.cannibalization.notCollected).toBe(false);
    expect(digest.cannibalization.items[0].query).toBe("naocare");
  });

  it("tracks a query by name after it leaves the opportunity list", () => {
    // Shipped work succeeded: the query climbed onto page 1, its score went
    // to 0 and it dropped out of `opportunities`. Tracking must still see it.
    query(db, PRIOR_DAY, "tecnost za sociva", 12, 30.5);
    query(db, RECENT_DAY, "tečnost za sočiva", 3, 9.0); // GSC recorded the diacritic spelling
    query(db, RECENT_DAY, "tecnost za sociva", 20, 7.2);

    const digest = buildAgentDigest(CONFIG, AS_OF, db, {
      track: ["Tečnost za sočiva", "sociva beograd", "tecnost za sociva"],
    });

    expect(digest.opportunities.map((o) => o.query)).not.toContain("tecnost za sociva");
    expect(digest.tracked).toHaveLength(2); // the folded duplicate is asked once
    const [hit, miss] = digest.tracked;
    expect(hit.inRecentWindow).toBe(true);
    expect(hit.entry?.query).toBe("tecnost za sociva"); // the spelling with more impressions
    expect(hit.entry?.position).toBe(7.2);
    expect(hit.entry?.positionDelta).toBe(23.3);
    expect(miss).toEqual({ requested: "sociva beograd", inRecentWindow: false, entry: null });
  });

  it("tracks a đ query that GSC recorded with the dj spelling", () => {
    query(db, RECENT_DAY, "torta za rodjendan", 8, 14.0);

    const [hit] = buildAgentDigest(CONFIG, AS_OF, db, { track: ["torta za rođendan"] }).tracked;

    expect(hit.inRecentWindow).toBe(true);
    expect(hit.entry?.query).toBe("torta za rodjendan");
  });

  it("tracks nothing when nothing is asked, and caps a long request", () => {
    expect(buildAgentDigest(CONFIG, AS_OF, db).tracked).toEqual([]);
    const many = Array.from({ length: 30 }, (_, i) => `upit ${i}`);
    expect(buildAgentDigest(CONFIG, AS_OF, db, { track: many }).tracked).toHaveLength(
      DIGEST_LIMITS.tracked
    );
  });

  it("reports the latest Core Web Vitals snapshot, keeping unfetched scores null", () => {
    db.prepare(
      `INSERT INTO cwv_snapshots VALUES (?, 'https://example.rs/', '2026-07-24T03:00:00',
         2400, NULL, 0.05, 'crux', 'PHONE', 91, NULL, 100, 92)`
    ).run(CONFIG.property);

    const { cwv } = buildAgentDigest(CONFIG, AS_OF, db);
    expect(cwv?.lcpP75).toBe(2400);
    expect(cwv?.inpP75).toBeNull();
    expect(cwv?.lighthouse.accessibility).toBeNull();
    expect(cwv?.lighthouse.seo).toBe(92);
  });
});

describe("GET /api/agent/digest", () => {
  let dir: string;
  const original = process.env.SEO_DB_PATH;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-digest-"));
    const dbPath = path.join(dir, "seo.db");
    const db = new BetterSqlite3(dbPath);
    db.exec(SCHEMA);
    db.exec(`INSERT INTO sites VALUES ('https://optikacajs.rs/', 'optika-cajs', 'Optika Cajs', 'cajs', '2026-10-09', 1);
             INSERT INTO sites VALUES ('https://old.rs/', 'old', 'Old', 'old', '2026-10-09', 0);`);
    db.close();
    process.env.SEO_DB_PATH = dbPath;
  });

  afterAll(() => {
    if (original === undefined) delete process.env.SEO_DB_PATH;
    else process.env.SEO_DB_PATH = original;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns every active site, never a retired one, uncached", async () => {
    const { GET } = await import("../app/api/agent/digest/route");
    const res = GET(new Request("http://piserver:8091/api/agent/digest"));

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(body.sites.map((s: { site: { slug: string } }) => s.site.slug)).toEqual(["optika-cajs"]);
  });

  it("returns one site by slug and 404s an unknown or retired one", async () => {
    const { GET } = await import("../app/api/agent/digest/route");

    const one = GET(new Request("http://piserver:8091/api/agent/digest?site=optika-cajs"));
    const site = (await one.json()).site;
    expect(site.name).toBe("Optika Cajs");
    // No language column in this fixture: the client default, Serbian.
    expect(site.language).toBe("sr");

    expect(GET(new Request("http://piserver:8091/api/agent/digest?site=nope")).status).toBe(404);
    expect(GET(new Request("http://piserver:8091/api/agent/digest?site=old")).status).toBe(404);
  });

  it("passes repeated track params through", async () => {
    const { GET } = await import("../app/api/agent/digest/route");
    const res = GET(
      new Request("http://piserver:8091/api/agent/digest?site=optika-cajs&track=naocare&track=sociva")
    );
    const body = await res.json();
    expect(body.tracked.map((t: { requested: string }) => t.requested)).toEqual(["naocare", "sociva"]);
  });
});
