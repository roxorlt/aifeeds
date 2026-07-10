import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  consumeFeedPrefetch,
  feedResponseNetworkSource,
} from "./feed-prefetch.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

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
  assert.match(api, /return consumeFeedPrefetch\(pf\.promise, fetchFromNetwork\)/);
  assert.match(feed, /feedResponseNetworkSource\(res\)/);
  assert.doesNotMatch(feed, /await htmlPrefetchUsed|prefetched\.promise/);
});
