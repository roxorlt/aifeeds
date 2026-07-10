import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dashboardSource = fs.readFileSync(path.join(here, "event-types.ts"), "utf8");
const workerSource = fs.readFileSync(path.join(here, "../../../../worker/src/track.ts"), "utf8");

function dashboardEventValues(source) {
  const block = source.match(/export const EVENTS = \{([\s\S]*?)\}\s+as const/)?.[1] ?? "";
  return new Set([...block.matchAll(/:\s*'([^']+)'/g)].map((m) => m[1]));
}

function workerWhitelistValues(source) {
  const block = source.match(/EVENT_TYPE_WHITELIST\s*=\s*new Set<[^>]+>\(\[([\s\S]*?)\]\)/)?.[1] ?? "";
  const values = new Set([...block.matchAll(/'([^']+)'/g)].map((m) => m[1]));
  for (const spread of block.matchAll(/\.\.\.([A-Z][A-Z0-9_]+)/g)) {
    const name = spread[1];
    const array = source.match(new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s+as const`))?.[1] ?? "";
    for (const match of array.matchAll(/'([^']+)'/g)) values.add(match[1]);
  }
  return values;
}

test("dashboard event constants and Worker ingest whitelist cannot drift", () => {
  const dashboard = dashboardEventValues(dashboardSource);
  const worker = workerWhitelistValues(workerSource);
  assert.ok(dashboard.has("perf_api"), "dashboard must declare perf_api");
  assert.ok(dashboard.has("feed_ready"), "dashboard must declare feed_ready");
  assert.deepEqual([...dashboard].sort(), [...worker].sort());
});
