import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const mockup = readFileSync(
  new URL("../../docs/plans/_mockups/2026-07-18-waterfall-compact-cards.html", import.meta.url),
  "utf8",
);

test("compact waterfall preview starts with the grid without a redundant feed heading", () => {
  assert.doesNotMatch(mockup, /今日值得看|全来源混排 · 持续更新/);
  assert.doesNotMatch(mockup, /feed-tools(?:__title)?/);
  assert.match(
    mockup,
    /<section class="feed-main">\s*<ol class="masonry" data-canvas="desktop">/,
  );
  assert.match(
    mockup,
    /\.masonry\s*{[^}]*grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\)/s,
  );
  assert.match(
    mockup,
    /\.app-canvas--mobile \.masonry\s*{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s,
  );
});
