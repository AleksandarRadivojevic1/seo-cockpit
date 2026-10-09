import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  slugify,
  isValidProperty,
  isValidSlug,
  validateNewSite,
  loadUserSites,
  readUserSites,
  writeUserSitesAtomic,
  type UserSite,
} from "../lib/userSites";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "usersites-"));

describe("validation", () => {
  it("slugifies a display name", () => {
    expect(slugify("My Agency Site!")).toBe("my-agency-site");
  });

  it("accepts the two GSC property shapes and rejects others", () => {
    expect(isValidProperty("sc-domain:example.com")).toBe(true);
    expect(isValidProperty("https://example.com/")).toBe(true);
    expect(isValidProperty("example.com")).toBe(false);
    expect(isValidProperty("http://no-trailing-slash.com")).toBe(false);
  });

  it("rejects bad slugs", () => {
    expect(isValidSlug("good-slug-1")).toBe(true);
    expect(isValidSlug("Bad Slug")).toBe(false);
  });

  it("rejects a duplicate slug", () => {
    const r = validateNewSite(
      { property: "sc-domain:dup.com", displayName: "Dup", brandToken: "dup", slug: "dup" },
      ["dup"],
      ["sc-domain:other.com"],
    );
    expect(r.site).toBeNull();
    expect(r.errors.slug).toBeTruthy();
  });

  it("rejects a duplicate property", () => {
    const r = validateNewSite(
      { property: "sc-domain:dup.com", displayName: "Dup", brandToken: "dup" },
      [],
      ["sc-domain:dup.com"],
    );
    expect(r.site).toBeNull();
    expect(r.errors.property).toBeTruthy();
  });

  it("builds a UserSite from valid input, deriving slug when omitted", () => {
    const r = validateNewSite(
      { property: "sc-domain:agency.com", displayName: "My Agency", brandToken: "agency" },
      [],
      [],
    );
    expect(r.errors).toEqual({});
    expect(r.site).toMatchObject({
      property: "sc-domain:agency.com",
      slug: "my-agency",
      displayName: "My Agency",
      brandToken: "agency",
      discoverSeeds: [],
      trendSeeds: [],
      serpLocation: null,
    });
    expect(typeof r.site!.addedAt).toBe("string");
  });
});

describe("read/write round-trip (snake_case on disk)", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("writes snake_case and reads it back to camelCase", () => {
    dir = tmp();
    const file = path.join(dir, "user-sites.json");
    const site: UserSite = {
      property: "sc-domain:agency.com",
      slug: "agency",
      displayName: "Agency",
      brandToken: "agency",
      discoverSeeds: [],
      trendSeeds: [],
      serpLocation: null,
      addedAt: "2026-09-14T12:00:00Z",
    };
    writeUserSitesAtomic(file, [site]);
    const onDisk = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(onDisk[0].display_name).toBe("Agency");
    expect(onDisk[0].brand_token).toBe("agency");
    expect(readUserSites(file)).toEqual([site]);
  });

  it("returns [] for a missing file or undefined path", () => {
    dir = tmp();
    expect(readUserSites(undefined)).toEqual([]);
    expect(readUserSites(path.join(dir, "nope.json"))).toEqual([]);
  });

  it("returns [] for malformed JSON", () => {
    dir = tmp();
    const file = path.join(dir, "user-sites.json");
    fs.writeFileSync(file, "{ not json");
    expect(readUserSites(file)).toEqual([]);
  });
});

describe("loadUserSites: missing, ok and malformed are different answers", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const site: UserSite = {
    property: "sc-domain:agency.com",
    slug: "agency",
    displayName: "Agency",
    brandToken: "agency",
    discoverSeeds: [],
    trendSeeds: [],
    serpLocation: null,
    addedAt: "2026-09-14T12:00:00Z",
  };

  it("reports a missing file or undefined path as missing", () => {
    dir = tmp();
    expect(loadUserSites(undefined)).toEqual({ state: "missing" });
    expect(loadUserSites(path.join(dir, "nope.json"))).toEqual({ state: "missing" });
  });

  it("reports a readable array as ok, with its sites", () => {
    dir = tmp();
    const file = path.join(dir, "user-sites.json");
    writeUserSitesAtomic(file, [site]);
    expect(loadUserSites(file)).toEqual({ state: "ok", sites: [site] });
  });

  it("reports unparseable JSON as malformed, carrying the parse error", () => {
    dir = tmp();
    const file = path.join(dir, "user-sites.json");
    fs.writeFileSync(file, "{ not json");
    const result = loadUserSites(file);
    expect(result.state).toBe("malformed");
    if (result.state !== "malformed") throw new Error("unreachable");
    expect(result.error).toMatch(/JSON/);
  });

  it("reports a non-array payload as malformed", () => {
    dir = tmp();
    const file = path.join(dir, "user-sites.json");
    fs.writeFileSync(file, JSON.stringify({ property: "sc-domain:agency.com" }));
    expect(loadUserSites(file)).toMatchObject({ state: "malformed", error: expect.stringMatching(/array/) });
  });

  it("reports a non-object entry as malformed rather than rewriting it away", () => {
    dir = tmp();
    const file = path.join(dir, "user-sites.json");
    fs.writeFileSync(file, JSON.stringify([{ property: "sc-domain:a.com", slug: "a" }, "oops"]));
    expect(loadUserSites(file)).toMatchObject({ state: "malformed", error: expect.stringMatching(/entry 2/) });
  });
});

describe("writeUserSitesAtomic keeps the previous file as .bak", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const site = (slug: string): UserSite => ({
    property: `sc-domain:${slug}.com`,
    slug,
    displayName: slug,
    brandToken: slug,
    discoverSeeds: [],
    trendSeeds: [],
    serpLocation: null,
    addedAt: "2026-09-14T12:00:00Z",
  });

  it("writes no .bak when there was no file before", () => {
    dir = tmp();
    const file = path.join(dir, "user-sites.json");
    writeUserSitesAtomic(file, [site("a")]);
    expect(fs.existsSync(`${file}.bak`)).toBe(false);
  });

  it("copies the current file to .bak before replacing it", () => {
    dir = tmp();
    const file = path.join(dir, "user-sites.json");
    writeUserSitesAtomic(file, [site("a")]);
    const first = fs.readFileSync(file, "utf-8");
    writeUserSitesAtomic(file, [site("a"), site("b")]);
    expect(fs.readFileSync(`${file}.bak`, "utf-8")).toBe(first);
    expect(readUserSites(file).map((s) => s.slug)).toEqual(["a", "b"]);
  });
});
