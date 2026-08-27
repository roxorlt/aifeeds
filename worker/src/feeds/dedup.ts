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

const WORKFLOW_RECOVERY_MAX_ATTEMPTS = 6;
const WORKFLOW_RECOVERY_MIN_AGE_MS = 30 * 60_000;
const WORKFLOW_RECOVERY_STATE_PATHS = `
  '$.workflow_error',
  '$.workflow_recovery_attempts',
  '$.workflow_recovery_bucket',
  '$.workflow_retry_exhausted_at',
  '$.workflow_retry_exhausted_alert_day'
`;

export interface FeedWorkflowRecoveryResult {
  found: number;
  triggered: number;
  failed: number;
  exhausted: number;
  exhausted_alerts: number;
  /** 最老待恢复条目的年龄（秒）；没有符合门槛的条目时为 null。 */
  oldest_age: number | null;
}

type WorkflowTriggerResult = 'triggered' | 'already_exists' | 'failed' | 'binding_missing';

export interface FeedWorkflowRecoveryOptions {
  sourceType: 'blog' | 'podcast';
  now?: Date;
  trigger: (itemId: string, extra: Record<string, unknown>) => Promise<WorkflowTriggerResult>;
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

/** 工作流无法创建时保留待恢复状态，并将失败原因作为结构化 extra 元数据写入。 */
export async function markWorkflowPending(
  env: { DB: D1Database },
  itemId: string,
  code: 'WORKFLOW_BINDING_MISSING' | 'WORKFLOW_CREATE_FAILED',
): Promise<void> {
  const error = JSON.stringify({ code, at: new Date().toISOString() });
  try {
    await env.DB.prepare(
      `UPDATE items
          SET pending_workflow=1,
              extra=json_set(COALESCE(extra, '{}'), '$.workflow_error', json(?))
        WHERE id=?`,
    ).bind(error, itemId).run();
  } catch (error) {
    console.error(`[feed-workflow] failed to mark pending ${itemId}:`, error);
  }
}

/** workflow 已创建、已存在或终态完成后，统一清理可重试状态和临时错误。 */
export async function clearWorkflowRecoveryState(
  env: { DB: D1Database },
  itemId: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE items
        SET pending_workflow=0,
            extra=json_remove(COALESCE(extra, '{}'), ${WORKFLOW_RECOVERY_STATE_PATHS})
      WHERE id=?`,
  ).bind(itemId).run();
}

/** irrelevant 终态：is_relevant=0 + wc_at（靠 /api/items 默认 relevant=1 过滤隐藏）。 */
export async function markIrrelevantCompleted(
  env: Env,
  itemId: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE items
        SET is_relevant = 0,
            pending_workflow = 0,
            extra = json_set(
              json_remove(COALESCE(extra, '{}'), ${WORKFLOW_RECOVERY_STATE_PATHS}),
              '$.workflow_completed_at', ?)
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
        SET pending_workflow = 0,
            extra = json_set(json_remove(COALESCE(extra, '{}'), ${WORKFLOW_RECOVERY_STATE_PATHS}),
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
        SET pending_workflow = 0,
            extra = json_set(
              json_remove(COALESCE(extra, '{}'), ${WORKFLOW_RECOVERY_STATE_PATHS}),
              '$.workflow_completed_at', ?)
      WHERE id = ?`,
  )
    .bind(new Date().toISOString(), itemId)
    .run();
}

/**
 * 对一个 feed source 的未完成条目做有界恢复。
 *
 * 行为不依赖 cron 频率：item extra 里的小时 bucket 防止同一小时重复创建实例，
 * attempts 达 6 后仅保留一次每日可观测告警信号，不再触发 workflow。
 */
export async function runFeedWorkflowRecovery(
  env: { DB: D1Database },
  options: FeedWorkflowRecoveryOptions,
): Promise<FeedWorkflowRecoveryResult> {
  const now = options.now || new Date();
  const nowMs = now.getTime();
  const threshold = new Date(nowMs - WORKFLOW_RECOVERY_MIN_AGE_MS).toISOString();
  const hourBucket = now.toISOString().slice(0, 13).replace('T', '-');
  const alertDay = now.toISOString().slice(0, 10);
  const rows = await env.DB.prepare(
    `SELECT id, extra, scraped_at FROM items
      WHERE source_type=?
        AND deleted_at IS NULL
        AND json_extract(extra, '$.workflow_completed_at') IS NULL
        AND datetime(scraped_at) <= datetime(?)
      ORDER BY scraped_at ASC
      LIMIT 50`,
  ).bind(options.sourceType, threshold).all<{ id: string; extra: string | null; scraped_at: string | null }>();

  const result: FeedWorkflowRecoveryResult = {
    found: 0,
    triggered: 0,
    failed: 0,
    exhausted: 0,
    exhausted_alerts: 0,
    oldest_age: null,
  };

  for (const row of rows.results || []) {
    const scrapedAtMs = Date.parse(row.scraped_at || '');
    if (!Number.isFinite(scrapedAtMs) || scrapedAtMs > nowMs - WORKFLOW_RECOVERY_MIN_AGE_MS) continue;
    result.found++;
    const age = Math.floor((nowMs - scrapedAtMs) / 1000);
    result.oldest_age = result.oldest_age === null ? age : Math.max(result.oldest_age, age);

    const extra = parseWorkflowExtra(row.extra);
    const attempts = nonNegativeInteger(extra.workflow_recovery_attempts);
    if (attempts >= WORKFLOW_RECOVERY_MAX_ATTEMPTS) {
      result.exhausted++;
      if (extra.workflow_retry_exhausted_alert_day !== alertDay) {
        await markWorkflowRecoveryExhausted(env, row.id, attempts, alertDay);
        result.exhausted_alerts++;
      }
      continue;
    }
    if (extra.workflow_recovery_bucket === hourBucket) continue;

    await markWorkflowRecoveryAttempt(env, row.id, attempts + 1, hourBucket);
    const triggered = await options.trigger(row.id, extra);
    if (triggered === 'triggered' || triggered === 'already_exists') result.triggered++;
    else result.failed++;
  }

  return result;
}

function parseWorkflowExtra(value: string | null): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function nonNegativeInteger(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

async function markWorkflowRecoveryAttempt(
  env: { DB: D1Database },
  itemId: string,
  attempts: number,
  bucket: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE items
        SET pending_workflow=1,
            extra=json_set(COALESCE(extra, '{}'),
                           '$.workflow_recovery_attempts', ?,
                           '$.workflow_recovery_bucket', ?)
      WHERE id=?`,
  ).bind(attempts, bucket, itemId).run();
}

async function markWorkflowRecoveryExhausted(
  env: { DB: D1Database },
  itemId: string,
  attempts: number,
  alertDay: string,
): Promise<void> {
  const error = JSON.stringify({
    code: 'WORKFLOW_RETRY_EXHAUSTED',
    attempts,
    at: new Date().toISOString(),
  });
  await env.DB.prepare(
    `UPDATE items
        SET pending_workflow=1,
            extra=json_set(COALESCE(extra, '{}'),
                           '$.workflow_error', json(?),
                           '$.workflow_retry_exhausted_at', ?,
                           '$.workflow_retry_exhausted_alert_day', ?)
      WHERE id=?`,
  ).bind(error, new Date().toISOString(), alertDay, itemId).run();
}
