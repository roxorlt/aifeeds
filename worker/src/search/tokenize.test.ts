// worker/src/search/tokenize.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { tokenizeForSearch, buildMatchQuery } from "./tokenize";

test("中文切 bigram", () => {
  assert.deepEqual(tokenizeForSearch("大模型"), ["大模", "模型"]);
});
test("单个汉字保留单字", () => {
  assert.deepEqual(tokenizeForSearch("深"), ["深"]);
});
test("中英混排：拉丁整词+连接符拆分+中文 bigram", () => {
  assert.deepEqual(tokenizeForSearch("Claude-Code 智能体"),
    ["claude-code", "claude", "code", "智能", "能体"]);
});
test("全角经 NFKC 归一", () => {
  assert.deepEqual(tokenizeForSearch("ＡＩ"), ["ai"]);
});
test("emoji/纯符号产出空数组", () => {
  assert.deepEqual(tokenizeForSearch("🔥🔥 !!!"), []);
  assert.deepEqual(tokenizeForSearch(""), []);
  assert.deepEqual(tokenizeForSearch(null), []);
});
test("超长拉丁词截断到 32 字符", () => {
  const t = tokenizeForSearch("a".repeat(50));
  assert.equal(t[0].length, 32);
});
test("MATCH：普通多 token 引号包裹 AND", () => {
  assert.equal(buildMatchQuery(["大模", "模型"]), '"大模" "模型"');
});
test("MATCH：末位拉丁≥3 加前缀星", () => {
  assert.equal(buildMatchQuery(["claude"]), '"claude"*');
  assert.equal(buildMatchQuery(["ab"]), '"ab"');
});
test("MATCH：末位中文单字加前缀星", () => {
  assert.equal(buildMatchQuery(["深"]), '"深"*');
});
test("MATCH：注入字符被中和（双引号剔除，语法词只是普通 token）", () => {
  assert.equal(buildMatchQuery(['fo"o', "or", "near"]), '"foo" "or" "near"');
  assert.equal(buildMatchQuery(['"""']), null);
});
test("MATCH：token 上限 12", () => {
  const q = buildMatchQuery(Array.from({ length: 20 }, (_, i) => `t${i}`));
  assert.equal((q!.match(/"/g) || []).length / 2, 12);
});
