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

/**
 * What is on disk, as three different answers. "missing" (nothing added yet)
 * and "malformed" (a bad hand edit) must not look alike: an add or remove
 * that treated a malformed file as empty would write back a list without
 * every site the file held.
 */
export type UserSitesFile =
  | { state: "missing" }
  | { state: "ok"; sites: UserSite[] }
  | { state: "malformed"; error: string };

export function loadUserSites(filePath: string | undefined): UserSitesFile {
  if (!filePath) return { state: "missing" };
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing" };
    // Present but unreadable is not "missing": writing over it is still a loss.
    return { state: "malformed", error: `could not be read: ${(e as Error).message}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { state: "malformed", error: `invalid JSON: ${(e as Error).message}` };
  }
  if (!Array.isArray(raw)) {
    return { state: "malformed", error: "expected a JSON array of sites" };
  }
  const bad = raw.findIndex((entry) => typeof entry !== "object" || entry === null || Array.isArray(entry));
  if (bad !== -1) {
    return { state: "malformed", error: `entry ${bad + 1} is not an object` };
  }
  return { state: "ok", sites: (raw as DiskSite[]).map(fromDisk) };
}

/**
 * Read the user-sites file for display. Missing/undefined/malformed all yield
 * []. Anything that writes the file back must use loadUserSites instead, so a
 * malformed file is refused rather than overwritten.
 */
export function readUserSites(filePath: string | undefined): UserSite[] {
  const file = loadUserSites(filePath);
  return file.state === "ok" ? file.sites : [];
}

/**
 * Write the user-sites file atomically (temp file + rename), first copying
 * the current file to `<file>.bak` so the previous version survives a bad
 * write.
 */
export function writeUserSitesAtomic(filePath: string, sites: UserSite[]): void {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.user-sites.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmpPath, JSON.stringify(sites.map(toDisk), null, 2), "utf-8");
  try {
    fs.copyFileSync(filePath, `${filePath}.bak`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      fs.rmSync(tmpPath, { force: true });
      throw e;
    }
  }
  fs.renameSync(tmpPath, filePath);
}

/** The message shown wherever a malformed user-sites file blocks a change. */
export function userSitesFileError(filePath: string, error: string): string {
  return (
    `${filePath} could not be parsed (${error}). Adding and removing sites is ` +
    `paused so the file isn't overwritten; fix it by hand, or restore ` +
    `${path.basename(filePath)}.bak, which holds the version before the last ` +
    `dashboard change.`
  );
}
