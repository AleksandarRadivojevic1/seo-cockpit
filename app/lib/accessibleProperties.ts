import fs from "node:fs";

/**
 * The set of GSC properties the collector's service account can read, as
 * published by the collector (see collector/seocockpit/properties.py).
 *
 * The dashboard holds no Google credentials, so it cannot call sites().list()
 * itself. Instead the collector writes this list to a shared file and the
 * add-site form validates against it here -- catching a wrong property in the
 * form instead of a day later as a 403 at the next scheduled run.
 */
export interface AccessibleProperties {
  /** When the collector last fetched the list; null if the file omits it. */
  fetchedAt: string | null;
  properties: string[];
}

/**
 * Read the accessible-properties file.
 *
 * Returns null when the file is missing, unreadable, malformed, or lacks a
 * properties array -- all of which mean "the list is unavailable", which is
 * deliberately DISTINCT from a present-but-empty list (a real answer: the
 * account can see nothing). Callers must not conflate the two.
 */
export function readAccessibleProperties(
  filePath: string | undefined,
): AccessibleProperties | null {
  if (!filePath) return null;
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
  try {
    const raw = JSON.parse(text);
    if (!raw || !Array.isArray(raw.properties)) return null;
    const properties = (raw.properties as unknown[]).filter(
      (p): p is string => typeof p === "string",
    );
    const fetchedAt = typeof raw.fetched_at === "string" ? raw.fetched_at : null;
    return { fetchedAt, properties };
  } catch {
    return null;
  }
}

export type PropertyCheck =
  /** In the accessible list exactly. */
  | { state: "ok" }
  /** The list is unavailable (not yet published); do not block. */
  | { state: "unavailable" }
  /** Not accessible, but a different-form property on the same domain is. */
  | { state: "suggest"; suggestion: string }
  /** No accessible property shares this one's domain. */
  | { state: "not-found" };

/**
 * The domain a property refers to, for cross-form matching:
 *   sc-domain:example.com  -> "example.com"
 *   https://example.com/    -> "example.com"
 * Returns null when the string parses as neither form.
 */
function domainKey(property: string): string | null {
  const p = property.trim().toLowerCase();
  const scDomain = /^sc-domain:(.+)$/.exec(p);
  if (scDomain) return scDomain[1].replace(/\/+$/, "");
  try {
    return new URL(p).hostname;
  } catch {
    return null;
  }
}

/**
 * Check a property against the accessible list.
 *
 * A null list yields "unavailable" (soft-allow) rather than blocking the add
 * before the collector has ever published -- and it is a different result from
 * "not-found", so callers can message the two cases distinctly.
 */
export function checkProperty(
  property: string,
  list: AccessibleProperties | null,
): PropertyCheck {
  if (list === null) return { state: "unavailable" };
  const target = property.trim();
  if (list.properties.includes(target)) return { state: "ok" };
  const key = domainKey(target);
  if (key) {
    const variant = list.properties.find((p) => domainKey(p) === key);
    if (variant) return { state: "suggest", suggestion: variant };
  }
  return { state: "not-found" };
}
