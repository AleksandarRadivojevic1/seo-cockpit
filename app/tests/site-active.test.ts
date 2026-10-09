import { afterAll, beforeAll, describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  getDb,
  listRetiredSiteConfigs,
  listSiteConfigs,
  siteConfigBySlug,
} from "../lib/db";

// A removed site is retired by the collector (sites.active = 0), not deleted:
// its history stays, but it must not reach the overview, where its empty
// recent window would read as a portfolio traffic drop.

let dir: string;
let migratedPath: string;
let legacyPath: string;

const SITES_COLUMNS = `
  property TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  brand_token TEXT NOT NULL,
  updated_at TEXT NOT NULL`;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seo-cockpit-active-"));

  migratedPath = path.join(dir, "migrated.db");
  const migrated = new BetterSqlite3(migratedPath);
  migrated.exec(`CREATE TABLE sites (${SITES_COLUMNS}, active INTEGER NOT NULL DEFAULT 1);`);
  migrated
    .prepare("INSERT INTO sites VALUES (?, ?, ?, ?, '2026-07-20', ?)")
    .run("sc-domain:live.com", "live", "Live", "live", 1);
  migrated
    .prepare("INSERT INTO sites VALUES (?, ?, ?, ?, '2026-07-20', ?)")
    .run("sc-domain:gone.com", "gone", "Gone", "gone", 0);
  migrated.close();

  // A database the collector has not migrated yet: no `active` column. The
  // dashboard can be deployed first, so it must still read one.
  legacyPath = path.join(dir, "legacy.db");
  const legacy = new BetterSqlite3(legacyPath);
  legacy.exec(`CREATE TABLE sites (${SITES_COLUMNS});`);
  legacy
    .prepare("INSERT INTO sites VALUES (?, ?, ?, ?, '2026-07-20')")
    .run("sc-domain:live.com", "live", "Live", "live");
  legacy.close();
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("sites.active", () => {
  it("lists only active sites", () => {
    expect(listSiteConfigs(getDb(migratedPath)).map((c) => c.slug)).toEqual(["live"]);
  });

  it("does not resolve a retired site's slug", () => {
    const db = getDb(migratedPath);
    expect(siteConfigBySlug("gone", db)).toBeNull();
    expect(siteConfigBySlug("live", db)?.property).toBe("sc-domain:live.com");
  });

  it("lists retired sites separately", () => {
    expect(listRetiredSiteConfigs(getDb(migratedPath)).map((c) => c.slug)).toEqual(["gone"]);
  });

  it("treats every site as active in a database without the column", () => {
    const db = getDb(legacyPath);
    expect(listSiteConfigs(db).map((c) => c.slug)).toEqual(["live"]);
    expect(siteConfigBySlug("live", db)?.slug).toBe("live");
    expect(listRetiredSiteConfigs(db)).toEqual([]);
  });
});
