import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  slugify,
  isValidProperty,
  isValidSlug,
  validateNewSite,
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
