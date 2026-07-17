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

test("external sitespeed workflow is pinned to the approved branch and production URL", () => {
  assert.match(workflow, /branches:\s*\n\s*-\s*'codex\/waterfall-ssr-rum-parallel'/);
  assert.match(workflow, /paths:\s*\n\s*-\s*'\.github\/workflows\/sitespeed-external\.yml'/);
  assert.deepEqual(
    [...workflow.matchAll(/https:\/\/[^\s"']+/g)].map(([url]) => url),
    ["https://ai-feeds.com/"],
    "the read-only production target must be the workflow's only URL",
  );
  assert.doesNotMatch(workflow, /\bmain\b/);
});

test("external sitespeed workflow runs a reproducible five-run mobile and desktop matrix", () => {
  assert.match(workflow, /sitespeedio\/sitespeed\.io:42\.0\.1/);
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
