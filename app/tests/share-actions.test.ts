import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const requestHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => requestHeaders.current }));

import { createShareLinkAction, revokeShareLinkAction, type ShareLinkState } from "../app/sites/actions";
import { SHARE_TOKEN_PATTERN, hashShareToken } from "../lib/shareLinks";

const INITIAL: ShareLinkState = { url: null, error: null };
const ENV_KEYS = ["SEO_DB_PATH", "SEO_SHARE_LINKS_PATH", "SEO_PUBLIC_BASE_URL", "SEO_INTERNAL_HOSTS",
  "SEO_DASHBOARD_PASSWORD"] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
let dir: string;
let linksFile: string;

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "share-actions-"));
  const dbPath = path.join(dir, "seo.db");
  const db = new BetterSqlite3(dbPath);
  db.exec(`CREATE TABLE sites (property TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL, brand_token TEXT NOT NULL, updated_at TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1);
    INSERT INTO sites VALUES ('https://optikacajs.rs/', 'optika-cajs', 'Optika Cajs', 'cajs', '2026-10-09', 1);`);
  db.close();
  process.env.SEO_DB_PATH = dbPath;
  process.env.SEO_PUBLIC_BASE_URL = "https://clients.deimos.agency/";
  delete process.env.SEO_INTERNAL_HOSTS;
  delete process.env.SEO_DASHBOARD_PASSWORD;
});

beforeEach(() => {
  linksFile = path.join(dir, `links-${Math.random().toString(36).slice(2)}.json`);
  process.env.SEO_SHARE_LINKS_PATH = linksFile;
  requestHeaders.current = new Headers();
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("createShareLinkAction", () => {
  it("returns the client URL once and stores only the token's hash", async () => {
    const state = await createShareLinkAction(INITIAL, form({ slug: "optika-cajs", label: "Optika – owner" }));

    expect(state.error).toBeNull();
    const match = /^https:\/\/clients\.deimos\.agency\/share\/(.+)$/.exec(state.url ?? "");
    expect(match).not.toBeNull();
    const token = match![1];
    expect(token).toMatch(SHARE_TOKEN_PATTERN);
    const onDisk = fs.readFileSync(linksFile, "utf-8");
    expect(onDisk).not.toContain(token);
    expect(JSON.parse(onDisk)[0]).toMatchObject({
      property: "https://optikacajs.rs/",
      label: "Optika – owner",
      token_hash: hashShareToken(token),
    });
  });

  it("asks for a label and refuses an unknown site", async () => {
    expect((await createShareLinkAction(INITIAL, form({ slug: "optika-cajs", label: "  " }))).error).toMatch(/label/i);
    expect((await createShareLinkAction(INITIAL, form({ slug: "nope", label: "x" }))).error).toMatch(/unknown site/i);
    expect(fs.existsSync(linksFile)).toBe(false);
  });

  it("says which setting is missing", async () => {
    const base = process.env.SEO_PUBLIC_BASE_URL;
    delete process.env.SEO_PUBLIC_BASE_URL;
    const state = await createShareLinkAction(INITIAL, form({ slug: "optika-cajs", label: "x" }));
    process.env.SEO_PUBLIC_BASE_URL = base;
    expect(state.error).toMatch(/SEO_PUBLIC_BASE_URL/);
  });

  it("is refused from the public host", async () => {
    process.env.SEO_INTERNAL_HOSTS = "192.168.1.156:8091";
    requestHeaders.current = new Headers({ host: "clients.deimos.agency" });
    await expect(
      createShareLinkAction(INITIAL, form({ slug: "optika-cajs", label: "x" })),
    ).rejects.toThrow("Not authorized");
    delete process.env.SEO_INTERNAL_HOSTS;
    expect(fs.existsSync(linksFile)).toBe(false);
  });
});

describe("revokeShareLinkAction", () => {
  it("revokes the link with that id", async () => {
    await createShareLinkAction(INITIAL, form({ slug: "optika-cajs", label: "owner" }));
    const id = JSON.parse(fs.readFileSync(linksFile, "utf-8"))[0].id;

    await revokeShareLinkAction(form({ id }));

    expect(JSON.parse(fs.readFileSync(linksFile, "utf-8"))[0].revoked_at).not.toBeNull();
  });
});
