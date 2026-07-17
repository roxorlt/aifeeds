#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SAFE_HOSTS = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
  "staging.ai-feeds.com",
  "perf-staging.ai-feeds.com",
]);
const REMOTE_HOSTS = new Set(["staging.ai-feeds.com", "perf-staging.ai-feeds.com"]);
const DEVICES = Object.freeze({
  desktop: {
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  },
  mobile: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
});

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function nearestRank(sorted, fraction) {
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

export function summarizeValues(values) {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length === 0) return { count: 0 };
  return {
    count: finite.length,
    min: round(finite[0]),
    p50: round(nearestRank(finite, 0.5)),
    p75: round(nearestRank(finite, 0.75)),
    p95: round(nearestRank(finite, 0.95)),
    max: round(finite.at(-1)),
  };
}

export function assertSafeViewUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid view URL");
  }
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new Error(`refusing protocol: ${url.protocol}`);
  }
  if (!SAFE_HOSTS.has(url.hostname)) throw new Error(`refusing host: ${url.hostname}`);
  if (REMOTE_HOSTS.has(url.hostname) && url.protocol !== "https:") {
    throw new Error("remote staging benchmark requires HTTPS");
  }
  if (url.username || url.password) throw new Error("refusing credentials in benchmark URL");
  if (url.pathname !== "/") throw new Error(`refusing path: ${url.pathname}`);
  return url;
}

export function assertSafeOutputPath(value, cwd = process.cwd()) {
  const allowedRoot = path.resolve(cwd, "output/home-view-benchmarks");
  const resolved = path.resolve(cwd, value);
  const relative = path.relative(allowedRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("output must stay inside the home-view benchmark directory");
  }
  return resolved;
}

function requiredArg(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) throw new Error(`missing ${name}`);
  return args[index + 1];
}

export function parseCliArgs(args, { cwd = process.cwd() } = {}) {
  const runsIndex = args.indexOf("--runs");
  const runs = runsIndex < 0 ? 5 : Number(args[runsIndex + 1]);
  if (!Number.isInteger(runs) || runs < 1 || runs > 20) throw new Error("--runs must be an integer in 1..20");
  const outputIndex = args.indexOf("--output");
  const outputValue = outputIndex < 0
    ? `output/home-view-benchmarks/run-${Date.now()}`
    : args[outputIndex + 1];
  if (!outputValue) throw new Error("missing --output value");
  return {
    classicUrl: assertSafeViewUrl(requiredArg(args, "--classic-url")).href,
    waterfallUrl: assertSafeViewUrl(requiredArg(args, "--waterfall-url")).href,
    runs,
    outputDir: assertSafeOutputPath(outputValue, cwd),
  };
}

function summarizeSamples(samples) {
  const summaries = [];
  for (const view of ["classic", "waterfall"]) {
    for (const device of Object.keys(DEVICES)) {
      for (const cache of ["cold", "warm"]) {
        const rows = samples.filter((row) => row.view === view && row.device === device && row.cache === cache);
        summaries.push({
          view,
          device,
          cache,
          lcp_ms: summarizeValues(rows.map((row) => row.lcp_ms)),
          fcp_ms: summarizeValues(rows.map((row) => row.fcp_ms)),
          ttfb_ms: summarizeValues(rows.map((row) => row.ttfb_ms)),
          cls: summarizeValues(rows.map((row) => row.cls)),
          requests: summarizeValues(rows.map((row) => row.requests)),
          transfer_kb: summarizeValues(rows.map((row) => row.transfer_kb)),
        });
      }
    }
  }
  return summaries;
}

function cell(value) {
  return Number.isFinite(value) ? String(value) : "—";
}

export function renderMarkdown(result) {
  const lines = [
    "# Home View Benchmark",
    "",
    `Generated: ${result.generated_at}`,
    `Runs per view/device/cache: ${result.runs}`,
    "",
    `- Classic: ${result.targets.classic}`,
    `- Waterfall: ${result.targets.waterfall}`,
    "",
    "| View | Device | Cache | LCP p50 ms | LCP p75 ms | TTFB p75 ms | CLS p75 | Requests p50 | Transfer p50 KB |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const row of result.summaries) {
    lines.push(`| ${row.view} | ${row.device} | ${row.cache} | ${cell(row.lcp_ms.p50)} | ${cell(row.lcp_ms.p75)} | ${cell(row.ttfb_ms.p75)} | ${cell(row.cls.p75)} | ${cell(row.requests.p50)} | ${cell(row.transfer_kb.p50)} |`);
  }
  lines.push("", "Cold and warm rows use fresh browser contexts; warm rows perform one unmeasured navigation before measurement.", "");
  return lines.join("\n");
}

async function installObservers(context) {
  await context.addInitScript(() => {
    globalThis.__aifeedsHomePerf = { lcp: 0, cls: 0 };
    try {
      new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const last = entries.at(-1);
        if (last) globalThis.__aifeedsHomePerf.lcp = last.startTime;
      }).observe({ type: "largest-contentful-paint", buffered: true });
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) globalThis.__aifeedsHomePerf.cls += entry.value;
        }
      }).observe({ type: "layout-shift", buffered: true });
    } catch {
      // Unsupported observers remain zero and are visible in the report.
    }
  });
}

async function readPageMetrics(page) {
  await page.waitForTimeout(600);
  return page.evaluate(() => {
    const navigation = performance.getEntriesByType("navigation")[0];
    const paints = Object.fromEntries(performance.getEntriesByType("paint").map((entry) => [entry.name, entry.startTime]));
    const resources = performance.getEntriesByType("resource");
    const transferred = resources.reduce((sum, entry) => sum + (entry.transferSize || entry.encodedBodySize || 0), 0)
      + (navigation?.transferSize || navigation?.encodedBodySize || 0);
    return {
      mode: document.documentElement.dataset.viewMode || "unknown",
      ttfb_ms: navigation ? navigation.responseStart - navigation.startTime : 0,
      fcp_ms: paints["first-contentful-paint"] || 0,
      lcp_ms: globalThis.__aifeedsHomePerf?.lcp || 0,
      cls: globalThis.__aifeedsHomePerf?.cls || 0,
      requests: resources.length + (navigation ? 1 : 0),
      transfer_kb: transferred / 1024,
      ssr_articles: document.querySelectorAll('[data-rendered="server"] article').length,
    };
  });
}

async function measureOne(browser, { url, view, device, cache }) {
  const context = await browser.newContext(DEVICES[device]);
  await installObservers(context);
  const page = await context.newPage();
  try {
    if (cache === "warm") await page.goto(url, { waitUntil: "load", timeout: 30_000 });
    await page.goto(url, { waitUntil: "load", timeout: 30_000 });
    const metrics = await readPageMetrics(page);
    return {
      view,
      device,
      cache,
      ...Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, typeof value === "number" ? round(value) : value])),
    };
  } finally {
    await context.close();
  }
}

export async function runHomeViewBenchmark({ classicUrl, waterfallUrl, runs }) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const targets = { classic: classicUrl, waterfall: waterfallUrl };
  const samples = [];
  try {
    for (const [view, url] of Object.entries(targets)) {
      for (const device of Object.keys(DEVICES)) {
        for (const cache of ["cold", "warm"]) {
          for (let run = 1; run <= runs; run += 1) {
            samples.push({ run, ...await measureOne(browser, { url, view, device, cache }) });
          }
        }
      }
    }
  } finally {
    await browser.close();
  }
  return {
    generated_at: new Date().toISOString(),
    runs,
    targets,
    samples,
    summaries: summarizeSamples(samples),
  };
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const result = await runHomeViewBenchmark(options);
  await mkdir(options.outputDir, { recursive: true });
  const jsonPath = path.join(options.outputDir, "results.json");
  const markdownPath = path.join(options.outputDir, "summary.md");
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`, "utf8"),
    writeFile(markdownPath, renderMarkdown(result), "utf8"),
  ]);
  process.stdout.write(`${jsonPath}\n${markdownPath}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
