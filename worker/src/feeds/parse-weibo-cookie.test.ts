import assert from "node:assert/strict";
import test from "node:test";

import {
  WeiboCookieMissingError,
  buildFeedFetchHeaders,
} from "./parse";
import type { FeedDef } from "./types";

const weiboFeed: FeedDef = {
  id: "blog:weibo-hot-tech",
  key: "weibo-hot-tech",
  kind: "blog",
  format: "rss",
  source_company: "微博",
  name: "微博科技热搜",
  region: "domestic",
  via: "rsshub",
  feed_url: "/weibo/hot/tech",
  cadence_hours: 2,
  fetch_strategy: "native",
  skip_cn_sensitive: true,
  needs_weibo_cookie: true,
};

test("buildFeedFetchHeaders forwards Weibo cookie only for flagged feeds", () => {
  const headers = buildFeedFetchHeaders(
    {
      RSSHUB_TOKEN: "rsshub-token",
      WEIBO_COOKIES: "SUB=_2A25...",
    },
    weiboFeed,
  );

  assert.equal(headers["X-RSSHub-Token"], "rsshub-token");
  assert.equal(headers["X-Weibo-Cookie"], "SUB=_2A25...");
});

test("buildFeedFetchHeaders fails clearly when a Weibo feed has no cookie", () => {
  assert.throws(
    () => buildFeedFetchHeaders({ RSSHUB_TOKEN: "rsshub-token" }, weiboFeed),
    WeiboCookieMissingError,
  );
});
