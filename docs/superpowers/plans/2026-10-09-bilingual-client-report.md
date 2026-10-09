# Bilingual Client Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The client report and its PDF can be rendered in Serbian or English, chosen per site with a `?lang=` override and an on-page SR / EN switch.

**Architecture:** The collector carries a per-site `language` (`sr` default) from `sites.yaml` / `user-sites.json` into a new `sites.language` column. The dashboard reads it with `siteLanguage()`, resolves the request language with `resolveReportLanguage()`, and renders one `ReportDocument` component from `reportStrings(lang)` (`SR` or the new `EN`, same compiler-checked shape) and `reportFormat(lang)` (Serbian or US-English numbers, dates, plurals). The PDF route passes `lang` through to the chromium render and names the file in that language.

**Tech Stack:** Python 3.14 collector (pytest), Next.js 16 App Router dashboard (TypeScript, vitest, `renderToStaticMarkup`), SQLite, `Intl` (`sr-Latn-RS`, `en-US`).

**Spec:** `docs/superpowers/specs/2026-10-09-bilingual-client-report-design.md`

## Global Constraints

- Languages are exactly `sr` and `en`; the default is `sr` everywhere (collector, DB column default, dashboard fallbacks).
- `Intl` locales: Serbian `sr-Latn-RS`, English `en-US`. All date math stays UTC.
- Only the client report and its PDF are bilingual. The admin dashboard, the proposal page and proposal Markdown stay English and are not touched.
- Never translated: search queries, demand keywords, competitor domains, page URLs, `Aleksandar Radivojević, Deimos Agency`, `deimos.agency`, `CTR`.
- Existing tests keep passing unchanged. New behaviour gets new tests.
- The `?lang=` request parameter is strict (exactly `sr` or `en`, anything else → site default). Config files are hand-edited, so the collector forgives case and whitespace (`" EN "` → `en`) and logs anything else as `sr`, never raising.
- Commit messages: one plain imperative sentence, capitalized, no `feat:`-style prefix, **no attribution trailers** (no `Co-Authored-By`, no "Generated with").
- Work inline in this session (Aleksandar's standing preference for seo-cockpit); run the real commands and show their output.
- Scratch files for Tasks 6 and 8 live in one directory, set at the start of every shell command that uses it: `WORK=/tmp/claude-1000/-home-ar-Documents-GitHub-seo-cockpit/43a79ef2-95da-4f61-aad8-1c711ed1c2a9/scratchpad/bilingual` (this session's scratchpad; never the repo).

## Review Focus

1. **A site with no data, in English** — the English honesty sentences (`notCollected`, `measuredZero`) must render instead of the Serbian ones. Pinned in Task 6.
2. **A repeated or array `?lang=` (`?lang=en&lang=sr`)** — Next hands the page a `string[]`; it must fall back to the site default, not crash or pick one arbitrarily. Pinned in Task 2.
3. **An English report for a site whose name has Serbian letters (`Optika Čajš`)** — the name must pass through untouched and the PDF filename must still be produced. Pinned in Tasks 6 and 7.
4. **A one-day measured span** — English must read `September 9, 2026`, not `September 9–9, 2026`. Pinned in Task 5. (The Serbian `9–9. septembar 2026.` is existing behaviour and stays unchanged per the spec.)
5. **A `user-sites.json` written before this change, or with a junk `language`** — the collector reads `sr`; the dashboard round-trips a file without the key byte-for-byte and drops a junk value on its next write. Pinned in Tasks 1 and 3.

---

### Task 1: Collector — per-site report language in config and the `sites` table

**Files:**
- Modify: `collector/seocockpit/config.py` (constants near `_REQUIRED_SITE_KEYS`; `Site` dataclass; `_site_from_dict`; the `Site(...)` construction in `load_config`)
- Modify: `collector/seocockpit/db.py` (`_SCHEMA` sites table; `_migrate_sites`; `upsert_sites`)
- Modify: `collector/seocockpit/collect.py` (the `db.upsert_sites` row dict in `collect_once`)
- Test: `collector/tests/test_config.py`, `collector/tests/test_db.py`, `collector/tests/test_collect.py` (append only)

**Interfaces:**
- Produces: `Site.language: str` (`"sr"` | `"en"`, default `"sr"`); `REPORT_LANGUAGES = ("sr", "en")`; `DEFAULT_REPORT_LANGUAGE = "sr"`; `sites.language TEXT NOT NULL DEFAULT 'sr'`; `upsert_sites` rows may carry `"language"` (absent → `"sr"`).

- [ ] **Step 1: Write the failing config tests** — append to `collector/tests/test_config.py`:

```python
# ---------------------------------------------------------------------------
# Report language: per site, Serbian unless set to English
# ---------------------------------------------------------------------------


def test_report_language_defaults_to_serbian_and_reads_english(tmp_path):
    path = tmp_path / "sites.yaml"
    path.write_text(
        """
db_path: data/seo.db
service_account_path: secrets/sa.json
sites:
  - property: "https://optikacajs.rs/"
    slug: optika-cajs
    display_name: Optika Cajs
    brand_token: cajs
  - property: "https://example-us.com/"
    slug: example-us
    display_name: Example US
    brand_token: example
    language: en
  - property: "https://shouty.com/"
    slug: shouty
    display_name: Shouty
    brand_token: shouty
    language: " EN "
""",
        encoding="utf-8",
    )
    by_slug = {s.slug: s for s in load_config(path).sites}

    assert by_slug["optika-cajs"].language == "sr"
    assert by_slug["example-us"].language == "en"
    # Hand-edited file: case and whitespace are forgiven.
    assert by_slug["shouty"].language == "en"


def test_unknown_report_language_is_logged_and_treated_as_serbian(tmp_path, caplog):
    import logging

    path = tmp_path / "sites.yaml"
    path.write_text(
        """
db_path: data/seo.db
service_account_path: secrets/sa.json
sites:
  - property: "https://example.de/"
    slug: example-de
    display_name: Example DE
    brand_token: example
    language: de
""",
        encoding="utf-8",
    )
    with caplog.at_level(logging.WARNING):
        site = load_config(path).sites[0]

    # A typo must never stop a collection run.
    assert site.language == "sr"
    assert "unknown report language" in caplog.text


def test_user_site_report_language_is_read_and_defaults_to_serbian(tmp_path):
    import json

    user_sites = tmp_path / "user-sites.json"
    user_sites.write_text(
        json.dumps(
            [
                {"property": "sc-domain:us.example", "slug": "us", "display_name": "US",
                 "brand_token": "us", "language": "en"},
                # Written before this change: no language key at all.
                {"property": "sc-domain:rs.example", "slug": "rs", "display_name": "RS",
                 "brand_token": "rs"},
                {"property": "sc-domain:junk.example", "slug": "junk", "display_name": "Junk",
                 "brand_token": "junk", "language": 42},
            ]
        ),
        encoding="utf-8",
    )
    config = load_config(FIXTURES_DIR / "fixture_sites.yaml", user_sites_path=user_sites)
    by_slug = {s.slug: s for s in config.sites}

    assert by_slug["us"].language == "en"
    assert by_slug["rs"].language == "sr"
    assert by_slug["junk"].language == "sr"
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd collector && .venv/bin/python -m pytest -q tests/test_config.py`
Expected: 3 FAIL with `AttributeError: 'Site' object has no attribute 'language'`.

- [ ] **Step 3: Implement the config side** — in `collector/seocockpit/config.py`, directly after the line `_REQUIRED_SITE_KEYS = ("property", "slug", "display_name", "brand_token")`, add:

```python

# The client report's language, per site. Everything else in the app stays
# English; only the report (and its PDF) is bilingual.
REPORT_LANGUAGES = ("sr", "en")
DEFAULT_REPORT_LANGUAGE = "sr"
```

In the `Site` dataclass, after the `serp_location: str | None = None` field, add:

```python
    # Language of the client report and its PDF: "sr" or "en". The dashboard
    # and the proposal stay English whatever this says.
    language: str = DEFAULT_REPORT_LANGUAGE
```

Directly above `def _site_from_dict(`, add:

```python
def _report_language(raw: Mapping, where: str) -> str:
    """The site's report language: ``sr`` or ``en``, ``sr`` when absent.

    Case and surrounding whitespace are forgiven, since both config files are
    edited by hand. Anything else is logged and treated as ``sr`` rather than
    raised: a typo in one site's language must not stop a collection run.
    """
    value = raw.get("language")
    if value is None:
        return DEFAULT_REPORT_LANGUAGE
    normalized = str(value).strip().lower()
    if normalized in REPORT_LANGUAGES:
        return normalized
    logger.warning(
        "%s: unknown report language %r, using %r", where, value, DEFAULT_REPORT_LANGUAGE
    )
    return DEFAULT_REPORT_LANGUAGE


```

In `_site_from_dict`, add as the last argument of the `Site(...)` call (after `serp_location=...`):

```python
        language=_report_language(raw, source),
```

In `load_config`, add as the last argument of the `Site(...)` call (after `serp_location=raw_site.get("serp_location") or None,`):

```python
                language=_report_language(raw_site, f"sites[{index}] of {config_path}"),
```

- [ ] **Step 4: Run the config tests to verify they pass**

Run: `cd collector && .venv/bin/python -m pytest -q tests/test_config.py`
Expected: all pass (the existing `test_load_config_parses_fixture_into_typed_objects` still passes: both sides default to `"sr"`).

- [ ] **Step 5: Write the failing DB and collect tests** — append to `collector/tests/test_db.py` (it already has `sqlite3`, `init_db`, `upsert_sites`, `SITE` and the `_site_row` helper):

```python
# ---------------------------------------------------------------------------
# sites.language: the client report's language, written by the collector
# ---------------------------------------------------------------------------


def test_init_db_adds_language_to_an_existing_sites_table(tmp_path):
    db_path = tmp_path / "seo.db"
    old = sqlite3.connect(db_path)
    old.execute(
        """
        CREATE TABLE sites (
            property TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE,
            display_name TEXT NOT NULL, brand_token TEXT NOT NULL,
            updated_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
        )
        """
    )
    old.execute(
        "INSERT INTO sites (property, slug, display_name, brand_token, updated_at)"
        " VALUES (?, 'example', 'Example', 'example', '2026-07-20')",
        (SITE,),
    )
    old.commit()
    old.close()

    conn = init_db(db_path)

    assert conn.execute("SELECT language FROM sites WHERE property=?", (SITE,)).fetchone() == ("sr",)


def test_upsert_sites_writes_the_language_and_defaults_to_serbian(conn):
    upsert_sites(
        conn,
        [{**_site_row(SITE, "example"), "language": "en"}, _site_row("https://example.org/", "org")],
    )

    assert dict(conn.execute("SELECT property, language FROM sites")) == {
        SITE: "en",
        "https://example.org/": "sr",
    }


def test_upsert_sites_updates_a_changed_language(conn):
    upsert_sites(conn, [_site_row(SITE, "example")])
    upsert_sites(conn, [{**_site_row(SITE, "example"), "language": "en"}])

    assert conn.execute("SELECT language FROM sites").fetchone() == ("en",)
```

Append to `collector/tests/test_collect.py`:

```python
def test_collect_once_writes_each_sites_report_language(tmp_path, conn):
    sites = [
        Site(property=SITE_A, slug="alexrad", display_name="Alexrad", brand_token="alexrad"),
        Site(property=SITE_B, slug="skedio", display_name="Skedio", brand_token="skedio",
             language="en"),
    ]

    collect_once(
        _config(tmp_path, sites=sites),
        mode="incremental",
        conn=conn,
        service=object(),
        fetch_analytics=lambda service, property, start, end: _sa(property, "2026-07-15"),
        fetch_cwv_fn=lambda url: None,
        today=datetime.date(2026, 7, 24),
    )

    assert dict(conn.execute("SELECT property, language FROM sites")) == {
        SITE_A: "sr",
        SITE_B: "en",
    }
```

- [ ] **Step 6: Run them to verify they fail**

Run: `cd collector && .venv/bin/python -m pytest -q tests/test_db.py tests/test_collect.py`
Expected: 4 FAIL with `sqlite3.OperationalError: no such column: language`.

- [ ] **Step 7: Implement the DB and collect side** — in `collector/seocockpit/db.py`, in `_SCHEMA`, change the end of the `sites` table from:

```sql
    updated_at   TEXT NOT NULL,
    active       INTEGER NOT NULL DEFAULT 1
);
```

to:

```sql
    updated_at   TEXT NOT NULL,
    active       INTEGER NOT NULL DEFAULT 1,
    language     TEXT NOT NULL DEFAULT 'sr'
);
```

Replace the whole `_migrate_sites` function with:

```python
def _migrate_sites(conn: sqlite3.Connection) -> None:
    """Add columns to a ``sites`` table created before they existed.

    ``_SCHEMA``'s ``CREATE TABLE IF NOT EXISTS`` cannot add a column to an
    existing table. ``active``: every existing row starts active (the column
    default), and the next ``collect_once`` retires any no longer configured.
    ``language``: every existing row starts ``sr`` until the next run writes
    the configured value. No-op on a fresh database or one already migrated.
    """
    if not _table_exists(conn, "sites"):
        return
    columns = {row[1] for row in conn.execute("PRAGMA table_info(sites)").fetchall()}
    if "active" not in columns:
        conn.execute("ALTER TABLE sites ADD COLUMN active INTEGER NOT NULL DEFAULT 1")
    if "language" not in columns:
        conn.execute("ALTER TABLE sites ADD COLUMN language TEXT NOT NULL DEFAULT 'sr'")
    conn.commit()
```

Replace the body of `upsert_sites` (docstring and statement) with:

```python
    """Upsert rows into ``sites``, keyed on ``property``.

    Each row is a mapping with keys: property, slug, display_name,
    brand_token, updated_at, and optionally language (``sr`` when absent).
    Re-upserting the same ``property`` updates the existing row in place
    rather than creating a duplicate, so editing ``sites.yaml`` (display
    name, brand token, slug or language) propagates on the next collection
    run. An upserted site is active, so re-adding a retired property brings
    it (and its history) back.
    """
    conn.executemany(
        """
        INSERT INTO sites (property, slug, display_name, brand_token, updated_at, active, language)
        VALUES (:property, :slug, :display_name, :brand_token, :updated_at, 1, :language)
        ON CONFLICT (property) DO UPDATE SET
            slug = excluded.slug,
            display_name = excluded.display_name,
            brand_token = excluded.brand_token,
            updated_at = excluded.updated_at,
            active = 1,
            language = excluded.language
        """,
        [{"language": "sr", **row} for row in rows],
    )
    conn.commit()
```

In `collector/seocockpit/collect.py`, in the row dict passed to `db.upsert_sites`, add after `"brand_token": site.brand_token,`:

```python
                "language": site.language,
```

- [ ] **Step 8: Run the whole collector suite**

Run: `cd collector && .venv/bin/python -m pytest -q`
Expected: all pass (previous count 233 plus the 7 new tests = 240).

- [ ] **Step 9: Commit**

```bash
git add collector/seocockpit/config.py collector/seocockpit/db.py collector/seocockpit/collect.py \
        collector/tests/test_config.py collector/tests/test_db.py collector/tests/test_collect.py
git commit -m "Give each site a report language and collect it into the sites table"
```

---

### Task 2: Dashboard — the report language type, request resolution, and `siteLanguage()`

**Files:**
- Create: `app/lib/report/language.ts`
- Modify: `app/lib/db.ts` (`hasActiveColumn` → `hasSitesColumn`; new `siteLanguage`)
- Test: `app/tests/report-language.test.ts` (new)

**Interfaces:**
- Consumes: `sites.language` column (Task 1).
- Produces:
  - `export const REPORT_LANGUAGES: readonly ["sr", "en"]`
  - `export type ReportLanguage = "sr" | "en"`
  - `export function isReportLanguage(value: unknown): value is ReportLanguage`
  - `export function resolveReportLanguage(param: string | string[] | null | undefined, siteDefault: ReportLanguage): ReportLanguage`
  - `export function siteLanguage(property: string, db?: Database.Database): ReportLanguage` (in `lib/db.ts`)

- [ ] **Step 1: Write the failing tests** — create `app/tests/report-language.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getDb, siteLanguage } from "../lib/db";
import { isReportLanguage, resolveReportLanguage } from "../lib/report/language";

describe("resolveReportLanguage", () => {
  it("uses ?lang= when it is exactly sr or en", () => {
    expect(resolveReportLanguage("en", "sr")).toBe("en");
    expect(resolveReportLanguage("sr", "en")).toBe("sr");
  });

  it("falls back to the site default for anything else", () => {
    expect(resolveReportLanguage(undefined, "en")).toBe("en");
    expect(resolveReportLanguage(null, "en")).toBe("en");
    expect(resolveReportLanguage("", "en")).toBe("en");
    expect(resolveReportLanguage("de", "sr")).toBe("sr");
    // Our own links always write lowercase; anything else is a mangled URL.
    expect(resolveReportLanguage("EN", "sr")).toBe("sr");
  });

  it("falls back for a repeated parameter (Next passes an array)", () => {
    expect(resolveReportLanguage(["en", "sr"], "sr")).toBe("sr");
  });

  it("recognizes exactly the two languages", () => {
    expect(isReportLanguage("sr")).toBe(true);
    expect(isReportLanguage("en")).toBe(true);
    expect(isReportLanguage("de")).toBe(false);
    expect(isReportLanguage(42)).toBe(false);
  });
});

describe("siteLanguage", () => {
  let dir: string;
  let migratedPath: string;
  let legacyPath: string;

  const COLUMNS = `
    property TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
    brand_token TEXT NOT NULL, updated_at TEXT NOT NULL`;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "seo-cockpit-lang-"));

    migratedPath = path.join(dir, "migrated.db");
    const migrated = new BetterSqlite3(migratedPath);
    migrated.exec(`CREATE TABLE sites (${COLUMNS}, language TEXT);`);
    const insert = migrated.prepare("INSERT INTO sites VALUES (?, ?, ?, ?, '2026-10-09', ?)");
    insert.run("sc-domain:us.example", "us", "US", "us", "en");
    insert.run("sc-domain:rs.example", "rs", "RS", "rs", "sr");
    insert.run("sc-domain:junk.example", "junk", "Junk", "junk", "fr");
    insert.run("sc-domain:null.example", "null", "Null", "null", null);
    migrated.close();

    // The collector hasn't migrated this one yet: no language column.
    legacyPath = path.join(dir, "legacy.db");
    const legacy = new BetterSqlite3(legacyPath);
    legacy.exec(`CREATE TABLE sites (${COLUMNS});`);
    legacy
      .prepare("INSERT INTO sites VALUES (?, ?, ?, ?, '2026-10-09')")
      .run("sc-domain:us.example", "us", "US", "us");
    legacy.close();
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads the stored language", () => {
    const db = getDb(migratedPath);
    expect(siteLanguage("sc-domain:us.example", db)).toBe("en");
    expect(siteLanguage("sc-domain:rs.example", db)).toBe("sr");
  });

  it("reads Serbian for an unknown value, a null, or an unknown site", () => {
    const db = getDb(migratedPath);
    expect(siteLanguage("sc-domain:junk.example", db)).toBe("sr");
    expect(siteLanguage("sc-domain:null.example", db)).toBe("sr");
    expect(siteLanguage("sc-domain:missing.example", db)).toBe("sr");
  });

  it("reads Serbian from a database without the column", () => {
    expect(siteLanguage("sc-domain:us.example", getDb(legacyPath))).toBe("sr");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd app && npx vitest run tests/report-language.test.ts`
Expected: FAIL — `Cannot find module '../lib/report/language'`.

- [ ] **Step 3: Create `app/lib/report/language.ts`**

```ts
/**
 * The client report's two languages.
 *
 * Only the report (and its PDF) is bilingual. The admin dashboard, the
 * proposal, and the client live view stay English.
 */
export const REPORT_LANGUAGES = ["sr", "en"] as const;
export type ReportLanguage = (typeof REPORT_LANGUAGES)[number];

export function isReportLanguage(value: unknown): value is ReportLanguage {
  return value === "sr" || value === "en";
}

/**
 * The language a report request renders in: `?lang=` when it is exactly
 * `sr` or `en`, otherwise the site's default.
 *
 * Strict on purpose: the parameter is written by our own links (the SR / EN
 * switch, the PDF button, share links), so anything else, including a
 * repeated parameter that Next passes as an array, is a mangled URL, and the
 * site default is the safe answer.
 */
export function resolveReportLanguage(
  param: string | string[] | null | undefined,
  siteDefault: ReportLanguage,
): ReportLanguage {
  return isReportLanguage(param) ? param : siteDefault;
}
```

- [ ] **Step 4: Add `siteLanguage` to `app/lib/db.ts`** — add the import at the top with the other imports:

```ts
import type { ReportLanguage } from "./report/language";
```

Replace the `hasActiveColumn` function (doc comment included) with:

```ts
/**
 * Whether this database's `sites` table has `column`. Columns the collector
 * adds by migration (`active`, `language`) may not exist yet: the dashboard
 * can be deployed first, so a missing column is read as its default rather
 * than an error. Checked per call, not cached: the collector can migrate the
 * file while this process runs.
 */
function hasSitesColumn(db: Database.Database, column: string): boolean {
  return db
    .prepare<[], { name: string }>("PRAGMA table_info(sites)")
    .all()
    .some((c) => c.name === column);
}
```

Then replace each of the three calls `hasActiveColumn(db)` in `listSiteConfigs`, `listRetiredSiteConfigs` and `siteConfigBySlug` with `hasSitesColumn(db, "active")`. Directly after `siteConfigBySlug`, add:

```ts
/**
 * A site's client-report language, from `sites.language` (written by the
 * collector). `sr` when the column doesn't exist yet, when the site isn't
 * found, or for any value other than `en`, so a report can always render.
 */
export function siteLanguage(
  property: string,
  db: Database.Database = getDb()
): ReportLanguage {
  if (!hasSitesColumn(db, "language")) return "sr";
  const row = db
    .prepare<[string], { language: string | null }>(
      "SELECT language FROM sites WHERE property = ?"
    )
    .get(property);
  return row?.language === "en" ? "en" : "sr";
}
```

- [ ] **Step 5: Run the tests**

Run: `cd app && npx vitest run tests/report-language.test.ts tests/site-active.test.ts tests/db.test.ts`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add app/lib/report/language.ts app/lib/db.ts app/tests/report-language.test.ts
git commit -m "Resolve a report's language from the request and the site's default"
```

---

### Task 3: Add-site form — choose the report language

**Files:**
- Modify: `app/lib/userSites.ts` (`UserSite`, `NewSiteInput`, `validateNewSite`, `DiskSite`, `toDisk`, `fromDisk`)
- Modify: `app/app/sites/actions.ts` (`addSite` passes `language`)
- Modify: `app/app/sites/add/AddSiteForm.tsx` (Language select)
- Test: `app/tests/user-sites.test.ts`, `app/tests/site-actions.test.ts` (append only)

**Interfaces:**
- Consumes: `ReportLanguage`, `isReportLanguage` (Task 2).
- Produces: `UserSite.language?: ReportLanguage`; `NewSiteInput.language?: string`; `language` key in `user-sites.json` (read by Task 1's collector).

- [ ] **Step 1: Write the failing tests** — append to `app/tests/user-sites.test.ts`:

```ts
describe("report language on dashboard-added sites", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const input = { property: "sc-domain:us.example", displayName: "US Client", brandToken: "us" };

  it("saves English when chosen and Serbian otherwise", () => {
    expect(validateNewSite({ ...input, language: "en" }, [], []).site?.language).toBe("en");
    expect(validateNewSite(input, [], []).site?.language).toBe("sr");
    expect(validateNewSite({ ...input, language: "fr" }, [], []).site?.language).toBe("sr");
  });

  it("writes the language to disk and reads it back", () => {
    dir = tmp();
    const file = path.join(dir, "user-sites.json");
    const site = validateNewSite({ ...input, language: "en" }, [], []).site!;
    writeUserSitesAtomic(file, [site]);
    expect(JSON.parse(fs.readFileSync(file, "utf-8"))[0].language).toBe("en");
    expect(readUserSites(file)[0].language).toBe("en");
  });

  it("drops a junk language instead of carrying it forward", () => {
    dir = tmp();
    const file = path.join(dir, "user-sites.json");
    fs.writeFileSync(
      file,
      JSON.stringify([
        { property: "sc-domain:a.com", slug: "a", display_name: "A", brand_token: "a", language: "fr" },
      ]),
    );
    const [site] = readUserSites(file);
    expect(site.language).toBeUndefined();
    writeUserSitesAtomic(file, [site]);
    expect(JSON.parse(fs.readFileSync(file, "utf-8"))[0]).not.toHaveProperty("language");
  });
});
```

Append to `app/tests/site-actions.test.ts`:

```ts
describe("addSite saves the report language", () => {
  it("stores the language chosen in the form", async () => {
    const form = addForm("sc-domain:us-client.com", "US Client");
    form.set("language", "en");

    const state = await addSite(INITIAL, form);

    expect(state).toEqual({ errors: {}, ok: true });
    const onDisk = JSON.parse(fs.readFileSync(sitesFile, "utf-8"));
    expect(onDisk[0].language).toBe("en");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd app && npx vitest run tests/user-sites.test.ts tests/site-actions.test.ts`
Expected: the 4 new tests FAIL (`language` undefined / missing).

- [ ] **Step 3: Implement in `app/lib/userSites.ts`** — add at the top, after the `path` import:

```ts
import { isReportLanguage, type ReportLanguage } from "./report/language";
```

In `interface UserSite`, after `serpLocation: string | null;`, add:

```ts
  /**
   * Client-report language. Optional on disk: a file written before this
   * field existed round-trips unchanged, and the collector reads a missing
   * value as `sr`.
   */
  language?: ReportLanguage;
```

In `interface NewSiteInput`, after `serpLocation?: string | null;`, add:

```ts
  language?: string;
```

In `validateNewSite`'s returned `site` object, after `serpLocation: input.serpLocation ?? null,`, add:

```ts
      language: input.language === "en" ? "en" : "sr",
```

In `interface DiskSite`, after `added_at: string;`, add:

```ts
  language?: string;
```

In `toDisk`, after `added_at: s.addedAt,`, add:

```ts
    // Undefined is dropped by JSON.stringify, so a site without a language
    // is written exactly as before.
    language: s.language,
```

In `fromDisk`, after `addedAt: d.added_at,`, add:

```ts
    // Only a valid language is carried; a junk value is dropped on the next
    // write rather than preserved (the collector already reads it as `sr`).
    ...(isReportLanguage(d.language) ? { language: d.language } : {}),
```

- [ ] **Step 4: Pass it from the action** — in `app/app/sites/actions.ts`, in the object passed to `validateNewSite` inside `addSite`, after `serpLocation: serpLocationRaw || null,`, add:

```ts
      language: String(formData.get("language") ?? ""),
```

- [ ] **Step 5: Add the select to the form** — in `app/app/sites/add/AddSiteForm.tsx`, directly after the closing `</Field>` of the "Brand token" field (before `<details`), add:

```tsx
      <Field
        label="Report language"
        hint="Language of the client report and its PDF. The dashboard stays in English."
      >
        <select name="language" defaultValue="sr" className={inputClass}>
          <option value="sr">Serbian</option>
          <option value="en">English</option>
        </select>
      </Field>
```

- [ ] **Step 6: Run the tests and the type check**

Run: `cd app && npx vitest run tests/user-sites.test.ts tests/site-actions.test.ts && npx tsc --noEmit`
Expected: all pass, `tsc` silent.

- [ ] **Step 7: Commit**

```bash
git add app/lib/userSites.ts app/app/sites/actions.ts app/app/sites/add/AddSiteForm.tsx \
        app/tests/user-sites.test.ts app/tests/site-actions.test.ts
git commit -m "Let the add-site form choose the report language"
```

---

### Task 4: English report strings

**Files:**
- Modify: `app/lib/report/sr.ts` (header sentence; add `ReportStrings` type at the end)
- Create: `app/lib/report/en.ts`
- Modify: `app/lib/report/language.ts` (add `reportStrings`)
- Test: `app/tests/report-strings-en.test.ts` (new)

**Interfaces:**
- Consumes: `ReportLanguage` (Task 2).
- Produces: `export type ReportStrings` (in `sr.ts`); `export const EN: ReportStrings` (in `en.ts`); `export function reportStrings(lang: ReportLanguage): ReportStrings` (in `language.ts`).

- [ ] **Step 1: Write the failing test** — create `app/tests/report-strings-en.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { EN } from "../lib/report/en";
import { reportStrings } from "../lib/report/language";
import { SR } from "../lib/report/sr";

const SERBIAN_LETTERS = /[čćđšž]/i;

describe("English report strings", () => {
  it("has exactly the Serbian entries", () => {
    expect(Object.keys(EN).sort()).toEqual(Object.keys(SR).sort());
    expect(Object.keys(EN.demandIntent).sort()).toEqual(Object.keys(SR.demandIntent).sort());
  });

  it("leaves nothing empty, including plural slots and intents", () => {
    for (const [key, value] of Object.entries(EN)) {
      if (typeof value === "string") expect(value.trim(), key).not.toBe("");
      if (Array.isArray(value)) for (const form of value) expect(form.trim(), key).not.toBe("");
    }
    for (const label of Object.values(EN.demandIntent)) expect(label.trim()).not.toBe("");
  });

  it("builds its sentences around the values it is given", () => {
    expect(EN.growthLead("3 months")).toContain("3 months");
    expect(EN.noPrior("September 9, 2026")).toContain("September 9, 2026");
    expect(EN.vsPrior("25%", true)).toContain("25%");
    expect(EN.vsPrior("25%", true)).not.toBe(EN.vsPrior("25%", false));
    expect(EN.demandLead(12, "keywords")).toContain("12 keywords");
  });

  it("contains no Serbian letters outside the author's name", () => {
    const { author, ...rest } = EN;
    const sentences = [
      EN.growthLead("3 months"),
      EN.noPrior("September 9, 2026"),
      EN.vsPrior("25%", true),
      EN.vsPrior("25%", false),
      EN.demandLead(12, "keywords"),
    ].join(" ");
    expect(JSON.stringify(rest)).not.toMatch(SERBIAN_LETTERS);
    expect(sentences).not.toMatch(SERBIAN_LETTERS);
    expect(author).toBe(SR.author);
  });

  it("keeps the names and terms that are never translated", () => {
    expect(EN.authorSite).toBe(SR.authorSite);
    expect(EN.colCtr).toBe("CTR");
  });
});

describe("reportStrings", () => {
  it("returns the strings for each language", () => {
    expect(reportStrings("sr")).toBe(SR);
    expect(reportStrings("en")).toBe(EN);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd app && npx vitest run tests/report-strings-en.test.ts`
Expected: FAIL — `Cannot find module '../lib/report/en'`.

- [ ] **Step 3: Add the shared type to `app/lib/report/sr.ts`** — in the header comment, replace the sentence:

```
 * negotiation. A second language later means a second file satisfying the
 * same shape.
```

with:

```
 * negotiation. The English report is `en.ts`, which must satisfy the same
 * shape (`ReportStrings`, below).
```

Append at the end of the file:

```ts

/** Widens SR's literal types so another language can satisfy the same shape. */
type Widen<T> = T extends string
  ? string
  : T extends (...args: infer A) => string
    ? (...args: A) => string
    : T extends readonly [string, string, string]
      ? [string, string, string]
      : T extends object
        ? { readonly [K in keyof T]: Widen<T[K]> }
        : T;

/**
 * The shape every report language satisfies: SR's entries with their literal
 * strings widened. A missing, extra or misshapen entry is a compile error,
 * so an untranslated string can't reach a client's PDF as `undefined`.
 */
export type ReportStrings = { readonly [K in keyof typeof SR]: Widen<(typeof SR)[K]> };
```

- [ ] **Step 4: Create `app/lib/report/en.ts`**

```ts
import type { ReportStrings } from "./sr";

/**
 * Every user-visible string in the English client report, for US clients.
 *
 * Same shape as `SR` (enforced by `ReportStrings`), US English, and the same
 * honesty rules: "not collected" and "measured, and zero" stay different
 * sentences, as do an absent prior period and a flat one.
 *
 * Plurals keep Serbian's three slots (one / few / other). English rules
 * never select "few", so the third slot repeats the plural.
 */
export const EN: ReportStrings = {
  docTitle: "SEO report",
  preparedBy: "Prepared by",
  author: "Aleksandar Radivojević, Deimos Agency",
  authorSite: "deimos.agency",
  period: "Period",
  print: "Download PDF",
  printBusy: "Preparing PDF…",
  printError: "The PDF couldn’t be prepared. Please try again.",

  summary: "Summary",
  clicks: ["click", "clicks", "clicks"],
  impressions: ["impression", "impressions", "impressions"],
  keywords: ["keyword", "keywords", "keywords"],
  avgPosition: "average position",

  growth: "Progress",
  months: ["month", "months", "months"],
  growthLead: (duration: string) =>
    `Over ${duration} of working together, here is how the key numbers have changed from the start to today.`,
  growthEmpty:
    "There isn’t enough history to show progress yet — it takes at least two months of collected data.",
  growthClicks: "Clicks",
  growthImpressions: "Impressions",
  growthPosition: "Average position",
  growthBefore: "at the start",
  growthAfter: "today",
  growthNew: "new",

  noPrior: (firstDay: string) =>
    `No previous period to compare with — the first measured day is ${firstDay}`,
  vsPrior: (pct: string, up: boolean) =>
    `${up ? "up" : "down"} ${pct} from the previous period`,
  noChange: "no change from the previous period",
  noPriorClicks: "the previous period recorded no clicks, so there is nothing to compare against",

  notCollected:
    "No search data has been collected for this site yet, so the sections below are empty. That is a gap in collection, not a search result.",
  measuredZero:
    "The site was measured throughout the period and recorded no impressions. The data exists, and the result is a real zero.",

  trend: "Impressions over time",
  trendEmpty: "Not enough measured days to draw the chart.",

  opportunities: "Opportunities",
  opportunitiesLead:
    "Searches the site already appears for, but below the first page — ranked by remaining potential.",
  opportunitiesEmpty:
    "No search in this period has untapped potential — everything we track is already on the first page or has too few impressions to judge.",
  colQuery: "Search term",
  colPosition: "Position",
  colImpressions: "Impressions",
  colClicks: "Clicks",
  colCtr: "CTR",
  colPage: "Page",

  movement: "Movement",
  movementRising: "Rising",
  movementDeclining: "Declining",
  movementNone: "none",
  movementEmpty: "No search moved enough to be shown.",

  sources: "Where impressions come from",
  sourceBrand: "Searches for your business name",
  sourceNonBrand: "Other searches",
  sourceAnonymous: "Search hidden by Google",
  sourcesNote:
    "Google doesn’t reveal the search term for rare searches, so the split between business-name searches and other searches covers only the part it shows.",

  pages: "Most visited pages",
  pagesEmpty: "No page-level data for this period.",

  demand: "Demand you’re not reaching",
  demandLead: (n: number, noun: string) =>
    `We found ${n} ${noun} people search for that the site doesn’t appear for yet.`,
  demandEmpty: "Demand research hasn’t been run for this site yet.",
  demandIntent: {
    commercial: "Ready to buy",
    local: "Local search",
    question: "Questions",
    other: "Other",
  },

  competitors: "Competitors",
  competitorsLead:
    "Sites that appear for the searches in the previous section, ranked by how many of them they show up for.",
  competitorsEmpty: "The competitor check hasn’t been run for these terms yet.",
  competitorsEmptySerp: "The check ran, but Google returned no results.",
  colDomain: "Site",
  colAppearances: "Searches",
  colBest: "Best position",
};
```

- [ ] **Step 5: Add `reportStrings` to `app/lib/report/language.ts`** — add at the top of the file:

```ts
import { EN } from "./en";
import { SR, type ReportStrings } from "./sr";
```

Append at the end:

```ts

/** The report's strings in `lang`. */
export function reportStrings(lang: ReportLanguage): ReportStrings {
  return lang === "en" ? EN : SR;
}
```

- [ ] **Step 6: Run the tests and the type check**

Run: `cd app && npx vitest run tests/report-strings-en.test.ts tests/report-sections.test.ts tests/report-phase2.test.ts tests/report-strings.test.ts && npx tsc --noEmit`
Expected: all pass, `tsc` silent (it proves `EN` matches `ReportStrings`).

- [ ] **Step 7: Commit**

```bash
git add app/lib/report/sr.ts app/lib/report/en.ts app/lib/report/language.ts app/tests/report-strings-en.test.ts
git commit -m "Add the English report strings"
```

---

### Task 5: Language-aware formatting, including the chart

**Files:**
- Modify: `app/lib/report/format.ts` (append `EN_LOCALE`, `ReportFormat`, English formatters, `reportFormat`)
- Modify: `app/lib/report/chart.ts` (`buildTrendPaths` optional `lang`)
- Modify: `app/components/report/ReportChart.tsx` (`lang` prop)
- Test: `app/tests/report-format-en.test.ts` (new), `app/tests/report-chart.test.ts` (append only)

**Interfaces:**
- Consumes: `ReportLanguage` (Task 2), `reportStrings` (Task 4).
- Produces:
  - `export const EN_LOCALE = "en-US"`
  - `export interface ReportFormat { int(n: number): string; decimal(n: number, digits?: number): string; percent(fraction: number): string; date(iso: string): string; period(startISO: string, endISO: string): string; plural(n: number, forms: [string, string, string]): string }`
  - `export function reportFormat(lang: ReportLanguage): ReportFormat`
  - `buildTrendPaths(points, width, height, lang: ReportLanguage = "sr")`
  - `<ReportChart points={...} lang?: ReportLanguage />` (default `"sr"`)

- [ ] **Step 1: Write the failing tests** — create `app/tests/report-format-en.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { reportFormat } from "../lib/report/format";

const en = reportFormat("en");
const sr = reportFormat("sr");

describe("English report formatting", () => {
  it("formats numbers the US way", () => {
    expect(en.int(1123)).toBe("1,123");
    expect(en.decimal(2.44)).toBe("2.4");
    expect(en.decimal(8.437, 2)).toBe("8.44");
    expect(en.percent(0.974)).toBe("97.4%");
    expect(en.percent(0.25)).toBe("25%");
  });

  it("writes dates month first, as UTC", () => {
    expect(en.date("2026-09-09")).toBe("September 9, 2026");
    expect(en.date("2026-01-01")).toBe("January 1, 2026");
  });

  it("collapses a period by shared month and year", () => {
    expect(en.period("2026-09-01", "2026-09-28")).toBe("September 1–28, 2026");
    expect(en.period("2026-09-09", "2026-10-06")).toBe("September 9 – October 6, 2026");
    expect(en.period("2026-12-20", "2027-01-05")).toBe("December 20, 2026 – January 5, 2027");
  });

  it("states a one-day span as that day", () => {
    expect(en.period("2026-09-09", "2026-09-09")).toBe("September 9, 2026");
  });

  it("uses two plural forms", () => {
    const clicks: [string, string, string] = ["click", "clicks", "clicks"];
    expect(en.plural(1, clicks)).toBe("click");
    expect(en.plural(2, clicks)).toBe("clicks");
    expect(en.plural(0, clicks)).toBe("clicks");
  });
});

describe("Serbian formatting through reportFormat", () => {
  it("is today's Serbian formatting", () => {
    expect(sr.int(1123)).toBe("1.123");
    expect(sr.decimal(2.44)).toBe("2,4");
    expect(sr.percent(0.974)).toBe("97,4%");
    expect(sr.date("2026-09-09")).toBe("9. septembar 2026.");
    expect(sr.period("2026-09-01", "2026-09-28")).toBe("1–28. septembar 2026.");
    expect(sr.period("2026-09-09", "2026-10-06")).toBe("9. septembar – 6. oktobar 2026.");
    expect(sr.period("2026-12-20", "2027-01-05")).toBe("20. decembar 2026. – 5. januar 2027.");
    expect(sr.plural(5, ["klik", "klika", "klikova"])).toBe("klikova");
  });
});
```

Append to `app/tests/report-chart.test.ts` (it already defines the `p(date, impressions)` helper and imports `buildTrendPaths`):

```ts
describe("buildTrendPaths in English", () => {
  it("labels the first and last date month first", () => {
    const out = buildTrendPaths([p("2026-07-01", 1), p("2026-07-17", 2)], 300, 60, "en");
    expect(out.ticks.map((t) => t.label)).toEqual(["July 1", "July 17"]);
  });

  it("still labels in Serbian by default", () => {
    const out = buildTrendPaths([p("2026-07-01", 1), p("2026-07-17", 2)], 300, 60);
    expect(out.ticks.map((t) => t.label)).toEqual(["1. jul", "17. jul"]);
  });
});
```

Create `app/tests/report-chart-lang.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import ReportChart from "../components/report/ReportChart";

const points = [
  { date: "2026-09-09", impressions: 1234, clicks: 10 },
  { date: "2026-09-10", impressions: 900, clicks: 8 },
];

describe("ReportChart language", () => {
  it("labels and numbers the chart in English", () => {
    const html = renderToStaticMarkup(<ReportChart points={points} lang="en" />);
    expect(html).toContain('aria-label="Impressions over time"');
    expect(html).toContain("1,234");
    expect(html).toContain("September 9");
  });

  it("stays Serbian by default", () => {
    const html = renderToStaticMarkup(<ReportChart points={points} />);
    expect(html).toContain('aria-label="Prikazi kroz vreme"');
    expect(html).toContain("1.234");
    expect(html).toContain("9. septembar");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd app && npx vitest run tests/report-format-en.test.ts tests/report-chart.test.ts tests/report-chart-lang.test.tsx`
Expected: FAIL — `reportFormat is not a function`, English tick labels still Serbian, no `lang` prop effect.

- [ ] **Step 3: Append the English formatters to `app/lib/report/format.ts`** — add the import at the top of the file:

```ts
import type { ReportLanguage } from "./language";
```

Append at the end of the file:

```ts

export const EN_LOCALE = "en-US";

/** The report's number, date and plural formatting for one language. */
export interface ReportFormat {
  int(n: number): string;
  decimal(n: number, digits?: number): string;
  percent(fraction: number): string;
  date(iso: string): string;
  period(startISO: string, endISO: string): string;
  plural(n: number, forms: [string, string, string]): string;
}

const EN_INT = new Intl.NumberFormat(EN_LOCALE, { maximumFractionDigits: 0 });
const EN_PERCENT_1 = new Intl.NumberFormat(EN_LOCALE, {
  style: "percent",
  maximumFractionDigits: 1,
});
const EN_PLURAL = new Intl.PluralRules(EN_LOCALE);
const EN_MONTH = new Intl.DateTimeFormat(EN_LOCALE, { month: "long", timeZone: "UTC" });

function enMonth(iso: string): string {
  const { year, month, day } = utcParts(iso);
  return EN_MONTH.format(new Date(Date.UTC(year, month - 1, day)));
}

/** `September 9, 2026`: month first, no trailing dot. */
function enDate(iso: string): string {
  const { day, year } = utcParts(iso);
  return `${enMonth(iso)} ${day}, ${year}`;
}

/**
 * Collapses what the two ends share, like `formatPeriodSr`. A one-day span is
 * just that day; `September 9–9, 2026` would read as a typo.
 */
function enPeriod(startISO: string, endISO: string): string {
  if (startISO === endISO) return enDate(startISO);
  const s = utcParts(startISO);
  const e = utcParts(endISO);
  if (s.year === e.year && s.month === e.month) {
    return `${enMonth(startISO)} ${s.day}–${e.day}, ${e.year}`;
  }
  if (s.year === e.year) {
    return `${enMonth(startISO)} ${s.day} – ${enMonth(endISO)} ${e.day}, ${e.year}`;
  }
  return `${enDate(startISO)} – ${enDate(endISO)}`;
}

/** English never selects "few", so the third slot carries the plural. */
function enPlural(n: number, forms: [string, string, string]): string {
  return EN_PLURAL.select(n) === "one" ? forms[0] : forms[2];
}

const SR_FORMAT: ReportFormat = {
  int: formatIntSr,
  decimal: formatDecimalSr,
  percent: formatPercentSr,
  date: formatDateSr,
  period: formatPeriodSr,
  plural: pluralSr,
};

const EN_FORMAT: ReportFormat = {
  int: (n) => EN_INT.format(n),
  decimal: (n, digits = 1) =>
    new Intl.NumberFormat(EN_LOCALE, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(n),
  percent: (fraction) => EN_PERCENT_1.format(fraction),
  date: enDate,
  period: enPeriod,
  plural: enPlural,
};

/** The report's formatting in `lang`. The Serbian set is the functions above, unchanged. */
export function reportFormat(lang: ReportLanguage): ReportFormat {
  return lang === "en" ? EN_FORMAT : SR_FORMAT;
}
```

- [ ] **Step 4: Make the chart language-aware** — in `app/lib/report/chart.ts`, replace:

```ts
import { SR_LOCALE } from "./format";
import type { TrendPointSr } from "./data";
```

with:

```ts
import { EN_LOCALE, SR_LOCALE } from "./format";
import type { TrendPointSr } from "./data";
import type { ReportLanguage } from "./language";
```

Replace the `DAY_MONTH` constant and `shortDate` function with:

```ts
const DAY_MONTH: Record<ReportLanguage, Intl.DateTimeFormat> = {
  sr: new Intl.DateTimeFormat(SR_LOCALE, { day: "numeric", month: "long", timeZone: "UTC" }),
  en: new Intl.DateTimeFormat(EN_LOCALE, { day: "numeric", month: "long", timeZone: "UTC" }),
};

function shortDate(iso: string, lang: ReportLanguage): string {
  const [y, m, d] = iso.split("-").map(Number);
  return DAY_MONTH[lang].format(new Date(Date.UTC(y, m - 1, d)));
}
```

Change the `buildTrendPaths` signature to:

```ts
export function buildTrendPaths(
  points: TrendPointSr[],
  width: number,
  height: number,
  lang: ReportLanguage = "sr"
): TrendPaths {
```

and in its `ticks` block replace each `shortDate(points[...].date)` with `shortDate(points[...].date, lang)` (three call sites).

In `app/components/report/ReportChart.tsx`, replace the imports and the signature line:

```tsx
import { buildTrendPaths } from "../../lib/report/chart";
import { formatIntSr } from "../../lib/report/format";
import type { TrendPointSr } from "../../lib/report/data";
```

with:

```tsx
import { buildTrendPaths } from "../../lib/report/chart";
import type { TrendPointSr } from "../../lib/report/data";
import { reportFormat } from "../../lib/report/format";
import { reportStrings, type ReportLanguage } from "../../lib/report/language";
```

and:

```tsx
export default function ReportChart({ points }: { points: TrendPointSr[] }) {
  const { segments, max, ticks } = buildTrendPaths(points, W - PAD_L, H - PAD_B);
```

with:

```tsx
export default function ReportChart({
  points,
  lang = "sr",
}: {
  points: TrendPointSr[];
  lang?: ReportLanguage;
}) {
  const { segments, max, ticks } = buildTrendPaths(points, W - PAD_L, H - PAD_B, lang);
```

Then replace `aria-label="Prikazi kroz vreme"` with `aria-label={reportStrings(lang).trend}` and `{formatIntSr(max)}` with `{reportFormat(lang).int(max)}`.

- [ ] **Step 5: Run the tests and the type check**

Run: `cd app && npx vitest run tests/report-format-en.test.ts tests/report-format.test.ts tests/report-chart.test.ts tests/report-chart-lang.test.tsx && npx tsc --noEmit`
Expected: all pass, `tsc` silent.

- [ ] **Step 6: Commit**

```bash
git add app/lib/report/format.ts app/lib/report/chart.ts app/components/report/ReportChart.tsx \
        app/tests/report-format-en.test.ts app/tests/report-chart.test.ts app/tests/report-chart-lang.test.tsx
git commit -m "Format report numbers and dates per language"
```

---

### Task 6: Render the report in the chosen language, with an SR / EN switch

**Files:**
- Create: `app/components/report/ReportDocument.tsx` (the document, moved out of the page)
- Create: `app/components/report/LanguageSwitch.tsx`
- Modify: `app/components/report/PrintButton.tsx` (labels prop instead of `SR`)
- Modify: `app/app/site/[slug]/report/page.tsx` (thin loader that renders `ReportDocument`)
- Test: `app/tests/report-document.test.tsx` (new)

**Interfaces:**
- Consumes: `reportStrings`, `resolveReportLanguage`, `ReportLanguage`, `REPORT_LANGUAGES` (Tasks 2, 4); `reportFormat` (Task 5); `siteLanguage` (Task 2); `<ReportChart lang>` (Task 5); `ReportData` (existing, `lib/report/data.ts`).
- Produces:
  - `export default function ReportDocument(props: { data: ReportData; lang: ReportLanguage; toolbar?: ReactNode })` — renders the `lang`-tagged `.report` root, the optional screen-only toolbar, the cover and the body. Piece 2's share route renders this same component.
  - `export default function LanguageSwitch(props: { current: ReportLanguage; hrefFor: (lang: ReportLanguage) => string })`
  - `PrintButton` props: `{ href: string; labels: { print: string; busy: string; error: string } }`

- [ ] **Step 1: Capture the Serbian baseline before touching the page** — start the dev server against a copy of the local DB and save today's Serbian report HTML:

```bash
WORK=/tmp/claude-1000/-home-ar-Documents-GitHub-seo-cockpit/43a79ef2-95da-4f61-aad8-1c711ed1c2a9/scratchpad/bilingual
mkdir -p $WORK && cp collector/data/seo.db $WORK/seo.db
(cd app && SEO_DB_PATH=$WORK/seo.db npx next dev -p 3999 > $WORK/dev.log 2>&1 &)
until curl -s -o /dev/null http://localhost:3999/site/optika-cajs/report; do sleep 1; done
curl -s http://localhost:3999/site/optika-cajs/report > $WORK/before-sr.html
```

Keep the server running (it hot-reloads) for Step 7.

- [ ] **Step 2: Write the failing tests** — create `app/tests/report-document.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import LanguageSwitch from "../components/report/LanguageSwitch";
import PrintButton from "../components/report/PrintButton";
import ReportDocument from "../components/report/ReportDocument";
import type { SignalEntry } from "../lib/analysis/signals";
import type { ReportData } from "../lib/report/data";

function entry(query: string, impressions: number, position: number, ctr: number): SignalEntry {
  return {
    query,
    impressions,
    clicks: Math.round(impressions * ctr),
    position,
    ctr,
    impressionsDelta: 100,
    positionDelta: 1.5,
    score: 10,
  };
}

// Every section populated, and Serbian letters in the things that are never
// translated: the site name and the queries.
const DATA: ReportData = {
  siteName: "Optika Čajš",
  property: "https://optikacajs.rs/",
  window: { start: "2026-09-09", end: "2026-10-06" },
  measuredStart: "2026-09-09",
  measuredEnd: "2026-10-06",
  measuredDays: 28,
  hasPriorWindow: true,
  dataState: "ok",
  clicks: { recent: 1123, prior: 900, deltaPct: 24.8 },
  impressions: 45210,
  avgPosition: 8.43,
  breakdown: {
    brandImpressions: 12000,
    nonBrandImpressions: 20000,
    anonymizedImpressions: 13210,
    totalImpressions: 45210,
  },
  opportunities: [entry("naočare za sunce", 1500, 12.4, 0.012)],
  rising: [entry("kontaktna sočiva", 800, 9.1, 0.03)],
  declining: [],
  topPages: [{ page: "https://optikacajs.rs/naocare", clicks: 300, impressions: 9000, position: 5.2 }],
  trend: [
    { date: "2026-09-09", impressions: 1200, clicks: 30 },
    { date: "2026-09-10", impressions: null, clicks: null },
    { date: "2026-09-11", impressions: 1500, clicks: 41 },
  ],
  demand: {
    gaps: [
      {
        keyword: "dioptrijske naočare cena",
        intent: "commercial",
        source: "autocomplete",
        suggestRank: 1,
        risingPct: null,
        risingLabel: null,
        volume: null,
      },
    ],
    covered: 4,
    totalDiscovered: 5,
    byIntent: { commercial: 1, question: 0, local: 0, other: 0 },
    notCollected: false,
  },
  competitors: [{ domain: "diopta.rs", kind: "competitor", appearances: 5, bestPosition: 1 }],
  serpState: "ok",
  growth: {
    beforeStart: "2026-07-01",
    beforeEnd: "2026-07-30",
    afterStart: "2026-09-07",
    afterEnd: "2026-10-06",
    durationDays: 98,
    clicks: { before: 68, after: 85, deltaPct: 25 },
    impressions: { before: 569, after: 1123, deltaPct: 97.4 },
    position: { before: 12.1, after: 8.4 },
  },
};

// Text that is never translated and legitimately carries Serbian letters.
const NEVER_TRANSLATED = [
  "Optika Čajš",
  "naočare za sunce",
  "kontaktna sočiva",
  "dioptrijske naočare cena",
  "Aleksandar Radivojević",
];

const SERBIAN_WORDS = [
  "Sažetak", "Napredak", "Prikazi", "Prilike", "Kretanje", "Konkurencija",
  "izveštaj", "Najposećenije", "Tražnja", "klikova", "prikaza", "pozicija",
];

function render(lang: "sr" | "en", data: ReportData = DATA): string {
  return renderToStaticMarkup(<ReportDocument data={data} lang={lang} />);
}

describe("ReportDocument in English", () => {
  const html = render("en");

  it("declares its language and uses the English copy", () => {
    expect(html).toContain('lang="en"');
    for (const heading of ["SEO report", "Summary", "Progress", "Impressions over time",
      "Opportunities", "Movement", "Where impressions come from", "Most visited pages",
      "Demand you’re not reaching", "Competitors"]) {
      expect(html).toContain(heading);
    }
  });

  it("formats numbers and the period the US way", () => {
    expect(html).toContain("1,123");
    expect(html).toContain("45,210");
    expect(html).toContain("September 9 – October 6, 2026");
  });

  it("contains no Serbian outside names and queries", () => {
    let text = html;
    for (const kept of NEVER_TRANSLATED) text = text.split(kept).join("");
    for (const word of SERBIAN_WORDS) expect(text, word).not.toContain(word);
    expect(text).not.toMatch(/[čćđšž]/i);
  });

  it("keeps the names and queries untouched", () => {
    for (const kept of NEVER_TRANSLATED) expect(html).toContain(kept);
  });

  it("states missing data honestly, in English", () => {
    expect(render("en", { ...DATA, dataState: "not-collected" })).toContain(
      "No search data has been collected for this site yet",
    );
    expect(render("en", { ...DATA, dataState: "zero" })).toContain("a real zero");
  });
});

describe("ReportDocument in Serbian", () => {
  const html = render("sr");

  it("is today's Serbian report", () => {
    expect(html).toContain('lang="sr"');
    for (const heading of ["SEO izveštaj", "Sažetak", "Napredak", "Prikazi kroz vreme",
      "Prilike", "Kretanje", "Konkurencija"]) {
      expect(html).toContain(heading);
    }
    expect(html).toContain("1.123");
    expect(html).toContain("9. septembar – 6. oktobar 2026.");
  });
});

describe("report toolbar", () => {
  it("is only rendered when the page passes one", () => {
    expect(render("en")).not.toContain("print:hidden");
    const withToolbar = renderToStaticMarkup(
      <ReportDocument data={DATA} lang="en" toolbar={<span>tools</span>} />,
    );
    expect(withToolbar).toContain("print:hidden");
    expect(withToolbar).toContain("tools");
  });

  it("switch links to both languages and marks the current one", () => {
    const html = renderToStaticMarkup(
      <LanguageSwitch current="en" hrefFor={(l) => `/site/x/report?lang=${l}`} />,
    );
    expect(html).toContain('href="/site/x/report?lang=sr"');
    expect(html).toContain('href="/site/x/report?lang=en"');
    expect(html).toMatch(/aria-current="true"[^>]*>EN</);
  });

  it("PDF button uses the labels and link it is given", () => {
    const html = renderToStaticMarkup(
      <PrintButton
        href="/site/x/report/pdf?lang=en"
        labels={{ print: "Download PDF", busy: "Preparing PDF…", error: "Failed" }}
      />,
    );
    expect(html).toContain('href="/site/x/report/pdf?lang=en"');
    expect(html).toContain("Download PDF");
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd app && npx vitest run tests/report-document.test.tsx`
Expected: FAIL — `Cannot find module '../components/report/LanguageSwitch'`.

- [ ] **Step 4: Create `app/components/report/LanguageSwitch.tsx`**

```tsx
import { REPORT_LANGUAGES, type ReportLanguage } from "../../lib/report/language";

/**
 * SR / EN links for the report. Plain links that change `?lang=`, so the PDF
 * button and a reload keep the choice. Lives in the report's screen-only
 * toolbar, so it never prints.
 */
export default function LanguageSwitch({
  current,
  hrefFor,
}: {
  current: ReportLanguage;
  hrefFor: (lang: ReportLanguage) => string;
}) {
  return (
    <nav aria-label="Report language" className="flex items-center gap-1 text-sm">
      {REPORT_LANGUAGES.map((lang) => (
        <a
          key={lang}
          href={hrefFor(lang)}
          aria-current={lang === current ? "true" : undefined}
          className={
            lang === current
              ? "rounded-md bg-neutral-900 px-2 py-1 text-white"
              : "rounded-md px-2 py-1 text-neutral-600 hover:bg-neutral-100"
          }
        >
          {lang.toUpperCase()}
        </a>
      ))}
    </nav>
  );
}
```

- [ ] **Step 5: Give `PrintButton` its labels** — in `app/components/report/PrintButton.tsx`, delete the line `import { SR } from "../../lib/report/sr";`, and replace:

```tsx
export default function PrintButton({ href }: { href: string }) {
```

with:

```tsx
export default function PrintButton({
  href,
  labels,
}: {
  href: string;
  /** In the report's language, from the page. */
  labels: { print: string; busy: string; error: string };
}) {
```

Then replace `{SR.printError}` with `{labels.error}` and `{state === "busy" ? SR.printBusy : SR.print}` with `{state === "busy" ? labels.busy : labels.print}`.

- [ ] **Step 6: Create `app/components/report/ReportDocument.tsx`** — this is the body of today's `page.tsx` (lines 21–83 helpers and 134–441 JSX), with every `SR.` read from `t` and every `…Sr(` formatter from `f`:

```tsx
import type { ReactNode } from "react";

import ReportChart from "./ReportChart";
import ReportTable from "./ReportTable";
import type { ReportData } from "../../lib/report/data";
import { reportFormat } from "../../lib/report/format";
import { reportStrings, type ReportLanguage } from "../../lib/report/language";

/** A share of the total, or an em dash when the total is zero. */
function share(value: number, total: number, percent: (fraction: number) => string): string {
  return total > 0 ? percent(value / total) : "—";
}

/** Full URLs are unreadable in a table column; the path is what identifies a page. */
function pathOf(url: string): string {
  try {
    const { pathname, search } = new URL(url);
    return `${pathname}${search}` || "/";
  } catch {
    return url;
  }
}

/** Directional caret for a metric delta — a drawn mark, not a ▲/▼ glyph. */
function Caret({ up }: { up: boolean }) {
  return (
    <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path d={up ? "M5 2 8.5 7.5H1.5z" : "M5 8 1.5 2.5h7z"} fill="currentColor" />
    </svg>
  );
}

/** One before→after line in the growth section. A percentage rides along for
 *  clicks and impressions; a zero baseline shows "new" instead of an infinite
 *  number. Position passes `deltaPct: undefined` — its direction is carried by
 *  the numbers alone, since a "−60%" on a rank that improved reads as a loss. */
function GrowthRow({
  label,
  before,
  after,
  deltaPct,
  newLabel,
  percent,
}: {
  label: string;
  before: string;
  after: string;
  deltaPct?: number | null;
  newLabel: string;
  percent: (fraction: number) => string;
}) {
  return (
    <div className="rb-growth-row">
      <span className="lbl">{label}</span>
      <span className="val">
        <span className="from">{before}</span>
        <span className="arw">→</span>
        {after}
      </span>
      <span className="chg">
        {deltaPct === undefined ? null : deltaPct === null ? (
          <span className="rb-delta">{newLabel}</span>
        ) : deltaPct === 0 ? null : (
          <span className={`rb-delta${deltaPct > 0 ? " up" : ""}`}>
            <Caret up={deltaPct > 0} />
            {percent(Math.abs(deltaPct) / 100)}
          </span>
        )}
      </span>
    </div>
  );
}

/**
 * The client report document, in Serbian or English.
 *
 * A print document that happens to be served over HTTP: light colours are
 * literals rather than theme variables, the only interactive elements live in
 * the screen-only `toolbar`, and every section is `break-inside-avoid` so the
 * PDF never splits a finding across a page.
 *
 * `lang` is declared on the root so hyphenation, screen readers and the PDF
 * know the language; the root layout's `<html lang="en">` is wrong for a
 * Serbian report. The admin report page and piece 2's share page both render
 * this component; only their `toolbar` differs.
 */
export default function ReportDocument({
  data: d,
  lang,
  toolbar,
}: {
  data: ReportData;
  lang: ReportLanguage;
  toolbar?: ReactNode;
}) {
  const t = reportStrings(lang);
  const f = reportFormat(lang);
  // The measured span, not the nominal 28 days: optika-cajs once held 17, and
  // a header claiming 28 would have been false.
  const period = d.measuredStart && d.measuredEnd ? f.period(d.measuredStart, d.measuredEnd) : "—";

  return (
    <div lang={lang} className="report mx-auto w-full max-w-[210mm] bg-white text-neutral-900">
      {toolbar ? (
        <div className="flex items-center justify-end gap-4 p-4 print:hidden">{toolbar}</div>
      ) : null}

      {/* Page 1 — dark branded cover (full-bleed in print via @page cover). */}
      <div className="report-cover">
        <div className="rc-brand">
          <span className="deimos-logo rc-logo" role="img" aria-label="Deimos" />
        </div>
        <div className="rc-mid">
          <div className="rc-doctype">{t.docTitle}</div>
          <h1 className="rc-client">
            {d.siteName}
            <span className="serif">{period}</span>
          </h1>
          <hr className="rc-rule" />
        </div>
        <div className="rc-foot">
          <div>
            <div className="label">{t.preparedBy}</div>
            <strong>{t.author}</strong>
          </div>
          <div style={{ textAlign: "right" }}>
            <a href={`https://${t.authorSite}`}>{t.authorSite}</a>
          </div>
        </div>
      </div>

      {/* Page 2+ — light printable body. */}
      <div className="report-body">
        <div className="rb-head">
          <div className="wm">
            <span className="deimos-logo rb-logo" role="img" aria-label="Deimos" />
          </div>
          <div className="pg">
            {d.siteName} · {t.docTitle} · {period}
          </div>
        </div>

        {/* "Nothing was collected" and "everything was collected and the answer
            is zero" are different statements about the world, and the client
            deserves the honest one. */}
        {d.dataState === "not-collected" && <p className="rb-lead">{t.notCollected}</p>}
        {d.dataState === "zero" && <p className="rb-lead">{t.measuredZero}</p>}

        <section className="mb-8 break-inside-avoid">
          <h2 className="rb-sec">{t.summary}</h2>
          <div className="rb-kpis">
            <div className="rb-kpi">
              <div className="n">{f.int(d.clicks.recent)}</div>
              <div className="u">{f.plural(d.clicks.recent, t.clicks)}</div>
              {/* The one directional comparison gets the compact caret chip;
                  the non-directional shapes (no prior window, prior-with-no-
                  clicks, flat) are stated in full below, never as a 0%. */}
              {d.hasPriorWindow && d.clicks.deltaPct !== null && d.clicks.deltaPct !== 0 && (
                <div className={`rb-delta${d.clicks.deltaPct > 0 ? " up" : ""}`}>
                  <Caret up={d.clicks.deltaPct > 0} />
                  {f.percent(Math.abs(d.clicks.deltaPct) / 100)}
                </div>
              )}
            </div>
            <div className="rb-kpi">
              <div className="n">{f.int(d.impressions)}</div>
              <div className="u">{f.plural(d.impressions, t.impressions)}</div>
            </div>
            <div className="rb-kpi">
              <div className="n">{d.avgPosition === null ? "—" : f.decimal(d.avgPosition)}</div>
              <div className="u">{t.avgPosition}</div>
            </div>
          </div>
          {/* Three shapes, three sentences, no silence: no prior window at all,
              a prior window with no clicks to divide by, and a flat comparison. */}
          {!d.hasPriorWindow
            ? d.measuredStart && (
                <p className="mt-3 text-xs italic text-neutral-500">
                  {t.noPrior(f.date(d.measuredStart))}
                </p>
              )
            : d.clicks.deltaPct === null ? (
                <p className="mt-3 text-xs italic text-neutral-500">
                  {t.colClicks}: {t.noPriorClicks}
                </p>
              ) : (
                d.clicks.deltaPct === 0 && (
                  <p className="mt-3 text-xs italic text-neutral-500">
                    {t.colClicks}: {t.noChange}
                  </p>
                )
              )}
        </section>

        <section className="mb-8 break-inside-avoid">
          <h2 className="rb-sec">{t.growth}</h2>
          {d.growth === null ? (
            <p className="text-sm text-neutral-500">{t.growthEmpty}</p>
          ) : (
            <>
              <p className="mb-4 text-sm text-neutral-600">
                {t.growthLead(
                  `${f.int(Math.round(d.growth.durationDays / 30))} ${f.plural(
                    Math.round(d.growth.durationDays / 30),
                    t.months
                  )}`
                )}
              </p>
              <div className="rb-growth">
                <GrowthRow
                  label={t.growthClicks}
                  before={f.int(d.growth.clicks.before)}
                  after={f.int(d.growth.clicks.after)}
                  deltaPct={d.growth.clicks.deltaPct}
                  newLabel={t.growthNew}
                  percent={f.percent}
                />
                <GrowthRow
                  label={t.growthImpressions}
                  before={f.int(d.growth.impressions.before)}
                  after={f.int(d.growth.impressions.after)}
                  deltaPct={d.growth.impressions.deltaPct}
                  newLabel={t.growthNew}
                  percent={f.percent}
                />
                <GrowthRow
                  label={t.growthPosition}
                  before={d.growth.position.before === null ? "—" : f.decimal(d.growth.position.before)}
                  after={d.growth.position.after === null ? "—" : f.decimal(d.growth.position.after)}
                  newLabel={t.growthNew}
                  percent={f.percent}
                />
              </div>
            </>
          )}
        </section>

        <section className="mb-8 break-inside-avoid">
          <h2 className="rb-sec">{t.trend}</h2>
          {d.trend.length > 1 ? (
            <ReportChart points={d.trend} lang={lang} />
          ) : (
            <p className="text-sm text-neutral-500">{t.trendEmpty}</p>
          )}
        </section>

        <section className="mb-8 break-inside-avoid">
          <h2 className="rb-sec">{t.opportunities}</h2>
          {d.opportunities.length === 0 ? (
            <p className="text-sm text-neutral-500">{t.opportunitiesEmpty}</p>
          ) : (
            <>
              <p className="mb-3 text-sm text-neutral-600">{t.opportunitiesLead}</p>
              <ReportTable
                head={[t.colQuery, t.colPosition, t.colImpressions, t.colCtr]}
                numeric={[false, true, true, true]}
                rows={d.opportunities.map((o) => [
                  o.query,
                  f.decimal(o.position),
                  f.int(o.impressions),
                  f.percent(o.ctr),
                ])}
              />
            </>
          )}
        </section>

        <section className="mb-8 break-inside-avoid">
          <h2 className="rb-sec">{t.movement}</h2>
          {d.rising.length === 0 && d.declining.length === 0 ? (
            <p className="text-sm text-neutral-500">{t.movementEmpty}</p>
          ) : (
            <dl className="text-sm">
              <div className="mb-1.5">
                <dt className="inline font-medium">{t.movementRising}: </dt>
                <dd className="inline text-neutral-600">
                  {d.rising.length === 0 ? t.movementNone : d.rising.map((e) => e.query).join(", ")}
                </dd>
              </div>
              <div>
                <dt className="inline font-medium">{t.movementDeclining}: </dt>
                <dd className="inline text-neutral-600">
                  {d.declining.length === 0
                    ? t.movementNone
                    : d.declining.map((e) => e.query).join(", ")}
                </dd>
              </div>
            </dl>
          )}
        </section>

        <section className="mb-8 break-inside-avoid">
          <h2 className="rb-sec">{t.sources}</h2>
          <ReportTable
            head={["", t.colImpressions, ""]}
            numeric={[false, true, true]}
            rows={[
              [
                t.sourceBrand,
                f.int(d.breakdown.brandImpressions),
                share(d.breakdown.brandImpressions, d.breakdown.totalImpressions, f.percent),
              ],
              [
                t.sourceNonBrand,
                f.int(d.breakdown.nonBrandImpressions),
                share(d.breakdown.nonBrandImpressions, d.breakdown.totalImpressions, f.percent),
              ],
              [
                t.sourceAnonymous,
                f.int(d.breakdown.anonymizedImpressions),
                share(d.breakdown.anonymizedImpressions, d.breakdown.totalImpressions, f.percent),
              ],
            ]}
          />
          <p className="mt-3 text-xs italic text-neutral-500">{t.sourcesNote}</p>
        </section>

        <section className="mb-8 break-inside-avoid">
          <h2 className="rb-sec">{t.pages}</h2>
          {d.topPages.length === 0 ? (
            <p className="text-sm text-neutral-500">{t.pagesEmpty}</p>
          ) : (
            <ReportTable
              head={[t.colPage, t.colClicks, t.colImpressions, t.colPosition]}
              numeric={[false, true, true, true]}
              rows={d.topPages.map((p) => [
                pathOf(p.page),
                f.int(p.clicks),
                f.int(p.impressions),
                f.decimal(p.position),
              ])}
            />
          )}
        </section>

        <section className="mb-8">
          <h2 className="rb-sec">{t.demand}</h2>
          {d.demand.notCollected || d.demand.gaps.length === 0 ? (
            <p className="text-sm text-neutral-500">{t.demandEmpty}</p>
          ) : (
            <>
              <p className="mb-3 text-sm text-neutral-600">
                {t.demandLead(d.demand.gaps.length, f.plural(d.demand.gaps.length, t.keywords))}
              </p>
              <ReportTable
                head={[t.colQuery, ""]}
                rows={d.demand.gaps.slice(0, 20).map((g) => [g.keyword, t.demandIntent[g.intent]])}
              />
            </>
          )}
        </section>

        <section className="mb-8">
          <h2 className="rb-sec">{t.competitors}</h2>
          {d.serpState === "not-checked" ? (
            <p className="text-sm text-neutral-500">{t.competitorsEmpty}</p>
          ) : d.competitors.length === 0 ? (
            <p className="text-sm text-neutral-500">{t.competitorsEmptySerp}</p>
          ) : (
            <>
              <p className="mb-3 text-sm text-neutral-600">{t.competitorsLead}</p>
              <ReportTable
                head={[t.colDomain, t.colAppearances, t.colBest]}
                numeric={[false, true, true]}
                rows={d.competitors
                  .slice(0, 10)
                  .map((c) => [c.domain, f.int(c.appearances), f.int(c.bestPosition)])}
              />
            </>
          )}
        </section>

        <footer className="rb-foot">
          <span>{t.authorSite}</span>
          <span>{d.siteName}</span>
        </footer>
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Replace `app/app/site/[slug]/report/page.tsx` with the thin loader**

```tsx
import { notFound } from "next/navigation";
import { connection } from "next/server";
import type { Metadata } from "next";

import LanguageSwitch from "../../../../components/report/LanguageSwitch";
import PrintButton from "../../../../components/report/PrintButton";
import ReportDocument from "../../../../components/report/ReportDocument";
import { formatISODateUTC } from "../../../../lib/analysis/windows";
import { siteConfigBySlug, siteLanguage } from "../../../../lib/db";
import { buildReportData } from "../../../../lib/report/data";
import { reportFormat } from "../../../../lib/report/format";
import { reportStrings, resolveReportLanguage } from "../../../../lib/report/language";

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { slug } = await params;
  const config = siteConfigBySlug(slug);
  if (!config) return { title: reportStrings("sr").docTitle };

  const lang = resolveReportLanguage((await searchParams).lang, siteLanguage(config.property));
  const data = buildReportData(config, formatISODateUTC(new Date()));
  const period =
    data.measuredStart && data.measuredEnd
      ? reportFormat(lang).period(data.measuredStart, data.measuredEnd)
      : "";

  // The browser derives a print-dialog PDF's filename from the document title.
  return { title: `${config.displayName} — ${reportStrings(lang).docTitle} — ${period}` };
}

/**
 * The per-site client report, in the site's language unless `?lang=` asks
 * for the other one. The document itself is `ReportDocument`; this page
 * loads the data, resolves the language, and supplies the screen-only
 * toolbar (language switch and PDF download).
 */
export default async function ReportPage({ params, searchParams }: Props) {
  await connection();

  const { slug } = await params;
  const config = siteConfigBySlug(slug);
  if (!config) {
    notFound();
  }

  const lang = resolveReportLanguage((await searchParams).lang, siteLanguage(config.property));
  const t = reportStrings(lang);
  const data = buildReportData(config, formatISODateUTC(new Date()));
  const base = `/site/${slug}/report`;

  return (
    <ReportDocument
      data={data}
      lang={lang}
      toolbar={
        <>
          <LanguageSwitch current={lang} hrefFor={(l) => `${base}?lang=${l}`} />
          <PrintButton
            href={`${base}/pdf?lang=${lang}`}
            labels={{ print: t.print, busy: t.printBusy, error: t.printError }}
          />
        </>
      }
    />
  );
}
```

- [ ] **Step 8: Run the tests and the type check**

Run: `cd app && npx vitest run && npx tsc --noEmit && npm run lint`
Expected: all vitest files pass, `tsc` silent, lint `0 errors` (the 4 pre-existing warnings in `actions.ts` remain).

- [ ] **Step 9: Prove the Serbian report is unchanged** — with the dev server from Step 1 still running:

```bash
WORK=/tmp/claude-1000/-home-ar-Documents-GitHub-seo-cockpit/43a79ef2-95da-4f61-aad8-1c711ed1c2a9/scratchpad/bilingual
curl -s http://localhost:3999/site/optika-cajs/report > $WORK/after-sr.html
curl -s "http://localhost:3999/site/optika-cajs/report?lang=en" > $WORK/after-en.html
python3 - $WORK/before-sr.html $WORK/after-sr.html <<'EOF'
import html, re, sys

def text(path):
    s = open(path, encoding="utf-8").read()
    s = s[s.index('class="report-cover"'):]  # skip the toolbar, which is new
    s = re.sub(r"<script.*?</script>", " ", s, flags=re.S)
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s))).strip()

before, after = text(sys.argv[1]), text(sys.argv[2])
print("Serbian report text identical" if before == after else f"DIFFERENT\nbefore: {before[:1500]}\nafter:  {after[:1500]}")
EOF
grep -c 'lang="en"' $WORK/after-en.html; grep -o "September[^<]*2026" $WORK/after-en.html | head -2
```

Expected: `Serbian report text identical`; the English page contains `lang="en"` and an English period.

- [ ] **Step 10: Commit**

```bash
git add app/components/report/ReportDocument.tsx app/components/report/LanguageSwitch.tsx \
        app/components/report/PrintButton.tsx "app/app/site/[slug]/report/page.tsx" \
        app/tests/report-document.test.tsx
git commit -m "Render the client report in the chosen language, with an SR / EN switch"
```

---

### Task 7: Print the PDF in the chosen language

**Files:**
- Modify: `app/lib/report/pdf.ts` (`internalReportUrl` optional `lang`; new `reportPdfFilenameFor`)
- Modify: `app/app/site/[slug]/report/pdf/route.ts`
- Test: `app/tests/report-pdf-lang.test.ts` (new), `app/tests/basic-auth.test.ts` (append only)

**Interfaces:**
- Consumes: `resolveReportLanguage`, `reportStrings`, `ReportLanguage` (Tasks 2, 4); `reportFormat` (Task 5); `siteLanguage` (Task 2).
- Produces:
  - `internalReportUrl(slug: string, requestUrl: string, lang?: ReportLanguage): string` — `?lang=` before `render=`; unchanged output when `lang` is omitted.
  - `reportPdfFilenameFor(siteName: string, lang: ReportLanguage, measuredStart: string | null, measuredEnd: string | null): string`

- [ ] **Step 1: Write the failing tests** — create `app/tests/report-pdf-lang.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";

import { contentDispositionAttachment, internalReportUrl, reportPdfFilenameFor } from "../lib/report/pdf";

const ORIGINAL = { PORT: process.env.PORT, PW: process.env.SEO_DASHBOARD_PASSWORD };

afterEach(() => {
  if (ORIGINAL.PORT === undefined) delete process.env.PORT;
  else process.env.PORT = ORIGINAL.PORT;
  if (ORIGINAL.PW === undefined) delete process.env.SEO_DASHBOARD_PASSWORD;
  else process.env.SEO_DASHBOARD_PASSWORD = ORIGINAL.PW;
});

describe("reportPdfFilenameFor", () => {
  it("names the English PDF in English", () => {
    expect(reportPdfFilenameFor("Optika Cajs", "en", "2026-09-09", "2026-10-06")).toBe(
      "Optika Cajs - SEO report - September 9 – October 6, 2026.pdf",
    );
  });

  it("names the Serbian PDF exactly as before", () => {
    expect(reportPdfFilenameFor("Optika Cajs", "sr", "2026-09-09", "2026-10-06")).toBe(
      "Optika Cajs - SEO izveštaj - 9. septembar – 6. oktobar 2026.pdf",
    );
  });

  it("keeps a Serbian site name in an English filename, with an ASCII fallback", () => {
    const name = reportPdfFilenameFor("Optika Čajš", "en", "2026-09-09", "2026-10-06");
    expect(name).toBe("Optika Čajš - SEO report - September 9 – October 6, 2026.pdf");
    expect(contentDispositionAttachment(name)).toContain("filename*=UTF-8''");
  });
});

describe("internalReportUrl with a language", () => {
  it("adds lang when auth is off", () => {
    delete process.env.SEO_DASHBOARD_PASSWORD;
    process.env.PORT = "3000";
    expect(internalReportUrl("skedio", "http://localhost:3000/", "en")).toBe(
      "http://127.0.0.1:3000/site/skedio/report?lang=en",
    );
  });

  it("adds lang before the render token when auth is on", () => {
    process.env.SEO_DASHBOARD_PASSWORD = "pw";
    process.env.PORT = "3000";
    expect(internalReportUrl("skedio", "http://localhost:3000/", "en")).toMatch(
      /^http:\/\/127\.0\.0\.1:3000\/site\/skedio\/report\?lang=en&render=[\w-]+$/,
    );
  });
});
```

Append to `app/tests/basic-auth.test.ts`, inside the existing `describe("proxy", …)` block (after its last `it`):

```ts
  it("passes the English PDF render URL", () => {
    process.env.SEO_DASHBOARD_PASSWORD = "pw";
    process.env.PORT = "3000";
    const url = internalReportUrl(
      "skedio",
      "http://192.168.1.156:8091/site/skedio/report/pdf",
      "en",
    );
    expect(url).toContain("?lang=en&render=");
    expect(passesThrough(proxy(new NextRequest(url)))).toBe(true);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd app && npx vitest run tests/report-pdf-lang.test.ts tests/basic-auth.test.ts`
Expected: FAIL — `reportPdfFilenameFor is not a function`, and the URL lacks `lang`.

- [ ] **Step 3: Implement in `app/lib/report/pdf.ts`** — add to the imports:

```ts
import { reportFormat } from "./format";
import { reportStrings, type ReportLanguage } from "./language";
```

Replace the body of `internalReportUrl` (keep its doc comment, adding the last paragraph below) with:

```ts
 *
 * `lang` is passed through so the PDF is printed in the language the reader
 * chose; omitted, the page uses the site's default.
 */
export function internalReportUrl(slug: string, requestUrl: string, lang?: ReportLanguage): string {
  const port = process.env.PORT ?? new URL(requestUrl).port ?? "3000";
  const url = `http://127.0.0.1:${port || "3000"}/site/${encodeURIComponent(slug)}/report`;
  const params = new URLSearchParams();
  if (lang) params.set("lang", lang);
  const auth = basicAuthConfig();
  if (auth) params.set(RENDER_TOKEN_PARAM, reportRenderToken(auth));
  const query = params.toString();
  return query ? `${url}?${query}` : url;
}
```

Directly after `reportPdfFilename`, add:

```ts
/**
 * The downloaded PDF's name in `lang`: `{site} - {report title} - {period}.pdf`.
 * Without a measured span the title stands in for the period, as before.
 */
export function reportPdfFilenameFor(
  siteName: string,
  lang: ReportLanguage,
  measuredStart: string | null,
  measuredEnd: string | null
): string {
  const t = reportStrings(lang);
  const period =
    measuredStart && measuredEnd ? reportFormat(lang).period(measuredStart, measuredEnd) : t.docTitle;
  return reportPdfFilename(`${siteName} - ${t.docTitle}`, period);
}
```

- [ ] **Step 4: Use them in the route** — replace `app/app/site/[slug]/report/pdf/route.ts`'s imports and `GET` body with:

```ts
import { formatISODateUTC } from "../../../../../lib/analysis/windows";
import { siteConfigBySlug, siteLanguage } from "../../../../../lib/db";
import { buildReportData } from "../../../../../lib/report/data";
import { resolveReportLanguage } from "../../../../../lib/report/language";
import {
  contentDispositionAttachment,
  internalReportUrl,
  renderPdf,
  reportPdfFilenameFor,
} from "../../../../../lib/report/pdf";
```

(keep the existing doc comment and `export const dynamic = "force-dynamic";`), then:

```ts
export async function GET(request: Request, ctx: RouteContext<"/site/[slug]/report/pdf">) {
  const { slug } = await ctx.params;

  const config = siteConfigBySlug(slug);
  if (!config) {
    return new Response("Not found", { status: 404 });
  }

  const lang = resolveReportLanguage(
    new URL(request.url).searchParams.get("lang"),
    siteLanguage(config.property)
  );
  const data = buildReportData(config, formatISODateUTC(new Date()));

  let pdf: Buffer;
  try {
    pdf = await renderPdf(internalReportUrl(slug, request.url, lang));
  } catch (err) {
    // Surfaced as text so the button can show its own localized failure
    // message instead of downloading a zero-byte file the client would open
    // and find empty.
    console.error("[report-pdf] render failed", err);
    return new Response("PDF rendering failed", { status: 500 });
  }

  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(pdf.byteLength),
      "Content-Disposition": contentDispositionAttachment(
        reportPdfFilenameFor(config.displayName, lang, data.measuredStart, data.measuredEnd)
      ),
      // The window moves daily and the render is expensive; a cached copy
      // would hand a client last week's numbers under this week's filename.
      "Cache-Control": "no-store",
    },
  });
}
```

- [ ] **Step 5: Run the tests and the type check**

Run: `cd app && npx vitest run && npx tsc --noEmit && npm run lint`
Expected: all pass, `tsc` silent, lint `0 errors`.

- [ ] **Step 6: Commit**

```bash
git add app/lib/report/pdf.ts "app/app/site/[slug]/report/pdf/route.ts" \
        app/tests/report-pdf-lang.test.ts app/tests/basic-auth.test.ts
git commit -m "Print the report PDF in the chosen language"
```

---

### Task 8: Verify real output, get the English proofread, then deploy

No code; this is the evidence and the release. Stop the Task 6 dev server first (find its PID by port: `ss -ltnp | grep ':3999 '`, then `kill <pid>`; never `pkill -f` a pattern that matches your own shell).

- [ ] **Step 1: Full suites**

Run: `collector/.venv/bin/python -m pytest -q collector` and `cd app && npx vitest run && npx tsc --noEmit && npm run lint`
Expected: pytest 240 passed; vitest all passed; `tsc` silent; lint `0 errors`.

- [ ] **Step 2: Migrate a DB copy and set one site to English**

```bash
WORK=/tmp/claude-1000/-home-ar-Documents-GitHub-seo-cockpit/43a79ef2-95da-4f61-aad8-1c711ed1c2a9/scratchpad/bilingual
cd collector && .venv/bin/python - "$WORK/seo.db" <<'EOF'
import sqlite3, sys
from seocockpit.db import init_db
conn = init_db(sys.argv[1])
conn.execute("UPDATE sites SET language = 'en' WHERE slug = 'skedio'")
conn.commit()
print(conn.execute("SELECT slug, language FROM sites ORDER BY slug").fetchall())
EOF
```

Expected: every site `sr` except `skedio` → `en`.

- [ ] **Step 3: Production build with auth, both PDFs**

Build, then assemble the standalone tree the way `deploy/Dockerfile.dashboard` does (standalone output, plus `.next/static` and `public/` copied in), and start it with auth on:

```bash
WORK=/tmp/claude-1000/-home-ar-Documents-GitHub-seo-cockpit/43a79ef2-95da-4f61-aad8-1c711ed1c2a9/scratchpad/bilingual
(cd app && npx next build > $WORK/build.log 2>&1); tail -3 $WORK/build.log
rm -rf $WORK/standalone && cp -r app/.next/standalone $WORK/standalone
cp -r app/.next/static $WORK/standalone/.next/static && cp -r app/public $WORK/standalone/public
(cd $WORK/standalone && NODE_ENV=production PORT=3998 HOSTNAME=127.0.0.1 SEO_DASHBOARD_PASSWORD=pw \
  SEO_DB_PATH=$WORK/seo.db node server.js > $WORK/standalone.log 2>&1 &)
until curl -s -o /dev/null http://127.0.0.1:3998/; do sleep 1; done
for lang in sr en; do
  curl -s -u acko:pw -D $WORK/pdf-$lang.headers -o $WORK/optika-$lang.pdf \
    "http://127.0.0.1:3998/site/optika-cajs/report/pdf?lang=$lang"
  grep -i "content-disposition" $WORK/pdf-$lang.headers
done
curl -s -u acko:pw -o /dev/null -D - "http://127.0.0.1:3998/site/skedio/report/pdf" | grep -i "content-disposition"
echo "Serbian words in the English PDF: $(pdftotext $WORK/optika-en.pdf - | grep -cE 'Sažetak|Prikazi|izveštaj|Prilike|Kretanje|Konkurencija|klikova')"
echo "401 text in either PDF: $(pdftotext $WORK/optika-en.pdf - | grep -c 'Authentication required')$(pdftotext $WORK/optika-sr.pdf - | grep -c 'Authentication required')"
pdftoppm -png -r 50 -f 1 -l 1 $WORK/optika-sr.pdf $WORK/cover-sr
pdftoppm -png -r 50 -f 1 -l 1 $WORK/optika-en.pdf $WORK/cover-en
```

Expected: the Serbian header names `SEO izve%C5%A1taj` / `9. septembar`; the English one `SEO report` / `September`; skedio with no `?lang=` downloads in English (its site default); both counts `0` (`00` for the second line). Open `cover-sr-1.png` and `cover-en-1.png` with the Read tool: the Deimos logo is on both covers. Stop the server afterwards by its port (`ss -ltnp | grep ':3998 '`, then `kill <pid>`).

- [ ] **Step 4: Hand the English PDF to Aleksandar for proofreading** — copy `$WORK/optika-en.pdf` to `~/Downloads/optika-cajs-report-en-proof.pdf` and ask him to proofread it. Apply any wording changes to `app/lib/report/en.ts` (re-run `npx vitest run tests/report-strings-en.test.ts tests/report-document.test.tsx`) and commit them as `Revise the English report wording`.

- [ ] **Step 5: Push and deploy — only with Aleksandar's go-ahead**

```bash
git push origin main
gh run list --limit 1   # watch CI: gh run watch <id> --exit-status
```

On the Pi (both images change: the collector migrates `sites.language`): check no collection is running (`collection_runs` has no `running` row), then `git -C ~/server/seo-cockpit/src pull --ff-only`, build both images detached as on 2026-10-09 (`nohup … docker compose build seo-cockpit-collector seo-cockpit-dashboard …`), `docker compose up -d seo-cockpit-collector seo-cockpit-dashboard`, `docker image prune -f && docker builder prune -f`.

- [ ] **Step 6: Verify on the Pi** — the `language` column appears at the next collection run (the collector migrates in `init_db`), and the dashboard reads Serbian until then, so everything below works immediately. Fetch both PDFs from inside the dashboard container with its own environment, so the password is never printed or leaves the Pi:

```bash
ssh acko@192.168.1.156 'docker logs seo-cockpit-dashboard 2>&1 | grep "\[auth\]"'
for lang in sr en; do
  ssh acko@192.168.1.156 "docker exec -i seo-cockpit-dashboard node - $lang" <<'JS' > $WORK/pi-optika-$lang.pdf
const lang = process.argv[2];
const auth = "Basic " + Buffer.from(`${process.env.SEO_DASHBOARD_USER || "acko"}:${process.env.SEO_DASHBOARD_PASSWORD}`).toString("base64");
fetch(`http://127.0.0.1:3000/site/optika-cajs/report/pdf?lang=${lang}`, { headers: { authorization: auth } })
  .then(async (r) => {
    console.error(lang, r.status, r.headers.get("content-type"), r.headers.get("content-disposition"));
    process.stdout.write(Buffer.from(await r.arrayBuffer()));
  });
JS
done
echo "Serbian words in the Pi's English PDF: $(pdftotext $WORK/pi-optika-en.pdf - | grep -cE 'Sažetak|Prikazi|izveštaj|Prilike|Kretanje|Konkurencija|klikova')"
```

Expected: `[auth] Basic auth enabled`; both fetches `200 application/pdf` with filenames in their language; the count `0`. Optika's default stays Serbian: the `sr` filename is the one a plain `/site/optika-cajs/report/pdf` (no `?lang=`) produces.
