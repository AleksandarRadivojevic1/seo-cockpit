"use server";

import { revalidatePath } from "next/cache";

import {
  checkProperty,
  readAccessibleProperties,
} from "../../lib/accessibleProperties";
import { listSiteConfigs } from "../../lib/db";
import { writeRunTrigger } from "../../lib/runTrigger";
import {
  readUserSites,
  validateNewSite,
  writeUserSitesAtomic,
} from "../../lib/userSites";

export interface AddSiteState {
  errors: Record<string, string>;
  ok: boolean;
}

function userSitesPath(): string {
  const p = process.env.SEO_USER_SITES_PATH;
  if (!p) throw new Error("SEO_USER_SITES_PATH is not set");
  return p;
}

/** Split a textarea/CSV field into trimmed, non-empty terms. */
function splitList(raw: FormDataEntryValue | null): string[] {
  if (!raw) return [];
  return String(raw)
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function addSite(
  _prev: AddSiteState,
  formData: FormData,
): Promise<AddSiteState> {
  const filePath = userSitesPath();
  const existing = readUserSites(filePath);

  // Uniqueness is checked against both already-collected sites (the DB `sites`
  // table, which includes the sites.yaml seeds) and pending user sites.
  const dbConfigs = listSiteConfigs();
  const existingSlugs = [
    ...dbConfigs.map((c) => c.slug),
    ...existing.map((s) => s.slug),
  ];
  const existingProperties = [
    ...dbConfigs.map((c) => c.property),
    ...existing.map((s) => s.property),
  ];

  const serpLocationRaw = String(formData.get("serpLocation") ?? "").trim();
  const { site, errors } = validateNewSite(
    {
      property: String(formData.get("property") ?? ""),
      displayName: String(formData.get("displayName") ?? ""),
      brandToken: String(formData.get("brandToken") ?? ""),
      slug: String(formData.get("slug") ?? ""),
      discoverSeeds: splitList(formData.get("discoverSeeds")),
      trendSeeds: splitList(formData.get("trendSeeds")),
      serpLocation: serpLocationRaw || null,
    },
    existingSlugs,
    existingProperties,
  );

  if (!site) return { errors, ok: false };

  // Verify the service account can actually read this property, against the
  // list the collector publishes (the dashboard holds no Google credentials).
  // This turns the old "accepted, then 403 a day later at the next run" trap
  // into an actionable error in the form.
  const accessible = readAccessibleProperties(
    process.env.SEO_ACCESSIBLE_PROPERTIES_PATH,
  );
  const check = checkProperty(site.property, accessible);
  if (check.state === "suggest") {
    return {
      errors: {
        property:
          `The service account can't access ${site.property}, but it can ` +
          `access ${check.suggestion}. Search Console treats the URL-prefix ` +
          `and domain forms as different properties — did you mean ` +
          `${check.suggestion}?`,
      },
      ok: false,
    };
  }
  if (check.state === "not-found") {
    const when = accessible?.fetchedAt
      ? `list checked ${accessible.fetchedAt}`
      : "list not yet fetched";
    return {
      errors: {
        property:
          `The service account can't access this property. Grant it access ` +
          `in Search Console, then use Refresh below and try again (${when}).`,
      },
      ok: false,
    };
  }
  // "ok" and "unavailable" both proceed. "unavailable" (the collector has not
  // published the list yet) is a deliberate soft-allow: it falls back to the
  // previous behaviour and lets the first run confirm access, rather than
  // blocking every add before the list ever exists.

  writeUserSitesAtomic(filePath, [...existing, site]);
  revalidatePath("/");
  return { errors: {}, ok: true };
}

export async function removeSite(formData: FormData): Promise<void> {
  const filePath = userSitesPath();
  const slug = String(formData.get("slug") ?? "");
  const remaining = readUserSites(filePath).filter((s) => s.slug !== slug);
  writeUserSitesAtomic(filePath, remaining);
  revalidatePath("/");
}

export interface RunState {
  ok: boolean;
  requestedAt: string | null;
  error: string | null;
}

/**
 * Ask the collector to run a collection now, by writing the trigger file its
 * watcher polls (~15s). Does not run collection itself — the collector is the
 * only writer of the database.
 */
export async function requestCollectionRun(
  _prev: RunState,
  _formData: FormData,
): Promise<RunState> {
  const p = process.env.SEO_RUN_TRIGGER_PATH;
  if (!p) return { ok: false, requestedAt: null, error: "SEO_RUN_TRIGGER_PATH is not set" };
  try {
    const requestedAt = writeRunTrigger(p);
    revalidatePath("/");
    return { ok: true, requestedAt, error: null };
  } catch (e) {
    return { ok: false, requestedAt: null, error: String(e) };
  }
}

export interface RefreshState {
  ok: boolean;
  requestedAt: string | null;
  error: string | null;
}

/**
 * Ask the collector to republish the accessible-property list, by writing the
 * refresh-trigger file its watcher polls (~15s). Used after granting the
 * service account access in Search Console, so the add-site check sees the new
 * property without waiting for a full nightly run. Same fire-and-forget shape
 * as requestCollectionRun; the operator retries the add a moment later.
 */
export async function refreshProperties(
  _prev: RefreshState,
  _formData: FormData,
): Promise<RefreshState> {
  const p = process.env.SEO_REFRESH_TRIGGER_PATH;
  if (!p)
    return { ok: false, requestedAt: null, error: "SEO_REFRESH_TRIGGER_PATH is not set" };
  try {
    const requestedAt = writeRunTrigger(p);
    return { ok: true, requestedAt, error: null };
  } catch (e) {
    return { ok: false, requestedAt: null, error: String(e) };
  }
}
