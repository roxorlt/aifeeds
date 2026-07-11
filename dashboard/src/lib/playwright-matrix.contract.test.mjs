import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dashboard = path.resolve(here, "../..");
const root = path.resolve(dashboard, "..");
const config = fs.readFileSync(path.join(dashboard, "playwright.config.ts"), "utf8");
const spec = fs.readFileSync(path.join(dashboard, "e2e/home-performance.spec.ts"), "utf8");
const prWorkflow = fs.readFileSync(path.join(root, ".github/workflows/pr-validation.yml"), "utf8");
const deployWorkflow = fs.readFileSync(path.join(root, ".github/workflows/deploy-dashboard.yml"), "utf8");

test("mobile matrix contains real Chromium and WebKit engines", () => {
  assert.match(config, /name:\s*["']iphone-webkit["']/);
  assert.match(config, /browserName:\s*["']webkit["']/);
  assert.match(config, /name:\s*["']android-chromium["']/);
  assert.match(config, /name:\s*["']desktop-chromium["']/);
});

test("mobile swipe uses a non-CDP path under WebKit", () => {
  assert.match(spec, /projectName\.includes\(["']webkit["']\)/);
  assert.match(spec, /new TouchEvent\(type/);
  assert.doesNotMatch(spec, /new Touch\(/,
    "Playwright WebKit exposes TouchEvent but its Touch constructor is illegal");
  assert.match(spec, /Object\.defineProperties\(event/);
  assert.match(spec, /dispatch\(["']touchstart["']/);
  assert.match(spec, /newCDPSession/);
});

test("both CI hard gates install pinned Chromium and WebKit runtimes", () => {
  for (const workflow of [prWorkflow, deployWorkflow]) {
    assert.match(workflow, /playwright-chromium-webkit-/);
    assert.match(workflow, /playwright install --with-deps chromium webkit/);
    assert.match(workflow, /playwright install-deps chromium webkit/);
  }
});
