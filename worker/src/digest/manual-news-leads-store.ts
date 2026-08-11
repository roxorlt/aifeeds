import type { Env } from '../index';
import {
  assertManualLeadTransition,
  mergeManualLeadCandidate,
  validateManualNewsLeadInput,
  type ManualNewsEvidence,
  type ManualNewsLeadStatus,
} from './manual-news-leads';
import type {
  ManualLeadProcessingStore,
  ManualNewsLeadRecord,
  ProcessedManualLeadAssessment,
} from './manual-news-leads-pipeline';
import {
  buildNewsReviewBatchId,
  createNewsReviewToken,
  getActiveNewsReviewBatch,
  getNewsReviewBatch,
  getPublishedNewsReviewSelection,
  newsReviewExpiresAt,
  newsReviewSecret,
  type NewsReviewBatch,
} from './news-review';

interface ManualLeadRow {
  id: string;
  review_date: string;
  input_type: ManualNewsLeadRecord['input_type'];
  input_text: string;
  input_url: string;
  note: string;
  status: ManualNewsLeadStatus;
  version: number;
  error_code: string | null;
  error_message: string | null;
  submit_idempotency_key: string;
  last_mutation_kind: string | null;
  last_mutation_idempotency_key: string | null;
  confirmed_batch_id: string | null;
  confirmed_at: number | null;
  created_at: number;
  updated_at: number;
}

interface ManualEvidenceRow {
  evidence_id: string;
  url: string;
  source_type: ManualNewsEvidence['source_type'];
  publisher: string;
  published_at: string | null;
  retrieved_at: number;
  title: string;
  excerpt: string;
  claims_supported_json: string;
  reliable: number;
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  try { return JSON.parse(value || '') as T; } catch { return fallback; }
}

function evidenceFromRow(row: ManualEvidenceRow): ManualNewsEvidence {
  return {
    id: row.evidence_id,
    url: row.url,
    source_type: row.source_type,
    publisher: row.publisher,
    published_at: row.published_at,
    retrieved_at: row.retrieved_at,
    title: row.title,
    excerpt: row.excerpt,
    claims_supported: parseJson<string[]>(row.claims_supported_json, []),
    reliable: row.reliable === 1,
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function leadFromRow(env: Env, row: ManualLeadRow): Promise<ManualNewsLeadRecord> {
  const [evidenceResult, assessmentRow] = await Promise.all([
    env.DB.prepare(
      `/* manual_evidence:list */ SELECT * FROM manual_news_evidence WHERE lead_id = ? ORDER BY evidence_id`,
    ).bind(row.id).all<ManualEvidenceRow>(),
    env.DB.prepare(
      `/* manual_assessment:latest */ SELECT assessment_json FROM manual_news_event_assessments
       WHERE lead_id = ? ORDER BY assessment_version DESC LIMIT 1`,
    ).bind(row.id).first<{ assessment_json: string }>(),
  ]);
  return {
    id: row.id,
    review_date: row.review_date,
    input_type: row.input_type,
    input_text: row.input_text || '',
    input_url: row.input_url || '',
    note: row.note || '',
    status: row.status,
    version: Number(row.version),
    error_code: row.error_code,
    error_message: row.error_message,
    assessment: assessmentRow
      ? parseJson<ProcessedManualLeadAssessment | null>(assessmentRow.assessment_json, null)
      : null,
    evidence: (evidenceResult.results || []).map(evidenceFromRow),
    confirmed_batch_id: row.confirmed_batch_id,
    confirmed_at: row.confirmed_at,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

export async function getManualNewsLead(env: Env, id: string): Promise<ManualNewsLeadRecord | null> {
  const row = await env.DB.prepare(
    `/* manual_lead:by_id */ SELECT * FROM manual_news_leads WHERE id = ?`,
  ).bind(id).first<ManualLeadRow>();
  return row ? leadFromRow(env, row) : null;
}

export async function listManualNewsLeads(env: Env, date: string): Promise<ManualNewsLeadRecord[]> {
  const result = await env.DB.prepare(
    `/* manual_lead:list_date */ SELECT * FROM manual_news_leads
     WHERE review_date = ? ORDER BY created_at DESC LIMIT 50`,
  ).bind(date).all<ManualLeadRow>();
  return Promise.all((result.results || []).map((row) => leadFromRow(env, row)));
}

export async function getManualNewsLeadCandidateState(
  env: Env,
  date: string,
): Promise<{ batch_id: string; revision: number } | null> {
  const active = await getActiveNewsReviewBatch(env, date);
  return active ? { batch_id: active.batch_id, revision: active.batch_revision } : null;
}

export async function submitManualNewsLead(
  env: Env,
  input: { date?: unknown; text?: unknown; url?: unknown; note?: unknown },
  idempotencyKey: string,
  now = Date.now(),
): Promise<{ lead: ManualNewsLeadRecord; created: boolean }> {
  const normalized = validateManualNewsLeadInput(input);
  const existing = await env.DB.prepare(
    `/* manual_lead:by_submit_key */ SELECT * FROM manual_news_leads
     WHERE review_date = ? AND submit_idempotency_key = ?`,
  ).bind(normalized.date, idempotencyKey).first<ManualLeadRow>();
  if (existing) return { lead: await leadFromRow(env, existing), created: false };
  const hash = await sha256Hex(`${normalized.date}\0${idempotencyKey}\0${normalized.text}\0${normalized.url}`);
  const id = `ml-${normalized.date.replace(/-/g, '')}-${hash.slice(0, 12)}`;
  const inserted = await env.DB.prepare(
    `/* manual_lead:insert */ INSERT OR IGNORE INTO manual_news_leads (
       id, review_date, input_type, input_text, input_url, note, status, version,
       submit_idempotency_key, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'submitted', 1, ?, ?, ?)`,
  ).bind(
    id,
    normalized.date,
    normalized.input_type,
    normalized.text,
    normalized.url,
    normalized.note,
    idempotencyKey,
    now,
    now,
  ).run();
  const lead = await getManualNewsLead(env, id);
  if (!lead) throw new Error('manual_news_lead_insert_failed');
  return { lead, created: Number(inserted.meta.changes || 0) > 0 };
}

export type ManualLeadMutationResult =
  | { ok: true; changed: boolean; lead: ManualNewsLeadRecord }
  | { ok: false; status: 404 | 409; error: string; lead?: ManualNewsLeadRecord };

export async function retryManualNewsLead(
  env: Env,
  id: string,
  expectedVersion: number,
  idempotencyKey: string,
  now = Date.now(),
): Promise<ManualLeadMutationResult> {
  const lead = await getManualNewsLead(env, id);
  if (!lead) return { ok: false, status: 404, error: 'manual_news_lead_not_found' };
  const row = await env.DB.prepare(
    `/* manual_lead:by_id */ SELECT * FROM manual_news_leads WHERE id = ?`,
  ).bind(id).first<ManualLeadRow>();
  if (row?.last_mutation_kind === 'retry' && row.last_mutation_idempotency_key === idempotencyKey) {
    return { ok: true, changed: false, lead };
  }
  if (lead.confirmed_at) return { ok: false, status: 409, error: 'lead_already_confirmed', lead };
  if (lead.version !== expectedVersion) return { ok: false, status: 409, error: 'lead_version_conflict', lead };
  if (!['failed', 'needs_review', 'rejected'].includes(lead.status)) {
    return { ok: false, status: 409, error: 'lead_not_retryable', lead };
  }
  assertManualLeadTransition(lead.status, 'validating');
  const result = await env.DB.prepare(
    `/* manual_lead:retry */ UPDATE manual_news_leads SET
       status = 'validating', version = version + 1, error_code = NULL, error_message = NULL,
       last_mutation_kind = 'retry', last_mutation_idempotency_key = ?, updated_at = ?
     WHERE id = ? AND version = ? AND status IN ('failed', 'needs_review', 'rejected')`,
  ).bind(idempotencyKey, now, id, expectedVersion).run();
  if (!result.meta.changes) {
    const conflicted = await getManualNewsLead(env, id);
    return { ok: false, status: 409, error: 'lead_version_conflict', ...(conflicted ? { lead: conflicted } : {}) };
  }
  const updated = await getManualNewsLead(env, id);
  if (!updated) return { ok: false, status: 404, error: 'manual_news_lead_not_found' };
  return { ok: true, changed: true, lead: updated };
}

export class D1ManualLeadProcessingStore implements ManualLeadProcessingStore {
  constructor(private readonly env: Env) {}

  getLead(id: string): Promise<ManualNewsLeadRecord | null> {
    return getManualNewsLead(this.env, id);
  }

  async transition(
    id: string,
    from: ManualNewsLeadStatus,
    to: ManualNewsLeadStatus,
    patch: Partial<Pick<ManualNewsLeadRecord, 'error_code' | 'error_message'>> = {},
  ): Promise<ManualNewsLeadRecord> {
    assertManualLeadTransition(from, to);
    const now = Date.now();
    const result = await this.env.DB.prepare(
      `/* manual_lead:transition */ UPDATE manual_news_leads SET
         status = ?, version = version + 1, error_code = ?, error_message = ?, updated_at = ?
       WHERE id = ? AND status = ?`,
    ).bind(to, patch.error_code ?? null, patch.error_message ?? null, now, id, from).run();
    if (!result.meta.changes) throw new Error('lead_transition_conflict');
    await this.env.DB.prepare(
      `/* manual_audit:transition */ INSERT INTO manual_news_lead_audit
       (lead_id, action, from_status, to_status, metadata_json, created_at)
       VALUES (?, 'status_transition', ?, ?, '{}', ?)`,
    ).bind(id, from, to, now).run();
    const updated = await getManualNewsLead(this.env, id);
    if (!updated) throw new Error('manual_news_lead_not_found');
    return updated;
  }

  async replaceEvidence(id: string, evidence: readonly ManualNewsEvidence[]): Promise<void> {
    const statements = [
      this.env.DB.prepare(`/* manual_evidence:delete */ DELETE FROM manual_news_evidence WHERE lead_id = ?`).bind(id),
      ...evidence.map((item) => this.env.DB.prepare(
        `/* manual_evidence:insert */ INSERT INTO manual_news_evidence (
           lead_id, evidence_id, url, source_type, publisher, published_at, retrieved_at,
           title, excerpt, claims_supported_json, reliable
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id, item.id, item.url, item.source_type, item.publisher, item.published_at, item.retrieved_at,
        item.title, item.excerpt, JSON.stringify(item.claims_supported), item.reliable ? 1 : 0,
      )),
    ];
    await this.env.DB.batch(statements);
  }

  async listRecentPriorEvents(date: string, excludeLeadId: string): Promise<Array<{ event_key: string; review_date: string; lead_id: string }>> {
    const result = await this.env.DB.prepare(
      `/* manual_assessment:recent_prior_events */ SELECT a.event_key, l.review_date, l.id AS lead_id
       FROM manual_news_event_assessments a JOIN manual_news_leads l ON l.id = a.lead_id
       WHERE l.id <> ? AND l.review_date BETWEEN date(?, '-14 days') AND ?
         AND a.assessment_version = (
           SELECT MAX(latest.assessment_version) FROM manual_news_event_assessments latest
           WHERE latest.lead_id = a.lead_id
         )
       UNION ALL
       SELECT json_extract(extra, '$.event_fingerprint'), substr(COALESCE(published_at, scraped_at), 1, 10), id
       FROM items
       WHERE id <> ? AND json_extract(extra, '$.event_fingerprint') IS NOT NULL
         AND substr(COALESCE(published_at, scraped_at), 1, 10) BETWEEN date(?, '-14 days') AND ?`,
    ).bind(excludeLeadId, date, date, `blog:manual:${excludeLeadId}`, date, date)
      .all<{ event_key: string; review_date: string; lead_id: string }>();
    return (result.results || []).filter((item) => !!item.event_key);
  }

  async findPriorEventsByEventKey(eventKey: string, excludeLeadId: string): Promise<Array<{ event_key: string; review_date: string; lead_id: string }>> {
    const result = await this.env.DB.prepare(
      `/* manual_assessment:exact_event_history */ SELECT a.event_key, l.review_date, l.id AS lead_id
       FROM manual_news_event_assessments a JOIN manual_news_leads l ON l.id = a.lead_id
       WHERE a.event_key = ? AND l.id <> ?
         AND a.assessment_version = (
           SELECT MAX(latest.assessment_version) FROM manual_news_event_assessments latest
           WHERE latest.lead_id = a.lead_id
         )
       UNION ALL
       SELECT json_extract(extra, '$.event_fingerprint'), substr(COALESCE(published_at, scraped_at), 1, 10), id
       FROM items
       WHERE json_extract(extra, '$.event_fingerprint') = ? AND id <> ?`,
    ).bind(eventKey, excludeLeadId, eventKey, `blog:manual:${excludeLeadId}`)
      .all<{ event_key: string; review_date: string; lead_id: string }>();
    return (result.results || []).filter((item) => !!item.event_key);
  }

  async saveAssessment(id: string, assessment: ProcessedManualLeadAssessment): Promise<void> {
    const lead = await getManualNewsLead(this.env, id);
    if (!lead) throw new Error('manual_news_lead_not_found');
    await this.env.DB.prepare(
      `/* manual_assessment:insert */ INSERT INTO manual_news_event_assessments (
         lead_id, assessment_version, event_key, event_type, material_update, score,
         recommendation, assessment_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(lead_id, assessment_version) DO UPDATE SET
         event_key = excluded.event_key, event_type = excluded.event_type,
         material_update = excluded.material_update, score = excluded.score,
         recommendation = excluded.recommendation, assessment_json = excluded.assessment_json,
         created_at = excluded.created_at`,
    ).bind(
      id, lead.version, assessment.event_key, assessment.event_type, assessment.material_update ? 1 : 0,
      assessment.score, assessment.recommendation, JSON.stringify(assessment), Date.now(),
    ).run();
  }
}

export async function confirmManualNewsLeadCandidate(
  env: Env,
  id: string,
  expectedVersion: number,
  expectedBatchRevision: number,
  idempotencyKey: string,
  now = Date.now(),
): Promise<
  | {
    ok: true;
    changed: boolean;
    lead: ManualNewsLeadRecord;
    batch: { batch_id: string; revision: number; supersedes_revision: number | null; current: true; review_url: string } | null;
    pending_initial_freeze: boolean;
    rerender_enqueued: false;
  }
  | { ok: false; status: 404 | 409; error: string; lead?: ManualNewsLeadRecord }
> {
  const lead = await getManualNewsLead(env, id);
  if (!lead) return { ok: false, status: 404, error: 'manual_news_lead_not_found' };
  const row = await env.DB.prepare(
    `/* manual_lead:by_id */ SELECT * FROM manual_news_leads WHERE id = ?`,
  ).bind(id).first<ManualLeadRow>();
  if (row?.last_mutation_kind === 'confirm' && row.last_mutation_idempotency_key === idempotencyKey) {
    const batch = row.confirmed_batch_id
      ? await getNewsReviewBatch(env, row.review_date, row.confirmed_batch_id)
      : null;
    return {
      ok: true,
      changed: false,
      lead,
      batch: batch ? await publicConfirmedBatch(env, batch) : null,
      pending_initial_freeze: !batch,
      rerender_enqueued: false,
    };
  }
  if (row?.confirmed_at) return { ok: false, status: 409, error: 'lead_already_confirmed', lead };
  if (now >= newsReviewExpiresAt(lead.review_date)) {
    return { ok: false, status: 409, error: 'review_expired', lead };
  }
  if (lead.version !== expectedVersion) return { ok: false, status: 409, error: 'lead_version_conflict', lead };
  if (!['recommended', 'needs_review'].includes(lead.status) || !lead.assessment) {
    return { ok: false, status: 409, error: 'lead_not_confirmable', lead };
  }

  const primaryEvidence = lead.evidence.find((item) => item.reliable) || lead.evidence[0];
  // Keep the canonical `${source_type}:${source_id}` identity so existing
  // render/deep-link/item-page paths continue to understand manual candidates.
  const itemId = `blog:manual:${lead.id}`;
  const candidate = {
    item_id: itemId,
    title: lead.assessment.title,
    summary: lead.assessment.summary,
    source: primaryEvidence?.publisher || '手工补录',
    score: lead.assessment.score,
    ...(primaryEvidence?.url || lead.input_url ? { url: primaryEvidence?.url || lead.input_url } : {}),
    event_key: lead.assessment.event_key,
    origin: 'manual_lead' as const,
    lead_id: lead.id,
  };
  // Never invent a source publication time. `scraped_at` records our own
  // ingestion separately; missing source timing remains NULL and visible as uncertainty.
  const publishedAt = lead.evidence.map((item) => item.published_at).find(Boolean) || null;
  const itemExtra = JSON.stringify({
    title_zh: lead.assessment.title,
    ai_summary_zh: lead.assessment.summary,
    source_company: candidate.source,
    event_fingerprint: lead.assessment.event_key,
    manual_lead: { lead_id: lead.id, evidence_ids: lead.evidence.map((item) => item.id) },
  });
  const active = await getActiveNewsReviewBatch(env, lead.review_date);
  if ((active?.batch_revision || 0) !== expectedBatchRevision) {
    return { ok: false, status: 409, error: 'candidate_batch_revision_conflict', lead };
  }
  if (!active) {
    await env.DB.batch([
      confirmedLeadItemStatement(env, lead, expectedVersion, candidate, publishedAt, itemExtra, now),
      env.DB.prepare(
        `/* manual_lead:confirm_prefreeze */ UPDATE manual_news_leads SET
           version = version + 1, confirmed_at = ?, last_mutation_kind = 'confirm',
           last_mutation_idempotency_key = ?, updated_at = ?
         WHERE id = ? AND version = ? AND status IN ('recommended', 'needs_review')`,
      ).bind(now, idempotencyKey, now, id, expectedVersion),
      env.DB.prepare(
        `/* manual_audit:confirm_prefreeze */ INSERT INTO manual_news_lead_audit
         (lead_id, action, from_status, to_status, idempotency_key, metadata_json, created_at)
         SELECT ?, 'confirm_candidate', status, status, ?, '{"pending_initial_freeze":true}', ?
         FROM manual_news_leads
         WHERE id = ? AND last_mutation_idempotency_key = ? AND version = ?`,
      ).bind(id, idempotencyKey, now, id, idempotencyKey, expectedVersion + 1),
    ]);
    const latestRow = await env.DB.prepare(
      `/* manual_lead:by_id */ SELECT * FROM manual_news_leads WHERE id = ?`,
    ).bind(id).first<ManualLeadRow>();
    if (!latestRow) return { ok: false, status: 404, error: 'manual_news_lead_not_found' };
    const updated = await leadFromRow(env, latestRow);
    if (latestRow.last_mutation_kind !== 'confirm' || latestRow.last_mutation_idempotency_key !== idempotencyKey) {
      return { ok: false, status: 409, error: 'lead_version_conflict', lead: updated };
    }
    return {
      ok: true,
      changed: true,
      lead: updated,
      batch: null,
      pending_initial_freeze: true,
      rerender_enqueued: false,
    };
  }

  const publishedIds = await getPublishedNewsReviewSelection(env, lead.review_date, active);
  const merged = mergeManualLeadCandidate({
    previous_candidates: active.candidates,
    previous_default_selected_ids: active.default_selected_ids,
    published_selected_ids: publishedIds,
    candidate,
    max_candidates: 10,
  });
  const batchId = await buildNewsReviewBatchId(lead.review_date, merged.candidates);
  const batchRevision = active.batch_revision + 1;
  const candidateIds = merged.candidates.map((item) => item.item_id);

  const statements = [
    confirmedLeadItemStatement(env, lead, expectedVersion, candidate, publishedAt, itemExtra, now, active),
    env.DB.prepare(
      `/* manual_lead:confirm_batch */ INSERT INTO daily_news_review_batches (
         review_date, batch_id, candidate_ids, candidates_json, default_selected_ids,
         created_at, expires_at, batch_revision, supersedes_batch_id, revision_origin,
         lineage_id, is_current
       ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual_lead', ?, 0
       WHERE EXISTS (SELECT 1 FROM manual_news_leads WHERE id = ? AND version = ?)
       AND EXISTS (SELECT 1 FROM daily_news_review_batches
           WHERE review_date = ? AND lineage_id = ? AND batch_id = ? AND batch_revision = ? AND is_current = 1)
       ON CONFLICT(review_date, batch_id) DO NOTHING`,
    ).bind(
      lead.review_date, batchId, JSON.stringify(candidateIds), JSON.stringify(merged.candidates),
      JSON.stringify(merged.default_selected_ids), now, newsReviewExpiresAt(lead.review_date),
      batchRevision, active.batch_id, lead.review_date, lead.id, expectedVersion,
      lead.review_date, lead.review_date, active.batch_id, active.batch_revision,
    ),
    env.DB.prepare(
      `/* manual_lead:supersede_batch */ UPDATE daily_news_review_batches SET superseded_by = ?, is_current = 0
       WHERE review_date = ? AND lineage_id = ? AND batch_id = ? AND batch_revision = ? AND is_current = 1
         AND EXISTS (SELECT 1 FROM daily_news_review_batches WHERE review_date = ? AND batch_id = ? AND is_current = 0)`,
    ).bind(
      batchId, lead.review_date, lead.review_date, active.batch_id, active.batch_revision,
      lead.review_date, batchId,
    ),
    env.DB.prepare(
      `/* manual_lead:activate_batch */ UPDATE daily_news_review_batches SET is_current = 1
       WHERE review_date = ? AND lineage_id = ? AND batch_id = ? AND is_current = 0
         AND EXISTS (SELECT 1 FROM daily_news_review_batches
           WHERE review_date = ? AND batch_id = ? AND superseded_by = ?)`,
    ).bind(lead.review_date, lead.review_date, batchId, lead.review_date, active.batch_id, batchId),
    env.DB.prepare(
      `/* manual_lead:confirm */ UPDATE manual_news_leads SET
         version = version + 1, confirmed_batch_id = ?, confirmed_at = ?,
         last_mutation_kind = 'confirm', last_mutation_idempotency_key = ?, updated_at = ?
       WHERE id = ? AND version = ? AND status IN ('recommended', 'needs_review')
         AND EXISTS (SELECT 1 FROM daily_news_review_batches WHERE review_date = ? AND batch_id = ? AND is_current = 1)`,
    ).bind(batchId, now, idempotencyKey, now, lead.id, expectedVersion, lead.review_date, batchId),
    env.DB.prepare(
      `/* manual_audit:confirm */ INSERT INTO manual_news_lead_audit
       (lead_id, action, from_status, to_status, idempotency_key, metadata_json, created_at)
       SELECT ?, 'confirm_candidate', status, status, ?, ?, ? FROM manual_news_leads
       WHERE id = ? AND confirmed_batch_id = ? AND last_mutation_idempotency_key = ?`,
    ).bind(
      lead.id, idempotencyKey,
      JSON.stringify({ batch_id: batchId, revision: batchRevision, supersedes: active.batch_id, evicted_ids: merged.evicted_ids }),
      now, lead.id, batchId, idempotencyKey,
    ),
  ];
  await env.DB.batch(statements);
  const updated = await getManualNewsLead(env, id);
  const batch = await getNewsReviewBatch(env, lead.review_date, batchId);
  if (!updated || updated.confirmed_batch_id !== batchId || !batch) {
    return { ok: false, status: 409, error: 'lead_version_conflict', ...(updated ? { lead: updated } : {}) };
  }
  return {
    ok: true,
    changed: true,
    lead: updated,
    batch: await publicConfirmedBatch(env, batch),
    pending_initial_freeze: false,
    rerender_enqueued: false,
  };
}

function confirmedLeadItemStatement(
  env: Env,
  lead: ManualNewsLeadRecord,
  expectedVersion: number,
  candidate: {
    item_id: string;
    title: string;
    summary: string;
    source: string;
    url?: string;
  },
  publishedAt: string | null,
  itemExtra: string,
  now: number,
  expectedActiveBatch?: NewsReviewBatch,
): D1PreparedStatement {
  const activeGuard = expectedActiveBatch
    ? ` AND EXISTS (SELECT 1 FROM daily_news_review_batches
         WHERE review_date = ? AND lineage_id = ? AND batch_id = ? AND batch_revision = ? AND is_current = 1)`
    : '';
  const values: unknown[] = [
    candidate.item_id,
    `manual:${lead.id}`,
    candidate.title,
    candidate.summary,
    candidate.summary,
    candidate.source,
    candidate.url || '',
    publishedAt,
    new Date(now).toISOString(),
    itemExtra,
    lead.id,
    expectedVersion,
  ];
  if (expectedActiveBatch) {
    values.push(lead.review_date, lead.review_date, expectedActiveBatch.batch_id, expectedActiveBatch.batch_revision);
  }
  return env.DB.prepare(
    `/* manual_lead:confirm_item */ INSERT INTO items (
       id, source_type, source_id, source_ref, title, content, content_translated, author,
       url, published_at, scraped_at, is_relevant, matched_by, lang, extra
     ) SELECT ?, 'blog', ?, 'manual_lead', ?, ?, ?, ?, ?, ?, ?, 1, 'manual_lead', 'zh', ?
     WHERE EXISTS (SELECT 1 FROM manual_news_leads WHERE id = ? AND version = ?)${activeGuard}
     ON CONFLICT(id) DO UPDATE SET title = excluded.title, content = excluded.content,
       content_translated = excluded.content_translated, author = excluded.author,
       url = excluded.url, published_at = excluded.published_at, extra = excluded.extra`,
  ).bind(...values);
}

async function publicConfirmedBatch(env: Env, batch: NewsReviewBatch): Promise<{
  batch_id: string;
  revision: number;
  supersedes_revision: number | null;
  current: true;
  review_url: string;
}> {
  const date = batch.review_date;
  const token = await createNewsReviewToken(newsReviewSecret(env), date, batch.batch_id);
  const url = new URL('https://ai-feeds.cc/aifeeds/latest/');
  url.searchParams.set('review_date', date);
  url.searchParams.set('review_batch', batch.batch_id);
  url.searchParams.set('review_token', token);
  url.hash = 'news-review';
  return {
    batch_id: batch.batch_id,
    revision: batch.batch_revision,
    supersedes_revision: batch.batch_revision > 1 ? batch.batch_revision - 1 : null,
    current: true,
    review_url: url.toString(),
  };
}
