import type { MetricKey } from "../cwv-format";

/**
 * Serbian **Latin** locale.
 *
 * The `-Latn` subtag is load-bearing: `sr-RS` resolves to Cyrillic (`јул`),
 * which neither client site uses. Verified against Node's ICU 2026-07-27.
 *
 * `Intl` falls back to `en-US` *silently* when a locale is unavailable, so a
 * trimmed-ICU runtime would produce decimal points and English month names
 * with no error anywhere. The report tests pin the output rather than the
 * locale tag alone.
 */
export const SR_LOCALE = "sr-Latn-RS";

const INT = new Intl.NumberFormat(SR_LOCALE, { maximumFractionDigits: 0 });
const DECIMAL_1 = new Intl.NumberFormat(SR_LOCALE, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const PERCENT_1 = new Intl.NumberFormat(SR_LOCALE, {
  style: "percent",
  maximumFractionDigits: 1,
});
const PLURAL = new Intl.PluralRules(SR_LOCALE);
const MONTH_FMT = new Intl.DateTimeFormat(SR_LOCALE, { month: "long", timeZone: "UTC" });

/** Whole numbers: impressions, clicks, keyword counts. */
export function formatIntSr(n: number): string {
  return INT.format(n);
}

/**
 * Comma-separated decimals. Serbian writes `5,3`; a decimal point marks the
 * document as machine-made, so the report cannot reuse the dashboard's
 * number formatting.
 */
export function formatDecimalSr(n: number, digits = 1): string {
  if (digits === 1) return DECIMAL_1.format(n);
  return new Intl.NumberFormat(SR_LOCALE, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
}

/** Takes a fraction (`0.753`), emits `75,3%`. */
export function formatPercentSr(fraction: number): string {
  return PERCENT_1.format(fraction);
}

/**
 * A Core Web Vitals value in Serbian.
 *
 * The dashboard's `formatMetricValue` cannot be reused here: it builds CLS
 * with `toFixed(3)`, which is locale-independent and emits `0.000` with a
 * decimal **point**. One stray point in an otherwise Serbian document is
 * exactly the kind of tell that makes it read as machine-translated — caught
 * by proofreading the printed PDF, not by any unit test that existed then.
 *
 * `null` is not accepted: an unmeasured metric is a sentence ("nije mereno"),
 * not a formatted number, and the caller must have already said so.
 */
export function formatCwvValueSr(value: number, metric: MetricKey): string {
  if (metric === "cls") return formatDecimalSr(value, 3);
  return `${formatIntSr(Math.round(value))} ms`;
}

/**
 * Splits an ISO `YYYY-MM-DD` into its calendar parts without going through
 * local time. Formatting a `Date` without an explicit UTC `timeZone` shifts
 * the day backwards in any timezone west of Greenwich, which would silently
 * misdate every report period.
 */
function utcParts(iso: string): { day: number; month: number; year: number } {
  const [year, month, day] = iso.split("-").map(Number);
  return { day, month, year };
}

function monthName(iso: string): string {
  const { year, month, day } = utcParts(iso);
  return MONTH_FMT.format(new Date(Date.UTC(year, month - 1, day)));
}

/** `23. jul 2026.` — Serbian writes a trailing dot after the year. */
export function formatDateSr(iso: string): string {
  const { day, year } = utcParts(iso);
  return `${day}. ${monthName(iso)} ${year}.`;
}

/**
 * The measured period, spelled out.
 *
 * Deliberately never says "poslednjih 28 dana": the real windows are shorter
 * than 28 days whenever collection started recently (optika-cajs holds 17),
 * so a header claiming 28 would be false on the first site this is used for.
 */
export function formatPeriodSr(startISO: string, endISO: string): string {
  const s = utcParts(startISO);
  const e = utcParts(endISO);
  if (s.year === e.year && s.month === e.month) {
    return `${s.day}–${e.day}. ${monthName(endISO)} ${e.year}.`;
  }
  if (s.year === e.year) {
    return `${s.day}. ${monthName(startISO)} – ${e.day}. ${monthName(endISO)} ${e.year}.`;
  }
  return `${formatDateSr(startISO)} – ${formatDateSr(endISO)}`;
}

/**
 * Serbian has three plural forms, not two: `1 klik` / `33 klika` /
 * `5 klikova`. `Intl.PluralRules` classifies them as one/few/other, so no
 * hand-written table is needed. Pass `[one, few, other]`.
 */
export function pluralSr(n: number, forms: [string, string, string]): string {
  const category = PLURAL.select(n);
  if (category === "one") return forms[0];
  if (category === "few") return forms[1];
  return forms[2];
}
