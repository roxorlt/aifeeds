import assert from "node:assert/strict";
import test from "node:test";

import {
  MASONRY_GAP_PX,
  MASONRY_ROW_PX,
  MASONRY_SSR_SAFETY_PX,
  estimateMasonryHeight,
  masonryRowSpan,
  nonShrinkingMasonrySpan,
} from "./masonry.ts";

const item = {
  id: "blog:openai:fixture",
  source_type: "blog",
  source_id: "fixture",
  title: "A useful title",
  content: "A compact summary that gives the card enough editorial context.",
  scraped_at: "2026-07-17T00:00:00.000Z",
};

test("measured row spans are positive and use one explicit row-gap contract", () => {
  assert.equal(MASONRY_ROW_PX, 8);
  assert.equal(MASONRY_GAP_PX, 12);
  assert.equal(MASONRY_SSR_SAFETY_PX, 20);
  assert.equal(masonryRowSpan(0), 1);
  assert.equal(masonryRowSpan(8), 1);
  assert.equal(masonryRowSpan(9), 2);
  assert.equal(masonryRowSpan(188), 10);
  assert.equal(masonryRowSpan(188), masonryRowSpan(188));
});

test("hydration may grow an underestimated card but never shrinks the server span", () => {
  assert.equal(nonShrinkingMasonrySpan(12, 188), 12);
  assert.equal(nonShrinkingMasonrySpan(12, 231.5), 13);
  assert.equal(nonShrinkingMasonrySpan(Number.NaN, 188), 10);
});

test("SSR estimates are deterministic and media creates a taller card", () => {
  const textHeight = estimateMasonryHeight(item);
  const mediaHeight = estimateMasonryHeight(item, { aspectRatio: 16 / 9 });
  const squareMediaHeight = estimateMasonryHeight(item, { aspectRatio: 1 });
  assert.equal(textHeight, estimateMasonryHeight(item));
  assert.ok(textHeight > 100);
  assert.ok(mediaHeight > textHeight);
  assert.equal(squareMediaHeight - textHeight, 200);
  assert.ok(masonryRowSpan(mediaHeight) >= masonryRowSpan(textHeight));
});
