import type { Env } from '../index';
import {
  manualNewsResponseKeyring,
  manualNewsVerificationKeyring,
} from '../security/manual-news-keyring';
import {
  assertManualLeadTransition,
  createManualEvidenceDigest,
  createManualLeadVerificationProof,
  MANUAL_LEAD_EDITORIAL_PROJECTION_CONTRACT,
  MANUAL_LEAD_EVIDENCE_DISPOSITION_CONTRACT,
  MANUAL_LEAD_GENERATED_CLAIM_CONTRACT,
  MANUAL_LEAD_SOURCE_FACT_CONTRACT,
  MANUAL_LEAD_VERIFICATION_POLICY_VERSION,
  manualLeadAssessmentValidationFailure,
  manualNewsAssessmentGenerationAudit,
  mergeManualLeadCandidate,
  validateManualLeadFactVerification,
  validateManualNewsProcessedAssessment,
  validateManualNewsLeadInput,
  type ManualNewsEvidence,
  type ManualLeadPriorEvent,
  type ManualNewsLeadStatus,
  type ManualNewsProcessedAssessment,
  type ManualNewsAssessmentGenerationAudit,
} from './manual-news-leads';
import {
  loadManualNewsEvidence,
  loadVerifiedManualAssessment,
  MANUAL_VERIFICATION_SNAPSHOT_GUARD_SQL,
  manualVerificationSnapshotGuardBindings,
  type PersistedManualVerificationRow,
} from './manual-news-leads-verification';
import type {
  ManualAssessmentGenerationCycleState,
  ManualAssessmentGenerationValidationResult,
  ManualLeadProcessingStore,
  ManualLeadTransitionPatch,
  ManualNewsLeadRecord,
  ManualNewsLeadSummary,
} from './manual-news-leads-pipeline';
import {
  isValidManualNewsProviderFailureAudit,
  manualNewsProviderFailureAudit,
  type ManualNewsProviderFailureAudit,
} from './manual-news-provider';
import {
  buildNewsReviewBatchId,
  createNewsReviewToken,
  getActiveNewsReviewBatch,
  getNewsReviewBatch,
  getPublishedNewsReviewSelection,
  newsReviewExpiresAt,
  newsReviewSecret,
  newsReviewSelectionHash,
  sanitizeCurrentNewsReviewBatch,
  type NewsReviewBatch,
} from './news-review';

const PROCESSING_LEASE_MS = 16 * 60 * 1000;
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
  evidence_count?: number;
}

interface ManualAssessmentGenerationCycleRow {
  cycle_id: string;
  lead_id: string;
  processing_owner: string;
  base_version: number;
  call_state: ManualAssessmentGenerationCycleState['call_state'] | 'superseded';
  first_validation_code: string | null;
  first_validation_path: string | null;
  last_validation_code: string | null;
  last_validation_path: string | null;
  regeneration_consumed: number;
  validated_assessment_json: string | null;
  provider_failure_json: string | null;
}

function assessmentGenerationCycleState(
  row: ManualAssessmentGenerationCycleRow,
  acquiredCall: boolean,
): ManualAssessmentGenerationCycleState {
  if (row.call_state === 'superseded') throw new Error('assessment_generation_cycle_superseded');
  let validatedAssessment: ManualNewsProcessedAssessment | undefined;
  if (row.validated_assessment_json) {
    try {
      validatedAssessment = JSON.parse(row.validated_assessment_json) as ManualNewsProcessedAssessment;
    } catch {
      throw new Error('assessment_generation_state_invalid');
    }
  }
  let providerFailure: ManualNewsProviderFailureAudit | undefined;
  if (row.provider_failure_json) {
    try {
      const parsed = JSON.parse(row.provider_failure_json);
      if (isValidManualNewsProviderFailureAudit(parsed)) providerFailure = parsed;
    } catch {
      throw new Error('assessment_generation_state_invalid');
    }
  }
  return {
    cycle_id: row.cycle_id,
    base_version: Number(row.base_version),
    generation_revision: Number(row.regeneration_consumed) === 1 ? 2 : 1,
    call_state: row.call_state,
    acquired_call: acquiredCall,
    ...(row.first_validation_code ? { first_validation_code: row.first_validation_code } : {}),
    ...(row.first_validation_path ? { first_validation_path: row.first_validation_path } : {}),
    ...(row.last_validation_code ? { last_validation_code: row.last_validation_code } : {}),
    ...(row.last_validation_path ? { last_validation_path: row.last_validation_path } : {}),
    regeneration_consumed: Number(row.regeneration_consumed) === 1,
    ...(validatedAssessment ? { validated_assessment: validatedAssessment } : {}),
    ...(providerFailure ? { provider_failure: providerFailure } : {}),
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function createMutationNonce(action: string): string {
  return `${action}:${crypto.randomUUID()}`;
}

function validatedTransitionAuditMetadata(
  metadata: ManualLeadTransitionPatch['audit_metadata'],
): Record<string, unknown> {
  if (!metadata) return {};
  const allowed = new Set([
    'assessment_generation_attempts',
    'assessment_first_validation_code',
    'assessment_first_validation_path',
    'assessment_last_validation_code',
    'assessment_last_validation_path',
    'assessment_regeneration_trigger_code',
    'assessment_regeneration_trigger_path',
    'assessment_claim_contract',
    'assessment_source_fact_contract',
    'assessment_editorial_projection_contract',
    'assessment_evidence_disposition_contract',
    'assessment_verification_policy',
    'assessment_recovery',
    'provider_failure',
  ]);
  const generationAudit = manualNewsAssessmentGenerationAudit(metadata);
  const generation = metadata.assessment_generation_attempts !== undefined;
  const recovery = metadata.assessment_recovery === 'persisted_verified';
  const generationFields = [
    'assessment_generation_attempts',
    'assessment_first_validation_code',
    'assessment_first_validation_path',
    'assessment_last_validation_code',
    'assessment_last_validation_path',
    'assessment_regeneration_trigger_code',
    'assessment_regeneration_trigger_path',
  ] as const;
  if (Object.keys(metadata).some((key) => !allowed.has(key))
    || generation === recovery
    || (generation && !generationAudit)
    || (recovery && generationFields.some((field) => metadata[field] !== undefined))
    || metadata.assessment_claim_contract !== MANUAL_LEAD_GENERATED_CLAIM_CONTRACT
    || metadata.assessment_source_fact_contract !== MANUAL_LEAD_SOURCE_FACT_CONTRACT
    || metadata.assessment_editorial_projection_contract !== MANUAL_LEAD_EDITORIAL_PROJECTION_CONTRACT
    || metadata.assessment_evidence_disposition_contract !== MANUAL_LEAD_EVIDENCE_DISPOSITION_CONTRACT
    || metadata.assessment_verification_policy !== MANUAL_LEAD_VERIFICATION_POLICY_VERSION
    || (metadata.provider_failure !== undefined
      && !isValidManualNewsProviderFailureAudit(metadata.provider_failure))
    ) {
    throw new Error('invalid_transition_audit_metadata');
  }
  return { ...metadata };
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

async function loadCurrentProviderFailure(
  env: Env,
  leadId: string,
  version: number,
): Promise<ManualNewsProviderFailureAudit | null> {
  const rows = await env.DB.prepare(
    `/* manual_audit:current_provider_failure */ SELECT metadata_json
     FROM manual_news_lead_audit WHERE lead_id = ? AND resulting_version = ?
     ORDER BY id DESC LIMIT 10`,
  ).bind(leadId, version).all<{ metadata_json: string }>();
  for (const row of rows.results || []) {
    try {
      const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
      if (isValidManualNewsProviderFailureAudit(metadata.provider_failure)) {
        return metadata.provider_failure;
      }
    } catch {
      // Old or malformed audit metadata is never exposed as trusted diagnostics.
    }
  }
  return null;
}

async function loadCurrentAssessmentGenerationAudit(
  env: Env,
  lead: Pick<ManualLeadRow, 'id' | 'status' | 'version' | 'processing_owner'>,
): Promise<ManualNewsAssessmentGenerationAudit | null> {
  const leadId = lead.id;
  const row = await env.DB.prepare(
    `/* manual_generation:current_api */ SELECT first_validation_code, first_validation_path,
       last_validation_code, last_validation_path, regeneration_consumed,
       processing_owner, base_version, call_state
     FROM manual_news_assessment_generation_cycles_v2
     WHERE lead_id = ? AND is_current = 1 AND call_state <> 'superseded'`,
  ).bind(leadId).first<{
    first_validation_code: string | null;
    first_validation_path: string | null;
    last_validation_code: string | null;
    last_validation_path: string | null;
    regeneration_consumed: number;
    processing_owner: string;
    base_version: number;
    call_state: ManualAssessmentGenerationCycleRow['call_state'];
  }>();
  if (!row) return null;
  const terminal = ['recommended', 'needs_review', 'duplicate', 'rejected', 'failed'].includes(lead.status);
  if ((lead.processing_owner && row.processing_owner !== lead.processing_owner)
    || Number(row.base_version) > Number(lead.version)
    || (lead.status === 'verifying' && Number(row.base_version) !== Number(lead.version))
    || (terminal && !['validated', 'terminal'].includes(row.call_state))) return null;
  const attempts = Number(row.regeneration_consumed) === 1 ? 2 : 1;
  const firstCode = row.first_validation_code || 'not_validated';
  const lastCode = row.last_validation_code || firstCode;
  return manualNewsAssessmentGenerationAudit({
    assessment_generation_attempts: attempts,
    assessment_first_validation_code: firstCode,
    ...(row.first_validation_path ? { assessment_first_validation_path: row.first_validation_path } : {}),
    assessment_last_validation_code: lastCode,
    ...(row.last_validation_path ? { assessment_last_validation_path: row.last_validation_path } : {}),
    ...(attempts === 2 ? {
      assessment_regeneration_trigger_code: firstCode,
      ...(row.first_validation_path
        ? { assessment_regeneration_trigger_path: row.first_validation_path }
        : {}),
    } : {}),
  });
}

async function leadFromRow(env: Env, row: ManualLeadRow): Promise<ManualNewsLeadRecord> {
  const [evidence, providerFailure, assessmentGeneration] = await Promise.all([
    loadManualNewsEvidence(env, row.id),
    String(row.error_message || '').startsWith('manual_news_provider_error:')
      ? loadCurrentProviderFailure(env, row.id, Number(row.version))
      : Promise.resolve(null),
    loadCurrentAssessmentGenerationAudit(env, row),
  ]);
  const verified = await loadVerifiedManualAssessment(env, row.id, evidence);
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
    ...(assessmentGeneration ? { assessment_generation: assessmentGeneration } : {}),
    ...(providerFailure ? { provider_failure: providerFailure } : {}),
    processing_owner: row.processing_owner || null,
    processing_attempt: Number(row.processing_attempt || 0),
    processing_lease_until: row.processing_lease_until === null || row.processing_lease_until === undefined
      ? null
      : Number(row.processing_lease_until),
    assessment: verified?.assessment || null,
    evidence,
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

export async function listManualNewsLeads(env: Env, date: string): Promise<ManualNewsLeadSummary[]> {
  const result = await env.DB.prepare(
    `/* manual_lead:list_date */ SELECT lead.*,
       (SELECT COUNT(*) FROM manual_news_evidence evidence WHERE evidence.lead_id = lead.id) AS evidence_count
     FROM manual_news_leads lead
     WHERE review_date = ? ORDER BY created_at DESC LIMIT 50`,
  ).bind(date).all<ManualLeadRow>();
  return (result.results || []).map((row): ManualNewsLeadSummary => ({
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
    confirmed_batch_id: row.confirmed_batch_id,
    confirmed_at: row.confirmed_at,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    evidence_count: Number(row.evidence_count || 0),
  }));
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
  const generationCycle = await env.DB.prepare(
    `/* manual_generation:retry_current */ SELECT cycle_id
     FROM manual_news_assessment_generation_cycles_v2
     WHERE lead_id = ? AND is_current = 1 AND call_state <> 'superseded'`,
  ).bind(id).first<{ cycle_id: string }>();
  const previousGenerationCycleId = generationCycle?.cycle_id || null;
  assertManualLeadTransition(lead.status, 'validating');
  const nextVersion = expectedVersion + 1;
  const processingOwner = manualNewsLeadProcessingOwner(id, nextVersion);
  const mutationNonce = createMutationNonce('retry');
  const invalidationNonce = createMutationNonce('assessment_invalidate');
  const supersedeNonce = createMutationNonce('assessment_generation_supersede');
  const mutation = env.DB.prepare(
    `/* manual_lead:retry */ UPDATE manual_news_leads SET
       status = 'validating', version = version + 1, error_code = NULL, error_message = NULL,
       last_mutation_kind = 'retry', last_mutation_idempotency_key = ?,
       last_mutation_nonce = ?, processing_owner = ?, processing_lease_until = ?,
       updated_at = ?
     WHERE id = ? AND version = ? AND status IN ('failed', 'needs_review', 'rejected')`,
  ).bind(idempotencyKey, mutationNonce, processingOwner, now + PROCESSING_LEASE_MS, now, id, expectedVersion);
  const retryAudit = auditMutationStatement(env, {
    leadId: id, action: 'retry', mutationKind: 'retry', mutationNonce,
    fromStatus: lead.status, toStatus: 'validating', idempotencyKey,
    resultingVersion: nextVersion, createdAt: now,
  });
  const retryGuard = `EXISTS (
    SELECT 1 FROM manual_news_leads l
    WHERE l.id = ? AND l.version = ? AND l.status = 'validating'
      AND l.last_mutation_kind = 'retry' AND l.last_mutation_idempotency_key = ?
      AND l.last_mutation_nonce = ?
  )`;
  const results = await env.DB.batch([
    mutation,
    retryAudit,
    env.DB.prepare(
      `/* manual_verification:retry_invalidate_audit */ INSERT INTO manual_news_lead_audit (
         lead_id, action, from_status, to_status, idempotency_key, mutation_nonce,
         resulting_version, metadata_json, created_at
       ) SELECT ?, 'assessment_invalidate', 'validating', 'validating', NULL, ?, ?, ?, ?
       WHERE ${retryGuard} AND EXISTS (
         SELECT 1 FROM manual_news_assessment_verifications
         WHERE lead_id = ? AND status = 'active'
       )`,
    ).bind(
      id, invalidationNonce, nextVersion, JSON.stringify({
        reason: 'manual_retry', lead_version: nextVersion,
        previous_lead_version: expectedVersion,
        previous_processing_attempt: lead.processing_attempt,
        next_processing_owner: processingOwner,
        mutation_nonce: invalidationNonce,
      }), now,
      id, nextVersion, idempotencyKey, mutationNonce, id,
    ),
    env.DB.prepare(
      `/* manual_verification:retry_invalidate */ UPDATE manual_news_assessment_verifications
       SET status = 'invalidated', reason = 'manual_retry', invalidated_at = ?
       WHERE lead_id = ? AND status = 'active' AND ${retryGuard}`,
    ).bind(now, id, id, nextVersion, idempotencyKey, mutationNonce),
    env.DB.prepare(
      `/* manual_verification:retry_quarantine_item */ UPDATE items SET deleted_at = ?
       WHERE id = ? AND deleted_at IS NULL AND EXISTS (
         SELECT 1 FROM manual_news_assessment_verifications v
         WHERE v.lead_id = ? AND v.status = 'invalidated'
           AND v.reason = 'manual_retry' AND v.invalidated_at = ?
       ) AND ${retryGuard}`,
    ).bind(
      new Date(now).toISOString(), `blog:manual:${id}`, id, now,
      id, nextVersion, idempotencyKey, mutationNonce,
    ),
    env.DB.prepare(
      `/* manual_generation:retry_supersede */ UPDATE manual_news_assessment_generation_cycles_v2
       SET call_state = 'superseded', superseded_by_processing_owner = ?, is_current = 0,
           supersede_nonce = ?, updated_at = ?
       WHERE cycle_id = ? AND lead_id = ? AND call_state <> 'superseded'
         AND is_current = 1 AND supersede_nonce IS NULL AND ${retryGuard}`,
    ).bind(
      processingOwner, supersedeNonce, now, previousGenerationCycleId, id,
      id, nextVersion, idempotencyKey, mutationNonce,
    ),
    env.DB.prepare(
      `/* manual_generation:retry_supersede_audit */ INSERT INTO manual_news_lead_audit (
         lead_id, action, from_status, to_status, idempotency_key, mutation_nonce,
         resulting_version, metadata_json, created_at
       ) SELECT ?, 'assessment_generation_supersede', 'validating', 'validating', NULL, ?, ?, ?, ?
       WHERE ${retryGuard} AND EXISTS (
         SELECT 1 FROM manual_news_assessment_generation_cycles_v2 cycle
         WHERE cycle.cycle_id = ? AND cycle.lead_id = ? AND cycle.call_state = 'superseded'
           AND cycle.superseded_by_processing_owner = ? AND cycle.supersede_nonce = ?
       )`,
    ).bind(
      id, supersedeNonce, nextVersion,
      JSON.stringify({
        cycle_id: previousGenerationCycleId, superseded_by_processing_owner: processingOwner,
        previous_lead_version: expectedVersion, next_lead_version: nextVersion,
      }), now,
      id, nextVersion, idempotencyKey, mutationNonce,
      previousGenerationCycleId, id, processingOwner, supersedeNonce,
    ),
  ]) as Array<{ meta?: { changes?: number } }>;
  const changed = auditedMutationChanges(results, 0, 1);
  const invalidationAudit = Number(results[2]?.meta?.changes || 0);
  const invalidated = Number(results[3]?.meta?.changes || 0);
  if ((invalidated > 0 ? 1 : 0) !== invalidationAudit) {
    throw new Error('manual_verification_audit_causality_mismatch');
  }
  const superseded = Number(results[5]?.meta?.changes || 0);
  const supersedeAudit = Number(results[6]?.meta?.changes || 0);
  if (superseded !== supersedeAudit
    || (changed && (previousGenerationCycleId ? 1 : 0) !== superseded)
    || (!changed && superseded !== 0)) {
    throw new Error('assessment_generation_supersede_causality_mismatch');
  }
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
): Promise<number | null> {
  if (!owner || owner.length > 200) throw new Error('invalid_processing_owner');
  const result = await env.DB.prepare(
    `/* manual_lead:claim_processing */ UPDATE manual_news_leads SET
       processing_owner = ?, processing_attempt = processing_attempt + 1,
       processing_lease_until = ?, updated_at = ?
     WHERE id = ? AND confirmed_at IS NULL
       AND status IN ('submitted','validating','researching','extracting','verifying','clustering','scored')
       AND (processing_owner IS NULL OR processing_owner = ?
         OR processing_lease_until IS NULL OR processing_lease_until < ?)
     RETURNING processing_attempt`,
  ).bind(owner, now + PROCESSING_LEASE_MS, now, id, owner, now).first<{ processing_attempt: number }>();
  return result ? Number(result.processing_attempt) : null;
}

export async function failManualNewsLeadAfterExhaustion(
  env: Env,
  id: string,
  owner: string,
  processingAttempt: number,
  error: unknown,
  now = Date.now(),
): Promise<boolean> {
  const row = await env.DB.prepare(
    `/* manual_lead:owned_processing */ SELECT status, version FROM manual_news_leads
     WHERE id = ? AND processing_owner = ? AND processing_attempt = ?`,
  ).bind(id, owner, processingAttempt).first<{ status: ManualNewsLeadStatus; version: number }>();
  if (!row || !INTERMEDIATE_PROCESSING_STATUSES.includes(row.status)) return false;
  const providerFailure = manualNewsProviderFailureAudit(error);
  const message = providerFailure
    ? `manual_news_provider_error:${providerFailure.stage}:${providerFailure.provider_error_code}`
    : (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 500);
  const mutationNonce = createMutationNonce('processing_exhausted');
  const mutation = env.DB.prepare(
    `/* manual_lead:processing_exhausted */ UPDATE manual_news_leads SET
       status = 'failed', version = version + 1, error_code = 'processing_retry_exhausted',
       error_message = ?, last_mutation_kind = 'processing_exhausted',
       last_mutation_idempotency_key = ?, last_mutation_nonce = ?, processing_owner = NULL,
       processing_lease_until = NULL, updated_at = ?
     WHERE id = ? AND status = ? AND version = ? AND processing_owner = ? AND processing_attempt = ?`,
  ).bind(message, owner, mutationNonce, now, id, row.status, row.version, owner, processingAttempt);
  return await runAuditedMutation(env, mutation, auditMutationStatement(env, {
    leadId: id, action: 'processing_exhausted', mutationKind: 'processing_exhausted', mutationNonce,
    fromStatus: row.status, toStatus: 'failed',
    idempotencyKey: owner, resultingVersion: Number(row.version) + 1,
    metadata: {
      processing_owner: owner,
      processing_attempt: processingAttempt,
      ...(providerFailure ? { provider_failure: providerFailure } : {}),
    },
    createdAt: now,
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
    const currentGeneration = await env.DB.prepare(
      `/* manual_generation:stale_current */ SELECT cycle_id
       FROM manual_news_assessment_generation_cycles_v2
       WHERE lead_id = ? AND is_current = 1 AND call_state <> 'superseded'`,
    ).bind(row.id).first<{ cycle_id: string }>();
    const previousGenerationCycleId = currentGeneration?.cycle_id || null;
    const key = `stale-recovery:${row.version}`;
    const nextVersion = Number(row.version) + 1;
    const processingOwner = manualNewsLeadProcessingOwner(row.id, nextVersion);
    const mutationNonce = createMutationNonce('stale_recovery');
    const supersedeNonce = createMutationNonce('assessment_generation_stale_supersede');
    const generationSnapshotGuard = previousGenerationCycleId
      ? `AND EXISTS (
           SELECT 1 FROM manual_news_assessment_generation_cycles_v2 cycle
           WHERE cycle.cycle_id = ? AND cycle.lead_id = manual_news_leads.id
             AND cycle.is_current = 1 AND cycle.call_state <> 'superseded'
         )`
      : `AND NOT EXISTS (
           SELECT 1 FROM manual_news_assessment_generation_cycles_v2 cycle
           WHERE cycle.lead_id = manual_news_leads.id AND cycle.is_current = 1
             AND cycle.call_state <> 'superseded'
         )`;
    const mutation = env.DB.prepare(
      `/* manual_lead:recover_stale */ UPDATE manual_news_leads SET
         status = 'validating', version = version + 1, error_code = NULL, error_message = NULL,
         last_mutation_kind = 'stale_recovery', last_mutation_idempotency_key = ?,
         last_mutation_nonce = ?, processing_owner = ?, processing_lease_until = ?, updated_at = ?
       WHERE id = ? AND status = ? AND version = ?
         AND (processing_lease_until IS NULL OR processing_lease_until < ?)
         ${generationSnapshotGuard}`,
    ).bind(
      key, mutationNonce, processingOwner, now + PROCESSING_LEASE_MS, now,
      row.id, row.status, row.version, now,
      ...(previousGenerationCycleId ? [previousGenerationCycleId] : []),
    );
    const recoveryAudit = auditMutationStatement(env, {
      leadId: row.id, action: 'stale_recovery', mutationKind: 'stale_recovery', mutationNonce,
      fromStatus: row.status, toStatus: 'validating',
      idempotencyKey: key, resultingVersion: nextVersion, createdAt: now,
    });
    const recoveredLeadGuard = `EXISTS (
      SELECT 1 FROM manual_news_leads lead
      WHERE lead.id = ? AND lead.version = ? AND lead.status = 'validating'
        AND lead.last_mutation_kind = 'stale_recovery'
        AND lead.last_mutation_idempotency_key = ? AND lead.last_mutation_nonce = ?
        AND lead.processing_owner = ?
    )`;
    const results = await env.DB.batch([
      mutation,
      recoveryAudit,
      env.DB.prepare(
        `/* manual_generation:stale_supersede */ UPDATE manual_news_assessment_generation_cycles_v2
         SET call_state = 'superseded', superseded_by_processing_owner = ?, is_current = 0,
             supersede_nonce = ?, updated_at = ?
         WHERE cycle_id = ? AND lead_id = ? AND is_current = 1
           AND call_state <> 'superseded' AND supersede_nonce IS NULL
           AND ${recoveredLeadGuard}`,
      ).bind(
        processingOwner, supersedeNonce, now, previousGenerationCycleId, row.id,
        row.id, nextVersion, key, mutationNonce, processingOwner,
      ),
      env.DB.prepare(
        `/* manual_generation:stale_supersede_audit */ INSERT INTO manual_news_lead_audit (
           lead_id, action, from_status, to_status, idempotency_key, mutation_nonce,
           resulting_version, metadata_json, created_at
         ) SELECT ?, 'assessment_generation_supersede', 'validating', 'validating', NULL, ?, ?, ?, ?
         WHERE ${recoveredLeadGuard} AND EXISTS (
           SELECT 1 FROM manual_news_assessment_generation_cycles_v2 cycle
           WHERE cycle.cycle_id = ? AND cycle.lead_id = ? AND cycle.call_state = 'superseded'
             AND cycle.is_current = 0 AND cycle.superseded_by_processing_owner = ?
             AND cycle.supersede_nonce = ?
         )`,
      ).bind(
        row.id, supersedeNonce, nextVersion, JSON.stringify({
          cycle_id: previousGenerationCycleId,
          superseded_by_processing_owner: processingOwner,
          previous_lead_version: row.version,
          next_lead_version: nextVersion,
          recovery_nonce: mutationNonce,
        }), now,
        row.id, nextVersion, key, mutationNonce, processingOwner,
        previousGenerationCycleId, row.id, processingOwner, supersedeNonce,
      ),
    ]) as Array<{ meta?: { changes?: number } }>;
    const changed = auditedMutationChanges(results, 0, 1);
    const superseded = Number(results[2]?.meta?.changes || 0);
    const supersedeAudit = Number(results[3]?.meta?.changes || 0);
    const expectedSupersede = changed && previousGenerationCycleId ? 1 : 0;
    if (superseded !== expectedSupersede || supersedeAudit !== expectedSupersede) {
      throw new Error('assessment_generation_stale_supersede_causality_mismatch');
    }
    if (!changed) continue;
    const lead = await getManualNewsLead(env, row.id);
    if (lead) recovered.push(lead);
  }
  return recovered;
}

export class D1ManualLeadProcessingStore implements ManualLeadProcessingStore {
  constructor(
    private readonly env: Env,
    private readonly processingOwner?: string,
    private readonly processingAttempt?: number,
  ) {}

  private fence(): { owner: string; attempt: number } {
    if (!this.processingOwner) throw new Error('processing_owner_required');
    if (!Number.isInteger(this.processingAttempt) || Number(this.processingAttempt) <= 0) {
      throw new Error('processing_attempt_required');
    }
    return { owner: this.processingOwner, attempt: Number(this.processingAttempt) };
  }

  getLead(id: string): Promise<ManualNewsLeadRecord | null> {
    return getManualNewsLead(this.env, id);
  }

  async hasPersistedAssessment(id: string): Promise<boolean> {
    const row = await this.env.DB.prepare(
      `/* manual_assessment:exists */ SELECT EXISTS (
         SELECT 1 FROM manual_news_event_assessments WHERE lead_id = ?
       ) AS present`,
    ).bind(id).first<{ present: number }>();
    return Number(row?.present || 0) === 1;
  }

  private async currentAssessmentGenerationCycle(
    id: string,
    expectedVersion: number,
  ): Promise<ManualAssessmentGenerationCycleState | null> {
    const { owner, attempt } = this.fence();
    const row = await this.env.DB.prepare(
      `/* manual_generation:current_fenced */ SELECT cycle.*
       FROM manual_news_leads lead
       JOIN manual_news_assessment_generation_cycles_v2 cycle
         ON cycle.lead_id = lead.id AND cycle.is_current = 1
       WHERE lead.id = ? AND lead.version = ? AND lead.status = 'verifying'
         AND lead.processing_owner = ? AND lead.processing_attempt = ?
         AND cycle.processing_owner = ? AND cycle.base_version = ?
         AND cycle.call_state <> 'superseded'`,
    ).bind(id, expectedVersion, owner, attempt, owner, expectedVersion)
      .first<ManualAssessmentGenerationCycleRow>();
    return row ? assessmentGenerationCycleState(row, false) : null;
  }

  async beginAssessmentGenerationCycle(
    id: string,
    expectedVersion: number,
  ): Promise<ManualAssessmentGenerationCycleState> {
    const existing = await this.currentAssessmentGenerationCycle(id, expectedVersion);
    if (existing) return existing;
    const { owner, attempt } = this.fence();
    const cycleId = `mag:${id}:${expectedVersion}:${(await sha256Hex(owner)).slice(0, 16)}`;
    const now = Date.now();
    const mutationNonce = createMutationNonce('assessment_generation_start');
    const leadGuard = `EXISTS (
      SELECT 1 FROM manual_news_leads lead
      WHERE lead.id = ? AND lead.version = ? AND lead.status = 'verifying'
        AND lead.processing_owner = ? AND lead.processing_attempt = ?
    )`;
    const statements = [
      this.env.DB.prepare(
        `/* manual_generation:insert_cycle */ INSERT OR IGNORE INTO manual_news_assessment_generation_cycles_v2 (
           cycle_id, lead_id, processing_owner, base_version, call_state,
           regeneration_consumed, is_current, start_nonce, created_at, updated_at
         ) SELECT ?, ?, ?, ?, 'initial_started', 0, 1, ?, ?, ? WHERE ${leadGuard}
           AND NOT EXISTS (SELECT 1 FROM manual_news_assessment_generation_cycles_v2 current
             WHERE current.lead_id = ? AND current.is_current = 1)`,
      ).bind(
        cycleId, id, owner, expectedVersion, mutationNonce, now, now,
        id, expectedVersion, owner, attempt,
        id,
      ),
      this.env.DB.prepare(
        `/* manual_generation:insert_revision */ INSERT OR IGNORE INTO manual_news_assessment_generation_revisions_v2 (
           cycle_id, generation_revision, call_kind, call_state, start_nonce, created_at
         ) SELECT ?, 1, 'initial', 'started', ?, ? WHERE ${leadGuard}
           AND EXISTS (SELECT 1 FROM manual_news_assessment_generation_cycles_v2 cycle
             WHERE cycle.cycle_id = ? AND cycle.call_state = 'initial_started'
               AND cycle.is_current = 1 AND cycle.start_nonce = ?)`,
      ).bind(
        cycleId, mutationNonce, now,
        id, expectedVersion, owner, attempt,
        cycleId, mutationNonce,
      ),
      this.env.DB.prepare(
        `/* manual_generation:start_audit */ INSERT INTO manual_news_lead_audit (
           lead_id, action, from_status, to_status, idempotency_key, mutation_nonce,
           resulting_version, metadata_json, created_at
         ) SELECT ?, 'assessment_generation_start_1', 'verifying', 'verifying', NULL, ?, ?, ?, ?
         WHERE ${leadGuard} AND EXISTS (
           SELECT 1 FROM manual_news_assessment_generation_revisions_v2 revision
           WHERE revision.cycle_id = ? AND revision.generation_revision = 1
             AND revision.call_state = 'started' AND revision.start_nonce = ?
         ) AND EXISTS (
           SELECT 1 FROM manual_news_assessment_generation_cycles_v2 cycle
           WHERE cycle.cycle_id = ? AND cycle.start_nonce = ? AND cycle.is_current = 1
         )`,
      ).bind(
        id, mutationNonce, expectedVersion, JSON.stringify({
          cycle_id: cycleId, generation_revision: 1, call_kind: 'initial',
          processing_owner: owner, processing_attempt: attempt, base_version: expectedVersion,
        }), now,
        id, expectedVersion, owner, attempt,
        cycleId, mutationNonce,
        cycleId, mutationNonce,
      ),
    ];
    const results = await this.env.DB.batch(statements) as Array<{ meta?: { changes?: number } }>;
    const claimed = Number(results[0]?.meta?.changes || 0);
    if (claimed === 1) {
      if (Number(results[1]?.meta?.changes || 0) !== 1
        || Number(results[2]?.meta?.changes || 0) !== 1) {
        throw new Error('assessment_generation_start_causality_mismatch');
      }
      const row = await this.currentAssessmentGenerationCycle(id, expectedVersion);
      if (!row) throw new Error('assessment_generation_state_missing');
      return { ...row, acquired_call: true };
    }
    if (results.some((entry) => Number(entry?.meta?.changes || 0) !== 0)) {
      throw new Error('assessment_generation_start_causality_mismatch');
    }
    const winner = await this.currentAssessmentGenerationCycle(id, expectedVersion);
    if (winner) return winner;
    throw new Error('stale_processing_owner');
  }

  async recordAssessmentGenerationValidation(
    id: string,
    expectedVersion: number,
    result: ManualAssessmentGenerationValidationResult,
  ): Promise<ManualAssessmentGenerationCycleState> {
    const { owner, attempt } = this.fence();
    const safeFailure = manualLeadAssessmentValidationFailure(new Error(
      `${result.validation_code}${result.validation_path ? `:${result.validation_path}` : ''}`,
    ));
    if (!['valid', 'not_validated'].includes(result.validation_code)
      && (safeFailure.code !== result.validation_code || safeFailure.path !== result.validation_path)) {
      throw new Error('assessment_generation_validation_invalid');
    }
    if ((result.validation_code === 'valid' && (!result.validated_assessment || result.validation_path))
      || (result.validation_code === 'not_validated' && result.validation_path)) {
      throw new Error('assessment_generation_validation_invalid');
    }
    if (result.generation_revision === 2 && result.regeneratable) {
      throw new Error('assessment_generation_validation_invalid');
    }
    if (result.provider_failure && !isValidManualNewsProviderFailureAudit(result.provider_failure)) {
      throw new Error('assessment_generation_validation_invalid');
    }
    const current = await this.currentAssessmentGenerationCycle(id, expectedVersion);
    if (!current) throw new Error('stale_processing_owner');
    if (current.generation_revision !== result.generation_revision
      || !['initial_started', 'regeneration_started'].includes(current.call_state)) {
      throw new Error('assessment_generation_revision_conflict');
    }
    const now = Date.now();
    const nextState = result.validation_code === 'valid'
      ? 'validated'
      : (result.generation_revision === 1 && result.regeneratable ? 'regeneration_ready' : 'terminal');
    const revisionState = result.validation_code === 'valid'
      ? 'validated'
      : (result.provider_failure ? 'provider_failed' : 'validation_failed');
    const mutationNonce = createMutationNonce(`assessment_generation_result_${result.generation_revision}`);
    const providerFailureJson = result.provider_failure ? JSON.stringify(result.provider_failure) : null;
    const assessmentJson = result.validated_assessment ? JSON.stringify(result.validated_assessment) : null;
    const guard = `EXISTS (
      SELECT 1 FROM manual_news_leads lead
      WHERE lead.id = ? AND lead.version = ? AND lead.status = 'verifying'
        AND lead.processing_owner = ? AND lead.processing_attempt = ?
    )`;
    const statements = [
      this.env.DB.prepare(
        `/* manual_generation:complete_revision */ UPDATE manual_news_assessment_generation_revisions_v2
         SET call_state = ?, validation_code = ?, validation_path = ?,
             validated_assessment_json = ?, provider_failure_json = ?, result_nonce = ?, completed_at = ?
         WHERE cycle_id = ? AND generation_revision = ? AND call_state = 'started'
           AND result_nonce IS NULL AND ${guard}
           AND EXISTS (SELECT 1 FROM manual_news_assessment_generation_cycles_v2 cycle
             WHERE cycle.cycle_id = ? AND cycle.is_current = 1
               AND cycle.processing_owner = ? AND cycle.base_version = ?)`,
      ).bind(
        revisionState, result.validation_code, result.validation_path || null,
        assessmentJson, providerFailureJson, mutationNonce, now,
        current.cycle_id, result.generation_revision,
        id, expectedVersion, owner, attempt,
        current.cycle_id, owner, expectedVersion,
      ),
      this.env.DB.prepare(
        `/* manual_generation:update_cycle */ UPDATE manual_news_assessment_generation_cycles_v2
         SET call_state = ?,
             first_validation_code = CASE WHEN ? = 1 THEN ? ELSE first_validation_code END,
             first_validation_path = CASE WHEN ? = 1 THEN ? ELSE first_validation_path END,
             last_validation_code = ?, last_validation_path = ?,
             validated_assessment_json = ?, provider_failure_json = ?,
             last_result_nonce = ?, updated_at = ?
         WHERE cycle_id = ? AND call_state = ? AND is_current = 1
           AND processing_owner = ? AND base_version = ?
           AND ${guard}
           AND EXISTS (SELECT 1 FROM manual_news_assessment_generation_revisions_v2 revision
             WHERE revision.cycle_id = ? AND revision.generation_revision = ?
               AND revision.call_state = ? AND revision.result_nonce = ?)`,
      ).bind(
        nextState,
        result.generation_revision, result.validation_code,
        result.generation_revision, result.validation_path || null,
        result.validation_code, result.validation_path || null,
        assessmentJson, providerFailureJson, mutationNonce, now,
        current.cycle_id, current.call_state, owner, expectedVersion,
        id, expectedVersion, owner, attempt,
        current.cycle_id, result.generation_revision, revisionState, mutationNonce,
      ),
      this.env.DB.prepare(
        `/* manual_generation:result_audit */ INSERT INTO manual_news_lead_audit (
           lead_id, action, from_status, to_status, idempotency_key, mutation_nonce,
           resulting_version, metadata_json, created_at
         ) SELECT ?, ?, 'verifying', 'verifying', NULL, ?, ?, ?, ? WHERE ${guard}
           AND EXISTS (SELECT 1 FROM manual_news_assessment_generation_cycles_v2 cycle
             WHERE cycle.cycle_id = ? AND cycle.is_current = 1
               AND cycle.last_result_nonce = ?)
           AND EXISTS (SELECT 1 FROM manual_news_assessment_generation_revisions_v2 revision
             WHERE revision.cycle_id = ? AND revision.generation_revision = ?
               AND revision.call_state = ? AND revision.validation_code = ?
               AND revision.result_nonce = ?)`,
      ).bind(
        id, `assessment_generation_result_${result.generation_revision}`, mutationNonce,
        expectedVersion, JSON.stringify({
          cycle_id: current.cycle_id, generation_revision: result.generation_revision,
          validation_code: result.validation_code,
          ...(result.validation_path ? { validation_path: result.validation_path } : {}),
          processing_owner: owner, processing_attempt: attempt, base_version: expectedVersion,
          ...(result.provider_failure ? { provider_failure: result.provider_failure } : {}),
        }), now,
        id, expectedVersion, owner, attempt,
        current.cycle_id, mutationNonce,
        current.cycle_id, result.generation_revision, revisionState, result.validation_code, mutationNonce,
      ),
    ];
    const results = await this.env.DB.batch(statements) as Array<{ meta?: { changes?: number } }>;
    const changes = results.map((entry) => Number(entry?.meta?.changes || 0));
    if (changes.every((value) => value === 0)) {
      const winner = await this.currentAssessmentGenerationCycle(id, expectedVersion);
      if (winner && winner.generation_revision === result.generation_revision
        && winner.call_state === nextState) return winner;
      throw new Error('stale_processing_owner');
    }
    if (changes.some((value) => value !== 1)) {
      throw new Error('assessment_generation_result_causality_mismatch');
    }
    const updated = await this.currentAssessmentGenerationCycle(id, expectedVersion);
    if (!updated) throw new Error('assessment_generation_state_missing');
    return updated;
  }

  async consumeAssessmentRegeneration(
    id: string,
    expectedVersion: number,
  ): Promise<ManualAssessmentGenerationCycleState> {
    const current = await this.currentAssessmentGenerationCycle(id, expectedVersion);
    if (!current) throw new Error('stale_processing_owner');
    if (current.call_state !== 'regeneration_ready') return current;
    const { owner, attempt } = this.fence();
    const now = Date.now();
    const mutationNonce = createMutationNonce('assessment_regeneration_consume');
    const guard = `EXISTS (
      SELECT 1 FROM manual_news_leads lead
      WHERE lead.id = ? AND lead.version = ? AND lead.status = 'verifying'
        AND lead.processing_owner = ? AND lead.processing_attempt = ?
    )`;
    const statements = [
      this.env.DB.prepare(
        `/* manual_generation:consume_regeneration */ UPDATE manual_news_assessment_generation_cycles_v2
         SET regeneration_consumed = 1, call_state = 'regeneration_started',
             regeneration_nonce = ?, updated_at = ?
         WHERE cycle_id = ? AND call_state = 'regeneration_ready' AND regeneration_consumed = 0
           AND is_current = 1 AND processing_owner = ? AND base_version = ?
           AND regeneration_nonce IS NULL AND ${guard}`,
      ).bind(mutationNonce, now, current.cycle_id, owner, expectedVersion, id, expectedVersion, owner, attempt),
      this.env.DB.prepare(
        `/* manual_generation:insert_regeneration_revision */ INSERT OR IGNORE INTO manual_news_assessment_generation_revisions_v2 (
           cycle_id, generation_revision, call_kind, call_state, start_nonce, created_at
         ) SELECT ?, 2, 'regeneration', 'started', ?, ? WHERE ${guard}
           AND EXISTS (SELECT 1 FROM manual_news_assessment_generation_cycles_v2 cycle
             WHERE cycle.cycle_id = ? AND cycle.call_state = 'regeneration_started'
               AND cycle.regeneration_consumed = 1 AND cycle.is_current = 1
               AND cycle.regeneration_nonce = ?)`,
      ).bind(
        current.cycle_id, mutationNonce, now,
        id, expectedVersion, owner, attempt,
        current.cycle_id, mutationNonce,
      ),
      this.env.DB.prepare(
        `/* manual_generation:regeneration_audit */ INSERT INTO manual_news_lead_audit (
           lead_id, action, from_status, to_status, idempotency_key, mutation_nonce,
           resulting_version, metadata_json, created_at
         ) SELECT ?, 'assessment_generation_start_2', 'verifying', 'verifying', NULL, ?, ?, ?, ?
         WHERE ${guard} AND EXISTS (
           SELECT 1 FROM manual_news_assessment_generation_revisions_v2 revision
           WHERE revision.cycle_id = ? AND revision.generation_revision = 2
             AND revision.call_state = 'started' AND revision.start_nonce = ?
         ) AND EXISTS (
           SELECT 1 FROM manual_news_assessment_generation_cycles_v2 cycle
           WHERE cycle.cycle_id = ? AND cycle.regeneration_nonce = ? AND cycle.is_current = 1
         )`,
      ).bind(
        id, mutationNonce, expectedVersion, JSON.stringify({
          cycle_id: current.cycle_id, generation_revision: 2, call_kind: 'regeneration',
          processing_owner: owner, processing_attempt: attempt, base_version: expectedVersion,
        }), now,
        id, expectedVersion, owner, attempt,
        current.cycle_id, mutationNonce,
        current.cycle_id, mutationNonce,
      ),
    ];
    const results = await this.env.DB.batch(statements) as Array<{ meta?: { changes?: number } }>;
    const consumed = Number(results[0]?.meta?.changes || 0);
    if (consumed === 1) {
      if (Number(results[1]?.meta?.changes || 0) !== 1
        || Number(results[2]?.meta?.changes || 0) !== 1) {
        throw new Error('assessment_regeneration_causality_mismatch');
      }
      const updated = await this.currentAssessmentGenerationCycle(id, expectedVersion);
      if (!updated) throw new Error('assessment_generation_state_missing');
      return { ...updated, acquired_call: true };
    }
    if (results.some((entry) => Number(entry?.meta?.changes || 0) !== 0)) {
      throw new Error('assessment_regeneration_causality_mismatch');
    }
    const winner = await this.currentAssessmentGenerationCycle(id, expectedVersion);
    if (winner) return winner;
    throw new Error('stale_processing_owner');
  }

  async transition(
    id: string,
    from: ManualNewsLeadStatus,
    to: ManualNewsLeadStatus,
    patch: ManualLeadTransitionPatch = {},
  ): Promise<ManualNewsLeadRecord> {
    assertManualLeadTransition(from, to);
    const now = Date.now();
    const { owner, attempt } = this.fence();
    const current = await this.env.DB.prepare(
      `/* manual_lead:transition_version */ SELECT version FROM manual_news_leads
       WHERE id = ? AND status = ? AND processing_owner = ? AND processing_attempt = ?`,
    ).bind(id, from, owner, attempt).first<{ version: number }>();
    if (!current) throw new Error('lead_transition_conflict');
    const terminal = ['recommended', 'needs_review', 'duplicate', 'rejected', 'failed'].includes(to);
    const mutationNonce = createMutationNonce('status_transition');
    const auditMetadata = validatedTransitionAuditMetadata(patch.audit_metadata);
    const mutation = this.env.DB.prepare(
      `/* manual_lead:transition */ UPDATE manual_news_leads SET
         status = ?, version = version + 1, error_code = ?, error_message = ?,
         last_mutation_kind = 'status_transition', last_mutation_idempotency_key = NULL,
         last_mutation_nonce = ?,
         processing_owner = ?, processing_lease_until = ?, updated_at = ?
       WHERE id = ? AND status = ? AND version = ?
         AND processing_owner = ? AND processing_attempt = ?`,
    ).bind(
      to, patch.error_code ?? null, patch.error_message ?? null, mutationNonce,
      terminal ? null : owner, terminal ? null : now + PROCESSING_LEASE_MS,
      now, id, from, Number(current.version), owner, attempt,
    );
    const changed = await runAuditedMutation(this.env, mutation, auditMutationStatement(this.env, {
      leadId: id, action: 'status_transition', mutationKind: 'status_transition', mutationNonce,
      fromStatus: from, toStatus: to,
      resultingVersion: Number(current.version) + 1, metadata: auditMetadata, createdAt: now,
    }));
    if (!changed) throw new Error('lead_transition_conflict');
    const updated = await getManualNewsLead(this.env, id);
    if (!updated) throw new Error('manual_news_lead_not_found');
    return updated;
  }

  async replaceEvidence(
    id: string,
    expectedVersion: number,
    evidence: readonly ManualNewsEvidence[],
  ): Promise<void> {
    const { owner, attempt } = this.fence();
    const now = Date.now();
    const invalidationNonce = createMutationNonce('assessment_invalidate');
    const replacementNonce = createMutationNonce('evidence_replace');
    const evidenceDigest = await createManualEvidenceDigest(evidence);
    const leadGuard = `EXISTS (
      SELECT 1 FROM manual_news_leads l
      WHERE l.id = ? AND l.version = ? AND l.processing_owner = ? AND l.processing_attempt = ?
        AND l.status = 'extracting'
    )`;
    const ownerGuardStatement = this.env.DB.prepare(
        `/* manual_evidence:owner_guard */ UPDATE manual_news_leads SET updated_at = updated_at
         WHERE id = ? AND version = ? AND processing_owner = ? AND processing_attempt = ?
           AND status = 'extracting'`,
      ).bind(id, expectedVersion, owner, attempt);
    const invalidationStatement = this.env.DB.prepare(
        `/* manual_verification:invalidate_for_evidence */ UPDATE manual_news_assessment_verifications
         SET status = 'invalidated', reason = 'evidence_replaced', invalidated_at = ?,
             invalidation_nonce = ?
         WHERE lead_id = ? AND status = 'active' AND ${leadGuard}`,
      ).bind(now, invalidationNonce, id, id, expectedVersion, owner, attempt);
    const invalidationAuditStatement = this.env.DB.prepare(
        `/* manual_verification:invalidate_audit */ INSERT INTO manual_news_lead_audit (
           lead_id, action, from_status, to_status, idempotency_key, mutation_nonce,
           resulting_version, metadata_json, created_at
         ) SELECT ?, 'assessment_invalidate', 'extracting', 'extracting', NULL, ?, ?, ?, ?
         WHERE ${leadGuard} AND EXISTS (
           SELECT 1 FROM manual_news_assessment_verifications v
           WHERE v.lead_id = ? AND v.status = 'invalidated'
             AND v.reason = 'evidence_replaced' AND v.invalidation_nonce = ?
         )`,
      ).bind(
        id, invalidationNonce, expectedVersion, JSON.stringify({
          reason: 'evidence_replaced', processing_owner: owner,
          processing_attempt: attempt, lead_version: expectedVersion,
          mutation_nonce: invalidationNonce,
        }), now,
        id, expectedVersion, owner, attempt, id, invalidationNonce,
      );
    const quarantineStatement = this.env.DB.prepare(
        `/* manual_verification:evidence_quarantine_item */ UPDATE items SET deleted_at = ?
         WHERE id = ? AND deleted_at IS NULL AND EXISTS (
           SELECT 1 FROM manual_news_assessment_verifications v
           WHERE v.lead_id = ? AND v.status = 'invalidated'
             AND v.reason = 'evidence_replaced' AND v.invalidation_nonce = ?
         ) AND ${leadGuard}`,
      ).bind(
        new Date(now).toISOString(), `blog:manual:${id}`, id, invalidationNonce,
        id, expectedVersion, owner, attempt,
      );
    const deleteEvidenceStatement = this.env.DB.prepare(
        `/* manual_evidence:delete */ DELETE FROM manual_news_evidence
         WHERE lead_id = ? AND ${leadGuard}`,
      ).bind(id, id, expectedVersion, owner, attempt);
    const insertEvidenceStatements = evidence.map((item) => this.env.DB.prepare(
        `/* manual_evidence:insert */ INSERT INTO manual_news_evidence (
           lead_id, evidence_id, response_key_id, url, source_type, publisher, published_at, retrieved_at,
           title, excerpt, claims_supported_json, fetch_audit_json, reliable
         ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${leadGuard}`,
      ).bind(
        id, item.id, item.response_key_id || '', item.url, item.source_type, item.publisher,
        item.published_at, item.retrieved_at,
        item.title, item.excerpt, JSON.stringify(item.claims_supported), JSON.stringify(item.fetch_audit || null),
        item.reliable ? 1 : 0, id, expectedVersion, owner, attempt,
      ));
    const replacementAuditStatement = this.env.DB.prepare(
        `/* manual_evidence:replace_audit */ INSERT INTO manual_news_lead_audit (
           lead_id, action, from_status, to_status, idempotency_key, mutation_nonce,
           resulting_version, metadata_json, created_at
         ) SELECT ?, 'evidence_replace', 'extracting', 'extracting', NULL, ?, ?, ?, ?
         WHERE ${leadGuard} AND (
           SELECT COUNT(*) FROM manual_news_evidence WHERE lead_id = ?
         ) = ?`,
      ).bind(
        id, replacementNonce, expectedVersion, JSON.stringify({
          processing_owner: owner,
          processing_attempt: attempt,
          lead_version: expectedVersion,
          evidence_digest: evidenceDigest,
          mutation_nonce: replacementNonce,
        }), now,
        id, expectedVersion, owner, attempt,
        id, evidence.length,
      );
    const statements = [
      ownerGuardStatement,
      invalidationStatement,
      invalidationAuditStatement,
      quarantineStatement,
      deleteEvidenceStatement,
      ...insertEvidenceStatements,
      replacementAuditStatement,
    ];
    const results = await this.env.DB.batch(statements) as Array<{ meta?: { changes?: number } }>;
    const resultIndex = {
      ownerGuard: 0,
      invalidation: 1,
      invalidationAudit: 2,
      quarantine: 3,
      evidenceDelete: 4,
      evidenceInsertStart: 5,
      evidenceReplaceAudit: 5 + insertEvidenceStatements.length,
    } as const;
    const changes = (index: number): number => Number(results[index]?.meta?.changes || 0);
    if (changes(resultIndex.ownerGuard) !== 1) throw new Error('stale_processing_owner');
    const invalidationAuditChanges = changes(resultIndex.invalidationAudit);
    const invalidatedChanges = changes(resultIndex.invalidation);
    if (![0, 1].includes(invalidationAuditChanges)
      || ![0, 1].includes(invalidatedChanges)
      || invalidationAuditChanges !== invalidatedChanges) {
      throw new Error('manual_verification_audit_causality_mismatch');
    }
    const quarantineChanges = changes(resultIndex.quarantine);
    if (![0, 1].includes(quarantineChanges) || quarantineChanges > invalidatedChanges) {
      throw new Error('manual_verification_quarantine_causality_mismatch');
    }
    if (!Number.isInteger(changes(resultIndex.evidenceDelete))
      || changes(resultIndex.evidenceDelete) < 0) {
      throw new Error('manual_evidence_delete_result_invalid');
    }
    for (let offset = 0; offset < insertEvidenceStatements.length; offset += 1) {
      if (changes(resultIndex.evidenceInsertStart + offset) !== 1) {
        throw new Error('manual_evidence_write_causality_mismatch');
      }
    }
    if (changes(resultIndex.evidenceReplaceAudit) !== 1) {
      throw new Error('manual_evidence_write_causality_mismatch');
    }
  }

  async listRecentPriorEvents(date: string, excludeLeadId: string): Promise<ManualLeadPriorEvent[]> {
    const manual = await this.env.DB.prepare(
      `/* manual_assessment:recent_prior_events */ SELECT a.event_key, l.review_date, l.id AS lead_id
       FROM manual_news_event_assessments a
       JOIN manual_news_assessment_verifications v
         ON v.lead_id = a.lead_id AND v.assessment_version = a.assessment_version AND v.status = 'active'
       JOIN manual_news_leads l ON l.id = a.lead_id
       WHERE l.id <> ? AND l.review_date BETWEEN date(?, '-14 days') AND ?
      `,
    ).bind(excludeLeadId, date, date)
      .all<{ event_key: string; review_date: string; lead_id: string }>();
    const verifiedManual: ManualLeadPriorEvent[] = [];
    for (const row of manual.results || []) {
      const verified = await loadVerifiedManualAssessment(this.env, row.lead_id);
      if (verified?.assessment.event_key === row.event_key) verifiedManual.push({
        ...row,
        verification_digest: verified.record.canonical_digest,
        title: verified.assessment.title,
        summary: verified.assessment.summary,
        claims: verified.assessment.claims,
      });
    }
    const items = await this.env.DB.prepare(
      `/* manual_assessment:recent_non_manual_items */ SELECT
         json_extract(extra, '$.event_fingerprint') AS event_key,
         substr(COALESCE(published_at, scraped_at), 1, 10) AS review_date, id AS lead_id
       FROM items
       WHERE id <> ? AND json_extract(extra, '$.event_fingerprint') IS NOT NULL
         AND COALESCE(source_ref, '') <> 'manual_lead'
         AND substr(COALESCE(published_at, scraped_at), 1, 10) BETWEEN date(?, '-14 days') AND ?`,
    ).bind(`blog:manual:${excludeLeadId}`, date, date)
      .all<{ event_key: string; review_date: string; lead_id: string }>();
    return [...verifiedManual, ...(items.results || [])].filter((item) => !!item.event_key);
  }

  async findPriorEventsByEventKey(eventKey: string, excludeLeadId: string): Promise<ManualLeadPriorEvent[]> {
    const manual = await this.env.DB.prepare(
      `/* manual_assessment:exact_event_history */ SELECT a.event_key, l.review_date, l.id AS lead_id
       FROM manual_news_event_assessments a
       JOIN manual_news_assessment_verifications v
         ON v.lead_id = a.lead_id AND v.assessment_version = a.assessment_version AND v.status = 'active'
       JOIN manual_news_leads l ON l.id = a.lead_id
       WHERE a.event_key = ? AND l.id <> ?
      `,
    ).bind(eventKey, excludeLeadId)
      .all<{ event_key: string; review_date: string; lead_id: string }>();
    const verifiedManual: ManualLeadPriorEvent[] = [];
    for (const row of manual.results || []) {
      const verified = await loadVerifiedManualAssessment(this.env, row.lead_id);
      if (verified?.assessment.event_key === eventKey) verifiedManual.push({
        ...row,
        verification_digest: verified.record.canonical_digest,
        title: verified.assessment.title,
        summary: verified.assessment.summary,
        claims: verified.assessment.claims,
      });
    }
    const items = await this.env.DB.prepare(
      `/* manual_assessment:exact_non_manual_items */ SELECT
         json_extract(extra, '$.event_fingerprint') AS event_key,
         substr(COALESCE(published_at, scraped_at), 1, 10) AS review_date, id AS lead_id
       FROM items
       WHERE json_extract(extra, '$.event_fingerprint') = ? AND id <> ?
         AND COALESCE(source_ref, '') <> 'manual_lead'`,
    ).bind(eventKey, `blog:manual:${excludeLeadId}`)
      .all<{ event_key: string; review_date: string; lead_id: string }>();
    return [...verifiedManual, ...(items.results || [])].filter((item) => !!item.event_key);
  }

  async saveVerifiedAssessment(
    id: string,
    expectedVersion: number,
    assessment: ManualNewsProcessedAssessment,
    verificationRaw: unknown,
  ): Promise<{ assessment_version: number }> {
    const { owner, attempt } = this.fence();
    const verificationKeys = manualNewsVerificationKeyring(this.env);
    const responseKeys = manualNewsResponseKeyring(this.env);
    const evidence = await loadManualNewsEvidence(this.env, id);
    const priorEvents = assessment.matched_event_key
      ? await this.findPriorEventsByEventKey(assessment.matched_event_key, id)
      : [];
    const priorEventKeys = priorEvents.map((event) => event.event_key);
    const validatedAssessment = validateManualNewsProcessedAssessment(assessment, evidence, priorEventKeys);
    const verification = validateManualLeadFactVerification(
      verificationRaw, validatedAssessment, evidence, { prior_events: priorEvents, persisted: true },
    );
    if (!['supported', 'conflicted'].includes(verification.overall_verdict)) {
      throw new Error('fact_verification_not_supported');
    }
    if (verification.overall_verdict === 'conflicted'
      && validatedAssessment.recommendation !== 'needs_review') {
      throw new Error('fact_verification_conflict_not_reviewed');
    }
    const assessmentVersion = expectedVersion * 1_000_000 + attempt;
    if (attempt >= 1_000_000 || !Number.isSafeInteger(assessmentVersion) || assessmentVersion <= 0) {
      throw new Error('invalid_assessment_version');
    }
    const proof = await createManualLeadVerificationProof({
      lead_id: id,
      assessment_version: assessmentVersion,
      assessment: validatedAssessment,
      evidence,
      verification,
    }, verificationKeys, responseKeys);
    const now = Date.now();
    const invalidationNonce = createMutationNonce('assessment_invalidate');
    const creationNonce = createMutationNonce('verification_create');
    const verificationId = `mav:${id}:${assessmentVersion}:${proof.canonical_digest.slice(0, 16)}`;
    const basicLeadGuard = `EXISTS (
      SELECT 1 FROM manual_news_leads l
      WHERE l.id = ? AND l.version = ? AND l.processing_owner = ? AND l.processing_attempt = ?
        AND l.status = 'verifying'
    )`;
    const preSaveGuard = `${basicLeadGuard} AND NOT EXISTS (
      SELECT 1 FROM manual_news_assessment_verifications current
      WHERE current.lead_id = ? AND current.status = 'active'
        AND current.processing_owner = ? AND current.processing_attempt = ?
    )`;
    const statements = [
      this.env.DB.prepare(
        `/* manual_assessment:owner_guard */ UPDATE manual_news_leads SET updated_at = updated_at
         WHERE id = ? AND version = ? AND processing_owner = ? AND processing_attempt = ?
           AND status = 'verifying' AND NOT EXISTS (
             SELECT 1 FROM manual_news_assessment_verifications current
             WHERE current.lead_id = ? AND current.status = 'active'
               AND current.processing_owner = ? AND current.processing_attempt = ?
           )`,
      ).bind(id, expectedVersion, owner, attempt, id, owner, attempt),
      this.env.DB.prepare(
        `/* manual_verification:replace_audit */ INSERT INTO manual_news_lead_audit (
           lead_id, action, from_status, to_status, idempotency_key, mutation_nonce,
           resulting_version, metadata_json, created_at
         ) SELECT ?, 'assessment_invalidate', 'verifying', 'verifying', NULL, ?, ?, ?, ?
         WHERE ${preSaveGuard} AND EXISTS (
           SELECT 1 FROM manual_news_assessment_verifications old
           WHERE old.lead_id = ? AND old.status = 'active'
         )`,
      ).bind(
        id, invalidationNonce, expectedVersion, JSON.stringify({
          reason: 'superseded_by_verification', processing_owner: owner,
          processing_attempt: attempt, lead_version: expectedVersion,
        }), now,
        id, expectedVersion, owner, attempt, id, owner, attempt, id,
      ),
      this.env.DB.prepare(
        `/* manual_verification:replace_active */ UPDATE manual_news_assessment_verifications
         SET status = 'invalidated', reason = 'superseded_by_verification', invalidated_at = ?
         WHERE lead_id = ? AND status = 'active' AND ${preSaveGuard}`,
      ).bind(
        now, id,
        id, expectedVersion, owner, attempt, id, owner, attempt,
      ),
      this.env.DB.prepare(
        `/* manual_assessment:insert */ INSERT INTO manual_news_event_assessments (
           lead_id, assessment_version, event_key, event_type, material_update, score,
           recommendation, assessment_json, created_at
         ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${preSaveGuard}`,
      ).bind(
        id, assessmentVersion, validatedAssessment.event_key, validatedAssessment.event_type,
        validatedAssessment.material_update ? 1 : 0, validatedAssessment.score,
        validatedAssessment.recommendation, JSON.stringify(validatedAssessment), now,
        id, expectedVersion, owner, attempt, id, owner, attempt,
      ),
      this.env.DB.prepare(
        `/* manual_verification:insert */ INSERT INTO manual_news_assessment_verifications (
           verification_id, lead_id, assessment_version, policy_version, verification_key_id, canonical_digest,
           hmac_sha256, verification_json, processing_owner, processing_attempt,
           creation_nonce, status, reason, created_at, invalidated_at
         ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, NULL WHERE ${preSaveGuard}`,
      ).bind(
        verificationId, id, assessmentVersion, proof.policy_version, proof.verification_key_id,
        proof.canonical_digest,
        proof.hmac_sha256, JSON.stringify(verification), owner, attempt, creationNonce, now,
        id, expectedVersion, owner, attempt, id, owner, attempt,
      ),
      this.env.DB.prepare(
        `/* manual_verification:create_audit */ INSERT INTO manual_news_lead_audit (
           lead_id, action, from_status, to_status, idempotency_key, mutation_nonce,
           resulting_version, metadata_json, created_at
         ) SELECT ?, 'verification_create', 'verifying', 'verifying', NULL, ?, ?, ?, ?
         WHERE ${basicLeadGuard} AND EXISTS (
           SELECT 1 FROM manual_news_assessment_verifications created
           WHERE created.verification_id = ? AND created.lead_id = ?
             AND created.assessment_version = ? AND created.creation_nonce = ?
             AND created.status = 'active'
         )`,
      ).bind(
        id, creationNonce, expectedVersion, JSON.stringify({
          verification_id: verificationId,
          assessment_version: assessmentVersion,
          policy_version: proof.policy_version,
          verification_key_id: proof.verification_key_id,
          canonical_digest: proof.canonical_digest,
          assessment_claim_contract: MANUAL_LEAD_GENERATED_CLAIM_CONTRACT,
          assessment_source_fact_contract: MANUAL_LEAD_SOURCE_FACT_CONTRACT,
          assessment_editorial_projection_contract: MANUAL_LEAD_EDITORIAL_PROJECTION_CONTRACT,
          assessment_evidence_disposition_contract: MANUAL_LEAD_EVIDENCE_DISPOSITION_CONTRACT,
          assessment_verification_policy: MANUAL_LEAD_VERIFICATION_POLICY_VERSION,
          processing_owner: owner,
          processing_attempt: attempt,
          mutation_nonce: creationNonce,
        }), now,
        id, expectedVersion, owner, attempt,
        verificationId, id, assessmentVersion, creationNonce,
      ),
    ];
    const results = await this.env.DB.batch(statements) as Array<{ meta?: { changes?: number } }>;
    if (Number(results[0]?.meta?.changes || 0) !== 1) throw new Error('stale_processing_owner');
    const invalidationAudit = Number(results[1]?.meta?.changes || 0);
    const invalidated = Number(results[2]?.meta?.changes || 0);
    if ((invalidated > 0 ? 1 : 0) !== invalidationAudit) {
      throw new Error('manual_verification_audit_causality_mismatch');
    }
    if (Number(results[3]?.meta?.changes || 0) !== 1
      || Number(results[4]?.meta?.changes || 0) !== 1
      || Number(results[5]?.meta?.changes || 0) !== 1) {
      throw new Error('manual_assessment_write_causality_mismatch');
    }
    return { assessment_version: assessmentVersion };
  }

  async invalidateAssessment(id: string, expectedVersion: number, reason: string): Promise<void> {
    if (!/^[a-z0-9_:-]{1,100}$/.test(reason)) throw new Error('invalid_assessment_invalidation_reason');
    const { owner, attempt } = this.fence();
    const now = Date.now();
    const mutationNonce = createMutationNonce('assessment_invalidate');
    try {
      const leadGuard = `EXISTS (
        SELECT 1 FROM manual_news_leads l
        WHERE l.id = ? AND l.version = ? AND l.processing_owner = ? AND l.processing_attempt = ?
          AND l.status = 'verifying'
      )`;
      const results = await this.env.DB.batch([
        this.env.DB.prepare(
          `/* manual_verification:invalidate_owner_guard */ UPDATE manual_news_leads SET updated_at = updated_at
           WHERE id = ? AND version = ? AND processing_owner = ? AND processing_attempt = ?
             AND status = 'verifying'`,
        ).bind(id, expectedVersion, owner, attempt),
        this.env.DB.prepare(
          `/* manual_verification:invalidate_audit */ INSERT INTO manual_news_lead_audit (
             lead_id, action, from_status, to_status, idempotency_key, mutation_nonce,
             resulting_version, metadata_json, created_at
           ) SELECT ?, 'assessment_invalidate', 'verifying', 'verifying', NULL, ?, ?, ?, ?
           WHERE ${leadGuard} AND EXISTS (
             SELECT 1 FROM manual_news_assessment_verifications
             WHERE lead_id = ? AND status = 'active'
           )`,
        ).bind(
          id, mutationNonce, expectedVersion, JSON.stringify({
            reason, processing_owner: owner, processing_attempt: attempt, lead_version: expectedVersion,
          }), now,
          id, expectedVersion, owner, attempt, id,
        ),
        this.env.DB.prepare(
          `/* manual_verification:invalidate */ UPDATE manual_news_assessment_verifications
           SET status = 'invalidated', reason = ?, invalidated_at = ?
           WHERE lead_id = ? AND status = 'active' AND ${leadGuard}`,
        ).bind(reason, now, id, id, expectedVersion, owner, attempt),
        this.env.DB.prepare(
          `/* manual_verification:invalidate_quarantine_item */ UPDATE items SET deleted_at = ?
           WHERE id = ? AND deleted_at IS NULL AND EXISTS (
             SELECT 1 FROM manual_news_assessment_verifications v
             WHERE v.lead_id = ? AND v.status = 'invalidated'
               AND v.reason = ? AND v.invalidated_at = ?
           ) AND ${leadGuard}`,
        ).bind(
          new Date(now).toISOString(), `blog:manual:${id}`, id, reason, now,
          id, expectedVersion, owner, attempt,
        ),
      ]) as Array<{ meta?: { changes?: number } }>;
      if (Number(results[0]?.meta?.changes || 0) !== 1) throw new Error('stale_processing_owner');
      const auditChanges = Number(results[1]?.meta?.changes || 0);
      const invalidated = Number(results[2]?.meta?.changes || 0);
      if ((invalidated > 0 ? 1 : 0) !== auditChanges) throw new Error('manual_verification_audit_causality_mismatch');
    } catch (error) {
      if (error instanceof Error && error.message === 'stale_processing_owner') throw error;
      throw new Error('d1_invalidate_assessment_failed');
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
    batch: { batch_id: string; revision: number; supersedes_revision: number | null; current: boolean; review_url: string } | null;
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
  const verified = await loadVerifiedManualAssessment(env, id, lead.evidence);
  if (!verified || !lead.assessment) {
    return { ok: false, status: 409, error: 'lead_not_fact_verified', lead };
  }
  const assessment = verified.assessment;
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
    title: assessment.title,
    summary: assessment.summary,
    source: primaryEvidence?.publisher || '手工补录',
    score: assessment.score,
    ...(primaryEvidence?.url || lead.input_url ? { url: primaryEvidence?.url || lead.input_url } : {}),
    event_key: assessment.event_key,
    origin: 'manual_lead' as const,
    lead_id: lead.id,
  };
  // Never invent a source publication time. `scraped_at` records our own
  // ingestion separately; missing source timing remains NULL and visible as uncertainty.
  const publishedAt = lead.evidence.map((item) => item.published_at).find(Boolean) || null;
  const itemExtra = JSON.stringify({
    title_zh: assessment.title,
    ai_summary_zh: assessment.summary,
    source_company: candidate.source,
    event_fingerprint: assessment.event_key,
    manual_lead: { lead_id: lead.id, evidence_ids: lead.evidence.map((item) => item.id) },
  });
  const confirmationNonce = createMutationNonce('confirm');
  let active = await getActiveNewsReviewBatch(env, lead.review_date);
  const activeSanitization = active
    ? await sanitizeCurrentNewsReviewBatch(env, lead.review_date, now)
    : null;
  if (activeSanitization) active = activeSanitization.batch;
  if ((active?.batch_revision || 0) !== expectedBatchRevision) {
    return { ok: false, status: 409, error: 'candidate_batch_revision_conflict', lead };
  }
  if (!active) {
    const results = await env.DB.batch([
      env.DB.prepare(
        `/* manual_lead:candidate_generation_init */ INSERT OR IGNORE INTO daily_news_review_candidate_generations
         (review_date, lineage_id, generation, updated_at) VALUES (?, ?, 0, ?)`,
      ).bind(lead.review_date, lead.review_date, now),
      confirmedLeadItemStatement(
        env, lead, expectedVersion, candidate, publishedAt, itemExtra, now, verified.record, undefined, true,
      ),
      env.DB.prepare(
        `/* manual_lead:confirm_prefreeze */ UPDATE manual_news_leads SET
           version = version + 1, confirmed_at = ?, last_mutation_kind = 'confirm',
           last_mutation_idempotency_key = ?, last_mutation_nonce = ?, updated_at = ?
         WHERE id = ? AND version = ? AND status IN ('recommended', 'needs_review')
           AND NOT EXISTS (SELECT 1 FROM daily_news_review_batches
             WHERE review_date = ? AND lineage_id = ? AND is_current = 1)
           AND ${MANUAL_VERIFICATION_SNAPSHOT_GUARD_SQL}`,
      ).bind(
        now, idempotencyKey, confirmationNonce, now, id, expectedVersion, lead.review_date, lead.review_date,
        ...manualVerificationSnapshotGuardBindings(id, verified.record),
      ),
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
  const batchRevision = active.batch_revision + 1;
  const batchId = await buildNewsReviewBatchId(lead.review_date, merged.candidates, {
    batch_revision: batchRevision,
    supersedes_batch_id: active.batch_id,
    lineage_id: lead.review_date,
  });
  const candidateIds = merged.candidates.map((item) => item.item_id);
  // 人审优先：确认线索只改候选池，不得把人审选择序列扔回自动排序。带人审标记时
  // 把人审序列（剔除已不在候选池的条目、补位追加在末尾）继续写进新版本的
  // applied_selected_ids，并继承标记，供后续自动冻结继续保护。
  const inheritsHumanSelection = active.human_reviewed && merged.default_selected_ids.length > 0;
  const inheritedSelectionHash = inheritsHumanSelection
    ? await newsReviewSelectionHash(merged.default_selected_ids)
    : null;
  const existingManualVerifications = activeSanitization?.manual_verifications || [];
  const existingManualGuard = existingManualVerifications.length
    ? existingManualVerifications.map(() => MANUAL_VERIFICATION_SNAPSHOT_GUARD_SQL).join(' AND ')
    : '1 = 1';
  const existingManualBindings = existingManualVerifications.flatMap((snapshot) =>
    manualVerificationSnapshotGuardBindings(snapshot.lead_id, snapshot.verification));

  const statements = [
    confirmedLeadItemStatement(
      env, lead, expectedVersion, candidate, publishedAt, itemExtra, now, verified.record, active,
      false, existingManualVerifications,
    ),
    env.DB.prepare(
      `/* manual_lead:confirm_batch */ INSERT INTO daily_news_review_batches (
         review_date, batch_id, candidate_ids, candidates_json, default_selected_ids,
         created_at, expires_at, batch_revision, supersedes_batch_id, revision_origin,
         lineage_id, is_current, candidate_generation,
         applied_selected_ids, selection_hash, edit_revision, publish_status, human_reviewed
       ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual_lead', ?, 0, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM manual_news_leads WHERE id = ? AND version = ?)
       AND EXISTS (SELECT 1 FROM daily_news_review_batches
           WHERE review_date = ? AND lineage_id = ? AND batch_id = ? AND batch_revision = ? AND is_current = 1)
       AND ${MANUAL_VERIFICATION_SNAPSHOT_GUARD_SQL}
       AND ${existingManualGuard}
       ON CONFLICT(review_date, batch_id) DO NOTHING`,
    ).bind(
      lead.review_date, batchId, JSON.stringify(candidateIds), JSON.stringify(merged.candidates),
      JSON.stringify(merged.default_selected_ids), now, newsReviewExpiresAt(lead.review_date),
      batchRevision, active.batch_id, lead.review_date, active.candidate_generation,
      inheritsHumanSelection ? JSON.stringify(merged.default_selected_ids) : null,
      inheritedSelectionHash,
      inheritsHumanSelection ? Math.max(active.edit_revision, 1) : 0,
      inheritsHumanSelection ? active.publish_status : 'not_requested',
      active.human_reviewed ? 1 : 0,
      lead.id, expectedVersion,
      lead.review_date, lead.review_date, active.batch_id, active.batch_revision,
      ...manualVerificationSnapshotGuardBindings(lead.id, verified.record),
      ...existingManualBindings,
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
         AND EXISTS (SELECT 1 FROM daily_news_review_batches WHERE review_date = ? AND batch_id = ? AND is_current = 1)
         AND ${MANUAL_VERIFICATION_SNAPSHOT_GUARD_SQL}`,
    ).bind(
      batchId, now, idempotencyKey, confirmationNonce, now,
      lead.id, expectedVersion, lead.review_date, batchId,
      ...manualVerificationSnapshotGuardBindings(lead.id, verified.record),
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
  verification: PersistedManualVerificationRow,
  expectedActiveBatch?: NewsReviewBatch,
  requireNoActiveBatch = false,
  requiredManualVerifications: ReadonlyArray<{
    lead_id: string;
    verification: PersistedManualVerificationRow;
  }> = [],
): D1PreparedStatement {
  const activeGuard = expectedActiveBatch
    ? ` AND EXISTS (SELECT 1 FROM daily_news_review_batches
         WHERE review_date = ? AND lineage_id = ? AND batch_id = ? AND batch_revision = ? AND is_current = 1)`
    : requireNoActiveBatch
      ? ` AND NOT EXISTS (SELECT 1 FROM daily_news_review_batches
           WHERE review_date = ? AND lineage_id = ? AND is_current = 1)`
      : '';
  const existingManualGuard = requiredManualVerifications.length
    ? requiredManualVerifications.map(() => MANUAL_VERIFICATION_SNAPSHOT_GUARD_SQL).join(' AND ')
    : '1 = 1';
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
    ...manualVerificationSnapshotGuardBindings(lead.id, verification),
    ...requiredManualVerifications.flatMap((snapshot) =>
      manualVerificationSnapshotGuardBindings(snapshot.lead_id, snapshot.verification)),
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
     WHERE EXISTS (SELECT 1 FROM manual_news_leads WHERE id = ? AND version = ?)
       AND ${MANUAL_VERIFICATION_SNAPSHOT_GUARD_SQL} AND ${existingManualGuard}${activeGuard}
     ON CONFLICT(id) DO UPDATE SET title = excluded.title, content = excluded.content,
       content_translated = excluded.content_translated, author = excluded.author,
       url = excluded.url, published_at = excluded.published_at, extra = excluded.extra`,
  ).bind(...values);
}

async function publicConfirmedBatch(env: Env, batch: NewsReviewBatch): Promise<{
  batch_id: string;
  revision: number;
  supersedes_revision: number | null;
  current: boolean;
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
    current: batch.is_current && !batch.superseded_by,
    review_url: url.toString(),
  };
}
