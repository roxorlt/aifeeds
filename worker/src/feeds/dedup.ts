// worker/src/feeds/dedup.ts
//
// v1 跨源滤重：只做 L1（canonical-URL 精确 url_hash），L2 推迟 v2（§5.6）。
// dedupL1 只判别不落库；suppress / mark 落库由各自 step 调用。
//
// ⚠️ 三种终态（relevant / irrelevant / dedup-suppressed）都写 extra.workflow_completed_at
//    （与现网 X 一致，x-tweet-pipeline.ts:236）。不复用「不写 gate」做隐藏 ——
//    不写 wc_at 会被 SOP §1.6 兜底 backfill 每 30min 无限重判（§5.5 根因）。
//
// 设计文档：docs/plans/2026-06-09-ai-vendor-feeds-source-design.md §5.5 / §5.6 / §8.2

import type { Env } from "../index";

interface DedupRow {
  is_relevant: number | null;
  url_hash: string | null;
}

/**
 * L1 跨源精确去重判别。
 * - is_relevant != 1 早退（不相关已在 step1 终判，不参与去重）。
 * - incumbent（已展示主源）必须额外满足 dedup_of IS NULL —— 否则会把一个被隐藏次源误当主源。
 * - 命中即返回 winner（次源由 caller 调 suppressDupCompleted 隐藏）。
 */
export async function dedupL1(
  env: Env,
  itemId: string,
): Promise<{ dup: boolean; winner?: string; reason?: "l1_same_url" }> {
  const row = await env.DB.prepare(
    `SELECT is_relevant,
            json_extract(extra, '$.url_hash') AS url_hash
       FROM items WHERE id = ?`,
  )
    .bind(itemId)
    .first<DedupRow>();
  if (!row) throw new Error(`dedupL1: item not found ${itemId}`);
  if (row.is_relevant !== 1) return { dup: false };
  const urlHash = row.url_hash;
  if (!urlHash) return { dup: false };

  const incumbent = await env.DB.prepare(
    `SELECT id FROM items
      WHERE json_extract(extra, '$.url_hash') = ?
        AND id != ?
        AND is_relevant = 1
        AND json_extract(extra, '$.workflow_completed_at') IS NOT NULL
        AND json_extract(extra, '$.dedup_of') IS NULL
      ORDER BY published_at ASC, id ASC
      LIMIT 1`,
  )
    .bind(urlHash, itemId)
    .first<{ id: string }>();

  if (incumbent) {
    return { dup: true, winner: incumbent.id, reason: "l1_same_url" };
  }
  return { dup: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// 三种终态写 workflow_completed_at（json_set 只动自己字段，防 lost-update）
// ─────────────────────────────────────────────────────────────────────────────

/** irrelevant 终态：is_relevant=0 + wc_at（靠 /api/items 默认 relevant=1 过滤隐藏）。 */
export async function markIrrelevantCompleted(
  env: Env,
  itemId: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE items
        SET is_relevant = 0,
            extra = json_set(COALESCE(extra, '{}'), '$.workflow_completed_at', ?)
      WHERE id = ?`,
  )
    .bind(new Date().toISOString(), itemId)
    .run();
}

/** dedup-suppressed 终态：dedup_of + dedup_reason + wc_at（靠 handleItems dedup_of IS NULL 隐藏）。 */
export async function suppressDupCompleted(
  env: Env,
  itemId: string,
  winnerId: string,
  reason: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE items
        SET extra = json_set(COALESCE(extra, '{}'),
                             '$.dedup_of', ?,
                             '$.dedup_reason', ?,
                             '$.workflow_completed_at', ?)
      WHERE id = ?`,
  )
    .bind(winnerId, reason, new Date().toISOString(), itemId)
    .run();
}

/** relevant 终态：enrich + eager 翻译 done 后写 wc_at（正文完整度不是 gate 条件）。 */
export async function markCompleted(env: Env, itemId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE items
        SET extra = json_set(COALESCE(extra, '{}'), '$.workflow_completed_at', ?)
      WHERE id = ?`,
  )
    .bind(new Date().toISOString(), itemId)
    .run();
}
