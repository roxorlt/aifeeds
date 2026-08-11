import type { Env } from '../index';
import {
  applyManualLeadEvidencePolicy,
  assertManualLeadTransition,
  isCurrentManualLeadVerification,
  manualLeadAssessmentCore,
  mergeManualLeadCandidate,
  validateManualLeadAssessment,
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

const PROCESSING_LEASE_MS = 6 * 60 * 1000;
const INTERMEDIATE_PROCESSING_STATUSES: readonly ManualNewsLeadStatus[] = [
  'submitted', 'validating', 'researching', 'extracting', 'verifying', 'clustering', 'scored',
];

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
  last_mutation_nonce: string | null;
  processing_owner: string | null;
  processing_attempt: number;
  processing_lease_until: number | null;
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
  fetch_audit_json: string;
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
    fetch_audit: parseJson<ManualNewsEvidence['fetch_audit']>(row.fetch_audit_json, null),
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function createMutationNonce(action: string): string {
  return `${action}:${crypto.randomUUID()}`;
}

export function manualNewsLeadProcessingOwner(id: string, version: number): string {
  return `manual-news-${id}-v${version}`;
}

function auditMutationStatement(
  env: Env,
  input: {
    leadId: string;
    action: string;
    mutationKind: string;
    mutationNonce: string;
    fromStatus: ManualNewsLeadStatus | null;
    toStatus: ManualNewsLeadStatus | null;
    idempotencyKey?: string | null;
    resultingVersion: number;
    metadata?: Record<string, unknown>;
    createdAt: number;
  },
): D1PreparedStatement {
  return env.DB.prepare(
    `/* manual_audit:mutation */ INSERT INTO manual_news_lead_audit
     (lead_id, action, from_status, to_status, idempotency_key, mutation_nonce,
      resulting_version, metadata_json, created_at)
     SELECT ?, ?, ?, ?, ?, ?, version, ?, ? FROM manual_news_leads
     WHERE id = ? AND version = ? AND status = ?
       AND last_mutation_kind = ? AND last_mutation_idempotency_key IS ?
       AND last_mutation_nonce = ?`,
  ).bind(
    input.leadId, input.action, input.fromStatus, input.toStatus, input.idempotencyKey || null,
    input.mutationNonce, JSON.stringify(input.metadata || {}), input.createdAt,
    input.leadId, input.resultingVersion, input.toStatus, input.mutationKind,
    input.idempotencyKey || null, input.mutationNonce,
  );
}

function auditedMutationChanges(
  results: Array<{ meta?: { changes?: number } }>,
  mutationIndex: number,
  auditIndex: number,
): number {
  const mutationChanges = Number(results[mutationIndex]?.meta?.changes || 0);
  const auditChanges = Number(results[auditIndex]?.meta?.changes || 0);
  if (mutationChanges > 1 || auditChanges > 1 || mutationChanges !== auditChanges) {
    throw new Error('manual_lead_audit_causality_mismatch');
  }
  return mutationChanges;
}

async function runAuditedMutation(
  env: Env,
  mutation: D1PreparedStatement,
  audit: D1PreparedStatement,
): Promise<number> {
  const results = await env.DB.batch([mutation, audit]) as Array<{ meta?: { changes?: number } }>;
  return auditedMutationChanges(results, 0, 1);
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
    processing_owner: row.processing_owner || null,
    processing_attempt: Number(row.processing_attempt || 0),
    processing_lease_until: row.processing_lease_until === null || row.processing_lease_until === undefined
      ? null
      : Number(row.processing_lease_until),
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
  if (existing) {
    const samePayload = existing.input_type === normalized.input_type
      && existing.input_text === normalized.text
      && existing.input_url === normalized.url
      && existing.note === normalized.note;
    if (!samePayload) throw new Error('idempotency_key_reused_with_different_payload');
    return { lead: await leadFromRow(env, existing), created: false };
  }
  const hash = await sha256Hex(`${normalized.date}\0${idempotencyKey}\0${normalized.text}\0${normalized.url}`);
  const id = `ml-${normalized.date.replace(/-/g, '')}-${hash.slice(0, 12)}`;
  const mutationNonce = createMutationNonce('submit');
  const processingOwner = manualNewsLeadProcessingOwner(id, 1);
  const insertStatement = env.DB.prepare(
    `/* manual_lead:insert */ INSERT OR IGNORE INTO manual_news_leads (
       id, review_date, input_type, input_text, input_url, note, status, version,
       submit_idempotency_key, last_mutation_kind, last_mutation_idempotency_key,
       last_mutation_nonce, processing_owner, processing_lease_until, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'submitted', 1, ?, 'submit', ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    normalized.date,
    normalized.input_type,
    normalized.text,
    normalized.url,
    normalized.note,
    idempotencyKey,
    idempotencyKey,
    mutationNonce,
    processingOwner,
    now + PROCESSING_LEASE_MS,
    now,
    now,
  );
  const created = await runAuditedMutation(env, insertStatement, auditMutationStatement(env, {
    leadId: id, action: 'submit', mutationKind: 'submit', mutationNonce,
    fromStatus: null, toStatus: 'submitted', idempotencyKey,
    resultingVersion: 1, metadata: { input_type: normalized.input_type }, createdAt: now,
  })) > 0;
  let lead = await getManualNewsLead(env, id);
  if (!lead) {
    const winner = await env.DB.prepare(
      `/* manual_lead:by_submit_key */ SELECT * FROM manual_news_leads
       WHERE review_date = ? AND submit_idempotency_key = ?`,
    ).bind(normalized.date, idempotencyKey).first<ManualLeadRow>();
    if (!winner) throw new Error('manual_news_lead_insert_failed');
    const samePayload = winner.input_type === normalized.input_type && winner.input_text === normalized.text
      && winner.input_url === normalized.url && winner.note === normalized.note;
    if (!samePayload) throw new Error('idempotency_key_reused_with_different_payload');
    lead = await leadFromRow(env, winner);
  }
  return { lead, created };
}

export type ManualLeadMutationResult =
  | { ok: true; changed: boolean; lead: ManualNewsLeadRecord }
  | { ok: false; status: 404 | 409; error: string; lead?: ManualNewsLeadRecord };

async function hasCompletedRetryAudit(
  env: Env,
  id: string,
  expectedVersion: number,
  idempotencyKey: string,
): Promise<boolean> {
  const audit = await env.DB.prepare(
    `/* manual_audit:retry_idempotency */ SELECT resulting_version FROM manual_news_lead_audit
     WHERE lead_id = ? AND action = 'retry' AND idempotency_key = ? LIMIT 1`,
  ).bind(id, idempotencyKey).first<{ resulting_version: number }>();
  return Number(audit?.resulting_version) === expectedVersion + 1;
}

export async function retryManualNewsLead(
  env: Env,
  id: string,
  expectedVersion: number,
  idempotencyKey: string,
  now = Date.now(),
): Promise<ManualLeadMutationResult> {
  const lead = await getManualNewsLead(env, id);
  if (!lead) return { ok: false, status: 404, error: 'manual_news_lead_not_found' };
  if (await hasCompletedRetryAudit(env, id, expectedVersion, idempotencyKey)) {
    const current = await getManualNewsLead(env, id);
    return current
      ? { ok: true, changed: false, lead: current }
      : { ok: false, status: 404, error: 'manual_news_lead_not_found' };
  }
  if (lead.confirmed_at) return { ok: false, status: 409, error: 'lead_already_confirmed', lead };
  if (lead.version !== expectedVersion) return { ok: false, status: 409, error: 'lead_version_conflict', lead };
  if (!['failed', 'needs_review', 'rejected'].includes(lead.status)) {
    return { ok: false, status: 409, error: 'lead_not_retryable', lead };
  }
  assertManualLeadTransition(lead.status, 'validating');
  const nextVersion = expectedVersion + 1;
  const processingOwner = manualNewsLeadProcessingOwner(id, nextVersion);
  const mutationNonce = createMutationNonce('retry');
  const mutation = env.DB.prepare(
    `/* manual_lead:retry */ UPDATE manual_news_leads SET
       status = 'validating', version = version + 1, error_code = NULL, error_message = NULL,
       last_mutation_kind = 'retry', last_mutation_idempotency_key = ?,
       last_mutation_nonce = ?, processing_owner = ?, processing_lease_until = ?, updated_at = ?
     WHERE id = ? AND version = ? AND status IN ('failed', 'needs_review', 'rejected')`,
  ).bind(idempotencyKey, mutationNonce, processingOwner, now + PROCESSING_LEASE_MS, now, id, expectedVersion);
  const changed = await runAuditedMutation(env, mutation, auditMutationStatement(env, {
    leadId: id, action: 'retry', mutationKind: 'retry', mutationNonce,
    fromStatus: lead.status, toStatus: 'validating', idempotencyKey,
    resultingVersion: nextVersion, createdAt: now,
  }));
  if (!changed) {
    const conflicted = await getManualNewsLead(env, id);
    if (await hasCompletedRetryAudit(env, id, expectedVersion, idempotencyKey)) {
      const current = await getManualNewsLead(env, id);
      return current
        ? { ok: true, changed: false, lead: current }
        : { ok: false, status: 404, error: 'manual_news_lead_not_found' };
    }
    return { ok: false, status: 409, error: 'lead_version_conflict', ...(conflicted ? { lead: conflicted } : {}) };
  }
  const updated = await getManualNewsLead(env, id);
  if (!updated) return { ok: false, status: 404, error: 'manual_news_lead_not_found' };
  return { ok: true, changed: true, lead: updated };
}

export async function claimManualNewsLeadProcessing(
  env: Env,
  id: string,
  owner: string,
  now = Date.now(),
): Promise<boolean> {
  if (!owner || owner.length > 200) throw new Error('invalid_processing_owner');
  const result = await env.DB.prepare(
    `/* manual_lead:claim_processing */ UPDATE manual_news_leads SET
       processing_owner = ?, processing_attempt = processing_attempt + 1,
       processing_lease_until = ?, updated_at = ?
     WHERE id = ? AND confirmed_at IS NULL
       AND status IN ('submitted','validating','researching','extracting','verifying','clustering','scored')
       AND (processing_owner IS NULL OR processing_owner = ?
         OR processing_lease_until IS NULL OR processing_lease_until < ?)`,
  ).bind(owner, now + PROCESSING_LEASE_MS, now, id, owner, now).run();
  return Number(result.meta.changes || 0) > 0;
}

export async function failManualNewsLeadAfterExhaustion(
  env: Env,
  id: string,
  owner: string,
  error: unknown,
  now = Date.now(),
): Promise<boolean> {
  const row = await env.DB.prepare(
    `/* manual_lead:owned_processing */ SELECT status, version FROM manual_news_leads
     WHERE id = ? AND processing_owner = ?`,
  ).bind(id, owner).first<{ status: ManualNewsLeadStatus; version: number }>();
  if (!row || !INTERMEDIATE_PROCESSING_STATUSES.includes(row.status)) return false;
  const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 500);
  const mutationNonce = createMutationNonce('processing_exhausted');
  const mutation = env.DB.prepare(
    `/* manual_lead:processing_exhausted */ UPDATE manual_news_leads SET
       status = 'failed', version = version + 1, error_code = 'processing_retry_exhausted',
       error_message = ?, last_mutation_kind = 'processing_exhausted',
       last_mutation_idempotency_key = ?, last_mutation_nonce = ?, processing_owner = NULL,
       processing_lease_until = NULL, updated_at = ?
     WHERE id = ? AND status = ? AND version = ? AND processing_owner = ?`,
  ).bind(message, owner, mutationNonce, now, id, row.status, row.version, owner);
  return await runAuditedMutation(env, mutation, auditMutationStatement(env, {
    leadId: id, action: 'processing_exhausted', mutationKind: 'processing_exhausted', mutationNonce,
    fromStatus: row.status, toStatus: 'failed',
    idempotencyKey: owner, resultingVersion: Number(row.version) + 1,
    metadata: { processing_owner: owner }, createdAt: now,
  })) > 0;
}

export async function markManualNewsLeadEnqueueFailure(
  env: Env,
  id: string,
  scheduledVersion: number,
  scheduledOwner: string,
  error: unknown,
  now = Date.now(),
): Promise<boolean> {
  const row = await env.DB.prepare(
    `/* manual_lead:enqueue_failure_version */ SELECT status, version FROM manual_news_leads
     WHERE id = ? AND version = ? AND processing_owner = ?
       AND status IN ('submitted','validating')`,
  ).bind(id, scheduledVersion, scheduledOwner).first<{ status: ManualNewsLeadStatus; version: number }>();
  if (!row) return false;
  const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 500);
  const key = `enqueue:${scheduledVersion}:${scheduledOwner}`;
  const mutationNonce = createMutationNonce('enqueue_failure');
  const mutation = env.DB.prepare(
    `/* manual_lead:enqueue_failure */ UPDATE manual_news_leads SET
       status = 'failed', version = version + 1, error_code = 'workflow_enqueue_failed',
       error_message = ?, last_mutation_kind = 'enqueue_failure',
       last_mutation_idempotency_key = ?, last_mutation_nonce = ?, processing_owner = NULL,
       processing_lease_until = NULL, updated_at = ?
     WHERE id = ? AND status = ? AND version = ? AND processing_owner = ?`,
  ).bind(message, key, mutationNonce, now, id, row.status, scheduledVersion, scheduledOwner);
  return await runAuditedMutation(env, mutation, auditMutationStatement(env, {
    leadId: id, action: 'enqueue_failure', mutationKind: 'enqueue_failure', mutationNonce,
    fromStatus: row.status, toStatus: 'failed',
    idempotencyKey: key, resultingVersion: Number(row.version) + 1, createdAt: now,
    metadata: { scheduled_version: scheduledVersion, processing_owner: scheduledOwner },
  })) > 0;
}

export async function recoverStaleManualNewsLeads(
  env: Env,
  date: string,
  now = Date.now(),
): Promise<ManualNewsLeadRecord[]> {
  const stale = await env.DB.prepare(
    `/* manual_lead:list_stale_processing */ SELECT id, status, version FROM manual_news_leads
     WHERE review_date = ?
       AND (status IN ('validating','researching','extracting','verifying','clustering','scored')
         OR (status = 'submitted' AND processing_owner IS NOT NULL))
       AND (processing_lease_until IS NULL OR processing_lease_until < ?)
     ORDER BY updated_at ASC LIMIT 20`,
  ).bind(date, now).all<{ id: string; status: ManualNewsLeadStatus; version: number }>();
  const recovered: ManualNewsLeadRecord[] = [];
  for (const row of stale.results || []) {
    const key = `stale-recovery:${row.version}`;
    const nextVersion = Number(row.version) + 1;
    const processingOwner = manualNewsLeadProcessingOwner(row.id, nextVersion);
    const mutationNonce = createMutationNonce('stale_recovery');
    const mutation = env.DB.prepare(
      `/* manual_lead:recover_stale */ UPDATE manual_news_leads SET
         status = 'validating', version = version + 1, error_code = NULL, error_message = NULL,
         last_mutation_kind = 'stale_recovery', last_mutation_idempotency_key = ?,
         last_mutation_nonce = ?, processing_owner = ?, processing_lease_until = ?, updated_at = ?
       WHERE id = ? AND status = ? AND version = ?
         AND (processing_lease_until IS NULL OR processing_lease_until < ?)`,
    ).bind(key, mutationNonce, processingOwner, now + PROCESSING_LEASE_MS, now, row.id, row.status, row.version, now);
    const changed = await runAuditedMutation(env, mutation, auditMutationStatement(env, {
      leadId: row.id, action: 'stale_recovery', mutationKind: 'stale_recovery', mutationNonce,
      fromStatus: row.status, toStatus: 'validating',
      idempotencyKey: key, resultingVersion: nextVersion, createdAt: now,
    }));
    if (!changed) continue;
    const lead = await getManualNewsLead(env, row.id);
    if (lead) recovered.push(lead);
  }
  return recovered;
}

export class D1ManualLeadProcessingStore implements ManualLeadProcessingStore {
  constructor(private readonly env: Env, private readonly processingOwner?: string) {}

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
    const current = await this.env.DB.prepare(
      `/* manual_lead:transition_version */ SELECT version FROM manual_news_leads WHERE id = ? AND status = ?`,
    ).bind(id, from).first<{ version: number }>();
    if (!current) throw new Error('lead_transition_conflict');
    const terminal = ['recommended', 'needs_review', 'duplicate', 'rejected', 'failed'].includes(to);
    const mutationNonce = createMutationNonce('status_transition');
    const ownerGuard = this.processingOwner ? ' AND processing_owner = ?' : '';
    const mutation = this.env.DB.prepare(
      `/* manual_lead:transition */ UPDATE manual_news_leads SET
         status = ?, version = version + 1, error_code = ?, error_message = ?,
         last_mutation_kind = 'status_transition', last_mutation_idempotency_key = NULL,
         last_mutation_nonce = ?,
         processing_owner = ?, processing_lease_until = ?, updated_at = ?
       WHERE id = ? AND status = ? AND version = ?${ownerGuard}`,
    ).bind(
      to, patch.error_code ?? null, patch.error_message ?? null, mutationNonce,
      terminal ? null : this.processingOwner || null, terminal ? null : now + PROCESSING_LEASE_MS,
      now, id, from, Number(current.version), ...(this.processingOwner ? [this.processingOwner] : []),
    );
    const changed = await runAuditedMutation(this.env, mutation, auditMutationStatement(this.env, {
      leadId: id, action: 'status_transition', mutationKind: 'status_transition', mutationNonce,
      fromStatus: from, toStatus: to,
      resultingVersion: Number(current.version) + 1, createdAt: now,
    }));
    if (!changed) throw new Error('lead_transition_conflict');
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
           title, excerpt, claims_supported_json, fetch_audit_json, reliable
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id, item.id, item.url, item.source_type, item.publisher, item.published_at, item.retrieved_at,
        item.title, item.excerpt, JSON.stringify(item.claims_supported), JSON.stringify(item.fetch_audit || null),
        item.reliable ? 1 : 0,
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

  async clearAssessment(id: string): Promise<void> {
    try {
      await this.env.DB.prepare(
        `/* manual_assessment:clear */ DELETE FROM manual_news_event_assessments WHERE lead_id = ?`,
      ).bind(id).run();
    } catch {
      throw new Error('d1_clear_assessment_failed');
    }
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
  if (!lead.assessment) return { ok: false, status: 409, error: 'lead_not_confirmable', lead };
  let factVerified = false;
  try {
    const validated = applyManualLeadEvidencePolicy(validateManualLeadAssessment(
      manualLeadAssessmentCore(lead.assessment), lead.evidence,
    ), lead.evidence);
    factVerified = await isCurrentManualLeadVerification(
      validated, lead.assessment.verification, lead.evidence,
    );
  } catch {
    factVerified = false;
  }
  if (!factVerified) return { ok: false, status: 409, error: 'lead_not_fact_verified', lead };
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
  if (!['recommended', 'needs_review'].includes(lead.status)) {
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
  const confirmationNonce = createMutationNonce('confirm');
  const active = await getActiveNewsReviewBatch(env, lead.review_date);
  if ((active?.batch_revision || 0) !== expectedBatchRevision) {
    return { ok: false, status: 409, error: 'candidate_batch_revision_conflict', lead };
  }
  if (!active) {
    const results = await env.DB.batch([
      env.DB.prepare(
        `/* manual_lead:candidate_generation_init */ INSERT OR IGNORE INTO daily_news_review_candidate_generations
         (review_date, lineage_id, generation, updated_at) VALUES (?, ?, 0, ?)`,
      ).bind(lead.review_date, lead.review_date, now),
      confirmedLeadItemStatement(env, lead, expectedVersion, candidate, publishedAt, itemExtra, now, undefined, true),
      env.DB.prepare(
        `/* manual_lead:confirm_prefreeze */ UPDATE manual_news_leads SET
           version = version + 1, confirmed_at = ?, last_mutation_kind = 'confirm',
           last_mutation_idempotency_key = ?, last_mutation_nonce = ?, updated_at = ?
         WHERE id = ? AND version = ? AND status IN ('recommended', 'needs_review')
           AND NOT EXISTS (SELECT 1 FROM daily_news_review_batches
             WHERE review_date = ? AND lineage_id = ? AND is_current = 1)`,
      ).bind(now, idempotencyKey, confirmationNonce, now, id, expectedVersion, lead.review_date, lead.review_date),
      env.DB.prepare(
        `/* manual_lead:candidate_generation_advance */ UPDATE daily_news_review_candidate_generations
         SET generation = generation + 1, updated_at = ?
         WHERE review_date = ? AND lineage_id = ?
           AND NOT EXISTS (SELECT 1 FROM daily_news_review_batches
             WHERE review_date = ? AND lineage_id = ? AND is_current = 1)
           AND EXISTS (SELECT 1 FROM manual_news_leads
             WHERE id = ? AND version = ? AND last_mutation_kind = 'confirm'
               AND last_mutation_idempotency_key = ? AND last_mutation_nonce = ?)`,
      ).bind(
        now, lead.review_date, lead.review_date, lead.review_date, lead.review_date,
        id, expectedVersion + 1, idempotencyKey, confirmationNonce,
      ),
      auditMutationStatement(env, {
        leadId: id, action: 'confirm_candidate', mutationKind: 'confirm', mutationNonce: confirmationNonce,
        fromStatus: lead.status, toStatus: lead.status,
        idempotencyKey, resultingVersion: expectedVersion + 1,
        metadata: { pending_initial_freeze: true }, createdAt: now,
      }),
    ]) as Array<{ meta?: { changes?: number } }>;
    const changed = auditedMutationChanges(results, 2, 4);
    const latestRow = await env.DB.prepare(
      `/* manual_lead:by_id */ SELECT * FROM manual_news_leads WHERE id = ?`,
    ).bind(id).first<ManualLeadRow>();
    if (!latestRow) return { ok: false, status: 404, error: 'manual_news_lead_not_found' };
    const updated = await leadFromRow(env, latestRow);
    if (!changed) {
      if (latestRow.last_mutation_kind === 'confirm' && latestRow.last_mutation_idempotency_key === idempotencyKey) {
        return {
          ok: true, changed: false, lead: updated, batch: null,
          pending_initial_freeze: true, rerender_enqueued: false,
        };
      }
      const latestActive = await getActiveNewsReviewBatch(env, lead.review_date);
      if (latestActive) {
        return { ok: false, status: 409, error: 'candidate_batch_revision_conflict', lead: updated };
      }
      return { ok: false, status: 409, error: 'lead_version_conflict', lead: updated };
    }
    if (latestRow.last_mutation_nonce !== confirmationNonce) {
      throw new Error('manual_lead_audit_causality_mismatch');
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
  let merged: ReturnType<typeof mergeManualLeadCandidate>;
  try {
    merged = mergeManualLeadCandidate({
      previous_candidates: active.candidates,
      previous_default_selected_ids: active.default_selected_ids,
      published_selected_ids: publishedIds,
      candidate,
      max_candidates: 10,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'candidate_cap_exhausted') {
      return { ok: false, status: 409, error: 'candidate_cap_exhausted', lead };
    }
    throw error;
  }
  const batchId = await buildNewsReviewBatchId(lead.review_date, merged.candidates);
  const batchRevision = active.batch_revision + 1;
  const candidateIds = merged.candidates.map((item) => item.item_id);

  const statements = [
    confirmedLeadItemStatement(env, lead, expectedVersion, candidate, publishedAt, itemExtra, now, active),
    env.DB.prepare(
      `/* manual_lead:confirm_batch */ INSERT INTO daily_news_review_batches (
         review_date, batch_id, candidate_ids, candidates_json, default_selected_ids,
         created_at, expires_at, batch_revision, supersedes_batch_id, revision_origin,
         lineage_id, is_current, candidate_generation
       ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual_lead', ?, 0, ?
       WHERE EXISTS (SELECT 1 FROM manual_news_leads WHERE id = ? AND version = ?)
       AND EXISTS (SELECT 1 FROM daily_news_review_batches
           WHERE review_date = ? AND lineage_id = ? AND batch_id = ? AND batch_revision = ? AND is_current = 1)
       ON CONFLICT(review_date, batch_id) DO NOTHING`,
    ).bind(
      lead.review_date, batchId, JSON.stringify(candidateIds), JSON.stringify(merged.candidates),
      JSON.stringify(merged.default_selected_ids), now, newsReviewExpiresAt(lead.review_date),
      batchRevision, active.batch_id, lead.review_date, active.candidate_generation, lead.id, expectedVersion,
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
         last_mutation_kind = 'confirm', last_mutation_idempotency_key = ?,
         last_mutation_nonce = ?, updated_at = ?
       WHERE id = ? AND version = ? AND status IN ('recommended', 'needs_review')
         AND EXISTS (SELECT 1 FROM daily_news_review_batches WHERE review_date = ? AND batch_id = ? AND is_current = 1)`,
    ).bind(
      batchId, now, idempotencyKey, confirmationNonce, now,
      lead.id, expectedVersion, lead.review_date, batchId,
    ),
    auditMutationStatement(env, {
      leadId: lead.id, action: 'confirm_candidate', mutationKind: 'confirm', mutationNonce: confirmationNonce,
      fromStatus: lead.status, toStatus: lead.status,
      idempotencyKey, resultingVersion: expectedVersion + 1,
      metadata: {
        batch_id: batchId, revision: batchRevision, supersedes: active.batch_id,
        evicted_ids: merged.evicted_ids,
      },
      createdAt: now,
    }),
  ];
  const results = await env.DB.batch(statements) as Array<{ meta?: { changes?: number } }>;
  const changed = auditedMutationChanges(results, 4, 5);
  const updated = await getManualNewsLead(env, id);
  const batch = await getNewsReviewBatch(env, lead.review_date, batchId);
  const updatedRow = await env.DB.prepare(
    `/* manual_lead:by_id */ SELECT * FROM manual_news_leads WHERE id = ?`,
  ).bind(id).first<ManualLeadRow>();
  if (!changed && updated && updatedRow?.last_mutation_kind === 'confirm'
    && updatedRow.last_mutation_idempotency_key === idempotencyKey && batch) {
    return {
      ok: true, changed: false, lead: updated, batch: await publicConfirmedBatch(env, batch),
      pending_initial_freeze: false, rerender_enqueued: false,
    };
  }
  if (!updated || updated.confirmed_batch_id !== batchId || !batch || !changed) {
    return { ok: false, status: 409, error: 'lead_version_conflict', ...(updated ? { lead: updated } : {}) };
  }
  if (updatedRow?.last_mutation_nonce !== confirmationNonce) {
    throw new Error('manual_lead_audit_causality_mismatch');
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
  requireNoActiveBatch = false,
): D1PreparedStatement {
  const activeGuard = expectedActiveBatch
    ? ` AND EXISTS (SELECT 1 FROM daily_news_review_batches
         WHERE review_date = ? AND lineage_id = ? AND batch_id = ? AND batch_revision = ? AND is_current = 1)`
    : requireNoActiveBatch
      ? ` AND NOT EXISTS (SELECT 1 FROM daily_news_review_batches
           WHERE review_date = ? AND lineage_id = ? AND is_current = 1)`
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
  } else if (requireNoActiveBatch) {
    values.push(lead.review_date, lead.review_date);
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
