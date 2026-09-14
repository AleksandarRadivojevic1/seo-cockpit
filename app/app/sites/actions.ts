"use server";

import { revalidatePath } from "next/cache";

import { listSiteConfigs } from "../../lib/db";
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
