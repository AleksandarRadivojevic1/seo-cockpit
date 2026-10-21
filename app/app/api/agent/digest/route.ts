import { buildAgentDigest } from "../../../../lib/agentDigest";
import { formatISODateUTC } from "../../../../lib/analysis/windows";
import { listSiteConfigs, siteConfigBySlug } from "../../../../lib/db";

/**
 * JSON digest for LLM agents: `GET /api/agent/digest` returns every active
 * site, `?site=<slug>` returns one. Repeat `&track=<query>` (max 20) to get
 * those queries' current numbers whatever their rank -- how an agent checks
 * whether shipped work paid off. See lib/agentDigest.ts.
 *
 * No auth code here on purpose. proxy.ts already puts every non-share path
 * behind Basic auth and the internal-host check, so with SEO_INTERNAL_HOSTS
 * set this route is a 404 on a public host like the rest of the admin app.
 * Agents on the Pi call it over loopback, which is always internal:
 *
 *   curl -sn "http://127.0.0.1:8091/api/agent/digest?site=optika-cajs"
 *
 * (`-n` reads the credential from ~/.netrc; see agents/README.md.)
 */
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const asOf = formatISODateUTC(new Date());
  const params = new URL(request.url).searchParams;
  const slug = params.get("site");
  const options = { track: params.getAll("track") };

  let body: unknown;
  if (slug) {
    const config = siteConfigBySlug(slug);
    if (!config) {
      return Response.json({ error: `unknown site: ${slug}` }, { status: 404 });
    }
    body = buildAgentDigest(config, asOf, undefined, options);
  } else {
    body = {
      asOf,
      sites: listSiteConfigs().map((config) => buildAgentDigest(config, asOf, undefined, options)),
    };
  }

  return Response.json(body, {
    // The windows move daily; a cached digest would have an agent act on
    // yesterday's data while its ticket claims today's date.
    headers: { "Cache-Control": "no-store" },
  });
}
