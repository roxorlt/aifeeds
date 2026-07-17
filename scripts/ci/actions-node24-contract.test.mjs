import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflowDir = path.join(root, ".github/workflows");
const workflowFiles = readdirSync(workflowDir)
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .sort();
const workflows = Object.fromEntries(workflowFiles.map((name) => [
  name,
  readFileSync(path.join(workflowDir, name), "utf8"),
]));

const requiredMajors = new Map([
  ["actions/checkout", "v5"],
  ["actions/setup-node", "v5"],
  ["actions/cache", "v5"],
  ["actions/upload-artifact", "v6"],
  ["dorny/paths-filter", "v4"],
]);

test("all JavaScript action references use the approved Node 24 majors", () => {
  const seen = new Set();
  for (const [filename, source] of Object.entries(workflows)) {
    for (const match of source.matchAll(/uses:\s*([\w-]+\/[\w-]+)@(v\d+)/g)) {
      const [, action, major] = match;
      if (!requiredMajors.has(action)) continue;
      seen.add(action);
      assert.equal(major, requiredMajors.get(action), `${filename}: ${action} must use ${requiredMajors.get(action)}`);
    }
  }
  assert.deepEqual(seen, new Set(requiredMajors.keys()));
});

test("workflow migration keeps the application runtime on Node 22", () => {
  for (const [filename, source] of Object.entries(workflows)) {
    if (!source.includes("actions/setup-node")) continue;
    assert.match(source, /node-version:\s*['"]22['"]/, `${filename} must retain the tested application Node runtime`);
    assert.doesNotMatch(source, /node-version:\s*['"]24['"]/, `${filename} must not conflate action runtime with application runtime`);
  }
});

test("the performance-ops gate runs this workflow contract", () => {
  assert.match(
    workflows["pr-validation.yml"],
    /scripts\/ci\/actions-node24-contract\.test\.mjs/,
  );
});
