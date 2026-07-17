import assert from "node:assert/strict";
import test from "node:test";

import {
  assertSafeOutputPath,
  assertSafeViewUrl,
  parseCliArgs,
  renderMarkdown,
  summarizeValues,
} from "./benchmark-home-views.mjs";

test("view benchmark refuses production and arbitrary hosts", () => {
  assert.equal(assertSafeViewUrl("http://127.0.0.1:4174/?view=classic").hostname, "127.0.0.1");
  assert.equal(assertSafeViewUrl("https://staging.ai-feeds.com/?view=waterfall").hostname, "staging.ai-feeds.com");
  assert.throws(() => assertSafeViewUrl("https://ai-feeds.com/?view=classic"), /refusing host/i);
  assert.throws(() => assertSafeViewUrl("https://example.com/?view=classic"), /refusing host/i);
  assert.throws(() => assertSafeViewUrl("file:///tmp/index.html"), /refusing protocol/i);
  assert.throws(() => assertSafeViewUrl("https://user:secret@staging.ai-feeds.com/"), /credentials/i);
  assert.throws(() => assertSafeViewUrl("https://staging.ai-feeds.com/search"), /refusing path/i);
});

test("summary uses deterministic nearest-rank percentiles", () => {
  assert.deepEqual(summarizeValues([50, 10, 40, 20, 30]), {
    count: 5,
    min: 10,
    p50: 30,
    p75: 40,
    p95: 50,
    max: 50,
  });
  assert.deepEqual(summarizeValues([]), { count: 0 });
});

test("CLI bounds repetitions and keeps reports inside the ignored benchmark directory", () => {
  const cwd = "/workspace/dashboard";
  const parsed = parseCliArgs([
    "--classic-url", "http://127.0.0.1:4174/?view=classic",
    "--waterfall-url", "http://127.0.0.1:4174/?view=waterfall",
    "--runs", "3",
    "--output", "output/home-view-benchmarks/local-check",
  ], { cwd });

  assert.equal(parsed.runs, 3);
  assert.equal(parsed.outputDir, "/workspace/dashboard/output/home-view-benchmarks/local-check");
  assert.throws(() => parseCliArgs([
    "--classic-url", "http://127.0.0.1:4174/",
    "--waterfall-url", "http://127.0.0.1:4174/",
    "--runs", "21",
  ], { cwd }), /1\.\.20/);
  assert.throws(() => assertSafeOutputPath("../outside", cwd), /benchmark directory/i);
});

test("Markdown renders stable classic and waterfall device rows", () => {
  const markdown = renderMarkdown({
    generated_at: "2026-07-17T00:00:00.000Z",
    runs: 2,
    targets: { classic: "http://127.0.0.1/?view=classic", waterfall: "http://127.0.0.1/?view=waterfall" },
    summaries: [{
      view: "classic",
      device: "desktop",
      cache: "cold",
      lcp_ms: { p50: 120, p75: 150 },
      ttfb_ms: { p75: 20 },
      cls: { p75: 0.01 },
      requests: { p50: 8 },
      transfer_kb: { p50: 42.5 },
    }, {
      view: "waterfall",
      device: "mobile",
      cache: "warm",
      lcp_ms: { p50: 140, p75: 170 },
      ttfb_ms: { p75: 22 },
      cls: { p75: 0.02 },
      requests: { p50: 9 },
      transfer_kb: { p50: 45.25 },
    }],
  });

  assert.match(markdown, /\| classic \| desktop \| cold \| 120 \| 150 \| 20 \| 0\.01 \| 8 \| 42\.5 \|/);
  assert.match(markdown, /\| waterfall \| mobile \| warm \| 140 \| 170 \| 22 \| 0\.02 \| 9 \| 45\.25 \|/);
  assert.doesNotMatch(markdown, /undefined/);
});
