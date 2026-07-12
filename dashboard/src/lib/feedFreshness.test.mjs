import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { newestScrapedAt } from "./feedFreshness.ts";

const feed = fs.readFileSync(new URL("../components/Feed.tsx", import.meta.url), "utf8");

test("cached feed freshness seeds polling from the newest cached item", () => {
  assert.equal(newestScrapedAt([]), null);
  assert.equal(newestScrapedAt([
    { scraped_at: "2026-07-12 01:00:00" },
    { scraped_at: "2026-07-12 03:00:00" },
    { scraped_at: "2026-07-12 02:00:00" },
  ]), "2026-07-12 03:00:00");
});

test("Feed initializes the poll cursor before a fresh cache hit can skip the network", () => {
  assert.match(feed, /useRef<string \| null>\(newestScrapedAt\(cachedInit\?\.items \?\? \[\]\)\)/);
  const cacheSkip = feed.slice(
    feed.indexOf("// 切回频道秒切"),
    feed.indexOf("let cancelled = false"),
  );
  assert.match(cacheSkip, /return;/);
  assert.doesNotMatch(cacheSkip, /lastScrapedAt\.current = null/);
});

test("network and hot-sort responses advance polling from the newest item, not row zero", () => {
  assert.doesNotMatch(feed, /lastScrapedAt\.current = (?:res\.items|fresh)\[0\][?]?\.scraped_at/);
  assert.ok(
    [...feed.matchAll(/lastScrapedAt\.current = newestScrapedAt\(/g)].length >= 3,
    "initial load, poll, and hot refresh must share the max-timestamp helper",
  );
});
