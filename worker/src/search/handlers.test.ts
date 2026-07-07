import test from "node:test";
import assert from "node:assert/strict";
import { validateSearchParams } from "./handlers";

const u = (qs: string) => new URL(`https://api.example.com/api/search?${qs}`);

test("正常 q", () => {
  const r = validateSearchParams(u("q=大模型"));
  assert.deepEqual(r, { ok: true, q: "大模型", source: null, cursor: null, limit: 20 });
});
test("空/纯空白 q → empty_query", () => {
  assert.equal((validateSearchParams(u("q=")) as any).error, "empty_query");
  assert.equal((validateSearchParams(u("q=%20%20")) as any).error, "empty_query");
});
test("超 100 字符 → query_too_long", () => {
  assert.equal((validateSearchParams(u(`q=${"a".repeat(101)}`)) as any).error, "query_too_long");
});
test("非法 source → invalid_source；合法 source 通过", () => {
  assert.equal((validateSearchParams(u("q=x&source=evil")) as any).error, "invalid_source");
  assert.equal((validateSearchParams(u("q=x&source=github")) as any).source, "github");
});
test("limit 钳制 1-50", () => {
  assert.equal((validateSearchParams(u("q=x&limit=999")) as any).limit, 50);
});
