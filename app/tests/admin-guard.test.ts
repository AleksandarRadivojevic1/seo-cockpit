import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const requestHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => requestHeaders.current }));

import {
  addSite,
  refreshProperties,
  removeSite,
  requestCollectionRun,
  type AddSiteState,
  type RefreshState,
  type RunState,
} from "../app/sites/actions";
import { isAdminRequest } from "../lib/adminGuard";

const AUTH = { username: "acko", password: "pw" };
const INTERNAL = "192.168.1.156:8091";
const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;

describe("isAdminRequest", () => {
  it("accepts an internal host with valid credentials", () => {
    expect(isAdminRequest({ host: INTERNAL, authorization: basic("acko", "pw") }, AUTH, INTERNAL)).toBe(true);
  });

  it("refuses an internal host without valid credentials when auth is on", () => {
    expect(isAdminRequest({ host: INTERNAL, authorization: null }, AUTH, INTERNAL)).toBe(false);
    expect(isAdminRequest({ host: INTERNAL, authorization: basic("acko", "no") }, AUTH, INTERNAL)).toBe(false);
  });

  it("refuses the public host even with valid credentials", () => {
    expect(
      isAdminRequest({ host: "clients.deimos.agency", authorization: basic("acko", "pw") }, AUTH, INTERNAL),
    ).toBe(false);
  });

  it("accepts any internal request when auth is off, and any host when no hosts are listed", () => {
    expect(isAdminRequest({ host: INTERNAL, authorization: null }, null, INTERNAL)).toBe(true);
    expect(isAdminRequest({ host: "clients.deimos.agency", authorization: null }, null, undefined)).toBe(true);
  });
});

describe("admin actions refuse a request from the public host", () => {
  const ENV_KEYS = ["SEO_INTERNAL_HOSTS", "SEO_USER_SITES_PATH", "SEO_RUN_TRIGGER_PATH",
    "SEO_REFRESH_TRIGGER_PATH", "SEO_DB_PATH", "SEO_DASHBOARD_PASSWORD"] as const;
  const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "seo-cockpit-guard-"));
    const db = new BetterSqlite3(path.join(dir, "seo.db"));
    db.exec(`CREATE TABLE sites (property TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL, brand_token TEXT NOT NULL, updated_at TEXT NOT NULL);`);
    db.close();
    process.env.SEO_DB_PATH = path.join(dir, "seo.db");
    process.env.SEO_INTERNAL_HOSTS = INTERNAL;
    process.env.SEO_USER_SITES_PATH = path.join(dir, "user-sites.json");
    process.env.SEO_RUN_TRIGGER_PATH = path.join(dir, "run-now.json");
    process.env.SEO_REFRESH_TRIGGER_PATH = path.join(dir, "refresh.json");
    delete process.env.SEO_DASHBOARD_PASSWORD;
  });

  beforeEach(() => {
    requestHeaders.current = new Headers({ host: "clients.deimos.agency" });
  });

  afterAll(() => {
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
    requestHeaders.current = new Headers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses every admin action and writes nothing", async () => {
    const form = new FormData();
    form.set("property", "sc-domain:intruder.com");
    form.set("displayName", "Intruder");
    form.set("brandToken", "intruder");
    form.set("slug", "intruder");

    await expect(addSite({ errors: {}, ok: false } as AddSiteState, form)).rejects.toThrow("Not authorized");
    await expect(removeSite(form)).rejects.toThrow("Not authorized");
    await expect(requestCollectionRun({} as RunState, form)).rejects.toThrow("Not authorized");
    await expect(refreshProperties({} as RefreshState, form)).rejects.toThrow("Not authorized");

    for (const file of ["user-sites.json", "run-now.json", "refresh.json"]) {
      expect(fs.existsSync(path.join(dir, file)), file).toBe(false);
    }
  });

  it("runs for the internal host", async () => {
    requestHeaders.current = new Headers({ host: INTERNAL });
    const state = await requestCollectionRun({} as RunState, new FormData());
    expect(state.ok).toBe(true);
  });
});

describe("every admin action checks first", () => {
  it("starts each exported server action with assertAdminRequest()", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "app/sites/actions.ts"), "utf-8");
    const actions = [...source.matchAll(/export async function (\w+)\([^)]*\)[^{]*\{\s*([^\n]*)/g)];
    expect(actions.length).toBeGreaterThanOrEqual(4);
    for (const [, name, firstLine] of actions) {
      expect(firstLine.trim(), name).toBe("await assertAdminRequest();");
    }
  });
});
