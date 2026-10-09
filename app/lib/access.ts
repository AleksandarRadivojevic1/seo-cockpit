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
