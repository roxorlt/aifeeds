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
import { FEED_REGISTRY } from './registry';

interface DedupRow {
  is_relevant: number | null;
  url_hash: string | null;
}

const WORKFLOW_RECOVERY_MAX_ATTEMPTS = 6;
const WORKFLOW_RECOVERY_MIN_AGE_MS = 30 * 60_000;
const WORKFLOW_RECOVERY_BATCH_SIZE = 50;
const WORKFLOW_EXHAUSTED_ALERT_CLAIM_LEASE_MS = 15 * 60_000;
const WORKFLOW_RECOVERY_STATE_PATHS = `
  '$.workflow_error',
  '$.workflow_recovery_attempts',
  '$.workflow_recovery_bucket',
  '$.workflow_retry_exhausted_at',
  '$.workflow_retry_exhausted_alert_day',
  '$.workflow_retry_exhausted_alert_pending_day',
  '$.workflow_retry_exhausted_alert_claim_token',
  '$.workflow_retry_exhausted_alert_claimed_at',
  '$.workflow_recovery_transition_token',
  '$.workflow_recovery_transition_canonical_id',
  '$.workflow_recovery_transition_version',
  '$.workflow_recovery_transition_canonical_row_id'
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
  onExhausted?: (signal: {
    sourceType: 'blog' | 'podcast';
    itemIds: string[];
    attempts: number;
    alertPeriod: string;
  }) => Promise<boolean>;
}

function workflowRecoveryRegistryJson(): string {
  return JSON.stringify(FEED_REGISTRY
    .filter((feed) => (feed.kind === 'blog' || feed.kind === 'podcast') && feed.enabled !== false)
    .map((feed) => ({
      id: feed.id,
      key: feed.key,
      kind: feed.kind,
      config: JSON.stringify(feed),
    }))
    .sort((left, right) => left.id.localeCompare(right.id)));
}

const WORKFLOW_RECOVERY_REGISTRY_CTE = `registry AS (
  SELECT json_extract(value,'$.id') id,json_extract(value,'$.key') feed_key,
         json_extract(value,'$.kind') kind,json_extract(value,'$.config') config
    FROM json_each(?)
)`;

/**
 * Current registry/source/item identity shared by every recovery read and claim.
 * Normal producer rows have a NULL source_ref. Podcast text posts are the single
 * evidence-backed cross-kind shape: source_type=blog with a podcast:<key>: id and feed_key.
 */
function workflowRecoveryManagedIdentitySql(
  itemAlias: string,
  safeExtra: string,
): string {
  return `${itemAlias}.source_ref IS NULL
    AND EXISTS (
      SELECT 1 FROM registry r JOIN sources s
        ON s.id=r.id AND s.source_type=r.kind AND s.source_ref=r.feed_key AND s.config=r.config
       WHERE r.id=json_extract(${safeExtra},'$.feed_id')
         AND (
           (${itemAlias}.source_type='blog' AND r.kind='blog'
             AND json_extract(${safeExtra},'$.feed_key')=r.feed_key)
           OR (${itemAlias}.source_type='podcast' AND r.kind='podcast'
             AND json_extract(${safeExtra},'$.show_key')=r.feed_key)
           OR (${itemAlias}.source_type='blog' AND r.kind='podcast'
             AND json_extract(${safeExtra},'$.feed_key')=r.feed_key
             AND json_extract(${safeExtra},'$.show_key') IS NULL
             AND ${itemAlias}.id GLOB ('podcast:' || r.feed_key || ':*'))
         )
    )`;
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
        WHERE id=?
          AND json_extract(
            CASE WHEN json_valid(COALESCE(extra, '{}')) THEN COALESCE(extra, '{}') ELSE '{}' END,
            '$.workflow_completed_at') IS NULL`,
    ).bind(error, itemId).run();
  } catch (error) {
    console.error(`[feed-workflow] failed to mark pending ${itemId}:`, error);
  }
}

/** workflow 已创建或已存在：清 pending/临时 create 错误，但保留恢复次数与小时 bucket。 */
export async function markWorkflowTriggered(
  env: { DB: D1Database },
  itemId: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE items
        SET pending_workflow=0,
            extra=json_remove(COALESCE(extra, '{}'), '$.workflow_error')
      WHERE id=?`,
  ).bind(itemId).run();
}

/** 仅供 workflow 真终态使用：统一清理全部可重试状态和临时错误。 */
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
  const alertClaimStaleBefore = new Date(nowMs - WORKFLOW_EXHAUSTED_ALERT_CLAIM_LEASE_MS).toISOString();
  const validExtra = `CASE WHEN json_valid(COALESCE(i.extra, '{}')) THEN COALESCE(i.extra, '{}') ELSE '{}' END`;
  const attempts = `COALESCE(CAST(json_extract(${validExtra}, '$.workflow_recovery_attempts') AS INTEGER), 0)`;
  const bucket = `COALESCE(json_extract(${validExtra}, '$.workflow_recovery_bucket'), '')`;
  const alertPeriod = `COALESCE(json_extract(${validExtra}, '$.workflow_retry_exhausted_alert_day'), '')`;
  const registryJson = workflowRecoveryRegistryJson();
  const managedIncomplete = `
        i.source_type=?
        AND ${workflowRecoveryManagedIdentitySql('i', validExtra)}
        AND i.deleted_at IS NULL
        AND json_extract(${validExtra}, '$.workflow_completed_at') IS NULL
        AND datetime(i.scraped_at) <= datetime(?)`;

  const stats = await env.DB.prepare(
    `WITH ${WORKFLOW_RECOVERY_REGISTRY_CTE}
     SELECT COUNT(*) AS found,
            COALESCE(SUM(CASE WHEN ${attempts} >= ? THEN 1 ELSE 0 END), 0) AS exhausted,
            MIN(i.scraped_at) AS oldest_scraped_at
       FROM items i
      WHERE ${managedIncomplete}`,
  ).bind(registryJson, WORKFLOW_RECOVERY_MAX_ATTEMPTS, options.sourceType, threshold)
    .first<{ found: number; exhausted: number; oldest_scraped_at: string | null }>();
  const oldestMs = Date.parse(stats?.oldest_scraped_at || '');
  const result: FeedWorkflowRecoveryResult = {
    found: Number(stats?.found || 0),
    triggered: 0,
    failed: 0,
    exhausted: Number(stats?.exhausted || 0),
    exhausted_alerts: 0,
    oldest_age: Number.isFinite(oldestMs) ? Math.max(0, Math.floor((nowMs - oldestMs) / 1000)) : null,
  };

  // Exhausted rows are observed separately so they can never occupy the eligible LIMIT page.
  const exhaustedRows = options.onExhausted ? await env.DB.prepare(
    `WITH ${WORKFLOW_RECOVERY_REGISTRY_CTE}
     SELECT i.id, i.extra, i.scraped_at FROM items i
      WHERE ${managedIncomplete}
        AND ${attempts} >= ?
        AND ${alertPeriod} <> ?
      ORDER BY i.scraped_at ASC, i.id ASC
      LIMIT ?`,
  ).bind(
    registryJson,
    options.sourceType,
    threshold,
    WORKFLOW_RECOVERY_MAX_ATTEMPTS,
    alertDay,
    WORKFLOW_RECOVERY_BATCH_SIZE,
  ).all<{ id: string; extra: string | null; scraped_at: string | null }>() : { results: [] };
  const alertClaims: Array<{ itemId: string; token: string }> = [];
  for (const row of exhaustedRows.results || []) {
    const extra = parseWorkflowExtra(row.extra);
    const token = `${now.toISOString()}:${crypto.randomUUID()}`;
    const claimed = await claimWorkflowRecoveryExhaustedAlert(
      env,
      row.id,
      nonNegativeInteger(extra.workflow_recovery_attempts),
      alertDay,
      now.toISOString(),
      alertClaimStaleBefore,
      token,
      options.sourceType,
      registryJson,
    );
    if (!claimed) continue;
    alertClaims.push({ itemId: row.id, token });
  }

  // attempts is the persisted fair-queue priority. With a 50-row hourly budget, rows that
  // have received fewer attempts always advance before older rows receive another one.
  // Therefore a stable queue of N items receives its first attempt within ceil(N / 50)
  // hourly invocations, while the hour bucket still prevents duplicate same-hour attempts.
  const eligibleRows = await env.DB.prepare(
    `WITH ${WORKFLOW_RECOVERY_REGISTRY_CTE}
     SELECT i.id, i.extra, i.scraped_at FROM items i
      WHERE ${managedIncomplete}
        AND ${attempts} < ?
        AND ${bucket} <> ?
      ORDER BY ${attempts} ASC, i.scraped_at ASC, i.id ASC
      LIMIT ?`,
  ).bind(
    registryJson,
    options.sourceType,
    threshold,
    WORKFLOW_RECOVERY_MAX_ATTEMPTS,
    hourBucket,
    WORKFLOW_RECOVERY_BATCH_SIZE,
  ).all<{ id: string; extra: string | null; scraped_at: string | null }>();

  for (const row of eligibleRows.results || []) {
    const extra = parseWorkflowExtra(row.extra);
    const priorAttempts = nonNegativeInteger(extra.workflow_recovery_attempts);
    const claimed = priorAttempts + 1 === WORKFLOW_RECOVERY_MAX_ATTEMPTS
      ? (await claimWorkflowRecoveryAttemptWithCanonicalIdentity(env, {
        sourceType: options.sourceType,
        itemId: row.id,
        priorAttempts,
        nextAttempts: priorAttempts + 1,
        hourBucket,
        nowMs,
      })).claimed
      : await markWorkflowRecoveryAttempt(
        env,
        row.id,
        priorAttempts,
        priorAttempts + 1,
        hourBucket,
        options.sourceType,
        registryJson,
      );
    if (!claimed) continue;
    const triggered = await options.trigger(row.id, extra);
    if (triggered === 'triggered' || triggered === 'already_exists') result.triggered++;
    else result.failed++;
  }

  if (alertClaims.length > 0) {
    let delivered = false;
    if (options.onExhausted) {
      try {
        delivered = await options.onExhausted({
          sourceType: options.sourceType,
          itemIds: alertClaims.map((claim) => claim.itemId),
          attempts: WORKFLOW_RECOVERY_MAX_ATTEMPTS,
          alertPeriod: alertDay,
        });
      } catch (error) {
        console.error(`[feed-workflow] exhausted alert enqueue failed for ${options.sourceType}:`, error);
      }
    }
    for (const claim of alertClaims) {
      if (delivered) {
        if (await markWorkflowRecoveryExhaustedAlertDelivered(
          env, claim.itemId, claim.token, alertDay,
        )) result.exhausted_alerts++;
      } else {
        await releaseWorkflowRecoveryExhaustedAlertClaim(env, claim.itemId, claim.token);
      }
    }
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
  priorAttempts: number,
  attempts: number,
  bucket: string,
  sourceType: 'blog' | 'podcast',
  registryJson: string,
): Promise<boolean> {
  const safe = `CASE WHEN i.extra IS NOT NULL AND json_valid(i.extra)=1 THEN i.extra ELSE '{}' END`;
  const write = await env.DB.prepare(
    `WITH ${WORKFLOW_RECOVERY_REGISTRY_CTE}
     UPDATE items AS i
        SET pending_workflow=1,
            extra=json_set(${safe},
                           '$.workflow_recovery_attempts', ?,
                           '$.workflow_recovery_bucket', ?)
      WHERE i.id=? AND i.source_type=? AND i.deleted_at IS NULL
        AND ${workflowRecoveryManagedIdentitySql('i', safe)}
        AND COALESCE(CAST(json_extract(${safe},'$.workflow_recovery_attempts') AS INTEGER),0)=?
        AND COALESCE(json_extract(${safe},'$.workflow_recovery_bucket'),'')<>?
        AND json_extract(${safe},'$.workflow_completed_at') IS NULL`,
  ).bind(registryJson, attempts, bucket, itemId, sourceType, priorAttempts, bucket).run();
  return Number(write.meta?.changes || 0) === 1;
}

export interface CanonicalRecoveryAttemptInput {
  sourceType: 'blog' | 'podcast';
  itemId: string;
  priorAttempts: number;
  nextAttempts: number;
  hourBucket: string;
  nowMs: number;
  transitionToken?: string;
}

export interface CanonicalRecoveryAttemptResult {
  claimed: boolean;
  mapping_complete: boolean;
  canonical_subject_id: string;
  canonical_row_id: string;
  error_code: 'CANONICAL_MAPPING_INCOMPLETE' | null;
}

const canonicalEncoder = new TextEncoder();

async function canonicalSubjectRowId(
  sourceType: 'blog' | 'podcast',
  canonicalSubjectId: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    canonicalEncoder.encode(`warning-subject\0${sourceType}\0v1\0${canonicalSubjectId}`),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

const CANONICAL_REGISTRY_CTE = WORKFLOW_RECOVERY_REGISTRY_CTE;

const CANONICAL_CAUSE_SAFE_EXTRA = `CASE WHEN i.extra IS NOT NULL AND json_valid(i.extra)=1
  THEN i.extra ELSE '{}' END`;

const CANONICAL_CAUSE_GUARD = `i.id=? AND i.source_type=? AND i.deleted_at IS NULL
  AND ${workflowRecoveryManagedIdentitySql('i', CANONICAL_CAUSE_SAFE_EXTRA)}
  AND json_extract(${CANONICAL_CAUSE_SAFE_EXTRA},'$.workflow_completed_at') IS NULL
  AND COALESCE(CAST(json_extract(${CANONICAL_CAUSE_SAFE_EXTRA},'$.workflow_recovery_attempts') AS INTEGER),0)=?
  AND COALESCE(CAST(json_extract(${CANONICAL_CAUSE_SAFE_EXTRA},'$.workflow_recovery_bucket') AS TEXT),'')=?
  AND json_extract(${CANONICAL_CAUSE_SAFE_EXTRA},'$.workflow_recovery_transition_token')=?
  AND json_extract(${CANONICAL_CAUSE_SAFE_EXTRA},'$.workflow_recovery_transition_canonical_id')=?
  AND json_extract(${CANONICAL_CAUSE_SAFE_EXTRA},'$.workflow_recovery_transition_version')=1
  AND json_extract(${CANONICAL_CAUSE_SAFE_EXTRA},'$.workflow_recovery_transition_canonical_row_id')=?`;

async function readCanonicalAttemptOutcome(
  env: { DB: D1Database },
  input: CanonicalRecoveryAttemptInput,
  canonicalSubjectId: string,
  canonicalRowId: string,
  transitionToken: string,
): Promise<{ transitioned: boolean; complete: boolean }> {
  const safe = `CASE WHEN i.extra IS NOT NULL AND json_valid(i.extra)=1 THEN i.extra ELSE '{}' END`;
  const row = await env.DB.prepare(
    `SELECT
       CASE WHEN COALESCE(CAST(json_extract(${safe},'$.workflow_recovery_attempts') AS INTEGER),0)=?
              AND COALESCE(CAST(json_extract(${safe},'$.workflow_recovery_bucket') AS TEXT),'')=?
            THEN 1 ELSE 0 END transitioned,
       CASE WHEN json_extract(${safe},'$.workflow_recovery_transition_token') IS NULL
              AND EXISTS (
                SELECT 1 FROM warning_canonical_subjects c
                JOIN warning_subject_aliases a
                  ON a.source_type=c.source_type AND a.canonical_version=c.canonical_version
                 AND a.canonical_subject_id=c.canonical_subject_id AND a.canonical_row_id=c.canonical_row_id
                 AND a.state='mapped'
                WHERE c.source_type=? AND c.canonical_version=1 AND c.canonical_subject_id=?
                  AND c.canonical_row_id=? AND c.state='mapped'
                  AND a.raw_subject_id=? AND a.canonical_subject_id=? AND a.canonical_row_id=?
              ) THEN 1 ELSE 0 END complete,
       json_extract(${safe},'$.workflow_recovery_transition_token') token
     FROM items i WHERE i.id=?`,
  ).bind(
    input.nextAttempts,
    input.hourBucket,
    input.sourceType,
    canonicalSubjectId,
    canonicalRowId,
    input.itemId,
    canonicalSubjectId,
    canonicalRowId,
    input.itemId,
  ).first<{ transitioned: number; complete: number; token: string | null }>();
  return {
    transitioned: row?.transitioned === 1
      && (row.complete === 1 || row.token === transitionToken || row.token === null),
    complete: row?.complete === 1,
  };
}

/**
 * Atomically binds the sixth recovery attempt to the exact NFC canonical
 * subject and raw alias. Every statement re-checks the durable cause token;
 * a zero-change attempts CAS therefore cannot authorize identity rows.
 */
export async function claimWorkflowRecoveryAttemptWithCanonicalIdentity(
  env: { DB: D1Database },
  input: CanonicalRecoveryAttemptInput,
): Promise<CanonicalRecoveryAttemptResult> {
  if (input.nextAttempts !== input.priorAttempts + 1
    || input.nextAttempts !== WORKFLOW_RECOVERY_MAX_ATTEMPTS) {
    throw new Error('CANONICAL_ATTEMPT_TRANSITION_INVALID');
  }
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) throw new Error('CANONICAL_TIME_INVALID');
  const canonicalSubjectId = input.itemId.normalize('NFC');
  const canonicalRowId = await canonicalSubjectRowId(input.sourceType, canonicalSubjectId);
  const transitionToken = input.transitionToken || crypto.randomUUID().replaceAll('-', '');
  if (!/^[0-9a-f]{32}$/i.test(transitionToken)) throw new Error('CANONICAL_TRANSITION_TOKEN_INVALID');
  const registryJson = workflowRecoveryRegistryJson();
  const causeBinds = [
    input.itemId,
    input.sourceType,
    input.nextAttempts,
    input.hourBucket,
    transitionToken,
    canonicalSubjectId,
    canonicalRowId,
  ];
  const safe = `CASE WHEN i.extra IS NOT NULL AND json_valid(i.extra)=1 THEN i.extra ELSE '{}' END`;
  const a1 = env.DB.prepare(
    `WITH ${CANONICAL_REGISTRY_CTE}
     UPDATE items AS i SET pending_workflow=1,extra=json_set(${safe},
       '$.workflow_recovery_attempts',?,'$.workflow_recovery_bucket',?,
       '$.workflow_recovery_transition_token',?,
       '$.workflow_recovery_transition_canonical_id',?,
       '$.workflow_recovery_transition_version',1,
       '$.workflow_recovery_transition_canonical_row_id',?)
     WHERE i.id=? AND i.source_type=? AND i.deleted_at IS NULL
       AND ${workflowRecoveryManagedIdentitySql('i', safe)}
       AND json_extract(${safe},'$.workflow_completed_at') IS NULL
       AND COALESCE(CAST(json_extract(${safe},'$.workflow_recovery_attempts') AS INTEGER),0)=?
       AND COALESCE(CAST(json_extract(${safe},'$.workflow_recovery_bucket') AS TEXT),'')<>?`,
  ).bind(
    registryJson,
    input.nextAttempts,
    input.hourBucket,
    transitionToken,
    canonicalSubjectId,
    canonicalRowId,
    input.itemId,
    input.sourceType,
    input.priorAttempts,
    input.hourBucket,
  );
  const a2 = env.DB.prepare(
    `WITH ${CANONICAL_REGISTRY_CTE}
     INSERT INTO warning_canonical_subjects(
       source_type,canonical_subject_id,canonical_version,canonical_row_id,first_item_rowid,
       sort_attempts,sort_scraped_at,sort_raw_subject_id,state,created_at_ms,updated_at_ms)
     SELECT ?,?,1,?,i.rowid,?,i.scraped_at,i.id,'mapped',?,? FROM items i
      WHERE ${CANONICAL_CAUSE_GUARD}
     ON CONFLICT(source_type,canonical_subject_id) DO UPDATE SET
       first_item_rowid=MIN(first_item_rowid,excluded.first_item_rowid),
       sort_attempts=MIN(sort_attempts,excluded.sort_attempts),
       sort_scraped_at=MIN(sort_scraped_at,excluded.sort_scraped_at),
       sort_raw_subject_id=MIN(sort_raw_subject_id,excluded.sort_raw_subject_id),
       updated_at_ms=excluded.updated_at_ms
     WHERE warning_canonical_subjects.canonical_version=excluded.canonical_version
       AND warning_canonical_subjects.canonical_row_id=excluded.canonical_row_id
       AND warning_canonical_subjects.state='mapped'`,
  ).bind(
    registryJson,
    input.sourceType,
    canonicalSubjectId,
    canonicalRowId,
    input.nextAttempts,
    input.nowMs,
    input.nowMs,
    ...causeBinds,
  );
  const a3 = env.DB.prepare(
    `WITH ${CANONICAL_REGISTRY_CTE}
     INSERT INTO warning_subject_aliases(
       source_type,raw_subject_id,canonical_subject_id,canonical_version,canonical_row_id,
       item_rowid,state,last_error_code,mapped_at_ms,updated_at_ms)
     SELECT ?,i.id,?,1,c.canonical_row_id,i.rowid,'mapped',NULL,?,?
       FROM items i JOIN warning_canonical_subjects c
         ON c.source_type=? AND c.canonical_version=1 AND c.canonical_subject_id=?
        AND c.canonical_row_id=? AND c.state='mapped'
      WHERE ${CANONICAL_CAUSE_GUARD}
     ON CONFLICT(source_type,raw_subject_id) DO NOTHING`,
  ).bind(
    registryJson,
    input.sourceType,
    canonicalSubjectId,
    input.nowMs,
    input.nowMs,
    input.sourceType,
    canonicalSubjectId,
    canonicalRowId,
    ...causeBinds,
  );
  const a4 = env.DB.prepare(
    `WITH ${CANONICAL_REGISTRY_CTE}
     UPDATE items AS i SET extra=json_remove(${CANONICAL_CAUSE_SAFE_EXTRA},
       '$.workflow_recovery_transition_token','$.workflow_recovery_transition_canonical_id',
       '$.workflow_recovery_transition_version','$.workflow_recovery_transition_canonical_row_id')
      WHERE ${CANONICAL_CAUSE_GUARD}
        AND EXISTS (
          SELECT 1 FROM warning_canonical_subjects c JOIN warning_subject_aliases a
            ON a.source_type=c.source_type AND a.canonical_version=c.canonical_version
           AND a.canonical_subject_id=c.canonical_subject_id AND a.canonical_row_id=c.canonical_row_id
           AND a.state='mapped'
           WHERE c.source_type=? AND c.canonical_version=1 AND c.canonical_subject_id=?
             AND c.canonical_row_id=? AND c.state='mapped' AND a.raw_subject_id=?)`,
  ).bind(
    registryJson,
    ...causeBinds,
    input.sourceType,
    canonicalSubjectId,
    canonicalRowId,
    input.itemId,
  );
  let results: D1Result<unknown>[];
  try {
    results = await env.DB.batch([a1, a2, a3, a4]) as D1Result<unknown>[];
  } catch (error) {
    const outcome = await readCanonicalAttemptOutcome(
      env,
      input,
      canonicalSubjectId,
      canonicalRowId,
      transitionToken,
    );
    if (!outcome.transitioned) throw error;
    return {
      claimed: true,
      mapping_complete: outcome.complete,
      canonical_subject_id: canonicalSubjectId,
      canonical_row_id: canonicalRowId,
      error_code: outcome.complete ? null : 'CANONICAL_MAPPING_INCOMPLETE',
    };
  }
  const claimed = Number(results[0]?.meta?.changes || 0) === 1;
  const outcome = await readCanonicalAttemptOutcome(
    env,
    input,
    canonicalSubjectId,
    canonicalRowId,
    transitionToken,
  );
  return {
    claimed: claimed || outcome.transitioned,
    mapping_complete: outcome.complete,
    canonical_subject_id: canonicalSubjectId,
    canonical_row_id: canonicalRowId,
    error_code: outcome.complete || !claimed ? null : 'CANONICAL_MAPPING_INCOMPLETE',
  };
}

async function claimWorkflowRecoveryExhaustedAlert(
  env: { DB: D1Database },
  itemId: string,
  attempts: number,
  alertDay: string,
  nowIso: string,
  staleBefore: string,
  token: string,
  sourceType: 'blog' | 'podcast',
  registryJson: string,
): Promise<boolean> {
  const error = JSON.stringify({
    code: 'WORKFLOW_RETRY_EXHAUSTED',
    attempts,
    at: nowIso,
  });
  const safe = `CASE WHEN i.extra IS NOT NULL AND json_valid(i.extra)=1 THEN i.extra ELSE '{}' END`;
  const write = await env.DB.prepare(
    `WITH ${WORKFLOW_RECOVERY_REGISTRY_CTE}
     UPDATE items AS i
        SET pending_workflow=1,
            extra=json_set(${safe},
                           '$.workflow_error', json(?),
                           '$.workflow_retry_exhausted_at', ?,
                           '$.workflow_retry_exhausted_alert_pending_day', ?,
                           '$.workflow_retry_exhausted_alert_claim_token', ?,
                           '$.workflow_retry_exhausted_alert_claimed_at', ?)
      WHERE i.id=? AND i.source_type=? AND i.deleted_at IS NULL
        AND ${workflowRecoveryManagedIdentitySql('i', safe)}
        AND COALESCE(json_extract(${safe},'$.workflow_retry_exhausted_alert_day'),'')<>?
        AND (
          COALESCE(json_extract(${safe},'$.workflow_retry_exhausted_alert_pending_day'),'')<>?
          OR datetime(COALESCE(json_extract(${safe},'$.workflow_retry_exhausted_alert_claimed_at'),
                               '1970-01-01T00:00:00.000Z'))
             <= datetime(?)
        )
        AND COALESCE(CAST(json_extract(${safe},'$.workflow_recovery_attempts') AS INTEGER),0)>=?
        AND json_extract(${safe},'$.workflow_completed_at') IS NULL`,
  ).bind(
    registryJson,
    error, nowIso, alertDay, token, nowIso,
    itemId, sourceType, alertDay, alertDay, staleBefore, WORKFLOW_RECOVERY_MAX_ATTEMPTS,
  ).run();
  return Number(write.meta?.changes || 0) === 1;
}

async function markWorkflowRecoveryExhaustedAlertDelivered(
  env: { DB: D1Database },
  itemId: string,
  token: string,
  alertDay: string,
): Promise<boolean> {
  const write = await env.DB.prepare(
    `UPDATE items
        SET extra=json_set(
          json_remove(CASE WHEN json_valid(COALESCE(extra, '{}')) THEN COALESCE(extra, '{}') ELSE '{}' END,
            '$.workflow_retry_exhausted_alert_pending_day',
            '$.workflow_retry_exhausted_alert_claim_token',
            '$.workflow_retry_exhausted_alert_claimed_at'),
          '$.workflow_retry_exhausted_alert_day', ?)
      WHERE id=?
        AND COALESCE(json_extract(CASE WHEN json_valid(COALESCE(extra, '{}')) THEN COALESCE(extra, '{}') ELSE '{}' END,
                                  '$.workflow_retry_exhausted_alert_claim_token'), '')=?`,
  ).bind(alertDay, itemId, token).run();
  return Number(write.meta?.changes || 0) === 1;
}

async function releaseWorkflowRecoveryExhaustedAlertClaim(
  env: { DB: D1Database },
  itemId: string,
  token: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE items
        SET extra=json_remove(
          CASE WHEN json_valid(COALESCE(extra, '{}')) THEN COALESCE(extra, '{}') ELSE '{}' END,
          '$.workflow_retry_exhausted_alert_pending_day',
          '$.workflow_retry_exhausted_alert_claim_token',
          '$.workflow_retry_exhausted_alert_claimed_at')
      WHERE id=?
        AND COALESCE(json_extract(CASE WHEN json_valid(COALESCE(extra, '{}')) THEN COALESCE(extra, '{}') ELSE '{}' END,
                                  '$.workflow_retry_exhausted_alert_claim_token'), '')=?`,
  ).bind(itemId, token).run();
}
