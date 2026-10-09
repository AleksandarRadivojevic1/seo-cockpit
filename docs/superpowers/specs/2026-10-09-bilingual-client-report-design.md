# Bilingual client report (Serbian + English) — design

**Date:** 2026-10-09
**Status:** Design approved in conversation; spec awaiting review
**Part of:** client access, piece 1 of 2. Piece 2 is client share links
(`2026-09-14-client-share-links-design.md`, to be revised next), which reuses
the language selection defined here.

## Goal

The client report (`/site/[slug]/report` and its PDF) can be produced in
**Serbian or English**. Serbian clients keep today's report unchanged; US
clients get an English one. Everything else stays English as it is today: the
admin dashboard, the proposal page, and the client live view planned in
piece 2.

## Decisions

1. **The language is a per-site default, plus a switch.** Each site has a
   `language` of `sr` or `en`, default `sr`. The report page shows an SR / EN
   switch so a reader can flip it; the PDF follows whichever is active.
2. **Approach: two string files and language-aware formatting.** `en.ts`
   beside the existing `sr.ts`, with the same shape enforced by the compiler.
   No i18n library: two languages on one page don't justify message catalogs,
   locale routing, or runtime negotiation (the reasoning already in `sr.ts`'s
   header). A copied English page was rejected because the two would drift.
3. **US English.** Plain, client-facing, keeping the report's honesty wording
   (not-collected vs measured-zero, absent prior window, anonymized share).
   Drafted by Claude, proofread by Aleksandar before it ships to a client.
4. **Never translated:** search queries, demand keywords, competitor domains,
   page URLs (they are what people typed or what exists), the author's name,
   `deimos.agency`, and "CTR".

## Language selection

### Where it is set

- **`sites.yaml`:** optional `language: en` per site. Absent means `sr`.
- **Add-site form:** a Language select (Serbian / English, default Serbian),
  saved as `language` in `config/user-sites.json`.
- **Collector:** `Site` gains `language: str = "sr"`. Parsed in both
  `load_config` and `_site_from_dict`. A value other than `sr`/`en` is logged
  and treated as `sr`, never fatal, matching how a bad user-sites entry is
  handled, so a typo can't stop a collection run.
- **`sites` table:** new column `language TEXT NOT NULL DEFAULT 'sr'`, added by
  the existing `_migrate_sites` (same pattern as `active`). `upsert_sites`
  writes it, defaulting a row without `language` to `sr` so callers (and the
  existing tests) that don't pass one keep working.

### How the dashboard reads it

- New `siteLanguage(property, db): "sr" | "en"` in `lib/db.ts`. Returns `sr` when
  the column is missing (a database the collector hasn't migrated yet, the same
  tolerance as `active`), when the value is null, or when it is anything other
  than `en`.
- **`SiteConfig` is not widened.** Existing tests compare site configs with
  exact equality; a separate read keeps them valid and keeps the language out
  of every caller that doesn't need it.
- `UserSite` gains an **optional** `language`. `fromDisk` passes it through only
  when present and `toDisk` writes it when set, so the existing round-trip
  behaviour (and test) is unchanged for files without it. This also fixes the
  write-back dropping the key: the dashboard otherwise discards keys it doesn't
  know when it rewrites the file.

### How a request resolves it

`resolveReportLanguage(param, siteDefault)`: `?lang=sr` or `?lang=en` wins;
anything else (absent, empty, `de`, mixed case) falls back to the site default.
Pure function, used by the report page and the PDF route.

## Strings

- `lib/report/en.ts` exports `EN`, typed `ReportStrings`.
- `ReportStrings` is derived from `typeof SR` with literal types widened
  (string literals → `string`, the three-slot plural tuples → `[string, string,
  string]`, the sentence functions keep their signatures, `demandIntent` keeps
  its keys). A missing, extra, or misshapen entry in `EN` is a compile error.
- `reportStrings(lang)` returns `SR` or `EN`.
- **Plurals:** Serbian needs three forms (one / few / other). Each language
  keeps three slots; English fills the third with the same form as the second
  (`["click", "clicks", "clicks"]`), since English plural rules never select
  "few". One shape, one plural function.
- `sr.ts` header comment updated to say a second language now exists.

## Formatting

`lib/report/format.ts` gains a per-language set, bound to an `Intl` locale
(`sr-Latn-RS` or `en-US`):

| | Serbian (unchanged) | English |
|---|---|---|
| Integer | `1.123` | `1,123` |
| Decimal (1 digit) | `2,4` | `2.4` |
| Percent | `97,4%` | `97.4%` |
| Date | `9. septembar 2026.` | `September 9, 2026` |
| Period, same month | `1–28. septembar 2026.` | `September 1–28, 2026` |
| Period, same year | `9. septembar – 6. oktobar 2026.` | `September 9 – October 6, 2026` |
| Period, across years | `20. decembar 2026. – 5. januar 2027.` | `December 20, 2026 – January 5, 2027` |
| Plural | `1 klik`, `2 klika`, `5 klikova` | `1 click`, `2 clicks` |

- `reportFormat(lang)` returns `{ int, decimal, percent, date, period, plural }`.
- The existing `formatIntSr`, `formatDecimalSr`, `formatPercentSr`,
  `formatDateSr`, `formatPeriodSr` and `pluralSr` stay exported and unchanged:
  they become the Serbian set, so the existing format tests stay valid.
- All date math stays UTC (`utcParts`), as today.

## Rendering

- **The report body becomes a component**, `ReportDocument({ data, lang })`,
  rendering from `reportStrings(lang)` and `reportFormat(lang)`. `page.tsx`
  keeps loading (`connection()`, `siteConfigBySlug`, `buildReportData`,
  language resolution) and renders `ReportDocument`. This makes the report
  renderable in tests without a server, and piece 2's share route renders the
  same component.
- **The report root carries `lang="sr"` or `lang="en"`.** Today the Serbian
  report sits inside the root layout's `<html lang="en">`; declaring the
  language on the report element fixes hyphenation, screen readers and the
  PDF's language.
- **SR / EN switch:** two links to the same report with `?lang=sr` / `?lang=en`,
  the active one marked, `print:hidden` so the PDF never shows it.
- **`PrintButton`** already receives its PDF link as an `href` prop from the
  page; the page now passes `/site/<slug>/report/pdf?lang=<active>`, plus the
  button's three labels from the active strings ("Sačuvaj kao PDF" /
  "Download PDF", and the busy and error messages) as a prop. Piece 2's share
  page passes its own `href` the same way.
- **`ReportChart`** formats its axis numbers with the active formatter.
- **`TrendPointSr`** holds no Serbian text (ISO dates and numbers); its name is
  left alone.

## PDF route

`/site/[slug]/report/pdf?lang=` resolves the language the same way, then:

- `internalReportUrl(slug, requestUrl, lang)` adds `lang` to the URL chromium
  prints, alongside the existing render token. `proxy.ts` only inspects the
  `render` parameter, so the extra parameter needs no auth change.
- **Filename** = `{site name} - {docTitle} - {period}.pdf` in that language,
  through the existing `reportPdfFilename` (which already drops the period's
  trailing dot) and `contentDispositionAttachment` (ASCII fallback plus RFC 5987
  UTF-8 name). Examples:
  - `Optika Cajs - SEO izveštaj - 9. septembar – 6. oktobar 2026.pdf`
  - `Optika Cajs - SEO report - September 9 – October 6, 2026.pdf`
- The route's failure response stays as it is: the button shows the localized
  error message, not the response body.

## Testing

- **String parity:** `EN` and `SR` have the same keys (also a compile error);
  no entry is empty; every sentence function returns non-empty text for
  sample arguments; every plural slot is non-empty.
- **No Serbian in English:** `ReportDocument` rendered with `lang="en"` over a
  fixture contains none of a list of Serbian-only words ("Sažetak", "Prikazi",
  "izveštaj", "Prilike", "Kretanje", …) and no `č ć đ š ž` outside the
  fixture's own names and queries.
- **Serbian unchanged:** the Serbian render still contains today's headings,
  and the existing report tests pass untouched.
- **Formatters:** every row of the table above, for both languages; existing
  Serbian format tests untouched.
- **Language resolution:** `?lang=en` → en; absent, empty, invalid → site
  default; `siteLanguage` on a database without the column → `sr`; on `en` →
  `en`; on garbage → `sr`.
- **Collector:** `language` parsed from `sites.yaml` and user-sites, default
  `sr`; an invalid value logged and treated as `sr`; the migration adds the
  column to an existing table; `upsert_sites` writes it and defaults a row
  without it.
- **Add-site:** the action saves `language` to `user-sites.json`; a file
  without it round-trips unchanged.
- **PDF:** filename per language; the internal URL carries `lang` and the render
  token, and passes `proxy.ts`.
- **Real output:** Optika's report printed to PDF in both languages, the English
  text checked for Serbian, the Serbian one compared with today's; Aleksandar
  proofreads the English. After deploy, both PDFs checked again on the Pi.

## Out of scope

- Client share links and the client live view (piece 2).
- The admin dashboard, the proposal page and the proposal Markdown (stay
  English).
- Per-site market for autocomplete / Trends / SERPs (review §3.1) and multiple
  brand tokens (§3.3): separate work. A US site set to `en` still gets Serbian
  demand data until §3.1 lands.
- Languages beyond Serbian and English.
