import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  SHARE_TOKEN_PATTERN,
  createShareLink,
  findShareLink,
  hashShareToken,
  loadShareLinks,
  newShareToken,
  revokeShareLink,
} from "../lib/shareLinks";

let dir: string | undefined;
const file = () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "share-links-"));
  return path.join(dir, "share-links.json");
};
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const OPTIKA = { property: "https://optikacajs.rs/", label: "Optika – owner" };

describe("tokens", () => {
  it("are 43 base64url characters and never repeat", () => {
    const a = newShareToken();
    const b = newShareToken();
    expect(a).toMatch(SHARE_TOKEN_PATTERN);
    expect(a).not.toBe(b);
  });

  it("are stored as their SHA-256", () => {
    expect(hashShareToken("abc")).toBe(createHash("sha256").update("abc").digest("hex"));
  });
});

describe("createShareLink", () => {
  it("creates the file on the first link and returns the raw token once", () => {
    const f = file();
    expect(loadShareLinks(f)).toEqual({ state: "missing" });

    const { link, token } = createShareLink(f, OPTIKA, new Date("2026-10-09T13:00:00Z"));

    expect(token).toMatch(SHARE_TOKEN_PATTERN);
    expect(link).toMatchObject({ ...OPTIKA, createdAt: "2026-10-09T13:00:00.000Z", revokedAt: null });
    expect(link.id).toMatch(/^sl_[0-9a-f]{8}$/);
    const onDisk = fs.readFileSync(f, "utf-8");
    expect(onDisk).not.toContain(token);
    expect(JSON.parse(onDisk)[0].token_hash).toBe(hashShareToken(token));
  });

  it("keeps the previous file as .bak", () => {
    const f = file();
    createShareLink(f, OPTIKA);
    const first = fs.readFileSync(f, "utf-8");
    createShareLink(f, { ...OPTIKA, label: "Optika – marketing" });
    expect(fs.readFileSync(`${f}.bak`, "utf-8")).toBe(first);
    expect(loadShareLinks(f)).toMatchObject({ state: "ok", links: [{}, {}] });
  });

  it("refuses to overwrite a malformed file", () => {
    const f = file();
    fs.writeFileSync(f, "[{ broken");
    expect(() => createShareLink(f, OPTIKA)).toThrow(/could not be parsed/);
    expect(fs.readFileSync(f, "utf-8")).toBe("[{ broken");
  });
});

describe("findShareLink", () => {
  it("finds a link by its raw token", () => {
    const f = file();
    const { link, token } = createShareLink(f, OPTIKA);
    const loaded = loadShareLinks(f);
    if (loaded.state !== "ok") throw new Error("unreachable");
    expect(findShareLink(loaded.links, token)?.id).toBe(link.id);
  });

  it("finds nothing for an unknown, malformed or revoked token", () => {
    const f = file();
    const { link, token } = createShareLink(f, OPTIKA);
    revokeShareLink(f, link.id);
    const loaded = loadShareLinks(f);
    if (loaded.state !== "ok") throw new Error("unreachable");
    expect(findShareLink(loaded.links, token)).toBeNull();
    expect(findShareLink(loaded.links, newShareToken())).toBeNull();
    for (const garbage of ["", "abc", "../../etc/passwd", `${token}x`]) {
      expect(findShareLink(loaded.links, garbage), garbage).toBeNull();
    }
  });
});

describe("revokeShareLink", () => {
  it("stamps revoked_at once and reports whether it changed anything", () => {
    const f = file();
    const { link } = createShareLink(f, OPTIKA);
    expect(revokeShareLink(f, link.id, new Date("2026-10-10T08:00:00Z"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(f, "utf-8"))[0].revoked_at).toBe("2026-10-10T08:00:00.000Z");
    expect(revokeShareLink(f, link.id)).toBe(false);
    expect(revokeShareLink(f, "sl_00000000")).toBe(false);
  });

  it("returns false when there is no file yet", () => {
    expect(revokeShareLink(file(), "sl_00000000")).toBe(false);
  });
});

describe("loadShareLinks", () => {
  it("reports a non-array or an incomplete entry as malformed", () => {
    const f = file();
    fs.writeFileSync(f, JSON.stringify({ links: [] }));
    expect(loadShareLinks(f).state).toBe("malformed");
    fs.writeFileSync(f, JSON.stringify([{ id: "sl_1", property: "x" }]));
    expect(loadShareLinks(f)).toMatchObject({ state: "malformed", error: expect.stringMatching(/entry 1/) });
  });
});
