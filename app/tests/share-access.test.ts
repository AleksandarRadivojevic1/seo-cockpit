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
