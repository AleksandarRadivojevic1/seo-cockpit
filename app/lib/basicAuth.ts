import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * HTTP Basic auth over the whole dashboard, ported from revenue-tracker's
 * server/auth.js and applied in proxy.ts. The dashboard can add and remove
 * sites and trigger collection runs, and its port is published on every
 * interface of the Pi, so anyone on the LAN could otherwise use it.
 *
 * Enabled only when SEO_DASHBOARD_PASSWORD is set, so local `npm run dev`
 * stays open while the deployed container (which sets it) is gated. The
 * username defaults to `acko`, overridable with SEO_DASHBOARD_USER.
 */
export interface BasicAuthConfig {
  username: string;
  password: string;
}

export function basicAuthConfig(
  env: Record<string, string | undefined> = process.env,
): BasicAuthConfig | null {
  const password = env.SEO_DASHBOARD_PASSWORD || "";
  if (!password) return null;
  return { username: env.SEO_DASHBOARD_USER || "acko", password };
}

/** Constant-time compare that also resists length leakage. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufB, bufB); // keep timing uniform
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function hasValidCredentials(header: string | null, auth: BasicAuthConfig): boolean {
  if (!header?.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const i = decoded.indexOf(":");
  if (i === -1) return false;
  // Both compares always run, so a wrong username costs the same time as a
  // wrong password.
  const userOk = safeEqual(decoded.slice(0, i), auth.username);
  const passOk = safeEqual(decoded.slice(i + 1), auth.password);
  return userOk && passOk;
}

/**
 * The token the PDF route appends to the report URL it hands headless
 * chromium, which loads the page over loopback and cannot send credentials.
 * Derived from the password, so it changes with it and the password itself
 * never appears on chromium's command line. Only accepted for GET on a
 * report page (see isAuthorized).
 */
export function reportRenderToken(auth: BasicAuthConfig): string {
  return createHmac("sha256", auth.password)
    .update(`seo-cockpit report render:${auth.username}`)
    .digest("base64url");
}

export const RENDER_TOKEN_PARAM = "render";

const REPORT_PAGE = /^\/site\/[^/]+\/report$/;
// Files in public/ (the report's logo and Next's stock icons) sit at the top
// level; no app route does, so a GET there can only be a static file.
export const PUBLIC_IMAGE = /^\/[\w.-]+\.(?:svg|png|ico|jpe?g|webp)$/;

export interface AuthRequest {
  method: string;
  pathname: string;
  authorization: string | null;
  renderToken: string | null;
}

export function isAuthorized(req: AuthRequest, auth: BasicAuthConfig): boolean {
  const isRead = req.method === "GET" || req.method === "HEAD";
  // Public images load without credentials so the report's logo also reaches
  // the chromium render, whose subresource requests carry no token.
  if (isRead && PUBLIC_IMAGE.test(req.pathname)) return true;
  if (hasValidCredentials(req.authorization, auth)) return true;
  return (
    isRead &&
    REPORT_PAGE.test(req.pathname) &&
    req.renderToken !== null &&
    safeEqual(req.renderToken, reportRenderToken(auth))
  );
}
