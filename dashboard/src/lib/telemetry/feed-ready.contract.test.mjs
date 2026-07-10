import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const feed = fs.readFileSync(path.join(here, "../../components/Feed.tsx"), "utf8");
const provenance = fs.readFileSync(path.join(here, "../feed-prefetch.ts"), "utf8");

test("Feed wires an unsampled page-once feed_ready after paint with bounded provenance", () => {
  assert.match(feed, /createFeedReadyScheduler/);
  assert.match(feed, /EVENTS\.FEED_READY/);
  assert.match(feed, /data-feed-source=\{sourceType\}/);
  assert.match(feed, /query_time_ms/);
  for (const source of ["memory_cache", "local_snapshot", "network"]) {
    assert.match(feed, new RegExp(`["']${source}["']`));
  }
  assert.match(provenance, /['"]html_prefetch['"]/);
  const feedReadyBlock = feed.match(/createFeedReadyScheduler\([\s\S]{0,900}/)?.[0] ?? "";
  assert.doesNotMatch(feedReadyBlock, /Math\.random|SAMPLE_RATE/);
});
