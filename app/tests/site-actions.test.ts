import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The actions call revalidatePath, which needs a running Next server.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { addSite, removeSite, type AddSiteState } from "../app/sites/actions";

const INITIAL: AddSiteState = { errors: {}, ok: false };
const MALFORMED = "[\n  { \"property\": \"sc-domain:kept.com\", \"slug\": \"kept\",\n";

const ENV_KEYS = ["SEO_DB_PATH", "SEO_USER_SITES_PATH", "SEO_ACCESSIBLE_PROPERTIES_PATH"] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let dir: string;
let sitesFile: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seo-cockpit-actions-"));
  const dbPath = path.join(dir, "seo.db");
  const db = new BetterSqlite3(dbPath);
  db.exec(`
    CREATE TABLE sites (
      property TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      brand_token TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.close();
  process.env.SEO_DB_PATH = dbPath;
  // No accessible-properties list yet: the add check soft-allows.
  delete process.env.SEO_ACCESSIBLE_PROPERTIES_PATH;
});

beforeEach(() => {
  sitesFile = path.join(dir, `user-sites-${Math.random().toString(36).slice(2)}.json`);
  process.env.SEO_USER_SITES_PATH = sitesFile;
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

function addForm(property: string, displayName: string): FormData {
  const form = new FormData();
  form.set("property", property);
  form.set("displayName", displayName);
  form.set("brandToken", displayName.toLowerCase());
  return form;
}

describe("addSite with a malformed user-sites.json", () => {
  it("refuses to write and reports the parse error on the form", async () => {
    fs.writeFileSync(sitesFile, MALFORMED);

    const state = await addSite(INITIAL, addForm("sc-domain:new.com", "New"));

    expect(state.ok).toBe(false);
    expect(state.errors.form).toMatch(/could not be parsed/i);
    expect(state.errors.form).toMatch(/JSON/);
    expect(fs.readFileSync(sitesFile, "utf-8")).toBe(MALFORMED);
  });
});

describe("removeSite with a malformed user-sites.json", () => {
  it("refuses to write, leaving the file as it was", async () => {
    fs.writeFileSync(sitesFile, MALFORMED);
    const form = new FormData();
    form.set("slug", "kept");

    await expect(removeSite(form)).rejects.toThrow(/could not be parsed/i);
    expect(fs.readFileSync(sitesFile, "utf-8")).toBe(MALFORMED);
  });
});

describe("the add/remove happy paths still write", () => {
  it("creates the file when it is missing", async () => {
    const state = await addSite(INITIAL, addForm("sc-domain:first.com", "First"));

    expect(state).toEqual({ errors: {}, ok: true });
    const onDisk = JSON.parse(fs.readFileSync(sitesFile, "utf-8"));
    expect(onDisk.map((s: { slug: string }) => s.slug)).toEqual(["first"]);
  });

  it("appends to an existing file and keeps the previous version as .bak", async () => {
    await addSite(INITIAL, addForm("sc-domain:first.com", "First"));
    const before = fs.readFileSync(sitesFile, "utf-8");

    await addSite(INITIAL, addForm("sc-domain:second.com", "Second"));

    const onDisk = JSON.parse(fs.readFileSync(sitesFile, "utf-8"));
    expect(onDisk.map((s: { slug: string }) => s.slug)).toEqual(["first", "second"]);
    expect(fs.readFileSync(`${sitesFile}.bak`, "utf-8")).toBe(before);
  });

  it("removes a site from a well-formed file", async () => {
    await addSite(INITIAL, addForm("sc-domain:first.com", "First"));
    await addSite(INITIAL, addForm("sc-domain:second.com", "Second"));
    const form = new FormData();
    form.set("slug", "first");

    await removeSite(form);

    const onDisk = JSON.parse(fs.readFileSync(sitesFile, "utf-8"));
    expect(onDisk.map((s: { slug: string }) => s.slug)).toEqual(["second"]);
  });
});
