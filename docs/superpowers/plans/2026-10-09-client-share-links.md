# Client Share Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A client opens `https://clients.deimos.agency/share/<token>` and sees only their own report (with SR / EN and PDF) and a read-only live dashboard, while the admin app stays behind Basic auth on the LAN.

**Architecture:** `proxy.ts` decides access per request with a pure `decideAccess()` (share paths: GET/HEAD only, open on every host, token checked in the route; internal hosts: Basic auth as today; any other host: 404). Every admin server action also calls `assertAdminRequest()`. Share links live in `config/share-links.json` as SHA-256 hashes; `resolveShare(token)` is the one place a token becomes a site. The client report reuses `ReportDocument`; the client live view reuses the dashboard after its body moves into a `SiteDashboard` component with header slots. A Cloudflare named tunnel (container) serves `clients.deimos.agency`.

**Tech Stack:** Next.js 16 (App Router, `proxy.ts`, server actions, `next/headers`), TypeScript, vitest + `renderToStaticMarkup`, better-sqlite3, Node `crypto`, Docker Compose, `cloudflare/cloudflared:2026.9.3`, the Cloudflare MCP server.

**Spec:** `docs/superpowers/specs/2026-10-09-client-share-links-design.md`

## Global Constraints

- Share paths (`/share/*`) accept **GET and HEAD only**; any other method, or any request carrying a `Next-Action` header, is `404`. They add `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex, nofollow`.
- Non-share paths on a host that is not internal → `404` (never 401/403). Internal = loopback (`127.0.0.1`, `localhost`, `[::1]`, any port) or a `host:port` listed in `SEO_INTERNAL_HOSTS`; **unset `SEO_INTERNAL_HOSTS` = every host internal** (today's behaviour).
- Every admin server action calls `await assertAdminRequest();` as its first statement.
- Tokens: 32 random bytes, base64url (43 chars, `^[A-Za-z0-9_-]{43}$`); stored only as SHA-256 hex; compared with `timingSafeEqual`; shown once.
- `share-links.json` uses snake_case on disk (`id`, `token_hash`, `property`, `label`, `created_at`, `revoked_at`); atomic write + `.bak`; a malformed file is refused, never overwritten.
- Links never expire; one site per link; several labelled links per site; a retired site's links resolve to `404`.
- The live dashboard is English; only the report is bilingual (per-site default + `?lang=`).
- Hostname `clients.deimos.agency`; tunnel image `cloudflare/cloudflared:2026.9.3`; origin `http://seo-cockpit-dashboard:3000`; 8091 stays LAN-only.
- The tunnel run token is never printed, fetched through the API, or pasted in chat; Aleksandar copies it from the Cloudflare dashboard into `~/server/.env` as `SEO_TUNNEL_TOKEN`.
- Existing test bodies stay unchanged (module-level setup may gain a mock for a new dependency; record it as a ruling).
- Commit messages: one plain imperative sentence, no prefix, **no attribution trailers**.
- Work inline in this session; scratch files in `WORK=/tmp/claude-1000/-home-ar-Documents-GitHub-seo-cockpit/43a79ef2-95da-4f61-aad8-1c711ed1c2a9/scratchpad/share-links` (set at the start of every shell command that uses it).

## Review Focus

1. **The Host the app sees through the tunnel.** cloudflared may forward the public hostname or the origin's (`seo-cockpit-dashboard:3000`); either must be treated as public, so `/` through the tunnel is `404`, never a password prompt. Pinned in Task 1 (unit) and Task 9 (through a real tunnel, with a non-loopback origin).
2. **Your own dashboard on an unlisted host** (e.g. `piserver:8091`) gets `404`. That is the fail-closed design; the default list covers the hosts in use, and `DEPLOY.md` says how to add one. Pinned in Task 1.
3. **`/share/` and `/share/<token>/` (trailing slash)** must not fall through to the admin rules. Pinned in Task 1.
4. **A fresh deploy with no `share-links.json`**: every share URL is `404`, and creating the first link creates the file. Pinned in Tasks 3 and 4.
5. **A link to a site that was later removed**: `404` for the client even though it was never revoked; the links page shows "site removed". Pinned in Tasks 4 and 6.

---

### Task 1: Access rules — `decideAccess` and the proxy

**Files:**
- Create: `app/lib/access.ts`
- Modify: `app/lib/basicAuth.ts` (export `PUBLIC_IMAGE`)
- Modify: `app/proxy.ts` (whole file)
- Test: `app/tests/share-access.test.ts` (new)

**Interfaces:**
- Consumes: `isAuthorized`, `BasicAuthConfig`, `basicAuthConfig`, `RENDER_TOKEN_PARAM`, `PUBLIC_IMAGE` (from `lib/basicAuth.ts`).
- Produces:
  - `export type AccessDecision = "share" | "allow" | "challenge" | "not-found"`
  - `export interface AccessRequest { method: string; pathname: string; host: string | null; authorization: string | null; renderToken: string | null; nextAction: boolean }`
  - `export function isInternalHost(host: string | null, internalHosts: string | undefined): boolean`
  - `export function decideAccess(req: AccessRequest, auth: BasicAuthConfig | null, internalHosts: string | undefined): AccessDecision`

- [ ] **Step 1: Write the failing tests** — create `app/tests/share-access.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { proxy } from "../proxy";
import { decideAccess, isInternalHost, type AccessRequest } from "../lib/access";

const INTERNAL = "192.168.1.156:8091,piserver.local:8091,localhost:8091";
const AUTH = { username: "acko", password: "pw" };
const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;

function req(over: Partial<AccessRequest>): AccessRequest {
  return {
    method: "GET",
    pathname: "/",
    host: "clients.deimos.agency",
    authorization: null,
    renderToken: null,
    nextAction: false,
    ...over,
  };
}

const ENV_KEYS = ["SEO_DASHBOARD_PASSWORD", "SEO_INTERNAL_HOSTS"] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
}

describe("isInternalHost", () => {
  it("treats every host as internal when SEO_INTERNAL_HOSTS is unset (today's behaviour)", () => {
    expect(isInternalHost("clients.deimos.agency", undefined)).toBe(true);
    expect(isInternalHost("clients.deimos.agency", "  ")).toBe(true);
  });

  it("matches a listed host:port exactly, ignoring case", () => {
    expect(isInternalHost("192.168.1.156:8091", INTERNAL)).toBe(true);
    expect(isInternalHost("PIServer.local:8091", INTERNAL)).toBe(true);
    expect(isInternalHost("192.168.1.156:8092", INTERNAL)).toBe(false);
  });

  it("always treats loopback as internal: the dashboard's own chromium prints over it", () => {
    expect(isInternalHost("127.0.0.1:3000", INTERNAL)).toBe(true);
    expect(isInternalHost("localhost:3999", INTERNAL)).toBe(true);
    expect(isInternalHost("[::1]:3000", INTERNAL)).toBe(true);
  });

  it("treats the tunnel's hosts, an unlisted own host, and a missing host as public", () => {
    // Whichever Host cloudflared forwards: the public name or the origin's.
    expect(isInternalHost("clients.deimos.agency", INTERNAL)).toBe(false);
    expect(isInternalHost("seo-cockpit-dashboard:3000", INTERNAL)).toBe(false);
    expect(isInternalHost("abc-def.trycloudflare.com", INTERNAL)).toBe(false);
    // Fail closed: an own host nobody listed gets the public treatment.
    expect(isInternalHost("piserver:8091", INTERNAL)).toBe(false);
    expect(isInternalHost(null, INTERNAL)).toBe(false);
  });
});

describe("decideAccess on a public host", () => {
  it("serves nothing but share pages and public images", () => {
    for (const auth of [AUTH, null]) {
      for (const pathname of ["/", "/site/optika-cajs", "/sites/add", "/sites/links",
        "/site/optika-cajs/report/pdf", "/share"]) {
        expect(decideAccess(req({ pathname }), auth, INTERNAL), pathname).toBe("not-found");
      }
      expect(decideAccess(req({ pathname: "/share/abc" }), auth, INTERNAL)).toBe("share");
      expect(decideAccess(req({ pathname: "/deimos-logo.svg" }), auth, INTERNAL)).toBe("allow");
    }
  });

  it("keeps a bare or trailing-slash share path on the share rules", () => {
    expect(decideAccess(req({ pathname: "/share/" }), AUTH, INTERNAL)).toBe("share");
    expect(decideAccess(req({ pathname: "/share/abc/" }), AUTH, INTERNAL)).toBe("share");
  });

  it("refuses anything but GET or HEAD on a share path, and any server action call", () => {
    expect(decideAccess(req({ pathname: "/share/abc", method: "HEAD" }), AUTH, INTERNAL)).toBe("share");
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      expect(decideAccess(req({ pathname: "/share/abc", method }), AUTH, INTERNAL), method).toBe("not-found");
    }
    expect(decideAccess(req({ pathname: "/share/abc", nextAction: true }), AUTH, INTERNAL)).toBe("not-found");
  });
});

describe("decideAccess on an internal host", () => {
  const host = "192.168.1.156:8091";

  it("keeps Basic auth exactly as before", () => {
    expect(decideAccess(req({ host }), AUTH, INTERNAL)).toBe("challenge");
    expect(decideAccess(req({ host, authorization: basic("acko", "pw") }), AUTH, INTERNAL)).toBe("allow");
    expect(decideAccess(req({ host, authorization: basic("acko", "no") }), AUTH, INTERNAL)).toBe("challenge");
  });

  it("allows everything when auth is off", () => {
    expect(decideAccess(req({ host }), null, INTERNAL)).toBe("allow");
  });

  it("still refuses a POST to a share path", () => {
    expect(decideAccess(req({ host, pathname: "/share/abc", method: "POST",
      authorization: basic("acko", "pw") }), AUTH, INTERNAL)).toBe("not-found");
  });

  it("lets the loopback PDF render through with credentials or its render token rule", () => {
    expect(decideAccess(req({ host: "127.0.0.1:3000", authorization: basic("acko", "pw") }),
      AUTH, INTERNAL)).toBe("allow");
  });
});

describe("proxy", () => {
  afterEach(restoreEnv);

  it("404s the admin app on the public host, without a password prompt", async () => {
    process.env.SEO_DASHBOARD_PASSWORD = "pw";
    process.env.SEO_INTERNAL_HOSTS = INTERNAL;
    const res = proxy(new NextRequest("https://clients.deimos.agency/"));
    expect(res.status).toBe(404);
    expect(res.headers.get("WWW-Authenticate")).toBeNull();
  });

  it("passes a share page and marks it no-referrer and noindex", () => {
    process.env.SEO_DASHBOARD_PASSWORD = "pw";
    process.env.SEO_INTERNAL_HOSTS = INTERNAL;
    const res = proxy(new NextRequest("https://clients.deimos.agency/share/abc"));
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });

  it("refuses a server action posted to a share path", () => {
    process.env.SEO_INTERNAL_HOSTS = INTERNAL;
    const res = proxy(
      new NextRequest("https://clients.deimos.agency/share/abc", {
        method: "POST",
        headers: { "next-action": "7f3a" },
      }),
    );
    expect(res.status).toBe(404);
  });

  it("still challenges the admin app on an internal host", () => {
    process.env.SEO_DASHBOARD_PASSWORD = "pw";
    process.env.SEO_INTERNAL_HOSTS = INTERNAL;
    const res = proxy(new NextRequest("http://192.168.1.156:8091/sites/add"));
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd app && npx vitest run tests/share-access.test.ts`
Expected: FAIL — `Cannot find module '../lib/access'`.

- [ ] **Step 3: Export `PUBLIC_IMAGE` from `app/lib/basicAuth.ts`** — change the line `const PUBLIC_IMAGE = /^\/[\w.-]+\.(?:svg|png|ico|jpe?g|webp)$/;` to:

```ts
export const PUBLIC_IMAGE = /^\/[\w.-]+\.(?:svg|png|ico|jpe?g|webp)$/;
```

- [ ] **Step 4: Create `app/lib/access.ts`**

```ts
import { PUBLIC_IMAGE, isAuthorized, type BasicAuthConfig } from "./basicAuth";

/**
 * Who may reach what, decided per request by proxy.ts. See
 * docs/superpowers/specs/2026-10-09-client-share-links-design.md.
 *
 * - "share": a GET/HEAD under `/share/`, open on every host; the route checks
 *   the token. Every host, because the PDF renderer's chromium loads share
 *   pages over loopback with no credentials.
 * - "allow": a public image, or an internal request that passes Basic auth
 *   (or auth is off).
 * - "challenge": an internal request without valid credentials.
 * - "not-found": everything else. That includes any other method on a share
 *   path (a server action is a POST to any page path, so allowing POSTs there
 *   would hand the internet the admin actions) and every non-share path on a
 *   public host. 404, never 403: don't confirm anything exists.
 */
export type AccessDecision = "share" | "allow" | "challenge" | "not-found";

export interface AccessRequest {
  method: string;
  pathname: string;
  /** The Host header, host:port. */
  host: string | null;
  authorization: string | null;
  renderToken: string | null;
  /** A `Next-Action` header is present: this is a server action call. */
  nextAction: boolean;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

function hostnameOf(host: string): string {
  if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1);
  const colon = host.lastIndexOf(":");
  return colon === -1 ? host : host.slice(0, colon);
}

/**
 * Whether `host` gets the admin app (still behind Basic auth). Loopback
 * always does: the dashboard's own chromium prints admin PDFs over it. With
 * `SEO_INTERNAL_HOSTS` unset every host does, which is the behaviour from
 * before share links. Anything else, including an unknown host, is public:
 * fail closed.
 */
export function isInternalHost(host: string | null, internalHosts: string | undefined): boolean {
  if (!internalHosts?.trim()) return true;
  if (!host) return false;
  const h = host.trim().toLowerCase();
  if (LOOPBACK.has(hostnameOf(h))) return true;
  return internalHosts
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .includes(h);
}

export function decideAccess(
  req: AccessRequest,
  auth: BasicAuthConfig | null,
  internalHosts: string | undefined,
): AccessDecision {
  const isRead = req.method === "GET" || req.method === "HEAD";
  if (req.pathname.startsWith("/share/")) {
    return isRead && !req.nextAction ? "share" : "not-found";
  }
  if (isRead && PUBLIC_IMAGE.test(req.pathname)) return "allow";
  if (!isInternalHost(req.host, internalHosts)) return "not-found";
  if (!auth) return "allow";
  return isAuthorized(
    {
      method: req.method,
      pathname: req.pathname,
      authorization: req.authorization,
      renderToken: req.renderToken,
    },
    auth,
  )
    ? "allow"
    : "challenge";
}
```

- [ ] **Step 5: Replace `app/proxy.ts`**

```ts
import { NextResponse, type NextRequest } from "next/server";

import { decideAccess } from "./lib/access";
import { RENDER_TOKEN_PARAM, basicAuthConfig } from "./lib/basicAuth";

// Logged once when the proxy loads, so `docker logs` shows whether the
// password reached the container (an unset one leaves the dashboard open).
const startupAuth = basicAuthConfig();
console.log(
  startupAuth
    ? `[auth] Basic auth enabled for user "${startupAuth.username}"`
    : "[auth] SEO_DASHBOARD_PASSWORD unset — auth disabled (dev mode)",
);

/**
 * Access control for every page, route handler and server action (a server
 * action is a POST to the page it lives on, so the matcher must cover pages,
 * not only an /api prefix). The rules live in lib/access.ts; admin server
 * actions also check for themselves (lib/adminGuard.ts).
 */
export function proxy(request: NextRequest) {
  const decision = decideAccess(
    {
      method: request.method,
      pathname: request.nextUrl.pathname,
      host: request.headers.get("host") ?? request.nextUrl.host,
      authorization: request.headers.get("authorization"),
      renderToken: request.nextUrl.searchParams.get(RENDER_TOKEN_PARAM),
      nextAction: request.headers.has("next-action"),
    },
    basicAuthConfig(),
    process.env.SEO_INTERNAL_HOSTS,
  );

  if (decision === "allow") return NextResponse.next();

  if (decision === "share") {
    const response = NextResponse.next();
    // The token is in the path: keep it out of Referer headers and indexes.
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
    return response;
  }

  if (decision === "challenge") {
    return new NextResponse("Authentication required.", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="SEO Cockpit", charset="UTF-8"' },
    });
  }

  return new NextResponse("Not found", { status: 404 });
}

export const config = {
  // Everything except Next's static build output, which holds no data.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
```

- [ ] **Step 6: Run the tests**

Run: `cd app && npx vitest run tests/share-access.test.ts tests/basic-auth.test.ts tests/proxy-matcher.test.ts && npx tsc --noEmit`
Expected: all pass (the existing proxy tests in `basic-auth.test.ts` are unchanged and still pass: with `SEO_INTERNAL_HOSTS` unset every host is internal), `tsc` silent.

- [ ] **Step 7: Commit**

```bash
git add app/lib/access.ts app/lib/basicAuth.ts app/proxy.ts app/tests/share-access.test.ts
git commit -m "Serve only share pages to hosts outside the LAN"
```

---

### Task 2: Admin server actions check the request themselves

**Files:**
- Create: `app/lib/adminGuard.ts`
- Modify: `app/app/sites/actions.ts` (import + first line of each action)
- Modify: `app/tests/site-actions.test.ts` (module-level `next/headers` mock only; no test body changes)
- Test: `app/tests/admin-guard.test.ts` (new)

**Interfaces:**
- Consumes: `isInternalHost` (Task 1); `basicAuthConfig`, `hasValidCredentials`, `BasicAuthConfig` (`lib/basicAuth.ts`).
- Produces:
  - `export function isAdminRequest(req: { host: string | null; authorization: string | null }, auth: BasicAuthConfig | null, internalHosts: string | undefined): boolean`
  - `export async function assertAdminRequest(): Promise<void>` — throws `Error("Not authorized.")`.

- [ ] **Step 1: Give the existing action tests a request** — the actions will read request headers, which don't exist outside a server. At the top of `app/tests/site-actions.test.ts`, directly after the line `vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));`, add:

```ts
// Admin actions check the request's headers (lib/adminGuard.ts). These tests
// run as today's local-dev case: no SEO_INTERNAL_HOSTS and no password, so an
// empty header set is an admin request.
const requestHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => requestHeaders.current }));
```

- [ ] **Step 2: Write the failing tests** — create `app/tests/admin-guard.test.ts`:

```ts
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
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd app && npx vitest run tests/admin-guard.test.ts tests/site-actions.test.ts`
Expected: `admin-guard.test.ts` FAILS (`Cannot find module '../lib/adminGuard'`); `site-actions.test.ts` still passes.

- [ ] **Step 4: Create `app/lib/adminGuard.ts`**

```ts
import { headers } from "next/headers";

import { isInternalHost } from "./access";
import { basicAuthConfig, hasValidCredentials, type BasicAuthConfig } from "./basicAuth";

/**
 * Whether a request may run an admin server action: it reached an internal
 * host, and carries valid Basic auth credentials when auth is on.
 */
export function isAdminRequest(
  req: { host: string | null; authorization: string | null },
  auth: BasicAuthConfig | null,
  internalHosts: string | undefined,
): boolean {
  if (!isInternalHost(req.host, internalHosts)) return false;
  return auth === null || hasValidCredentials(req.authorization, auth);
}

/**
 * Throws unless the current request may run an admin action. The first
 * statement of every admin server action.
 *
 * The proxy already guards every page, but a server action is a POST that
 * names the action in a header and can be sent to any path, so each action
 * checks for itself instead of trusting the proxy's matcher (Next's own
 * guidance for server functions).
 */
export async function assertAdminRequest(): Promise<void> {
  const h = await headers();
  const ok = isAdminRequest(
    { host: h.get("host"), authorization: h.get("authorization") },
    basicAuthConfig(),
    process.env.SEO_INTERNAL_HOSTS,
  );
  if (!ok) throw new Error("Not authorized.");
}
```

- [ ] **Step 5: Guard every action in `app/app/sites/actions.ts`** — add the import after the `writeRunTrigger` import:

```ts
import { assertAdminRequest } from "../../lib/adminGuard";
```

Then make `await assertAdminRequest();` the first statement of `addSite`, `removeSite`, `requestCollectionRun` and `refreshProperties` (before `const filePath = …` / `const p = …`).

- [ ] **Step 6: Run the tests**

Run: `cd app && npx vitest run && npx tsc --noEmit`
Expected: all pass, `tsc` silent.

- [ ] **Step 7: Commit**

```bash
git add app/lib/adminGuard.ts app/app/sites/actions.ts app/tests/admin-guard.test.ts app/tests/site-actions.test.ts
git commit -m "Make every admin action check the request itself"
```

---

### Task 3: The share link store

**Files:**
- Create: `app/lib/shareLinks.ts`
- Test: `app/tests/share-links.test.ts` (new)

**Interfaces:**
- Produces:
  - `export interface ShareLink { id: string; tokenHash: string; property: string; label: string; createdAt: string; revokedAt: string | null }`
  - `export type ShareLinksFile = { state: "missing" } | { state: "ok"; links: ShareLink[] } | { state: "malformed"; error: string }`
  - `export const SHARE_TOKEN_PATTERN: RegExp` (`/^[A-Za-z0-9_-]{43}$/`)
  - `export function newShareToken(): string`
  - `export function hashShareToken(token: string): string` (SHA-256 hex)
  - `export function loadShareLinks(filePath: string | undefined): ShareLinksFile`
  - `export function writeShareLinksAtomic(filePath: string, links: ShareLink[]): void`
  - `export function findShareLink(links: ShareLink[], token: string): ShareLink | null` (active links only)
  - `export function shareLinksFileError(filePath: string, error: string): string`
  - `export function createShareLink(filePath: string, input: { property: string; label: string }, now?: Date): { link: ShareLink; token: string }`
  - `export function revokeShareLink(filePath: string, id: string, now?: Date): boolean`

- [ ] **Step 1: Write the failing tests** — create `app/tests/share-links.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  SHARE_TOKEN_PATTERN,
  createShareLink,
  findShareLink,
  hashShareToken,
  loadShareLinks,
  newShareToken,
  revokeShareLink,
} from "../lib/shareLinks";

let dir: string | undefined;
const file = () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "share-links-"));
  return path.join(dir, "share-links.json");
};
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const OPTIKA = { property: "https://optikacajs.rs/", label: "Optika – owner" };

describe("tokens", () => {
  it("are 43 base64url characters and never repeat", () => {
    const a = newShareToken();
    const b = newShareToken();
    expect(a).toMatch(SHARE_TOKEN_PATTERN);
    expect(a).not.toBe(b);
  });

  it("are stored as their SHA-256", () => {
    expect(hashShareToken("abc")).toBe(createHash("sha256").update("abc").digest("hex"));
  });
});

describe("createShareLink", () => {
  it("creates the file on the first link and returns the raw token once", () => {
    const f = file();
    expect(loadShareLinks(f)).toEqual({ state: "missing" });

    const { link, token } = createShareLink(f, OPTIKA, new Date("2026-10-09T13:00:00Z"));

    expect(token).toMatch(SHARE_TOKEN_PATTERN);
    expect(link).toMatchObject({ ...OPTIKA, createdAt: "2026-10-09T13:00:00.000Z", revokedAt: null });
    expect(link.id).toMatch(/^sl_[0-9a-f]{8}$/);
    const onDisk = fs.readFileSync(f, "utf-8");
    expect(onDisk).not.toContain(token);
    expect(JSON.parse(onDisk)[0].token_hash).toBe(hashShareToken(token));
  });

  it("keeps the previous file as .bak", () => {
    const f = file();
    createShareLink(f, OPTIKA);
    const first = fs.readFileSync(f, "utf-8");
    createShareLink(f, { ...OPTIKA, label: "Optika – marketing" });
    expect(fs.readFileSync(`${f}.bak`, "utf-8")).toBe(first);
    expect(loadShareLinks(f)).toMatchObject({ state: "ok", links: [{}, {}] });
  });

  it("refuses to overwrite a malformed file", () => {
    const f = file();
    fs.writeFileSync(f, "[{ broken");
    expect(() => createShareLink(f, OPTIKA)).toThrow(/could not be parsed/);
    expect(fs.readFileSync(f, "utf-8")).toBe("[{ broken");
  });
});

describe("findShareLink", () => {
  it("finds a link by its raw token", () => {
    const f = file();
    const { link, token } = createShareLink(f, OPTIKA);
    const loaded = loadShareLinks(f);
    if (loaded.state !== "ok") throw new Error("unreachable");
    expect(findShareLink(loaded.links, token)?.id).toBe(link.id);
  });

  it("finds nothing for an unknown, malformed or revoked token", () => {
    const f = file();
    const { link, token } = createShareLink(f, OPTIKA);
    revokeShareLink(f, link.id);
    const loaded = loadShareLinks(f);
    if (loaded.state !== "ok") throw new Error("unreachable");
    expect(findShareLink(loaded.links, token)).toBeNull();
    expect(findShareLink(loaded.links, newShareToken())).toBeNull();
    for (const garbage of ["", "abc", "../../etc/passwd", `${token}x`]) {
      expect(findShareLink(loaded.links, garbage), garbage).toBeNull();
    }
  });
});

describe("revokeShareLink", () => {
  it("stamps revoked_at once and reports whether it changed anything", () => {
    const f = file();
    const { link } = createShareLink(f, OPTIKA);
    expect(revokeShareLink(f, link.id, new Date("2026-10-10T08:00:00Z"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(f, "utf-8"))[0].revoked_at).toBe("2026-10-10T08:00:00.000Z");
    expect(revokeShareLink(f, link.id)).toBe(false);
    expect(revokeShareLink(f, "sl_00000000")).toBe(false);
  });

  it("returns false when there is no file yet", () => {
    expect(revokeShareLink(file(), "sl_00000000")).toBe(false);
  });
});

describe("loadShareLinks", () => {
  it("reports a non-array or an incomplete entry as malformed", () => {
    const f = file();
    fs.writeFileSync(f, JSON.stringify({ links: [] }));
    expect(loadShareLinks(f).state).toBe("malformed");
    fs.writeFileSync(f, JSON.stringify([{ id: "sl_1", property: "x" }]));
    expect(loadShareLinks(f)).toMatchObject({ state: "malformed", error: expect.stringMatching(/entry 1/) });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd app && npx vitest run tests/share-links.test.ts`
Expected: FAIL — `Cannot find module '../lib/shareLinks'`.

- [ ] **Step 3: Create `app/lib/shareLinks.ts`**

```ts
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Client share links, stored in config/share-links.json (the dashboard's
 * writable mount). Only a SHA-256 of each token is kept, so the file is never
 * a list of working links, and a lost link is replaced (revoke + create),
 * never recovered.
 */
export interface ShareLink {
  id: string;
  tokenHash: string;
  property: string;
  label: string;
  createdAt: string;
  revokedAt: string | null;
}

interface DiskShareLink {
  id: string;
  token_hash: string;
  property: string;
  label: string;
  created_at: string;
  revoked_at: string | null;
}

export type ShareLinksFile =
  | { state: "missing" }
  | { state: "ok"; links: ShareLink[] }
  | { state: "malformed"; error: string };

/** 32 random bytes as base64url: 43 characters, 256 bits. */
export const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function newShareToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashShareToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function isDiskShareLink(value: unknown): value is DiskShareLink {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.token_hash === "string" &&
    typeof v.property === "string" &&
    typeof v.label === "string" &&
    typeof v.created_at === "string" &&
    (v.revoked_at === null || typeof v.revoked_at === "string")
  );
}

function fromDisk(d: DiskShareLink): ShareLink {
  return {
    id: d.id,
    tokenHash: d.token_hash,
    property: d.property,
    label: d.label,
    createdAt: d.created_at,
    revokedAt: d.revoked_at,
  };
}

function toDisk(l: ShareLink): DiskShareLink {
  return {
    id: l.id,
    token_hash: l.tokenHash,
    property: l.property,
    label: l.label,
    created_at: l.createdAt,
    revoked_at: l.revokedAt,
  };
}

/** Missing, readable, or malformed: three different answers (see userSites.ts). */
export function loadShareLinks(filePath: string | undefined): ShareLinksFile {
  if (!filePath) return { state: "missing" };
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing" };
    return { state: "malformed", error: `could not be read: ${(e as Error).message}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { state: "malformed", error: `invalid JSON: ${(e as Error).message}` };
  }
  if (!Array.isArray(raw)) return { state: "malformed", error: "expected a JSON array of links" };
  const bad = raw.findIndex((entry) => !isDiskShareLink(entry));
  if (bad !== -1) return { state: "malformed", error: `entry ${bad + 1} is not a valid share link` };
  return { state: "ok", links: (raw as DiskShareLink[]).map(fromDisk) };
}

/** Atomic (temp file + rename), keeping the previous file as `<file>.bak`. */
export function writeShareLinksAtomic(filePath: string, links: ShareLink[]): void {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.share-links.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmpPath, JSON.stringify(links.map(toDisk), null, 2), "utf-8");
  try {
    fs.copyFileSync(filePath, `${filePath}.bak`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      fs.rmSync(tmpPath, { force: true });
      throw e;
    }
  }
  fs.renameSync(tmpPath, filePath);
}

/**
 * The active link `token` belongs to, or null. Every stored hash is compared
 * in constant time; a malformed token never reaches the comparison.
 */
export function findShareLink(links: ShareLink[], token: string): ShareLink | null {
  if (!SHARE_TOKEN_PATTERN.test(token)) return null;
  const wanted = Buffer.from(hashShareToken(token), "hex");
  let found: ShareLink | null = null;
  for (const link of links) {
    const stored = Buffer.from(link.tokenHash, "hex");
    if (stored.length === wanted.length && timingSafeEqual(stored, wanted) && link.revokedAt === null) {
      found = link;
    }
  }
  return found;
}

export function shareLinksFileError(filePath: string, error: string): string {
  return (
    `${filePath} could not be parsed (${error}). Share links can't be created or ` +
    `revoked until it is fixed by hand, or restored from ${path.basename(filePath)}.bak.`
  );
}

/** Mints a link. The raw token is returned once; only its hash is stored. */
export function createShareLink(
  filePath: string,
  input: { property: string; label: string },
  now: Date = new Date(),
): { link: ShareLink; token: string } {
  const file = loadShareLinks(filePath);
  if (file.state === "malformed") throw new Error(shareLinksFileError(filePath, file.error));
  const token = newShareToken();
  const link: ShareLink = {
    id: `sl_${randomBytes(4).toString("hex")}`,
    tokenHash: hashShareToken(token),
    property: input.property,
    label: input.label,
    createdAt: now.toISOString(),
    revokedAt: null,
  };
  writeShareLinksAtomic(filePath, [...(file.state === "ok" ? file.links : []), link]);
  return { link, token };
}

/** Revokes an active link. False when there is no such active link. */
export function revokeShareLink(filePath: string, id: string, now: Date = new Date()): boolean {
  const file = loadShareLinks(filePath);
  if (file.state === "malformed") throw new Error(shareLinksFileError(filePath, file.error));
  if (file.state === "missing") return false;
  let changed = false;
  const links = file.links.map((link) => {
    if (link.id !== id || link.revokedAt !== null) return link;
    changed = true;
    return { ...link, revokedAt: now.toISOString() };
  });
  if (changed) writeShareLinksAtomic(filePath, links);
  return changed;
}
```

- [ ] **Step 4: Run the tests**

Run: `cd app && npx vitest run tests/share-links.test.ts && npx tsc --noEmit`
Expected: all pass, `tsc` silent.

- [ ] **Step 5: Commit**

```bash
git add app/lib/shareLinks.ts app/tests/share-links.test.ts
git commit -m "Store client share links as hashes in config/share-links.json"
```

---

### Task 4: From a token to a site — `resolveShare`

**Files:**
- Modify: `app/lib/db.ts` (add `siteConfigByProperty` after `siteConfigBySlug`)
- Create: `app/lib/shareScope.ts`
- Test: `app/tests/share-scope.test.ts` (new)

**Interfaces:**
- Consumes: `loadShareLinks`, `findShareLink`, `createShareLink`, `revokeShareLink`, `ShareLink` (Task 3); `getDb`, `SiteConfig`, `hasSitesColumn` (existing, `lib/db.ts`).
- Produces:
  - `export function siteConfigByProperty(property: string, db?: Database.Database): SiteConfig | null` (active sites only)
  - `export interface ResolvedShare { link: ShareLink; config: SiteConfig }`
  - `export function resolveShare(token: string, options?: { filePath?: string; db?: Database.Database }): ResolvedShare | null`

- [ ] **Step 1: Write the failing tests** — create `app/tests/share-scope.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd app && npx vitest run tests/share-scope.test.ts`
Expected: FAIL — `siteConfigByProperty` is not exported / `Cannot find module '../lib/shareScope'`.

- [ ] **Step 3: Add `siteConfigByProperty` to `app/lib/db.ts`**, directly after the `siteConfigBySlug` function:

```ts
/**
 * A single active site's display metadata by property, or null when no active
 * site has it. Share links store a property, so a removed (retired) site
 * resolves to null and its links stop working.
 */
export function siteConfigByProperty(
  property: string,
  db: Database.Database = getDb()
): SiteConfig | null {
  const active = hasSitesColumn(db, "active") ? "AND active = 1" : "";
  const row = db
    .prepare<[string], SiteConfig>(
      `SELECT property, slug, display_name AS displayName, brand_token AS brandToken
       FROM sites
       WHERE property = ? ${active}`
    )
    .get(property);
  return row ?? null;
}
```

- [ ] **Step 4: Create `app/lib/shareScope.ts`**

```ts
import type Database from "better-sqlite3";

import { getDb, siteConfigByProperty, type SiteConfig } from "./db";
import { findShareLink, loadShareLinks, type ShareLink } from "./shareLinks";

export interface ResolvedShare {
  link: ShareLink;
  config: SiteConfig;
}

/**
 * The single place a client's access is decided: a share route's token →
 * the one site it may see, or null (the route renders a 404).
 *
 * Null for a malformed, unknown or revoked token, for a missing or malformed
 * links file, and for a site that has since been removed. The token is the
 * only input: no route parameter names a site, so there is nothing to change
 * in the URL to reach another one.
 */
export function resolveShare(
  token: string,
  options: { filePath?: string; db?: Database.Database } = {},
): ResolvedShare | null {
  const file = loadShareLinks(options.filePath ?? process.env.SEO_SHARE_LINKS_PATH);
  if (file.state !== "ok") return null;
  const link = findShareLink(file.links, token);
  if (!link) return null;
  const config = siteConfigByProperty(link.property, options.db ?? getDb());
  return config ? { link, config } : null;
}
```

- [ ] **Step 5: Run the tests**

Run: `cd app && npx vitest run tests/share-scope.test.ts tests/db.test.ts tests/site-active.test.ts && npx tsc --noEmit`
Expected: all pass, `tsc` silent.

- [ ] **Step 6: Commit**

```bash
git add app/lib/db.ts app/lib/shareScope.ts app/tests/share-scope.test.ts
git commit -m "Resolve a share token to exactly one active site"
```

---

### Task 5: Move the site dashboard into a reusable component

**Files:**
- Create: `app/components/SiteDashboard.tsx` (the body of today's site page)
- Modify: `app/app/site/[slug]/page.tsx` (thin loader that renders `SiteDashboard`)
- Test: `app/tests/site-dashboard.test.ts` (new); existing `app/tests/site-page.test.ts` unchanged

**Interfaces:**
- Produces:
  - `export default function SiteDashboard(props: { config: SiteConfig; top?: ReactNode; headerLinks?: ReactNode; afterHeader?: ReactNode })`
  - `export function buildTrendSeries(rows: TotalsRow[], start: string, end: string): TrendPoint[]` and `export function formatNonBrandDelta(delta: number, hasPriorWindow: boolean): string` — moved here, re-exported from the page so `site-page.test.ts` keeps importing them from `../app/site/[slug]/page`.

- [ ] **Step 1: Capture the admin site page before touching it**

```bash
WORK=/tmp/claude-1000/-home-ar-Documents-GitHub-seo-cockpit/43a79ef2-95da-4f61-aad8-1c711ed1c2a9/scratchpad/share-links
# The current Pi snapshot, already migrated, from the bilingual report run.
mkdir -p $WORK && cp /tmp/claude-1000/-home-ar-Documents-GitHub-seo-cockpit/43a79ef2-95da-4f61-aad8-1c711ed1c2a9/scratchpad/bilingual/seo.db $WORK/seo.db
(cd app && SEO_DB_PATH=$WORK/seo.db npx next dev -p 3999 > $WORK/dev.log 2>&1 &)
until curl -s -o /dev/null http://localhost:3999/site/optika-cajs; do sleep 1; done
curl -s http://localhost:3999/site/optika-cajs > $WORK/before-site.html
```

Keep the server running for Step 7.

- [ ] **Step 2: Write the failing test** — create `app/tests/site-dashboard.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import * as dashboard from "../components/SiteDashboard";

describe("SiteDashboard", () => {
  it("exports the component and the two helpers the page re-exports", () => {
    expect(typeof dashboard.default).toBe("function");
    expect(typeof dashboard.buildTrendSeries).toBe("function");
    expect(typeof dashboard.formatNonBrandDelta).toBe("function");
  });

  it("renders no navigation of its own: every link arrives through a slot", () => {
    // The client live view renders this component; a link written inside it
    // would reach the client. Admin links are passed in by the admin page.
    const source = fs.readFileSync(path.join(process.cwd(), "components/SiteDashboard.tsx"), "utf-8");
    expect(source).not.toMatch(/<Link\b/);
    expect(source).not.toMatch(/\bhref=/);
    expect(source).not.toMatch(/from "next\/link"/);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd app && npx vitest run tests/site-dashboard.test.ts`
Expected: FAIL — `Cannot find module '../components/SiteDashboard'`.

- [ ] **Step 4: Create the component by moving the page body** — run this exact transformation (it moves code verbatim; only the import paths, the three slots and the signature change):

```bash
cd /home/ar/Documents/GitHub/seo-cockpit && python3 - <<'EOF'
import pathlib
page = pathlib.Path("app/app/site/[slug]/page.tsx").read_text()

imports_end = page.index("type FreshnessLevel = ")
imports = page[:imports_end]
for drop in ['import Link from "next/link";\n', 'import { notFound } from "next/navigation";\n',
             'import { connection } from "next/server";\n', "  siteConfigBySlug,\n"]:
    assert imports.count(drop) == 1, drop
    imports = imports.replace(drop, "", 1)
assert imports.count('import type { TotalsRow } from "../../../lib/db";') == 1
imports = imports.replace('import type { TotalsRow } from "../../../lib/db";',
                          'import type { SiteConfig, TotalsRow } from "../../../lib/db";', 1)
imports = imports.replace('"../../../components/', '"./').replace('"../../../lib/', '"../lib/')
imports = 'import type { ReactNode } from "react";\n\n' + imports.lstrip("\n")

helpers_end = page.index("/**\n * Per-site trend view")
helpers = page[imports_end:helpers_end]

load_start = page.index("  const asOf = formatISODateUTC(new Date());")
ret = page.index("  return (\n", load_start)
loading = page[load_start:ret]
jsx = page[ret:]

back_start = jsx.index("      {/* An inline chevron")
back_end = jsx.index("      </Link>\n", back_start) + len("      </Link>\n")
jsx = jsx[:back_start] + "      {top}\n" + jsx[back_end:]
links_start = jsx.index("          <Link\n            href={`/site/${slug}/proposal`}")
links_end = jsx.index("          <Badge", links_start)
jsx = jsx[:links_start] + "          {headerLinks}\n" + jsx[links_end:]
assert jsx.count("      </header>\n") == 1
jsx = jsx.replace("      </header>\n", "      </header>\n\n      {afterHeader}\n", 1)

component = imports + helpers + '''/**
 * One site's dashboard: trend, brand split, queries, pages, Core Web Vitals,
 * demand, competitors, cannibalization and geography. English, read-only.
 *
 * Rendered by the admin site page and by the client's Live data view, so it
 * contains no navigation of its own: everything a viewer can click arrives
 * through `top`, `headerLinks` and `afterHeader`, which only the admin page
 * fills with admin links.
 *
 * A server component that reads the DB directly; the routes that render it
 * call `connection()` first, because the collector writes seo.db from another
 * container and nothing here can be cached at build time.
 */
export default function SiteDashboard({
  config,
  top,
  headerLinks,
  afterHeader,
}: {
  config: SiteConfig;
  top?: ReactNode;
  headerLinks?: ReactNode;
  afterHeader?: ReactNode;
}) {
''' + loading + jsx
pathlib.Path("app/components/SiteDashboard.tsx").write_text(component)
EOF
grep -c "slug" app/components/SiteDashboard.tsx
```

Expected: the final `grep -c` prints `0` (nothing in the component refers to a slug).

- [ ] **Step 5: Replace `app/app/site/[slug]/page.tsx` with the thin loader**

```tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import SiteDashboard from "../../../components/SiteDashboard";
import { siteConfigBySlug } from "../../../lib/db";

// Tests import these helpers from this page; they live with the dashboard now.
export { buildTrendSeries, formatNonBrandDelta } from "../../../components/SiteDashboard";

/**
 * The admin view of one site: the shared dashboard plus the admin header
 * (back to the overview, the findings page, the client report). The client's
 * Live data view renders the same dashboard without any of these.
 */
export default async function SitePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  await connection();

  const { slug } = await params;
  const config = siteConfigBySlug(slug);
  if (!config) {
    notFound();
  }

  return (
    <SiteDashboard
      config={config}
      top={
        // An inline chevron, not a glyph or emoji: this is a navigation
        // affordance rather than decoration, and the label carries the
        // meaning on its own if the icon fails to paint.
        <Link
          href="/"
          className="flex w-fit items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <svg
            aria-hidden="true"
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            viewBox="0 0 24 24"
          >
            <path d="M15 18l-6-6 6-6" />
          </svg>
          Back to dashboard
        </Link>
      }
      headerLinks={
        <>
          <Link
            href={`/site/${slug}/proposal`}
            className="text-sm text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
          >
            Findings
          </Link>
          {/* English on the English dashboard; the report it opens is in the
              site's language, with an SR / EN switch. */}
          <Link
            href={`/site/${slug}/report`}
            className="text-sm text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
          >
            Client report
          </Link>
        </>
      }
    />
  );
}
```

- [ ] **Step 6: Run the tests and the type check**

Run: `cd app && npx vitest run && npx tsc --noEmit && npm run lint 2>&1 | grep problems`
Expected: all pass (including the unchanged `site-page.test.ts`), `tsc` silent, lint `0 errors`.

- [ ] **Step 7: Prove the admin page is unchanged** — with the Step 1 server still running:

```bash
WORK=/tmp/claude-1000/-home-ar-Documents-GitHub-seo-cockpit/43a79ef2-95da-4f61-aad8-1c711ed1c2a9/scratchpad/share-links
sleep 2; curl -s http://localhost:3999/site/optika-cajs > $WORK/after-site.html
python3 - $WORK/before-site.html $WORK/after-site.html <<'EOF'
import html, re, sys
def text(path):
    s = open(path, encoding="utf-8").read()
    s = s[s.index("<body"):]
    s = re.sub(r"<script.*?</script>", " ", s, flags=re.S)
    t = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s))).strip()
    return t.replace("Client report (SR)", "Client report")
a, b = text(sys.argv[1]), text(sys.argv[2])
print("site page text identical (apart from the report link label)" if a == b else f"DIFFERENT\n{a[:1500]}\n---\n{b[:1500]}")
EOF
```

Expected: `site page text identical (apart from the report link label)`. Then stop the dev server by its port (`ss -ltnp | grep ':3999 '`, `kill <pid>`).

- [ ] **Step 8: Commit**

```bash
git add app/components/SiteDashboard.tsx "app/app/site/[slug]/page.tsx" app/tests/site-dashboard.test.ts
git commit -m "Move the site dashboard into a component the client view can reuse"
```

---

### Task 6: Admin — create, list and revoke share links

**Files:**
- Modify: `app/app/sites/actions.ts` (two actions)
- Create: `app/components/ShareLinkForm.tsx`
- Create: `app/lib/shareLinkRows.ts`
- Create: `app/app/sites/links/page.tsx`
- Modify: `app/app/site/[slug]/page.tsx` (`afterHeader={<ShareLinkForm slug={slug} />}`)
- Modify: `app/app/page.tsx` (a "Share links" link in the header)
- Test: `app/tests/share-actions.test.ts`, `app/tests/share-link-rows.test.ts`, `app/tests/share-link-form.test.tsx` (new)

**Interfaces:**
- Consumes: `assertAdminRequest` (Task 2); `createShareLink`, `revokeShareLink`, `loadShareLinks`, `shareLinksFileError`, `ShareLink` (Task 3); `siteConfigBySlug`, `listSiteConfigs`, `listRetiredSiteConfigs` (`lib/db.ts`); `SiteDashboard` slots (Task 5); `UserSitesFileNotice` (existing).
- Produces:
  - `export interface ShareLinkState { url: string | null; error: string | null }`
  - `export async function createShareLinkAction(_prev: ShareLinkState, formData: FormData): Promise<ShareLinkState>` (fields `slug`, `label`)
  - `export async function revokeShareLinkAction(formData: FormData): Promise<void>` (field `id`)
  - `export interface ShareLinkRow { id: string; label: string; siteName: string; created: string; status: "active" | "revoked" | "site removed" }`
  - `export function buildShareLinkRows(links: ShareLink[], active: SiteConfig[], retired: SiteConfig[]): ShareLinkRow[]` (newest first)

- [ ] **Step 1: Write the failing tests** — create `app/tests/share-link-rows.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { SiteConfig } from "../lib/db";
import { buildShareLinkRows } from "../lib/shareLinkRows";
import type { ShareLink } from "../lib/shareLinks";

const optika: SiteConfig = { property: "https://optikacajs.rs/", slug: "optika-cajs", displayName: "Optika Cajs", brandToken: "cajs" };
const gone: SiteConfig = { property: "https://gone.example/", slug: "gone", displayName: "Gone", brandToken: "gone" };

function link(over: Partial<ShareLink>): ShareLink {
  return { id: "sl_1", tokenHash: "x", property: optika.property, label: "owner",
    createdAt: "2026-10-09T13:00:00.000Z", revokedAt: null, ...over };
}

describe("buildShareLinkRows", () => {
  it("names the site and states each link's status, newest first", () => {
    const rows = buildShareLinkRows(
      [
        link({ id: "sl_a", label: "owner", createdAt: "2026-10-01T09:00:00.000Z" }),
        link({ id: "sl_b", label: "old", createdAt: "2026-10-05T09:00:00.000Z", revokedAt: "2026-10-06T09:00:00.000Z" }),
        link({ id: "sl_c", label: "former", property: gone.property, createdAt: "2026-10-08T09:00:00.000Z" }),
        link({ id: "sl_d", label: "mystery", property: "https://unknown.example/", createdAt: "2026-09-01T09:00:00.000Z" }),
      ],
      [optika],
      [gone],
    );
    expect(rows).toEqual([
      { id: "sl_c", label: "former", siteName: "Gone", created: "2026-10-08", status: "site removed" },
      { id: "sl_b", label: "old", siteName: "Optika Cajs", created: "2026-10-05", status: "revoked" },
      { id: "sl_a", label: "owner", siteName: "Optika Cajs", created: "2026-10-01", status: "active" },
      { id: "sl_d", label: "mystery", siteName: "https://unknown.example/", created: "2026-09-01", status: "site removed" },
    ]);
  });
});
```

Create `app/tests/share-actions.test.ts`:

```ts
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
```

Create `app/tests/share-link-form.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import ShareLinkForm from "../components/ShareLinkForm";

describe("ShareLinkForm", () => {
  it("posts the site's slug and a label", () => {
    const html = renderToStaticMarkup(<ShareLinkForm slug="optika-cajs" />);
    expect(html).toContain('name="slug"');
    expect(html).toContain('value="optika-cajs"');
    expect(html).toContain('name="label"');
    expect(html).toContain("Create link");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd app && npx vitest run tests/share-link-rows.test.ts tests/share-actions.test.ts tests/share-link-form.test.tsx`
Expected: FAIL — missing modules / exports.

- [ ] **Step 3: Create `app/lib/shareLinkRows.ts`**

```ts
import type { SiteConfig } from "./db";
import type { ShareLink } from "./shareLinks";

export interface ShareLinkRow {
  id: string;
  label: string;
  siteName: string;
  created: string;
  status: "active" | "revoked" | "site removed";
}

/**
 * The share links page's rows, newest first. "site removed" is shown for a
 * link that was never revoked but whose site is no longer active: it already
 * 404s for the client (see resolveShare), and the page should say why.
 */
export function buildShareLinkRows(
  links: ShareLink[],
  active: SiteConfig[],
  retired: SiteConfig[],
): ShareLinkRow[] {
  const activeByProperty = new Map(active.map((c) => [c.property, c]));
  const retiredByProperty = new Map(retired.map((c) => [c.property, c]));
  return [...links]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((link) => {
      const site = activeByProperty.get(link.property) ?? retiredByProperty.get(link.property);
      return {
        id: link.id,
        label: link.label,
        siteName: site?.displayName ?? link.property,
        created: link.createdAt.slice(0, 10),
        status: link.revokedAt
          ? "revoked"
          : activeByProperty.has(link.property)
            ? "active"
            : "site removed",
      };
    });
}
```

- [ ] **Step 4: Add the two actions to `app/app/sites/actions.ts`** — extend the imports:

```ts
import { listRetiredSiteConfigs, listSiteConfigs, siteConfigBySlug } from "../../lib/db";
import { createShareLink, revokeShareLink } from "../../lib/shareLinks";
```

(replacing the existing `import { listRetiredSiteConfigs, listSiteConfigs } from "../../lib/db";`), and append:

```ts
export interface ShareLinkState {
  url: string | null;
  error: string | null;
}

/**
 * Creates a client share link for a site and returns its URL. This is the
 * only time the raw token exists outside the client's hands: the store keeps
 * its hash, so a lost link is revoked and replaced, never shown again.
 */
export async function createShareLinkAction(
  _prev: ShareLinkState,
  formData: FormData,
): Promise<ShareLinkState> {
  await assertAdminRequest();
  const filePath = process.env.SEO_SHARE_LINKS_PATH;
  const base = process.env.SEO_PUBLIC_BASE_URL;
  if (!filePath) return { url: null, error: "SEO_SHARE_LINKS_PATH is not set." };
  if (!base) return { url: null, error: "SEO_PUBLIC_BASE_URL is not set." };

  const config = siteConfigBySlug(String(formData.get("slug") ?? ""));
  if (!config) return { url: null, error: "Unknown site." };
  const label = String(formData.get("label") ?? "").trim();
  if (!label) return { url: null, error: "Give the link a label, e.g. the client's name." };
  if (label.length > 80) return { url: null, error: "Keep the label under 80 characters." };

  try {
    const { token } = createShareLink(filePath, { property: config.property, label });
    revalidatePath("/sites/links");
    return { url: `${base.replace(/\/+$/, "")}/share/${token}`, error: null };
  } catch (e) {
    return { url: null, error: (e as Error).message };
  }
}

/** Revokes a share link; it stops working on the client's next request. */
export async function revokeShareLinkAction(formData: FormData): Promise<void> {
  await assertAdminRequest();
  const filePath = process.env.SEO_SHARE_LINKS_PATH;
  if (!filePath) throw new Error("SEO_SHARE_LINKS_PATH is not set.");
  revokeShareLink(filePath, String(formData.get("id") ?? ""));
  revalidatePath("/sites/links");
}
```

- [ ] **Step 5: Create `app/components/ShareLinkForm.tsx`**

```tsx
"use client";

import { useActionState, useRef, useState } from "react";

import { Button } from "./ui/button";
import { createShareLinkAction, type ShareLinkState } from "../app/sites/actions";

const INITIAL: ShareLinkState = { url: null, error: null };

const inputClass =
  "h-8 rounded-lg border border-border bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** The new link, with a copy button that falls back to selecting the text:
 *  the clipboard API needs a secure context, and the LAN dashboard is http. */
function NewLink({ url }: { url: string }) {
  const field = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<string | null>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setNote("Copied.");
    } catch {
      field.current?.select();
      setNote("Selected: press Ctrl+C to copy.");
    }
  }

  return (
    <div className="mt-3 flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <input
          ref={field}
          readOnly
          value={url}
          aria-label="Share link"
          onFocus={(e) => e.currentTarget.select()}
          className={`${inputClass} flex-1 bg-muted font-mono text-xs`}
        />
        <Button type="button" variant="outline" size="sm" onClick={copy}>
          Copy
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {note ? `${note} ` : ""}Send it to the client now: it can’t be shown again. Revoke or
        replace links on the Share links page.
      </p>
    </div>
  );
}

/**
 * Creates a client share link for this site. Admin only: rendered by the
 * admin site page, never by the client's live view.
 */
export default function ShareLinkForm({ slug }: { slug: string }) {
  const [state, formAction, pending] = useActionState(createShareLinkAction, INITIAL);

  return (
    <section className="rounded-xl border border-border bg-card p-4 text-card-foreground shadow-sm">
      <h2 className="pb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Share with client
      </h2>
      <form action={formAction} className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input type="hidden" name="slug" value={slug} />
        <input
          name="label"
          placeholder="Label, e.g. Optika – owner"
          maxLength={80}
          autoComplete="off"
          className={`${inputClass} flex-1`}
        />
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Creating…" : "Create link"}
        </Button>
      </form>
      {state.error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {state.error}
        </p>
      ) : null}
      {state.url ? <NewLink key={state.url} url={state.url} /> : null}
    </section>
  );
}
```

- [ ] **Step 6: Create `app/app/sites/links/page.tsx`**

```tsx
import Link from "next/link";
import { connection } from "next/server";

import UserSitesFileNotice from "../../../components/UserSitesFileNotice";
import { revokeShareLinkAction } from "../actions";
import { listRetiredSiteConfigs, listSiteConfigs } from "../../../lib/db";
import { buildShareLinkRows } from "../../../lib/shareLinkRows";
import { loadShareLinks, shareLinksFileError } from "../../../lib/shareLinks";

const STATUS_STYLE = {
  active: "text-emerald-700 dark:text-emerald-400",
  revoked: "text-muted-foreground",
  "site removed": "text-amber-700 dark:text-amber-400",
} as const;

/**
 * Every client share link: who it's for, which site, when it was created,
 * and whether it still works. Links are created on each site's page; the URL
 * is shown only then, so this page lists links without their URLs.
 */
export default async function ShareLinksPage() {
  await connection();
  const filePath = process.env.SEO_SHARE_LINKS_PATH;
  const file = loadShareLinks(filePath);
  const rows =
    file.state === "ok" ? buildShareLinkRows(file.links, listSiteConfigs(), listRetiredSiteConfigs()) : [];
  const notice =
    file.state === "malformed" && filePath ? shareLinksFileError(filePath, file.error) : null;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-1">
        <Link href="/" className="text-xs text-muted-foreground hover:text-foreground">
          ← Back to overview
        </Link>
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">Share links</h1>
        <p className="text-sm text-muted-foreground">
          Each link opens one site’s report and live data for a client, without a password. Links
          never expire; revoke one to stop it working. Create links on a site’s page.
        </p>
      </header>

      <UserSitesFileNotice message={notice} />

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No share links yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground uppercase">
            <tr>
              <th className="pb-2 font-medium">Label</th>
              <th className="pb-2 font-medium">Site</th>
              <th className="pb-2 font-medium">Created</th>
              <th className="pb-2 font-medium">Status</th>
              <th className="pb-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-border">
                <td className="py-2">{row.label}</td>
                <td className="py-2">{row.siteName}</td>
                <td className="py-2 tabular-nums">{row.created}</td>
                <td className={`py-2 ${STATUS_STYLE[row.status]}`}>{row.status}</td>
                <td className="py-2 text-right">
                  {row.status === "active" ? (
                    <form action={revokeShareLinkAction}>
                      <input type="hidden" name="id" value={row.id} />
                      <button
                        type="submit"
                        className="text-xs text-muted-foreground underline underline-offset-4 hover:text-destructive"
                      >
                        Revoke
                      </button>
                    </form>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

- [ ] **Step 7: Wire the form and the link** — in `app/app/site/[slug]/page.tsx`, add the import `import ShareLinkForm from "../../../components/ShareLinkForm";` and the prop `afterHeader={<ShareLinkForm slug={slug} />}` on `<SiteDashboard`. In `app/app/page.tsx`, directly after the closing `</Link>` of the "Add site" link, add:

```tsx
          <Link
            href="/sites/links"
            className="text-sm text-primary underline-offset-4 hover:underline"
          >
            Share links
          </Link>
```

- [ ] **Step 8: Run the tests, types and lint**

Run: `cd app && npx vitest run && npx next typegen > /dev/null && npx tsc --noEmit && npm run lint 2>&1 | grep problems`
Expected: all pass (the guard's source scan now also covers the two new actions), `tsc` silent, lint `0 errors` (warning count rises by one: `createShareLinkAction`'s unused `_prev`, the same pattern as the existing four).

- [ ] **Step 9: Commit**

```bash
git add app/app/sites/actions.ts app/components/ShareLinkForm.tsx app/lib/shareLinkRows.ts \
        app/app/sites/links/page.tsx "app/app/site/[slug]/page.tsx" app/app/page.tsx \
        app/tests/share-actions.test.ts app/tests/share-link-rows.test.ts app/tests/share-link-form.test.tsx
git commit -m "Create, list and revoke client share links from the dashboard"
```

---

### Task 7: The client's pages — report, live data, PDF

**Files:**
- Create: `app/components/ShareTabs.tsx`
- Modify: `app/lib/report/pdf.ts` (`loopbackOrigin` helper; `internalShareReportUrl`)
- Create: `app/app/share/[token]/page.tsx`
- Create: `app/app/share/[token]/live/page.tsx`
- Create: `app/app/share/[token]/report/pdf/route.ts`
- Test: `app/tests/share-pages.test.tsx` (new)

**Interfaces:**
- Consumes: `resolveShare` (Task 4); `SiteDashboard` (Task 5); `ReportDocument`, `LanguageSwitch`, `PrintButton` (existing); `resolveReportLanguage`, `reportStrings`, `siteLanguage`, `buildReportData`, `reportPdfFilenameFor`, `contentDispositionAttachment`, `renderPdf` (existing); `decideAccess` (Task 1, in the test).
- Produces:
  - `export default function ShareTabs(props: { token: string; current: "report" | "live" })`
  - `export function internalShareReportUrl(token: string, requestUrl: string, lang: ReportLanguage): string`
  - Routes `/share/[token]`, `/share/[token]/live`, `/share/[token]/report/pdf`.

- [ ] **Step 1: Write the failing tests** — create `app/tests/share-pages.test.tsx`:

```tsx
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import BetterSqlite3 from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import SharedReportPage from "../app/share/[token]/page";
import SharedLivePage from "../app/share/[token]/live/page";
import ShareTabs from "../components/ShareTabs";
import { decideAccess } from "../lib/access";
import { internalShareReportUrl } from "../lib/report/pdf";
import { createShareLink, newShareToken } from "../lib/shareLinks";

const ENV_KEYS = ["SEO_DB_PATH", "SEO_SHARE_LINKS_PATH", "PORT"] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
let dir: string;
let token: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "share-pages-"));
  const dbPath = path.join(dir, "seo.db");
  const db = new BetterSqlite3(dbPath);
  db.exec(`
    CREATE TABLE totals_daily (site TEXT, date TEXT, clicks INT, impressions INT, ctr REAL, position REAL, PRIMARY KEY (site, date));
    CREATE TABLE query_daily (site TEXT, date TEXT, query TEXT, clicks INT, impressions INT, ctr REAL, position REAL, PRIMARY KEY (site, date, query));
    CREATE TABLE page_daily (site TEXT, date TEXT, page TEXT, clicks INT, impressions INT, ctr REAL, position REAL, PRIMARY KEY (site, date, page));
    CREATE TABLE cwv_snapshots (site TEXT, url TEXT, captured_at TEXT, lcp_p75 REAL, inp_p75 REAL, cls_p75 REAL, source TEXT, form_factor TEXT, lh_performance REAL, lh_accessibility REAL, lh_best_practices REAL, lh_seo REAL);
    CREATE TABLE demand_keywords (site TEXT, keyword TEXT, source TEXT, seed TEXT, suggest_rank INT, rising_pct REAL, rising_label TEXT, top_value REAL, volume INT, first_seen TEXT, last_seen TEXT, PRIMARY KEY (site, keyword, source));
    CREATE TABLE sites (property TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, brand_token TEXT NOT NULL, updated_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, language TEXT NOT NULL DEFAULT 'sr');
    INSERT INTO sites VALUES ('https://us-client.example/', 'us-client', 'US Client', 'usclient', '2026-10-09', 1, 'en');
    INSERT INTO sites VALUES ('https://other.example/', 'other', 'Other Client', 'other', '2026-10-09', 1, 'sr');
  `);
  db.close();
  process.env.SEO_DB_PATH = dbPath;
  process.env.SEO_SHARE_LINKS_PATH = path.join(dir, "share-links.json");
  token = createShareLink(process.env.SEO_SHARE_LINKS_PATH, {
    property: "https://us-client.example/",
    label: "owner",
  }).token;
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

function props(t: string, searchParams: Record<string, string> = {}) {
  return { params: Promise.resolve({ token: t }), searchParams: Promise.resolve(searchParams) };
}

/** Every href in the page, so a test can assert there is nowhere else to go. */
function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
}

describe("the client's report page", () => {
  it("renders the token's site, in the site's language", async () => {
    const html = renderToStaticMarkup(await SharedReportPage(props(token)));
    expect(html).toContain("US Client");
    expect(html).toContain('lang="en"');
    expect(html).toContain("SEO report");
    expect(html).not.toContain("Other Client");
  });

  it("switches language with ?lang=", async () => {
    const html = renderToStaticMarkup(await SharedReportPage(props(token, { lang: "sr" })));
    expect(html).toContain('lang="sr"');
  });

  it("links only to the client's own pages and the agency site", async () => {
    const html = renderToStaticMarkup(await SharedReportPage(props(token)));
    for (const href of hrefs(html)) {
      const ok = href.startsWith(`/share/${token}`) || href === "https://deimos.agency";
      expect(ok, href).toBe(true);
    }
    expect(hrefs(html)).toContain(`/share/${token}/live`);
    expect(hrefs(html)).toContain(`/share/${token}/report/pdf?lang=en`);
  });

  it("404s an unknown, malformed or revoked token", async () => {
    await expect(SharedReportPage(props(newShareToken()))).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    await expect(SharedReportPage(props("nope"))).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  });
});

describe("the client's live page", () => {
  it("404s an unknown token", async () => {
    await expect(SharedLivePage(props(newShareToken()))).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  });
});

describe("ShareTabs", () => {
  it("offers exactly the report and live data, marking the current one", () => {
    const html = renderToStaticMarkup(<ShareTabs token="tok" current="live" />);
    expect(hrefs(html)).toEqual(["/share/tok", "/share/tok/live"]);
    expect(html).toMatch(/aria-current="page"[^>]*>Live data</);
  });
});

describe("internalShareReportUrl", () => {
  it("prints the share page over loopback, which the proxy lets through on its token", () => {
    process.env.PORT = "3000";
    const url = internalShareReportUrl(token, "https://clients.deimos.agency/share/x/report/pdf", "sr");
    expect(url).toBe(`http://127.0.0.1:3000/share/${token}?lang=sr`);
    const parsed = new URL(url);
    expect(
      decideAccess(
        { method: "GET", pathname: parsed.pathname, host: parsed.host, authorization: null,
          renderToken: null, nextAction: false },
        { username: "acko", password: "pw" },
        "192.168.1.156:8091",
      ),
    ).toBe("share");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd app && npx vitest run tests/share-pages.test.tsx`
Expected: FAIL — `Cannot find module '../app/share/[token]/page'`.

- [ ] **Step 3: Create `app/components/ShareTabs.tsx`**

```tsx
/** The client's only navigation: their report and their live data. */
export default function ShareTabs({ token, current }: { token: string; current: "report" | "live" }) {
  const tabs = [
    { key: "report", label: "Report", href: `/share/${token}` },
    { key: "live", label: "Live data", href: `/share/${token}/live` },
  ] as const;
  return (
    <nav aria-label="Client view" className="flex items-center gap-1 text-sm">
      {tabs.map((tab) => (
        <a
          key={tab.key}
          href={tab.href}
          aria-current={tab.key === current ? "page" : undefined}
          className={
            tab.key === current
              ? "rounded-md bg-neutral-900 px-3 py-1 text-white"
              : "rounded-md px-3 py-1 text-neutral-600 hover:bg-neutral-100"
          }
        >
          {tab.label}
        </a>
      ))}
    </nav>
  );
}
```

- [ ] **Step 4: Add the share URL to `app/lib/report/pdf.ts`** — replace the first two lines of `internalReportUrl`'s body:

```ts
  const port = process.env.PORT ?? new URL(requestUrl).port ?? "3000";
  const url = `http://127.0.0.1:${port || "3000"}/site/${encodeURIComponent(slug)}/report`;
```

with:

```ts
  const url = `${loopbackOrigin(requestUrl)}/site/${encodeURIComponent(slug)}/report`;
```

and add, directly above the doc comment of `internalReportUrl`:

```ts
/** The loopback origin the server's own chromium prints from (see below). */
function loopbackOrigin(requestUrl: string): string {
  const port = process.env.PORT ?? new URL(requestUrl).port ?? "3000";
  return `http://127.0.0.1:${port || "3000"}`;
}

/**
 * The share page chromium prints for a client's PDF. No render token: the
 * share token is the access, and the proxy opens `/share/*` (GET) on every
 * host, loopback included.
 */
export function internalShareReportUrl(
  token: string,
  requestUrl: string,
  lang: ReportLanguage
): string {
  return `${loopbackOrigin(requestUrl)}/share/${encodeURIComponent(token)}?lang=${lang}`;
}

```

- [ ] **Step 5: Create `app/app/share/[token]/page.tsx`**

```tsx
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import ShareTabs from "../../../components/ShareTabs";
import LanguageSwitch from "../../../components/report/LanguageSwitch";
import PrintButton from "../../../components/report/PrintButton";
import ReportDocument from "../../../components/report/ReportDocument";
import { formatISODateUTC } from "../../../lib/analysis/windows";
import { siteLanguage } from "../../../lib/db";
import { buildReportData } from "../../../lib/report/data";
import { reportStrings, resolveReportLanguage } from "../../../lib/report/language";
import { resolveShare } from "../../../lib/shareScope";

type Props = {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const ROBOTS = { index: false, follow: false };

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const share = resolveShare((await params).token);
  if (!share) return { robots: ROBOTS };
  const lang = resolveReportLanguage((await searchParams).lang, siteLanguage(share.config.property));
  return { title: `${share.config.displayName} — ${reportStrings(lang).docTitle}`, robots: ROBOTS };
}

/**
 * The client's report, reached by a share link. The token alone decides the
 * site (resolveShare); an invalid, revoked or removed-site token is a 404.
 */
export default async function SharedReportPage({ params, searchParams }: Props) {
  await connection();
  const { token } = await params;
  const share = resolveShare(token);
  if (!share) notFound();

  const lang = resolveReportLanguage((await searchParams).lang, siteLanguage(share.config.property));
  const t = reportStrings(lang);
  const data = buildReportData(share.config, formatISODateUTC(new Date()));
  const base = `/share/${token}`;

  return (
    <ReportDocument
      data={data}
      lang={lang}
      toolbar={
        <>
          <div className="mr-auto">
            <ShareTabs token={token} current="report" />
          </div>
          <LanguageSwitch current={lang} hrefFor={(l) => `${base}?lang=${l}`} />
          <PrintButton
            href={`${base}/report/pdf?lang=${lang}`}
            labels={{ print: t.print, busy: t.printBusy, error: t.printError }}
          />
        </>
      }
    />
  );
}
```

- [ ] **Step 6: Create `app/app/share/[token]/live/page.tsx`**

```tsx
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import ShareTabs from "../../../../components/ShareTabs";
import SiteDashboard from "../../../../components/SiteDashboard";
import { resolveShare } from "../../../../lib/shareScope";

type Props = { params: Promise<{ token: string }> };

const ROBOTS = { index: false, follow: false };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const share = resolveShare((await params).token);
  if (!share) return { robots: ROBOTS };
  return { title: `${share.config.displayName} — Live data`, robots: ROBOTS };
}

/**
 * The client's live data: the same dashboard as the admin site page, with the
 * client tabs instead of the admin header. English, read-only.
 */
export default async function SharedLivePage({ params }: Props) {
  await connection();
  const { token } = await params;
  const share = resolveShare(token);
  if (!share) notFound();

  return <SiteDashboard config={share.config} top={<ShareTabs token={token} current="live" />} />;
}
```

- [ ] **Step 7: Create `app/app/share/[token]/report/pdf/route.ts`**

```ts
import { formatISODateUTC } from "../../../../../lib/analysis/windows";
import { siteLanguage } from "../../../../../lib/db";
import { buildReportData } from "../../../../../lib/report/data";
import { resolveReportLanguage } from "../../../../../lib/report/language";
import {
  contentDispositionAttachment,
  internalShareReportUrl,
  renderPdf,
  reportPdfFilenameFor,
} from "../../../../../lib/report/pdf";
import { resolveShare } from "../../../../../lib/shareScope";

/**
 * The client's report as a PDF: prints `/share/<token>` in the requested
 * language, the same way the admin PDF prints the admin report.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: RouteContext<"/share/[token]/report/pdf">) {
  const { token } = await ctx.params;
  const share = resolveShare(token);
  if (!share) {
    return new Response("Not found", { status: 404 });
  }

  const lang = resolveReportLanguage(
    new URL(request.url).searchParams.get("lang"),
    siteLanguage(share.config.property)
  );
  const data = buildReportData(share.config, formatISODateUTC(new Date()));

  let pdf: Buffer;
  try {
    pdf = await renderPdf(internalShareReportUrl(token, request.url, lang));
  } catch (err) {
    console.error("[share-pdf] render failed", err);
    return new Response("PDF rendering failed", { status: 500 });
  }

  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(pdf.byteLength),
      "Content-Disposition": contentDispositionAttachment(
        reportPdfFilenameFor(share.config.displayName, lang, data.measuredStart, data.measuredEnd)
      ),
      "Cache-Control": "no-store",
    },
  });
}
```

- [ ] **Step 8: Run the tests, types and lint**

Run: `cd app && npx vitest run && npx next typegen > /dev/null && npx tsc --noEmit && npm run lint 2>&1 | grep problems`
Expected: all pass, `tsc` silent (typegen creates the `RouteContext` for the new route), lint `0 errors`.

- [ ] **Step 9: Commit**

```bash
git add app/components/ShareTabs.tsx app/lib/report/pdf.ts "app/app/share" app/tests/share-pages.test.tsx
git commit -m "Give clients their report, live data and PDF behind a share link"
```

---

### Task 8: Deployment config — compose, runbook, guards

**Files:**
- Modify: `deploy/compose.snippet.yml` (dashboard env; `seo-cockpit-tunnel` service)
- Modify: `deploy/DEPLOY.md` (new section "1d. Client share links")
- Test: `collector/tests/test_compose_snippet.py` (new); `collector/tests/test_deploy_docs.py` (append)

**Interfaces:**
- Produces: compose env `SEO_INTERNAL_HOSTS`, `SEO_PUBLIC_BASE_URL`, `SEO_SHARE_LINKS_PATH`; service `seo-cockpit-tunnel` (`cloudflare/cloudflared:2026.9.3`, `TUNNEL_TOKEN: ${SEO_TUNNEL_TOKEN:?…}`, no ports).

- [ ] **Step 1: Write the failing tests** — create `collector/tests/test_compose_snippet.py`:

```python
"""Guards on the client share links' deployment config in compose.snippet.yml.

The tunnel is the only path from the internet to the Pi, so its service must
never publish a port, must be pinned, and must refuse to start without its
token; the dashboard must know which hosts are internal.
"""

import re
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parent.parent.parent
SNIPPET = REPO / "deploy" / "compose.snippet.yml"


def _services() -> dict:
    return yaml.safe_load(SNIPPET.read_text())["services"]


def test_tunnel_service_is_pinned_publishes_nothing_and_needs_its_token():
    tunnel = _services()["seo-cockpit-tunnel"]
    assert re.fullmatch(r"cloudflare/cloudflared:\d{4}\.\d+\.\d+", tunnel["image"])
    assert "ports" not in tunnel
    assert tunnel["command"] == "tunnel --no-autoupdate run"
    assert tunnel["environment"]["TUNNEL_TOKEN"].startswith("${SEO_TUNNEL_TOKEN:?")


def test_dashboard_knows_its_internal_hosts_public_url_and_links_file():
    env = _services()["seo-cockpit-dashboard"]["environment"]
    assert "192.168.1.156:8091" in env["SEO_INTERNAL_HOSTS"]
    assert "https://clients.deimos.agency" in env["SEO_PUBLIC_BASE_URL"]
    assert "/config/share-links.json" in env["SEO_SHARE_LINKS_PATH"]
```

Append to `collector/tests/test_deploy_docs.py`:

```python


def test_runbook_covers_client_share_links():
    text = RUNBOOK.read_text()
    for needle in ("SEO_INTERNAL_HOSTS", "SEO_TUNNEL_TOKEN", "clients.deimos.agency", "/sites/links"):
        assert needle in text, needle
```

- [ ] **Step 2: Run to verify they fail**

Run: `collector/.venv/bin/python -m pytest -q collector/tests/test_compose_snippet.py collector/tests/test_deploy_docs.py`
Expected: FAIL — `KeyError: 'seo-cockpit-tunnel'`, missing env keys, and the runbook needles.

- [ ] **Step 3: Update `deploy/compose.snippet.yml`** — in the dashboard's `environment:`, directly after the `SEO_DASHBOARD_USER` line, add:

```yaml
      # Client share links (docs/superpowers/specs/2026-10-09-client-share-links-design.md).
      # Hosts that get the admin app (still behind the password): the Host
      # header values you use on the LAN / WireGuard. Any other host, the
      # tunnel's included, only serves /share/* and 404s everything else.
      # An unlisted own host gets a 404: add it here and in the live file.
      SEO_INTERNAL_HOSTS: ${SEO_INTERNAL_HOSTS:-192.168.1.156:8091,piserver.local:8091,localhost:8091}
      # The address clients open; share URLs are built from it.
      SEO_PUBLIC_BASE_URL: ${SEO_PUBLIC_BASE_URL:-https://clients.deimos.agency}
      # The link store (hashes only), in the :rw config mount.
      SEO_SHARE_LINKS_PATH: ${SEO_SHARE_LINKS_PATH:-/config/share-links.json}
```

and append a third service at the end of the file:

```yaml

  seo-cockpit-tunnel:
    # Cloudflare Tunnel for clients.deimos.agency. Dials OUT to Cloudflare, so
    # the Pi opens no inbound port and 8091 stays LAN-only. The public
    # hostname → http://seo-cockpit-dashboard:3000 route lives in the tunnel's
    # remote config in Cloudflare (Zero Trust → Networks → Tunnels).
    # Add this service to the live file only AFTER SEO_TUNNEL_TOKEN is in
    # ~/server/.env: the :? below stops `docker compose` for the whole stack
    # until it is set.
    image: cloudflare/cloudflared:2026.9.3
    container_name: seo-cockpit-tunnel
    restart: unless-stopped
    command: tunnel --no-autoupdate run
    environment:
      TUNNEL_TOKEN: ${SEO_TUNNEL_TOKEN:?set SEO_TUNNEL_TOKEN in ~/server/.env}
    depends_on:
      - seo-cockpit-dashboard
```

- [ ] **Step 4: Add the runbook section to `deploy/DEPLOY.md`** — directly before the line `## 2. Secrets`, add:

````markdown
## 1d. Client share links (`clients.deimos.agency`)

A client gets a link like `https://clients.deimos.agency/share/<token>`. It
opens their report (their site's language, SR / EN switch, PDF download) and a
read-only **Live data** tab, and nothing else: on that address every other path
is a 404, and the token alone decides which site is shown.

- **Create a link** on the site's page ("Share with client"). The URL is shown
  **once**: only a hash of its token is stored (`config/share-links.json`), so a
  lost link is revoked and replaced, never recovered.
- **List and revoke** links at `/sites/links`. Links never expire. Removing a
  site stops its links too.
- **`SEO_INTERNAL_HOSTS`** lists the `Host` values that get the admin app (still
  behind the password): `192.168.1.156:8091,piserver.local:8091,localhost:8091`.
  **If your own dashboard suddenly shows "Not found", you reached it under a
  host that isn't listed** (e.g. `piserver:8091`): add it to the compose file and
  the live file, then recreate the dashboard.
- **The tunnel** (`seo-cockpit-tunnel`, `cloudflare/cloudflared:2026.9.3`) dials
  out to Cloudflare; the Pi opens no inbound port. Its public hostname
  `clients.deimos.agency` → `http://seo-cockpit-dashboard:3000` is set in
  Cloudflare (Zero Trust → Networks → Tunnels → `seo-cockpit`).
- **`SEO_TUNNEL_TOKEN`** is the tunnel's run token. Copy it from that tunnel's
  page in the Cloudflare dashboard into `~/server/.env`; never paste it anywhere
  else. Add the `seo-cockpit-tunnel` service to the live compose file only after
  the token is set: its `:?` stops `docker compose` for the whole stack until
  then.

Verify after a deploy:

```bash
docker logs seo-cockpit-tunnel 2>&1 | grep -i "registered tunnel connection"
curl -s -o /dev/null -w '%{http_code}\n' https://clients.deimos.agency/          # 404
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8091/                   # 401
```

---

````

- [ ] **Step 5: Run the tests and validate compose**

Run: `collector/.venv/bin/python -m pytest -q collector && GOOGLE_API_KEY=x SEO_DASHBOARD_PASSWORD=x SEO_TUNNEL_TOKEN=x docker compose -f deploy/compose.snippet.yml config > /dev/null && echo "compose OK"`
Expected: all pytest pass; `compose OK`.

- [ ] **Step 6: Commit**

```bash
git add deploy/compose.snippet.yml deploy/DEPLOY.md collector/tests/test_compose_snippet.py collector/tests/test_deploy_docs.py
git commit -m "Add the tunnel and share link settings to the deploy config"
```

---

### Task 9: See it working through a temporary tunnel

No code. Production build, real data, a real Cloudflare quick tunnel (no account), checked by script and then by Aleksandar on his phone.

- [ ] **Step 1: Build and start the quick tunnel first** (its URL is needed as `SEO_PUBLIC_BASE_URL`). The origin is the workstation's LAN address, not loopback, so the test is faithful whichever `Host` cloudflared forwards:

```bash
WORK=/tmp/claude-1000/-home-ar-Documents-GitHub-seo-cockpit/43a79ef2-95da-4f61-aad8-1c711ed1c2a9/scratchpad/share-links
LAN=$(ip -4 route get 1.1.1.1 | grep -oP 'src \K[\d.]+'); echo "LAN=$LAN"
(cd app && npx next build > $WORK/build.log 2>&1); tail -2 $WORK/build.log
docker run -d --name seo-quick-tunnel --network host cloudflare/cloudflared:2026.9.3 \
  tunnel --no-autoupdate --url http://$LAN:3998 > /dev/null
until docker logs seo-quick-tunnel 2>&1 | grep -qo 'https://[a-z0-9-]*\.trycloudflare\.com'; do sleep 1; done
PUBLIC=$(docker logs seo-quick-tunnel 2>&1 | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | head -1); echo "$PUBLIC" > $WORK/public-url; echo "$PUBLIC"
```

- [ ] **Step 2: Start the standalone server** (as `deploy/Dockerfile.dashboard` lays it out) with auth on and only loopback plus `localhost:3998` internal:

```bash
WORK=/tmp/claude-1000/-home-ar-Documents-GitHub-seo-cockpit/43a79ef2-95da-4f61-aad8-1c711ed1c2a9/scratchpad/share-links
ST=$WORK/standalone-$(date +%s); cp -r app/.next/standalone $ST && cp -r app/.next/static $ST/.next/static && cp -r app/public $ST/public
(cd $ST && NODE_ENV=production PORT=3998 HOSTNAME=0.0.0.0 SEO_DASHBOARD_PASSWORD=pw \
  SEO_INTERNAL_HOSTS=localhost:3998 SEO_PUBLIC_BASE_URL=$(cat $WORK/public-url) \
  SEO_SHARE_LINKS_PATH=$WORK/share-links.json SEO_DB_PATH=$WORK/seo.db node server.js > $WORK/server.log 2>&1 &)
until curl -s -o /dev/null http://127.0.0.1:3998/; do sleep 1; done; grep "\[auth\]" $WORK/server.log
```

- [ ] **Step 3: Create a link through the real admin action** — log in to `http://localhost:3998/site/optika-cajs` in Chrome (user `acko`, test password `pw`, a local throwaway) and use "Share with client" with label `Optika – test`; copy the URL into `$WORK/share-url`. If the browser can't be driven, create it with the same library code instead:

```bash
WORK=/tmp/claude-1000/-home-ar-Documents-GitHub-seo-cockpit/43a79ef2-95da-4f61-aad8-1c711ed1c2a9/scratchpad/share-links
cd app && node -e '
import("./lib/shareLinks.ts").then((m) => {
  const { token } = m.createShareLink(process.argv[1], { property: "https://optikacajs.rs/", label: "Optika – test" });
  console.log(process.argv[2] + "/share/" + token);
});' "$WORK/share-links.json" "$(cat $WORK/public-url)" > $WORK/share-url
```

- [ ] **Step 4: Check the public side by script**

```bash
WORK=/tmp/claude-1000/-home-ar-Documents-GitHub-seo-cockpit/43a79ef2-95da-4f61-aad8-1c711ed1c2a9/scratchpad/share-links
PUBLIC=$(cat $WORK/public-url); SHARE=$(cat $WORK/share-url); T=${SHARE##*/}
code() { curl -s -o /dev/null -w "%{http_code}" "$@"; }
for p in / /site/optika-cajs /sites/add /sites/links /site/optika-cajs/report/pdf; do printf '%-34s %s\n' "public $p" "$(code $PUBLIC$p)"; done
printf '%-34s %s\n' "share report" "$(code $SHARE)"
printf '%-34s %s\n' "share report ?lang=en" "$(code "$SHARE?lang=en")"
printf '%-34s %s\n' "share live" "$(code $SHARE/live)"
printf '%-34s %s\n' "share POST (server action)" "$(code -X POST -H 'Next-Action: x' $SHARE)"
printf '%-34s %s\n' "unknown token" "$(code $PUBLIC/share/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA)"
curl -s -D - -o /dev/null $SHARE | grep -iE "^referrer-policy|^x-robots-tag"
curl -s -o $WORK/share.pdf -D $WORK/share-pdf.h "$SHARE/report/pdf?lang=sr"; grep -iE "^HTTP|content-type|content-disposition" $WORK/share-pdf.h
for page in "" /live; do curl -s "$SHARE$page" > $WORK/page.html; python3 - "$WORK/page.html" "$T" <<'EOF'
import re, sys
html, token = open(sys.argv[1], encoding="utf-8").read(), sys.argv[2]
bad = [h for h in re.findall(r'href="([^"]*)"', html)
       if not (h.startswith(f"/share/{token}") or h.startswith("https://deimos.agency")
               or h.startswith("/_next/") or h.startswith("/favicon.ico"))]
print("forbidden hrefs:", bad or "none")
EOF
done
```

Expected: every `public …` path `404`; share report, `?lang=en` and live `200`; POST `404`; unknown token `404`; `referrer-policy: no-referrer` and `x-robots-tag: noindex, nofollow`; the PDF `200 application/pdf` with a Serbian filename; `forbidden hrefs: none` for both pages. If `public /` is `401` instead of `404`, the tunnel forwarded a loopback Host: stop and rule (Review Focus 1).

- [ ] **Step 5: Revocation works** — revoke on `http://localhost:3998/sites/links` (or `revokeShareLink` via `node -e` as in Step 3), then `curl -s -o /dev/null -w '%{http_code}\n' $SHARE` → `404`. Create a fresh link for Step 6.

- [ ] **Step 6: Aleksandar tries it on his phone** — send him the fresh share URL in chat (a throwaway quick-tunnel link to his own data): open it, switch SR / EN, download the PDF, open Live data, and try the bare `trycloudflare.com` address (expect "Not found"). Wait for his go-ahead.

- [ ] **Step 7: Tear down** — `docker rm -f seo-quick-tunnel`; stop the server by its port (`ss -ltnp | grep ':3998 '`, `kill <pid>`).

---

### Task 10: `clients.deimos.agency` in production

Stop points are marked **[Aleksandar]**; everything else runs here.

- [ ] **Step 1: Merge and push** — once Task 9 is approved: fast-forward `main` to the feature branch, push, watch CI (`gh run watch <id> --exit-status`).

- [ ] **Step 2: [Aleksandar] Approve the Cloudflare connection** — load the tools (`ToolSearch` `select:mcp__plugin_cloudflare_cloudflare__authenticate,mcp__plugin_cloudflare_cloudflare__complete_authentication`), call `authenticate`, give him the URL; he approves in the browser; finish with `complete_authentication`.

- [ ] **Step 3: Create the tunnel and route** with the Cloudflare MCP tools (account and zone looked up by name `deimos.agency`):
  - a remotely-managed tunnel named `seo-cockpit` (`config_src: "cloudflare"`);
  - its configuration: ingress `clients.deimos.agency` → `http://seo-cockpit-dashboard:3000`, then a catch-all `http_status:404`;
  - a proxied DNS `CNAME` `clients` → `<tunnel-id>.cfargotunnel.com`.

  Never call the tunnel-token endpoint, and never repeat a token that appears in a response.

- [ ] **Step 4: [Aleksandar] Put the run token in `.env`** — Zero Trust → Networks → Tunnels → `seo-cockpit` → the install command shows the token; he adds `SEO_TUNNEL_TOKEN=<token>` to `~/server/.env` himself and confirms with `grep -c '^SEO_TUNNEL_TOKEN=..' ~/server/.env` → `1`.

- [ ] **Step 5: Edit the live compose file** (back it up first, as on 2026-10-09: `docker-compose.yml.bak-sharelinks-<timestamp>`): add the three dashboard env lines after `SEO_DASHBOARD_USER`, and append the `seo-cockpit-tunnel` service from the snippet. Show the `diff` (additions only) and `docker compose config >/dev/null && echo OK`.

- [ ] **Step 6: Deploy** — confirm no collection is running; `git -C ~/server/seo-cockpit/src pull --ff-only`; build the dashboard image detached (as before), `docker compose up -d seo-cockpit-dashboard seo-cockpit-tunnel`, then `docker image prune -f && docker builder prune -f`.

- [ ] **Step 7: Verify in production**
  - `docker logs seo-cockpit-tunnel | grep -i "registered tunnel connection"` (four connections);
  - `curl https://clients.deimos.agency/` → `404`; `curl http://localhost:8091/` on the Pi → `401`;
  - **[Aleksandar]** creates the first real link on Optika's page (`http://192.168.1.156:8091/site/optika-cajs`), opens it on his phone, and checks report, SR / EN, PDF and Live data; then revokes a test link on `/sites/links` and confirms it 404s.
