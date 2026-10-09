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
