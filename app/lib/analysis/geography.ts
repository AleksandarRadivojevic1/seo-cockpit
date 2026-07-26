import type { CountryRow } from "../db";
import { lookupCountry } from "../iso-3166";

export interface CountryTotal {
  /** GSC's lowercase alpha-3 code, e.g. "srb". */
  code: string;
  /** English display name, or the raw uppercased code when unrecognised. */
  name: string;
  /**
   * world-atlas join key (numeric ISO id, or feature name for the handful of
   * features with no ISO assignment). Empty when this code has no feature in
   * the atlas — such a country is listed but not drawn.
   */
  atlasKey: string;
  clicks: number;
  impressions: number;
  /** Share of the window's total impressions, 0-1. */
  share: number;
}

export interface CountryBreakdown {
  countries: CountryTotal[];
  totalImpressions: number;
  totalClicks: number;
  /** Countries with at least one impression. */
  countryCount: number;
  /**
   * Countries that have impressions but no atlas feature, so they appear in
   * the list and not on the map. Surfaced in the UI rather than dropped.
   */
  unmapped: CountryTotal[];
}

/**
 * The upper bound of each colour bin, ascending. A country's impressions fall
 * in the first bin whose bound they do not exceed; anything above the last
 * bound lands in the top bin.
 *
 * Bins rather than a continuous ramp because the real distribution is extreme:
 * on optikacajs, Serbia has 214 impressions and six other countries have
 * exactly 1. A linear ramp maps those six to a tint indistinguishable from
 * "no impressions", turning six real markets into apparent absences. Bins
 * guarantee that 1 impression is visibly different from 0.
 */
export const COUNTRY_BINS = [2, 10, 50] as const;

/** Number of colour steps: one per bin bound, plus the open-ended top bin. */
export const COUNTRY_BIN_COUNT = COUNTRY_BINS.length + 1;

/**
 * Returns the 0-based colour bin for an impression count.
 *
 * Zero and negative counts return -1, meaning "no impressions" — a distinct
 * state that must NOT be rendered as the palest step of the ramp. This is the
 * same null-vs-zero distinction the rest of this project enforces, in its
 * geographic form: an unshaded country means measured zero, and it has to look
 * different from a country with one impression.
 */
export function countryBin(impressions: number): number {
  if (impressions <= 0) return -1;
  for (let i = 0; i < COUNTRY_BINS.length; i += 1) {
    if (impressions <= COUNTRY_BINS[i]) return i;
  }
  return COUNTRY_BINS.length;
}

/** Human-readable label for a bin index, for the legend. */
export function binLabel(bin: number): string {
  if (bin < 0) return "No impressions";
  const lower = bin === 0 ? 1 : COUNTRY_BINS[bin - 1] + 1;
  const upper = bin < COUNTRY_BINS.length ? COUNTRY_BINS[bin] : null;
  if (upper === null) return `${lower}+`;
  return lower === upper ? `${lower}` : `${lower}–${upper}`;
}

/**
 * Aggregates per-country rows into a ranked breakdown plus map metadata.
 *
 * Shares are computed against the sum of these rows, which for the country
 * dimension IS the site total — GSC does not anonymize country the way it
 * anonymizes queries (verified: 223 of 223 impressions attributed on
 * optikacajs, 17 of 17 on skedio). So unlike `buildBrandBreakdown` there is no
 * unattributed remainder to carry.
 *
 * Rows with an unrecognised code are kept, not discarded: they hold real
 * impressions, and dropping them would quietly shrink the total that every
 * share is measured against.
 */
export function buildCountryBreakdown(rows: CountryRow[]): CountryBreakdown {
  const byCode = new Map<string, { clicks: number; impressions: number }>();

  for (const row of rows) {
    const code = row.country.toLowerCase();
    const entry = byCode.get(code) ?? { clicks: 0, impressions: 0 };
    entry.clicks += row.clicks;
    entry.impressions += row.impressions;
    byCode.set(code, entry);
  }

  let totalImpressions = 0;
  let totalClicks = 0;
  for (const e of byCode.values()) {
    totalImpressions += e.impressions;
    totalClicks += e.clicks;
  }

  const countries: CountryTotal[] = [...byCode.entries()]
    .map(([code, e]) => {
      const iso = lookupCountry(code);
      return {
        code,
        name: iso?.name ?? code.toUpperCase(),
        atlasKey: iso?.key ?? "",
        clicks: e.clicks,
        impressions: e.impressions,
        share: totalImpressions > 0 ? e.impressions / totalImpressions : 0,
      };
    })
    .sort((a, b) => b.impressions - a.impressions || a.name.localeCompare(b.name));

  return {
    countries,
    totalImpressions,
    totalClicks,
    countryCount: countries.filter((c) => c.impressions > 0).length,
    unmapped: countries.filter((c) => c.atlasKey === "" && c.impressions > 0),
  };
}
