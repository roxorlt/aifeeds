import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflowPath = path.join(root, ".github/workflows/sitespeed-external.yml");
const workflow = existsSync(workflowPath) ? readFileSync(workflowPath, "utf8") : "";

test("external sitespeed workflow exists", () => {
  assert.ok(workflow, ".github/workflows/sitespeed-external.yml must exist");
});

test("external sitespeed workflow is pinned to the approved branch and explicit production views", () => {
  assert.match(workflow, /branches:\s*\n\s*-\s*'codex\/waterfall-ssr-rum-parallel'/);
  assert.match(workflow, /paths:\s*\n\s*-\s*'\.github\/workflows\/sitespeed-external\.yml'/);
  assert.deepEqual(
    [...workflow.matchAll(/https:\/\/[^\s"']+/g)].map(([url]) => url),
    [
      "https://ai-feeds.com/?view=classic",
      "https://ai-feeds.com/?view=waterfall",
    ],
    "only the two explicit read-only production cohorts may be targeted",
  );
  assert.doesNotMatch(workflow, /\bmain\b/);
});

test("external sitespeed workflow runs reproducible five-run view and device matrices", () => {
  assert.match(workflow, /sitespeedio\/sitespeed\.io:42\.0\.1/);
  assert.match(workflow, /name:\s*classic/);
  assert.match(workflow, /name:\s*waterfall/);
  assert.match(workflow, /mode:\s*mobile/);
  assert.match(workflow, /mode:\s*desktop/);
  assert.match(workflow, /(?:^|\s)-n\s+5(?:\s|$)/m);
  assert.match(workflow, /--mobile/);
  assert.match(workflow, /--browsertime\.connectivity\.engine\s+throttle/);
  assert.match(workflow, /--browsertime\.connectivity\.profile\s+custom/);
  assert.match(workflow, /--browsertime\.connectivity\.downstreamKbps/);
  assert.match(workflow, /--browsertime\.connectivity\.upstreamKbps/);
  assert.match(workflow, /--browsertime\.connectivity\.latency/);
});

test("external sitespeed workflow can only read repository content and upload reports", () => {
  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read/);
  assert.match(workflow, /uses:\s*actions\/upload-artifact@v6/);
  assert.match(workflow, /if:\s*always\(\)/);
  assert.doesNotMatch(workflow, /\$\{\{\s*secrets\./);
  assert.doesNotMatch(workflow, /\b(?:wrangler|deploy|scp|ssh|rsync|git\s+push|curl)\b/i);
  assert.doesNotMatch(workflow, /\b(?:POST|PUT|PATCH|DELETE)\b/);
});
