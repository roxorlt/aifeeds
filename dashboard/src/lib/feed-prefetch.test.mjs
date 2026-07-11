import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import {
  consumeFeedPrefetch,
  feedResponseNetworkSource,
} from "./feed-prefetch.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

function runHtmlPrefetchBootstrap({
  pathname,
  hostname = "staging.ai-feeds.com",
  configuredBase = "https://staging-api.ai-feeds.com",
  sameOrigin = false,
}) {
  const html = fs.readFileSync(path.join(here, "../../index.html"), "utf8");
  const inline = html.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
  assert.ok(inline, "parser-inline feed prefetch bootstrap must exist");
  const source = inline
    .replace("__AIFEEDS_API_SAME_ORIGIN__", JSON.stringify(sameOrigin))
    .replace("__AIFEEDS_API_BASE__", JSON.stringify(configuredBase));
  const fetches = [];
  const links = [];
  const window = {};
  vm.runInNewContext(source, {
    AbortController,
    document: {
      createElement: () => ({}),
      head: { appendChild: (link) => links.push({ ...link }) },
    },
    fetch: (url, init) => {
      fetches.push({ url, init });
      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
    },
    location: { hostname, pathname },
    window,
  });
  return { fetches, links, window };
}

test("parser prefetch only starts on the default feed homepage", () => {
  const blockedPaths = [
    "/search",
    "/settings",
    "/settings/account",
    "/s/share-token",
    "/t/123",
    "/g/owner/repo",
    "/ph/product/2026-07-11",
    "/c/skill",
    "/e/event",
    "/h/2607.00001",
    "/o/article",
    "/subscribe",
    "/me/subscription",
  ];

  const homepage = runHtmlPrefetchBootstrap({ pathname: "/" });
  assert.deepEqual(homepage.fetches.map(({ url }) => url), [
    "https://staging-api.ai-feeds.com/api/items?source_type=x_list&limit=12",
  ]);
  assert.ok(homepage.window.__feedPrefetch);

  for (const pathname of blockedPaths) {
    const result = runHtmlPrefetchBootstrap({ pathname });
    assert.equal(result.fetches.length, 0, `${pathname} must not prefetch x_list`);
    assert.equal(result.window.__feedPrefetch, undefined, pathname);
    assert.deepEqual(
      result.links.map(({ rel, href }) => ({ rel, href })),
      [
        { rel: "preconnect", href: "https://staging-api.ai-feeds.com" },
        { rel: "dns-prefetch", href: "https://staging-api.ai-feeds.com" },
      ],
      `${pathname} may warm the correct API origin without pulling list data`,
    );
  }
});

test("same-origin homepage prefetch stays relative and adds no second-origin hints", () => {
  const result = runHtmlPrefetchBootstrap({
    pathname: "/",
    configuredBase: "https://staging-api.ai-feeds.com",
    sameOrigin: true,
  });

  assert.deepEqual(result.fetches.map(({ url }) => url), [
    "/api/items?source_type=x_list&limit=12",
  ]);
  assert.deepEqual(result.links, []);
});

test("a fast valid HTML prefetch is marked as the actual response source", async () => {
  const prefetched = { items: [{ id: "prefetched" }] };
  let fallbackCalls = 0;
  const result = await consumeFeedPrefetch(
    Promise.resolve(prefetched),
    async () => {
      fallbackCalls += 1;
      return { items: [{ id: "network" }] };
    },
    20,
  );
  assert.equal(result, prefetched);
  assert.equal(feedResponseNetworkSource(result), "html_prefetch");
  assert.equal(fallbackCalls, 0);
});

test("a never-settling prefetch times out and cannot block a successful network fallback", async () => {
  const never = new Promise(() => {});
  const network = { items: [{ id: "network" }] };
  const result = await Promise.race([
    consumeFeedPrefetch(never, async () => network, 5),
    new Promise((_, reject) => setTimeout(() => reject(new Error("prefetch blocked fallback")), 100)),
  ]);
  assert.equal(result, network);
  assert.equal(feedResponseNetworkSource(result), "network");
});

test("a timed-out cancellable prefetch settles before the normalized fallback starts", async () => {
  let resolvePrefetch;
  const events = [];
  let activePrefetches = 1;
  const prefetch = new Promise((resolve) => { resolvePrefetch = resolve; });
  const network = { items: [{ id: "network" }] };

  const result = await consumeFeedPrefetch({
    promise: prefetch,
    cancel: async () => {
      events.push("abort");
      await new Promise((resolve) => setTimeout(resolve, 2));
      activePrefetches -= 1;
      resolvePrefetch(null);
      await prefetch;
      events.push("settled");
    },
  }, async () => {
    assert.equal(activePrefetches, 0, "fallback must not overlap the same HTML request");
    events.push("fallback");
    return network;
  }, 5);

  assert.equal(result, network);
  assert.deepEqual(events, ["abort", "settled", "fallback"]);
  assert.equal(feedResponseNetworkSource(result), "network");
});

test("a prefetch that settles after timeout cannot misattribute the fallback response", async () => {
  let resolvePrefetch;
  const late = new Promise((resolve) => { resolvePrefetch = resolve; });
  const network = { items: [{ id: "network" }] };
  const result = await consumeFeedPrefetch(late, async () => network, 5);
  resolvePrefetch({ items: [{ id: "late-prefetch" }] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(result, network);
  assert.equal(feedResponseNetworkSource(result), "network");
});

test("invalid or rejected prefetch values fall back without being marked", async () => {
  const networkA = { items: [{ id: "a" }] };
  const networkB = { items: [{ id: "b" }] };
  const invalid = await consumeFeedPrefetch(Promise.resolve(null), async () => networkA, 20);
  const rejected = await consumeFeedPrefetch(Promise.reject(new Error("failed")), async () => networkB, 20);
  assert.equal(feedResponseNetworkSource(invalid), "network");
  assert.equal(feedResponseNetworkSource(rejected), "network");
});

test("fetchItems delegates timeout and provenance to the non-blocking prefetch helper", () => {
  const api = fs.readFileSync(path.join(here, "../api.ts"), "utf8");
  const feed = fs.readFileSync(path.join(here, "../components/Feed.tsx"), "utf8");
  const html = fs.readFileSync(path.join(here, "../../index.html"), "utf8");
  assert.match(api, /return consumeFeedPrefetch\(pf, fetchFromNetwork\)/);
  assert.match(api, /cancel: \(\) => Promise<void>/);
  assert.match(html, /const controller = new AbortController\(\)/);
  assert.match(html, /signal: controller\.signal/);
  assert.match(html, /const settled = promise\.then/);
  assert.match(html, /cancel:\s*\(\) => \{[\s\S]*?controller\.abort\(\)[\s\S]*?return settled/);
  assert.doesNotMatch(html, /API_ERROR|track\(/,
    "aborting the raw HTML optimization must not emit API error telemetry");
  assert.match(feed, /feedResponseNetworkSource\(res\)/);
  assert.doesNotMatch(feed, /await htmlPrefetchUsed|prefetched\.promise/);
});
