import type { Env } from '../index';
import { pushDeerMessage } from '../notifier';
import {
  AUTOMATIC_NEWS_REVIEW_CANDIDATE_LIMIT,
  deriveAutomaticManualEventIdentityV1,
  MANUAL_NEWS_REVIEW_CANDIDATE_LIMIT,
  MANUAL_NEWS_SOURCE_SUPPORT_POLICY,
  mergeAuthorizedManualNewsCandidates,
  mergeManualLeadCandidate,
  TOTAL_NEWS_REVIEW_CANDIDATE_LIMIT,
} from './manual-news-leads';
import {
  authorizeFormalNewsSet,
  formalNewsFinalGuardBindings,
  formalNewsFinalGuardSqlPredicate,
  type FormalNewsAuthorizationResult,
} from './news-source-policy';
import {
  loadVerifiedManualCandidateProof,
  MANUAL_VERIFICATION_SNAPSHOT_GUARD_SQL,
  manualVerificationSnapshotGuardBindings,
  type PersistedManualVerificationRow,
} from './manual-news-leads-verification';

export interface NewsReviewCandidate {
  item_id: string;
  title: string;
  summary: string;
  source: string;
  score: number | null;
  url?: string;
  event_key?: string;
  origin?: 'manual_lead';
  lead_id?: string;
}

export interface NewsReviewTokenResult {
  ok: boolean;
  expired: boolean;
}

export interface NewsReviewBatch {
  review_date: string;
  batch_id: string;
  candidate_ids: string[];
  candidates: NewsReviewCandidate[];
  default_selected_ids: string[];
  applied_selected_ids: string[] | null;
  selection_hash: string | null;
  edit_revision: number;
  publish_status: 'not_requested' | 'pending' | 'published' | 'failed';
  publish_error: string | null;
  published_at: number | null;
  notified_at: number | null;
  notification_hash: string | null;
  auto_repaired_from_batch: string | null;
  auto_repaired_invalid_ids: string[];
  superseded_by: string | null;
  // 该批次的 applied_selected_ids 出自人工审核提交，或由人审序列继承而来。
  // 一旦置 1，同一 lineage 的后续版本必须继承，自动路径不得重排（见 038 迁移）。
  human_reviewed: boolean;
  batch_revision: number;
  supersedes_batch_id: string | null;
  revision_origin: 'scheduled_freeze' | 'manual_lead';
  lineage_id: string;
  is_current: boolean;
  candidate_generation: number;
  created_at: number;
  expires_at: number;
}

export interface VerifiedNewsReviewManualProofRef {
  item_id: string;
  lead_id: string;
  verification_id: string;
  creation_nonce: string;
  canonical_digest: string;
}

export interface VerifiedNewsReviewSelectionSnapshot {
  batch_id: string;
  batch_revision: number;
  selection_hash: string;
  selected_ids: string[];
  manual_verifications: VerifiedNewsReviewManualProofRef[];
}

interface NewsReviewBatchRow {
  review_date: string;
  batch_id: string;
  candidate_ids: string;
  candidates_json: string;
  default_selected_ids: string;
  applied_selected_ids: string | null;
  selection_hash: string | null;
  edit_revision: number;
  publish_status: NewsReviewBatch['publish_status'];
  publish_error: string | null;
  published_at: number | null;
  notified_at: number | null;
  notification_hash: string | null;
  auto_repaired_from_batch: string | null;
  auto_repaired_invalid_ids: string | null;
  superseded_by: string | null;
  human_reviewed?: number;
  batch_revision?: number;
  supersedes_batch_id?: string | null;
  revision_origin?: NewsReviewBatch['revision_origin'];
  lineage_id?: string;
  is_current?: number;
  candidate_generation?: number;
  created_at: number;
  expires_at: number;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function parseStringArray(value: string | null): string[] {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseCandidates(value: string): NewsReviewCandidate[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as NewsReviewCandidate[] : [];
  } catch {
    return [];
  }
}

function toBatch(row: NewsReviewBatchRow): NewsReviewBatch {
  return {
    ...row,
    batch_revision: Number(row.batch_revision || 1),
    supersedes_batch_id: row.supersedes_batch_id || null,
    revision_origin: row.revision_origin || 'scheduled_freeze',
    // 迁移落地前的旧行没有该列，按「无人审」处理，行为与改造前一致。
    human_reviewed: row.human_reviewed === 1,
    lineage_id: row.lineage_id || row.review_date,
    is_current: row.is_current === undefined ? !row.superseded_by : row.is_current === 1,
    candidate_generation: Number(row.candidate_generation || 0),
    candidate_ids: parseStringArray(row.candidate_ids),
    candidates: parseCandidates(row.candidates_json),
    default_selected_ids: parseStringArray(row.default_selected_ids),
    applied_selected_ids: row.applied_selected_ids === null ? null : parseStringArray(row.applied_selected_ids),
    auto_repaired_invalid_ids: parseStringArray(row.auto_repaired_invalid_ids),
  };
}

function base64Url(bytes: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function hmac(secret: string, payload: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return base64Url(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
}

function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index++) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

function assertReviewDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new Error('invalid_review_date');
  }
}

export function newsReviewExpiresAt(date: string): number {
  assertReviewDate(date);
  return Date.parse(`${date}T16:00:00.000Z`);
}

export async function buildNewsReviewBatchId(
  date: string,
  candidates: readonly NewsReviewCandidate[],
  lineage?: { batch_revision: number; supersedes_batch_id: string | null; lineage_id: string },
): Promise<string> {
  assertReviewDate(date);
  const hash = await sha256Hex(stableJson({ date, candidates, ...(lineage ? { lineage } : {}) }));
  return `nr-${date.replace(/-/g, '')}-${hash.slice(0, 12)}`;
}

export async function createNewsReviewToken(secret: string, date: string, batchId: string): Promise<string> {
  if (!secret) throw new Error('missing_news_review_secret');
  assertReviewDate(date);
  return hmac(secret, `${date}\n${batchId}`);
}

export async function verifyNewsReviewToken(
  secret: string,
  date: string,
  batchId: string,
  token: string,
  now = Date.now(),
): Promise<NewsReviewTokenResult> {
  let expiresAt: number;
  try {
    expiresAt = newsReviewExpiresAt(date);
  } catch {
    return { ok: false, expired: false };
  }
  if (now >= expiresAt) return { ok: false, expired: true };
  if (!secret || !token) return { ok: false, expired: false };
  const expected = await createNewsReviewToken(secret, date, batchId);
  return { ok: safeEqual(expected, token), expired: false };
}

export async function verifyNewsReviewTokenSignature(
  secret: string,
  date: string,
  batchId: string,
  token: string,
): Promise<boolean> {
  try {
    if (!secret || !token) return false;
    return safeEqual(await createNewsReviewToken(secret, date, batchId), token);
  } catch {
    return false;
  }
}

export type NewsReviewSelectionValidation =
  | { ok: true; selected_ids: string[] }
  | { ok: false; error: 'selection_must_have_one_to_five' | 'selection_must_be_unique' | 'selection_contains_unknown_item' };

export function validateNewsReviewSelection(
  selectedIds: unknown,
  candidateIds: readonly string[],
): NewsReviewSelectionValidation {
  if (
    !Array.isArray(selectedIds)
    || selectedIds.length < 1
    || selectedIds.length > 5
    || selectedIds.some((id) => typeof id !== 'string')
  ) {
    return { ok: false, error: 'selection_must_have_one_to_five' };
  }
  const normalized = selectedIds.map((id) => id.trim());
  if (new Set(normalized).size !== normalized.length) {
    return { ok: false, error: 'selection_must_be_unique' };
  }
  const candidates = new Set(candidateIds);
  if (normalized.some((id) => !candidates.has(id))) {
    return { ok: false, error: 'selection_contains_unknown_item' };
  }
  return { ok: true, selected_ids: normalized };
}

export async function newsReviewSelectionHash(selectedIds: readonly string[]): Promise<string> {
  return sha256Hex(stableJson(selectedIds));
}

export async function getNewsReviewBatch(
  env: Env,
  date: string,
  batchId: string,
): Promise<NewsReviewBatch | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM daily_news_review_batches WHERE review_date = ? AND batch_id = ?`,
  ).bind(date, batchId).first<NewsReviewBatchRow>();
  return row ? toBatch(row) : null;
}

export async function getActiveNewsReviewBatch(env: Env, date: string): Promise<NewsReviewBatch | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM daily_news_review_batches
     WHERE review_date = ? AND lineage_id = ? AND is_current = 1
     ORDER BY created_at DESC LIMIT 1`,
  ).bind(date, date).first<NewsReviewBatchRow>();
  return row ? toBatch(row) : null;
}

async function readNewsReviewCandidateGeneration(env: Env, date: string, now: number): Promise<number> {
  assertReviewDate(date);
  await env.DB.prepare(
    `/* news_review:candidate_generation_init */ INSERT OR IGNORE INTO daily_news_review_candidate_generations
     (review_date, lineage_id, generation, updated_at) VALUES (?, ?, 0, ?)`,
  ).bind(date, date, now).run();
  const row = await env.DB.prepare(
    `/* news_review:candidate_generation_read */ SELECT generation
     FROM daily_news_review_candidate_generations WHERE review_date = ? AND lineage_id = ?`,
  ).bind(date, date).first<{ generation: number }>();
  const generation = Number(row?.generation);
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error('invalid_news_review_candidate_generation');
  }
  return generation;
}

async function readAppliedNewsReviewSelection(env: Env, date: string): Promise<string[] | null> {
  try {
    const row = await env.DB.prepare(
      `SELECT applied_selected_ids FROM daily_news_review_batches
       WHERE review_date = ? AND lineage_id = ? AND is_current = 1
         AND applied_selected_ids IS NOT NULL
       ORDER BY created_at DESC, edit_revision DESC LIMIT 1`,
    ).bind(date, date).first<{ applied_selected_ids: string }>();
    const ids = row ? parseStringArray(row.applied_selected_ids) : [];
    return row && ids.length <= 5 ? ids : null;
  } catch (error) {
    // 部署迁移与 Worker 代码存在短暂先后窗口；缺表时回退默认 digest_pool，
    // 不能让邮件、日报页或默认视频因此中断。
    console.warn('[news-review] applied selection unavailable', String(error).slice(0, 160));
    return null;
  }
}

export async function getAppliedNewsReviewSelection(env: Env, date: string): Promise<string[] | null> {
  let sanitizedBatch: NewsReviewBatch | null = null;
  try {
    // Applied selections are production inputs for email, static daily pages, and
    // staged video payloads. Always revalidate the current snapshot against full
    // item provenance; a generic legacy id cannot reveal source_ref/feed identity.
    sanitizedBatch = (await sanitizeCurrentNewsReviewBatch(env, date)).batch;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isRolloutSchemaGap = /(?:no such table|no such column):?\s*[\w.]+/i.test(message);
    if (message !== 'news_review_batch_not_found' && !isRolloutSchemaGap) throw error;
  }
  const applied = await readAppliedNewsReviewSelection(env, date);
  if (!applied || !sanitizedBatch) return applied;
  return (await authorizeNewsReviewBatchSnapshot(
    env, date, sanitizedBatch, applied, 'applied_selection_final_projection',
  )).allowed_ids;
}

// HK 推送来源标记用：当日 lineage 的当前批次是否携带人审序列。表/列在 rollout 窗口
// 内可能还没迁移到位，此时按「无人审」处理，让契约退化成原来的自动语义而不是报错。
export async function hasHumanReviewedNewsSelection(env: Env, date: string): Promise<boolean> {
  try {
    const row = await env.DB.prepare(
      `/* news_review:human_reviewed_current */ SELECT human_reviewed
       FROM daily_news_review_batches
       WHERE review_date = ? AND lineage_id = ? AND is_current = 1
       ORDER BY created_at DESC LIMIT 1`,
    ).bind(date, date).first<{ human_reviewed: number }>();
    return Number(row?.human_reviewed || 0) === 1;
  } catch (error) {
    console.warn('[news-review] human review flag unavailable', String(error).slice(0, 160));
    return false;
  }
}

async function readRawPublishedNewsReviewSelection(
  env: Env,
  date: string,
  currentBatch: NewsReviewBatch,
): Promise<string[]> {
  if (Array.isArray(currentBatch.applied_selected_ids)) return currentBatch.applied_selected_ids;
  try {
    const previous = await env.DB.prepare(
      `SELECT default_selected_ids FROM daily_news_review_batches
       WHERE review_date = ? AND superseded_by = ?
       ORDER BY created_at DESC LIMIT 1`,
    ).bind(date, currentBatch.batch_id).first<{ default_selected_ids: string }>();
    const ids = previous ? parseStringArray(previous.default_selected_ids) : [];
    if (ids.length === 5) return ids;
  } catch {
    // Initial rollout or a pre-migration batch has no previous snapshot.
  }
  return currentBatch.default_selected_ids;
}

export async function getPublishedNewsReviewSelection(
  env: Env,
  date: string,
  currentBatch: NewsReviewBatch,
): Promise<string[]> {
  const raw = await readRawPublishedNewsReviewSelection(env, date, currentBatch);
  return (await authorizeNewsReviewBatchSnapshot(
    env, date, currentBatch, raw, 'published_selection',
  )).allowed_ids;
}

/**
 * Binds a review row and its complete outward item authorization in one final
 * SQL snapshot. Historical rows remain immutable, but their projection is not
 * a transferable capability when the current item/source/manual proof changes.
 */
export async function authorizeNewsReviewBatchSnapshot(
  env: Env,
  date: string,
  batch: NewsReviewBatch,
  itemIds: readonly string[],
  purpose: string,
): Promise<FormalNewsAuthorizationResult> {
  const authorization = await authorizeFormalNewsSet(env, date, itemIds, purpose);
  if (stableJson(authorization.allowed_ids) !== stableJson(itemIds)) return authorization;
  const guard = formalNewsFinalGuardSqlPredicate();
  const current = await env.DB.prepare(
    `/* news_review:batch_formal_final_guard */ SELECT 1 AS ok
       FROM daily_news_review_batches b
      WHERE b.review_date=? AND b.lineage_id=? AND b.batch_id=?
        AND b.batch_revision=? AND b.is_current=? AND b.edit_revision=?
        AND b.candidate_generation=? AND b.candidate_ids=? AND b.default_selected_ids=?
        AND COALESCE(b.applied_selected_ids,'')=? AND COALESCE(b.selection_hash,'')=?
        AND b.superseded_by IS ? AND ${guard}`,
  ).bind(
    date, batch.lineage_id, batch.batch_id, batch.batch_revision, batch.is_current ? 1 : 0,
    batch.edit_revision, batch.candidate_generation, JSON.stringify(batch.candidate_ids),
    JSON.stringify(batch.default_selected_ids),
    batch.applied_selected_ids === null ? '' : JSON.stringify(batch.applied_selected_ids),
    batch.selection_hash || '', batch.superseded_by,
    ...formalNewsFinalGuardBindings(authorization),
  ).first<{ ok: number }>();
  if (Number(current?.ok || 0) === 1) return authorization;
  return {
    allowed_ids: [],
    decisions: authorization.decisions.map((decision) => decision.allowed
      ? { item_id: decision.item_id, allowed: false, code: 'DENY_AUTHORIZATION_STALE' as const }
      : decision),
  };
}

export interface FreezeNewsReviewBatchResult {
  batch: NewsReviewBatch;
  created: boolean;
  superseded_batch_id: string | null;
  auto_repaired: boolean;
  auto_repaired_invalid_ids: string[];
}

export function repairInvalidNewsReviewSelection(
  publishedIds: readonly string[],
  candidateIds: readonly string[],
): { required: boolean; invalid_ids: string[]; selected_ids: string[] } {
  const candidates = new Set(candidateIds);
  const invalidIds = publishedIds.filter((id) => !candidates.has(id));
  if (!invalidIds.length) return { required: false, invalid_ids: [], selected_ids: [...publishedIds] };
  const targetCount = Math.min(5, Math.max(1, publishedIds.length));
  const selected = publishedIds.filter((id) => candidates.has(id));
  for (const id of candidateIds) {
    if (selected.length >= targetCount) break;
    if (!selected.includes(id)) selected.push(id);
  }
  return { required: true, invalid_ids: invalidIds, selected_ids: selected.slice(0, targetCount) };
}

export async function freezeNewsReviewBatch(
  env: Env,
  date: string,
  candidates: readonly NewsReviewCandidate[],
  defaultSelectedIds: readonly string[],
  now = Date.now(),
): Promise<FreezeNewsReviewBatchResult> {
  const candidateGeneration = await readNewsReviewCandidateGeneration(env, date, now);
  return freezeNewsReviewBatchAtGeneration(
    env, date, candidates, defaultSelectedIds, now, candidateGeneration, 0,
  );
}

const MAX_CANDIDATE_GENERATION_RETRIES = 3;

async function freezeNewsReviewBatchAtGeneration(
  env: Env,
  date: string,
  candidates: readonly NewsReviewCandidate[],
  defaultSelectedIds: readonly string[],
  now: number,
  candidateGeneration: number,
  generationRetry: number,
): Promise<FreezeNewsReviewBatchResult> {
  if (candidates.length < 5) throw new Error('review_candidates_must_be_five_to_ten');
  const submittedManualCount = candidates.filter(isManualCandidateSnapshot).length;
  if (submittedManualCount > MANUAL_NEWS_REVIEW_CANDIDATE_LIMIT) throw new Error('manual_candidate_limit_exceeded');
  if (candidates.length - submittedManualCount > AUTOMATIC_NEWS_REVIEW_CANDIDATE_LIMIT) {
    throw new Error('automatic_candidate_limit_exceeded');
  }
  if (candidates.length > TOTAL_NEWS_REVIEW_CANDIDATE_LIMIT) throw new Error('review_candidate_total_limit_exceeded');
  const submittedCandidateIds = candidates.map((candidate) => candidate.item_id);
  if (new Set(submittedCandidateIds).size !== submittedCandidateIds.length) throw new Error('review_candidates_must_be_unique');
  const previous = await getActiveNewsReviewBatch(env, date);
  const preserved = await preserveConfirmedManualCandidates(
    env, date, candidates, defaultSelectedIds, previous,
  );
  const effectiveCandidates = preserved.candidates;
  const effectiveManualCount = effectiveCandidates.filter(isManualCandidateSnapshot).length;
  if (effectiveManualCount > MANUAL_NEWS_REVIEW_CANDIDATE_LIMIT) throw new Error('manual_candidate_limit_exceeded');
  if (effectiveCandidates.length - effectiveManualCount > AUTOMATIC_NEWS_REVIEW_CANDIDATE_LIMIT) {
    throw new Error('automatic_candidate_limit_exceeded');
  }
  if (effectiveCandidates.length > TOTAL_NEWS_REVIEW_CANDIDATE_LIMIT) {
    throw new Error('review_candidate_total_limit_exceeded');
  }
  const candidateIds = effectiveCandidates.map((candidate) => candidate.item_id);
  const freezeAuthorization = await authorizeFormalNewsSet(
    env, date, candidateIds, 'review_freeze_final_guard',
  );
  if (stableJson(freezeAuthorization.allowed_ids) !== stableJson(candidateIds)) {
    throw new Error('news_review_formal_authorization_stale');
  }
  const validatedDefault = validateNewsReviewSelection(preserved.default_selected_ids, candidateIds);
  if (!validatedDefault.ok) throw new Error(`invalid_default_selection:${validatedDefault.error}`);
  if (previous
    && stableJson(previous.candidates) === stableJson(effectiveCandidates)
    && stableJson(previous.default_selected_ids) === stableJson(validatedDefault.selected_ids)) {
    const unchangedAuthorization = await authorizeNewsReviewBatchSnapshot(
      env, date, previous, candidateIds, 'review_freeze_unchanged_guard',
    );
    if (stableJson(unchangedAuthorization.allowed_ids) !== stableJson(candidateIds)) {
      throw new Error('news_review_formal_authorization_stale');
    }
    return {
      batch: previous,
      created: false,
      superseded_batch_id: null,
      auto_repaired: !!previous.auto_repaired_from_batch,
      auto_repaired_invalid_ids: previous.auto_repaired_invalid_ids,
    };
  }
  const batchRevision = (previous?.batch_revision || 0) + 1;
  const batchId = await buildNewsReviewBatchId(date, effectiveCandidates, {
    batch_revision: batchRevision,
    supersedes_batch_id: previous?.batch_id || null,
    lineage_id: date,
  });
  const existing = await getNewsReviewBatch(env, date, batchId);
  if (existing) {
    const current = existing.is_current ? existing : await getActiveNewsReviewBatch(env, date);
    if (current) {
      const existingAuthorization = await authorizeNewsReviewBatchSnapshot(
        env, date, current, current.candidate_ids, 'review_freeze_existing_guard',
      );
      if (stableJson(existingAuthorization.allowed_ids) !== stableJson(current.candidate_ids)) {
        throw new Error('news_review_formal_authorization_stale');
      }
      return {
        batch: current,
        created: false,
        superseded_batch_id: null,
        auto_repaired: !!current.auto_repaired_from_batch,
        auto_repaired_invalid_ids: current.auto_repaired_invalid_ids,
      };
    }
  }
  const previousPublishedIds = previous
    ? await getPublishedNewsReviewSelection(env, date, previous)
    : [];
  const repair = previous
    ? repairInvalidNewsReviewSelection(previousPublishedIds, candidateIds)
    : { required: false, invalid_ids: [], selected_ids: [] };
  // 人审优先：previous 带人审标记时，新版本继承人审序列本身，而不是让 applied_selected_ids
  // 归空、把生产回落到本轮自动排序。repairInvalidNewsReviewSelection 在「无失效条目」时
  // 原样返回人审顺序；有失效条目时只剔除失效项，保留其余相对顺序，补位项追加在末尾。
  const humanReviewed = !!previous?.human_reviewed;
  const inheritsHumanSelection = humanReviewed && repair.selected_ids.length > 0;
  const appliedSelectedIds = repair.required || inheritsHumanSelection ? repair.selected_ids : null;
  const selectionHash = appliedSelectedIds ? await newsReviewSelectionHash(appliedSelectedIds) : null;
  const editRevision = inheritsHumanSelection
    ? Math.max(previous!.edit_revision, 1)
    : (repair.required ? 1 : 0);
  // 继承且无失效条目时选择序列与线上一致，沿用上一版的发布状态，不制造假的待发布态。
  const publishStatus = repair.required
    ? 'pending'
    : (inheritsHumanSelection ? previous!.publish_status : 'not_requested');
  const publishedAt = !repair.required && inheritsHumanSelection ? previous!.published_at : null;
  const writeAuthorization = await authorizeFormalNewsSet(
    env, date, candidateIds, 'review_freeze_write_guard',
  );
  if (stableJson(writeAuthorization.allowed_ids) !== stableJson(candidateIds)) {
    throw new Error('news_review_formal_authorization_stale');
  }
  const formalWriteGuard = formalNewsFinalGuardSqlPredicate();
  const insert = env.DB.prepare(
    `/* news_review:insert_revision_cas */ INSERT INTO daily_news_review_batches (
       review_date, batch_id, candidate_ids, candidates_json, default_selected_ids,
       applied_selected_ids, selection_hash, edit_revision, publish_status,
       auto_repaired_from_batch, auto_repaired_invalid_ids, created_at, expires_at,
       batch_revision, supersedes_batch_id, revision_origin, lineage_id, is_current,
       candidate_generation, published_at, human_reviewed
     ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled_freeze', ?, ?, ?, ?, ?
     WHERE EXISTS (SELECT 1 FROM daily_news_review_candidate_generations
       WHERE review_date = ? AND lineage_id = ? AND generation = ?)
     AND ${previous
       ? `EXISTS (SELECT 1 FROM daily_news_review_batches
            WHERE review_date = ? AND lineage_id = ? AND batch_id = ? AND batch_revision = ? AND is_current = 1
              AND edit_revision=? AND candidate_generation=? AND candidate_ids=? AND default_selected_ids=?
              AND COALESCE(applied_selected_ids,'')=? AND COALESCE(selection_hash,'')=?
              AND superseded_by IS NULL)`
       : `NOT EXISTS (SELECT 1 FROM daily_news_review_batches
            WHERE review_date = ? AND lineage_id = ? AND is_current = 1)`}
     AND ${formalWriteGuard}
     ON CONFLICT(review_date, batch_id) DO NOTHING`,
  ).bind(
    date, batchId, JSON.stringify(candidateIds), JSON.stringify(effectiveCandidates),
    JSON.stringify(validatedDefault.selected_ids), appliedSelectedIds ? JSON.stringify(appliedSelectedIds) : null,
    selectionHash, editRevision, publishStatus,
    repair.required ? previous!.batch_id : null, repair.required ? JSON.stringify(repair.invalid_ids) : null,
    now, newsReviewExpiresAt(date), batchRevision, previous?.batch_id || null, date, previous ? 0 : 1,
    candidateGeneration, publishedAt, humanReviewed ? 1 : 0, date, date, candidateGeneration,
    date, date, ...(previous ? [
      previous.batch_id, previous.batch_revision, previous.edit_revision,
      previous.candidate_generation, JSON.stringify(previous.candidate_ids),
      JSON.stringify(previous.default_selected_ids),
      previous.applied_selected_ids === null ? '' : JSON.stringify(previous.applied_selected_ids),
      previous.selection_hash || '',
    ] : []),
    ...formalNewsFinalGuardBindings(writeAuthorization),
  );
  const statements: D1PreparedStatement[] = [insert];
  if (previous) {
    statements.push(
      env.DB.prepare(
        `/* news_review:supersede_revision_cas */ UPDATE daily_news_review_batches
         SET superseded_by = ?, is_current = 0
         WHERE review_date = ? AND lineage_id = ? AND batch_id = ? AND batch_revision = ? AND is_current = 1
           AND EXISTS (SELECT 1 FROM daily_news_review_batches
             WHERE review_date = ? AND batch_id = ? AND is_current = 0)`,
      ).bind(batchId, date, date, previous.batch_id, previous.batch_revision, date, batchId),
      env.DB.prepare(
        `/* news_review:activate_revision_cas */ UPDATE daily_news_review_batches SET is_current = 1
         WHERE review_date = ? AND lineage_id = ? AND batch_id = ? AND is_current = 0
           AND EXISTS (SELECT 1 FROM daily_news_review_batches
             WHERE review_date = ? AND batch_id = ? AND superseded_by = ?)`,
      ).bind(date, date, batchId, date, previous.batch_id, batchId),
    );
  }
  const writes = await env.DB.batch(statements) as Array<{ meta?: { changes?: number } }>;
  if (Number(writes[0]?.meta?.changes || 0) !== 1) {
    const failedAuthorization = await authorizeFormalNewsSet(
      env, date, candidateIds, 'review_freeze_cas_failure_guard',
    );
    if (stableJson(failedAuthorization.allowed_ids) !== stableJson(candidateIds)) {
      throw new Error('news_review_formal_authorization_stale');
    }
  }
  const inserted = await getNewsReviewBatch(env, date, batchId);
  const active = inserted?.is_current ? inserted : await getActiveNewsReviewBatch(env, date);
  if (!active) {
    const latestGeneration = await readNewsReviewCandidateGeneration(env, date, now);
    if (latestGeneration !== candidateGeneration) {
      if (generationRetry >= MAX_CANDIDATE_GENERATION_RETRIES) {
        throw new Error('news_review_candidate_generation_conflict');
      }
      // Re-run the complete candidate collection. In particular, this reloads
      // durable pre-freeze confirmations instead of publishing the stale V1.
      return freezeNewsReviewBatchAtGeneration(
        env, date, candidates, defaultSelectedIds, now, latestGeneration, generationRetry + 1,
      );
    }
    throw new Error('news_review_batch_cas_failed');
  }
  const verifiedActive = active.candidates.some(isManualCandidateSnapshot)
    ? (await sanitizeCurrentNewsReviewBatch(env, date, now)).batch
    : active;
  return {
    batch: verifiedActive,
    created: verifiedActive.batch_id === batchId ? !existing : verifiedActive.supersedes_batch_id === batchId,
    superseded_batch_id: verifiedActive.batch_id === batchId
      ? previous?.batch_id || null
      : verifiedActive.supersedes_batch_id,
    auto_repaired: verifiedActive.batch_id === batchId && repair.required,
    auto_repaired_invalid_ids: verifiedActive.batch_id === batchId
      ? repair.invalid_ids
      : verifiedActive.auto_repaired_invalid_ids,
  };
}

export type SubmitNewsReviewResult =
  | { ok: true; changed: false; retry_publish: boolean; batch: NewsReviewBatch; selected_ids: string[] }
  | { ok: true; changed: true; retry_publish: true; batch: NewsReviewBatch; selected_ids: string[] }
  | { ok: false; status: 400 | 401 | 404 | 409 | 410; error: string; batch?: NewsReviewBatch };

export async function submitNewsReviewSelection(
  env: Env,
  input: { date: string; batch_id: string; token: string; selected_ids: unknown },
  now = Date.now(),
): Promise<SubmitNewsReviewResult> {
  const tokenStatus = await verifyNewsReviewToken(
    newsReviewSecret(env), input.date, input.batch_id, input.token, now,
  );
  if (tokenStatus.expired) return { ok: false, status: 410, error: 'review_expired' };
  if (!tokenStatus.ok) return { ok: false, status: 401, error: 'invalid_review_token' };
  const batch = await getNewsReviewBatch(env, input.date, input.batch_id);
  if (!batch) return { ok: false, status: 404, error: 'review_batch_not_found' };
  if (batch.superseded_by || !batch.is_current || batch.lineage_id !== input.date) {
    return { ok: false, status: 409, error: 'review_batch_superseded', batch };
  }
  const sanitized = await sanitizeCurrentNewsReviewBatch(env, input.date, now);
  if (sanitized.batch.batch_id !== batch.batch_id) {
    const requested = Array.isArray(input.selected_ids)
      ? input.selected_ids.filter((id): id is string => typeof id === 'string')
      : [];
    if (requested.some((id) => sanitized.dropped_ids.includes(id))) {
      return { ok: false, status: 409, error: 'stale_candidate', batch: sanitized.batch };
    }
    return { ok: false, status: 409, error: 'review_batch_superseded', batch: sanitized.batch };
  }
  const validation = validateNewsReviewSelection(input.selected_ids, batch.candidate_ids);
  if (!validation.ok) return { ok: false, status: 400, error: validation.error, batch };
  const selectedIds = validation.selected_ids;
  const selectedAuthorization = await authorizeFormalNewsSet(
    env, input.date, selectedIds, 'review_submit_final_guard',
  );
  if (stableJson(selectedAuthorization.allowed_ids) !== stableJson(selectedIds)) {
    return { ok: false, status: 409, error: 'stale_candidate', batch: sanitized.batch };
  }
  const hash = await newsReviewSelectionHash(selectedIds);
  const effectiveIds = batch.applied_selected_ids
    || await getPublishedNewsReviewSelection(env, input.date, batch);
  const effectiveHash = await newsReviewSelectionHash(effectiveIds);
  if (hash === effectiveHash) {
    const unchangedAuthorization = await authorizeNewsReviewBatchSnapshot(
      env, input.date, batch, batch.candidate_ids, 'review_submit_unchanged_guard',
    );
    if (stableJson(unchangedAuthorization.allowed_ids) !== stableJson(batch.candidate_ids)) {
      return { ok: false, status: 409, error: 'stale_candidate', batch: sanitized.batch };
    }
    return {
      ok: true,
      changed: false,
      retry_publish: !!batch.applied_selected_ids && batch.publish_status !== 'published',
      batch,
      selected_ids: selectedIds,
    };
  }
  const verificationGuard = sanitized.manual_verifications.length
    ? sanitized.manual_verifications.map(() => MANUAL_VERIFICATION_SNAPSHOT_GUARD_SQL).join(' AND ')
    : '1 = 1';
  const verificationBindings = sanitized.manual_verifications.flatMap((snapshot) =>
    manualVerificationSnapshotGuardBindings(snapshot.lead_id, snapshot.verification));
  const writeAuthorization = await authorizeFormalNewsSet(
    env, input.date, batch.candidate_ids, 'review_submit_write_guard',
  );
  if (stableJson(writeAuthorization.allowed_ids) !== stableJson(batch.candidate_ids)) {
    return { ok: false, status: 409, error: 'stale_candidate', batch: sanitized.batch };
  }
  const formalWriteGuard = formalNewsFinalGuardSqlPredicate();
  const writeStatement = env.DB.prepare(
    `UPDATE daily_news_review_batches SET
       applied_selected_ids = ?, selection_hash = ?, edit_revision = edit_revision + 1,
       publish_status = 'pending', publish_error = NULL, published_at = NULL,
       human_reviewed = 1
     WHERE review_date = ? AND lineage_id = ? AND batch_id = ?
       AND is_current = 1 AND superseded_by IS NULL
       AND batch_revision=? AND edit_revision=? AND candidate_generation=?
       AND candidate_ids=? AND default_selected_ids=?
       AND COALESCE(applied_selected_ids,'')=? AND COALESCE(selection_hash,'')=?
       AND ${verificationGuard} AND ${formalWriteGuard}`,
  ).bind(
    JSON.stringify(selectedIds), hash, input.date, input.date, input.batch_id,
    batch.batch_revision, batch.edit_revision, batch.candidate_generation,
    JSON.stringify(batch.candidate_ids), JSON.stringify(batch.default_selected_ids),
    batch.applied_selected_ids === null ? '' : JSON.stringify(batch.applied_selected_ids),
    batch.selection_hash || '',
    ...verificationBindings,
    ...formalNewsFinalGuardBindings(writeAuthorization),
  );
  const [write] = await env.DB.batch([writeStatement]) as Array<{ meta?: { changes?: number } }>;
  if (Number(write.meta?.changes || 0) !== 1) {
    const refreshed = await sanitizeCurrentNewsReviewBatch(env, input.date, now);
    const stale = selectedIds.some((id) => refreshed.dropped_ids.includes(id));
    return {
      ok: false,
      status: 409,
      error: stale ? 'stale_candidate' : 'review_selection_write_conflict',
      batch: refreshed.batch,
    };
  }
  const updated = await getNewsReviewBatch(env, input.date, input.batch_id);
  if (!updated?.applied_selected_ids || updated.selection_hash !== hash) {
    return { ok: false, status: 409, error: 'review_selection_write_conflict', batch: updated || batch };
  }
  return { ok: true, changed: true, retry_publish: true, batch: updated, selected_ids: selectedIds };
}

export async function markNewsReviewPublished(
  env: Env,
  date: string,
  batchId: string,
  selectionHash: string,
  error?: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE daily_news_review_batches SET publish_status = ?, publish_error = ?, published_at = ?
     WHERE review_date = ? AND batch_id = ? AND selection_hash = ?`,
  ).bind(
    error ? 'failed' : 'published',
    error ? error.slice(0, 500) : null,
    error ? null : Date.now(),
    date,
    batchId,
    selectionHash,
  ).run();
}

interface NewsReviewPoolMetaCandidate {
  id?: string;
  title?: string;
  title_zh?: string;
  source_company?: string;
  adjusted_score?: number;
}

interface NewsReviewItemRow {
  id: string;
  source_id: string | null;
  source_ref: string | null;
  title: string | null;
  content: string | null;
  content_translated: string | null;
  url: string | null;
  extra: string | null;
}

async function readScheduledNewsItemPolicy(
  env: Env,
  date: string,
  itemIds: readonly string[],
): Promise<Map<string, boolean>> {
  const result = await authorizeFormalNewsSet(env, date, itemIds, 'review_sanitizer');
  return new Map(result.decisions.map((row) => [row.item_id, row.allowed]));
}

function isManualCandidateSnapshot(candidate: Pick<NewsReviewCandidate, 'item_id' | 'origin' | 'lead_id'>): boolean {
  return candidate.origin === 'manual_lead'
    || !!candidate.lead_id
    || candidate.item_id.startsWith('blog:manual:')
    || candidate.item_id.startsWith('manual-news:');
}

function parseObject(value: string | null): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function compactReviewText(value: unknown, maxLength: number): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (Array.from(text).length <= maxLength) return text;
  return `${Array.from(text).slice(0, Math.max(0, maxLength - 1)).join('').replace(/[，,、；;：:\s]+$/g, '')}…`;
}

interface ConfirmedManualCandidateRow {
  id: string;
  input_url: string;
}

interface VerifiedManualCandidateSnapshot {
  candidate: NewsReviewCandidate;
  lead_id: string;
  verification: PersistedManualVerificationRow;
}

async function verifiedManualCandidateSnapshot(
  env: Env,
  row: ConfirmedManualCandidateRow,
): Promise<VerifiedManualCandidateSnapshot | null> {
  const verified = await loadVerifiedManualCandidateProof(env, row.id);
  if (!verified) return null;
  if (verified.policy_version === MANUAL_NEWS_SOURCE_SUPPORT_POLICY) {
    return {
      lead_id: row.id,
      verification: verified.record,
      candidate: {
        ...verified.candidate,
        origin: 'manual_lead',
        lead_id: row.id,
      },
    };
  }
  if (!verified.assessment) return null;
  const primaryEvidence = verified.evidence.find((item) => item.reliable) || verified.evidence[0];
  const assessment = verified.assessment;
  return {
    lead_id: row.id,
    verification: verified.record,
    candidate: {
      item_id: `blog:manual:${row.id}`,
      title: compactReviewText(assessment.title, 80),
      summary: compactReviewText(assessment.summary, 180),
      source: compactReviewText(primaryEvidence?.publisher || '手工补录', 40),
      score: assessment.score,
      ...(primaryEvidence?.url || row.input_url ? { url: primaryEvidence?.url || row.input_url } : {}),
      event_key: assessment.event_key,
      origin: 'manual_lead',
      lead_id: row.id,
    },
  };
}

async function verifiedManualCandidate(
  env: Env,
  row: ConfirmedManualCandidateRow,
): Promise<NewsReviewCandidate | null> {
  return (await verifiedManualCandidateSnapshot(env, row))?.candidate || null;
}

async function confirmedManualCandidateById(
  env: Env,
  leadId: string,
): Promise<VerifiedManualCandidateSnapshot | null> {
  const row = await env.DB.prepare(
    `/* news_review:confirmed_manual_candidate_by_id */ SELECT id, input_url
     FROM manual_news_leads
     WHERE id = ? AND confirmed_at IS NOT NULL AND status IN ('recommended', 'needs_review')`,
  ).bind(leadId).first<ConfirmedManualCandidateRow>();
  return row ? verifiedManualCandidateSnapshot(env, row) : null;
}

function manualCandidateLeadId(candidate: NewsReviewCandidate): string | null {
  if (candidate.lead_id) return candidate.lead_id;
  if (candidate.item_id.startsWith('blog:manual:')) return candidate.item_id.slice('blog:manual:'.length);
  if (candidate.item_id.startsWith('manual-news:')) return candidate.item_id.slice('manual-news:'.length);
  return null;
}

export async function loadAutomaticNewsReviewEventIdentitySidecar(
  env: Env,
  candidates: readonly NewsReviewCandidate[],
): Promise<Record<string, string>> {
  const ids = [...new Set(candidates
    .filter((candidate) => !isManualCandidateSnapshot(candidate))
    .map((candidate) => candidate.item_id))];
  if (!ids.length) return {};
  if (ids.length > AUTOMATIC_NEWS_REVIEW_CANDIDATE_LIMIT) {
    throw new Error('automatic_candidate_limit_exceeded');
  }
  const rows = await env.DB.prepare(
    `/* news_review:automatic_event_identity_sidecar */ SELECT id, extra
     FROM items WHERE id IN (${ids.map(() => '?').join(',')})`,
  ).bind(...ids).all<{ id: string; extra: string | null }>();
  const sidecar: Record<string, string> = {};
  for (const row of rows.results || []) {
    const fingerprint = parseObject(row.extra).event_fingerprint;
    const identity = await deriveAutomaticManualEventIdentityV1(fingerprint);
    if (identity) sidecar[row.id] = identity.event_key;
  }
  return sidecar;
}

export async function sanitizeCurrentNewsReviewBatch(
  env: Env,
  date: string,
  now = Date.now(),
): Promise<{
  batch: NewsReviewBatch;
  changed: boolean;
  dropped_ids: string[];
  manual_verifications: Array<{ lead_id: string; verification: PersistedManualVerificationRow }>;
}> {
  return sanitizeCurrentNewsReviewBatchAttempt(env, date, now, 0);
}

export async function getVerifiedNewsReviewSelectionSnapshot(
  env: Env,
  date: string,
  now = Date.now(),
): Promise<VerifiedNewsReviewSelectionSnapshot | null> {
  let sanitized: Awaited<ReturnType<typeof sanitizeCurrentNewsReviewBatch>>;
  try {
    sanitized = await sanitizeCurrentNewsReviewBatch(env, date, now);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'news_review_batch_not_found'
      || /(?:no such table|no such column):?\s*[\w.]+/i.test(message)) return null;
    throw error;
  }
  const selectedIds = await getPublishedNewsReviewSelection(env, date, sanitized.batch);
  const candidateIds = new Set(sanitized.batch.candidate_ids);
  if (selectedIds.some((id) => !candidateIds.has(id))) {
    throw new Error('news_review_verified_selection_invalid');
  }
  if (!selectedIds.length) {
    return {
      batch_id: sanitized.batch.batch_id,
      batch_revision: sanitized.batch.batch_revision,
      selection_hash: await newsReviewSelectionHash([]),
      selected_ids: [],
      manual_verifications: [],
    };
  }
  const verificationByLead = new Map(sanitized.manual_verifications.map((entry) => [entry.lead_id, entry.verification]));
  const manualVerifications: VerifiedNewsReviewManualProofRef[] = [];
  for (const itemId of selectedIds) {
    if (!itemId.startsWith('blog:manual:')) continue;
    const leadId = itemId.slice('blog:manual:'.length);
    const verification = verificationByLead.get(leadId);
    if (!verification) throw new Error('news_review_manual_verification_missing');
    manualVerifications.push({
      item_id: itemId,
      lead_id: leadId,
      verification_id: verification.verification_id,
      creation_nonce: verification.creation_nonce,
      canonical_digest: verification.canonical_digest,
    });
  }

  const finalAuthorization = await authorizeNewsReviewBatchSnapshot(
    env, date, sanitized.batch, selectedIds, 'verified_selection_final_guard',
  );
  if (stableJson(finalAuthorization.allowed_ids) !== stableJson(selectedIds)) {
    throw new Error('news_review_verified_selection_stale');
  }
  return {
    batch_id: sanitized.batch.batch_id,
    batch_revision: sanitized.batch.batch_revision,
    selection_hash: await newsReviewSelectionHash(selectedIds),
    selected_ids: [...selectedIds],
    manual_verifications: manualVerifications,
  };
}

async function sanitizeCurrentNewsReviewBatchAttempt(
  env: Env,
  date: string,
  now: number,
  attempt: number,
  initialBatchId?: string,
  accumulatedDroppedIds: string[] = [],
): ReturnType<typeof sanitizeCurrentNewsReviewBatch> {
  const current = await getActiveNewsReviewBatch(env, date);
  if (!current) throw new Error('news_review_batch_not_found');
  const initialId = initialBatchId || current.batch_id;
  const candidates: NewsReviewCandidate[] = [];
  const droppedIds = [...accumulatedDroppedIds];
  const manualVerifications: Array<{ lead_id: string; verification: PersistedManualVerificationRow }> = [];
  const scheduledPolicy = await readScheduledNewsItemPolicy(
    env,
    date,
    current.candidates
      .filter((candidate) => !isManualCandidateSnapshot(candidate))
      .map((candidate) => candidate.item_id),
  );
  for (const candidate of current.candidates) {
    if (!isManualCandidateSnapshot(candidate)) {
      // Keep the id-only guard for snapshots whose backing row has disappeared,
      // and use the batch-read shared SQL predicate whenever durable identity exists.
      if (scheduledPolicy.get(candidate.item_id) !== true) {
        droppedIds.push(candidate.item_id);
      } else {
        candidates.push(candidate);
      }
      continue;
    }
    const leadId = manualCandidateLeadId(candidate);
    const snapshot = leadId
      ? await confirmedManualCandidateById(env, leadId)
      : null;
    if (!snapshot) {
      droppedIds.push(candidate.item_id);
      continue;
    }
    const refreshed = snapshot.candidate;
    if (refreshed.item_id !== candidate.item_id) droppedIds.push(candidate.item_id);
    candidates.push(refreshed);
    manualVerifications.push({ lead_id: snapshot.lead_id, verification: snapshot.verification });
  }
  const candidateIds = candidates.map((candidate) => candidate.item_id);
  const available = new Set(candidateIds);
  const defaultSelected = current.default_selected_ids.filter((id) => available.has(id));
  const publishedBefore = await getPublishedNewsReviewSelection(env, date, current);
  const publishedAfter = publishedBefore.filter((id) => available.has(id));
  const publishedChanged = stableJson(publishedAfter) !== stableJson(publishedBefore)
    || publishedAfter.some((id) => {
      const before = current.candidates.find((candidate) => candidate.item_id === id);
      const after = candidates.find((candidate) => candidate.item_id === id);
      return stableJson(before) !== stableJson(after);
    });
  const appliedSelected = current.applied_selected_ids !== null || publishedChanged
    ? publishedAfter
    : null;
  const drifted = stableJson(candidates) !== stableJson(current.candidates)
    || stableJson(defaultSelected) !== stableJson(current.default_selected_ids)
    || stableJson(appliedSelected) !== stableJson(current.applied_selected_ids);
  if (!drifted) return {
    batch: current,
    changed: current.batch_id !== initialId,
    dropped_ids: [...new Set(droppedIds)],
    manual_verifications: manualVerifications,
  };

  const batchRevision = current.batch_revision + 1;
  const hash = await sha256Hex(stableJson({
    date, candidates, sanitized_from: current.batch_id, batch_revision: batchRevision,
  }));
  const batchId = `nr-${date.replace(/-/g, '')}-${hash.slice(0, 12)}`;
  const selectionHash = appliedSelected ? await newsReviewSelectionHash(appliedSelected) : null;
  const editRevision = publishedChanged ? current.edit_revision + 1 : current.edit_revision;
  const publishStatus = publishedChanged ? 'pending' : current.publish_status;
  const verificationGuard = manualVerifications.length
    ? manualVerifications.map(() => MANUAL_VERIFICATION_SNAPSHOT_GUARD_SQL).join(' AND ')
    : '1 = 1';
  const verificationBindings = manualVerifications.flatMap((snapshot) =>
    manualVerificationSnapshotGuardBindings(snapshot.lead_id, snapshot.verification));
  const sanitizeWriteAuthorization = await authorizeFormalNewsSet(
    env, date, candidateIds, 'review_sanitize_write_guard',
  );
  if (stableJson(sanitizeWriteAuthorization.allowed_ids) !== stableJson(candidateIds)) {
    if (attempt >= 2) throw new Error('news_review_formal_authorization_stale');
    return sanitizeCurrentNewsReviewBatchAttempt(
      env, date, now, attempt + 1, initialId, [...new Set(droppedIds)],
    );
  }
  const formalWriteGuard = formalNewsFinalGuardSqlPredicate();
  const statements = [
    env.DB.prepare(
      `/* news_review:sanitize_insert_cas */ INSERT INTO daily_news_review_batches (
         review_date, batch_id, candidate_ids, candidates_json, default_selected_ids,
         applied_selected_ids, selection_hash, edit_revision, publish_status,
         publish_error, published_at, notified_at, notification_hash,
         auto_repaired_from_batch, auto_repaired_invalid_ids, superseded_by,
         created_at, expires_at, batch_revision, supersedes_batch_id, revision_origin,
         lineage_id, is_current, candidate_generation, human_reviewed
       ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL,
         ?, ?, ?, ?, ?, ?, 0, ?, ?
       WHERE EXISTS (SELECT 1 FROM daily_news_review_batches
         WHERE review_date = ? AND lineage_id = ? AND batch_id = ?
           AND batch_revision = ? AND is_current = 1 AND edit_revision=?
           AND candidate_generation=? AND candidate_ids=? AND default_selected_ids=?
           AND COALESCE(applied_selected_ids,'')=? AND COALESCE(selection_hash,'')=?)
       AND ${verificationGuard} AND ${formalWriteGuard}
       ON CONFLICT(review_date, batch_id) DO NOTHING`,
    ).bind(
      date, batchId, JSON.stringify(candidateIds), JSON.stringify(candidates), JSON.stringify(defaultSelected),
      appliedSelected === null ? null : JSON.stringify(appliedSelected), selectionHash, editRevision, publishStatus,
      publishedChanged ? null : current.publish_error, publishedChanged ? null : current.published_at,
      current.batch_id, JSON.stringify(droppedIds), now, current.expires_at, batchRevision,
      current.batch_id, current.revision_origin, date, current.candidate_generation,
      current.human_reviewed ? 1 : 0,
      date, date, current.batch_id, current.batch_revision, current.edit_revision,
      current.candidate_generation, JSON.stringify(current.candidate_ids),
      JSON.stringify(current.default_selected_ids),
      current.applied_selected_ids === null ? '' : JSON.stringify(current.applied_selected_ids),
      current.selection_hash || '',
      ...verificationBindings,
      ...formalNewsFinalGuardBindings(sanitizeWriteAuthorization),
    ),
    env.DB.prepare(
      `/* news_review:sanitize_supersede_cas */ UPDATE daily_news_review_batches
       SET superseded_by = ?, is_current = 0
       WHERE review_date = ? AND lineage_id = ? AND batch_id = ?
         AND batch_revision = ? AND is_current = 1
         AND EXISTS (SELECT 1 FROM daily_news_review_batches
           WHERE review_date = ? AND batch_id = ? AND is_current = 0)`,
    ).bind(batchId, date, date, current.batch_id, current.batch_revision, date, batchId),
    env.DB.prepare(
      `/* news_review:sanitize_activate_cas */ UPDATE daily_news_review_batches SET is_current = 1
       WHERE review_date = ? AND lineage_id = ? AND batch_id = ? AND is_current = 0
         AND EXISTS (SELECT 1 FROM daily_news_review_batches
           WHERE review_date = ? AND batch_id = ? AND superseded_by = ?)`,
    ).bind(date, date, batchId, date, current.batch_id, batchId),
  ];
  await env.DB.batch(statements);
  const active = await getActiveNewsReviewBatch(env, date);
  if (!active) throw new Error('news_review_batch_cas_failed');
  if (active.batch_id !== batchId) {
    if (attempt >= 2) throw new Error('news_review_manual_verification_conflict');
    return sanitizeCurrentNewsReviewBatchAttempt(
      env, date, now, attempt + 1, initialId, [...new Set(droppedIds)],
    );
  }
  return {
    batch: active,
    changed: true,
    dropped_ids: [...new Set(droppedIds)],
    manual_verifications: manualVerifications,
  };
}

async function durableConfirmedManualCandidates(env: Env, date: string): Promise<NewsReviewCandidate[]> {
  const confirmed = await env.DB.prepare(
    `/* news_review:confirmed_manual_candidates */ SELECT l.id, l.input_url
     FROM manual_news_leads l
     WHERE l.review_date = ? AND l.confirmed_at IS NOT NULL
       AND l.status IN ('recommended', 'needs_review')
     ORDER BY COALESCE((
       SELECT MIN(audit.id) FROM manual_news_lead_audit audit
       WHERE audit.lead_id = l.id AND (
         (EXISTS (SELECT 1 FROM manual_news_assessment_verifications verification
           WHERE verification.lead_id = l.id AND verification.status = 'active'
             AND verification.policy_version = ?)
          AND audit.action = 'submit'
          AND json_extract(audit.metadata_json, '$.candidate_authorization') = ?)
         OR
         (NOT EXISTS (SELECT 1 FROM manual_news_assessment_verifications verification
           WHERE verification.lead_id = l.id AND verification.status = 'active'
             AND verification.policy_version = ?)
          AND audit.action = 'confirm_candidate')
       )
     ), 9223372036854775807) ASC, l.confirmed_at ASC, l.id ASC`,
  ).bind(
    date,
    MANUAL_NEWS_SOURCE_SUPPORT_POLICY, MANUAL_NEWS_SOURCE_SUPPORT_POLICY,
    MANUAL_NEWS_SOURCE_SUPPORT_POLICY,
  ).all<ConfirmedManualCandidateRow>();
  const candidates: NewsReviewCandidate[] = [];
  for (const row of confirmed.results || []) {
    const candidate = await verifiedManualCandidate(env, row);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

async function preserveConfirmedManualCandidates(
  env: Env,
  date: string,
  submittedCandidates: readonly NewsReviewCandidate[],
  submittedDefaultIds: readonly string[],
  previous: NewsReviewBatch | null,
): Promise<{ candidates: NewsReviewCandidate[]; default_selected_ids: string[] }> {
  // Batch JSON and caller-supplied candidates are snapshots, not authority for
  // manual leads. Rebuild every manual candidate from its currently active,
  // HMAC-verified assessment so key rotation or content tampering removes it.
  const manualByLead = new Map<string, NewsReviewCandidate>();
  for (const candidate of await durableConfirmedManualCandidates(env, date)) {
    if (!candidate.lead_id) continue;
    manualByLead.set(candidate.lead_id, candidate);
  }
  const manuals: NewsReviewCandidate[] = [];
  const manualByIdentity = new Map<string, NewsReviewCandidate>();
  for (const candidate of manualByLead.values()) {
    const identity = candidate.event_key || candidate.item_id;
    const collision = manualByIdentity.get(identity);
    if (collision && collision.lead_id !== candidate.lead_id) {
      throw new Error('confirmed_manual_candidate_event_collision');
    }
    if (!collision) {
      manualByIdentity.set(identity, candidate);
      manuals.push(candidate);
    }
  }
  if (manuals.length > MANUAL_NEWS_REVIEW_CANDIDATE_LIMIT) throw new Error('manual_candidate_limit_exceeded');
  const automaticEventIdentities = manuals.length
    ? await loadAutomaticNewsReviewEventIdentitySidecar(
      env, [...(previous?.candidates || []), ...submittedCandidates],
    )
    : {};
  const automaticIdentity = (candidate: NewsReviewCandidate) =>
    candidate.event_key || automaticEventIdentities[candidate.item_id] || candidate.item_id;

  const availableById = new Map<string, NewsReviewCandidate>();
  for (const candidate of [...(previous?.candidates || []), ...submittedCandidates]) {
    availableById.set(candidate.item_id, candidate);
  }
  const publishedIds = previous ? await getPublishedNewsReviewSelection(env, date, previous) : [];
  const protectedScheduled: NewsReviewCandidate[] = [];
  const seenItemIds = new Set<string>();
  const seenEventKeys = new Set<string>();
  for (const publishedId of publishedIds) {
    const candidate = availableById.get(publishedId);
    if (!candidate || isManualCandidateSnapshot(candidate)) continue;
    const eventKey = automaticIdentity(candidate);
    if (seenItemIds.has(candidate.item_id) || seenEventKeys.has(eventKey)) continue;
    seenItemIds.add(candidate.item_id);
    seenEventKeys.add(eventKey);
    protectedScheduled.push(candidate);
  }
  if (protectedScheduled.length > AUTOMATIC_NEWS_REVIEW_CANDIDATE_LIMIT) {
    throw new Error('automatic_candidate_limit_exceeded');
  }

  const unselectedScheduled: NewsReviewCandidate[] = [];
  for (const candidate of submittedCandidates) {
    if (isManualCandidateSnapshot(candidate)) continue;
    const eventKey = automaticIdentity(candidate);
    if (manuals.some((item) => item.item_id === candidate.item_id)) {
      continue;
    }
    if (seenItemIds.has(candidate.item_id) || seenEventKeys.has(eventKey)) continue;
    seenItemIds.add(candidate.item_id);
    seenEventKeys.add(eventKey);
    unselectedScheduled.push(candidate);
  }
  const scheduledCapacity = AUTOMATIC_NEWS_REVIEW_CANDIDATE_LIMIT;
  const scheduled = [
    ...protectedScheduled,
    ...unselectedScheduled.slice(0, Math.max(0, scheduledCapacity - protectedScheduled.length)),
  ];
  const merged = mergeAuthorizedManualNewsCandidates({
    previous_candidates: scheduled,
    previous_default_selected_ids: submittedDefaultIds,
    published_selected_ids: [],
    automatic_event_identities: automaticEventIdentities,
    manual_candidates: manuals.map((candidate, index) => ({
      authorization_order: index + 1,
      candidate,
    })),
  });
  return { candidates: merged.candidates, default_selected_ids: merged.default_selected_ids };
}

export async function freezeNewsReviewBatchFromPool(
  env: Env,
  date: string,
  now = Date.now(),
): Promise<FreezeNewsReviewBatchResult> {
  // Snapshot before any pool/manual candidate reads. The final insert is
  // conditioned on this exact generation, so a concurrent pre-freeze confirm
  // forces a complete recollection instead of publishing stale candidates.
  const candidateGeneration = await readNewsReviewCandidateGeneration(env, date, now);
  const pool = await env.DB.prepare(
    `SELECT item_ids, items_meta FROM digest_pool
     WHERE slot_key = ? AND source = 'news' AND density = 'normal'`,
  ).bind(`${date}-08`).first<{ item_ids: string; items_meta: string | null }>();
  if (!pool) throw new Error('news_review_pool_missing');
  const defaultIds = parseStringArray(pool.item_ids);
  const meta = parseObject(pool.items_meta);
  const candidateIdsRaw = Array.isArray(meta.candidate_ids_after_exact_dedup)
    ? meta.candidate_ids_after_exact_dedup.filter((id): id is string => typeof id === 'string')
    : defaultIds;
  const candidateIds = [...new Set(candidateIdsRaw)].slice(0, 10);
  if (candidateIds.length < 5 || defaultIds.length < 5) throw new Error('news_review_pool_has_fewer_than_five');

  const auditRows = Array.isArray(meta.candidates)
    ? meta.candidates as NewsReviewPoolMetaCandidate[]
    : [];
  const auditById = new Map(auditRows.map((candidate) => [String(candidate.id || ''), candidate]));
  const placeholders = candidateIds.map(() => '?').join(',');
  const itemResult = await env.DB.prepare(
    `SELECT id, source_id, source_ref, title, content, content_translated, url, extra
     FROM items WHERE id IN (${placeholders})`,
  ).bind(...candidateIds).all<NewsReviewItemRow>();
  const itemById = new Map((itemResult.results || []).map((row) => [row.id, row]));
  const rawScheduledCandidateIds = candidateIds.filter((itemId) =>
    !itemId.startsWith('blog:manual:') && itemById.get(itemId)?.source_ref !== 'manual_lead');
  const scheduledAuthorization = await authorizeFormalNewsSet(
    env, date, rawScheduledCandidateIds, 'review_freeze_from_pool',
  );
  const scheduledAllowed = new Set(scheduledAuthorization.allowed_ids);
  const scheduledCandidateIds = rawScheduledCandidateIds.filter((itemId) => scheduledAllowed.has(itemId));
  let candidates: NewsReviewCandidate[] = scheduledCandidateIds.map((itemId) => {
    const item = itemById.get(itemId);
    const audit = auditById.get(itemId);
    const extra = parseObject(item?.extra || null);
    const title = compactReviewText(
      extra.title_zh || audit?.title_zh || item?.title || audit?.title || itemId,
      80,
    );
    const summary = compactReviewText(
      extra.ai_summary_zh || extra.summary_zh || item?.content_translated || item?.content || '',
      180,
    );
    return {
      item_id: itemId,
      title,
      summary,
      source: compactReviewText(audit?.source_company || extra.source_company || '', 40),
      score: typeof audit?.adjusted_score === 'number' ? audit.adjusted_score : null,
      ...(item?.url ? { url: item.url } : {}),
    };
  });
  let freezeDefaults = defaultIds.filter((itemId) => scheduledCandidateIds.includes(itemId)).slice(0, 5);
  const confirmed = await env.DB.prepare(
    `/* news_review:prefreeze_confirmed_manual */ SELECT l.id, l.input_url
     FROM manual_news_leads l
     WHERE l.review_date = ? AND l.confirmed_at IS NOT NULL AND l.confirmed_batch_id IS NULL
       AND l.status IN ('recommended', 'needs_review')
     ORDER BY COALESCE((
       SELECT MIN(audit.id) FROM manual_news_lead_audit audit
       WHERE audit.lead_id = l.id AND (
         (EXISTS (SELECT 1 FROM manual_news_assessment_verifications verification
           WHERE verification.lead_id = l.id AND verification.status = 'active'
             AND verification.policy_version = ?)
          AND audit.action = 'submit'
          AND json_extract(audit.metadata_json, '$.candidate_authorization') = ?)
         OR
         (NOT EXISTS (SELECT 1 FROM manual_news_assessment_verifications verification
           WHERE verification.lead_id = l.id AND verification.status = 'active'
             AND verification.policy_version = ?)
          AND audit.action = 'confirm_candidate')
       )
     ), 9223372036854775807) ASC, l.confirmed_at ASC, l.id ASC`,
  ).bind(
    date,
    MANUAL_NEWS_SOURCE_SUPPORT_POLICY, MANUAL_NEWS_SOURCE_SUPPORT_POLICY,
    MANUAL_NEWS_SOURCE_SUPPORT_POLICY,
  ).all<ConfirmedManualCandidateRow>();
  for (const row of confirmed.results || []) {
    const candidate = await verifiedManualCandidate(env, row);
    if (!candidate) continue;
    const merged = mergeManualLeadCandidate({
      previous_candidates: candidates,
      previous_default_selected_ids: freezeDefaults,
      published_selected_ids: freezeDefaults,
      candidate,
      max_candidates: TOTAL_NEWS_REVIEW_CANDIDATE_LIMIT,
    });
    candidates = merged.candidates;
    freezeDefaults = merged.default_selected_ids;
  }
  const frozen = await freezeNewsReviewBatchAtGeneration(
    env, date, candidates, freezeDefaults, now, candidateGeneration, 0,
  );
  const includedLeadIds = [...new Set(frozen.batch.candidates
    .filter((candidate) => candidate.origin === 'manual_lead' && candidate.lead_id)
    .map((candidate) => candidate.lead_id!))];
  if (includedLeadIds.length) {
    await env.DB.batch(includedLeadIds.map((leadId) => env.DB.prepare(
      `UPDATE manual_news_leads SET confirmed_batch_id = ?, updated_at = ?
       WHERE id = ? AND confirmed_batch_id IS NULL`,
    ).bind(frozen.batch.batch_id, now, leadId)));
  }
  return frozen;
}

export function buildNewsReviewNotification(
  date: string,
  batchId: string,
  token: string,
  candidates: readonly NewsReviewCandidate[],
): { title: string; body: string; review_url: string } {
  const reviewUrl = new URL('https://ai-feeds.cc/aifeeds/latest/');
  reviewUrl.searchParams.set('review_date', date);
  reviewUrl.searchParams.set('review_batch', batchId);
  reviewUrl.searchParams.set('review_token', token);
  reviewUrl.hash = 'news-review';
  const lines = candidates.map((candidate, index) => {
    const meta = [candidate.source, candidate.score === null ? '' : `${Number(candidate.score.toFixed(2))}分`]
      .filter(Boolean)
      .join(' · ');
    return `${index + 1}. ${candidate.title}\n${meta ? `${meta}\n` : ''}${candidate.summary}`;
  });
  return {
    title: `AI Feeds ${date.slice(5)} 行业要闻候选`,
    body: [
      '默认前 5 条已进入生产。可在今天 23:59 前从下列候选中选择 5 条并调整顺序：',
      '',
      ...lines.flatMap((line) => [line, '']),
      `[打开今日轻量审核页](${reviewUrl.toString()})`,
    ].join('\n').trim(),
    review_url: reviewUrl.toString(),
  };
}

export async function notifyNewsReviewBatch(
  env: Env,
  batch: NewsReviewBatch,
): Promise<{ notified: boolean; review_url: string }> {
  const token = await createNewsReviewToken(newsReviewSecret(env), batch.review_date, batch.batch_id);
  const message = buildNewsReviewNotification(batch.review_date, batch.batch_id, token, batch.candidates);
  if (batch.auto_repaired_invalid_ids.length) {
    message.body = [
      `⚠️ 已发现当前生产选择中的失效/事实阻断条目：${batch.auto_repaired_invalid_ids.join('、')}`,
      '系统已按新排名自动剔除并补足五条；请打开审核页确认新的选择与顺序。',
      '',
      message.body,
    ].join('\n');
  }
  if (batch.notified_at && batch.notification_hash === batch.batch_id) {
    return { notified: false, review_url: message.review_url };
  }
  const sent = await pushDeerMessage(env, message.title, message.body);
  if (sent.succeeded === 0) throw new Error('news_review_pushdeer_delivery_failed');
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE daily_news_review_batches SET notified_at = ?, notification_hash = ?
     WHERE review_date = ? AND batch_id = ? AND notified_at IS NULL`,
  ).bind(now, batch.batch_id, batch.review_date, batch.batch_id).run();
  return { notified: true, review_url: message.review_url };
}

// Env is intentionally referenced here so the persistence/API implementation can
// remain in this domain module without leaking the shared secret into callers.
export function newsReviewSecret(env: Env): string {
  return env.DAILY_NEWS_REVIEW_SECRET || '';
}
