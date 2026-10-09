import { afterAll, beforeAll, describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getDb, siteConfigByProperty } from "../lib/db";
import { createShareLink, newShareToken, revokeShareLink } from "../lib/shareLinks";
import { resolveShare } from "../lib/shareScope";

const LIVE = "https://optikacajs.rs/";
const RETIRED = "https://gone.example/";

let dir: string;
let linksFile: string;
let db: BetterSqlite3.Database;
let liveToken: string;
let revokedToken: string;
let retiredToken: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "share-scope-"));
  const dbPath = path.join(dir, "seo.db");
  const w = new BetterSqlite3(dbPath);
  w.exec(`CREATE TABLE sites (property TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL, brand_token TEXT NOT NULL, updated_at TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1);`);
  w.prepare("INSERT INTO sites VALUES (?, 'optika-cajs', 'Optika Cajs', 'cajs', '2026-10-09', 1)").run(LIVE);
  w.prepare("INSERT INTO sites VALUES (?, 'gone', 'Gone', 'gone', '2026-10-09', 0)").run(RETIRED);
  w.close();
  db = getDb(dbPath);

  linksFile = path.join(dir, "share-links.json");
  liveToken = createShareLink(linksFile, { property: LIVE, label: "owner" }).token;
  const revoked = createShareLink(linksFile, { property: LIVE, label: "old" });
  revokeShareLink(linksFile, revoked.link.id);
  revokedToken = revoked.token;
  retiredToken = createShareLink(linksFile, { property: RETIRED, label: "former client" }).token;
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("siteConfigByProperty", () => {
  it("returns an active site and nothing for a retired or unknown one", () => {
    expect(siteConfigByProperty(LIVE, db)?.slug).toBe("optika-cajs");
    expect(siteConfigByProperty(RETIRED, db)).toBeNull();
    expect(siteConfigByProperty("https://unknown.example/", db)).toBeNull();
  });
});

describe("resolveShare", () => {
  it("turns a valid token into its site", () => {
    const share = resolveShare(liveToken, { filePath: linksFile, db });
    expect(share?.config.property).toBe(LIVE);
    expect(share?.link.label).toBe("owner");
  });

  it("refuses a revoked token, an unknown one, and garbage", () => {
    expect(resolveShare(revokedToken, { filePath: linksFile, db })).toBeNull();
    expect(resolveShare(newShareToken(), { filePath: linksFile, db })).toBeNull();
    expect(resolveShare("../../etc/passwd", { filePath: linksFile, db })).toBeNull();
  });

  it("refuses a link to a site that was removed, even if never revoked", () => {
    expect(resolveShare(retiredToken, { filePath: linksFile, db })).toBeNull();
  });

  it("refuses everything when the links file is missing or malformed", () => {
    expect(resolveShare(liveToken, { filePath: path.join(dir, "nope.json"), db })).toBeNull();
    const broken = path.join(dir, "broken.json");
    fs.writeFileSync(broken, "{ broken");
    expect(resolveShare(liveToken, { filePath: broken, db })).toBeNull();
  });
});
