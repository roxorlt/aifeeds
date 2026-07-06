// worker/src/search/terms.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { collectEntityTerms } from "./terms";

test("github 仓库名拆 owner 与 repo 各一条 + 全名一条", () => {
  const m = collectEntityTerms([{ source_type: "github", title: "anthropics/claude-code",
    author: "anthropics", handle: null, metrics: JSON.stringify({ stars: 1000 }),
    extra: JSON.stringify({ ai_category: "agent" }) }]);
  assert.ok(m.has("anthropics/claude-code"));
  assert.ok(m.has("claude-code"));
  assert.ok(m.has("agent")); // ai_category 也成词
});
test("作者出现 3 次以上才成词", () => {
  const row = { source_type: "x_list", title: null, author: "Karpathy", handle: "karpathy", metrics: null, extra: null };
  assert.ok(!collectEntityTerms([row]).has("karpathy"));
  assert.ok(collectEntityTerms([row, row, row]).has("karpathy"));
});
test("词长过滤：<2 或 >40 字符不成词", () => {
  const m = collectEntityTerms([{ source_type: "clawhub", title: "a", author: null, handle: null, metrics: null,
    extra: JSON.stringify({}) }]);
  assert.equal(m.size, 0);
});
