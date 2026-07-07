// worker/src/search/ranking.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { finalScore, rankHits, groupHits, encodeOffsetCursor, decodeOffsetCursor, RECALL_LIMIT } from "./ranking";

const NOW = Date.parse("2026-07-06T00:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 86400000).toISOString();

test("同相关性下，x_list 7 天衰减快于 github 180 天", () => {
  const fresh = finalScore(-10, daysAgo(0), "x_list", NOW);
  const oldX = finalScore(-10, daysAgo(30), "x_list", NOW);
  const oldGh = finalScore(-10, daysAgo(30), "github", NOW);
  assert.ok(fresh > oldX);
  assert.ok(oldGh > oldX); // 30 天前的 GH 仓库分数远高于 30 天前的推文
});
test("published_at 缺失按 365 天衰减兜底", () => {
  assert.ok(finalScore(-10, null, "github", NOW) < finalScore(-10, daysAgo(0), "github", NOW));
});
test("rankHits 降序、groupHits 组序按组内最高分且每组最多 3 条", () => {
  const hits = [
    { source_type: "github", published_at: daysAgo(1), b: -8 },
    { source_type: "x_list", published_at: daysAgo(0), b: -20 },
    { source_type: "x_list", published_at: daysAgo(0), b: -5 },
    { source_type: "x_list", published_at: daysAgo(0), b: -6 },
    { source_type: "x_list", published_at: daysAgo(0), b: -7 },
  ];
  const groups = groupHits(rankHits(hits, NOW));
  assert.equal(groups[0].source_type, "x_list"); // 最高分 -20 在 x_list 组
  assert.equal(groups[0].total, 4);
  assert.equal(groups[0].top.length, 3);
  assert.equal(groups[1].source_type, "github");
});
test("offset cursor 编解码，非法输入回 0", () => {
  assert.equal(decodeOffsetCursor(encodeOffsetCursor(40)), 40);
  assert.equal(decodeOffsetCursor(null), 0);
  assert.equal(decodeOffsetCursor("garbage!!"), 0);
  assert.equal(decodeOffsetCursor(encodeOffsetCursor(-5)), 0);
});
test("groupHits 组序按真实组内最高分，不依赖输入预排序", () => {
  // 乱序输入（非 rankHits 输出顺序）：x_list 组的最高分成员出现在 github 之后
  const ranked = [
    { source_type: "github", published_at: daysAgo(1), b: -8, score: 5 },
    { source_type: "x_list", published_at: daysAgo(0), b: -5, score: 3 },
    { source_type: "x_list", published_at: daysAgo(0), b: -20, score: 10 },
  ];
  const groups = groupHits(ranked);
  assert.equal(groups[0].source_type, "x_list"); // 真实组内最高分 10 > github 的 5
  assert.equal(groups[1].source_type, "github");
});
test("超大 offset 解码后钳制到 RECALL_LIMIT", () => {
  assert.equal(decodeOffsetCursor(btoa(`o:${"9".repeat(32)}`)), RECALL_LIMIT);
});
