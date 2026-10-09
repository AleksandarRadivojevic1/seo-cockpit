import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Client share links, stored in config/share-links.json (the dashboard's
 * writable mount). Only a SHA-256 of each token is kept, so the file is never
 * a list of working links, and a lost link is replaced (revoke + create),
 * never recovered.
 */
export interface ShareLink {
  id: string;
  tokenHash: string;
  property: string;
  label: string;
  createdAt: string;
  revokedAt: string | null;
}

interface DiskShareLink {
  id: string;
  token_hash: string;
  property: string;
  label: string;
  created_at: string;
  revoked_at: string | null;
}

export type ShareLinksFile =
  | { state: "missing" }
  | { state: "ok"; links: ShareLink[] }
  | { state: "malformed"; error: string };

/** 32 random bytes as base64url: 43 characters, 256 bits. */
export const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function newShareToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashShareToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function isDiskShareLink(value: unknown): value is DiskShareLink {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.token_hash === "string" &&
    typeof v.property === "string" &&
    typeof v.label === "string" &&
    typeof v.created_at === "string" &&
    (v.revoked_at === null || typeof v.revoked_at === "string")
  );
}

function fromDisk(d: DiskShareLink): ShareLink {
  return {
    id: d.id,
    tokenHash: d.token_hash,
    property: d.property,
    label: d.label,
    createdAt: d.created_at,
    revokedAt: d.revoked_at,
  };
}

function toDisk(l: ShareLink): DiskShareLink {
  return {
    id: l.id,
    token_hash: l.tokenHash,
    property: l.property,
    label: l.label,
    created_at: l.createdAt,
    revoked_at: l.revokedAt,
  };
}

/** Missing, readable, or malformed: three different answers (see userSites.ts). */
export function loadShareLinks(filePath: string | undefined): ShareLinksFile {
  if (!filePath) return { state: "missing" };
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing" };
    return { state: "malformed", error: `could not be read: ${(e as Error).message}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { state: "malformed", error: `invalid JSON: ${(e as Error).message}` };
  }
  if (!Array.isArray(raw)) return { state: "malformed", error: "expected a JSON array of links" };
  const bad = raw.findIndex((entry) => !isDiskShareLink(entry));
  if (bad !== -1) return { state: "malformed", error: `entry ${bad + 1} is not a valid share link` };
  return { state: "ok", links: (raw as DiskShareLink[]).map(fromDisk) };
}

/** Atomic (temp file + rename), keeping the previous file as `<file>.bak`. */
export function writeShareLinksAtomic(filePath: string, links: ShareLink[]): void {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.share-links.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmpPath, JSON.stringify(links.map(toDisk), null, 2), "utf-8");
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

/**
 * The active link `token` belongs to, or null. Every stored hash is compared
 * in constant time; a malformed token never reaches the comparison.
 */
export function findShareLink(links: ShareLink[], token: string): ShareLink | null {
  if (!SHARE_TOKEN_PATTERN.test(token)) return null;
  const wanted = Buffer.from(hashShareToken(token), "hex");
  let found: ShareLink | null = null;
  for (const link of links) {
    const stored = Buffer.from(link.tokenHash, "hex");
    if (stored.length === wanted.length && timingSafeEqual(stored, wanted) && link.revokedAt === null) {
      found = link;
    }
  }
  return found;
}

export function shareLinksFileError(filePath: string, error: string): string {
  return (
    `${filePath} could not be parsed (${error}). Share links can't be created or ` +
    `revoked until it is fixed by hand, or restored from ${path.basename(filePath)}.bak.`
  );
}

/** Mints a link. The raw token is returned once; only its hash is stored. */
export function createShareLink(
  filePath: string,
  input: { property: string; label: string },
  now: Date = new Date(),
): { link: ShareLink; token: string } {
  const file = loadShareLinks(filePath);
  if (file.state === "malformed") throw new Error(shareLinksFileError(filePath, file.error));
  const token = newShareToken();
  const link: ShareLink = {
    id: `sl_${randomBytes(4).toString("hex")}`,
    tokenHash: hashShareToken(token),
    property: input.property,
    label: input.label,
    createdAt: now.toISOString(),
    revokedAt: null,
  };
  writeShareLinksAtomic(filePath, [...(file.state === "ok" ? file.links : []), link]);
  return { link, token };
}

/** Revokes an active link. False when there is no such active link. */
export function revokeShareLink(filePath: string, id: string, now: Date = new Date()): boolean {
  const file = loadShareLinks(filePath);
  if (file.state === "malformed") throw new Error(shareLinksFileError(filePath, file.error));
  if (file.state === "missing") return false;
  let changed = false;
  const links = file.links.map((link) => {
    if (link.id !== id || link.revokedAt !== null) return link;
    changed = true;
    return { ...link, revokedAt: now.toISOString() };
  });
  if (changed) writeShareLinksAtomic(filePath, links);
  return changed;
}
