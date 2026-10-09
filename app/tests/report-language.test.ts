import { afterAll, beforeAll, describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getDb, siteLanguage } from "../lib/db";
import { isReportLanguage, resolveReportLanguage } from "../lib/report/language";

describe("resolveReportLanguage", () => {
  it("uses ?lang= when it is exactly sr or en", () => {
    expect(resolveReportLanguage("en", "sr")).toBe("en");
    expect(resolveReportLanguage("sr", "en")).toBe("sr");
  });

  it("falls back to the site default for anything else", () => {
    expect(resolveReportLanguage(undefined, "en")).toBe("en");
    expect(resolveReportLanguage(null, "en")).toBe("en");
    expect(resolveReportLanguage("", "en")).toBe("en");
    expect(resolveReportLanguage("de", "sr")).toBe("sr");
    // Our own links always write lowercase; anything else is a mangled URL.
    expect(resolveReportLanguage("EN", "sr")).toBe("sr");
  });

  it("falls back for a repeated parameter (Next passes an array)", () => {
    expect(resolveReportLanguage(["en", "sr"], "sr")).toBe("sr");
  });

  it("recognizes exactly the two languages", () => {
    expect(isReportLanguage("sr")).toBe(true);
    expect(isReportLanguage("en")).toBe(true);
    expect(isReportLanguage("de")).toBe(false);
    expect(isReportLanguage(42)).toBe(false);
  });
});

describe("siteLanguage", () => {
  let dir: string;
  let migratedPath: string;
  let legacyPath: string;

  const COLUMNS = `
    property TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
    brand_token TEXT NOT NULL, updated_at TEXT NOT NULL`;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "seo-cockpit-lang-"));

    migratedPath = path.join(dir, "migrated.db");
    const migrated = new BetterSqlite3(migratedPath);
    migrated.exec(`CREATE TABLE sites (${COLUMNS}, language TEXT);`);
    const insert = migrated.prepare("INSERT INTO sites VALUES (?, ?, ?, ?, '2026-10-09', ?)");
    insert.run("sc-domain:us.example", "us", "US", "us", "en");
    insert.run("sc-domain:rs.example", "rs", "RS", "rs", "sr");
    insert.run("sc-domain:junk.example", "junk", "Junk", "junk", "fr");
    insert.run("sc-domain:null.example", "null", "Null", "null", null);
    migrated.close();

    // The collector hasn't migrated this one yet: no language column.
    legacyPath = path.join(dir, "legacy.db");
    const legacy = new BetterSqlite3(legacyPath);
    legacy.exec(`CREATE TABLE sites (${COLUMNS});`);
    legacy
      .prepare("INSERT INTO sites VALUES (?, ?, ?, ?, '2026-10-09')")
      .run("sc-domain:us.example", "us", "US", "us");
    legacy.close();
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads the stored language", () => {
    const db = getDb(migratedPath);
    expect(siteLanguage("sc-domain:us.example", db)).toBe("en");
    expect(siteLanguage("sc-domain:rs.example", db)).toBe("sr");
  });

  it("reads Serbian for an unknown value, a null, or an unknown site", () => {
    const db = getDb(migratedPath);
    expect(siteLanguage("sc-domain:junk.example", db)).toBe("sr");
    expect(siteLanguage("sc-domain:null.example", db)).toBe("sr");
    expect(siteLanguage("sc-domain:missing.example", db)).toBe("sr");
  });

  it("reads Serbian from a database without the column", () => {
    expect(siteLanguage("sc-domain:us.example", getDb(legacyPath))).toBe("sr");
  });
});
