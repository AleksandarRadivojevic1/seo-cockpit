# seo-cockpit

An internal SEO command center for tracking a portfolio of sites over time.

It takes a daily snapshot of your **Google Search Console** and **Core Web Vitals**
data, keeps the history in SQLite, and surfaces the opportunities that actually
move the needle. The two it cares about most are **striking-distance keywords**
(the page-2, almost-page-1 queries where a little work pays off fastest) and
**rising queries**. The point is to see how every site is doing at a glance and
turn what you find into concrete recommendations.

It's built to run on a home server (a Raspberry Pi 5, arm64) behind LAN and
WireGuard. Local-first and portable, and not exposed to the internet by default.

## How it works

Two separate processes share a single SQLite file, and each one has exactly one job.

```
 Collector (Python)          seo.db (SQLite)          Dashboard (Next.js)
   GSC + CWV, daily    --writes-->  timeseries  --reads-->  overview + per-site
   idempotent upserts             snapshots               opportunity views
   (only process that                                     read-only
    touches Google APIs)
```

The **collector** is small, boring Python, and it's the only thing that ever
touches the Google APIs or the service-account key. On its first run it backfills
about 90 days so the trends are useful right away, then on every run after that it
re-fetches a trailing window to absorb GSC's 2-3 day data lag. Every write is an
idempotent upsert, so re-running a date never duplicates rows.

The **dashboard** is a pure read-only Next.js app. It can't corrupt history and you
can rebuild or restart it whenever you want. All the trend and opportunity analysis
happens at read time in the TypeScript layer, not in the database.

## The trends engine

This is the core of the tool. It compares a recent 28-day window against the prior
28 days (offset for the data lag) and works out, per query:

| Signal | What it means |
|---|---|
| Emerging | Showing up now, absent before |
| Rising | Impressions up past a noise-filtered threshold |
| Climbing | Average position improved by roughly 3 spots or more |
| Declining | Impressions down or position slipping, a retention signal |
| Striking distance | Position around 8 to 20 with real impressions and low CTR, the highest-ROI work |
| Brand vs non-brand | Split by brand token, since non-brand growth is the truer measure of SEO progress |

Tables are capped by a transparent opportunity score
(`impressions x gap-to-page-1 x (1 - ctr)`), with impression floors to keep the
noise out.

## Dashboard views

**Portfolio overview.** One card per site with a 28-day sparkline and delta,
average position, a CWV badge, the striking-distance count, and a freshness
indicator so you know how current the data is.

**Per-site view.** Trend charts with a brand/non-brand toggle, the
striking-distance table, the rising, emerging, and declining lists, top pages, and
a Core Web Vitals panel.

**Proposal mode.** A print-friendly findings page with a "copy findings as
Markdown" button, so the results drop straight into a client proposal.

## Tech stack

- **Collector:** Python 3, `google-api-python-client`, APScheduler
- **Storage:** SQLite (swappable for Postgres later without rewriting the app)
- **Dashboard:** Next.js 16 (App Router), TypeScript, Tailwind, `better-sqlite3`
- **Deploy:** Docker Compose, two arm64 services

## Configuration

Sites live in `collector/sites.yaml`, one entry each with its GSC property, display
name, and brand token. Onboarding a new site is two steps: share its GSC property
with the service account, then add a line to the config.

The service-account key and the SQLite database are never committed. See
`.gitignore`.

## Status and roadmap

**Phase 1 (current).** Daily GSC and CWV collection, the trends engine, and the
dashboard views above, all on free data sources.

**Phase 2 (later).** Market-demand trends via Google Trends or DataForSEO to
surface the rising demand you're *not* capturing yet, plus branded PDF report
export and push alerts.

**Phase 3 (optional).** Authentication and per-client login views.

## License

[MIT](LICENSE), Aleksandar Radivojevic
