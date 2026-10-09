import type { SiteConfig } from "./db";
import type { ShareLink } from "./shareLinks";

export interface ShareLinkRow {
  id: string;
  label: string;
  siteName: string;
  created: string;
  status: "active" | "revoked" | "site removed";
}

/**
 * The share links page's rows, newest first. "site removed" is shown for a
 * link that was never revoked but whose site is no longer active: it already
 * 404s for the client (see resolveShare), and the page should say why.
 */
export function buildShareLinkRows(
  links: ShareLink[],
  active: SiteConfig[],
  retired: SiteConfig[],
): ShareLinkRow[] {
  const activeByProperty = new Map(active.map((c) => [c.property, c]));
  const retiredByProperty = new Map(retired.map((c) => [c.property, c]));
  return [...links]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((link) => {
      const site = activeByProperty.get(link.property) ?? retiredByProperty.get(link.property);
      return {
        id: link.id,
        label: link.label,
        siteName: site?.displayName ?? link.property,
        created: link.createdAt.slice(0, 10),
        status: link.revokedAt
          ? "revoked"
          : activeByProperty.has(link.property)
            ? "active"
            : "site removed",
      };
    });
}
