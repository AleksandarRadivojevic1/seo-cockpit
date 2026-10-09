import { describe, expect, it } from "vitest";

import type { SiteConfig } from "../lib/db";
import { buildShareLinkRows } from "../lib/shareLinkRows";
import type { ShareLink } from "../lib/shareLinks";

const optika: SiteConfig = { property: "https://optikacajs.rs/", slug: "optika-cajs", displayName: "Optika Cajs", brandToken: "cajs" };
const gone: SiteConfig = { property: "https://gone.example/", slug: "gone", displayName: "Gone", brandToken: "gone" };

function link(over: Partial<ShareLink>): ShareLink {
  return { id: "sl_1", tokenHash: "x", property: optika.property, label: "owner",
    createdAt: "2026-10-09T13:00:00.000Z", revokedAt: null, ...over };
}

describe("buildShareLinkRows", () => {
  it("names the site and states each link's status, newest first", () => {
    const rows = buildShareLinkRows(
      [
        link({ id: "sl_a", label: "owner", createdAt: "2026-10-01T09:00:00.000Z" }),
        link({ id: "sl_b", label: "old", createdAt: "2026-10-05T09:00:00.000Z", revokedAt: "2026-10-06T09:00:00.000Z" }),
        link({ id: "sl_c", label: "former", property: gone.property, createdAt: "2026-10-08T09:00:00.000Z" }),
        link({ id: "sl_d", label: "mystery", property: "https://unknown.example/", createdAt: "2026-09-01T09:00:00.000Z" }),
      ],
      [optika],
      [gone],
    );
    expect(rows).toEqual([
      { id: "sl_c", label: "former", siteName: "Gone", created: "2026-10-08", status: "site removed" },
      { id: "sl_b", label: "old", siteName: "Optika Cajs", created: "2026-10-05", status: "revoked" },
      { id: "sl_a", label: "owner", siteName: "Optika Cajs", created: "2026-10-01", status: "active" },
      { id: "sl_d", label: "mystery", siteName: "https://unknown.example/", created: "2026-09-01", status: "site removed" },
    ]);
  });
});
