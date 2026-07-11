import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertSafeBenchmarkUrl,
  runBenchmark,
  summarizeDurations,
} from "./benchmark-aifeeds-upstream.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(here, "..", "deploy", "nginx", "aifeeds-upstream-performance.conf");

test("benchmark refuses production, arbitrary hosts and personalized endpoints", () => {
  assert.doesNotThrow(() => assertSafeBenchmarkUrl("https://perf-staging.ai-feeds.com/api/items?limit=1"));
  assert.doesNotThrow(() => assertSafeBenchmarkUrl("http://127.0.0.1:4173/api/feed-manifest"));
  assert.throws(() => assertSafeBenchmarkUrl("https://ai-feeds.com/api/items"), /refusing host/i);
  assert.throws(() => assertSafeBenchmarkUrl("https://perf-staging.ai-feeds.com/api/auth/me"), /refusing path/i);
  assert.throws(() => assertSafeBenchmarkUrl("https://example.com/api/items"), /refusing host/i);
});

test("duration summaries use deterministic nearest-rank percentiles", () => {
  assert.deepEqual(summarizeDurations([10, 20, 30, 40, 50]), {
    count: 5,
    min_ms: 10,
    p50_ms: 30,
    p75_ms: 40,
    p95_ms: 50,
    max_ms: 50,
  });
});

test("warmup requests use a probe distinct from the measured run", async () => {
  const originalFetch = globalThis.fetch;
  const probes = [];
  globalThis.fetch = async (_url, init) => {
    probes.push(new Headers(init?.headers).get("X-Aifeeds-Perf-Probe"));
    return new Response("{}", {
      status: 200,
      headers: {
        "Server-Timing": "d1;dur=1",
        "X-Request-Id": "benchmark-test-request",
      },
    });
  };

  try {
    const result = await runBenchmark({
      url: "http://127.0.0.1:4173/api/items?limit=1",
      warmup: 2,
      requests: 3,
      concurrency: 1,
    });
    const measured = probes.filter((probe) => probe === result.run_id);
    const warmup = probes.filter((probe) => probe !== result.run_id);

    assert.equal(measured.length, result.requests);
    assert.equal(warmup.length, result.warmup);
    assert.equal(new Set(warmup).size, 1);
    assert.notEqual(warmup[0], result.run_id);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("versioned nginx template is fail-closed and cannot pin Cloudflare IPs or enable cache", () => {
  const config = fs.readFileSync(configPath, "utf8");

  assert.match(config, /__TRUSTED_RESOLVER__/);
  assert.match(config, /__WORKER_UPSTREAM_HOST__/);
  assert.match(config, /server __WORKER_UPSTREAM_HOST__:443 resolve/);
  assert.match(config, /keepalive 16/);
  assert.match(config, /keepalive_timeout 30s/);
  assert.match(config, /keepalive_requests 1000/);
  assert.doesNotMatch(config, /\b(?:104\.\d+|172\.6[4-9]\.\d+|188\.114\.\d+)\b/);
  assert.doesNotMatch(config, /^\s*proxy_cache\s+(?!off)/m);
  assert.doesNotMatch(config, /^\s*proxy_set_header\s+X-Origin-Secret\s+/m);
  assert.match(config, /proxy_set_header Host __WORKER_UPSTREAM_HOST__/);
  assert.match(config, /proxy_ssl_name __WORKER_UPSTREAM_HOST__/);
});
