import type Database from "better-sqlite3";

import { getDb, siteConfigByProperty, type SiteConfig } from "./db";
import { findShareLink, loadShareLinks, type ShareLink } from "./shareLinks";

export interface ResolvedShare {
  link: ShareLink;
  config: SiteConfig;
}

/**
 * The single place a client's access is decided: a share route's token →
 * the one site it may see, or null (the route renders a 404).
 *
 * Null for a malformed, unknown or revoked token, for a missing or malformed
 * links file, and for a site that has since been removed. The token is the
 * only input: no route parameter names a site, so there is nothing to change
 * in the URL to reach another one.
 */
export function resolveShare(
  token: string,
  options: { filePath?: string; db?: Database.Database } = {},
): ResolvedShare | null {
  const file = loadShareLinks(options.filePath ?? process.env.SEO_SHARE_LINKS_PATH);
  if (file.state !== "ok") return null;
  const link = findShareLink(file.links, token);
  if (!link) return null;
  const config = siteConfigByProperty(link.property, options.db ?? getDb());
  return config ? { link, config } : null;
}
