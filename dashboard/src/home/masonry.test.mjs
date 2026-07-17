import assert from "node:assert/strict";
import test from "node:test";

import {
  MASONRY_GAP_PX,
  MASONRY_ROW_PX,
  estimateMasonryHeight,
  masonryRowSpan,
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
  assert.equal(masonryRowSpan(0), 1);
  assert.equal(masonryRowSpan(8), 1);
  assert.equal(masonryRowSpan(9), 2);
  assert.equal(masonryRowSpan(188), 10);
  assert.equal(masonryRowSpan(188), masonryRowSpan(188));
});

test("SSR estimates are deterministic and media creates a taller card", () => {
  const textHeight = estimateMasonryHeight(item);
  const mediaHeight = estimateMasonryHeight(item, { aspectRatio: 16 / 9 });
  assert.equal(textHeight, estimateMasonryHeight(item));
  assert.ok(textHeight > 100);
  assert.ok(mediaHeight > textHeight);
  assert.ok(masonryRowSpan(mediaHeight) >= masonryRowSpan(textHeight));
});
