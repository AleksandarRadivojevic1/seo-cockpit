import fs from "node:fs";
import path from "node:path";

/**
 * A site added from the dashboard rather than seeded in collector/sites.yaml.
 *
 * Persisted to the config/user-sites.json file that the dashboard writes and
 * the collector reads. Stored on disk with the SAME snake_case keys as
 * sites.yaml (plus added_at) so the collector parses it with identical
 * semantics; this module maps to/from those keys.
 */
export interface UserSite {
  property: string;
  slug: string;
  displayName: string;
  brandToken: string;
  discoverSeeds: string[];
  trendSeeds: string[];
  serpLocation: string | null;
  addedAt: string;
}

export interface NewSiteInput {
  property: string;
  displayName: string;
  brandToken: string;
  slug?: string;
  discoverSeeds?: string[];
  trendSeeds?: string[];
  serpLocation?: string | null;
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * A GSC property is either a domain property (sc-domain:example.com) or a
 * URL-prefix property, which is a full http(s) URL ending in "/".
 */
export function isValidProperty(p: string): boolean {
  if (/^sc-domain:[^\s/]+\.[^\s/]+$/.test(p)) return true;
  return /^https?:\/\/[^\s]+\/$/.test(p);
}

export function isValidSlug(s: string): boolean {
  return /^[a-z0-9-]+$/.test(s);
}

export function validateNewSite(
  input: NewSiteInput,
  existingSlugs: string[],
  existingProperties: string[],
): { site: UserSite | null; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const property = input.property.trim();
  const displayName = input.displayName.trim();
  const brandToken = input.brandToken.trim();
  const slug = input.slug?.trim() || slugify(displayName);

  if (!isValidProperty(property)) {
    errors.property =
      "Must be a domain property (sc-domain:example.com) or a URL-prefix property ending in / (https://example.com/).";
  } else if (existingProperties.includes(property)) {
    errors.property = "That property is already configured.";
  }
  if (!displayName) errors.displayName = "Required.";
  if (!brandToken) errors.brandToken = "Required.";
  if (!isValidSlug(slug)) {
    errors.slug = "Only lowercase letters, digits and hyphens.";
  } else if (existingSlugs.includes(slug)) {
    errors.slug = "That slug is already in use.";
  }

  if (Object.keys(errors).length > 0) return { site: null, errors };

  return {
    site: {
      property,
      slug,
      displayName,
      brandToken,
      discoverSeeds: input.discoverSeeds ?? [],
      trendSeeds: input.trendSeeds ?? [],
      serpLocation: input.serpLocation ?? null,
      addedAt: new Date().toISOString(),
    },
    errors: {},
  };
}

interface DiskSite {
  property: string;
  slug: string;
  display_name: string;
  brand_token: string;
  discover_seeds: string[];
  trend_seeds: string[];
  serp_location: string | null;
  added_at: string;
}

function toDisk(s: UserSite): DiskSite {
  return {
    property: s.property,
    slug: s.slug,
    display_name: s.displayName,
    brand_token: s.brandToken,
    discover_seeds: s.discoverSeeds,
    trend_seeds: s.trendSeeds,
    serp_location: s.serpLocation,
    added_at: s.addedAt,
  };
}

function fromDisk(d: DiskSite): UserSite {
  return {
    property: d.property,
    slug: d.slug,
    displayName: d.display_name,
    brandToken: d.brand_token,
    discoverSeeds: d.discover_seeds ?? [],
    trendSeeds: d.trend_seeds ?? [],
    serpLocation: d.serp_location ?? null,
    addedAt: d.added_at,
  };
}

/** Read the user-sites file. Missing/undefined/malformed all yield []. */
export function readUserSites(filePath: string | undefined): UserSite[] {
  if (!filePath) return [];
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }
  try {
    const raw = JSON.parse(text);
    if (!Array.isArray(raw)) return [];
    return raw.map(fromDisk);
  } catch {
    return [];
  }
}

/** Write the user-sites file atomically (temp file + rename). */
export function writeUserSitesAtomic(filePath: string, sites: UserSite[]): void {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.user-sites.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmpPath, JSON.stringify(sites.map(toDisk), null, 2), "utf-8");
  fs.renameSync(tmpPath, filePath);
}
