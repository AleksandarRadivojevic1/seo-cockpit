import type { SerpCheckRow, SerpResultRow } from "../db";

/**
 * What kind of thing holds a SERP position.
 *
 * These live here, not in the collector, on purpose: the lists below are a
 * judgment call that will be wrong at the edges, and correcting them must
 * cost nothing. The collector stores raw domains, so re-classifying is a
 * page reload rather than another 250-credit month.
 */
export type DomainKind = "own" | "marketplace" | "social" | "content" | "competitor";

/**
 * General-purpose marketplaces and classifieds. A SERP owned by these is
 * usually not winnable with a content page — you are competing with a site
 * that has every product and far more authority than a local shop.
 *
 * Seeded from real captured SERPs (2026-07-27) rather than guessed.
 */
const MARKETPLACE_DOMAINS = [
  "kupujemprodajem.com",
  "olx.ba",
  "olx.rs",
  "limundo.com",
  "ananas.rs",
  "emmezeta.rs",
  "tehnomanija.rs",
  "gigatron.rs",
  "amazon.com",
  "ebay.com",
  "aliexpress.com",
  "temu.com",
];

/**
 * Platforms, not businesses. A video or a reel ranking is a signal the query
 * wants a demonstration rather than a product page — genuinely useful to
 * know, and a different response than "write a better category page".
 */
const SOCIAL_DOMAINS = [
  "youtube.com",
  "youtu.be",
  "instagram.com",
  "facebook.com",
  "tiktok.com",
  "reddit.com",
  "pinterest.com",
  "x.com",
  "twitter.com",
  "linkedin.com",
  "quora.com",
];

/**
 * Editorial/health-information sites rather than shops. When these hold the
 * top spots the query is informational, and a product page will not displace
 * them however well optimised it is.
 */
const CONTENT_DOMAINS = [
  "mojvid.rs",
  "svetivid.com",
  "wikipedia.org",
  "stetoskop.info",
  "kurir.rs",
  "blic.rs",
  "b92.net",
  "telegraf.rs",
];

function matches(domain: string, list: string[]): boolean {
  return list.some((entry) => domain === entry || domain.endsWith(`.${entry}`));
}

/**
 * The domain to look for in a SERP, from a GSC property string.
 *
 * Mirrors `own_domain_for` in the collector's serp.py. Duplicated rather
 * than shared because the two runtimes cannot import each other; a mismatch
 * here would only mislabel our own result as a competitor, which is visible
 * on screen rather than silent.
 */
export function ownDomainFor(siteProperty: string): string {
  if (siteProperty.startsWith("sc-domain:")) {
    return siteProperty.slice("sc-domain:".length).trim().toLowerCase();
  }
  try {
    const host = new URL(siteProperty).hostname.toLowerCase();
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return siteProperty.toLowerCase();
  }
}

/** Classify one result's domain relative to the site being analysed. */
export function classifyDomain(domain: string, ownDomain: string): DomainKind {
  const d = domain.toLowerCase();
  const own = ownDomain.toLowerCase();
  if (d === own || d.endsWith(`.${own}`)) return "own";
  if (matches(d, MARKETPLACE_DOMAINS)) return "marketplace";
  if (matches(d, SOCIAL_DOMAINS)) return "social";
  if (matches(d, CONTENT_DOMAINS)) return "content";
  return "competitor";
}

/**
 * Whether a URL points at a site's front door rather than a specific page.
 *
 * A homepage ranking usually means authority is winning; a deep page ranking
 * means content is winning, which is the beatable case. A bare locale
 * segment (/sr, /en) still counts as a homepage.
 */
export function isHomepage(url: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return true;
  return segments.length === 1 && /^[a-z]{2}(-[a-z]{2})?$/i.test(segments[0]);
}

/**
 * How to describe our own absence from a SERP.
 *
 * Never a bare "not ranking": that is unfalsifiable and overstates what was
 * measured. The depth actually examined is part of the claim.
 */
export function absenceLabel(check: Pick<SerpCheckRow, "depthChecked">): string {
  return `Not in top ${check.depthChecked}`;
}

export type SerpState = "not-checked" | "empty-serp" | "ok";

/**
 * Three states that must never render alike.
 *
 * - `not-checked`: no credits spent on this site yet.
 * - `empty-serp`: checked, and Google returned no organic results at all.
 *   Rare and real — a finding, not a failure.
 * - `ok`: checked, results present.
 *
 * A check that FAILED is none of these: the collector writes nothing, so it
 * is indistinguishable from `not-checked`, which is the conservative and
 * correct outcome.
 */
export function serpState(checks: SerpCheckRow[]): SerpState {
  if (checks.length === 0) return "not-checked";
  if (checks.every((c) => c.results.length === 0)) return "empty-serp";
  return "ok";
}

export interface DomainTally {
  domain: string;
  kind: DomainKind;
  /** How many of the checked SERPs this domain appears in. */
  appearances: number;
  /** Its best (numerically lowest) position across those SERPs. */
  bestPosition: number;
}

/**
 * Domains ranked by how often they hold the keywords we're missing.
 *
 * This is the closest honest answer to "who are my competitors": not a list
 * someone typed into a config, but the sites Google actually returns for the
 * things this shop wants to sell. Counted once per keyword — a domain
 * holding positions 1 and 5 of the same SERP is one appearance, not two, or
 * a site with many URLs would outrank a site with one good one.
 */
export function rankCompetitors(checks: SerpCheckRow[], ownDomain: string): DomainTally[] {
  const tally = new Map<string, DomainTally>();

  for (const check of checks) {
    const seenInThisCheck = new Set<string>();
    for (const result of check.results) {
      if (seenInThisCheck.has(result.domain)) continue;
      seenInThisCheck.add(result.domain);

      const existing = tally.get(result.domain);
      if (existing) {
        existing.appearances += 1;
        existing.bestPosition = Math.min(existing.bestPosition, result.position);
      } else {
        tally.set(result.domain, {
          domain: result.domain,
          kind: classifyDomain(result.domain, ownDomain),
          appearances: 1,
          bestPosition: result.position,
        });
      }
    }
  }

  return [...tally.values()].sort(
    (a, b) => b.appearances - a.appearances || a.bestPosition - b.bestPosition
  );
}

/** Convenience for the panel: the top N results of one check. */
export function topResults(check: SerpCheckRow, n: number): SerpResultRow[] {
  return check.results.slice(0, n);
}
