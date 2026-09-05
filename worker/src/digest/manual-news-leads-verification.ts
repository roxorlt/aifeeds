import type { Env } from '../index';
import {
  manualNewsResponseKeyring,
  manualNewsVerificationKeyring,
  type ManualNewsKeyring,
} from '../security/manual-news-keyring';
import {
  assertManualNewsEvidenceSet,
  createManualEvidenceDigest,
  isCurrentManualNewsSourceSupportProof,
  isCurrentManualLeadVerification,
  MANUAL_LEAD_VERIFICATION_POLICY_VERSION,
  MANUAL_NEWS_SOURCE_SUPPORT_POLICY,
  validateManualLeadFactVerification,
  validateManualNewsProcessedAssessment,
  type ManualLeadFactVerification,
  type ManualLeadPriorEvent,
  type ManualNewsEvidence,
  type ManualNewsProcessedAssessment,
  type ManualNewsSourceSupportPayload,
} from './manual-news-leads';
import {
  isCurrentManualNewsOwnerVouchProof,
  MANUAL_NEWS_OWNER_VOUCH_AUDIT_ACTION,
  MANUAL_NEWS_OWNER_VOUCH_POLICY,
  ownerVouchCandidateFromPayload,
  type ManualNewsOwnerVouchPayload,
} from './manual-news-owner-vouch';
import {
  isCurrentManualNewsOwnerAssertedProof,
  MANUAL_NEWS_OWNER_ASSERTED_AUDIT_ACTIONS,
  MANUAL_NEWS_OWNER_ASSERTED_POLICY,
  ownerAssertedCandidateFromPayload,
  type ManualNewsOwnerAssertedPayload,
} from './manual-news-owner-asserted';

interface ManualEvidenceRow {
  evidence_id: string;
  response_key_id: string;
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

interface ManualEvidenceBulkRow extends ManualEvidencePreflightRow {
  evidence_id: string | null;
  response_key_id: string | null;
  url: string | null;
  source_type: ManualNewsEvidence['source_type'] | null;
  publisher: string | null;
  published_at: string | null;
  retrieved_at: number | null;
  title: string | null;
  excerpt: string | null;
  claims_supported_json: string | null;
  fetch_audit_json: string | null;
  reliable: number | null;
}

export interface PersistedManualVerificationRow {
  verification_id: string;
  lead_id: string;
  assessment_version: number;
  policy_version: string;
  verification_key_id: string;
  canonical_digest: string;
  hmac_sha256: string;
  verification_json: string;
  processing_owner: string;
  processing_attempt: number;
  creation_nonce: string;
  invalidation_nonce?: string | null;
  status: 'active' | 'invalidated';
  reason: string | null;
  created_at: number;
  invalidated_at: number | null;
  assessment_json?: string;
  review_date?: string;
  lead_status?: string;
  lead_confirmed_at?: number | null;
  lead_version?: number;
}

export interface VerifiedPersistedManualAssessment {
  assessment: ManualNewsProcessedAssessment;
  verification: ManualLeadFactVerification;
  record: PersistedManualVerificationRow;
  evidence: ManualNewsEvidence[];
}

export interface VerifiedPersistedManualCandidateProof {
  policy_version:
    | typeof MANUAL_LEAD_VERIFICATION_POLICY_VERSION
    | typeof MANUAL_NEWS_SOURCE_SUPPORT_POLICY
    | typeof MANUAL_NEWS_OWNER_VOUCH_POLICY
    | typeof MANUAL_NEWS_OWNER_ASSERTED_POLICY;
  candidate: {
    item_id: string;
    title: string;
    summary: string;
    source: string;
    score: number | null;
    url: string;
    published_at: string | null;
    event_key: string;
  };
  record: PersistedManualVerificationRow;
  evidence: ManualNewsEvidence[];
  assessment?: ManualNewsProcessedAssessment;
  source_support?: ManualNewsSourceSupportPayload;
  owner_vouch?: ManualNewsOwnerVouchPayload;
  owner_asserted?: ManualNewsOwnerAssertedPayload;
}

type PersistedVerificationOutcome =
  | { status: 'valid'; value: VerifiedPersistedManualAssessment }
  | { status: 'absent' | 'unavailable' | 'tamper'; value: null };

export const MANUAL_VERIFICATION_SNAPSHOT_GUARD_SQL = `EXISTS (
  SELECT 1 FROM manual_news_assessment_verifications verification
  WHERE verification.verification_id = ? AND verification.lead_id = ?
    AND verification.assessment_version = ? AND verification.policy_version = ?
    AND verification.verification_key_id = ?
    AND verification.canonical_digest = ? AND verification.hmac_sha256 = ?
    AND verification.verification_json = ? AND verification.processing_owner = ?
    AND verification.processing_attempt = ? AND verification.creation_nonce = ?
    AND verification.status = 'active'
)`;

export function manualVerificationSnapshotGuardBindings(
  leadId: string,
  verification: PersistedManualVerificationRow,
): unknown[] {
  return [
    verification.verification_id,
    leadId,
    Number(verification.assessment_version),
    verification.policy_version,
    verification.verification_key_id,
    verification.canonical_digest,
    verification.hmac_sha256,
    verification.verification_json,
    verification.processing_owner,
    Number(verification.processing_attempt),
    verification.creation_nonce,
  ];
}

/**
 * 集合版快照门禁。语义与「把 `MANUAL_VERIFICATION_SNAPSHOT_GUARD_SQL` 按条数 AND 起来」
 * 逐字等价（同样的 11 个字段、同样用 `=` 比较、同样只认 status='active'、快照集合为空时恒真），
 * 区别只在绑参个数：从 `11 × N` 降到固定 1 个 JSON 字符串。
 *
 * 为什么必须这么写：D1 单条语句的绑参上限是 100 个（clawhub.ts 有实测记录）。当天每多一条
 * 已确认的手工候选就往同一条原子写门禁里多塞 11 个绑参，7 条就越界，直接 500
 * （`D1_ERROR: too many SQL variables`）。写法照抄仓库既有范式 `executeFormalNewsFinalGuard`：
 * 整个数组 `JSON.stringify` 当单个参数传进去，SQL 里 `json_each(?)` 展开、`json_extract` 取字段。
 *
 * 「NOT EXISTS(有一条快照对不上)」等价于「每条快照都对得上」；`json_each('[]')` 不产行，
 * 所以空集合恒真，与旧写法的 `'1 = 1'` 一致。
 */
export const MANUAL_VERIFICATION_SNAPSHOT_SET_GUARD_SQL = `NOT EXISTS (
  SELECT 1 FROM json_each(?) snapshot_entry
  WHERE NOT EXISTS (
    SELECT 1 FROM manual_news_assessment_verifications verification
    WHERE verification.verification_id = json_extract(snapshot_entry.value, '$.verification_id')
      AND verification.lead_id = json_extract(snapshot_entry.value, '$.lead_id')
      AND verification.assessment_version = json_extract(snapshot_entry.value, '$.assessment_version')
      AND verification.policy_version = json_extract(snapshot_entry.value, '$.policy_version')
      AND verification.verification_key_id = json_extract(snapshot_entry.value, '$.verification_key_id')
      AND verification.canonical_digest = json_extract(snapshot_entry.value, '$.canonical_digest')
      AND verification.hmac_sha256 = json_extract(snapshot_entry.value, '$.hmac_sha256')
      AND verification.verification_json = json_extract(snapshot_entry.value, '$.verification_json')
      AND verification.processing_owner = json_extract(snapshot_entry.value, '$.processing_owner')
      AND verification.processing_attempt = json_extract(snapshot_entry.value, '$.processing_attempt')
      AND verification.creation_nonce = json_extract(snapshot_entry.value, '$.creation_nonce')
      AND verification.status = 'active'
  )
)`;

/** `MANUAL_VERIFICATION_SNAPSHOT_SET_GUARD_SQL` 的唯一绑参：整批快照打成一个 JSON 字符串。 */
export function manualVerificationSnapshotSetGuardBinding(
  snapshots: ReadonlyArray<{ lead_id: string; verification: PersistedManualVerificationRow }>,
): string {
  return JSON.stringify(snapshots.map((snapshot) => ({
    // 字段顺序与 manualVerificationSnapshotGuardBindings 一一对应，数字字段照样走 Number()，
    // 好让 json_extract 取出来的是 INTEGER 而不是 TEXT。
    verification_id: snapshot.verification.verification_id ?? null,
    lead_id: snapshot.lead_id ?? null,
    assessment_version: Number(snapshot.verification.assessment_version),
    policy_version: snapshot.verification.policy_version ?? null,
    verification_key_id: snapshot.verification.verification_key_id ?? null,
    canonical_digest: snapshot.verification.canonical_digest ?? null,
    hmac_sha256: snapshot.verification.hmac_sha256 ?? null,
    verification_json: snapshot.verification.verification_json ?? null,
    processing_owner: snapshot.verification.processing_owner ?? null,
    processing_attempt: Number(snapshot.verification.processing_attempt),
    creation_nonce: snapshot.verification.creation_nonce ?? null,
  })));
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  try { return JSON.parse(value || '') as T; } catch { return fallback; }
}

function evidenceFromRow(row: ManualEvidenceRow): ManualNewsEvidence {
  return {
    id: row.evidence_id,
    response_key_id: row.response_key_id,
    url: row.url,
    source_type: row.source_type,
    publisher: row.publisher,
    published_at: row.published_at,
    retrieved_at: Number(row.retrieved_at),
    title: row.title,
    excerpt: row.excerpt,
    claims_supported: parseJson<string[]>(row.claims_supported_json, []),
    reliable: Number(row.reliable) === 1,
    fetch_audit: parseJson<ManualNewsEvidence['fetch_audit']>(row.fetch_audit_json, null),
  };
}

async function quarantineInvalidManualAssessment(
  env: Env,
  row: PersistedManualVerificationRow,
  reason: 'verification_integrity_invalid',
): Promise<void> {
  const now = Date.now();
  const invalidatedAt = now;
  const deletedAt = new Date(now).toISOString();
  const mutationNonce = `verification_quarantine:${crypto.randomUUID()}`;
  const invalidationNonce = `verification_invalidation:${crypto.randomUUID()}`;
  const snapshotGuard = `verification_id = ? AND lead_id = ? AND status = 'active'
    AND assessment_version = ? AND policy_version = ? AND verification_key_id = ?
    AND canonical_digest = ? AND hmac_sha256 = ? AND verification_json = ?
    AND processing_owner = ? AND processing_attempt = ? AND creation_nonce = ?`;
  const results = await env.DB.batch([
    env.DB.prepare(
      `/* manual_verification:quarantine */ UPDATE manual_news_assessment_verifications
       SET status = 'invalidated', reason = ?, invalidated_at = ?, invalidation_nonce = ?
       WHERE ${snapshotGuard}`,
    ).bind(
      reason, invalidatedAt, invalidationNonce, row.verification_id, row.lead_id,
      row.assessment_version, row.policy_version, row.verification_key_id,
      row.canonical_digest, row.hmac_sha256, row.verification_json,
      row.processing_owner, row.processing_attempt, row.creation_nonce,
    ),
    env.DB.prepare(
      `/* manual_verification:quarantine_item */ UPDATE items SET deleted_at = ?
       WHERE id = ? AND deleted_at IS NULL AND EXISTS (
         SELECT 1 FROM manual_news_assessment_verifications v
         WHERE v.verification_id = ? AND v.lead_id = ? AND v.status = 'invalidated'
           AND v.reason = ? AND v.invalidation_nonce = ?
       )`,
    ).bind(deletedAt, `blog:manual:${row.lead_id}`, row.verification_id, row.lead_id, reason, invalidationNonce),
    env.DB.prepare(
      `/* manual_verification:quarantine_audit */ INSERT INTO manual_news_lead_audit (
         lead_id, action, from_status, to_status, idempotency_key, mutation_nonce,
         resulting_version, metadata_json, created_at
       ) SELECT l.id, 'verification_quarantine', l.status, l.status, NULL, ?, l.version, ?, ?
       FROM manual_news_leads l WHERE l.id = ? AND EXISTS (
         SELECT 1 FROM manual_news_assessment_verifications v
         WHERE v.verification_id = ? AND v.lead_id = l.id AND v.status = 'invalidated'
           AND v.reason = ? AND v.invalidation_nonce = ?
       )`,
    ).bind(
      mutationNonce,
      JSON.stringify({
        verification_id: row.verification_id,
        assessment_version: row.assessment_version,
        reason,
        mutation_nonce: mutationNonce,
      }),
      now, row.lead_id, row.verification_id, reason, invalidationNonce,
    ),
  ]) as Array<{ meta?: { changes?: number } }>;
  const invalidated = Number(results[0]?.meta?.changes || 0);
  const audited = Number(results[2]?.meta?.changes || 0);
  if (invalidated !== audited) throw new Error('manual_verification_quarantine_causality_mismatch');
}

async function activeVerificationSnapshot(
  env: Env,
  leadId: string,
): Promise<PersistedManualVerificationRow | null> {
  return env.DB.prepare(
    `/* manual_verification:active_for_malformed_evidence */ SELECT
       verification_id, lead_id, assessment_version, policy_version, verification_key_id,
       canonical_digest, hmac_sha256, verification_json, processing_owner, processing_attempt,
       creation_nonce, status, reason, created_at, invalidated_at
     FROM manual_news_assessment_verifications
     WHERE lead_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
  ).bind(leadId).first<PersistedManualVerificationRow>();
}

async function quarantineMalformedEvidence(env: Env, leadId: string): Promise<void> {
  const verification = await activeVerificationSnapshot(env, leadId);
  if (verification) {
    await quarantineInvalidManualAssessment(env, verification, 'verification_integrity_invalid');
  }
}

interface ManualEvidencePreflightRow {
  evidence_count: number;
  max_evidence_id_bytes: number | null;
  max_response_key_id_bytes: number | null;
  max_url_bytes: number | null;
  max_source_type_bytes: number | null;
  max_publisher_bytes: number | null;
  max_published_at_bytes: number | null;
  max_title_bytes: number | null;
  max_excerpt_code_points: number | null;
  max_excerpt_bytes: number | null;
  max_claims_bytes: number | null;
  max_fetch_audit_bytes: number | null;
}

const EVIDENCE_PREFLIGHT_LIMITS = {
  evidence_count: 8,
  max_evidence_id_bytes: 256,
  max_response_key_id_bytes: 64,
  max_url_bytes: 4_096,
  max_source_type_bytes: 64,
  max_publisher_bytes: 1_024,
  max_published_at_bytes: 64,
  max_title_bytes: 4_096,
  max_excerpt_code_points: 3_000,
  max_excerpt_bytes: 12_000,
  max_claims_bytes: 80_000,
  max_fetch_audit_bytes: 131_072,
} as const;

function evidencePreflightInvalid(row: ManualEvidencePreflightRow | null): boolean {
  if (!row || !Number.isSafeInteger(Number(row.evidence_count))
    || Number(row.evidence_count) < 0
    || Number(row.evidence_count) > EVIDENCE_PREFLIGHT_LIMITS.evidence_count) return true;
  return Object.entries(EVIDENCE_PREFLIGHT_LIMITS).some(([field, limit]) => {
    if (field === 'evidence_count') return false;
    const value = Number(row[field as keyof ManualEvidencePreflightRow] ?? 0);
    return !Number.isSafeInteger(value) || value < 0 || value > limit;
  });
}

function configuredKeyrings(env: Env): {
  verificationKeys: ManualNewsKeyring;
  responseKeys: ManualNewsKeyring;
} | null {
  try {
    return {
      verificationKeys: manualNewsVerificationKeyring(env),
      responseKeys: manualNewsResponseKeyring(env),
    };
  } catch {
    return null;
  }
}

async function persistedKeyLineageAvailable(
  env: Env,
  leadId: string,
  keyrings: { verificationKeys: ManualNewsKeyring; responseKeys: ManualNewsKeyring },
): Promise<boolean> {
  const verification = await env.DB.prepare(
    `/* manual_verification:key_lineage */ SELECT verification_key_id
     FROM manual_news_assessment_verifications
     WHERE lead_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
  ).bind(leadId).first<{ verification_key_id: string }>();
  if (verification && !keyrings.verificationKeys.keys.has(verification.verification_key_id)) return false;
  const responseKeyIds = [...keyrings.responseKeys.keys.keys()];
  const unknownResponseKeys = await env.DB.prepare(
    `/* manual_evidence:key_lineage */ SELECT COUNT(*) AS unknown_key_count
     FROM manual_news_evidence
     WHERE lead_id = ? AND response_key_id NOT IN (${responseKeyIds.map(() => '?').join(', ')})`,
  ).bind(leadId, ...responseKeyIds).first<{ unknown_key_count: number }>();
  return Number(unknownResponseKeys?.unknown_key_count || 0) === 0;
}

export async function loadManualNewsEvidence(env: Env, leadId: string): Promise<ManualNewsEvidence[]> {
  const keyrings = configuredKeyrings(env);
  if (!keyrings || !await persistedKeyLineageAvailable(env, leadId, keyrings)) return [];
  const preflight = await env.DB.prepare(
    `/* manual_evidence:preflight */ SELECT
       COUNT(*) AS evidence_count,
       MAX(length(CAST(evidence_id AS BLOB))) AS max_evidence_id_bytes,
       MAX(length(CAST(response_key_id AS BLOB))) AS max_response_key_id_bytes,
       MAX(length(CAST(url AS BLOB))) AS max_url_bytes,
       MAX(length(CAST(source_type AS BLOB))) AS max_source_type_bytes,
       MAX(length(CAST(publisher AS BLOB))) AS max_publisher_bytes,
       MAX(length(CAST(COALESCE(published_at, '') AS BLOB))) AS max_published_at_bytes,
       MAX(length(CAST(title AS BLOB))) AS max_title_bytes,
       MAX(length(excerpt)) AS max_excerpt_code_points,
       MAX(length(CAST(excerpt AS BLOB))) AS max_excerpt_bytes,
       MAX(length(CAST(claims_supported_json AS BLOB))) AS max_claims_bytes,
       MAX(length(CAST(fetch_audit_json AS BLOB))) AS max_fetch_audit_bytes
     FROM manual_news_evidence WHERE lead_id = ?`,
  ).bind(leadId).first<ManualEvidencePreflightRow>();
  if (evidencePreflightInvalid(preflight)) {
    await quarantineMalformedEvidence(env, leadId);
    return [];
  }
  const result = await env.DB.prepare(
    `/* manual_evidence:list */ SELECT
       evidence_id, response_key_id, url, source_type, publisher, published_at, retrieved_at,
       title, excerpt, claims_supported_json, fetch_audit_json, reliable
     FROM manual_news_evidence
     WHERE lead_id = ?
       AND length(CAST(evidence_id AS BLOB)) <= 256
       AND length(CAST(response_key_id AS BLOB)) <= 64
       AND length(CAST(url AS BLOB)) <= 4096
       AND length(CAST(source_type AS BLOB)) <= 64
       AND length(CAST(publisher AS BLOB)) <= 1024
       AND length(CAST(COALESCE(published_at, '') AS BLOB)) <= 64
       AND length(CAST(title AS BLOB)) <= 4096
       AND length(excerpt) <= 3000
       AND length(CAST(excerpt AS BLOB)) <= 12000
       AND length(CAST(claims_supported_json AS BLOB)) <= 80000
       AND length(CAST(fetch_audit_json AS BLOB)) <= 131072
     ORDER BY evidence_id LIMIT 9`,
  ).bind(leadId).all<ManualEvidenceRow>();
  if ((result.results || []).length !== Number(preflight?.evidence_count || 0)) {
    await quarantineMalformedEvidence(env, leadId);
    return [];
  }
  const evidence = (result.results || []).map(evidenceFromRow);
  try {
    assertManualNewsEvidenceSet(evidence);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'manual_news_evidence_set_invalid') throw error;
    await quarantineMalformedEvidence(env, leadId);
    return [];
  }
  return evidence;
}

export async function verifyPersistedManualAssessment(
  env: Env,
  leadId: string,
  assessmentRaw: unknown,
  evidence: readonly ManualNewsEvidence[],
  verificationRow: PersistedManualVerificationRow,
  priorEvents: readonly ManualLeadPriorEvent[] = [],
): Promise<VerifiedPersistedManualAssessment | null> {
  const outcome = await verifyPersistedManualAssessmentOutcome(
    env, leadId, assessmentRaw, evidence, verificationRow, priorEvents,
  );
  return outcome.value;
}

async function verifyPersistedManualAssessmentOutcome(
  env: Env,
  leadId: string,
  assessmentRaw: unknown,
  evidence: readonly ManualNewsEvidence[],
  verificationRow: PersistedManualVerificationRow,
  priorEvents: readonly ManualLeadPriorEvent[] = [],
): Promise<PersistedVerificationOutcome> {
  if (verificationRow.status !== 'active' || verificationRow.lead_id !== leadId) {
    return { status: 'tamper', value: null };
  }
  const keyrings = configuredKeyrings(env);
  if (!keyrings
    || !keyrings.verificationKeys.keys.has(verificationRow.verification_key_id)
    || evidence.some((item) => typeof item.response_key_id !== 'string'
      || !keyrings.responseKeys.keys.has(item.response_key_id))) {
    return { status: 'unavailable', value: null };
  }
  try {
    const assessment = validateManualNewsProcessedAssessment(assessmentRaw, evidence);
    const verificationRaw = parseJson<unknown>(verificationRow.verification_json, null);
    const verification = validateManualLeadFactVerification(
      verificationRaw, assessment, evidence, { persisted: true, prior_events: priorEvents },
    );
    const current = await isCurrentManualLeadVerification({
      lead_id: leadId,
      assessment_version: Number(verificationRow.assessment_version),
      assessment,
      evidence,
      verification,
    }, {
      policy_version: verificationRow.policy_version,
      verification_key_id: verificationRow.verification_key_id,
      canonical_digest: verificationRow.canonical_digest,
      hmac_sha256: verificationRow.hmac_sha256,
    }, keyrings.verificationKeys, keyrings.responseKeys);
    return current
      ? { status: 'valid', value: { assessment, verification, record: verificationRow, evidence: [...evidence] } }
      : { status: 'tamper', value: null };
  } catch {
    return { status: 'tamper', value: null };
  }
}

interface ManualCandidateProofDispatchRow extends PersistedManualVerificationRow {
  review_date: string;
  input_type: 'text' | 'url' | 'text_url';
  input_text: string;
  input_url: string;
  note: string;
  submit_idempotency_key: string;
  lead_status: string;
  lead_confirmed_at: number | null;
  lead_version: number;
}

interface SourceSupportAuthorizationAuditRow {
  authorization_audit_id: number | null;
  authorization_idempotency_key: string | null;
  authorization_metadata_json: string | null;
}

interface BulkSourceSupportCandidateProofRow
  extends ManualCandidateProofDispatchRow, ManualEvidenceBulkRow, SourceSupportAuthorizationAuditRow {}

async function activeManualCandidateProofRow(
  env: Env,
  leadId: string,
): Promise<ManualCandidateProofDispatchRow | null> {
  return env.DB.prepare(
    `/* manual_verification:policy_dispatch */ SELECT
       v.verification_id, v.lead_id, v.assessment_version, v.policy_version,
       v.verification_key_id, v.canonical_digest, v.hmac_sha256, v.verification_json,
       v.processing_owner, v.processing_attempt, v.creation_nonce, v.status, v.reason,
       v.created_at, v.invalidation_nonce, v.invalidated_at,
       l.review_date, l.input_type, l.input_text, l.input_url, l.note,
       l.submit_idempotency_key, l.status AS lead_status,
       l.confirmed_at AS lead_confirmed_at, l.version AS lead_version
     FROM manual_news_assessment_verifications v
     JOIN manual_news_leads l ON l.id = v.lead_id
     WHERE v.lead_id = ? AND v.status = 'active'
     ORDER BY v.created_at DESC LIMIT 1`,
  ).bind(leadId).first<ManualCandidateProofDispatchRow>();
}

async function sourceSupportAuthorizationMatches(
  env: Env,
  row: ManualCandidateProofDispatchRow,
  payload: ManualNewsSourceSupportPayload,
): Promise<boolean> {
  const audit = await env.DB.prepare(
    `/* manual_verification:source_support_authorization */ SELECT
       id, idempotency_key, metadata_json
     FROM manual_news_lead_audit
     WHERE lead_id = ? AND action = 'submit' AND resulting_version = 1
       AND from_status IS NULL AND to_status = 'submitted'
     ORDER BY id ASC LIMIT 1`,
  ).bind(row.lead_id).first<{ id: number; idempotency_key: string; metadata_json: string }>();
  return sourceSupportAuthorizationSnapshotMatches(row, payload, audit ? {
    authorization_audit_id: audit.id,
    authorization_idempotency_key: audit.idempotency_key,
    authorization_metadata_json: audit.metadata_json,
  } : null);
}

function sourceSupportAuthorizationSnapshotMatches(
  row: ManualCandidateProofDispatchRow,
  payload: ManualNewsSourceSupportPayload,
  audit: SourceSupportAuthorizationAuditRow | null,
): boolean {
  if (payload.input.review_date !== row.review_date
    || payload.input.input_type !== row.input_type
    || payload.input.input_text !== row.input_text
    || payload.input.input_url !== row.input_url
    || payload.input.note !== row.note
    || payload.authorization.idempotency_key !== row.submit_idempotency_key
    || !audit
    || Number(audit.authorization_audit_id) !== payload.authorization.audit_id
    || audit.authorization_idempotency_key !== payload.authorization.idempotency_key) return false;
  const metadata = parseJson<Record<string, unknown>>(audit.authorization_metadata_json, {});
  const expectedKeys = [
    'input_type', 'candidate_authorization', 'submit_identity_contract', 'submit_identity_digest',
  ];
  return Object.keys(metadata).length === expectedKeys.length
    && Object.keys(metadata).every((key) => expectedKeys.includes(key))
    && metadata.input_type === row.input_type
    && metadata.candidate_authorization === MANUAL_NEWS_SOURCE_SUPPORT_POLICY
    && metadata.submit_identity_contract === 'manual_news_submit_identity_v1'
    && metadata.submit_identity_digest === payload.authorization.submit_identity_digest;
}

async function verifySourceSupportCandidateProofSnapshot(
  row: ManualCandidateProofDispatchRow,
  payload: ManualNewsSourceSupportPayload,
  evidence: readonly ManualNewsEvidence[],
  keyrings: { verificationKeys: ManualNewsKeyring; responseKeys: ManualNewsKeyring },
): Promise<boolean> {
  try {
    return await createManualEvidenceDigest(evidence) === await createManualEvidenceDigest(payload.evidence)
      && await isCurrentManualNewsSourceSupportProof({
        lead_id: row.lead_id,
        assessment_version: Number(row.assessment_version),
        payload,
      }, {
        policy_version: row.policy_version,
        verification_key_id: row.verification_key_id,
        canonical_digest: row.canonical_digest,
        hmac_sha256: row.hmac_sha256,
      }, keyrings.verificationKeys, keyrings.responseKeys);
  } catch {
    return false;
  }
}

async function ownerVouchAuthorizationMatches(
  env: Env,
  row: ManualCandidateProofDispatchRow,
  payload: ManualNewsOwnerVouchPayload,
): Promise<boolean> {
  if (payload.lead_id !== row.lead_id || payload.review_date !== row.review_date) return false;
  // 担保这一步的授权凭据是 owner 自己的 vouch_candidate 审计行:它与 proof 行同一个
  // batch 落盘,并把 canonical_digest 与陈述原文一起钉住。proof 行被单独改写(即使
  // 拿得到密钥)也会因为找不到同摘要的授权行而失效。
  const audits = await env.DB.prepare(
    `/* manual_verification:owner_vouch_authorization */ SELECT metadata_json
     FROM manual_news_lead_audit
     WHERE lead_id = ? AND action = ?
     ORDER BY id ASC LIMIT 5`,
  ).bind(row.lead_id, MANUAL_NEWS_OWNER_VOUCH_AUDIT_ACTION).all<{ metadata_json: string }>();
  return (audits.results || []).some((audit) => {
    const metadata = parseJson<Record<string, unknown>>(audit.metadata_json, {});
    return metadata.candidate_authorization === MANUAL_NEWS_OWNER_VOUCH_POLICY
      && metadata.canonical_digest === row.canonical_digest
      && metadata.statement === payload.statement;
  });
}

async function verifyOwnerVouchCandidateProofSnapshot(
  row: ManualCandidateProofDispatchRow,
  payload: ManualNewsOwnerVouchPayload,
  evidence: readonly ManualNewsEvidence[],
  keyrings: { verificationKeys: ManualNewsKeyring; responseKeys: ManualNewsKeyring },
): Promise<boolean> {
  try {
    return await createManualEvidenceDigest(evidence) === await createManualEvidenceDigest(payload.evidence)
      && await isCurrentManualNewsOwnerVouchProof({
        lead_id: row.lead_id,
        assessment_version: Number(row.assessment_version),
        payload,
      }, {
        policy_version: row.policy_version,
        verification_key_id: row.verification_key_id,
        canonical_digest: row.canonical_digest,
        hmac_sha256: row.hmac_sha256,
      }, keyrings.verificationKeys, keyrings.responseKeys);
  } catch {
    return false;
  }
}

async function ownerAssertedAuthorizationMatches(
  env: Env,
  row: ManualCandidateProofDispatchRow,
  payload: ManualNewsOwnerAssertedPayload,
): Promise<boolean> {
  if (payload.lead_id !== row.lead_id || payload.review_date !== row.review_date) return false;
  // 与担保同构:授权凭据是 owner 自己那条审计行(与 proof 行同一个 batch 落盘),把
  // canonical_digest 与陈述原文一起钉住。两个 action 都收 —— 一步直接录入写
  // `assert_candidate`,零证据线索从担保按钮救回时写 `vouch_candidate`。
  const audits = await env.DB.prepare(
    `/* manual_verification:owner_asserted_authorization */ SELECT metadata_json
     FROM manual_news_lead_audit
     WHERE lead_id = ? AND action IN (${MANUAL_NEWS_OWNER_ASSERTED_AUDIT_ACTIONS.map(() => '?').join(', ')})
     ORDER BY id ASC LIMIT 5`,
  ).bind(row.lead_id, ...MANUAL_NEWS_OWNER_ASSERTED_AUDIT_ACTIONS).all<{ metadata_json: string }>();
  return (audits.results || []).some((audit) => {
    const metadata = parseJson<Record<string, unknown>>(audit.metadata_json, {});
    return metadata.candidate_authorization === MANUAL_NEWS_OWNER_ASSERTED_POLICY
      && metadata.canonical_digest === row.canonical_digest
      && metadata.statement === payload.statement;
  });
}

async function verifyOwnerAssertedCandidateProofSnapshot(
  row: ManualCandidateProofDispatchRow,
  payload: ManualNewsOwnerAssertedPayload,
  evidence: readonly ManualNewsEvidence[],
  keyrings: { verificationKeys: ManualNewsKeyring; responseKeys: ManualNewsKeyring },
): Promise<boolean> {
  try {
    return await createManualEvidenceDigest(evidence) === await createManualEvidenceDigest(payload.evidence)
      && await isCurrentManualNewsOwnerAssertedProof({
        lead_id: row.lead_id,
        input_url: row.input_url || '',
        assessment_version: Number(row.assessment_version),
        payload,
      }, {
        policy_version: row.policy_version,
        verification_key_id: row.verification_key_id,
        canonical_digest: row.canonical_digest,
        hmac_sha256: row.hmac_sha256,
      }, keyrings.verificationKeys, keyrings.responseKeys);
  } catch {
    return false;
  }
}

/** 一次 SQL 能覆盖的线索条数；审核批次最多 50 条手工候选，所以最多 3 次查询。 */
const MANUAL_CANDIDATE_SIGNED_SNAPSHOT_CHUNK_SIZE = 20;

export interface ManualCandidateSignedSnapshot {
  lead_id: string;
  policy_version:
    | typeof MANUAL_NEWS_SOURCE_SUPPORT_POLICY
    | typeof MANUAL_NEWS_OWNER_VOUCH_POLICY
    | typeof MANUAL_NEWS_OWNER_ASSERTED_POLICY;
  candidate: VerifiedPersistedManualCandidateProof['candidate'];
  record: PersistedManualVerificationRow;
}

function proofSnapshotFields(row: ManualCandidateProofDispatchRow) {
  return {
    policy_version: row.policy_version,
    verification_key_id: row.verification_key_id,
    canonical_digest: row.canonical_digest,
    hmac_sha256: row.hmac_sha256,
  };
}

async function signedManualCandidateFromRow(
  row: ManualCandidateProofDispatchRow,
  keyrings: { verificationKeys: ManualNewsKeyring; responseKeys: ManualNewsKeyring },
): Promise<ManualCandidateSignedSnapshot | null> {
  if (!keyrings.verificationKeys.keys.has(row.verification_key_id)) return null;
  const proof = proofSnapshotFields(row);
  try {
    if (row.policy_version === MANUAL_NEWS_OWNER_VOUCH_POLICY) {
      const payload = parseJson<ManualNewsOwnerVouchPayload | null>(row.verification_json, null);
      if (!payload || payload.lead_id !== row.lead_id || payload.review_date !== row.review_date) return null;
      if (!await isCurrentManualNewsOwnerVouchProof({
        lead_id: row.lead_id, assessment_version: Number(row.assessment_version), payload,
      }, proof, keyrings.verificationKeys, keyrings.responseKeys)) return null;
      return {
        lead_id: row.lead_id,
        policy_version: MANUAL_NEWS_OWNER_VOUCH_POLICY,
        candidate: ownerVouchCandidateFromPayload(payload),
        record: row,
      };
    }
    if (row.policy_version === MANUAL_NEWS_OWNER_ASSERTED_POLICY) {
      const payload = parseJson<ManualNewsOwnerAssertedPayload | null>(row.verification_json, null);
      if (!payload || payload.lead_id !== row.lead_id || payload.review_date !== row.review_date) return null;
      if (!await isCurrentManualNewsOwnerAssertedProof({
        lead_id: row.lead_id, input_url: row.input_url || '',
        assessment_version: Number(row.assessment_version), payload,
      }, proof, keyrings.verificationKeys, keyrings.responseKeys)) return null;
      return {
        lead_id: row.lead_id,
        policy_version: MANUAL_NEWS_OWNER_ASSERTED_POLICY,
        candidate: ownerAssertedCandidateFromPayload(payload),
        record: row,
      };
    }
    if (row.policy_version === MANUAL_NEWS_SOURCE_SUPPORT_POLICY) {
      const payload = parseJson<ManualNewsSourceSupportPayload | null>(row.verification_json, null);
      if (!payload) return null;
      if (!await isCurrentManualNewsSourceSupportProof({
        lead_id: row.lead_id, assessment_version: Number(row.assessment_version), payload,
      }, proof, keyrings.verificationKeys, keyrings.responseKeys)) return null;
      return {
        lead_id: row.lead_id,
        policy_version: MANUAL_NEWS_SOURCE_SUPPORT_POLICY,
        candidate: { ...payload.item_projection, event_key: payload.event_identity.event_key },
        record: row,
      };
    }
    // v11 旧策略的候选要靠 assessment 行 + 证据行重建，没有纯计算的廉价路径。
    return null;
  } catch {
    return null;
  }
}

/**
 * 读路径的批量廉价复核：一条 SQL 拿回整批手工候选的 active proof 行，然后**纯计算**
 * 地重算 canonical_digest 并验 HMAC，把签名里的候选投影交回给调用方。
 *
 * 为什么读路径可以只做这一步：验签是「确认」（confirm / vouch / assert）那一步的写入
 * 门禁，那时已经把整份 payload（含证据快照）验过并落盘，canonical_digest + hmac_sha256
 * 把它钉死。每次查列表再逐条重算一遍，等于把写入门禁搬到读路径上 —— 每条候选 9 次
 * D1 往返，prod 实测约 1.8s/条。所以读路径信任的是确认时已验签并落盘的摘要。
 *
 * 这里刻意**不读**证据行、授权审计行与密钥世系，因此它只回答「这份签名还是确认时那一份
 * 吗」，不回答「证据行事后有没有被单独改动」。完整重算（loadVerifiedManualCandidateProof，
 * 含证据摘要比对与失效隔离）留给调用方：凡是这里没返回、或返回的投影跟批次快照对不上的
 * 线索，都必须落回完整重算。发布授权（authorizeFormalNewsSet）那条线仍走完整校验。
 */
export async function loadSignedManualCandidateSnapshots(
  env: Env,
  leadIds: readonly string[],
): Promise<Map<string, ManualCandidateSignedSnapshot>> {
  const matched = new Map<string, ManualCandidateSignedSnapshot>();
  const uniqueLeadIds = [...new Set(leadIds)];
  if (!uniqueLeadIds.length) return matched;
  const keyrings = configuredKeyrings(env);
  if (!keyrings) return matched;
  for (let offset = 0;
    offset < uniqueLeadIds.length;
    offset += MANUAL_CANDIDATE_SIGNED_SNAPSHOT_CHUNK_SIZE) {
    const chunk = uniqueLeadIds.slice(offset, offset + MANUAL_CANDIDATE_SIGNED_SNAPSHOT_CHUNK_SIZE);
    const result = await env.DB.prepare(
      `/* news_review:manual_candidate_proof_bulk */ WITH requested(lead_id) AS (
         VALUES ${chunk.map(() => '(?)').join(', ')}
       ) SELECT
         v.verification_id, v.lead_id, v.assessment_version, v.policy_version,
         v.verification_key_id, v.canonical_digest, v.hmac_sha256, v.verification_json,
         v.processing_owner, v.processing_attempt, v.creation_nonce, v.status, v.reason,
         v.created_at, v.invalidation_nonce, v.invalidated_at,
         l.review_date, l.input_type, l.input_text, l.input_url, l.note,
         l.submit_idempotency_key, l.status AS lead_status,
         l.confirmed_at AS lead_confirmed_at, l.version AS lead_version
       FROM requested r
       JOIN manual_news_leads l ON l.id = r.lead_id
         AND l.confirmed_at IS NOT NULL AND l.status IN ('recommended', 'needs_review')
       JOIN manual_news_assessment_verifications v ON v.lead_id = l.id AND v.status = 'active'`,
    ).bind(...chunk).all<ManualCandidateProofDispatchRow>();
    const rowsByLead = new Map<string, ManualCandidateProofDispatchRow[]>();
    for (const row of result.results || []) {
      const bucket = rowsByLead.get(row.lead_id);
      if (bucket) bucket.push(row);
      else rowsByLead.set(row.lead_id, [row]);
    }
    for (const [leadId, rows] of rowsByLead) {
      // 同一条线索有多行 active 时，「当前那一份」要按 created_at 排序才定得下来。
      // 这里不猜，直接交给完整重算。
      if (rows.length !== 1) continue;
      const signed = await signedManualCandidateFromRow(rows[0], keyrings);
      if (signed) matched.set(leadId, signed);
    }
  }
  return matched;
}

export async function loadVerifiedManualCandidateProof(
  env: Env,
  leadId: string,
): Promise<VerifiedPersistedManualCandidateProof | null> {
  const row = await activeManualCandidateProofRow(env, leadId);
  if (!row) return null;
  if (row.policy_version !== MANUAL_LEAD_VERIFICATION_POLICY_VERSION
    && row.policy_version !== MANUAL_NEWS_SOURCE_SUPPORT_POLICY
    && row.policy_version !== MANUAL_NEWS_OWNER_VOUCH_POLICY
    && row.policy_version !== MANUAL_NEWS_OWNER_ASSERTED_POLICY) return null;
  if (row.policy_version === MANUAL_LEAD_VERIFICATION_POLICY_VERSION) {
    const legacy = await loadVerifiedManualAssessment(env, leadId);
    if (!legacy) return null;
    const primaryEvidence = legacy.evidence.find((item) => item.reliable) || legacy.evidence[0];
    return {
      policy_version: MANUAL_LEAD_VERIFICATION_POLICY_VERSION,
      candidate: {
        item_id: `blog:manual:${leadId}`,
        title: legacy.assessment.title,
        summary: legacy.assessment.summary,
        source: primaryEvidence?.publisher || '手工补录',
        score: legacy.assessment.score,
        url: primaryEvidence?.url || row.input_url,
        published_at: primaryEvidence?.published_at || null,
        event_key: legacy.assessment.event_key,
      },
      record: legacy.record,
      evidence: legacy.evidence,
      assessment: legacy.assessment,
    };
  }
  const keyrings = configuredKeyrings(env);
  if (!keyrings
    || !keyrings.verificationKeys.keys.has(row.verification_key_id)
    || !await persistedKeyLineageAvailable(env, leadId, keyrings)) return null;
  if (row.policy_version === MANUAL_NEWS_OWNER_VOUCH_POLICY) {
    const vouchPayload = parseJson<ManualNewsOwnerVouchPayload | null>(row.verification_json, null);
    const vouchEvidence = await loadManualNewsEvidence(env, leadId);
    const vouchValid = !!vouchPayload
      && await ownerVouchAuthorizationMatches(env, row, vouchPayload)
      && await verifyOwnerVouchCandidateProofSnapshot(row, vouchPayload, vouchEvidence, keyrings);
    if (!vouchValid || !vouchPayload) {
      await quarantineInvalidManualAssessment(env, row, 'verification_integrity_invalid');
      return null;
    }
    return {
      policy_version: MANUAL_NEWS_OWNER_VOUCH_POLICY,
      candidate: ownerVouchCandidateFromPayload(vouchPayload),
      record: row,
      evidence: vouchEvidence,
      owner_vouch: vouchPayload,
    };
  }
  if (row.policy_version === MANUAL_NEWS_OWNER_ASSERTED_POLICY) {
    const assertedPayload = parseJson<ManualNewsOwnerAssertedPayload | null>(row.verification_json, null);
    // 零证据是这条通道的常态:loadManualNewsEvidence 返回空数组,证据摘要两侧同为空集。
    const assertedEvidence = await loadManualNewsEvidence(env, leadId);
    const assertedValid = !!assertedPayload
      && await ownerAssertedAuthorizationMatches(env, row, assertedPayload)
      && await verifyOwnerAssertedCandidateProofSnapshot(row, assertedPayload, assertedEvidence, keyrings);
    if (!assertedValid || !assertedPayload) {
      await quarantineInvalidManualAssessment(env, row, 'verification_integrity_invalid');
      return null;
    }
    return {
      policy_version: MANUAL_NEWS_OWNER_ASSERTED_POLICY,
      candidate: ownerAssertedCandidateFromPayload(assertedPayload),
      record: row,
      evidence: assertedEvidence,
      owner_asserted: assertedPayload,
    };
  }
  const payload = parseJson<ManualNewsSourceSupportPayload | null>(row.verification_json, null);
  const evidence = await loadManualNewsEvidence(env, leadId);
  let valid = false;
  if (payload && await sourceSupportAuthorizationMatches(env, row, payload)) {
    valid = await verifySourceSupportCandidateProofSnapshot(row, payload, evidence, keyrings);
  }
  if (!valid || !payload) {
    await quarantineInvalidManualAssessment(env, row, 'verification_integrity_invalid');
    return null;
  }
  return {
    policy_version: MANUAL_NEWS_SOURCE_SUPPORT_POLICY,
    candidate: {
      ...payload.item_projection,
      event_key: payload.event_identity.event_key,
    },
    record: row,
    evidence,
    source_support: payload,
  };
}

const SOURCE_SUPPORT_BULK_PROOF_LIMIT = 700;
const SOURCE_SUPPORT_BULK_PROOF_CHUNK_SIZE = 20;

export async function loadVerifiedManualSourceSupportProofs(
  env: Env,
  leadIds: readonly string[],
): Promise<Map<string, VerifiedPersistedManualCandidateProof>> {
  const uniqueLeadIds = [...new Set(leadIds)];
  if (uniqueLeadIds.length > SOURCE_SUPPORT_BULK_PROOF_LIMIT) {
    throw new Error('source_support_prior_event_scan_limit');
  }
  const verified = new Map<string, VerifiedPersistedManualCandidateProof>();
  if (uniqueLeadIds.length === 0) return verified;
  const keyrings = configuredKeyrings(env);
  if (!keyrings) return verified;

  for (let offset = 0; offset < uniqueLeadIds.length; offset += SOURCE_SUPPORT_BULK_PROOF_CHUNK_SIZE) {
    const chunk = uniqueLeadIds.slice(offset, offset + SOURCE_SUPPORT_BULK_PROOF_CHUNK_SIZE);
    const requestedValues = chunk.map(() => '(?)').join(', ');
    const result = await env.DB.prepare(
      `/* manual_verification:source_support_bulk */ WITH requested(lead_id) AS (
         VALUES ${requestedValues}
       ), evidence_stats AS (
         SELECT e.lead_id,
           COUNT(*) AS evidence_count,
           MAX(length(CAST(e.evidence_id AS BLOB))) AS max_evidence_id_bytes,
           MAX(length(CAST(e.response_key_id AS BLOB))) AS max_response_key_id_bytes,
           MAX(length(CAST(e.url AS BLOB))) AS max_url_bytes,
           MAX(length(CAST(e.source_type AS BLOB))) AS max_source_type_bytes,
           MAX(length(CAST(e.publisher AS BLOB))) AS max_publisher_bytes,
           MAX(length(CAST(COALESCE(e.published_at, '') AS BLOB))) AS max_published_at_bytes,
           MAX(length(CAST(e.title AS BLOB))) AS max_title_bytes,
           MAX(length(e.excerpt)) AS max_excerpt_code_points,
           MAX(length(CAST(e.excerpt AS BLOB))) AS max_excerpt_bytes,
           MAX(length(CAST(e.claims_supported_json AS BLOB))) AS max_claims_bytes,
           MAX(length(CAST(e.fetch_audit_json AS BLOB))) AS max_fetch_audit_bytes
         FROM manual_news_evidence e JOIN requested r ON r.lead_id = e.lead_id
         GROUP BY e.lead_id
       ) SELECT
         v.verification_id, v.lead_id, v.assessment_version, v.policy_version,
         v.verification_key_id, v.canonical_digest, v.hmac_sha256, v.verification_json,
         v.processing_owner, v.processing_attempt, v.creation_nonce, v.status, v.reason,
         v.created_at, v.invalidation_nonce, v.invalidated_at,
         l.review_date, l.input_type, l.input_text, l.input_url, l.note,
         l.submit_idempotency_key, l.status AS lead_status,
         l.confirmed_at AS lead_confirmed_at, l.version AS lead_version,
         a.id AS authorization_audit_id,
         a.idempotency_key AS authorization_idempotency_key,
         a.metadata_json AS authorization_metadata_json,
         COALESCE(s.evidence_count, 0) AS evidence_count,
         s.max_evidence_id_bytes, s.max_response_key_id_bytes, s.max_url_bytes,
         s.max_source_type_bytes, s.max_publisher_bytes, s.max_published_at_bytes,
         s.max_title_bytes, s.max_excerpt_code_points, s.max_excerpt_bytes,
         s.max_claims_bytes, s.max_fetch_audit_bytes,
         e.evidence_id, e.response_key_id, e.url, e.source_type, e.publisher,
         e.published_at, e.retrieved_at, e.title, e.excerpt,
         e.claims_supported_json, e.fetch_audit_json, e.reliable
       FROM requested r
       JOIN manual_news_assessment_verifications v
         ON v.lead_id = r.lead_id AND v.status = 'active' AND v.policy_version = '${MANUAL_NEWS_SOURCE_SUPPORT_POLICY}'
       JOIN manual_news_leads l ON l.id = v.lead_id
       LEFT JOIN manual_news_lead_audit a ON a.id = (
         SELECT MIN(a0.id) FROM manual_news_lead_audit a0
         WHERE a0.lead_id = v.lead_id AND a0.action = 'submit'
           AND a0.resulting_version = 1 AND a0.from_status IS NULL AND a0.to_status = 'submitted'
       )
       LEFT JOIN evidence_stats s ON s.lead_id = v.lead_id
       LEFT JOIN manual_news_evidence e ON e.lead_id = v.lead_id
         AND COALESCE(s.evidence_count, 0) <= 8
         AND COALESCE(s.max_evidence_id_bytes, 0) <= 256
         AND COALESCE(s.max_response_key_id_bytes, 0) <= 64
         AND COALESCE(s.max_url_bytes, 0) <= 4096
         AND COALESCE(s.max_source_type_bytes, 0) <= 64
         AND COALESCE(s.max_publisher_bytes, 0) <= 1024
         AND COALESCE(s.max_published_at_bytes, 0) <= 64
         AND COALESCE(s.max_title_bytes, 0) <= 4096
         AND COALESCE(s.max_excerpt_code_points, 0) <= 3000
         AND COALESCE(s.max_excerpt_bytes, 0) <= 12000
         AND COALESCE(s.max_claims_bytes, 0) <= 80000
         AND COALESCE(s.max_fetch_audit_bytes, 0) <= 131072
       ORDER BY v.lead_id ASC, e.evidence_id ASC`,
    ).bind(...chunk).all<BulkSourceSupportCandidateProofRow>();
    const grouped = new Map<string, {
      row: BulkSourceSupportCandidateProofRow;
      evidenceRows: ManualEvidenceRow[];
    }>();
    for (const row of result.results || []) {
      const group = grouped.get(row.lead_id) || { row, evidenceRows: [] };
      if (row.evidence_id !== null && row.response_key_id !== null && row.url !== null
        && row.source_type !== null && row.publisher !== null && row.retrieved_at !== null
        && row.title !== null && row.excerpt !== null && row.claims_supported_json !== null
        && row.fetch_audit_json !== null && row.reliable !== null) {
        group.evidenceRows.push(row as ManualEvidenceRow);
      }
      grouped.set(row.lead_id, group);
    }
    for (const { row, evidenceRows } of grouped.values()) {
      const preflight: ManualEvidencePreflightRow = {
        evidence_count: Number(row.evidence_count),
        max_evidence_id_bytes: row.max_evidence_id_bytes,
        max_response_key_id_bytes: row.max_response_key_id_bytes,
        max_url_bytes: row.max_url_bytes,
        max_source_type_bytes: row.max_source_type_bytes,
        max_publisher_bytes: row.max_publisher_bytes,
        max_published_at_bytes: row.max_published_at_bytes,
        max_title_bytes: row.max_title_bytes,
        max_excerpt_code_points: row.max_excerpt_code_points,
        max_excerpt_bytes: row.max_excerpt_bytes,
        max_claims_bytes: row.max_claims_bytes,
        max_fetch_audit_bytes: row.max_fetch_audit_bytes,
      };
      if (evidencePreflightInvalid(preflight) || evidenceRows.length !== preflight.evidence_count) {
        await quarantineInvalidManualAssessment(env, row, 'verification_integrity_invalid');
        continue;
      }
      const evidence = evidenceRows.map(evidenceFromRow);
      try {
        assertManualNewsEvidenceSet(evidence);
      } catch {
        await quarantineInvalidManualAssessment(env, row, 'verification_integrity_invalid');
        continue;
      }
      if (!keyrings.verificationKeys.keys.has(row.verification_key_id)
        || evidence.some((item) => typeof item.response_key_id !== 'string'
          || !keyrings.responseKeys.keys.has(item.response_key_id))) continue;
      const payload = parseJson<ManualNewsSourceSupportPayload | null>(row.verification_json, null);
      const authorization = {
        authorization_audit_id: row.authorization_audit_id,
        authorization_idempotency_key: row.authorization_idempotency_key,
        authorization_metadata_json: row.authorization_metadata_json,
      };
      const valid = payload
        && sourceSupportAuthorizationSnapshotMatches(row, payload, authorization)
        && await verifySourceSupportCandidateProofSnapshot(row, payload, evidence, keyrings);
      if (!valid || !payload) {
        await quarantineInvalidManualAssessment(env, row, 'verification_integrity_invalid');
        continue;
      }
      verified.set(row.lead_id, {
        policy_version: MANUAL_NEWS_SOURCE_SUPPORT_POLICY,
        candidate: { ...payload.item_projection, event_key: payload.event_identity.event_key },
        record: row,
        evidence,
        source_support: payload,
      });
    }
  }
  return verified;
}

export async function loadVerifiedManualAssessment(
  env: Env,
  leadId: string,
  providedEvidence?: readonly ManualNewsEvidence[],
): Promise<VerifiedPersistedManualAssessment | null> {
  return (await loadVerifiedManualAssessmentInternal(env, leadId, providedEvidence, new Set<string>())).value;
}

async function loadVerifiedManualAssessmentInternal(
  env: Env,
  leadId: string,
  providedEvidence: readonly ManualNewsEvidence[] | undefined,
  ancestors: Set<string>,
): Promise<PersistedVerificationOutcome> {
  if (ancestors.has(leadId)) return { status: 'tamper', value: null };
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(leadId);
  const keyrings = configuredKeyrings(env);
  if (!keyrings || !await persistedKeyLineageAvailable(env, leadId, keyrings)) {
    return { status: 'unavailable', value: null };
  }
  const evidence = providedEvidence ? [...providedEvidence] : await loadManualNewsEvidence(env, leadId);
  const row = await env.DB.prepare(
    `/* manual_verification:active_assessment */ SELECT
       v.verification_id, v.lead_id, v.assessment_version, v.policy_version,
       v.verification_key_id, v.canonical_digest,
       v.hmac_sha256, v.verification_json, v.processing_owner, v.processing_attempt,
       v.creation_nonce, v.status, v.reason, v.created_at, v.invalidated_at,
       a.assessment_json, l.review_date, l.status AS lead_status,
       l.confirmed_at AS lead_confirmed_at, l.version AS lead_version
     FROM manual_news_assessment_verifications v
     JOIN manual_news_event_assessments a
       ON a.lead_id = v.lead_id AND a.assessment_version = v.assessment_version
     JOIN manual_news_leads l ON l.id = v.lead_id
     WHERE v.lead_id = ? AND v.status = 'active'
     ORDER BY v.created_at DESC LIMIT 1`,
  ).bind(leadId).first<PersistedManualVerificationRow>();
  if (!row?.assessment_json) return { status: 'absent', value: null };
  if (!keyrings.verificationKeys.keys.has(row.verification_key_id)
    || evidence.some((item) => typeof item.response_key_id !== 'string'
      || !keyrings.responseKeys.keys.has(item.response_key_id))) {
    return { status: 'unavailable', value: null };
  }
  const verificationRaw = parseJson<unknown>(row.verification_json, null);
  const storedPriorContext = verificationRaw && typeof verificationRaw === 'object' && !Array.isArray(verificationRaw)
    && Array.isArray((verificationRaw as { prior_context?: unknown }).prior_context)
    ? (verificationRaw as { prior_context: unknown[] }).prior_context
    : [];
  const priorEvents: ManualLeadPriorEvent[] = [];
  let priorContextLoadFailed = false;
  if (storedPriorContext.length > 20) priorContextLoadFailed = true;
  for (const entry of priorContextLoadFailed ? [] : storedPriorContext) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || typeof (entry as { lead_id?: unknown }).lead_id !== 'string') {
      priorContextLoadFailed = true;
      break;
    }
    const priorLeadId = (entry as { lead_id: string }).lead_id;
    const priorOutcome = await loadVerifiedManualAssessmentInternal(env, priorLeadId, undefined, nextAncestors);
    if (priorOutcome.status === 'unavailable') return priorOutcome;
    const prior = priorOutcome.value;
    if (!prior || !prior.record.review_date) {
      priorContextLoadFailed = true;
      break;
    }
    priorEvents.push({
      event_key: prior.assessment.event_key,
      review_date: prior.record.review_date,
      lead_id: priorLeadId,
      verification_digest: prior.record.canonical_digest,
      title: prior.assessment.title,
      summary: prior.assessment.summary,
      claims: prior.assessment.claims,
    });
  }
  const outcome = await verifyPersistedManualAssessmentOutcome(
    env, leadId, parseJson<unknown>(row.assessment_json, null), evidence, row,
    priorContextLoadFailed ? [] : priorEvents,
  );
  if (outcome.status === 'valid' || outcome.status === 'unavailable') return outcome;
  await quarantineInvalidManualAssessment(env, row, 'verification_integrity_invalid');
  return outcome;
}
