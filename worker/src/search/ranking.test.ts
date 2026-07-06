// worker/src/search/ranking.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { finalScore, rankHits, groupHits, encodeOffsetCursor, decodeOffsetCursor } from "./ranking";

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
