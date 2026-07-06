// worker/src/search/sync.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { extractSearchFields } from "./sync";

const base = {
  id: "github:foo/bar", source_type: "github", title: "foo/bar",
  content: null, content_translated: null, author: "foo", handle: null,
  published_at: "2026-07-01T00:00:00Z", is_relevant: 1, deleted_at: null,
  extra: JSON.stringify({ workflow_completed_at: "2026-07-01T00:05:00Z", ai_summary: "一个 AI 工具", ai_category: "agent" }),
};

test("github：title=repo，body 含 ai_summary+category，author=owner", () => {
  const f = extractSearchFields(base as any)!;
  assert.equal(f.title, "foo/bar");
  assert.match(f.body, /一个 AI 工具/);
  assert.match(f.body, /agent/);
  assert.match(f.author, /foo/);
});
test("未完成 workflow 的行返回 null", () => {
  assert.equal(extractSearchFields({ ...base, extra: JSON.stringify({}) } as any), null);
});
test("cn_sensitive / dedup_of / 软删 / is_relevant=0 返回 null", () => {
  const mk = (patch: object) =>
    extractSearchFields({ ...base, extra: JSON.stringify({ workflow_completed_at: "x", ...patch }) } as any);
  assert.equal(mk({ cn_sensitive: 1 }), null);
  assert.equal(mk({ dedup_of: "github:a/b" }), null);
  assert.equal(extractSearchFields({ ...base, deleted_at: 123 } as any), null);
  assert.equal(extractSearchFields({ ...base, is_relevant: 0 } as any), null);
});
test("x_list：body 含原文与译文，author 含名字+handle", () => {
  const f = extractSearchFields({
    ...base, id: "x_list:1", source_type: "x_list", title: null,
    content: "hello world", content_translated: "你好世界", author: "Some One", handle: "someone",
  } as any)!;
  assert.match(f.body, /hello world/);
  assert.match(f.body, /你好世界/);
  assert.match(f.author, /someone/);
});
test("podcast：shownotes_zh 截 1000 字，不含 transcript", () => {
  const f = extractSearchFields({
    ...base, id: "podcast:1", source_type: "podcast", title: "第 1 期",
    extra: JSON.stringify({ workflow_completed_at: "x", title_zh: "中文标题",
      shownotes_zh: "长".repeat(3000), transcript_text_zh: "禁止出现" }),
  } as any)!;
  assert.ok(f.body.length <= 1100);
  assert.ok(!f.body.includes("禁止出现"));
  assert.match(f.title, /中文标题/);
});
