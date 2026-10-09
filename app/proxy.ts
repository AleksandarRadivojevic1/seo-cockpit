import { NextResponse, type NextRequest } from "next/server";

import { RENDER_TOKEN_PARAM, basicAuthConfig, isAuthorized } from "./lib/basicAuth";

// Logged once when the proxy loads, so `docker logs` shows whether the
// password reached the container (an unset one leaves the dashboard open).
const startupAuth = basicAuthConfig();
console.log(
  startupAuth
    ? `[auth] Basic auth enabled for user "${startupAuth.username}"`
    : "[auth] SEO_DASHBOARD_PASSWORD unset — auth disabled (dev mode)",
);

/**
 * Basic auth in front of every page, route handler and server action (a
 * server action is a POST to the page it lives on, so the matcher must cover
 * pages, not only an /api prefix). See lib/basicAuth.ts for the rules.
 */
export function proxy(request: NextRequest) {
  const auth = basicAuthConfig();
  if (!auth) return NextResponse.next();

  const authorized = isAuthorized(
    {
      method: request.method,
      pathname: request.nextUrl.pathname,
      authorization: request.headers.get("authorization"),
      renderToken: request.nextUrl.searchParams.get(RENDER_TOKEN_PARAM),
    },
    auth,
  );
  if (authorized) return NextResponse.next();

  return new NextResponse("Authentication required.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="SEO Cockpit", charset="UTF-8"' },
  });
}

export const config = {
  // Everything except Next's static build output, which holds no data.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
