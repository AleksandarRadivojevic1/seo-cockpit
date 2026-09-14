import fs from "node:fs";
import path from "node:path";

/**
 * Write the run-now trigger file the collector watches. Records a fresh
 * `requested_at` timestamp; the collector runs a collection when it sees a
 * timestamp newer than the last it processed. Atomic (temp + rename) so the
 * collector never reads a half-written file. Returns the timestamp written.
 */
export function writeRunTrigger(filePath: string): string {
  const requestedAt = new Date().toISOString();
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.run-now.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmpPath, JSON.stringify({ requested_at: requestedAt }), "utf-8");
  fs.renameSync(tmpPath, filePath);
  return requestedAt;
}
