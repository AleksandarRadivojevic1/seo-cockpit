# Client share links — design

**Date:** 2026-10-09
**Status:** Design approved in conversation (section 1); spec awaiting review
**Supersedes:** `2026-09-14-client-share-links-design.md` (written before the
dashboard had Basic auth and before Next 16 renamed `middleware.ts` to
`proxy.ts`; its "no Cloudflare domain yet" no longer holds).
**Part of:** client access, piece 2 of 2. Piece 1, the bilingual report, is
live (`2026-10-09-bilingual-client-report-design.md`).

## Goal

An agency client gets a link, `https://clients.deimos.agency/share/<token>`,
that opens **their own** report (in their site's language, with the SR / EN
switch and the PDF download) and a **read-only live dashboard** of their site
(English). Nothing else in the app is reachable from that address.

## Decisions (Aleksandar, 2026-10-09)

1. **Hostname:** `clients.deimos.agency`. `deimos.agency` is already on
   Cloudflare nameservers, so a named tunnel can serve it.
2. **Live data tab:** the **whole** site dashboard, read-only, with every admin
   control removed. Always English (only reports are bilingual).
3. **Lifetime:** links **never expire**; revoked by hand. Several labelled links
   per site are allowed ("Optika – owner", "Optika – marketing").
4. **Reach:** a Cloudflare Tunnel. The Pi opens no inbound port; `8091` stays
   LAN / WireGuard only.

## Security invariants

A bug here leaks one client's commercial data to another, or opens the admin
to the internet. Every part of the design upholds these:

- **The token alone decides the site.** Share routes take no site identifier;
  the property comes from the token record. There is no parameter to ask for
  another site.
- **Deny by default.** No valid token → 404 (never 403: don't confirm a
  resource exists). A revoked token, a token for a removed (retired) site, or a
  malformed one → 404.
- **Share paths are read-only: GET and HEAD only.** A Next server action is a
  POST to *any* page path, identified by a header, so a `/share/*` path that
  accepted POSTs would let anyone on the internet invoke `addSite`,
  `removeSite` or `requestCollectionRun` without the password. The proxy
  rejects every other method on `/share/*`, and any request carrying the
  `Next-Action` header there.
- **Admin actions check for themselves.** Every admin server action starts by
  asserting the request is an authenticated internal one, independent of the
  proxy (the defence Next's own docs ask for).
- **Fail closed on host.** Only hosts listed as internal (plus loopback) get
  the admin app, still behind Basic auth. Any other host, including
  `clients.deimos.agency` and anything unrecognised, gets only `/share/*` and
  public images; everything else is 404.
- **Tokens are hashed at rest.** 32 random bytes (base64url, 43 characters),
  shown once at creation; `share-links.json` stores only the SHA-256. The
  file is never a list of working links.
- **The token never leaves the page.** `Referrer-Policy: no-referrer` on share
  responses, so outbound links don't carry it; `X-Robots-Tag: noindex,
  nofollow` and a `noindex` meta, so a leaked link isn't indexed.
- **`seo.db` stays read-only** to the dashboard. The only writable surface
  stays `config/`, now also holding `share-links.json`.

## Access rules (`proxy.ts`)

Evaluated per request, first match wins:

1. **Path starts with `/share/`:**
   - method is not GET / HEAD, or the `Next-Action` header is present → `404`;
   - otherwise → pass through, adding `Referrer-Policy: no-referrer` and
     `X-Robots-Tag: noindex, nofollow`. The **route** validates the token.
     This holds on every host, which is also how the PDF renderer's headless
     chromium (loopback, no credentials) loads a share page.
2. **GET / HEAD of a top-level public image** (`/deimos-logo.svg`, …) → pass,
   as today (the report's logo is a CSS mask).
3. **Internal host** (loopback, or listed in `SEO_INTERNAL_HOSTS`) → today's
   Basic auth rules, unchanged (credentials, or the render token on
   `GET /site/<slug>/report`).
4. **Any other host** → `404`.

`SEO_INTERNAL_HOSTS` is a comma-separated list of `Host` header values
(host:port) that get the admin app, e.g.
`192.168.1.156:8091,piserver.local:8091,localhost:8091`. Loopback
(`127.0.0.1`, `localhost`, `[::1]`, any port) is always internal: the
dashboard's own chromium renders admin PDFs over loopback. **Unset** means
every host is internal, which keeps today's behaviour for local dev and for
a deploy that hasn't set it yet; compose sets it.

A forged `Host` on the LAN earns at most the Basic auth prompt or a 404, never
admin. Through the tunnel, Cloudflare routes by hostname, so requests arrive
as `clients.deimos.agency`.

## Admin server actions

`assertAdminRequest()` (new, `lib/adminGuard.ts`), called first in `addSite`,
`removeSite`, `requestCollectionRun`, `refreshProperties`, `createShareLink`
and `revokeShareLink`. It reads the request headers and throws unless:

- the `Host` is internal (rule 3 above), and
- Basic auth is off, or the `Authorization` header carries valid credentials.

## Token store — `config/share-links.json`

```json
[
  {
    "id": "sl_8c1f2e9a",
    "token_hash": "<sha256 hex of the raw token>",
    "property": "https://optikacajs.rs/",
    "label": "Optika – owner",
    "created_at": "2026-10-09T13:00:00.000Z",
    "revoked_at": null
  }
]
```

- One site per link (`property`); a client with two sites gets two links.
- `id` is 8 random hex characters with an `sl_` prefix, used only to revoke.
- **Mint:** 32 bytes from `crypto.randomBytes`, base64url → raw token; store
  its SHA-256 hex. The raw token goes into the URL shown once.
- **Resolve:** SHA-256 the incoming token, find a record with that hash,
  `revoked_at === null`, and a property that is still an **active** site
  (`sites.active = 1`). Otherwise `null` → 404. Compare hashes with
  `timingSafeEqual`.
- **Revoke:** set `revoked_at` to now. Records are kept, so the list shows
  what was revoked when.
- **Writes** are atomic (temp file + rename) and keep a `.bak`, and a
  malformed file is refused rather than overwritten: the same guard as
  `user-sites.json`, reusing its pattern.
- `SEO_SHARE_LINKS_PATH`, default `/config/share-links.json` (dashboard only;
  the collector never reads it).

## Pages

### Client-facing (any host, token-gated)

- **`/share/[token]`** — the report: `ReportDocument` for the token's site, in
  the site's language (`siteLanguage`, overridable with `?lang=`). Toolbar:
  **Report / Live data** tabs, the SR / EN switch (links to
  `/share/<token>?lang=…`), and the PDF button (`/share/<token>/report/pdf?lang=…`).
- **`/share/[token]/live`** — the whole site dashboard for that site, read-only,
  English. The same header tabs; none of the admin header (no link to the
  overview, the proposal, the admin report, or any other site).
- **`/share/[token]/report/pdf`** — prints `/share/<token>?lang=…` through the
  existing chromium path (loopback; the token is the access) and names the
  file with `reportPdfFilenameFor`.
- All three: `robots: { index: false, follow: false }` metadata.

To render the live view without duplicating the dashboard, the body of
`/site/[slug]/page.tsx` moves into a `SiteDashboard` component that takes the
site config and a `header` node, exactly as `ReportDocument` takes a
`toolbar`. The admin page passes today's header; the share page passes the
client tabs.

### Admin (internal host, Basic auth)

- **On each site page:** a "Share with client" form (label field + button).
  The action mints a link and shows its full URL **once**, with a copy
  button and the note that it can't be shown again.
- **`/sites/links`:** every link with label, site, created date and status
  (active / revoked / site removed), and a Revoke button on active ones.
  Linked from the overview header.
- Share URLs are built from `SEO_PUBLIC_BASE_URL` (`https://clients.deimos.agency`).

## Cloudflare Tunnel

- **Testing:** a quick tunnel (`cloudflared tunnel --url …`, run from the
  `cloudflare/cloudflared` image) gives a temporary `trycloudflare.com` URL with
  no account, to open a real link on a phone before the hostname exists.
- **Production:** a remotely-managed named tunnel in Aleksandar's Cloudflare
  account, public hostname `clients.deimos.agency` → `http://seo-cockpit-dashboard:3000`
  (the compose network name, so the tunnel never touches the LAN port). Created
  through the Cloudflare MCP server once Aleksandar approves its OAuth in the
  browser. The tunnel's run token goes into `~/server/.env` as
  `SEO_TUNNEL_TOKEN`; it is never printed or pasted in chat.
- **Compose:** a `seo-cockpit-tunnel` service, image `cloudflare/cloudflared`
  pinned to a release, `command: tunnel --no-autoupdate run`,
  `TUNNEL_TOKEN: ${SEO_TUNNEL_TOKEN:?…}`, `restart: unless-stopped`, no ports.
  The dashboard gets `SEO_INTERNAL_HOSTS`, `SEO_PUBLIC_BASE_URL` and
  `SEO_SHARE_LINKS_PATH`. `DEPLOY.md` gains the steps.

## Testing — isolation is the feature, so assert the negatives

**Proxy:**
- Public host: `/`, `/site/optika-cajs`, `/sites/add`, `/sites/links`,
  `/site/optika-cajs/report/pdf` → 404; `/share/<anything>` GET → passes;
  `/share/x` POST → 404; GET `/share/x` with `Next-Action` → 404; logo GET →
  passes; unknown host → treated as public.
- Internal host: Basic auth exactly as today (existing tests unchanged); POST
  to `/share/x` from an internal host → still 404.
- Loopback is internal; `SEO_INTERNAL_HOSTS` unset → every host internal.
- Share responses carry `Referrer-Policy: no-referrer` and
  `X-Robots-Tag: noindex, nofollow`.

**Admin guard:** each admin action rejects a request from a public host, and
one without valid credentials when auth is on; accepts an internal request
with valid credentials.

**Store:** mint returns a raw token once and stores only its hash; resolve
accepts the raw token and rejects unknown, garbage, revoked, and
retired-site tokens; revoke sets `revoked_at`; a malformed file is refused,
not overwritten; `.bak` kept.

**Pages:** `/share/<valid>` renders that site's report in its language; its
HTML contains no `href` to `/`, `/site/`, `/sites/` or another site's data;
`/share/<valid>/live` renders the dashboard with the client header and the
same absence of admin links; invalid / revoked → 404; noindex metadata
present.

**Real output:** the full flow through a quick tunnel from a phone: open the
link, switch SR / EN, download the PDF, open Live data; confirm `/` and
`/site/…` on the tunnel host are 404 and a revoked link stops working.
Then the same on `clients.deimos.agency` after deploy.

## Out of scope

- Client accounts, logins and sessions (a later option; it would swap the
  token for an identity and reuse the store and scoping).
- Expiry enforcement (links never expire, by decision 3).
- Rate limiting on `/share/*` (a 256-bit token can't be guessed; revisit only
  if abuse appears).
- Translating the live dashboard (always English, by decision).
- Any collector change, and any change to the `seo.db` mount.
