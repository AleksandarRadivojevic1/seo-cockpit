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
