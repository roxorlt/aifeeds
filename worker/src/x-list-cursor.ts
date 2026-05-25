// X list 抓取游标驱动 - 核心算法纯函数
//
// 设计文档: docs/plans/2026-05-22-x-list-cursor-driven-design.md
//
// 所有函数纯逻辑，不依赖 env / D1 / fetch，便于 ad-hoc 测试。
// 测试: worker/scripts/test-x-list-cursor.ts

/** seen_set 大小上限（设计文档 §3 决策 1）*/
export const SEEN_SET_MAX_SIZE = 10;

/** catch-up 分流默认阈值（设计文档 §3 决策 4）*/
export const CATCHUP_THRESHOLD_DEFAULT = 70;

/** 解析 sources.cursor 文本到 Set。容错：非法 / 空 → 空 Set（冷启动）*/
export function parseSeenSet(cursorRaw: string | null | undefined): Set<string> {
  if (!cursorRaw) return new Set();
  try {
    const parsed = JSON.parse(cursorRaw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === 'string'));
  } catch {
    return new Set();
  }
}

/** 把 topIds 序列化回 cursor 字段；只取前 SEEN_SET_MAX_SIZE 个 */
export function serializeSeenSet(topIds: string[]): string {
  return JSON.stringify(topIds.slice(0, SEEN_SET_MAX_SIZE));
}

/**
 * 找 page 内第一个命中 seen_set 的位置。
 * 返回 -1 = 没命中（这一页全是新的，要全部 upsert + 翻下一页）
 * 返回 >= 0 = 命中位置。pageIds[0..index-1] 是新的；index 及之后丢弃；停翻页。
 */
export function findStopIndex(pageIds: string[], seenSet: Set<string>): number {
  if (seenSet.size === 0) return -1;
  for (let i = 0; i < pageIds.length; i++) {
    if (seenSet.has(pageIds[i])) return i;
  }
  return -1;
}

/** catch-up 分流结果 */
export interface CatchupPartition<T> {
  immediate: T[];
  pending: T[];
}

/**
 * 按阈值把 newItems 分两组。
 * 入参假设按 published_at desc 排（最新在前）。
 * ≤ threshold → 全部 immediate；> threshold → 前 threshold immediate，剩余 pending。
 */
export function partitionForCatchup<T>(
  newItems: T[],
  threshold: number = CATCHUP_THRESHOLD_DEFAULT,
): CatchupPartition<T> {
  if (newItems.length <= threshold) {
    return { immediate: newItems, pending: [] };
  }
  return {
    immediate: newItems.slice(0, threshold),
    pending: newItems.slice(threshold),
  };
}
