import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const vitals = fs.readFileSync(path.join(here, "vitals.ts"), "utf8");
const main = fs.readFileSync(path.join(here, "../../main.tsx"), "utf8");
const app = fs.readFileSync(path.join(here, "../../App.tsx"), "utf8");

test("final LCP is safely enriched and settles the local performance gate", () => {
  assert.match(vitals, /onLCP\(\(metric\)\s*=>/);
  assert.match(vitals, /safeLcpDescriptorFromMetric\(metric,/);
  assert.match(vitals, /window\.dispatchEvent\(new Event\('aifeeds:lcp-settled'\)\)/);
});

test("non-LCP web-vitals retain their existing reporters", () => {
  for (const pair of [
    ["onINP", "PERF_INP"],
    ["onCLS", "PERF_CLS"],
    ["onTTFB", "PERF_TTFB"],
    ["onFCP", "PERF_FCP"],
  ]) {
    assert.match(vitals, new RegExp(`${pair[0]}\\(report\\(EVENTS\\.${pair[1]}\\)\\)`));
  }
});

test("main bootstraps telemetry before React on every route and DashboardHome does not duplicate it", () => {
  assert.match(main, /createTelemetryBootstrap/);
  const bootstrapAt = main.indexOf('bootstrapTelemetry()');
  const renderAt = main.indexOf('createRoot(');
  assert.ok(bootstrapAt >= 0 && renderAt >= 0 && bootstrapAt < renderAt);
  assert.match(main, /try\s*\{\s*const bootstrapTelemetry = createTelemetryBootstrap\(/);
  assert.match(main, /bootstrapTelemetry\(\)\s*\}\s*catch/);
  assert.doesNotMatch(main, /window\.addEventListener\('load', installApiObserver/);
  assert.doesNotMatch(app, /initTelemetry\(|installVitals\(|installNavTiming\(|installImgTiming\(|installErrorHandlers\(/);
  assert.match(vitals, /track\(EVENTS\.PERF_API, detail\)/);
});

test("image timing keeps its sampling while excluding same-origin static assets", () => {
  assert.match(vitals, /const IMG_SAMPLE = 0\.25/);
  assert.match(vitals, /Math\.random\(\) >= IMG_SAMPLE/);
  assert.match(vitals, /resource\.kind === 'none' \|\| resource\.kind === 'static_asset'/);
});
