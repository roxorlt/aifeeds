#!/usr/bin/env node

import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const SAFE_HOSTS = new Set([
  "perf-staging.ai-feeds.com",
  "localhost",
  "127.0.0.1",
  "[::1]",
  "::1",
]);

const SAFE_PATHS = new Set(["/api/items", "/api/feed-manifest"]);

export function assertSafeBenchmarkUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid benchmark URL");
  }
  if (!SAFE_HOSTS.has(url.hostname)) {
    throw new Error(`refusing host: ${url.hostname}`);
  }
  if (!SAFE_PATHS.has(url.pathname)) {
    throw new Error(`refusing path: ${url.pathname}`);
  }
  if (url.username || url.password) {
    throw new Error("refusing credentials in benchmark URL");
  }
  if (url.hostname === "perf-staging.ai-feeds.com" && url.protocol !== "https:") {
    throw new Error("perf staging requires HTTPS");
  }
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new Error(`refusing protocol: ${url.protocol}`);
  }
  return url;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function createRunId() {
  return `upstream-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

function nearestRank(sorted, fraction) {
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index];
}

export function summarizeDurations(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return { count: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    min_ms: round(sorted[0]),
    p50_ms: round(nearestRank(sorted, 0.5)),
    p75_ms: round(nearestRank(sorted, 0.75)),
    p95_ms: round(nearestRank(sorted, 0.95)),
    max_ms: round(sorted.at(-1)),
  };
}

function readNumberArg(args, name, fallback, min, max) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const parsed = Number(args[index + 1]);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer in ${min}..${max}`);
  }
  return parsed;
}

function readStringArg(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) throw new Error(`missing ${name}`);
  return args[index + 1];
}

async function requestOnce(url, runId) {
  const started = performance.now();
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip, br",
      "X-Aifeeds-Perf-Probe": runId,
    },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  await response.arrayBuffer();
  return {
    durationMs: performance.now() - started,
    status: response.status,
    serverTiming: response.headers.get("server-timing") || "",
    requestId: response.headers.get("x-request-id") || "",
  };
}

async function runBatch(url, count, concurrency, runId) {
  const rows = [];
  for (let offset = 0; offset < count; offset += concurrency) {
    const size = Math.min(concurrency, count - offset);
    rows.push(...await Promise.all(
      Array.from({ length: size }, () => requestOnce(url, runId)),
    ));
  }
  return rows;
}

export async function runBenchmark({ url, warmup = 20, requests = 100, concurrency = 1 }) {
  const safeUrl = assertSafeBenchmarkUrl(url);
  const runId = createRunId();
  if (warmup > 0) {
    await runBatch(safeUrl, warmup, concurrency, createRunId());
  }
  const rows = await runBatch(safeUrl, requests, concurrency, runId);
  const statuses = Object.fromEntries(
    [...new Set(rows.map((row) => row.status))]
      .sort((a, b) => a - b)
      .map((status) => [status, rows.filter((row) => row.status === status).length]),
  );
  const successful = rows.filter((row) => row.status >= 200 && row.status < 300);
  return {
    run_id: runId,
    target: `${safeUrl.origin}${safeUrl.pathname}`,
    warmup,
    requests,
    concurrency,
    statuses,
    all_2xx: successful.length === rows.length,
    duration: summarizeDurations(rows.map((row) => row.durationMs)),
    timing_header_samples: successful.filter((row) => row.serverTiming).length,
    request_id_samples: successful.filter((row) => row.requestId).length,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const result = await runBenchmark({
    url: readStringArg(args, "--url"),
    warmup: readNumberArg(args, "--warmup", 20, 0, 100),
    requests: readNumberArg(args, "--requests", 100, 1, 1000),
    concurrency: readNumberArg(args, "--concurrency", 1, 1, 32),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.all_2xx) process.exitCode = 2;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
