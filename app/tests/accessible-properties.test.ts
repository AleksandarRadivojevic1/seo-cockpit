import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readAccessibleProperties,
  checkProperty,
  type AccessibleProperties,
} from "../lib/accessibleProperties";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "accprops-"));

describe("readAccessibleProperties", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("reads the collector-published file", () => {
    dir = tmp();
    const file = path.join(dir, "accessible-properties.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        fetched_at: "2026-09-15T12:00:00+00:00",
        properties: ["sc-domain:alexrad.dev", "https://skedio.rs/"],
      }),
    );
    expect(readAccessibleProperties(file)).toEqual({
      fetchedAt: "2026-09-15T12:00:00+00:00",
      properties: ["sc-domain:alexrad.dev", "https://skedio.rs/"],
    });
  });

  it("returns null for a missing file or undefined path", () => {
    dir = tmp();
    expect(readAccessibleProperties(undefined)).toBeNull();
    expect(readAccessibleProperties(path.join(dir, "nope.json"))).toBeNull();
  });

  it("returns null for malformed JSON or a missing properties array", () => {
    dir = tmp();
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, "{ not json");
    expect(readAccessibleProperties(bad)).toBeNull();
    const noArray = path.join(dir, "noarray.json");
    fs.writeFileSync(noArray, JSON.stringify({ fetched_at: "t" }));
    expect(readAccessibleProperties(noArray)).toBeNull();
  });

  it("distinguishes an empty list from an unavailable file", () => {
    dir = tmp();
    const empty = path.join(dir, "empty.json");
    fs.writeFileSync(empty, JSON.stringify({ fetched_at: "t", properties: [] }));
    // A present-but-empty list is a real answer (the account can see nothing),
    // NOT the same as the file being absent -- the standing null-vs-zero rule.
    expect(readAccessibleProperties(empty)).toEqual({ fetchedAt: "t", properties: [] });
  });
});

describe("checkProperty", () => {
  const list: AccessibleProperties = {
    fetchedAt: "2026-09-15T12:00:00+00:00",
    properties: ["sc-domain:deimos.agency", "https://skedio.rs/"],
  };

  it("accepts a property that is in the list exactly", () => {
    expect(checkProperty("sc-domain:deimos.agency", list)).toEqual({ state: "ok" });
    expect(checkProperty("https://skedio.rs/", list)).toEqual({ state: "ok" });
  });

  it("suggests the accessible form when the domain matches but the form differs", () => {
    // The exact trap: typed the URL-prefix form when GSC has the domain form.
    expect(checkProperty("https://deimos.agency/", list)).toEqual({
      state: "suggest",
      suggestion: "sc-domain:deimos.agency",
    });
  });

  it("rejects a property whose domain is not accessible at all", () => {
    expect(checkProperty("sc-domain:unknown.rs", list)).toEqual({ state: "not-found" });
  });

  it("soft-allows when the list is unavailable, distinctly from not-found", () => {
    // Unavailable (collector hasn't published yet) must NOT hard-block, and
    // must be a DIFFERENT outcome from a property that is genuinely absent.
    expect(checkProperty("sc-domain:deimos.agency", null)).toEqual({ state: "unavailable" });
    expect(checkProperty("sc-domain:unknown.rs", null)).toEqual({ state: "unavailable" });
  });

  it("rejects (not suggests) when nothing shares the domain, even with an empty list", () => {
    const empty: AccessibleProperties = { fetchedAt: "t", properties: [] };
    expect(checkProperty("sc-domain:deimos.agency", empty)).toEqual({ state: "not-found" });
  });
});
