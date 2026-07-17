import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHomeFeedClientPath,
  fetchHomeFeedPage,
  getHomeCardModel,
  parseInitialHomeFeed,
} from "./homeData.ts";

const fixture = {
  id: "blog:openai:fixture",
  source_type: "blog",
  source_id: "fixture",
  title: "Original title",
  content: "Original body",
  scraped_at: "2026-07-17T00:00:00.000Z",
  extra: {
    title_zh: "中文标题",
    excerpt_zh: "更适合卡片的中文摘要",
    cover_image: "https://third-party.example/unsafe.jpg",
    cover_image_variants: [
      { url: "/r/blog/card/fixture-400.webp", width: 400, height: 225, format: "webp" },
      { url: "javascript:alert(1)", width: 800, height: 450, format: "webp" },
    ],
  },
};

function response(items = [fixture]) {
  return {
    view_mode: "waterfall",
    items,
    next_cursor: "next",
    has_more: true,
    query_time_ms: 4.2,
    generated_at: "2026-07-17T00:00:00.000Z",
  };
}

test("initial data accepts only the waterfall JSON contract", () => {
  assert.deepEqual(parseInitialHomeFeed(JSON.stringify(response())), response());
  assert.throws(() => parseInitialHomeFeed("alert(1)"), /initial home feed/i);
  assert.throws(
    () => parseInitialHomeFeed(JSON.stringify({ ...response(), view_mode: "classic" })),
    /initial home feed/i,
  );
  assert.throws(
    () => parseInitialHomeFeed(JSON.stringify({ ...response(), items: [{ id: "<script>" }] })),
    /initial home feed/i,
  );
});

test("card presentation is source-aware and only selects bounded internal image variants", () => {
  const model = getHomeCardModel(fixture);
  assert.equal(model.sourceLabel, "官方新闻");
  assert.equal(model.title, "中文标题");
  assert.equal(model.summary, "更适合卡片的中文摘要");
  assert.deepEqual(model.image, {
    src: "/r/blog/card/fixture-400.webp",
    width: 400,
    height: 225,
    alt: "中文标题",
  });
  assert.equal(JSON.stringify(model).includes("third-party.example"), false);
  assert.equal(JSON.stringify(model).includes("javascript:"), false);
});

test("client pagination is same-origin, bounded, abortable, and cursor-aware", async () => {
  assert.equal(buildHomeFeedClientPath(null, 1), "/_home/feed?limit=12");
  assert.equal(
    buildHomeFeedClientPath("a/b?c", 99),
    "/_home/feed?limit=48&cursor=a%2Fb%3Fc",
  );

  const controller = new AbortController();
  let captured;
  const result = await fetchHomeFeedPage({
    cursor: "next/cursor",
    limit: 24,
    signal: controller.signal,
    fetchImpl: async (input, init) => {
      captured = { input, init };
      return Response.json(response());
    },
  });
  assert.equal(captured.input, "/_home/feed?limit=24&cursor=next%2Fcursor");
  assert.equal(captured.init.signal, controller.signal);
  assert.equal(captured.init.credentials, "same-origin");
  assert.equal(result.view_mode, "waterfall");
});
