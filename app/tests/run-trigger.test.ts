import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeRunTrigger } from "../lib/runTrigger";

describe("writeRunTrigger", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("writes a fresh ISO requested_at atomically and returns it", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtrig-"));
    const file = path.join(dir, "run-now.json");

    const ts = writeRunTrigger(file);

    const onDisk = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(onDisk.requested_at).toBe(ts);
    // A valid ISO 8601 instant.
    expect(new Date(ts).toISOString()).toBe(ts);
    // No stray temp files left behind.
    expect(fs.readdirSync(dir)).toEqual(["run-now.json"]);
  });

  it("overwrites a previous trigger with a newer timestamp", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtrig-"));
    const file = path.join(dir, "run-now.json");
    fs.writeFileSync(file, JSON.stringify({ requested_at: "2000-01-01T00:00:00.000Z" }));

    const ts = writeRunTrigger(file);

    expect(JSON.parse(fs.readFileSync(file, "utf-8")).requested_at).toBe(ts);
    expect(ts).not.toBe("2000-01-01T00:00:00.000Z");
  });
});
