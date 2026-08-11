import type { Env } from '../index';
import { pushDeerMessage } from '../notifier';
import { mergeManualLeadCandidate } from './manual-news-leads';

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

export async function getAppliedNewsReviewSelection(env: Env, date: string): Promise<string[] | null> {
  try {
    const row = await env.DB.prepare(
      `SELECT applied_selected_ids FROM daily_news_review_batches
       WHERE review_date = ? AND applied_selected_ids IS NOT NULL
       ORDER BY created_at DESC, edit_revision DESC LIMIT 1`,
    ).bind(date).first<{ applied_selected_ids: string }>();
    const ids = row ? parseStringArray(row.applied_selected_ids) : [];
    return ids.length >= 1 && ids.length <= 5 ? ids : null;
  } catch (error) {
    // 部署迁移与 Worker 代码存在短暂先后窗口；缺表时回退默认 digest_pool，
    // 不能让邮件、日报页或默认视频因此中断。
    console.warn('[news-review] applied selection unavailable', String(error).slice(0, 160));
    return null;
  }
}

export async function getPublishedNewsReviewSelection(
  env: Env,
  date: string,
  currentBatch: NewsReviewBatch,
): Promise<string[]> {
  const applied = await getAppliedNewsReviewSelection(env, date);
  if (applied) return applied;
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
       batch_revision, supersedes_batch_id, revision_origin, lineage_id, is_current
     ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled_freeze', ?, ?
     WHERE ${previous
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
  if (!active) throw new Error('news_review_batch_cas_failed');
  return {
    batch: active,
    created: active.batch_id === batchId && !existing,
    superseded_batch_id: active.batch_id === batchId ? previous?.batch_id || null : null,
    auto_repaired: active.batch_id === batchId && repair.required,
    auto_repaired_invalid_ids: active.batch_id === batchId ? repair.invalid_ids : active.auto_repaired_invalid_ids,
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
  if (batch.superseded_by) return { ok: false, status: 409, error: 'review_batch_superseded', batch };
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
  await env.DB.prepare(
    `UPDATE daily_news_review_batches SET
       applied_selected_ids = ?, selection_hash = ?, edit_revision = edit_revision + 1,
       publish_status = 'pending', publish_error = NULL, published_at = NULL
     WHERE review_date = ? AND batch_id = ? AND superseded_by IS NULL`,
  ).bind(JSON.stringify(selectedIds), hash, input.date, input.batch_id).run();
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
  title: string | null;
  content: string | null;
  content_translated: string | null;
  url: string | null;
  extra: string | null;
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
  assessment_json: string;
  publisher: string | null;
  evidence_url: string | null;
}

async function durableConfirmedManualCandidates(env: Env, date: string): Promise<NewsReviewCandidate[]> {
  const confirmed = await env.DB.prepare(
    `/* news_review:confirmed_manual_candidates */ SELECT l.id, l.input_url, a.assessment_json,
       (SELECT e.publisher FROM manual_news_evidence e
        WHERE e.lead_id = l.id AND e.reliable = 1 ORDER BY e.evidence_id LIMIT 1) AS publisher,
       (SELECT e.url FROM manual_news_evidence e
        WHERE e.lead_id = l.id AND e.reliable = 1 ORDER BY e.evidence_id LIMIT 1) AS evidence_url
     FROM manual_news_leads l
     JOIN manual_news_event_assessments a ON a.lead_id = l.id
       AND a.assessment_version = (
         SELECT MAX(a2.assessment_version) FROM manual_news_event_assessments a2 WHERE a2.lead_id = l.id
       )
     WHERE l.review_date = ? AND l.confirmed_at IS NOT NULL
       AND l.status IN ('recommended', 'needs_review')
     ORDER BY l.confirmed_at ASC, l.id ASC`,
  ).bind(date).all<ConfirmedManualCandidateRow>();
  const candidates: NewsReviewCandidate[] = [];
  for (const row of confirmed.results || []) {
    const assessment = parseObject(row.assessment_json);
    const title = compactReviewText(assessment.title, 80);
    const summary = compactReviewText(assessment.summary, 180);
    const eventKey = compactReviewText(assessment.event_key, 200);
    const score = Number(assessment.score);
    if (!title || !summary || !eventKey || !Number.isFinite(score)) continue;
    const url = row.evidence_url || row.input_url;
    candidates.push({
      item_id: `blog:manual:${row.id}`,
      title,
      summary,
      source: compactReviewText(row.publisher || '手工补录', 40),
      score,
      ...(url ? { url } : {}),
      event_key: eventKey,
      origin: 'manual_lead',
      lead_id: row.id,
    });
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
  const manualByLead = new Map<string, NewsReviewCandidate>();
  for (const candidate of [
    ...(previous?.candidates || []),
    ...submittedCandidates,
    ...await durableConfirmedManualCandidates(env, date),
  ]) {
    if (candidate.origin !== 'manual_lead' || !candidate.lead_id) continue;
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
  if (manuals.length > 10) throw new Error('confirmed_manual_candidates_exceed_cap');

  const defaultAliases = new Map<string, string>();
  const nonManual: NewsReviewCandidate[] = [];
  const seenItemIds = new Set<string>();
  const seenEventKeys = new Set<string>();
  for (const candidate of submittedCandidates) {
    if (candidate.origin === 'manual_lead') continue;
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
    nonManual.push(candidate);
  }
  const candidates = [...nonManual.slice(0, 10 - manuals.length), ...manuals];
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
    `SELECT id, title, content, content_translated, url, extra FROM items WHERE id IN (${placeholders})`,
  ).bind(...candidateIds).all<NewsReviewItemRow>();
  const itemById = new Map((itemResult.results || []).map((row) => [row.id, row]));
  let candidates: NewsReviewCandidate[] = candidateIds.map((itemId) => {
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
  let freezeDefaults = defaultIds.slice(0, 5);
  const confirmed = await env.DB.prepare(
    `SELECT l.id, l.input_url, a.assessment_json,
       (SELECT e.publisher FROM manual_news_evidence e WHERE e.lead_id = l.id AND e.reliable = 1 ORDER BY e.evidence_id LIMIT 1) AS publisher
     FROM manual_news_leads l
     JOIN manual_news_event_assessments a ON a.lead_id = l.id
       AND a.assessment_version = (
         SELECT MAX(a2.assessment_version) FROM manual_news_event_assessments a2 WHERE a2.lead_id = l.id
       )
     WHERE l.review_date = ? AND l.confirmed_at IS NOT NULL AND l.confirmed_batch_id IS NULL
       AND l.status IN ('recommended', 'needs_review')
     ORDER BY l.confirmed_at ASC`,
  ).bind(date).all<{ id: string; input_url: string; assessment_json: string; publisher: string | null }>();
  const includedLeadIds: string[] = [];
  for (const row of confirmed.results || []) {
    const assessment = parseObject(row.assessment_json);
    const title = compactReviewText(assessment.title, 80);
    const summary = compactReviewText(assessment.summary, 180);
    const eventKey = compactReviewText(assessment.event_key, 200);
    const score = Number(assessment.score);
    if (!title || !summary || !eventKey || !Number.isFinite(score)) continue;
    const merged = mergeManualLeadCandidate({
      previous_candidates: candidates,
      previous_default_selected_ids: freezeDefaults,
      published_selected_ids: freezeDefaults,
      candidate: {
        item_id: `blog:manual:${row.id}`,
        title,
        summary,
        source: compactReviewText(row.publisher || '手工补录', 40),
        score,
        ...(row.input_url ? { url: row.input_url } : {}),
        event_key: eventKey,
        origin: 'manual_lead',
        lead_id: row.id,
      },
      max_candidates: 10,
    });
    candidates = merged.candidates;
    freezeDefaults = merged.default_selected_ids;
    includedLeadIds.push(row.id);
  }
  const frozen = await freezeNewsReviewBatch(env, date, candidates, freezeDefaults, now);
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
