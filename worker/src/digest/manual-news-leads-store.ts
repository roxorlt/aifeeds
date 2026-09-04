import type { Env } from '../index';
import {
  manualNewsResponseKeyring,
  manualNewsVerificationKeyring,
} from '../security/manual-news-keyring';
import {
  assertManualLeadTransition,
  boundedManualLeadPriorEvents,
  createManualEvidenceDigest,
  createManualLeadVerificationProof,
  createManualNewsSourceSupportProof,
  deriveAutomaticManualEventIdentityV1,
  MANUAL_LEAD_EDITORIAL_PROJECTION_CONTRACT,
  MANUAL_LEAD_EVIDENCE_DISPOSITION_CONTRACT,
  MANUAL_LEAD_GENERATED_CLAIM_CONTRACT,
  MANUAL_LEAD_SOURCE_FACT_CONTRACT,
  MANUAL_LEAD_VERIFICATION_POLICY_VERSION,
  manualLeadAssessmentValidationFailure,
  manualNewsAssessmentGenerationAudit,
  MANUAL_NEWS_REVIEW_CANDIDATE_LIMIT,
  MANUAL_NEWS_PRIOR_EVENT_PROVIDER_LIMITS,
  mergeAuthorizedManualNewsCandidates,
  mergeManualLeadCandidate,
  TOTAL_NEWS_REVIEW_CANDIDATE_LIMIT,
  validateManualLeadFactVerification,
  validateManualNewsProcessedAssessment,
  validateManualNewsLeadInput,
  MANUAL_NEWS_SOURCE_SUPPORT_POLICY,
  type ManualNewsEvidence,
  type ManualLeadPriorEvent,
  type ManualNewsLeadStatus,
  type ManualNewsProcessedAssessment,
  type ManualNewsAssessmentGenerationAudit,
  type ManualNewsSourceSupportAuthorization,
  type ManualNewsSourceSupportPayload,
  type ManualNewsSourceSupportPriorEvent,
  type ManualReviewCandidate,
} from './manual-news-leads';
import {
  createManualNewsOwnerVouchPayload,
  createManualNewsOwnerVouchProof,
  MANUAL_NEWS_OWNER_VOUCH_AUDIT_ACTION,
  MANUAL_NEWS_OWNER_VOUCH_MUTATION_KIND,
  MANUAL_NEWS_OWNER_VOUCH_POLICY,
  normalizeOwnerVouchStatement,
} from './manual-news-owner-vouch';
import {
  createManualNewsOwnerAssertedPayload,
  createManualNewsOwnerAssertedProof,
  MANUAL_NEWS_OWNER_ASSERTED_AUDIT_ACTION,
  MANUAL_NEWS_OWNER_ASSERTED_AUDIT_ACTIONS,
  MANUAL_NEWS_OWNER_ASSERTED_MUTATION_KIND,
  MANUAL_NEWS_OWNER_ASSERTED_POLICY,
} from './manual-news-owner-asserted';
import {
  loadManualNewsEvidence,
  loadVerifiedManualCandidateProof,
  loadVerifiedManualSourceSupportProofs,
  loadVerifiedManualAssessment,
  MANUAL_VERIFICATION_SNAPSHOT_GUARD_SQL,
  MANUAL_VERIFICATION_SNAPSHOT_SET_GUARD_SQL,
  manualVerificationSnapshotGuardBindings,
  manualVerificationSnapshotSetGuardBinding,
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
  loadAutomaticNewsReviewEventIdentitySidecar,
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

function sourceSupportEvidenceSnapshotGuard(
  leadId: string,
  evidence: readonly ManualNewsEvidence[],
): {
  sql: string;
  bindings: unknown[];
} {
  return {
    // 证据集为空时只剩「这条线索确实一条证据都没有」这一句 —— owner 直接录入
    // (owner_asserted_v1) 就是这种形态,不能像以前那样直接判 false。
    //
    // 证据逐条展开会各占 13 个绑参,取满 8 条(MANUAL_NEWS_EVIDENCE_MAX_COUNT)光这一段
    // 就 104 个,越过 D1 单语句 100 个的绑参上限。改成整批打成一个 JSON 绑参、
    // json_each 展开逐字段比对:字段集合、比较方式(published_at 仍用 NULL 安全的 IS,
    // 其余仍用 =)、reliable / retrieved_at 的数字形态都与逐条展开逐字一致。
    sql: `(SELECT COUNT(*) FROM manual_news_evidence WHERE lead_id = ?) = ?
      AND NOT EXISTS (
        SELECT 1 FROM json_each(?) evidence_entry
        WHERE NOT EXISTS (
          SELECT 1 FROM manual_news_evidence e
          WHERE e.lead_id = json_extract(evidence_entry.value, '$.lead_id')
            AND e.evidence_id = json_extract(evidence_entry.value, '$.evidence_id')
            AND e.response_key_id = json_extract(evidence_entry.value, '$.response_key_id')
            AND e.url = json_extract(evidence_entry.value, '$.url')
            AND e.source_type = json_extract(evidence_entry.value, '$.source_type')
            AND e.publisher = json_extract(evidence_entry.value, '$.publisher')
            AND e.published_at IS json_extract(evidence_entry.value, '$.published_at')
            AND e.retrieved_at = json_extract(evidence_entry.value, '$.retrieved_at')
            AND e.title = json_extract(evidence_entry.value, '$.title')
            AND e.excerpt = json_extract(evidence_entry.value, '$.excerpt')
            AND e.claims_supported_json = json_extract(evidence_entry.value, '$.claims_supported_json')
            AND e.fetch_audit_json = json_extract(evidence_entry.value, '$.fetch_audit_json')
            AND e.reliable = json_extract(evidence_entry.value, '$.reliable')
        )
      )`,
    bindings: [
      leadId,
      evidence.length,
      JSON.stringify(evidence.map((item) => ({
        lead_id: leadId,
        evidence_id: item.id,
        response_key_id: item.response_key_id || '',
        url: item.url,
        source_type: item.source_type,
        publisher: item.publisher,
        published_at: item.published_at ?? null,
        retrieved_at: Number(item.retrieved_at),
        title: item.title,
        excerpt: item.excerpt,
        claims_supported_json: JSON.stringify(item.claims_supported),
        fetch_audit_json: JSON.stringify(item.fetch_audit || null),
        reliable: item.reliable ? 1 : 0,
      }))),
    ],
  };
}

interface OrderedVerifiedManualCandidate {
  authorization_order: number;
  candidate: ManualReviewCandidate;
  lead_id: string;
  verification: PersistedManualVerificationRow;
}

async function orderedVerifiedManualCandidates(
  env: Env,
  date: string,
  excludeLeadId: string,
): Promise<OrderedVerifiedManualCandidate[]> {
  const rows = await env.DB.prepare(
    `/* manual_source_support:ordered_confirmed_manual */ SELECT
       l.id AS lead_id,
       CASE WHEN v.policy_version = ? THEN (
         SELECT MIN(a.id) FROM manual_news_lead_audit a
         WHERE a.lead_id = l.id AND a.action = 'submit'
           AND json_extract(a.metadata_json, '$.candidate_authorization') = ?
       ) WHEN v.policy_version = ? THEN (
         SELECT MIN(a.id) FROM manual_news_lead_audit a
         WHERE a.lead_id = l.id AND a.action = ?
       ) WHEN v.policy_version = ? THEN (
         SELECT MIN(a.id) FROM manual_news_lead_audit a
         WHERE a.lead_id = l.id AND a.action IN (?, ?)
       ) ELSE (
         SELECT MIN(a.id) FROM manual_news_lead_audit a
         WHERE a.lead_id = l.id AND a.action = 'confirm_candidate'
       ) END AS authorization_order
     FROM manual_news_leads l
     JOIN manual_news_assessment_verifications v
       ON v.lead_id = l.id AND v.status = 'active'
     WHERE l.review_date = ? AND l.confirmed_at IS NOT NULL AND l.id <> ?
       AND l.status IN ('recommended', 'needs_review')
     ORDER BY authorization_order ASC, l.id ASC LIMIT 51`,
  ).bind(
    MANUAL_NEWS_SOURCE_SUPPORT_POLICY, MANUAL_NEWS_SOURCE_SUPPORT_POLICY,
    // 担保候选的授权时刻是 owner 的 vouch_candidate 审计行(与 proof 行同 batch 落盘),
    // 不是随后那次 confirm_candidate。取不到该行就让下面的正整数校验 fail-closed。
    MANUAL_NEWS_OWNER_VOUCH_POLICY, MANUAL_NEWS_OWNER_VOUCH_AUDIT_ACTION,
    // 直接录入的授权时刻是 assert_candidate(一步录入)或 vouch_candidate(零证据线索
    // 从担保按钮救回)审计行,同样不是随后那次 confirm_candidate。
    MANUAL_NEWS_OWNER_ASSERTED_POLICY, ...MANUAL_NEWS_OWNER_ASSERTED_AUDIT_ACTIONS,
    date, excludeLeadId,
  ).all<{ lead_id: string; authorization_order: number | null }>();
  if ((rows.results || []).length > MANUAL_NEWS_REVIEW_CANDIDATE_LIMIT) {
    throw new Error('manual_candidate_limit_exceeded');
  }
  const candidates: OrderedVerifiedManualCandidate[] = [];
  for (const row of rows.results || []) {
    const order = Number(row.authorization_order);
    if (!Number.isSafeInteger(order) || order <= 0) throw new Error('manual_candidate_order_invalid');
    const proof = await loadVerifiedManualCandidateProof(env, row.lead_id);
    if (!proof) continue;
    candidates.push({
      authorization_order: order,
      candidate: {
        ...proof.candidate,
        origin: 'manual_lead',
        lead_id: row.lead_id,
      },
      lead_id: row.lead_id,
      verification: proof.record,
    });
  }
  return candidates;
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

async function manualEventClaimNonce(reviewDate: string, eventKey: string): Promise<string> {
  return `confirm-event:${await sha256Hex(`manual-news-confirm-event-v1\0${reviewDate}\0${eventKey}`)}`;
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

export interface ManualNewsCandidateAuthorizationView {
  candidate_authorization: 'llm_verified' | typeof MANUAL_NEWS_SOURCE_SUPPORT_POLICY
    | typeof MANUAL_NEWS_OWNER_VOUCH_POLICY | typeof MANUAL_NEWS_OWNER_ASSERTED_POLICY | null;
  /** 担保与直接录入共用这个字段；直接录入时 `vouched_at` 取 `asserted_at`。 */
  vouch: { statement: string; vouched_at: number } | null;
}

interface ManualNewsCandidateAuthorizationRow {
  lead_id?: string;
  policy_version: string;
  vouch_statement: string | null;
  vouched_at: number | null;
}

/**
 * 呈现用的放行方式。**不是授权判定** —— 是否真的能进候选池由
 * loadVerifiedManualCandidateProof 与正式新闻门决定，这里只把当前 active 验证行的
 * policy 与担保陈述展示给 owner，未知 policy 一律显示为 null。
 */
function manualNewsCandidateAuthorizationView(
  row: ManualNewsCandidateAuthorizationRow | null,
): ManualNewsCandidateAuthorizationView {
  if (!row) return { candidate_authorization: null, vouch: null };
  if (row.policy_version === MANUAL_LEAD_VERIFICATION_POLICY_VERSION) {
    return { candidate_authorization: 'llm_verified', vouch: null };
  }
  if (row.policy_version === MANUAL_NEWS_SOURCE_SUPPORT_POLICY) {
    return { candidate_authorization: MANUAL_NEWS_SOURCE_SUPPORT_POLICY, vouch: null };
  }
  if (row.policy_version !== MANUAL_NEWS_OWNER_VOUCH_POLICY
    && row.policy_version !== MANUAL_NEWS_OWNER_ASSERTED_POLICY) {
    return { candidate_authorization: null, vouch: null };
  }
  const vouchedAt = Number(row.vouched_at);
  return {
    candidate_authorization: row.policy_version === MANUAL_NEWS_OWNER_ASSERTED_POLICY
      ? MANUAL_NEWS_OWNER_ASSERTED_POLICY
      : MANUAL_NEWS_OWNER_VOUCH_POLICY,
    vouch: typeof row.vouch_statement === 'string' && row.vouch_statement
      && Number.isSafeInteger(vouchedAt) && vouchedAt > 0
      ? { statement: row.vouch_statement, vouched_at: vouchedAt }
      : null,
  };
}

const MANUAL_NEWS_CANDIDATE_AUTHORIZATION_COLUMNS = `v.policy_version,
  CASE WHEN v.policy_version IN (?, ?) THEN json_extract(v.verification_json, '$.statement') END
    AS vouch_statement,
  CASE WHEN v.policy_version = ? THEN json_extract(v.verification_json, '$.vouched_at')
       WHEN v.policy_version = ? THEN json_extract(v.verification_json, '$.asserted_at') END
    AS vouched_at`;

export async function getManualNewsCandidateAuthorization(
  env: Env,
  leadId: string,
): Promise<ManualNewsCandidateAuthorizationView> {
  const row = await env.DB.prepare(
    `/* manual_lead:candidate_authorization */ SELECT ${MANUAL_NEWS_CANDIDATE_AUTHORIZATION_COLUMNS}
     FROM manual_news_assessment_verifications v
     WHERE v.lead_id = ? AND v.status = 'active'
     ORDER BY v.created_at DESC LIMIT 1`,
  ).bind(
    MANUAL_NEWS_OWNER_VOUCH_POLICY, MANUAL_NEWS_OWNER_ASSERTED_POLICY,
    MANUAL_NEWS_OWNER_VOUCH_POLICY, MANUAL_NEWS_OWNER_ASSERTED_POLICY, leadId,
  ).first<ManualNewsCandidateAuthorizationRow>();
  return manualNewsCandidateAuthorizationView(row);
}

export async function listManualNewsCandidateAuthorizations(
  env: Env,
  date: string,
): Promise<Map<string, ManualNewsCandidateAuthorizationView>> {
  const result = await env.DB.prepare(
    `/* manual_lead:candidate_authorization_by_date */ SELECT v.lead_id,
       ${MANUAL_NEWS_CANDIDATE_AUTHORIZATION_COLUMNS}
     FROM manual_news_assessment_verifications v
     JOIN manual_news_leads l ON l.id = v.lead_id
     WHERE l.review_date = ? AND v.status = 'active'
     ORDER BY v.lead_id ASC LIMIT 200`,
  ).bind(
    MANUAL_NEWS_OWNER_VOUCH_POLICY, MANUAL_NEWS_OWNER_ASSERTED_POLICY,
    MANUAL_NEWS_OWNER_VOUCH_POLICY, MANUAL_NEWS_OWNER_ASSERTED_POLICY, date,
  ).all<ManualNewsCandidateAuthorizationRow>();
  const views = new Map<string, ManualNewsCandidateAuthorizationView>();
  for (const row of result.results || []) {
    if (typeof row.lead_id === 'string') views.set(row.lead_id, manualNewsCandidateAuthorizationView(row));
  }
  return views;
}

export async function getManualNewsLeadCandidateState(
  env: Env,
  date: string,
): Promise<{ batch_id: string; revision: number } | null> {
  const active = await getActiveNewsReviewBatch(env, date);
  return active ? { batch_id: active.batch_id, revision: active.batch_revision } : null;
}

export async function getManualNewsLeadPaidRetrievalEpoch(
  env: Env,
  id: string,
): Promise<number> {
  const audit = await env.DB.prepare(
    `/* manual_audit:paid_retrieval_epoch */ SELECT id
     FROM manual_news_lead_audit
     WHERE lead_id = ? AND action = 'retry' AND idempotency_key IS NOT NULL
       AND from_status IN ('failed', 'needs_review', 'rejected') AND to_status = 'validating'
     ORDER BY resulting_version DESC, id DESC LIMIT 1`,
  ).bind(id).first<{ id: number }>();
  if (!audit) return 0;
  const epoch = Number(audit.id);
  if (!Number.isSafeInteger(epoch) || epoch <= 0) throw new Error('invalid_paid_retrieval_epoch');
  return epoch;
}

async function manualNewsSubmitIdentityDigest(input: {
  date: string;
  input_type: ManualNewsLeadRecord['input_type'];
  text: string;
  url: string;
  note: string;
  candidate_authorization: typeof MANUAL_NEWS_SOURCE_SUPPORT_POLICY
    | typeof MANUAL_NEWS_OWNER_ASSERTED_POLICY | null;
}): Promise<string> {
  return sha256Hex([
    'manual-news-submit-identity-v1', input.date, input.input_type, input.text,
    input.url, input.note, input.candidate_authorization || '',
  ].join('\0'));
}

export async function getManualNewsSourceSupportAuthorization(
  env: Env,
  id: string,
): Promise<ManualNewsSourceSupportAuthorization | null> {
  const row = await env.DB.prepare(
    `/* manual_audit:source_support_authorization */ SELECT
       l.review_date, l.input_type, l.input_text, l.input_url, l.note,
       l.submit_idempotency_key, a.id AS audit_id, a.idempotency_key, a.metadata_json
     FROM manual_news_leads l
     JOIN manual_news_lead_audit a ON a.lead_id = l.id
     WHERE l.id = ? AND a.action = 'submit' AND a.resulting_version = 1
       AND a.from_status IS NULL AND a.to_status = 'submitted'
       AND a.idempotency_key = l.submit_idempotency_key
     ORDER BY a.id ASC LIMIT 1`,
  ).bind(id).first<{
    review_date: string;
    input_type: ManualNewsLeadRecord['input_type'];
    input_text: string;
    input_url: string;
    note: string;
    submit_idempotency_key: string;
    audit_id: number;
    idempotency_key: string;
    metadata_json: string;
  }>();
  if (!row) return null;
  let metadata: Record<string, unknown>;
  try {
    const parsed = JSON.parse(row.metadata_json) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    metadata = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const expectedKeys = [
    'input_type', 'candidate_authorization', 'submit_identity_contract', 'submit_identity_digest',
  ];
  if (Object.keys(metadata).length !== expectedKeys.length
    || Object.keys(metadata).some((key) => !expectedKeys.includes(key))
    || metadata.input_type !== row.input_type
    || metadata.candidate_authorization !== MANUAL_NEWS_SOURCE_SUPPORT_POLICY
    || metadata.submit_identity_contract !== 'manual_news_submit_identity_v1'
    || typeof metadata.submit_identity_digest !== 'string'
    || !Number.isSafeInteger(Number(row.audit_id)) || Number(row.audit_id) <= 0) return null;
  const expectedDigest = await manualNewsSubmitIdentityDigest({
    date: row.review_date,
    input_type: row.input_type,
    text: row.input_text,
    url: row.input_url,
    note: row.note,
    candidate_authorization: MANUAL_NEWS_SOURCE_SUPPORT_POLICY,
  });
  if (metadata.submit_identity_digest !== expectedDigest) return null;
  return {
    audit_id: Number(row.audit_id),
    candidate_authorization: MANUAL_NEWS_SOURCE_SUPPORT_POLICY,
    submit_identity_digest: expectedDigest,
    idempotency_key: row.idempotency_key,
  };
}

export async function submitManualNewsLead(
  env: Env,
  input: {
    date?: unknown;
    text?: unknown;
    url?: unknown;
    note?: unknown;
    candidate_authorization?: unknown;
  },
  idempotencyKey: string,
  now = Date.now(),
): Promise<{ lead: ManualNewsLeadRecord; created: boolean }> {
  const normalized = validateManualNewsLeadInput(input);
  const submitIdentityDigest = await manualNewsSubmitIdentityDigest({
    date: normalized.date,
    input_type: normalized.input_type,
    text: normalized.text,
    url: normalized.url,
    note: normalized.note,
    candidate_authorization: normalized.candidate_authorization,
  });
  const sameSubmission = async (row: ManualLeadRow): Promise<boolean> => {
    const samePayload = row.input_type === normalized.input_type
      && row.input_text === normalized.text
      && row.input_url === normalized.url
      && row.note === normalized.note;
    if (!samePayload) return false;
    const audit = await env.DB.prepare(
      `/* manual_audit:submit_authorization */ SELECT id, metadata_json
       FROM manual_news_lead_audit
       WHERE lead_id = ? AND action = 'submit' AND resulting_version = 1
       ORDER BY id ASC LIMIT 1`,
    ).bind(row.id).first<{ id: number; metadata_json: string }>();
    if (!audit) return normalized.candidate_authorization === null;
    let metadata: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(audit.metadata_json) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>;
      }
    } catch {
      return false;
    }
    const storedAuthorization = metadata.candidate_authorization === MANUAL_NEWS_SOURCE_SUPPORT_POLICY
      ? MANUAL_NEWS_SOURCE_SUPPORT_POLICY
      : null;
    if (storedAuthorization !== normalized.candidate_authorization) return false;
    return storedAuthorization === null
      || (metadata.submit_identity_contract === 'manual_news_submit_identity_v1'
        && metadata.submit_identity_digest === submitIdentityDigest);
  };
  const existing = await env.DB.prepare(
    `/* manual_lead:by_submit_key */ SELECT * FROM manual_news_leads
     WHERE review_date = ? AND submit_idempotency_key = ?`,
  ).bind(normalized.date, idempotencyKey).first<ManualLeadRow>();
  if (existing) {
    if (!await sameSubmission(existing)) throw new Error('idempotency_key_reused_with_different_payload');
    return { lead: await leadFromRow(env, existing), created: false };
  }
  const hash = normalized.candidate_authorization
    ? await sha256Hex(`manual-news-source-support-lead-id-v1\0${normalized.date}\0${idempotencyKey}\0${submitIdentityDigest}`)
    : await sha256Hex(`${normalized.date}\0${idempotencyKey}\0${normalized.text}\0${normalized.url}`);
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
    resultingVersion: 1,
    metadata: {
      input_type: normalized.input_type,
      ...(normalized.candidate_authorization ? {
        candidate_authorization: normalized.candidate_authorization,
        submit_identity_contract: 'manual_news_submit_identity_v1',
        submit_identity_digest: submitIdentityDigest,
      } : {}),
    },
    createdAt: now,
  })) > 0;
  let lead = await getManualNewsLead(env, id);
  if (!lead) {
    const winner = await env.DB.prepare(
      `/* manual_lead:by_submit_key */ SELECT * FROM manual_news_leads
       WHERE review_date = ? AND submit_idempotency_key = ?`,
    ).bind(normalized.date, idempotencyKey).first<ManualLeadRow>();
    if (!winner) throw new Error('manual_news_lead_insert_failed');
    if (!await sameSubmission(winner)) throw new Error('idempotency_key_reused_with_different_payload');
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

  getSourceSupportAuthorization(id: string): Promise<ManualNewsSourceSupportAuthorization | null> {
    return getManualNewsSourceSupportAuthorization(this.env, id);
  }

  async listSourceSupportPriorEvents(
    date: string,
    excludeLeadId: string,
  ): Promise<ManualNewsSourceSupportPriorEvent[]> {
    const manual = await this.env.DB.prepare(
      `/* manual_source_support:recent_manual_events */ SELECT
         v.lead_id, l.review_date
       FROM manual_news_assessment_verifications v
       JOIN manual_news_leads l ON l.id = v.lead_id
       WHERE v.policy_version = ? AND v.status = 'active' AND v.lead_id <> ?
         AND l.confirmed_at IS NOT NULL
         AND l.review_date BETWEEN date(?, '-14 days') AND ?
       ORDER BY l.review_date DESC, v.lead_id ASC LIMIT 701`,
    ).bind(MANUAL_NEWS_SOURCE_SUPPORT_POLICY, excludeLeadId, date, date)
      .all<{ lead_id: string; review_date: string }>();
    if ((manual.results || []).length > 700) throw new Error('source_support_prior_event_scan_limit');
    const events: ManualNewsSourceSupportPriorEvent[] = [];
    const proofs = await loadVerifiedManualSourceSupportProofs(
      this.env,
      (manual.results || []).map((row) => row.lead_id),
    );
    for (const row of manual.results || []) {
      const proof = proofs.get(row.lead_id);
      if (!proof) continue;
      events.push({
        event_key: proof.candidate.event_key,
        review_date: row.review_date,
        origin: 'manual',
        item_id: proof.candidate.item_id,
      });
    }
    const automatic = await this.env.DB.prepare(
      `/* manual_source_support:recent_automatic_events */ SELECT
         id, extra, substr(COALESCE(published_at, scraped_at), 1, 10) AS review_date
       FROM items
       WHERE id <> ? AND COALESCE(source_ref, '') <> 'manual_lead'
         AND deleted_at IS NULL AND COALESCE(is_relevant, 0) = 1
         AND extra IS NOT NULL AND json_valid(extra) = 1
         AND json_type(extra, '$.event_fingerprint') = 'object'
         AND substr(COALESCE(published_at, scraped_at), 1, 10)
           BETWEEN date(?, '-14 days') AND ?
       ORDER BY review_date DESC, id ASC LIMIT 4097`,
    ).bind(`blog:manual:${excludeLeadId}`, date, date)
      .all<{ id: string; extra: string; review_date: string }>();
    if ((automatic.results || []).length > 4096) throw new Error('source_support_prior_event_scan_limit');
    for (const row of automatic.results || []) {
      let fingerprint: unknown = null;
      try {
        const extra = JSON.parse(row.extra) as Record<string, unknown>;
        fingerprint = extra.event_fingerprint;
      } catch {
        continue;
      }
      const identity = await deriveAutomaticManualEventIdentityV1(fingerprint);
      if (!identity) continue;
      events.push({
        event_key: identity.event_key,
        review_date: row.review_date,
        origin: 'automatic',
        item_id: row.id,
      });
    }
    const ordered = events.sort((left, right) =>
      right.review_date.localeCompare(left.review_date)
      || (left.origin === right.origin ? 0 : left.origin === 'manual' ? -1 : 1)
      || left.item_id.localeCompare(right.item_id));
    const byEvent = new Map<string, ManualNewsSourceSupportPriorEvent>();
    for (const event of ordered) if (!byEvent.has(event.event_key)) byEvent.set(event.event_key, event);
    return [...byEvent.values()];
  }

  async saveSourceSupportedCandidate(
    id: string,
    expectedVersion: number,
    payload: ManualNewsSourceSupportPayload,
  ): Promise<ManualNewsLeadRecord> {
    const { owner, attempt } = this.fence();
    const lead = await getManualNewsLead(this.env, id);
    if (!lead) throw new Error('manual_news_lead_not_found');
    const alreadyVerified = await loadVerifiedManualCandidateProof(this.env, id);
    if (lead.confirmed_at !== null
      && alreadyVerified?.policy_version === MANUAL_NEWS_SOURCE_SUPPORT_POLICY
      && JSON.stringify(alreadyVerified.source_support) === JSON.stringify(payload)) return lead;
    if (lead.version !== expectedVersion || lead.status !== 'verifying'
      || lead.processing_owner !== owner || lead.processing_attempt !== attempt
      || lead.confirmed_at !== null) throw new Error('stale_processing_owner');

    const authorization = await getManualNewsSourceSupportAuthorization(this.env, id);
    if (!authorization || JSON.stringify(authorization) !== JSON.stringify(payload.authorization)
      || payload.input.review_date !== lead.review_date
      || payload.input.input_type !== lead.input_type
      || payload.input.input_text !== lead.input_text
      || payload.input.input_url !== lead.input_url
      || payload.input.note !== lead.note) throw new Error('source_support_authorization_stale');
    const evidence = await loadManualNewsEvidence(this.env, id);
    if (await createManualEvidenceDigest(evidence) !== await createManualEvidenceDigest(payload.evidence)) {
      throw new Error('source_support_evidence_stale');
    }
    const assessmentVersion = expectedVersion * 1_000_000 + attempt;
    if (attempt >= 1_000_000 || !Number.isSafeInteger(assessmentVersion) || assessmentVersion <= 0) {
      throw new Error('invalid_assessment_version');
    }
    const proof = await createManualNewsSourceSupportProof({
      lead_id: id, assessment_version: assessmentVersion, payload,
    }, manualNewsVerificationKeyring(this.env), manualNewsResponseKeyring(this.env));
    const now = Date.now();
    const creationNonce = createMutationNonce('source_support_verification_create');
    const eventClaimNonce = await manualEventClaimNonce(lead.review_date, payload.event_identity.event_key);
    const verificationId = `mav:${id}:${assessmentVersion}:${proof.canonical_digest.slice(0, 16)}`;
    const verificationJson = JSON.stringify(payload);
    const verification: PersistedManualVerificationRow = {
      verification_id: verificationId,
      lead_id: id,
      assessment_version: assessmentVersion,
      policy_version: proof.policy_version,
      verification_key_id: proof.verification_key_id,
      canonical_digest: proof.canonical_digest,
      hmac_sha256: proof.hmac_sha256,
      verification_json: verificationJson,
      processing_owner: owner,
      processing_attempt: attempt,
      creation_nonce: creationNonce,
      status: 'active',
      reason: null,
      created_at: now,
      invalidated_at: null,
    };
    const candidate: ManualReviewCandidate = {
      ...payload.item_projection,
      event_key: payload.event_identity.event_key,
      origin: 'manual_lead',
      lead_id: id,
    };
    const proofGuardBindings = manualVerificationSnapshotGuardBindings(id, verification);
    const evidenceGuard = sourceSupportEvidenceSnapshotGuard(id, evidence);
    const submitMetadata = JSON.stringify({
      input_type: lead.input_type,
      candidate_authorization: MANUAL_NEWS_SOURCE_SUPPORT_POLICY,
      submit_identity_contract: 'manual_news_submit_identity_v1',
      submit_identity_digest: authorization.submit_identity_digest,
    });
    const itemExtra = JSON.stringify({
      title_zh: candidate.title,
      ai_summary_zh: candidate.summary,
      source_company: candidate.source,
      event_fingerprint: payload.event_identity.event_key,
      manual_lead: { lead_id: id, evidence_ids: evidence.map((entry) => entry.id) },
      manual_source_support: {
        policy_version: MANUAL_NEWS_SOURCE_SUPPORT_POLICY,
        authorization_audit_id: authorization.audit_id,
        verification_id: verificationId,
        canonical_digest: proof.canonical_digest,
      },
    });

    const active = await getActiveNewsReviewBatch(this.env, lead.review_date);
    const confirmedCount = await this.env.DB.prepare(
      `/* manual_source_support:manual_cap_preflight */ SELECT COUNT(*) AS count
       FROM manual_news_leads WHERE review_date = ? AND confirmed_at IS NOT NULL`,
    ).bind(lead.review_date).first<{ count: number }>();
    if (Number(confirmedCount?.count || 0) >= MANUAL_NEWS_REVIEW_CANDIDATE_LIMIT) {
      throw new Error('manual_candidate_limit_exceeded');
    }
    const existingManual = await orderedVerifiedManualCandidates(this.env, lead.review_date, id);
    if (!active) {
      const generationRow = await this.env.DB.prepare(
        `/* manual_source_support:generation_read */ SELECT generation
         FROM daily_news_review_candidate_generations WHERE review_date = ? AND lineage_id = ?`,
      ).bind(lead.review_date, lead.review_date).first<{ generation: number }>();
      const generation = generationRow ? Number(generationRow.generation) : 0;
      if (!Number.isSafeInteger(generation) || generation < 0) {
        throw new Error('invalid_news_review_candidate_generation');
      }
      // 整批已确认快照只占 1 个绑参 —— 按条数展开会随当天候选条数撞 D1 100 个绑参上限。
      const existingProofGuard = MANUAL_VERIFICATION_SNAPSHOT_SET_GUARD_SQL;
      const existingProofBindings = [manualVerificationSnapshotSetGuardBinding(existingManual)];
      const sharedGate = `EXISTS (
        SELECT 1 FROM manual_news_leads l
        WHERE l.id = ? AND l.version = ? AND l.status = 'verifying'
          AND l.processing_owner = ? AND l.processing_attempt = ? AND l.confirmed_at IS NULL
      ) AND EXISTS (
        SELECT 1 FROM manual_news_lead_audit a
        WHERE a.id = ? AND a.lead_id = ? AND a.action = 'submit'
          AND a.resulting_version = 1 AND a.from_status IS NULL AND a.to_status = 'submitted'
          AND a.idempotency_key = ? AND a.metadata_json = ?
      ) AND ${evidenceGuard.sql}
        AND NOT EXISTS (SELECT 1 FROM manual_news_assessment_verifications v
          WHERE v.lead_id = ? AND v.status = 'active')
        AND NOT EXISTS (SELECT 1 FROM daily_news_review_batches b
          WHERE b.review_date = ? AND b.lineage_id = ? AND b.is_current = 1)
        AND (SELECT COUNT(*) FROM manual_news_leads l
          WHERE l.review_date = ? AND l.confirmed_at IS NOT NULL) < ${MANUAL_NEWS_REVIEW_CANDIDATE_LIMIT}
        AND NOT EXISTS (SELECT 1 FROM manual_news_lead_audit a
          WHERE a.action = 'confirm_candidate' AND a.mutation_nonce = ?)
        AND COALESCE((SELECT g.generation FROM daily_news_review_candidate_generations g
          WHERE g.review_date = ? AND g.lineage_id = ?), 0) = ?
        AND ${existingProofGuard}
        AND length(?) BETWEEN 1 AND 80 AND length(?) BETWEEN 1 AND 180`;
      const sharedGateBindings: unknown[] = [
        id, expectedVersion, owner, attempt,
        authorization.audit_id, id, authorization.idempotency_key, submitMetadata,
        ...evidenceGuard.bindings,
        id,
        lead.review_date, lead.review_date,
        lead.review_date, eventClaimNonce,
        lead.review_date, lead.review_date, generation,
        ...existingProofBindings,
        candidate.title, candidate.summary,
      ];
      const finalMetadata = JSON.stringify({
        candidate_authorization: MANUAL_NEWS_SOURCE_SUPPORT_POLICY,
        authorization_audit_id: authorization.audit_id,
        verification_id: verificationId,
        canonical_digest: proof.canonical_digest,
        pending_initial_freeze: true,
        event_key: payload.event_identity.event_key,
        event_aliases: {},
        rerender_enqueued: false,
      });
      try {
        await this.env.DB.batch([
        this.env.DB.prepare(
          `/* manual_source_support:proof_insert_prefreeze */ INSERT INTO manual_news_assessment_verifications (
             verification_id, lead_id, assessment_version, policy_version, verification_key_id,
             canonical_digest, hmac_sha256, verification_json, processing_owner, processing_attempt,
             creation_nonce, status, reason, created_at, invalidated_at
           ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, NULL
           WHERE ${sharedGate}`,
        ).bind(
          verificationId, id, assessmentVersion, proof.policy_version, proof.verification_key_id,
          proof.canonical_digest, proof.hmac_sha256, verificationJson, owner, attempt, creationNonce, now,
          ...sharedGateBindings,
        ),
        this.env.DB.prepare(
          `/* manual_source_support:item_insert_prefreeze */ INSERT INTO items (
             id, source_type, source_id, source_ref, title, content, content_translated, author,
             url, published_at, scraped_at, is_relevant, matched_by, lang, extra
           ) SELECT ?, 'blog', ?, 'manual_lead', ?, ?, ?, ?, ?, ?, ?, 1, 'manual_lead', 'zh', ?
           WHERE ${MANUAL_VERIFICATION_SNAPSHOT_GUARD_SQL}`,
        ).bind(
          candidate.item_id, payload.item_projection.source_id, candidate.title, candidate.summary,
          candidate.summary, candidate.source, candidate.url || '', payload.item_projection.published_at,
          new Date(now).toISOString(), itemExtra, ...proofGuardBindings,
        ),
        this.env.DB.prepare(
          `/* manual_source_support:lead_confirm_prefreeze */ UPDATE manual_news_leads
           SET status = 'recommended', version = version + 1, confirmed_batch_id = NULL, confirmed_at = ?,
             processing_owner = NULL, processing_lease_until = NULL,
             last_mutation_kind = 'source_support_confirm', last_mutation_idempotency_key = ?,
             last_mutation_nonce = ?, updated_at = ?
           WHERE id = ? AND version = ? AND status = 'verifying'
             AND processing_owner = ? AND processing_attempt = ? AND confirmed_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM daily_news_review_batches b
               WHERE b.review_date = ? AND b.lineage_id = ? AND b.is_current = 1)
             AND EXISTS (SELECT 1 FROM items i WHERE i.id = ? AND i.extra = ?)
             AND ${MANUAL_VERIFICATION_SNAPSHOT_GUARD_SQL}`,
        ).bind(
          now, authorization.idempotency_key, eventClaimNonce, now,
          id, expectedVersion, owner, attempt, lead.review_date, lead.review_date,
          candidate.item_id, itemExtra, ...proofGuardBindings,
        ),
        this.env.DB.prepare(
          `/* manual_source_support:generation_advance */ INSERT INTO daily_news_review_candidate_generations
             (review_date, lineage_id, generation, updated_at)
           SELECT ?, ?, ?, ?
           WHERE NOT EXISTS (SELECT 1 FROM daily_news_review_batches b
               WHERE b.review_date = ? AND b.lineage_id = ? AND b.is_current = 1)
             AND EXISTS (SELECT 1 FROM manual_news_leads l
               WHERE l.id = ? AND l.version = ? AND l.status = 'recommended'
                 AND l.confirmed_at = ? AND l.last_mutation_nonce = ?)
             AND ${MANUAL_VERIFICATION_SNAPSHOT_GUARD_SQL}
           ON CONFLICT(review_date, lineage_id) DO UPDATE SET
             generation = excluded.generation, updated_at = excluded.updated_at
           WHERE daily_news_review_candidate_generations.generation = ?
             AND NOT EXISTS (SELECT 1 FROM daily_news_review_batches b
               WHERE b.review_date = ? AND b.lineage_id = ? AND b.is_current = 1)
             AND EXISTS (SELECT 1 FROM manual_news_leads l
               WHERE l.id = ? AND l.version = ? AND l.status = 'recommended'
                 AND l.confirmed_at = ? AND l.last_mutation_nonce = ?)
             AND ${MANUAL_VERIFICATION_SNAPSHOT_GUARD_SQL}`,
        ).bind(
          lead.review_date, lead.review_date, generation + 1, now,
          lead.review_date, lead.review_date,
          id, expectedVersion + 1, now, eventClaimNonce,
          ...proofGuardBindings,
          generation,
          lead.review_date, lead.review_date,
          id, expectedVersion + 1, now, eventClaimNonce,
          ...proofGuardBindings,
        ),
        this.env.DB.prepare(
          `/* manual_source_support:final_audit_gate_prefreeze */ INSERT INTO manual_news_lead_audit (
             lead_id, action, from_status, to_status, idempotency_key, mutation_nonce,
             resulting_version, metadata_json, created_at
           ) VALUES (?, 'confirm_candidate', 'verifying', 'recommended', NULL,
             CASE WHEN EXISTS (
               SELECT 1 FROM manual_news_leads l
               WHERE l.id = ? AND l.version = ? AND l.status = 'recommended'
                 AND l.confirmed_batch_id IS NULL AND l.confirmed_at = ?
                 AND l.processing_owner IS NULL AND l.last_mutation_kind = 'source_support_confirm'
                 AND l.last_mutation_idempotency_key = ? AND l.last_mutation_nonce = ?
             ) AND EXISTS (SELECT 1 FROM items i
               WHERE i.id = ? AND i.source_id = ? AND i.source_ref = 'manual_lead'
                 AND i.title = ? AND i.content = ? AND i.extra = ?)
             AND NOT EXISTS (SELECT 1 FROM daily_news_review_batches b
               WHERE b.review_date = ? AND b.lineage_id = ? AND b.is_current = 1)
             AND EXISTS (SELECT 1 FROM daily_news_review_candidate_generations g
               WHERE g.review_date = ? AND g.lineage_id = ? AND g.generation = ?)
             AND ${MANUAL_VERIFICATION_SNAPSHOT_GUARD_SQL}
             THEN ? ELSE NULL END, ?, ?, ?)` ,
        ).bind(
          id,
          id, expectedVersion + 1, now, authorization.idempotency_key, eventClaimNonce,
          candidate.item_id, payload.item_projection.source_id, candidate.title, candidate.summary, itemExtra,
          lead.review_date, lead.review_date,
          lead.review_date, lead.review_date, generation + 1,
          ...proofGuardBindings,
          eventClaimNonce, expectedVersion + 1, finalMetadata, now,
        ),
        ]);
      } catch (error) {
        const eventOwner = await confirmedManualEventOwner(
          this.env, lead.review_date, payload.event_identity.event_key, eventClaimNonce,
        );
        if (eventOwner && eventOwner !== id) throw new Error('manual_candidate_event_conflict');
        throw error;
      }
      const updated = await getManualNewsLead(this.env, id);
      if (!updated || updated.version !== expectedVersion + 1
        || updated.status !== 'recommended' || updated.confirmed_batch_id !== null
        || updated.confirmed_at === null) throw new Error('source_support_atomic_write_failed');
      return updated;
    }
    const automaticEventIdentities = await loadAutomaticNewsReviewEventIdentitySidecar(
      this.env, active.candidates,
    );
    const merged = mergeAuthorizedManualNewsCandidates({
      previous_candidates: active.candidates,
      previous_default_selected_ids: active.default_selected_ids,
      published_selected_ids: active.applied_selected_ids || [],
      automatic_event_identities: automaticEventIdentities,
      manual_candidates: [
        ...existingManual.map((entry) => ({
          authorization_order: entry.authorization_order,
          candidate: entry.candidate,
        })),
        { authorization_order: authorization.audit_id, candidate },
      ],
    });
    const batchRevision = active.batch_revision + 1;
    const batchId = await buildNewsReviewBatchId(lead.review_date, merged.candidates, {
      batch_revision: batchRevision,
      supersedes_batch_id: active.batch_id,
      lineage_id: lead.review_date,
    });
    const candidateIds = merged.candidates.map((entry) => entry.item_id);
    const inheritsHumanSelection = active.human_reviewed && merged.default_selected_ids.length > 0;
    const inheritedSelectionHash = inheritsHumanSelection
      ? await newsReviewSelectionHash(merged.default_selected_ids)
      : null;
    // 同上：整批已确认快照打成一个 JSON 绑参。
    const existingProofGuard = MANUAL_VERIFICATION_SNAPSHOT_SET_GUARD_SQL;
    const existingProofBindings = [manualVerificationSnapshotSetGuardBinding(existingManual)];
    const activeSnapshotGuard = `EXISTS (
      SELECT 1 FROM daily_news_review_batches b
      WHERE b.review_date = ? AND b.lineage_id = ? AND b.batch_id = ?
        AND b.batch_revision = ? AND b.is_current = 1 AND b.candidate_generation = ?
        AND b.candidate_ids = ? AND b.candidates_json = ? AND b.default_selected_ids = ?
        AND b.applied_selected_ids IS ? AND b.selection_hash IS ?
        AND b.edit_revision = ? AND b.publish_status = ? AND b.human_reviewed = ?
        AND b.superseded_by IS ?
    )`;
    const activeSnapshotBindings: unknown[] = [
      lead.review_date, active.lineage_id, active.batch_id, active.batch_revision,
      active.candidate_generation, JSON.stringify(active.candidate_ids), JSON.stringify(active.candidates),
      JSON.stringify(active.default_selected_ids),
      active.applied_selected_ids === null ? null : JSON.stringify(active.applied_selected_ids),
      active.selection_hash, active.edit_revision, active.publish_status,
      active.human_reviewed ? 1 : 0, active.superseded_by,
    ];
    const sharedGate = `EXISTS (
      SELECT 1 FROM manual_news_leads l
      WHERE l.id = ? AND l.version = ? AND l.status = 'verifying'
        AND l.processing_owner = ? AND l.processing_attempt = ? AND l.confirmed_at IS NULL
    ) AND EXISTS (
      SELECT 1 FROM manual_news_lead_audit a
      WHERE a.id = ? AND a.lead_id = ? AND a.action = 'submit'
        AND a.resulting_version = 1 AND a.from_status IS NULL AND a.to_status = 'submitted'
        AND a.idempotency_key = ? AND a.metadata_json = ?
    ) AND ${evidenceGuard.sql}
      AND NOT EXISTS (SELECT 1 FROM manual_news_assessment_verifications v
        WHERE v.lead_id = ? AND v.status = 'active')
      AND (SELECT COUNT(*) FROM manual_news_leads l
        WHERE l.review_date = ? AND l.confirmed_at IS NOT NULL) < ${MANUAL_NEWS_REVIEW_CANDIDATE_LIMIT}
      AND NOT EXISTS (SELECT 1 FROM manual_news_lead_audit a
        WHERE a.action = 'confirm_candidate' AND a.mutation_nonce = ?)
      AND ${activeSnapshotGuard}
      AND EXISTS (SELECT 1 FROM daily_news_review_candidate_generations g
        WHERE g.review_date = ? AND g.lineage_id = ? AND g.generation = ?)
      AND ${existingProofGuard}
      AND length(?) BETWEEN 1 AND 80 AND length(?) BETWEEN 1 AND 180`;
    const sharedGateBindings: unknown[] = [
      id, expectedVersion, owner, attempt,
      authorization.audit_id, id, authorization.idempotency_key, submitMetadata,
      ...evidenceGuard.bindings,
      id, lead.review_date, eventClaimNonce,
      ...activeSnapshotBindings,
      lead.review_date, lead.review_date, active.candidate_generation,
      ...existingProofBindings,
      candidate.title, candidate.summary,
    ];
    const finalMetadata = JSON.stringify({
      candidate_authorization: MANUAL_NEWS_SOURCE_SUPPORT_POLICY,
      authorization_audit_id: authorization.audit_id,
      verification_id: verificationId,
      canonical_digest: proof.canonical_digest,
      batch_id: batchId,
      revision: batchRevision,
      supersedes: active.batch_id,
      event_key: payload.event_identity.event_key,
      event_aliases: merged.event_aliases,
      rerender_enqueued: false,
    });
    const statements = [
      this.env.DB.prepare(
        `/* manual_source_support:proof_insert */ INSERT INTO manual_news_assessment_verifications (
           verification_id, lead_id, assessment_version, policy_version, verification_key_id,
           canonical_digest, hmac_sha256, verification_json, processing_owner, processing_attempt,
           creation_nonce, status, reason, created_at, invalidated_at
         ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, NULL
         WHERE ${sharedGate}`,
      ).bind(
        verificationId, id, assessmentVersion, proof.policy_version, proof.verification_key_id,
        proof.canonical_digest, proof.hmac_sha256, verificationJson, owner, attempt, creationNonce, now,
        ...sharedGateBindings,
      ),
      this.env.DB.prepare(
        `/* manual_source_support:item_insert */ INSERT INTO items (
           id, source_type, source_id, source_ref, title, content, content_translated, author,
           url, published_at, scraped_at, is_relevant, matched_by, lang, extra
         ) SELECT ?, 'blog', ?, 'manual_lead', ?, ?, ?, ?, ?, ?, ?, 1, 'manual_lead', 'zh', ?
         WHERE ${MANUAL_VERIFICATION_SNAPSHOT_GUARD_SQL}`,
      ).bind(
        candidate.item_id, payload.item_projection.source_id, candidate.title, candidate.summary,
        candidate.summary, candidate.source, candidate.url || '', payload.item_projection.published_at,
        new Date(now).toISOString(), itemExtra, ...proofGuardBindings,
      ),
      this.env.DB.prepare(
        `/* manual_source_support:batch_insert */ INSERT INTO daily_news_review_batches (
           review_date, batch_id, candidate_ids, candidates_json, default_selected_ids,
           created_at, expires_at, batch_revision, supersedes_batch_id, revision_origin,
           lineage_id, is_current, candidate_generation, applied_selected_ids, selection_hash,
           edit_revision, publish_status, human_reviewed
         ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual_lead', ?, 0, ?, ?, ?, ?, ?, ?
         WHERE ${MANUAL_VERIFICATION_SNAPSHOT_GUARD_SQL} AND ${activeSnapshotGuard}`,
      ).bind(
        lead.review_date, batchId, JSON.stringify(candidateIds), JSON.stringify(merged.candidates),
        JSON.stringify(merged.default_selected_ids), now, newsReviewExpiresAt(lead.review_date),
        batchRevision, active.batch_id, lead.review_date, active.candidate_generation,
        inheritsHumanSelection ? JSON.stringify(merged.default_selected_ids) : null,
        inheritedSelectionHash, inheritsHumanSelection ? Math.max(active.edit_revision, 1) : 0,
        inheritsHumanSelection ? active.publish_status : 'not_requested', active.human_reviewed ? 1 : 0,
        ...proofGuardBindings, ...activeSnapshotBindings,
      ),
      this.env.DB.prepare(
        `/* manual_source_support:batch_supersede */ UPDATE daily_news_review_batches
         SET superseded_by = ?, is_current = 0
         WHERE review_date = ? AND lineage_id = ? AND batch_id = ? AND batch_revision = ? AND is_current = 1
           AND EXISTS (SELECT 1 FROM daily_news_review_batches next
             WHERE next.review_date = ? AND next.batch_id = ? AND next.is_current = 0)
           AND ${MANUAL_VERIFICATION_SNAPSHOT_GUARD_SQL}`,
      ).bind(
        batchId, lead.review_date, active.lineage_id, active.batch_id, active.batch_revision,
        lead.review_date, batchId, ...proofGuardBindings,
      ),
      this.env.DB.prepare(
        `/* manual_source_support:batch_activate */ UPDATE daily_news_review_batches
         SET is_current = 1
         WHERE review_date = ? AND lineage_id = ? AND batch_id = ? AND is_current = 0
           AND EXISTS (SELECT 1 FROM daily_news_review_batches previous
             WHERE previous.review_date = ? AND previous.batch_id = ?
               AND previous.superseded_by = ? AND previous.is_current = 0)
           AND ${MANUAL_VERIFICATION_SNAPSHOT_GUARD_SQL}`,
      ).bind(
        lead.review_date, lead.review_date, batchId,
        lead.review_date, active.batch_id, batchId, ...proofGuardBindings,
      ),
      this.env.DB.prepare(
        `/* manual_source_support:lead_confirm */ UPDATE manual_news_leads
         SET status = 'recommended', version = version + 1, confirmed_batch_id = ?, confirmed_at = ?,
           processing_owner = NULL, processing_lease_until = NULL,
           last_mutation_kind = 'source_support_confirm', last_mutation_idempotency_key = ?,
           last_mutation_nonce = ?, updated_at = ?
         WHERE id = ? AND version = ? AND status = 'verifying'
           AND processing_owner = ? AND processing_attempt = ? AND confirmed_at IS NULL
           AND EXISTS (SELECT 1 FROM daily_news_review_batches b
             WHERE b.review_date = ? AND b.batch_id = ? AND b.is_current = 1)
           AND ${MANUAL_VERIFICATION_SNAPSHOT_GUARD_SQL}`,
      ).bind(
        batchId, now, authorization.idempotency_key, eventClaimNonce, now,
        id, expectedVersion, owner, attempt, lead.review_date, batchId, ...proofGuardBindings,
      ),
      this.env.DB.prepare(
        `/* manual_source_support:final_audit_gate */ INSERT INTO manual_news_lead_audit (
           lead_id, action, from_status, to_status, idempotency_key, mutation_nonce,
           resulting_version, metadata_json, created_at
         ) VALUES (?, 'confirm_candidate', 'verifying', 'recommended', NULL,
           CASE WHEN EXISTS (
             SELECT 1 FROM manual_news_leads l
             WHERE l.id = ? AND l.version = ? AND l.status = 'recommended'
               AND l.confirmed_batch_id = ? AND l.confirmed_at = ?
               AND l.processing_owner IS NULL AND l.last_mutation_kind = 'source_support_confirm'
               AND l.last_mutation_idempotency_key = ? AND l.last_mutation_nonce = ?
           ) AND EXISTS (
             SELECT 1 FROM items i WHERE i.id = ? AND i.source_id = ? AND i.source_ref = 'manual_lead'
               AND i.title = ? AND i.content = ? AND i.extra = ?
           ) AND EXISTS (
             SELECT 1 FROM daily_news_review_batches b
             WHERE b.review_date = ? AND b.batch_id = ? AND b.batch_revision = ? AND b.is_current = 1
           ) AND ${MANUAL_VERIFICATION_SNAPSHOT_GUARD_SQL}
           THEN ? ELSE NULL END, ?, ?, ?)` ,
      ).bind(
        id,
        id, expectedVersion + 1, batchId, now, authorization.idempotency_key, eventClaimNonce,
        candidate.item_id, payload.item_projection.source_id, candidate.title, candidate.summary, itemExtra,
        lead.review_date, batchId, batchRevision,
        ...proofGuardBindings,
        eventClaimNonce, expectedVersion + 1, finalMetadata, now,
      ),
    ];
    try {
      await this.env.DB.batch(statements);
    } catch (error) {
      const eventOwner = await confirmedManualEventOwner(
        this.env, lead.review_date, payload.event_identity.event_key, eventClaimNonce,
      );
      if (eventOwner && eventOwner !== id) throw new Error('manual_candidate_event_conflict');
      throw error;
    }
    const updated = await getManualNewsLead(this.env, id);
    if (!updated || updated.version !== expectedVersion + 1
      || updated.status !== 'recommended' || updated.confirmed_batch_id !== batchId
      || updated.confirmed_at === null) throw new Error('source_support_atomic_write_failed');
    return updated;
  }

  getPaidRetrievalEpoch(id: string): Promise<number> {
    return getManualNewsLeadPaidRetrievalEpoch(this.env, id);
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

  /**
   * ⚠️ 已知限制（2026-09-03，`owner_vouched_v1` 上线时确认并接受）：跨天事件去重的历史只
   * 来自 `manual_news_event_assessments`（大模型评估）与自动候选的 `event_fingerprint`，
   * **owner 担保的线索不参与**——它没有评估行，事件身份只绑主证据 URL。
   * 影响面：同一件事今天被担保、明天走大模型评估补录时，不会被判成「已推送过的旧闻」。
   * 同一天内的重复担保仍被 confirm 的事件占用检查（mutation_nonce 唯一索引）挡住。
   */
  async listRecentPriorEvents(date: string, excludeLeadId: string): Promise<ManualLeadPriorEvent[]> {
    const sourceScanLimit = MANUAL_NEWS_PRIOR_EVENT_PROVIDER_LIMITS.max_events * 2;
    const manual = await this.env.DB.prepare(
      `/* manual_assessment:recent_prior_events */ SELECT a.event_key, l.review_date, l.id AS lead_id
       FROM manual_news_event_assessments a
       JOIN manual_news_assessment_verifications v
         ON v.lead_id = a.lead_id AND v.assessment_version = a.assessment_version AND v.status = 'active'
       JOIN manual_news_leads l ON l.id = a.lead_id
       WHERE l.id <> ? AND l.review_date BETWEEN date(?, '-14 days') AND ?
       ORDER BY l.review_date DESC, a.event_key ASC, l.id ASC
       LIMIT ?`,
    ).bind(excludeLeadId, date, date, sourceScanLimit)
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
         AND substr(COALESCE(published_at, scraped_at), 1, 10) BETWEEN date(?, '-14 days') AND ?
       ORDER BY review_date DESC, event_key ASC, lead_id ASC
       LIMIT ?`,
    ).bind(`blog:manual:${excludeLeadId}`, date, date, sourceScanLimit)
      .all<{ event_key: string; review_date: string; lead_id: string }>();
    return boundedManualLeadPriorEvents([
      ...verifiedManual,
      ...(items.results || []),
    ]);
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

export interface ManualNewsLeadCandidateMutationResult {
  ok: true;
  changed: boolean;
  lead: ManualNewsLeadRecord;
  batch: {
    batch_id: string;
    revision: number;
    supersedes_revision: number | null;
    current: boolean;
    review_url: string;
  } | null;
  pending_initial_freeze: boolean;
  rerender_enqueued: false;
}

export type ManualNewsLeadCandidateMutationOutcome =
  | ManualNewsLeadCandidateMutationResult
  | { ok: false; status: 400 | 404 | 409; error: string; lead?: ManualNewsLeadRecord };

/**
 * owner 担保确认。
 *
 * 两步：先把签名快照与 `vouch_candidate` 审计原子写进库（线索 version+1、
 * `last_mutation_kind='vouch'`），再复用既有的 {@link confirmManualNewsLeadCandidate}
 * 走完确认流程（冻结前候选池 / 新批次 / 事件占用冲突都不另起一套）。
 *
 * 按证据数量分派放行方式：
 * - 有签名证据 → `owner_vouched_v1`（owner 担保 + 证据链，行为与 2026-09-03 上线时一致）
 * - 零证据     → `owner_asserted_v1`（owner 断言，陈述本身就是全部依据）
 *
 * 零证据以前直接回 409 `lead_not_vouchable`，2026-09-04 owner 那三条取证全失败的线索
 * 因此救不回来 —— 这条分派就是那次事故的修复。
 *
 * 第二步 409 时**保留** proof 行：owner 拿到新的 batch revision 重试即可，不必重写陈述。
 */
export async function vouchManualNewsLeadCandidate(
  env: Env,
  id: string,
  expectedVersion: number,
  expectedBatchRevision: number,
  statementInput: unknown,
  idempotencyKey: string,
  now = Date.now(),
): Promise<ManualNewsLeadCandidateMutationOutcome> {
  let statement: string;
  try {
    statement = normalizeOwnerVouchStatement(statementInput);
  } catch {
    return { ok: false, status: 400, error: 'invalid_vouch_statement' };
  }
  const lead = await getManualNewsLead(env, id);
  if (!lead) return { ok: false, status: 404, error: 'manual_news_lead_not_found' };
  const confirmKey = `${idempotencyKey}:confirm`;
  // 已有任何一条 active 验证行(含未知 / 已篡改 policy)就不能再担保 —— 唯一活跃索引会
  // 挡住写入,这里显式判掉才能回一个说得清的错误码。
  const activeVerification = await env.DB.prepare(
    `/* manual_owner_vouch:active_verification */ SELECT verification_id
     FROM manual_news_assessment_verifications
     WHERE lead_id = ? AND status = 'active' LIMIT 1`,
  ).bind(id).first<{ verification_id: string }>();
  const existing = activeVerification ? await loadVerifiedManualCandidateProof(env, id) : null;
  // 同一句陈述已经写过快照（第二步失败后重试，或整轮重放）时跳过写入，直接续做确认。
  const reusable = (existing?.policy_version === MANUAL_NEWS_OWNER_VOUCH_POLICY
    && existing.owner_vouch?.statement === statement)
    || (existing?.policy_version === MANUAL_NEWS_OWNER_ASSERTED_POLICY
      && existing.owner_asserted?.statement === statement);
  const row = await env.DB.prepare(
    `/* manual_lead:by_id */ SELECT * FROM manual_news_leads WHERE id = ?`,
  ).bind(id).first<ManualLeadRow>();
  // 同一个幂等键的整轮重放：版本号照旧是发起时那个，不能拿它当版本冲突。
  const replayed = !!row && (
    (row.last_mutation_kind === MANUAL_NEWS_OWNER_VOUCH_MUTATION_KIND
      && row.last_mutation_idempotency_key === idempotencyKey)
    || (row.last_mutation_kind === 'confirm' && row.last_mutation_idempotency_key === confirmKey));
  if (reusable && !replayed && lead.version !== expectedVersion) {
    return { ok: false, status: 409, error: 'lead_version_conflict', lead };
  }
  if (!reusable) {
    if (activeVerification) return { ok: false, status: 409, error: 'lead_not_vouchable', lead };
    if (lead.confirmed_at !== null) return { ok: false, status: 409, error: 'lead_already_confirmed', lead };
    if (now >= newsReviewExpiresAt(lead.review_date)) {
      return { ok: false, status: 409, error: 'review_expired', lead };
    }
    if (lead.version !== expectedVersion) {
      return { ok: false, status: 409, error: 'lead_version_conflict', lead };
    }
    if (!['needs_review', 'failed'].includes(lead.status)) {
      return { ok: false, status: 409, error: 'lead_not_vouchable', lead };
    }
    let written: Awaited<ReturnType<typeof writeOwnerVouchProof>>;
    try {
      // 零证据走直接录入(owner_asserted_v1)；入口仍是担保按钮，所以审计 action 与
      // last_mutation_kind 保持 vouch 一侧，如实记录 owner 是从哪儿点进来的。
      written = lead.evidence.length >= 1
        ? await writeOwnerVouchProof(env, lead, statement, idempotencyKey, now)
        : await writeOwnerAssertedProof(env, lead, statement, idempotencyKey, now, {
          auditAction: MANUAL_NEWS_OWNER_VOUCH_AUDIT_ACTION,
          mutationKind: MANUAL_NEWS_OWNER_VOUCH_MUTATION_KIND,
        });
    } catch (error) {
      // 证据链自己不成立(证据集非法 / response HMAC 或正文摘要对不上)时，担保这条路本来
      // 就走不通，回 409 让 owner 看到「不能担保」，而不是把内部异常抛成 500。
      const message = error instanceof Error ? error.message : '';
      if (message === 'owner_vouch_payload_invalid' || message === 'owner_asserted_payload_invalid'
        || message.startsWith('manual_news_evidence_')) {
        // 只记错误名,不记证据内容:409 lead_not_vouchable 在 prod 上看不出是哪一环拒的,
        // 没有这行日志就只能靠猜(2026-09-03 推文证据摘要误判即是如此)。
        console.warn('[manual-news-vouch] evidence chain rejected', { lead_id: id, error: message });
        return { ok: false, status: 409, error: 'lead_not_vouchable', lead };
      }
      throw error;
    }
    if (!written.ok) return written;
  }
  return confirmManualNewsLeadCandidate(
    env, id, reusable ? lead.version : expectedVersion + 1, expectedBatchRevision, confirmKey, now,
  );
}

type OwnerAuthorizationWriteResult =
  | { ok: true }
  | { ok: false; status: 409; error: string; lead: ManualNewsLeadRecord };

/**
 * owner 担保（`owner_vouched_v1`）的快照写入。零证据线索不能走这里 —— 担保 payload
 * 必须有主证据，调用方按证据数量分派到 {@link writeOwnerAssertedProof}。
 */
async function writeOwnerVouchProof(
  env: Env,
  lead: ManualNewsLeadRecord,
  statement: string,
  idempotencyKey: string,
  now: number,
): Promise<OwnerAuthorizationWriteResult> {
  const assessmentVersion = lead.version * 1_000_000 + 900_000;
  if (!Number.isSafeInteger(assessmentVersion) || assessmentVersion <= 0) {
    throw new Error('invalid_assessment_version');
  }
  const payload = await createManualNewsOwnerVouchPayload({
    lead: { id: lead.id, review_date: lead.review_date },
    statement,
    evidence: lead.evidence,
    vouched_at: now,
  });
  const proof = await createManualNewsOwnerVouchProof(
    { lead_id: lead.id, assessment_version: assessmentVersion, payload },
    manualNewsVerificationKeyring(env), manualNewsResponseKeyring(env),
  );
  return writeOwnerAuthorizationProof(env, lead, {
    statement,
    assessmentVersion,
    payloadJson: JSON.stringify(payload),
    proof,
    auditAction: MANUAL_NEWS_OWNER_VOUCH_AUDIT_ACTION,
    mutationKind: MANUAL_NEWS_OWNER_VOUCH_MUTATION_KIND,
    processingOwner: `owner-vouch:${lead.id}`,
  }, idempotencyKey, now);
}

/**
 * owner 直接录入（`owner_asserted_v1`）的快照写入。证据可以是 0 条；挂了证据也照常
 * 被签进快照并做密码学校验。
 *
 * `auditAction` / `mutationKind` 由调用方给：一步直接录入是 `assert_candidate` / `assert`，
 * 零证据线索从担保按钮救回时沿用 `vouch_candidate` / `vouch`，让审计如实记录入口。
 */
async function writeOwnerAssertedProof(
  env: Env,
  lead: ManualNewsLeadRecord,
  statement: string,
  idempotencyKey: string,
  now: number,
  entry: { auditAction: string; mutationKind: string } = {
    auditAction: MANUAL_NEWS_OWNER_ASSERTED_AUDIT_ACTION,
    mutationKind: MANUAL_NEWS_OWNER_ASSERTED_MUTATION_KIND,
  },
): Promise<OwnerAuthorizationWriteResult> {
  const assessmentVersion = lead.version * 1_000_000 + 800_000;
  if (!Number.isSafeInteger(assessmentVersion) || assessmentVersion <= 0) {
    throw new Error('invalid_assessment_version');
  }
  const payload = await createManualNewsOwnerAssertedPayload({
    lead: { id: lead.id, review_date: lead.review_date, input_url: lead.input_url },
    statement,
    evidence: lead.evidence,
    asserted_at: now,
  });
  const proof = await createManualNewsOwnerAssertedProof(
    {
      lead_id: lead.id,
      input_url: lead.input_url,
      assessment_version: assessmentVersion,
      payload,
    },
    manualNewsVerificationKeyring(env), manualNewsResponseKeyring(env),
  );
  return writeOwnerAuthorizationProof(env, lead, {
    statement,
    assessmentVersion,
    payloadJson: JSON.stringify(payload),
    proof,
    auditAction: entry.auditAction,
    mutationKind: entry.mutationKind,
    processingOwner: `owner-asserted:${lead.id}`,
  }, idempotencyKey, now);
}

/**
 * 担保 / 直接录入共用的三语句原子写入：proof 行 + 线索状态推进 + 授权审计。
 *
 * 三条语句彼此因果绑定（后一条的 guard 引用前一条的落盘结果），要么全成要么全不成；
 * 全 0 说明版本被别人推走了，回 409 让 owner 拿新版本重试。
 */
async function writeOwnerAuthorizationProof(
  env: Env,
  lead: ManualNewsLeadRecord,
  input: {
    statement: string;
    assessmentVersion: number;
    payloadJson: string;
    proof: {
      policy_version: string;
      verification_key_id: string;
      canonical_digest: string;
      hmac_sha256: string;
    };
    auditAction: string;
    mutationKind: string;
    processingOwner: string;
  },
  idempotencyKey: string,
  now: number,
): Promise<OwnerAuthorizationWriteResult> {
  const expectedVersion = lead.version;
  const { proof, assessmentVersion } = input;
  const verificationId = `mav:${lead.id}:${assessmentVersion}:${proof.canonical_digest.slice(0, 16)}`;
  const creationNonce = createMutationNonce(`${input.mutationKind}_verification_create`);
  const mutationNonce = createMutationNonce(input.mutationKind);
  // 这一步不占 workflow 的 processing fence（owner 从页面直接发起），但 proof 行的
  // processing_owner / processing_attempt 有 NOT NULL 与 > 0 约束，这里记录发起方身份。
  const processingAttempt = 1;
  const verification: PersistedManualVerificationRow = {
    verification_id: verificationId,
    lead_id: lead.id,
    assessment_version: assessmentVersion,
    policy_version: proof.policy_version,
    verification_key_id: proof.verification_key_id,
    canonical_digest: proof.canonical_digest,
    hmac_sha256: proof.hmac_sha256,
    verification_json: input.payloadJson,
    processing_owner: input.processingOwner,
    processing_attempt: processingAttempt,
    creation_nonce: creationNonce,
    status: 'active',
    reason: null,
    created_at: now,
    invalidated_at: null,
  };
  const proofGuardBindings = manualVerificationSnapshotGuardBindings(lead.id, verification);
  const evidenceGuard = sourceSupportEvidenceSnapshotGuard(lead.id, lead.evidence);
  const auditMetadata = JSON.stringify({
    candidate_authorization: proof.policy_version,
    statement: input.statement,
    canonical_digest: proof.canonical_digest,
    verification_id: verificationId,
  });
  const leadGuard = `EXISTS (
    SELECT 1 FROM manual_news_leads l
    WHERE l.id = ? AND l.version = ? AND l.status IN ('needs_review', 'failed')
      AND l.confirmed_at IS NULL
  )`;
  const results = await env.DB.batch([
    env.DB.prepare(
      `/* manual_owner_vouch:proof_insert */ INSERT OR IGNORE INTO manual_news_assessment_verifications (
         verification_id, lead_id, assessment_version, policy_version, verification_key_id,
         canonical_digest, hmac_sha256, verification_json, processing_owner, processing_attempt,
         creation_nonce, status, reason, created_at, invalidated_at
       ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, NULL
       WHERE ${leadGuard}
         AND NOT EXISTS (SELECT 1 FROM manual_news_assessment_verifications v
           WHERE v.lead_id = ? AND v.status = 'active')
         AND ${evidenceGuard.sql}`,
    ).bind(
      verificationId, lead.id, assessmentVersion, proof.policy_version, proof.verification_key_id,
      proof.canonical_digest, proof.hmac_sha256, input.payloadJson, input.processingOwner,
      processingAttempt, creationNonce, now,
      lead.id, expectedVersion,
      lead.id,
      ...evidenceGuard.bindings,
    ),
    env.DB.prepare(
      `/* manual_owner_vouch:lead_vouch */ UPDATE manual_news_leads SET
         status = 'needs_review', version = version + 1,
         last_mutation_kind = ?, last_mutation_idempotency_key = ?, last_mutation_nonce = ?,
         updated_at = ?
       WHERE id = ? AND version = ? AND status IN ('needs_review', 'failed')
         AND confirmed_at IS NULL
         AND ${MANUAL_VERIFICATION_SNAPSHOT_GUARD_SQL}`,
    ).bind(
      input.mutationKind, idempotencyKey, mutationNonce, now,
      lead.id, expectedVersion, ...proofGuardBindings,
    ),
    env.DB.prepare(
      `/* manual_owner_vouch:audit */ INSERT INTO manual_news_lead_audit (
         lead_id, action, from_status, to_status, idempotency_key, mutation_nonce,
         resulting_version, metadata_json, created_at
       ) SELECT ?, ?, ?, 'needs_review', ?, ?, version, ?, ? FROM manual_news_leads
       WHERE id = ? AND version = ? AND status = 'needs_review'
         AND last_mutation_kind = ? AND last_mutation_idempotency_key = ?
         AND last_mutation_nonce = ?
         AND ${MANUAL_VERIFICATION_SNAPSHOT_GUARD_SQL}`,
    ).bind(
      lead.id, input.auditAction, lead.status, idempotencyKey, mutationNonce,
      auditMetadata, now,
      lead.id, expectedVersion + 1, input.mutationKind, idempotencyKey,
      mutationNonce, ...proofGuardBindings,
    ),
  ]) as Array<{ meta?: { changes?: number } }>;
  const changes = results.map((entry) => Number(entry?.meta?.changes || 0));
  if (changes.every((value) => value === 0)) {
    const latest = await getManualNewsLead(env, lead.id);
    return {
      ok: false, status: 409, error: 'lead_version_conflict', lead: latest || lead,
    };
  }
  if (changes.some((value) => value !== 1)) throw new Error('manual_lead_audit_causality_mismatch');
  return { ok: true };
}

/**
 * owner 一步直接录入（`owner_asserted_v1`）。
 *
 * 不派发 Workflow、不做任何取证：一个 `DB.batch` 内建线索（`needs_review`、
 * `error_code=NULL`）+ 写 `submit` 与 `assert_candidate` 审计 + 写签名快照，然后复用
 * {@link confirmManualNewsLeadCandidate} 走完既有确认流程。
 *
 * 幂等：同一个 `Idempotency-Key` 落在同一天、同一份输入上时命中已有线索，续做后面的
 * 步骤并返回同一结果；输入变了则回 `idempotency_key_reused_with_different_payload`。
 * 命中的线索若已经带着证据（例如取证跑完一半的旧线索），证据照样被签进快照并做
 * 密码学校验 —— 断言可以不带证据，带上的证据必须是真的。
 */
export async function assertManualNewsLeadCandidate(
  env: Env,
  input: {
    date?: unknown;
    text?: unknown;
    url?: unknown;
    note?: unknown;
    statement?: unknown;
    expected_batch_revision?: unknown;
  },
  idempotencyKey: string,
  now = Date.now(),
): Promise<ManualNewsLeadCandidateMutationOutcome> {
  const normalized = validateManualNewsLeadInput({
    date: input.date, text: input.text, url: input.url, note: input.note,
  });
  let statement: string;
  try {
    // 陈述缺省时用文字线索本身:owner 在页面上写的那句话就是他要断言的事。
    statement = normalizeOwnerVouchStatement(
      input.statement === undefined || input.statement === null || input.statement === ''
        ? normalized.text
        : input.statement,
    );
  } catch {
    return { ok: false, status: 400, error: 'invalid_vouch_statement' };
  }
  // 审核窗口早就过了就别建线索了 —— 后面的确认一定会拒,留一条建了又用不上的
  // needs_review 线索只会让 owner 在列表里看见垃圾。
  if (now >= newsReviewExpiresAt(normalized.date)) {
    return { ok: false, status: 409, error: 'review_expired' };
  }
  const confirmKey = `${idempotencyKey}:confirm`;
  const expectedBatchRevision = Number.isInteger(Number(input.expected_batch_revision))
    && Number(input.expected_batch_revision) >= 0
    ? Number(input.expected_batch_revision)
    // 一步录入没有「先读后写」的机会,缺省时就取当前 active 批次的 revision。
    : (await getActiveNewsReviewBatch(env, normalized.date))?.batch_revision || 0;
  const existingRow = await env.DB.prepare(
    `/* manual_lead:by_submit_key */ SELECT * FROM manual_news_leads
     WHERE review_date = ? AND submit_idempotency_key = ?`,
  ).bind(normalized.date, idempotencyKey).first<ManualLeadRow>();
  if (existingRow) {
    if (existingRow.input_type !== normalized.input_type
      || existingRow.input_text !== normalized.text
      || existingRow.input_url !== normalized.url
      || (existingRow.note || '') !== normalized.note) {
      throw new Error('idempotency_key_reused_with_different_payload');
    }
    const existingLead = await leadFromRow(env, existingRow);
    return continueOwnerAssertedEntry(
      env, existingLead, statement, idempotencyKey, confirmKey, expectedBatchRevision, now,
    );
  }
  const submitIdentityDigest = await manualNewsSubmitIdentityDigest({
    date: normalized.date,
    input_type: normalized.input_type,
    text: normalized.text,
    url: normalized.url,
    note: normalized.note,
    candidate_authorization: MANUAL_NEWS_OWNER_ASSERTED_POLICY,
  });
  const hash = await sha256Hex(
    `manual-news-owner-asserted-lead-id-v1\0${normalized.date}\0${idempotencyKey}\0${submitIdentityDigest}`,
  );
  const id = `ml-${normalized.date.replace(/-/g, '')}-${hash.slice(0, 12)}`;
  const created = await createOwnerAssertedLead(env, {
    id, normalized, statement, idempotencyKey, now,
  });
  if (!created.ok) return created;
  const lead = await getManualNewsLead(env, id);
  if (!lead) throw new Error('manual_news_lead_insert_failed');
  return confirmManualNewsLeadCandidate(env, id, lead.version, expectedBatchRevision, confirmKey, now);
}

/** 命中已有线索时的续做：缺 proof 就补写，再走确认。 */
async function continueOwnerAssertedEntry(
  env: Env,
  lead: ManualNewsLeadRecord,
  statement: string,
  idempotencyKey: string,
  confirmKey: string,
  expectedBatchRevision: number,
  now: number,
): Promise<ManualNewsLeadCandidateMutationOutcome> {
  const activeVerification = await env.DB.prepare(
    `/* manual_owner_vouch:active_verification */ SELECT verification_id
     FROM manual_news_assessment_verifications
     WHERE lead_id = ? AND status = 'active' LIMIT 1`,
  ).bind(lead.id).first<{ verification_id: string }>();
  const existing = activeVerification ? await loadVerifiedManualCandidateProof(env, lead.id) : null;
  const reusable = existing?.policy_version === MANUAL_NEWS_OWNER_ASSERTED_POLICY
    && existing.owner_asserted?.statement === statement;
  if (reusable) {
    return confirmManualNewsLeadCandidate(env, lead.id, lead.version, expectedBatchRevision, confirmKey, now);
  }
  if (activeVerification) return { ok: false, status: 409, error: 'lead_not_vouchable', lead };
  if (lead.confirmed_at !== null) return { ok: false, status: 409, error: 'lead_already_confirmed', lead };
  if (now >= newsReviewExpiresAt(lead.review_date)) {
    return { ok: false, status: 409, error: 'review_expired', lead };
  }
  if (!['needs_review', 'failed'].includes(lead.status)) {
    return { ok: false, status: 409, error: 'lead_not_vouchable', lead };
  }
  let written: Awaited<ReturnType<typeof writeOwnerAssertedProof>>;
  try {
    written = await writeOwnerAssertedProof(env, lead, statement, idempotencyKey, now);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message === 'owner_asserted_payload_invalid' || message.startsWith('manual_news_evidence_')) {
      console.warn('[manual-news-assert] evidence chain rejected', { lead_id: lead.id, error: message });
      return { ok: false, status: 409, error: 'lead_not_vouchable', lead };
    }
    throw error;
  }
  if (!written.ok) return written;
  return confirmManualNewsLeadCandidate(
    env, lead.id, lead.version + 1, expectedBatchRevision, confirmKey, now,
  );
}

/**
 * 建线索 + submit 审计 + 签名快照 + `assert_candidate` 审计，四条语句一个 batch。
 *
 * 四条彼此因果绑定：后一条的 guard 引用前一条的落盘结果。全 0 说明这个幂等键已经被
 * 别人用掉了（并发重放），回 409 让调用方按已有线索续做。
 */
async function createOwnerAssertedLead(
  env: Env,
  input: {
    id: string;
    normalized: ReturnType<typeof validateManualNewsLeadInput>;
    statement: string;
    idempotencyKey: string;
    now: number;
  },
): Promise<{ ok: true } | { ok: false; status: 409; error: string }> {
  const { id, normalized, statement, idempotencyKey, now } = input;
  const assessmentVersion = 1 * 1_000_000 + 800_000;
  const payload = await createManualNewsOwnerAssertedPayload({
    lead: { id, review_date: normalized.date, input_url: normalized.url },
    statement,
    evidence: [],
    asserted_at: now,
  });
  const proof = await createManualNewsOwnerAssertedProof(
    { lead_id: id, input_url: normalized.url, assessment_version: assessmentVersion, payload },
    manualNewsVerificationKeyring(env), manualNewsResponseKeyring(env),
  );
  const payloadJson = JSON.stringify(payload);
  const verificationId = `mav:${id}:${assessmentVersion}:${proof.canonical_digest.slice(0, 16)}`;
  const mutationNonce = createMutationNonce(MANUAL_NEWS_OWNER_ASSERTED_MUTATION_KIND);
  const creationNonce = createMutationNonce('owner_asserted_verification_create');
  const auditNonce = createMutationNonce('owner_asserted_authorization');
  const processingOwner = `owner-asserted:${id}`;
  const verification: PersistedManualVerificationRow = {
    verification_id: verificationId,
    lead_id: id,
    assessment_version: assessmentVersion,
    policy_version: proof.policy_version,
    verification_key_id: proof.verification_key_id,
    canonical_digest: proof.canonical_digest,
    hmac_sha256: proof.hmac_sha256,
    verification_json: payloadJson,
    processing_owner: processingOwner,
    processing_attempt: 1,
    creation_nonce: creationNonce,
    status: 'active',
    reason: null,
    created_at: now,
    invalidated_at: null,
  };
  const proofGuardBindings = manualVerificationSnapshotGuardBindings(id, verification);
  const leadGuard = `EXISTS (
    SELECT 1 FROM manual_news_leads l
    WHERE l.id = ? AND l.version = 1 AND l.status = 'needs_review' AND l.confirmed_at IS NULL
      AND l.review_date = ? AND l.submit_idempotency_key = ? AND l.last_mutation_nonce = ?
  )`;
  const leadGuardBindings = [id, normalized.date, idempotencyKey, mutationNonce];
  const results = await env.DB.batch([
    env.DB.prepare(
      `/* manual_lead:assert_insert */ INSERT OR IGNORE INTO manual_news_leads (
         id, review_date, input_type, input_text, input_url, note, status, version,
         error_code, error_message, submit_idempotency_key, last_mutation_kind,
         last_mutation_idempotency_key, last_mutation_nonce, processing_owner,
         processing_attempt, processing_lease_until, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'needs_review', 1, NULL, NULL, ?, ?, ?, ?, NULL, 0, NULL, ?, ?)`,
    ).bind(
      id, normalized.date, normalized.input_type, normalized.text, normalized.url, normalized.note,
      idempotencyKey, MANUAL_NEWS_OWNER_ASSERTED_MUTATION_KIND, idempotencyKey, mutationNonce,
      now, now,
    ),
    env.DB.prepare(
      `/* manual_lead:assert_submit_audit */ INSERT INTO manual_news_lead_audit (
         lead_id, action, from_status, to_status, idempotency_key, mutation_nonce,
         resulting_version, metadata_json, created_at
       ) SELECT ?, 'submit', NULL, 'needs_review', ?, ?, 1, ?, ? WHERE ${leadGuard}`,
    ).bind(
      id, idempotencyKey, mutationNonce, JSON.stringify({
        input_type: normalized.input_type,
        candidate_authorization: MANUAL_NEWS_OWNER_ASSERTED_POLICY,
      }), now,
      ...leadGuardBindings,
    ),
    env.DB.prepare(
      `/* manual_owner_asserted:proof_insert */ INSERT OR IGNORE INTO manual_news_assessment_verifications (
         verification_id, lead_id, assessment_version, policy_version, verification_key_id,
         canonical_digest, hmac_sha256, verification_json, processing_owner, processing_attempt,
         creation_nonce, status, reason, created_at, invalidated_at
       ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'active', NULL, ?, NULL
       WHERE ${leadGuard}
         AND NOT EXISTS (SELECT 1 FROM manual_news_assessment_verifications v
           WHERE v.lead_id = ? AND v.status = 'active')
         AND (SELECT COUNT(*) FROM manual_news_evidence WHERE lead_id = ?) = 0`,
    ).bind(
      verificationId, id, assessmentVersion, proof.policy_version, proof.verification_key_id,
      proof.canonical_digest, proof.hmac_sha256, payloadJson, processingOwner, creationNonce, now,
      ...leadGuardBindings, id, id,
    ),
    env.DB.prepare(
      `/* manual_owner_asserted:audit */ INSERT INTO manual_news_lead_audit (
         lead_id, action, from_status, to_status, idempotency_key, mutation_nonce,
         resulting_version, metadata_json, created_at
       ) SELECT ?, ?, 'needs_review', 'needs_review', NULL, ?, 1, ?, ?
       WHERE ${leadGuard} AND ${MANUAL_VERIFICATION_SNAPSHOT_GUARD_SQL}`,
    ).bind(
      id, MANUAL_NEWS_OWNER_ASSERTED_AUDIT_ACTION, auditNonce, JSON.stringify({
        candidate_authorization: MANUAL_NEWS_OWNER_ASSERTED_POLICY,
        statement,
        canonical_digest: proof.canonical_digest,
        verification_id: verificationId,
      }), now,
      ...leadGuardBindings, ...proofGuardBindings,
    ),
  ]) as Array<{ meta?: { changes?: number } }>;
  const changes = results.map((entry) => Number(entry?.meta?.changes || 0));
  if (changes.every((value) => value === 0)) {
    return { ok: false, status: 409, error: 'lead_version_conflict' };
  }
  if (changes.some((value) => value !== 1)) throw new Error('manual_lead_audit_causality_mismatch');
  return { ok: true };
}

export async function confirmManualNewsLeadCandidate(
  env: Env,
  id: string,
  expectedVersion: number,
  expectedBatchRevision: number,
  idempotencyKey: string,
  now = Date.now(),
): Promise<ManualNewsLeadCandidateMutationOutcome> {
  const lead = await getManualNewsLead(env, id);
  if (!lead) return { ok: false, status: 404, error: 'manual_news_lead_not_found' };
  const row = await env.DB.prepare(
    `/* manual_lead:by_id */ SELECT * FROM manual_news_leads WHERE id = ?`,
  ).bind(id).first<ManualLeadRow>();
  // 放行凭据统一从 loadVerifiedManualCandidateProof 取:大模型评估(v10)仍要求线索自己
  // 带得出可读评估;source_support_v1 与 owner_vouched_v1 走签名快照,没有评估行也能确认。
  const verified = await loadVerifiedManualCandidateProof(env, id);
  if (!verified
    || (verified.policy_version === MANUAL_LEAD_VERIFICATION_POLICY_VERSION
      && (!verified.assessment || !lead.assessment))) {
    return { ok: false, status: 409, error: 'lead_not_fact_verified', lead };
  }
  const assessment = verified.assessment;
  const eventKey = verified.candidate.event_key;
  const eventClaimNonce = await manualEventClaimNonce(lead.review_date, eventKey);
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
  const existingEventOwner = await confirmedManualEventOwner(
    env, lead.review_date, eventKey, eventClaimNonce,
  );
  if (existingEventOwner && existingEventOwner !== id) {
    return { ok: false, status: 409, error: 'manual_candidate_event_conflict', lead };
  }

  const primaryEvidence = lead.evidence.find((item) => item.reliable) || lead.evidence[0];
  // Keep the canonical `${source_type}:${source_id}` identity so existing
  // render/deep-link/item-page paths continue to understand manual candidates.
  const itemId = `blog:manual:${lead.id}`;
  const candidate: ManualReviewCandidate = assessment ? {
    item_id: itemId,
    title: assessment.title,
    summary: assessment.summary,
    source: primaryEvidence?.publisher || '手工补录',
    score: assessment.score,
    ...(primaryEvidence?.url || lead.input_url ? { url: primaryEvidence?.url || lead.input_url } : {}),
    // 源站发布时间原值透传,空值省略字段。取值表达式必须与 news-review.ts 的
    // verifiedManualCandidateSnapshot(legacy 分支)逐字一致 —— 那是同一条候选被
    // sanitize 重建时的读取口径,不一致会让每次 sanitize 都看到 drift 而空转 bump 版本。
    ...(primaryEvidence?.published_at ? { published_at: primaryEvidence.published_at } : {}),
    event_key: eventKey,
    origin: 'manual_lead' as const,
    lead_id: lead.id,
  } : {
    // 签名快照路径(source_support_v1 / owner_vouched_v1):item_projection 被
    // canonical_digest / hmac_sha256 覆盖,必须逐字透传。这里的展开式与
    // news-review.ts 的 verifiedManualCandidateSnapshot 同一条 —— 两侧不一致同样会
    // 让 sanitize 每次都看到 drift。
    ...verified.candidate,
    origin: 'manual_lead' as const,
    lead_id: lead.id,
  };
  // Never invent a source publication time. `scraped_at` records our own
  // ingestion separately; missing source timing remains NULL and visible as uncertainty.
  // 签名快照路径改取投影里的时间:那一列被 HMAC 覆盖,正式新闻门的最终守卫也拿它跟
  // items.published_at 逐字对比,用「第一条带时间的证据」会在多证据时对不上而被拒。
  const publishedAt = assessment
    ? lead.evidence.map((item) => item.published_at).find(Boolean) || null
    : candidate.published_at ?? null;
  const itemExtra = JSON.stringify({
    title_zh: candidate.title,
    ai_summary_zh: candidate.summary,
    source_company: candidate.source,
    event_fingerprint: eventKey,
    manual_lead: { lead_id: lead.id, evidence_ids: lead.evidence.map((item) => item.id) },
  });
  // The successful confirmation audit is the event ownership record. Its existing
  // unique mutation_nonce index atomically selects one owner without a separate
  // claim that could survive a downstream zero-row guard.
  const confirmationNonce = eventClaimNonce;
  let active = await getActiveNewsReviewBatch(env, lead.review_date);
  const activeSanitization = active
    ? await sanitizeCurrentNewsReviewBatch(env, lead.review_date, now)
    : null;
  if (activeSanitization) active = activeSanitization.batch;
  if ((active?.batch_revision || 0) !== expectedBatchRevision) {
    const eventOwner = await confirmedManualEventOwner(
      env, lead.review_date, eventKey, eventClaimNonce,
    );
    if (eventOwner && eventOwner !== id) {
      return { ok: false, status: 409, error: 'manual_candidate_event_conflict', lead };
    }
    return { ok: false, status: 409, error: 'candidate_batch_revision_conflict', lead };
  }
  if (!active) {
    let results: Array<{ meta?: { changes?: number } }>;
    try {
      results = await env.DB.batch([
      env.DB.prepare(
        `/* manual_lead:candidate_generation_init */ INSERT OR IGNORE INTO daily_news_review_candidate_generations
         (review_date, lineage_id, generation, updated_at) VALUES (?, ?, 0, ?)`,
      ).bind(lead.review_date, lead.review_date, now),
      confirmedLeadItemStatement(
        env, lead, expectedVersion, candidate, publishedAt, itemExtra, now, verified.record,
        undefined, true,
      ),
      env.DB.prepare(
        `/* manual_lead:confirm_prefreeze */ UPDATE manual_news_leads SET
           version = version + 1, confirmed_at = ?, last_mutation_kind = 'confirm',
           last_mutation_idempotency_key = ?, last_mutation_nonce = ?, updated_at = ?
         WHERE id = ? AND version = ? AND status IN ('recommended', 'needs_review')
           AND NOT EXISTS (SELECT 1 FROM daily_news_review_batches
             WHERE review_date = ? AND lineage_id = ? AND is_current = 1)
           AND (SELECT COUNT(*) FROM manual_news_leads
             WHERE review_date = ? AND confirmed_at IS NOT NULL) < ${MANUAL_NEWS_REVIEW_CANDIDATE_LIMIT}
           AND ${MANUAL_VERIFICATION_SNAPSHOT_GUARD_SQL}`,
      ).bind(
        now, idempotencyKey, confirmationNonce, now, id, expectedVersion, lead.review_date, lead.review_date,
        lead.review_date,
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
    } catch (error) {
      const eventOwner = await confirmedManualEventOwner(
        env, lead.review_date, eventKey, eventClaimNonce,
      );
      if (eventOwner && eventOwner !== id) {
        return { ok: false, status: 409, error: 'manual_candidate_event_conflict', lead };
      }
      throw error;
    }
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
      const eventOwner = await confirmedManualEventOwner(
        env, lead.review_date, eventKey, eventClaimNonce,
      );
      if (eventOwner && eventOwner !== id) {
        return { ok: false, status: 409, error: 'manual_candidate_event_conflict', lead: updated };
      }
      const latestActive = await getActiveNewsReviewBatch(env, lead.review_date);
      if (latestActive) {
        return { ok: false, status: 409, error: 'candidate_batch_revision_conflict', lead: updated };
      }
      const confirmedCount = await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM manual_news_leads
         WHERE review_date = ? AND confirmed_at IS NOT NULL`,
      ).bind(lead.review_date).first<{ count: number }>();
      if (Number(confirmedCount?.count || 0) >= MANUAL_NEWS_REVIEW_CANDIDATE_LIMIT) {
        return { ok: false, status: 409, error: 'manual_candidate_limit_exceeded', lead: updated };
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
      max_candidates: TOTAL_NEWS_REVIEW_CANDIDATE_LIMIT,
    });
  } catch (error) {
    if (error instanceof Error && [
      'manual_candidate_limit_exceeded',
      'automatic_candidate_limit_exceeded',
      'review_candidate_total_limit_exceeded',
    ].includes(error.message)) {
      return { ok: false, status: 409, error: error.message, lead };
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
  // 把人审序列（同事件替换按别名原位改写，其他失效条目剔除）继续写进新版本的
  // applied_selected_ids，并继承标记，供后续自动冻结继续保护。
  const inheritsHumanSelection = active.human_reviewed && merged.default_selected_ids.length > 0;
  const inheritedSelectionHash = inheritsHumanSelection
    ? await newsReviewSelectionHash(merged.default_selected_ids)
    : null;
  const existingManualVerifications = activeSanitization?.manual_verifications || [];
  // 同上：整批已确认快照打成一个 JSON 绑参。
  const existingManualGuard = MANUAL_VERIFICATION_SNAPSHOT_SET_GUARD_SQL;
  const existingManualBindings = [manualVerificationSnapshotSetGuardBinding(existingManualVerifications)];

  const statements = [
    confirmedLeadItemStatement(
      env, lead, expectedVersion, candidate, publishedAt, itemExtra, now, verified.record,
      active, false, existingManualVerifications,
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
        event_aliases: merged.event_aliases,
      },
      createdAt: now,
    }),
  ];
  let results: Array<{ meta?: { changes?: number } }>;
  try {
    results = await env.DB.batch(statements) as Array<{ meta?: { changes?: number } }>;
  } catch (error) {
    const eventOwner = await confirmedManualEventOwner(
      env, lead.review_date, eventKey, eventClaimNonce,
    );
    if (eventOwner && eventOwner !== id) {
      return { ok: false, status: 409, error: 'manual_candidate_event_conflict', lead };
    }
    throw error;
  }
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
    const eventOwner = await confirmedManualEventOwner(
      env, lead.review_date, eventKey, eventClaimNonce,
    );
    if (eventOwner && eventOwner !== id) {
      return { ok: false, status: 409, error: 'manual_candidate_event_conflict', ...(updated ? { lead: updated } : {}) };
    }
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

async function confirmedManualEventOwner(
  env: Env,
  reviewDate: string,
  eventKey: string,
  mutationNonce: string,
): Promise<string | null> {
  const owner = await env.DB.prepare(
    `/* manual_lead:confirm_event_owner */ SELECT lead_id FROM manual_news_lead_audit
     WHERE action = 'confirm_candidate' AND mutation_nonce = ? LIMIT 1`,
  ).bind(mutationNonce).first<{ lead_id: string }>();
  if (owner?.lead_id) return owner.lead_id;
  const confirmed = await env.DB.prepare(
    `/* manual_lead:confirmed_event_owner */ SELECT l.id AS lead_id
     FROM manual_news_leads l
     JOIN manual_news_assessment_verifications v
       ON v.lead_id = l.id AND v.status = 'active'
     JOIN manual_news_event_assessments a
       ON a.lead_id = v.lead_id AND a.assessment_version = v.assessment_version
     WHERE l.review_date = ? AND l.confirmed_at IS NOT NULL AND a.event_key = ?
     ORDER BY l.confirmed_at ASC, l.id ASC LIMIT 1`,
  ).bind(reviewDate, eventKey).first<{ lead_id: string }>();
  return confirmed?.lead_id || null;
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
           WHERE review_date = ? AND lineage_id = ? AND is_current = 1)
         AND (SELECT COUNT(*) FROM manual_news_leads
           WHERE review_date = ? AND confirmed_at IS NOT NULL) < ${MANUAL_NEWS_REVIEW_CANDIDATE_LIMIT}`
      : '';
  // 同上：整批已确认快照打成一个 JSON 绑参。
  const existingManualGuard = MANUAL_VERIFICATION_SNAPSHOT_SET_GUARD_SQL;
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
    manualVerificationSnapshotSetGuardBinding(requiredManualVerifications),
  ];
  if (expectedActiveBatch) {
    values.push(lead.review_date, lead.review_date, expectedActiveBatch.batch_id, expectedActiveBatch.batch_revision);
  } else if (requireNoActiveBatch) {
    values.push(lead.review_date, lead.review_date, lead.review_date);
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
