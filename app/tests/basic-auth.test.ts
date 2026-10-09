import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { proxy } from "../proxy";
import {
  basicAuthConfig,
  hasValidCredentials,
  isAuthorized,
  reportRenderToken,
} from "../lib/basicAuth";
import { internalReportUrl } from "../lib/report/pdf";

const ENV_KEYS = ["SEO_DASHBOARD_PASSWORD", "SEO_DASHBOARD_USER", "PORT"] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
}

const basic = (user: string, pass: string) =>
  `Basic ${Buffer.from(`${user}:${pass}`, "utf8").toString("base64")}`;

const AUTH = { username: "acko", password: "s3cret:with-colon" };

describe("basicAuthConfig", () => {
  it("is off when SEO_DASHBOARD_PASSWORD is unset, so local dev stays open", () => {
    expect(basicAuthConfig({})).toBeNull();
    expect(basicAuthConfig({ SEO_DASHBOARD_PASSWORD: "" })).toBeNull();
  });

  it("defaults the username to acko, overridable", () => {
    expect(basicAuthConfig({ SEO_DASHBOARD_PASSWORD: "pw" })).toEqual({
      username: "acko",
      password: "pw",
    });
    expect(
      basicAuthConfig({ SEO_DASHBOARD_PASSWORD: "pw", SEO_DASHBOARD_USER: "alex" }),
    ).toEqual({ username: "alex", password: "pw" });
  });
});

describe("hasValidCredentials", () => {
  it("accepts the right user and password, splitting at the first colon", () => {
    expect(hasValidCredentials(basic("acko", "s3cret:with-colon"), AUTH)).toBe(true);
  });

  it("rejects a wrong password, a wrong user, and malformed headers", () => {
    expect(hasValidCredentials(basic("acko", "nope"), AUTH)).toBe(false);
    expect(hasValidCredentials(basic("someone", "s3cret:with-colon"), AUTH)).toBe(false);
    expect(hasValidCredentials(null, AUTH)).toBe(false);
    expect(hasValidCredentials("Bearer abc", AUTH)).toBe(false);
    expect(hasValidCredentials(`Basic ${Buffer.from("no-colon").toString("base64")}`, AUTH)).toBe(
      false,
    );
  });
});

describe("isAuthorized", () => {
  const token = reportRenderToken(AUTH);
  const req = (over: Partial<Parameters<typeof isAuthorized>[0]>) => ({
    method: "GET",
    pathname: "/",
    authorization: null,
    renderToken: null,
    ...over,
  });

  it("requires credentials for pages and for server actions (POSTs to a page)", () => {
    expect(isAuthorized(req({}), AUTH)).toBe(false);
    expect(isAuthorized(req({ method: "POST", pathname: "/sites/add" }), AUTH)).toBe(false);
    expect(
      isAuthorized(req({ method: "POST", authorization: basic("acko", AUTH.password) }), AUTH),
    ).toBe(true);
  });

  it("lets the PDF renderer load a report page with the render token, and nothing else", () => {
    // Headless chromium can't send credentials. It gets a token derived from
    // the password, good only for GET on a report page.
    expect(isAuthorized(req({ pathname: "/site/skedio/report", renderToken: token }), AUTH)).toBe(
      true,
    );
    expect(isAuthorized(req({ pathname: "/site/skedio/report", renderToken: "x" }), AUTH)).toBe(
      false,
    );
    expect(isAuthorized(req({ pathname: "/site/skedio", renderToken: token }), AUTH)).toBe(false);
    expect(
      isAuthorized(req({ pathname: "/site/skedio/report/pdf", renderToken: token }), AUTH),
    ).toBe(false);
    expect(
      isAuthorized(
        req({ method: "POST", pathname: "/site/skedio/report", renderToken: token }),
        AUTH,
      ),
    ).toBe(false);
  });

  it("serves top-level public images without credentials (the report's logo), on GET only", () => {
    expect(isAuthorized(req({ pathname: "/deimos-logo.svg" }), AUTH)).toBe(true);
    expect(isAuthorized(req({ method: "POST", pathname: "/deimos-logo.svg" }), AUTH)).toBe(false);
    expect(isAuthorized(req({ pathname: "/site/x.svg" }), AUTH)).toBe(false);
  });

  it("derives a different render token from a different password", () => {
    expect(reportRenderToken({ ...AUTH, password: "other" })).not.toBe(token);
  });
});

describe("proxy", () => {
  beforeEach(() => {
    delete process.env.SEO_DASHBOARD_USER;
  });
  afterEach(restoreEnv);

  const passesThrough = (res: Response) => res.headers.get("x-middleware-next") === "1";

  it("passes everything through when no password is configured", () => {
    delete process.env.SEO_DASHBOARD_PASSWORD;
    const res = proxy(new NextRequest("http://192.168.1.156:8091/"));
    expect(passesThrough(res)).toBe(true);
  });

  it("challenges a request without credentials", async () => {
    process.env.SEO_DASHBOARD_PASSWORD = "pw";
    const res = proxy(new NextRequest("http://192.168.1.156:8091/sites/add"));
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toMatch(/^Basic realm="SEO Cockpit"/);
    expect(await res.text()).not.toContain("pw");
  });

  it("passes a request with the right credentials", () => {
    process.env.SEO_DASHBOARD_PASSWORD = "pw";
    const res = proxy(
      new NextRequest("http://192.168.1.156:8091/", {
        headers: { authorization: basic("acko", "pw") },
      }),
    );
    expect(passesThrough(res)).toBe(true);
  });

  it("passes the URL the PDF route hands chromium", () => {
    process.env.SEO_DASHBOARD_PASSWORD = "pw";
    process.env.PORT = "3000";
    const url = internalReportUrl("skedio", "http://192.168.1.156:8091/site/skedio/report/pdf");
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:3000\/site\/skedio\/report\?render=/);
    expect(url).not.toContain("pw");
    expect(passesThrough(proxy(new NextRequest(url)))).toBe(true);
  });

  it("leaves the internal report URL unchanged when auth is off", () => {
    delete process.env.SEO_DASHBOARD_PASSWORD;
    process.env.PORT = "3000";
    expect(internalReportUrl("skedio", "http://localhost:3000/")).toBe(
      "http://127.0.0.1:3000/site/skedio/report",
    );
  });

  it("passes the English PDF render URL", () => {
    process.env.SEO_DASHBOARD_PASSWORD = "pw";
    process.env.PORT = "3000";
    const url = internalReportUrl(
      "skedio",
      "http://192.168.1.156:8091/site/skedio/report/pdf",
      "en",
    );
    expect(url).toContain("?lang=en&render=");
    expect(passesThrough(proxy(new NextRequest(url)))).toBe(true);
  });
});
