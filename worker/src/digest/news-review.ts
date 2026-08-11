import type { Env } from '../index';
import { pushDeerMessage } from '../notifier';
import { mergeManualLeadCandidate } from './manual-news-leads';
import {
  loadVerifiedManualAssessment,
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
  batch_revision: number;
  supersedes_batch_id: string | null;
  revision_origin: 'scheduled_freeze' | 'manual_lead';
  lineage_id: string;
  is_current: boolean;
  candidate_generation: number;
  created_at: number;
  expires_at: number;
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
): Promise<string> {
  assertReviewDate(date);
  const hash = await sha256Hex(stableJson({ date, candidates }));
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
  try {
    const active = await getActiveNewsReviewBatch(env, date);
    if (active?.candidates.some(isManualCandidateSnapshot)) {
      await sanitizeCurrentNewsReviewBatch(env, date);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isRolloutSchemaGap = /(?:no such table|no such column):?\s*[\w.]+/i.test(message);
    if (message !== 'news_review_batch_not_found' && !isRolloutSchemaGap) throw error;
  }
  return readAppliedNewsReviewSelection(env, date);
}

export async function getPublishedNewsReviewSelection(
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
  if (candidates.length < 5 || candidates.length > 10) throw new Error('review_candidates_must_be_five_to_ten');
  const submittedCandidateIds = candidates.map((candidate) => candidate.item_id);
  if (new Set(submittedCandidateIds).size !== submittedCandidateIds.length) throw new Error('review_candidates_must_be_unique');
  const previous = await getActiveNewsReviewBatch(env, date);
  const preserved = await preserveConfirmedManualCandidates(
    env, date, candidates, defaultSelectedIds, previous,
  );
  const effectiveCandidates = preserved.candidates;
  const candidateIds = effectiveCandidates.map((candidate) => candidate.item_id);
  const validatedDefault = validateNewsReviewSelection(preserved.default_selected_ids, candidateIds);
  if (!validatedDefault.ok) throw new Error(`invalid_default_selection:${validatedDefault.error}`);
  const batchId = await buildNewsReviewBatchId(date, effectiveCandidates);
  const existing = await getNewsReviewBatch(env, date, batchId);
  if (existing) {
    const current = existing.is_current ? existing : await getActiveNewsReviewBatch(env, date);
    if (current) return {
      batch: current,
      created: false,
      superseded_batch_id: null,
      auto_repaired: !!current.auto_repaired_from_batch,
      auto_repaired_invalid_ids: current.auto_repaired_invalid_ids,
    };
  }
  const batchRevision = (previous?.batch_revision || 0) + 1;
  const previousPublishedIds = previous
    ? await getPublishedNewsReviewSelection(env, date, previous)
    : [];
  const repair = previous
    ? repairInvalidNewsReviewSelection(previousPublishedIds, candidateIds)
    : { required: false, invalid_ids: [], selected_ids: [] };
  const selectionHash = repair.required ? await newsReviewSelectionHash(repair.selected_ids) : null;
  const insert = env.DB.prepare(
    `/* news_review:insert_revision_cas */ INSERT INTO daily_news_review_batches (
       review_date, batch_id, candidate_ids, candidates_json, default_selected_ids,
       applied_selected_ids, selection_hash, edit_revision, publish_status,
       auto_repaired_from_batch, auto_repaired_invalid_ids, created_at, expires_at,
       batch_revision, supersedes_batch_id, revision_origin, lineage_id, is_current,
       candidate_generation
     ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled_freeze', ?, ?, ?
     WHERE EXISTS (SELECT 1 FROM daily_news_review_candidate_generations
       WHERE review_date = ? AND lineage_id = ? AND generation = ?)
     AND ${previous
       ? `EXISTS (SELECT 1 FROM daily_news_review_batches
            WHERE review_date = ? AND lineage_id = ? AND batch_id = ? AND batch_revision = ? AND is_current = 1)`
       : `NOT EXISTS (SELECT 1 FROM daily_news_review_batches
            WHERE review_date = ? AND lineage_id = ? AND is_current = 1)`}
     ON CONFLICT(review_date, batch_id) DO NOTHING`,
  ).bind(
    date, batchId, JSON.stringify(candidateIds), JSON.stringify(effectiveCandidates),
    JSON.stringify(validatedDefault.selected_ids), repair.required ? JSON.stringify(repair.selected_ids) : null,
    selectionHash, repair.required ? 1 : 0, repair.required ? 'pending' : 'not_requested',
    repair.required ? previous!.batch_id : null, repair.required ? JSON.stringify(repair.invalid_ids) : null,
    now, newsReviewExpiresAt(date), batchRevision, previous?.batch_id || null, date, previous ? 0 : 1,
    candidateGeneration, date, date, candidateGeneration,
    date, date, ...(previous ? [previous.batch_id, previous.batch_revision] : []),
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
  await env.DB.batch(statements);
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
  const hash = await newsReviewSelectionHash(selectedIds);
  const effectiveIds = batch.applied_selected_ids
    || await getPublishedNewsReviewSelection(env, input.date, batch);
  const effectiveHash = await newsReviewSelectionHash(effectiveIds);
  if (hash === effectiveHash) {
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
  const writeStatement = env.DB.prepare(
    `UPDATE daily_news_review_batches SET
       applied_selected_ids = ?, selection_hash = ?, edit_revision = edit_revision + 1,
       publish_status = 'pending', publish_error = NULL, published_at = NULL
     WHERE review_date = ? AND lineage_id = ? AND batch_id = ?
       AND is_current = 1 AND superseded_by IS NULL AND ${verificationGuard}`,
  ).bind(
    JSON.stringify(selectedIds), hash, input.date, input.date, input.batch_id,
    ...verificationBindings,
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
  source_ref: string | null;
  title: string | null;
  content: string | null;
  content_translated: string | null;
  url: string | null;
  extra: string | null;
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
  const verified = await loadVerifiedManualAssessment(env, row.id);
  if (!verified) return null;
  const primaryEvidence = verified.evidence.find((item) => item.reliable) || verified.evidence[0];
  const { assessment } = verified;
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
  for (const candidate of current.candidates) {
    if (!isManualCandidateSnapshot(candidate)) {
      candidates.push(candidate);
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
  const statements = [
    env.DB.prepare(
      `/* news_review:sanitize_insert_cas */ INSERT INTO daily_news_review_batches (
         review_date, batch_id, candidate_ids, candidates_json, default_selected_ids,
         applied_selected_ids, selection_hash, edit_revision, publish_status,
         publish_error, published_at, notified_at, notification_hash,
         auto_repaired_from_batch, auto_repaired_invalid_ids, superseded_by,
         created_at, expires_at, batch_revision, supersedes_batch_id, revision_origin,
         lineage_id, is_current, candidate_generation
       ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL,
         ?, ?, ?, ?, ?, ?, 0, ?
       WHERE EXISTS (SELECT 1 FROM daily_news_review_batches
         WHERE review_date = ? AND lineage_id = ? AND batch_id = ?
           AND batch_revision = ? AND is_current = 1)
       AND ${verificationGuard}
       ON CONFLICT(review_date, batch_id) DO NOTHING`,
    ).bind(
      date, batchId, JSON.stringify(candidateIds), JSON.stringify(candidates), JSON.stringify(defaultSelected),
      appliedSelected === null ? null : JSON.stringify(appliedSelected), selectionHash, editRevision, publishStatus,
      publishedChanged ? null : current.publish_error, publishedChanged ? null : current.published_at,
      current.batch_id, JSON.stringify(droppedIds), now, current.expires_at, batchRevision,
      current.batch_id, current.revision_origin, date, current.candidate_generation,
      date, date, current.batch_id, current.batch_revision,
      ...verificationBindings,
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
     ORDER BY l.confirmed_at ASC, l.id ASC`,
  ).bind(date).all<ConfirmedManualCandidateRow>();
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
  if (manuals.length > 10) throw new Error('candidate_cap_exhausted');

  const defaultAliases = new Map<string, string>();
  const availableById = new Map<string, NewsReviewCandidate>();
  for (const candidate of [...(previous?.candidates || []), ...submittedCandidates]) {
    availableById.set(candidate.item_id, candidate);
    if (isManualCandidateSnapshot(candidate)) continue;
    const manual = manualByIdentity.get(candidate.event_key || candidate.item_id);
    if (manual) defaultAliases.set(candidate.item_id, manual.item_id);
  }
  const publishedIds = previous ? await getPublishedNewsReviewSelection(env, date, previous) : [];
  const protectedScheduled: NewsReviewCandidate[] = [];
  const seenItemIds = new Set<string>();
  const seenEventKeys = new Set<string>();
  for (const publishedId of publishedIds) {
    const aliasedId = defaultAliases.get(publishedId) || publishedId;
    if (manuals.some((candidate) => candidate.item_id === aliasedId)) continue;
    const candidate = availableById.get(publishedId);
    if (!candidate || isManualCandidateSnapshot(candidate)) continue;
    if (seenItemIds.has(candidate.item_id) || (candidate.event_key && seenEventKeys.has(candidate.event_key))) continue;
    seenItemIds.add(candidate.item_id);
    if (candidate.event_key) seenEventKeys.add(candidate.event_key);
    protectedScheduled.push(candidate);
  }
  if (manuals.length + protectedScheduled.length > 10) throw new Error('candidate_cap_exhausted');

  const unselectedScheduled: NewsReviewCandidate[] = [];
  for (const candidate of submittedCandidates) {
    if (isManualCandidateSnapshot(candidate)) continue;
    const manual = manualByIdentity.get(candidate.event_key || candidate.item_id);
    if (manual) {
      defaultAliases.set(candidate.item_id, manual.item_id);
      continue;
    }
    if (manuals.some((item) => item.item_id === candidate.item_id)) {
      defaultAliases.set(candidate.item_id, candidate.item_id);
      continue;
    }
    if (seenItemIds.has(candidate.item_id) || (candidate.event_key && seenEventKeys.has(candidate.event_key))) continue;
    seenItemIds.add(candidate.item_id);
    if (candidate.event_key) seenEventKeys.add(candidate.event_key);
    unselectedScheduled.push(candidate);
  }
  const scheduledCapacity = 10 - manuals.length;
  const candidates = [
    ...protectedScheduled,
    ...unselectedScheduled.slice(0, scheduledCapacity - protectedScheduled.length),
    ...manuals,
  ];
  const candidateIds = new Set(candidates.map((candidate) => candidate.item_id));
  const defaultSelectedIds = [...new Set(submittedDefaultIds.map((id) => defaultAliases.get(id) || id))]
    .filter((id) => candidateIds.has(id));
  return { candidates, default_selected_ids: defaultSelectedIds };
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
    `SELECT id, source_ref, title, content, content_translated, url, extra
     FROM items WHERE id IN (${placeholders})`,
  ).bind(...candidateIds).all<NewsReviewItemRow>();
  const itemById = new Map((itemResult.results || []).map((row) => [row.id, row]));
  const scheduledCandidateIds = candidateIds.filter((itemId) =>
    !itemId.startsWith('blog:manual:') && itemById.get(itemId)?.source_ref !== 'manual_lead');
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
     ORDER BY l.confirmed_at ASC`,
  ).bind(date).all<ConfirmedManualCandidateRow>();
  for (const row of confirmed.results || []) {
    const candidate = await verifiedManualCandidate(env, row);
    if (!candidate) continue;
    const merged = mergeManualLeadCandidate({
      previous_candidates: candidates,
      previous_default_selected_ids: freezeDefaults,
      published_selected_ids: freezeDefaults,
      candidate,
      max_candidates: 10,
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
