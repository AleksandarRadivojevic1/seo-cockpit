import { describe, expect, it } from "vitest";

// Import order matters here: loading Next's experimental testing helpers
// before next/server (pulled in by the proxy) trips Next's AsyncLocalStorage
// invariant under vitest. Kept apart from basic-auth.test.ts for the same
// reason.
import { config as proxyConfig } from "../proxy";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";

describe("proxy matcher", () => {
  const matches = (url: string) => unstable_doesMiddlewareMatch({ config: proxyConfig, url });

  it("covers pages, the PDF route and server actions' page paths", () => {
    expect(matches("/")).toBe(true);
    expect(matches("/sites/add")).toBe(true);
    expect(matches("/site/skedio")).toBe(true);
    expect(matches("/site/skedio/report/pdf")).toBe(true);
  });

  it("skips Next's static build output", () => {
    expect(matches("/_next/static/chunks/main.js")).toBe(false);
  });
});
