# Cannibalization Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface, on the internal dashboard, the queries where a site has multiple competing pages — which page should win and how many impressions are at stake.

**Architecture:** The collector fetches a rolling 28-day query×page breakdown from GSC and stores it as a per-site snapshot (wiped and rewritten each run). The dashboard reads that snapshot and applies the detection thresholds at render time, following the existing `lib/db.ts` (raw reads) + `lib/analysis/*` (pure view-model builders) + component split. Detection is dashboard-side so thresholds tune without a re-collect.

**Tech Stack:** Python 3 / sqlite3 / apscheduler / google-api-python-client (collector); Next.js / TypeScript / better-sqlite3 / vitest (dashboard).

**Spec:** `docs/superpowers/specs/2026-09-15-cannibalization-detection-design.md`

## Global Constraints

- Detection thresholds, verbatim: `MIN_IMPRESSIONS = 10`, `RUNNER_UP_SHARE = 0.20`. A query is cannibalized when ≥2 pages each have impressions ≥ `MIN_IMPRESSIONS` AND the 2nd-highest-impression qualifying page's impressions ≥ `RUNNER_UP_SHARE` × the highest.
- Canonical page = most clicks; tie broken by best (lowest) average position. Competitors = the other qualifying pages. Ranked by `impressionsAtStake` (sum of competitors' impressions) descending.
- Snapshot window = last 28 days: `window_end = end` (the run's resolved end date), `window_start = end - 27 days`.
- Snapshot has **replace** semantics: each run wipes the site's rows and inserts the current window. Empty rows = a real "measured, nothing to show" state.
- `null`/not-collected vs `[]`/measured-zero must stay distinct all the way to the component (recurring project lesson).
- Snapshot fetch/write failure is isolated per site with its own nested try/except (the CWV pattern) — it must never mark an otherwise-successful GSC run as failed, nor abort other sites.
- Surface: dashboard only (`/site/[slug]`). Not the client report/PDF.
- UI copy is plain and professional — no emoji.
- Commits: plain imperative subject, no conventional-commit prefix, no attribution trailers. Feature branch `feature/cannibalization-detection` off `main`; fast-forward merge when done.

---

## Task 1: Snapshot table + replace writer (collector)

**Files:**
- Modify: `collector/seocockpit/db.py` (add table to `_SCHEMA`; add `replace_query_page_snapshot`)
- Test: `collector/tests/test_db.py`

**Interfaces:**
- Produces: table `query_page_snapshot(site, query, page, clicks, impressions, ctr, position, window_start, window_end, captured_at)` PK `(site, query, page)`; `replace_query_page_snapshot(conn, site, rows, *, window_start, window_end, captured_at) -> None` where each `row` is a mapping with keys `site, query, page, clicks, impressions, ctr, position`.

- [ ] **Step 1: Write the failing tests**

```python
# collector/tests/test_db.py
from seocockpit import db as dbmod

def _qps_rows(conn, site):
    return conn.execute(
        "SELECT query, page, impressions FROM query_page_snapshot "
        "WHERE site=? ORDER BY query, page", (site,)
    ).fetchall()

def test_replace_query_page_snapshot_wipes_then_inserts(tmp_path):
    conn = dbmod.init_db(tmp_path / "t.db")
    meta = dict(window_start="2026-08-18", window_end="2026-09-14", captured_at="2026-09-15T00:00:00")
    dbmod.replace_query_page_snapshot(conn, "sc-domain:x", [
        {"site": "sc-domain:x", "query": "q", "page": "p1", "clicks": 1, "impressions": 50, "ctr": 0.1, "position": 3.0},
        {"site": "sc-domain:x", "query": "q", "page": "p2", "clicks": 0, "impressions": 20, "ctr": 0.0, "position": 8.0},
    ], **meta)
    # A second call for the same site replaces, not appends.
    dbmod.replace_query_page_snapshot(conn, "sc-domain:x", [
        {"site": "sc-domain:x", "query": "q", "page": "p1", "clicks": 2, "impressions": 60, "ctr": 0.1, "position": 2.0},
    ], **meta)
    assert _qps_rows(conn, "sc-domain:x") == [("q", "p1", 60)]

def test_replace_query_page_snapshot_isolates_other_sites(tmp_path):
    conn = dbmod.init_db(tmp_path / "t.db")
    meta = dict(window_start="2026-08-18", window_end="2026-09-14", captured_at="2026-09-15T00:00:00")
    dbmod.replace_query_page_snapshot(conn, "sc-domain:a", [
        {"site": "sc-domain:a", "query": "q", "page": "p", "clicks": 1, "impressions": 30, "ctr": 0.1, "position": 4.0},
    ], **meta)
    dbmod.replace_query_page_snapshot(conn, "sc-domain:b", [], **meta)  # empty clears b only
    assert len(_qps_rows(conn, "sc-domain:a")) == 1
    assert _qps_rows(conn, "sc-domain:b") == []

def test_init_db_is_idempotent_for_snapshot(tmp_path):
    p = tmp_path / "t.db"
    conn = dbmod.init_db(p)
    meta = dict(window_start="2026-08-18", window_end="2026-09-14", captured_at="2026-09-15T00:00:00")
    dbmod.replace_query_page_snapshot(conn, "sc-domain:x", [
        {"site": "sc-domain:x", "query": "q", "page": "p", "clicks": 1, "impressions": 30, "ctr": 0.1, "position": 4.0},
    ], **meta)
    conn.close()
    conn2 = dbmod.init_db(p)  # re-running migrations must not drop the row
    assert len(_qps_rows(conn2, "sc-domain:x")) == 1
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd collector && ./.venv/bin/python -m pytest tests/test_db.py -k query_page -v`
Expected: FAIL — `AttributeError: module 'seocockpit.db' has no attribute 'replace_query_page_snapshot'` (and no such table).

- [ ] **Step 3: Add the table to `_SCHEMA`**

Inside the `_SCHEMA` string in `collector/seocockpit/db.py`, alongside the other `CREATE TABLE IF NOT EXISTS` blocks (before the `CREATE INDEX` lines):

```sql
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

- [ ] **Step 4: Add the replace writer**

Alongside the other `upsert_*` writers in `db.py`:

```python
def replace_query_page_snapshot(
    conn: sqlite3.Connection,
    site: str,
    rows: Iterable[Mapping],
    *,
    window_start: str,
    window_end: str,
    captured_at: str,
) -> None:
    """Replace the site's rolling query x page snapshot in one transaction.

    Snapshot semantics: every call wipes the site's prior rows and inserts the
    current window, so the table never grows over time. An empty ``rows``
    leaves the site with no snapshot rows -- a real "measured, nothing to
    show" state, distinct from "never collected". Each row is stamped with the
    window and capture time here so callers pass only site/query/page metrics.
    """
    stamped = [
        {
            **row,
            "window_start": window_start,
            "window_end": window_end,
            "captured_at": captured_at,
        }
        for row in rows
    ]
    with conn:  # atomic: delete + insert commit together, rollback on error
        conn.execute("DELETE FROM query_page_snapshot WHERE site = ?", (site,))
        conn.executemany(
            """
            INSERT INTO query_page_snapshot
                (site, query, page, clicks, impressions, ctr, position,
                 window_start, window_end, captured_at)
            VALUES
                (:site, :query, :page, :clicks, :impressions, :ctr, :position,
                 :window_start, :window_end, :captured_at)
            """,
            stamped,
        )
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd collector && ./.venv/bin/python -m pytest tests/test_db.py -v`
Expected: PASS (all db tests, including the three new ones).

- [ ] **Step 6: Commit**

```bash
git add collector/seocockpit/db.py collector/tests/test_db.py
git commit -m "Add query_page_snapshot table and replace writer"
```

---

## Task 2: query×page fetch (collector)

**Files:**
- Modify: `collector/seocockpit/gsc.py` (add `fetch_query_page`)
- Test: `collector/tests/test_gsc.py`

**Interfaces:**
- Consumes: `_query_all_rows(service, property, body)`, `_ROW_LIMIT` (module-private, same file).
- Produces: `fetch_query_page(service, property, start, end) -> list[dict]`, each dict `{site, query, page, clicks, impressions, ctr, position}` (no `date` key).

- [ ] **Step 1: Write the failing test**

```python
# collector/tests/test_gsc.py
from seocockpit import gsc

class _FakeSA:
    def __init__(self, pages):
        self._pages = pages
        self.bodies = []
    def query(self, siteUrl, body):
        self.bodies.append(body)
        page = self._pages.pop(0) if self._pages else {"rows": []}
        return _FakeReq(page)

class _FakeReq:
    def __init__(self, resp): self._resp = resp
    def execute(self): return self._resp

class _FakeService:
    def __init__(self, pages): self._sa = _FakeSA(pages)
    def searchanalytics(self): return self._sa

def test_fetch_query_page_returns_pairs_without_date():
    service = _FakeService([
        {"rows": [
            {"keys": ["kontaktna sociva", "https://x/a"], "clicks": 5, "impressions": 50, "ctr": 0.1, "position": 3.0},
            {"keys": ["kontaktna sociva", "https://x/b"], "clicks": 0, "impressions": 20, "ctr": 0.0, "position": 8.0},
        ]},
    ])
    rows = gsc.fetch_query_page(service, "sc-domain:x", "2026-08-18", "2026-09-14")
    assert rows == [
        {"site": "sc-domain:x", "query": "kontaktna sociva", "page": "https://x/a", "clicks": 5, "impressions": 50, "ctr": 0.1, "position": 3.0},
        {"site": "sc-domain:x", "query": "kontaktna sociva", "page": "https://x/b", "clicks": 0, "impressions": 20, "ctr": 0.0, "position": 8.0},
    ]
    # single query+page dimension set, no date
    assert service._sa.bodies[0]["dimensions"] == ["query", "page"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd collector && ./.venv/bin/python -m pytest tests/test_gsc.py -k query_page -v`
Expected: FAIL — `AttributeError: module 'seocockpit.gsc' has no attribute 'fetch_query_page'`.

- [ ] **Step 3: Implement `fetch_query_page`**

```python
def fetch_query_page(service, property: str, start: str, end: str) -> list[dict]:
    """Fetch the query x page breakdown for ``property`` over [start, end].

    Unlike ``fetch_search_analytics``'s per-day breakdowns, this is a single
    aggregate over the whole window (no ``date`` dimension) -- the input to
    cannibalization detection. Paginates like the others via
    ``_query_all_rows``. Returns DB-ready dicts with no ``date`` key.
    """
    body = {
        "startDate": start,
        "endDate": end,
        "rowLimit": _ROW_LIMIT,
        "dataState": "final",
        "dimensions": ["query", "page"],
    }
    rows = []
    for row in _query_all_rows(service, property, body):
        query, page = row["keys"]
        rows.append(
            {
                "site": property,
                "query": query,
                "page": page,
                "clicks": row.get("clicks", 0),
                "impressions": row.get("impressions", 0),
                "ctr": row.get("ctr", 0.0),
                "position": row.get("position", 0.0),
            }
        )
    return rows
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd collector && ./.venv/bin/python -m pytest tests/test_gsc.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add collector/seocockpit/gsc.py collector/tests/test_gsc.py
git commit -m "Fetch query x page breakdown from GSC"
```

---

## Task 3: Wire the snapshot into collection (collector)

**Files:**
- Modify: `collector/seocockpit/collect.py` (`collect_once`: add injectable `fetch_query_page_fn`; per-site nested try after the country upsert)
- Test: `collector/tests/test_collect.py`

**Interfaces:**
- Consumes: `gsc.fetch_query_page` (Task 2), `db.replace_query_page_snapshot` (Task 1).
- Produces: `collect_once(..., fetch_query_page_fn: Callable | None = None)` — defaults to `gsc_module.fetch_query_page`; signature `(service, property, start, end) -> list[dict]`.

- [ ] **Step 1: Write the failing tests**

```python
# collector/tests/test_collect.py  (follow this file's existing fixture style
# for config/conn/fake fetchers; the two assertions below are the new behavior)
def test_collect_writes_query_page_snapshot(collect_env):
    # collect_env: the file's existing helper giving (config, conn) with one site.
    config, conn = collect_env
    captured = {}
    def fake_qp(service, property, start, end):
        captured["window"] = (start, end)
        return [{"site": property, "query": "q", "page": "p1", "clicks": 1, "impressions": 40, "ctr": 0.1, "position": 3.0}]
    collect_once(
        config, "incremental", conn=conn, service=object(),
        fetch_analytics=lambda *a: _empty_search_analytics(),
        fetch_cwv_fn=lambda url: None,
        fetch_query_page_fn=fake_qp,
        today=datetime.date(2026, 9, 15),
    )
    rows = conn.execute("SELECT query, page, impressions FROM query_page_snapshot").fetchall()
    assert rows == [("q", "p1", 40)]
    # 28-day window: window_end is the run's end date, window_start 27 days back.
    from datetime import date, timedelta
    start, end = captured["window"]
    assert date.fromisoformat(end) - date.fromisoformat(start) == timedelta(days=27)

def test_query_page_failure_does_not_fail_the_site(collect_env):
    config, conn = collect_env
    def boom(*a): raise RuntimeError("gsc 500")
    results = collect_once(
        config, "incremental", conn=conn, service=object(),
        fetch_analytics=lambda *a: _empty_search_analytics(),
        fetch_cwv_fn=lambda url: None,
        fetch_query_page_fn=boom,
        today=datetime.date(2026, 9, 15),
    )
    assert results[0]["status"] == "success"  # snapshot failure is isolated
```

> Implementer note: `_empty_search_analytics()` and `collect_env` mirror the existing helpers/fixtures in `test_collect.py`. If the file builds `SearchAnalytics` inline, reuse that; the new assertions are the snapshot write and the isolation guarantee.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd collector && ./.venv/bin/python -m pytest tests/test_collect.py -k query_page -v`
Expected: FAIL — `collect_once() got an unexpected keyword argument 'fetch_query_page_fn'`.

- [ ] **Step 3: Add the injectable fetcher default**

In `collect_once`, alongside the other `if fetch_* is None:` defaulting (near lines 139-142):

```python
    if fetch_query_page_fn is None:
        fetch_query_page_fn = gsc_module.fetch_query_page
```

And add the parameter to the signature (keyword-only group, after `fetch_cwv_fn`):

```python
    fetch_query_page_fn: Callable | None = None,
```

- [ ] **Step 4: Add the per-site snapshot block**

In the per-site loop, immediately after `db.upsert_country_daily(conn, sa.by_country)` and its `rows_written` accounting, before the CWV block (so both isolated blocks sit together):

```python
            # Rolling query x page snapshot for cannibalization detection.
            # Its own try/except (like CWV below): a snapshot failure must not
            # condemn the GSC rows already committed for this site.
            qp_error: str | None = None
            try:
                snap_end = end
                snap_start = (
                    datetime.date.fromisoformat(end) - datetime.timedelta(days=27)
                ).isoformat()
                qp_rows = fetch_query_page_fn(service, site.property, snap_start, snap_end)
                db.replace_query_page_snapshot(
                    conn,
                    site.property,
                    qp_rows,
                    window_start=snap_start,
                    window_end=snap_end,
                    captured_at=captured_at.isoformat(),
                )
                rows_written += len(qp_rows)
            except Exception as e:  # noqa: BLE001 - isolate snapshot from GSC
                qp_error = f"query_page: {e}"
                logger.warning(
                    "query x page snapshot failed for %s (GSC data still collected): %s",
                    site.property,
                    e,
                )
```

Then fold `qp_error` into the run's non-fatal note. Where the code currently calls `db.finish_run(conn, run_id, "success", cwv_error, rows_written)` and appends `"error": cwv_error`, combine both:

```python
            run_note = "; ".join(n for n in (cwv_error, qp_error) if n) or None
            db.finish_run(conn, run_id, "success", run_note, rows_written)
            results.append(
                {
                    "site": site.property,
                    "status": "success",
                    "rows": rows_written,
                    "error": run_note,
                    "cwv_error": cwv_error,
                }
            )
```

> If an existing test asserts the exact `error` value on a CWV-only failure, `run_note` equals `cwv_error` when `qp_error` is None, so it stays green.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd collector && ./.venv/bin/python -m pytest tests/test_collect.py -v`
Expected: PASS (new tests and existing ones).

- [ ] **Step 6: Run the whole collector suite**

Run: `cd collector && ./.venv/bin/python -m pytest -q`
Expected: PASS (no regressions).

- [ ] **Step 7: Commit**

```bash
git add collector/seocockpit/collect.py collector/tests/test_collect.py
git commit -m "Collect the query x page snapshot each run, isolated per site"
```

---

## Task 4: Detection logic (dashboard, pure)

**Files:**
- Create: `app/lib/analysis/cannibalization.ts`
- Test: `app/tests/cannibalization.test.ts`

**Interfaces:**
- Consumes: `QueryPageRow` from `app/lib/db.ts` (Task 5 defines it; for this task, a row is `{ query: string; page: string; clicks: number; impressions: number; ctr: number; position: number }`).
- Produces: `MIN_IMPRESSIONS`, `RUNNER_UP_SHARE`; types `CompetingPage`, `CannibalizedQuery`, `CannibalizationBreakdown`; `detectCannibalization(rows) -> CannibalizedQuery[]`; `buildCannibalization(rows) -> CannibalizationBreakdown`.

- [ ] **Step 1: Write the failing tests**

```typescript
// app/tests/cannibalization.test.ts
import { describe, it, expect } from "vitest";
import {
  detectCannibalization,
  buildCannibalization,
} from "../lib/analysis/cannibalization";

const row = (query: string, page: string, clicks: number, impressions: number, position: number) => ({
  query, page, clicks, impressions, ctr: 0, position,
});

describe("detectCannibalization", () => {
  it("flags a query where two pages each clear the impression floor and the runner-up holds 20% share", () => {
    const out = detectCannibalization([
      row("q", "p1", 10, 100, 3),
      row("q", "p2", 1, 20, 8), // 20% of 100 -> included
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].canonical.page).toBe("p1"); // most clicks
    expect(out[0].competitors.map((c) => c.page)).toEqual(["p2"]);
    expect(out[0].impressionsAtStake).toBe(20);
  });

  it("excludes a page below the impression floor (only one qualifies)", () => {
    expect(detectCannibalization([row("q", "p1", 5, 100, 3), row("q", "p2", 0, 9, 8)])).toEqual([]);
  });

  it("excludes when the runner-up is below the 20% share (19 of 100)", () => {
    expect(detectCannibalization([row("q", "p1", 5, 100, 3), row("q", "p2", 0, 19, 8)])).toEqual([]);
  });

  it("breaks a clicks tie by best (lowest) position when choosing canonical", () => {
    const out = detectCannibalization([row("q", "p1", 3, 50, 9), row("q", "p2", 3, 50, 2)]);
    expect(out[0].canonical.page).toBe("p2");
  });

  it("ranks queries by impressions at stake, descending", () => {
    const out = detectCannibalization([
      row("small", "a", 5, 100, 3), row("small", "b", 1, 30, 8),
      row("big", "c", 5, 100, 3), row("big", "d", 1, 90, 8),
    ]);
    expect(out.map((q) => q.query)).toEqual(["big", "small"]);
  });

  it("does not flag a single-page query", () => {
    expect(detectCannibalization([row("q", "p1", 5, 100, 3)])).toEqual([]);
  });
});

describe("buildCannibalization", () => {
  it("reports notCollected when there are no snapshot rows", () => {
    expect(buildCannibalization([])).toEqual({ notCollected: true, items: [] });
  });
  it("reports collected-but-empty when rows exist but none cannibalize", () => {
    expect(buildCannibalization([row("q", "p1", 5, 100, 3)])).toEqual({ notCollected: false, items: [] });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd app && npm test -- cannibalization`
Expected: FAIL — cannot resolve `../lib/analysis/cannibalization`.

- [ ] **Step 3: Implement the module**

```typescript
// app/lib/analysis/cannibalization.ts
import type { QueryPageRow } from "../db";

/** A query is cannibalized when >=2 pages each clear MIN_IMPRESSIONS and the
 *  runner-up (2nd by impressions) holds at least RUNNER_UP_SHARE of the top. */
export const MIN_IMPRESSIONS = 10;
export const RUNNER_UP_SHARE = 0.2;

export interface CompetingPage {
  page: string;
  clicks: number;
  impressions: number;
  position: number;
}

export interface CannibalizedQuery {
  query: string;
  canonical: CompetingPage; // the page that should win (most clicks)
  competitors: CompetingPage[]; // the pages splitting the query
  impressionsAtStake: number; // sum of competitors' impressions
}

export interface CannibalizationBreakdown {
  notCollected: boolean;
  items: CannibalizedQuery[];
}

export function detectCannibalization(rows: QueryPageRow[]): CannibalizedQuery[] {
  const byQuery = new Map<string, CompetingPage[]>();
  for (const r of rows) {
    const list = byQuery.get(r.query) ?? [];
    list.push({ page: r.page, clicks: r.clicks, impressions: r.impressions, position: r.position });
    byQuery.set(r.query, list);
  }

  const out: CannibalizedQuery[] = [];
  for (const [query, pages] of byQuery) {
    const qualifying = pages.filter((p) => p.impressions >= MIN_IMPRESSIONS);
    if (qualifying.length < 2) continue;

    const byImpr = [...qualifying].sort((a, b) => b.impressions - a.impressions);
    if (byImpr[1].impressions < RUNNER_UP_SHARE * byImpr[0].impressions) continue;

    // canonical = most clicks; tie -> best (lowest) position
    const ranked = [...qualifying].sort((a, b) => b.clicks - a.clicks || a.position - b.position);
    const canonical = ranked[0];
    const competitors = ranked.slice(1);
    const impressionsAtStake = competitors.reduce((s, p) => s + p.impressions, 0);
    out.push({ query, canonical, competitors, impressionsAtStake });
  }

  return out.sort((a, b) => b.impressionsAtStake - a.impressionsAtStake);
}

export function buildCannibalization(rows: QueryPageRow[]): CannibalizationBreakdown {
  if (rows.length === 0) return { notCollected: true, items: [] };
  return { notCollected: false, items: detectCannibalization(rows) };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && npm test -- cannibalization`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/analysis/cannibalization.ts app/tests/cannibalization.test.ts
git commit -m "Add cannibalization detection logic"
```

---

## Task 5: Snapshot read (dashboard)

**Files:**
- Modify: `app/lib/db.ts` (add `QueryPageRow` interface + `queryPageSnapshot`)
- Test: `app/tests/db.test.ts`

**Interfaces:**
- Consumes: `getDb()`, the `Database.Database` prepare/all pattern already in the file.
- Produces: `interface QueryPageRow { query: string; page: string; clicks: number; impressions: number; ctr: number; position: number }`; `queryPageSnapshot(site, db?) -> QueryPageRow[]`.

- [ ] **Step 1: Write the failing test**

```typescript
// app/tests/db.test.ts  (follow this file's existing temp-DB setup: it creates
// a better-sqlite3 database, applies the collector schema, inserts rows, then
// calls the db.ts reader with that connection)
import Database from "better-sqlite3";
import { queryPageSnapshot } from "../lib/db";

it("queryPageSnapshot returns the site's rows and is empty for an uncollected site", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE query_page_snapshot (
    site TEXT, query TEXT, page TEXT, clicks INTEGER, impressions INTEGER,
    ctr REAL, position REAL, window_start TEXT, window_end TEXT, captured_at TEXT,
    PRIMARY KEY (site, query, page));`);
  db.prepare(`INSERT INTO query_page_snapshot VALUES
    ('sc-domain:x','q','p1',1,40,0.1,3.0,'2026-08-18','2026-09-14','2026-09-15T00:00:00')`).run();

  expect(queryPageSnapshot("sc-domain:x", db)).toEqual([
    { query: "q", page: "p1", clicks: 1, impressions: 40, ctr: 0.1, position: 3.0 },
  ]);
  expect(queryPageSnapshot("sc-domain:none", db)).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npm test -- db.test`
Expected: FAIL — `queryPageSnapshot` is not exported.

- [ ] **Step 3: Implement the reader**

Add near the other readers in `app/lib/db.ts`:

```typescript
export interface QueryPageRow {
  query: string;
  page: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/** Rows of the collector's rolling query x page snapshot for one site.
 *  Empty array means the collector has not written a snapshot for this site
 *  yet -- the caller treats that as "not collected", distinct from a
 *  collected snapshot that yields no cannibalized queries. */
export function queryPageSnapshot(
  site: string,
  db: Database.Database = getDb(),
): QueryPageRow[] {
  return db
    .prepare<[string], QueryPageRow>(
      `SELECT query, page, clicks, impressions, ctr, position
         FROM query_page_snapshot
        WHERE site = ?
        ORDER BY impressions DESC`,
    )
    .all(site);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npm test -- db.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/db.ts app/tests/db.test.ts
git commit -m "Read the query x page snapshot for a site"
```

---

## Task 6: Cannibalization section (dashboard)

**Files:**
- Create: `app/components/Cannibalization.tsx`
- Modify: `app/app/site/[slug]/page.tsx` (build the breakdown, render the section)
- Test: `app/tests/cannibalization-panel.test.tsx`

**Interfaces:**
- Consumes: `CannibalizationBreakdown` (Task 4); `queryPageSnapshot`, `buildCannibalization`.
- Produces: default-exported `Cannibalization({ breakdown }: { breakdown: CannibalizationBreakdown })`.

- [ ] **Step 1: Write the failing test**

```tsx
// app/tests/cannibalization-panel.test.tsx  (mirror the render style of the
// existing *.test.tsx panels, e.g. line-chart.test.tsx)
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import Cannibalization from "../components/Cannibalization";

describe("Cannibalization", () => {
  it("shows a not-collected state when the snapshot is absent", () => {
    render(<Cannibalization breakdown={{ notCollected: true, items: [] }} />);
    expect(screen.getByText(/not collected/i)).toBeTruthy();
  });

  it("shows a clean measured-zero state when nothing cannibalizes", () => {
    render(<Cannibalization breakdown={{ notCollected: false, items: [] }} />);
    expect(screen.getByText(/no cannibalized queries/i)).toBeTruthy();
  });

  it("lists a cannibalized query with its canonical page and impressions at stake", () => {
    render(
      <Cannibalization
        breakdown={{
          notCollected: false,
          items: [
            {
              query: "kontaktna sociva",
              canonical: { page: "https://x/a", clicks: 5, impressions: 100, position: 3 },
              competitors: [{ page: "https://x/b", clicks: 0, impressions: 40, position: 8 }],
              impressionsAtStake: 40,
            },
          ],
        }}
      />,
    );
    expect(screen.getByText("kontaktna sociva")).toBeTruthy();
    expect(screen.getByText(/https:\/\/x\/a/)).toBeTruthy();
    expect(screen.getByText(/40/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npm test -- cannibalization-panel`
Expected: FAIL — cannot resolve `../components/Cannibalization`.

- [ ] **Step 3: Implement the component**

```tsx
// app/components/Cannibalization.tsx
import EmptyState from "./EmptyState";
import type { CannibalizationBreakdown } from "../lib/analysis/cannibalization";

/**
 * Queries where this site has more than one page competing, splitting clicks
 * and impressions. Canonical = the page that should win (most clicks); the
 * others are candidates to consolidate or redirect. Ranked by impressions at
 * stake. Sourced from the rolling 28-day query x page snapshot.
 */
export default function Cannibalization({
  breakdown,
}: {
  breakdown: CannibalizationBreakdown;
}) {
  if (breakdown.notCollected) {
    return <EmptyState title="Cannibalization not collected yet" />;
  }
  if (breakdown.items.length === 0) {
    return <EmptyState title="No cannibalized queries" />;
  }
  return (
    <section className="space-y-4">
      {breakdown.items.map((item) => (
        <div key={item.query} className="rounded-lg border p-4">
          <div className="flex items-baseline justify-between gap-4">
            <h3 className="font-medium">{item.query}</h3>
            <span className="text-sm text-muted-foreground">
              {item.impressionsAtStake} impressions at stake
            </span>
          </div>
          <p className="mt-2 text-sm">
            <span className="text-muted-foreground">Should win: </span>
            <span className="font-mono break-all">{item.canonical.page}</span>{" "}
            ({item.canonical.clicks} clicks, pos {item.canonical.position.toFixed(1)})
          </p>
          <ul className="mt-1 space-y-1 text-sm text-muted-foreground">
            {item.competitors.map((c) => (
              <li key={c.page} className="break-all font-mono">
                {c.page} — {c.impressions} impr, pos {c.position.toFixed(1)}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
```

- [ ] **Step 4: Wire it into the site page**

In `app/app/site/[slug]/page.tsx`: add imports (with the other component and `lib/db` imports)

```typescript
import Cannibalization from "../../../components/Cannibalization";
import { buildCannibalization } from "../../../lib/analysis/cannibalization";
```

add `queryPageSnapshot` to the existing `from "../../../lib/db"` import group, build the breakdown near where `demand`/`serp` are built (around line 164):

```typescript
  const cannibalization = buildCannibalization(queryPageSnapshot(config.property));
```

and render the section near `<DemandGaps />` / `<SerpCompetitors />` (around lines 356-367), matching the surrounding heading/section markup:

```tsx
        <Cannibalization breakdown={cannibalization} />
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd app && npm test -- cannibalization-panel`
Expected: PASS.

- [ ] **Step 6: Run the whole app suite**

Run: `cd app && npm test`
Expected: PASS (no regressions; `site-page.test.ts` still green).

- [ ] **Step 7: Commit**

```bash
git add app/components/Cannibalization.tsx app/app/site/[slug]/page.tsx app/tests/cannibalization-panel.test.tsx
git commit -m "Show the cannibalization section on the site dashboard"
```

---

## Finish: merge + deploy

- [ ] Fast-forward merge `feature/cannibalization-detection` into `main`, delete the branch, push.
- [ ] Deploy to the Pi: pull `src`, rebuild **both** images (`docker compose build seo-cockpit-collector seo-cockpit-dashboard`, dashboard heap-capped as in prior deploys), `up -d` both.
- [ ] Verify: trigger a collection (Run collection now), confirm `query_page_snapshot` gets rows, and the Cannibalization section renders on a site page (young sites like deimos may show "No cannibalized queries" — the measured-zero state, which is correct).

---

## Self-Review

**Spec coverage:**
- Rolling 28-day snapshot storage → Task 1 (table + replace writer), Task 3 (window `[end-27, end]`, replace each run). ✓
- New GSC query×page fetch → Task 2. ✓
- Per-site isolation (CWV pattern) → Task 3. ✓
- Detection thresholds / canonical / ranking → Task 4 (constants + edges tested). ✓
- Dashboard-side detection, tunable → Task 4 (pure module), Task 5 (raw read). ✓
- null vs [] distinction → Task 4 `buildCannibalization`, Task 5 empty read, Task 6 two empty states. ✓
- Dashboard-only surface → Task 6 (site page only; report untouched). ✓
- No emoji → Task 6 copy is plain. ✓

**Placeholder scan:** No TBD/TODO. The one soft reference — `collect_env` / `_empty_search_analytics` in Task 3 — is explicitly tied to `test_collect.py`'s existing fixtures with an implementer note, not an invented API.

**Type consistency:** `QueryPageRow` defined in Task 5, consumed by Task 4's `detectCannibalization`; `CannibalizationBreakdown`/`CannibalizedQuery`/`CompetingPage` defined in Task 4, consumed by Task 6. `replace_query_page_snapshot(conn, site, rows, *, window_start, window_end, captured_at)` defined in Task 1, called with those exact keywords in Task 3. `fetch_query_page(service, property, start, end)` defined in Task 2, injected as `fetch_query_page_fn` in Task 3. Consistent.
