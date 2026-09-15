# Cannibalization Detection — Design

Date: 2026-09-15
Status: Approved for planning
Roadmap origin: Deimos Agency handoff (Gemini chat), section 4A "Cannibalization Detection"

## Problem

Keyword cannibalization is when two or more URLs on the same domain compete
for the same search query, splitting clicks and impressions and often
suppressing both. seo-cockpit cannot currently detect it: the collector
fetches GSC Search Analytics as four **independent** breakdowns — `date`,
`date+query`, `date+page`, `date+country` (`collector/seocockpit/gsc.py`
`fetch_search_analytics`) — and stores `query_daily` and `page_daily` as
separate marginal tables. Nothing records **which page ranked for which
query**, so "one query, multiple pages" is unanswerable from the current
schema.

## Goal

Surface, on the internal dashboard, the queries where a site has multiple
competing pages — showing which page should win and how many impressions are
at stake — so the agency has a concrete technical fix-it list.

## Decisions (settled during brainstorming)

1. **Storage: rolling 28-day snapshot**, not daily history. Cannibalization
   is a current-state diagnostic. One row per `(site, query, page)`, replaced
   wholesale each run. Keeps the cross-product table flat and bounded. Trend
   ("when did this start") is a deliberate v2, not built now.
2. **Detection bar (high-signal):** a query is cannibalized when, in the
   window, **≥2 pages** each have **impressions ≥ 10**, **and** the runner-up
   page's impressions are **≥ 20%** of the top page's impressions.
3. **Canonical page** = the page with the most clicks; tie broken by best
   (lowest) average position. All other qualifying pages are the
   "cannibalizing" pages.
4. **Ranking:** flagged queries sorted by `impressions_at_stake` (sum of
   non-canonical pages' impressions) descending.
5. **Detection runs dashboard-side**, not in the collector. The collector
   only ingests the raw snapshot; thresholds are applied at render time so
   they can be tuned without re-collecting.
6. **Surface: dashboard only** (`/site/[slug]`). Not in the client report /
   PDF for v1. Report inclusion is deferred to the "Action Plan" roadmap item.

## Non-goals (YAGNI)

- No daily history / trend of cannibalization.
- No client-report or PDF surface.
- No auto-canonical recommendation beyond "most clicks wins".
- No cross-site or cross-domain analysis.

## Architecture

Four units, each independently testable.

### 1. Collector — new snapshot fetch (`collector/seocockpit/gsc.py`)

Add a function separate from `fetch_search_analytics`, because the snapshot
window is fixed (last 28 days) and independent of the run's mode/date range:

```
fetch_query_page(service, property, start, end) -> list[dict]
```

- One paginated `searchanalytics().query()` call with
  `dimensions: ["query", "page"]`, `dataState: "final"`, `rowLimit`
  paginated to exhaustion (reuse `_query_all_rows`).
- Returns DB-ready dicts: `{site, query, page, clicks, impressions, ctr,
  position}`. No `date` key (it is an aggregate over the window).
- No top-N-per-day cap (there are no days); if a global cap is ever needed
  it can cap by impressions, but v1 keeps every returned row — GSC's own
  `rowLimit` pagination bounds it, and these sites are small.

### 2. Collector — orchestration (`collector/seocockpit/collect.py`)

Inside the existing per-site loop, **after** the main GSC upserts and their
`rows_written` accounting, add a **nested try/except that mirrors the CWV
block**: a snapshot failure must not condemn the GSC rows already committed
for that site, nor abort other sites.

- Window: `snap_start = end - 27 days`, `snap_end = end` (reuse the same
  `end` the incremental/backfill range resolves to, so it tracks GSC lag).
- Call `fetch_query_page`, then `db.replace_query_page_snapshot(conn,
  site.property, rows)`.
- On success, add the row count to `rows_written`. On failure, append to a
  non-fatal error note (same shape as `cwv_error`) and log a warning; the
  run's status stays `success` if GSC succeeded.

### 3. Collector — schema + writer (`collector/seocockpit/db.py`)

New table, created via the existing `CREATE TABLE IF NOT EXISTS` block and
covered by the idempotent migration harness (no UNIQUE-index migration
gymnastics — the PK is sufficient):

```
CREATE TABLE IF NOT EXISTS query_page_snapshot (
    site         TEXT NOT NULL,
    query        TEXT NOT NULL,
    page         TEXT NOT NULL,
    clicks       INTEGER,
    impressions  INTEGER,
    ctr          REAL,
    position     REAL,
    window_start TEXT NOT NULL,
    window_end   TEXT NOT NULL,
    captured_at  TEXT NOT NULL,
    PRIMARY KEY (site, query, page)
);
CREATE INDEX IF NOT EXISTS idx_qps_site_query
    ON query_page_snapshot (site, query);
```

Writer with **replace semantics** (this is what makes it a snapshot):

```
replace_query_page_snapshot(conn, site, rows) -> None
```

- Single transaction: `DELETE FROM query_page_snapshot WHERE site = ?`, then
  bulk-insert the new rows stamped with `window_start`, `window_end`,
  `captured_at`. If `rows` is empty, the site's snapshot is left empty (a
  real "measured no competition" state) — see the empty-vs-null note below.

### 4. Dashboard — query + detection (`app/lib/db.ts`)

```
getCannibalization(site): CannibalizedQuery[] | null
```

- Returns `null` when the site has **no `query_page_snapshot` rows at all**
  (not collected yet) — distinct from `[]` (collected, nothing cannibalized).
  This distinction is mandatory (see recurring design lesson: never render
  "not collected" and "measured zero" identically).
- Reads all snapshot rows for the site, groups by `query`, and applies the
  detection bar in a **pure helper** (`detectCannibalization(rows)`) that
  takes grouped rows and returns the flagged results — kept pure so the
  thresholds are unit-testable in isolation and tunable in one place.
- Each `CannibalizedQuery`: `{ query, canonical: {page, clicks, impressions,
  position}, competitors: [{page, clicks, impressions, position}],
  impressionsAtStake }`. Sorted by `impressionsAtStake` desc.
- Thresholds (`MIN_IMPRESSIONS = 10`, `RUNNER_UP_SHARE = 0.20`) live as named
  constants at the top of the helper.

### 5. Dashboard — section component (`app/components/Cannibalization.tsx`)

- Follows the `DemandGaps` / `SerpCompetitors` section pattern, rendered on
  `app/site/[slug]/page.tsx`.
- For each flagged query: the query text, the canonical URL marked
  "should win", the competing URL(s) with clicks / impressions / position,
  and impressions-at-stake.
- States:
  - `null` → "Not collected yet" (matches the other not-collected sections).
  - `[]` → "No cannibalized queries" (a clean, measured result).
  - non-empty → the ranked list.

## Data flow

```
GSC (query x page, last 28d)
  -> fetch_query_page                        [gsc.py]
  -> replace_query_page_snapshot (DELETE+INSERT per site)  [collect.py -> db.py]
  -> query_page_snapshot table
  -> getCannibalization -> detectCannibalization (thresholds)  [lib/db.ts]
  -> Cannibalization.tsx section              [/site/[slug]]
```

## Error handling

- Snapshot fetch/write failure is isolated per site via its own nested
  try/except (CWV pattern), reported as a non-fatal note, and never marks an
  otherwise-successful GSC run as failed.
- A 403 / permission error on the snapshot call behaves like any other
  per-site failure — logged, isolated, other sites unaffected.
- Empty snapshot (`rows == []`) is a valid state, written as zero rows;
  `getCannibalization` distinguishes it from "never collected".

## Testing (TDD)

Collector (`pytest`):
- `fetch_query_page` normalizes `query`/`page`/metrics correctly and omits
  any `date` key (mock the service, as existing GSC tests do).
- `replace_query_page_snapshot` **replaces** a site's prior rows (insert two,
  replace with one, assert only the new row remains) and leaves other sites'
  rows untouched.
- Migration is idempotent: running the schema/migration twice on an existing
  DB is a no-op and preserves rows.

Dashboard (`vitest`):
- `detectCannibalization` threshold edges: impressions exactly 10 included /
  9 excluded; runner-up at exactly 20% included / 19% excluded; single-page
  query excluded; canonical tie-break falls through clicks -> position;
  ranking order by impressions-at-stake.
- `getCannibalization` returns `null` for no rows, `[]` for rows-but-none-
  flagged, and the correct shape otherwise.

## Rollout

- Additive schema (new table, `CREATE TABLE IF NOT EXISTS`); no migration of
  existing tables, no backfill needed — the snapshot populates on the first
  collection run after deploy for every configured site.
- Deploy is the standard collector + dashboard rebuild on the Pi.
```
