/**
 * Generates `lib/iso-3166.ts` — the lookup that joins GSC's country codes to
 * world-atlas features.
 *
 * Run with:  node --experimental-strip-types scripts/gen-iso-3166.ts
 *
 * Why this is generated rather than hand-written: there are 249 ISO 3166-1
 * codes and getting one numeric wrong silently mislocates a country on the map
 * with no error anywhere. Why it is generated rather than looked up at runtime:
 * `i18n-iso-countries` carries every locale's translations (~1MB) to answer a
 * question that is a static table of ~250 rows.
 *
 * THE ATLAS JOIN KEY IS NOT ALWAYS THE NUMERIC CODE. world-atlas ships three
 * features with no `id` at all — Kosovo, N. Cyprus and Somaliland — because
 * they have no ISO 3166-1 assignment. GSC nonetheless reports Kosovo as `xkk`
 * and it appears in this project's real data. So the key we emit is the atlas
 * feature's `id` where it has one, and its `properties.name` where it does not;
 * the renderer keys features the same way.
 */
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const countries = require("i18n-iso-countries");
const atlas = require("world-atlas/countries-110m.json");

const here = dirname(fileURLToPath(import.meta.url));

interface AtlasGeometry {
  id?: string;
  properties?: { name?: string };
}

const geometries: AtlasGeometry[] = atlas.objects.countries.geometries;

/** Atlas features that carry no ISO numeric id, keyed by their name. */
const idlessByName = new Map<string, string>();
for (const g of geometries) {
  if (g.id === undefined && g.properties?.name) {
    idlessByName.set(g.properties.name.toLowerCase(), g.properties.name);
  }
}

const numericIds = new Set(geometries.map((g) => g.id).filter(Boolean) as string[]);

/**
 * GSC codes with no usable ISO numeric in the atlas, mapped to the atlas
 * feature name instead. `zzz` is GSC's "unknown region" bucket — it is
 * deliberately absent so it renders as an unmapped row rather than a country.
 */
const NAME_OVERRIDES: Record<string, string> = {
  xkk: "Kosovo",
};

// `getAlpha3Codes()` returns alpha3 -> alpha2 pairs, so the codes we want are
// the KEYS. Taking the values here yields alpha-2 codes that then fail every
// alpha-3 lookup silently.
const alpha3List: string[] = Object.keys(
  countries.getAlpha3Codes() as Record<string, string>
);

const rows: Array<[string, string, string]> = [];

for (const alpha3 of alpha3List) {
  const lower = alpha3.toLowerCase();
  const name = countries.getName(alpha3, "en") ?? alpha3;
  const numeric = countries.alpha3ToNumeric(alpha3);

  let key: string | undefined;
  if (NAME_OVERRIDES[lower] && idlessByName.has(NAME_OVERRIDES[lower].toLowerCase())) {
    key = NAME_OVERRIDES[lower];
  } else if (numeric && numericIds.has(numeric)) {
    key = numeric;
  }

  // A code with no atlas feature still gets a NAME so the ranked list can label
  // it; `key` stays empty and the renderer leaves it off the map rather than
  // guessing a location.
  rows.push([lower, key ?? "", name]);
}

for (const [lower, override] of Object.entries(NAME_OVERRIDES)) {
  if (!rows.some((r) => r[0] === lower)) {
    rows.push([lower, idlessByName.get(override.toLowerCase()) ?? "", override]);
  }
}

rows.sort((a, b) => a[0].localeCompare(b[0]));

const mapped = rows.filter((r) => r[1] !== "").length;
const body = rows
  .map(([code, key, name]) => `  ${code}: { key: ${JSON.stringify(key)}, name: ${JSON.stringify(name)} },`)
  .join("\n");

const out = `// GENERATED FILE — do not edit by hand.
// Regenerate: node --experimental-strip-types scripts/gen-iso-3166.ts
//
// Maps GSC's lowercase ISO 3166-1 alpha-3 country codes to a world-atlas
// feature key and an English display name.
//
// \`key\` is the atlas join key: the feature's numeric \`id\` where it has one,
// or its \`properties.name\` for the three features that have no ISO assignment
// (Kosovo, N. Cyprus, Somaliland). An EMPTY \`key\` means the code has no
// feature in the 110m atlas — such a country is listed with its impressions but
// is NOT drawn, because guessing a location would be worse than omitting one.
//
// ${rows.length} codes, ${mapped} with an atlas feature.

export interface IsoCountry {
  /** world-atlas join key, or "" when the atlas has no feature for this code. */
  key: string;
  /** English display name. */
  name: string;
}

export const ISO_3166: Record<string, IsoCountry> = {
${body}
};

/**
 * Resolves a GSC country code. Returns \`null\` for codes we have no entry for
 * at all (e.g. GSC's \`zzz\` unknown-region bucket), so callers can render the
 * raw code rather than silently discarding its impressions.
 */
export function lookupCountry(alpha3: string): IsoCountry | null {
  return ISO_3166[alpha3.toLowerCase()] ?? null;
}
`;

writeFileSync(join(here, "..", "lib", "iso-3166.ts"), out);
console.log(`wrote lib/iso-3166.ts — ${rows.length} codes, ${mapped} with an atlas feature`);
