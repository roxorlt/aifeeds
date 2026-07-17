import assert from "node:assert/strict";
import test from "node:test";

import { homePathForItem } from "./itemPath.ts";

function item(sourceType, sourceId, id = `${sourceType}:${sourceId}`) {
  return {
    id,
    source_type: sourceType,
    source_id: sourceId,
    scraped_at: "2026-07-17T00:00:00.000Z",
  };
}

test("every drawer-supported source maps to its canonical path", () => {
  assert.equal(homePathForItem(item("x_list", "123")), "/t/123");
  assert.equal(homePathForItem(item("github", "open ai/codex web")), "/g/open%20ai/codex%20web");
  assert.equal(
    homePathForItem(item("product_hunt", "canvas-code:2026-07-17")),
    "/ph/canvas-code/2026-07-17",
  );
  assert.equal(homePathForItem(item("clawhub", "agent kit")), "/c/agent%20kit");
  assert.equal(homePathForItem(item("huodongxing", "5859894940100")), "/e/5859894940100");
  assert.equal(homePathForItem(item("hf_paper", "2607.12345")), "/h/2607.12345");
  assert.equal(
    homePathForItem(item("blog", "ignored", "blog:openai:abc/def")),
    "/o/blog%3Aopenai%3Aabc%2Fdef",
  );
  assert.equal(
    homePathForItem(item("podcast", "ignored", "podcast:latent-space:ep 1")),
    "/o/podcast%3Alatent-space%3Aep%201",
  );
});

test("malformed composite ids and unsupported sources have no home path", () => {
  assert.equal(homePathForItem(item("github", "owner-only")), null);
  assert.equal(homePathForItem(item("product_hunt", "slug-only")), null);
  assert.equal(homePathForItem(item("youtube", "video")), null);
});
