import assert from "node:assert/strict";
import test from "node:test";

import { getWaterfallCardModel } from "./waterfallCardModel.ts";

const BASE = {
  source_id: "fixture",
  scraped_at: "2026-07-18T08:00:00.000Z",
  published_at: "2026-07-18T07:00:00.000Z",
};

function item(source_type, overrides = {}) {
  return {
    ...BASE,
    id: `${source_type}:fixture`,
    source_type,
    title: `${source_type} title`,
    content: `${source_type} summary`,
    ...overrides,
  };
}

test("X cards prioritize author and body without duplicating body as a title", () => {
  const model = getWaterfallCardModel(item("x_list", {
    author: "Ada",
    handle: "@ada",
    title: null,
    content: "A concise observation about production agents.",
    metrics: { likes: 2_430, replies: 128, views: 31_000 },
  }));
  assert.equal(model.identity, "Ada");
  assert.equal(model.secondaryIdentity, "@ada");
  assert.equal(model.title, null);
  assert.equal(model.summary, "A concise observation about production agents.");
  assert.deepEqual(model.metrics, [
    { label: "赞", value: "2.4K" },
    { label: "回复", value: "128" },
  ]);
  assert.equal(model.mediaPosition, "after_text");
});

test("project, research, official, event, and video sources expose distinct compact models", () => {
  const cases = [
    [
      item("github", {
        source_id: "openai/codex",
        title: "Coding agent",
        metrics: { stars: 18_600, today_stars: 320, forks: 1_900 },
        extra: { language: "TypeScript" },
      }),
      { identity: "openai/codex", metric: "今日 ★", sourceLabel: "GitHub" },
    ],
    [
      item("product_hunt", {
        title: "Research Canvas",
        metrics: { votes: 482, comments: 67 },
      }),
      { identity: "Product Hunt", metric: "▲", sourceLabel: "Product Hunt" },
    ],
    [
      item("hf_paper", {
        title: "World Models",
        metrics: { upvotes: 326, num_comments: 18, github_stars: 8_100 },
        extra: { arxiv_id: "2607.00001" },
      }),
      { identity: "arXiv 2607.00001", metric: "赞同", sourceLabel: "AI 论文" },
    ],
    [
      item("blog", {
        title: "Reliable evaluations",
        extra: { source_company: "Anthropic", reading_minutes: 8 },
      }),
      { identity: "Anthropic", metric: "阅读", sourceLabel: "官方新闻" },
    ],
    [
      item("podcast", {
        title: "Agent infrastructure",
        extra: { show_name: "Latent Space", duration_sec: 3_360 },
      }),
      { identity: "Latent Space", metric: "时长", sourceLabel: "AI 播客" },
    ],
    [
      item("clawhub", {
        title: "browser-research",
        metrics: { stars: 3_200, downloads: 18_000, installsCurrent: 760 },
      }),
      { identity: "ClawHub", metric: "★", sourceLabel: "ClawHub" },
    ],
    [
      item("huodongxing", {
        title: "AI Builder Meetup",
        metrics: { registered_count: 280, visit_number: 4_600 },
        extra: { city: "上海", organizer: { name: "AI Builder", url: "https://example.com" } },
      }),
      { identity: "AI Builder", metric: "报名", sourceLabel: "AI 活动" },
    ],
    [
      item("youtube", {
        author: "AI Engineering",
        title: "Shipping agents",
        metrics: { views: 128_000, likes: 4_800 },
      }),
      { identity: "AI Engineering", metric: "播放", sourceLabel: "YouTube" },
    ],
  ];

  for (const [fixture, expected] of cases) {
    const model = getWaterfallCardModel(fixture);
    assert.equal(model.identity, expected.identity, fixture.source_type);
    assert.equal(model.sourceLabel, expected.sourceLabel, fixture.source_type);
    assert.equal(model.metrics[0]?.label, expected.metric, fixture.source_type);
    assert.ok(model.metrics.length <= 2, fixture.source_type);
    assert.equal(JSON.stringify(model).includes("undefined"), false, fixture.source_type);
  }
});

test("missing optional source data renders a stable fallback with no empty metric shell", () => {
  const model = getWaterfallCardModel(item("youtube", {
    title: null,
    content: null,
    author: null,
    metrics: "{broken",
    extra: "{broken",
  }));
  assert.equal(model.identity, "YouTube");
  assert.equal(model.title, "YouTube 动态");
  assert.equal(model.summary, "");
  assert.deepEqual(model.metrics, []);
});
