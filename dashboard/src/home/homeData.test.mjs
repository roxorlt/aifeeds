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
    ranking_version: 2,
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
  assert.throws(
    () => parseInitialHomeFeed(JSON.stringify({ ...response(), ranking_version: 3 })),
    /initial home feed/i,
  );
  const { ranking_version: _rankingVersion, ...withoutRankingVersion } = response();
  assert.deepEqual(
    parseInitialHomeFeed(JSON.stringify(withoutRankingVersion)),
    { ...withoutRankingVersion, ranking_version: 1 },
  );
});

test("YouTube is accepted as a live ninth source and has a stable label", () => {
  const youtube = {
    ...fixture,
    id: "youtube:fixture",
    source_type: "youtube",
    source_id: "fixture-video",
    title: "Agent systems in production",
  };
  const parsed = parseInitialHomeFeed(JSON.stringify(response([youtube])));
  assert.equal(parsed.items[0].source_type, "youtube");
  assert.equal(getHomeCardModel(youtube).sourceLabel, "YouTube");
});

test("card presentation is source-aware and only selects bounded internal image variants", () => {
  const model = getHomeCardModel(fixture);
  assert.equal(model.sourceLabel, "官方新闻");
  assert.equal(model.title, "中文标题");
  assert.equal(model.summary, "更适合卡片的中文摘要");
  assert.deepEqual(model.image, {
    src: "https://api.ai-feeds.com/r/blog/card/fixture-400.webp",
    width: 400,
    height: 225,
    alt: "中文标题",
  });
  assert.equal(JSON.stringify(model).includes("third-party.example"), false);
  assert.equal(JSON.stringify(model).includes("javascript:"), false);
});

test("cards fall back to safe source media when ingestion-time variants are not ready", () => {
  const xImage = getHomeCardModel({
    ...fixture,
    id: "x_list:image",
    source_type: "x_list",
    media: [{
      type: "image",
      url: "/r/x/fallback.jpg",
      width: 880,
      height: 1068,
    }],
    extra: {},
  });
  assert.deepEqual(xImage.image, {
    src: "https://api.ai-feeds.com/r/x/fallback.jpg",
    width: 880,
    height: 1068,
    alt: "Original title",
  });

  const eventImage = getHomeCardModel({
    ...fixture,
    id: "huodongxing:event",
    source_type: "huodongxing",
    media: [{ role: "thumbnail", url: "https://cdn.huodongxing.com/event.jpg" }],
    extra: {
      og_image: "https://wimg.huodongxing.com/event.jpg",
    },
  });
  assert.deepEqual(eventImage.image, {
    src: "https://api.ai-feeds.com/img?url=https%3A%2F%2Fwimg.huodongxing.com%2Fevent.jpg&w=640",
    width: 800,
    height: 450,
    alt: "Original title",
    crop: true,
  });

  const videoPoster = getHomeCardModel({
    ...fixture,
    id: "x_list:video",
    source_type: "x_list",
    media: [{
      type: "video",
      url: "https://video.twimg.com/video.mp4",
      poster: "/r/x/poster.jpg",
      width: 1280,
      height: 720,
    }],
    extra: {},
  });
  assert.equal(videoPoster.image?.src, "https://api.ai-feeds.com/r/x/poster.jpg");
  assert.equal(videoPoster.image?.width, 1280);
  assert.equal(videoPoster.image?.height, 720);
});

test("raw animated and unsafe media never bypass the verified static preview contract", () => {
  const model = getHomeCardModel({
    ...fixture,
    id: "product_hunt:animated",
    source_type: "product_hunt",
    media: [
      {
        type: "image",
        url: "https://ph-files.imgix.net/demo.gif",
        width: 1200,
        height: 800,
        card_preview_status: "unavailable",
      },
      {
        type: "image",
        url: "javascript:alert(1)",
        width: 1200,
        height: 800,
      },
    ],
    extra: {},
  });
  assert.equal(model.image, null);
});

test("unproxied third-party covers never load directly in waterfall cards", () => {
  const model = getHomeCardModel({
    ...fixture,
    id: "blog:unproxied-cover",
    extra: {
      cover_image: "https://third-party.example/cover.jpg",
    },
    media: [],
  });
  assert.equal(model.image, null);
});

test("card dates are identical across the edge UTC and browser local time zones", () => {
  const previousTimeZone = process.env.TZ;
  const item = {
    ...fixture,
    published_at: "2026-07-18 07:08:43",
  };
  try {
    process.env.TZ = "UTC";
    const edgeMeta = getHomeCardModel(item).meta;
    process.env.TZ = "Asia/Shanghai";
    const browserMeta = getHomeCardModel(item).meta;
    assert.equal(edgeMeta, "2026-07-18");
    assert.equal(browserMeta, edgeMeta);
  } finally {
    if (previousTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimeZone;
  }
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
