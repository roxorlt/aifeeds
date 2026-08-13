import type { Env } from '../index';
import {
  isCurrentManualLeadVerification,
  isManualNewsVerificationSecretConfigured,
  validateManualLeadFactVerification,
  validateManualNewsProcessedAssessment,
  type ManualLeadFactVerification,
  type ManualLeadPriorEvent,
  type ManualNewsEvidence,
  type ManualNewsProcessedAssessment,
} from './manual-news-leads';

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

export interface PersistedManualVerificationRow {
  verification_id: string;
  lead_id: string;
  assessment_version: number;
  policy_version: string;
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
}

export interface VerifiedPersistedManualAssessment {
  assessment: ManualNewsProcessedAssessment;
  verification: ManualLeadFactVerification;
  record: PersistedManualVerificationRow;
  evidence: ManualNewsEvidence[];
}

export const MANUAL_VERIFICATION_SNAPSHOT_GUARD_SQL = `EXISTS (
  SELECT 1 FROM manual_news_assessment_verifications verification
  WHERE verification.verification_id = ? AND verification.lead_id = ?
    AND verification.assessment_version = ? AND verification.policy_version = ?
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
    verification.canonical_digest,
    verification.hmac_sha256,
    verification.verification_json,
    verification.processing_owner,
    Number(verification.processing_attempt),
    verification.creation_nonce,
  ];
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
  reason: 'verification_secret_invalid' | 'verification_integrity_invalid',
): Promise<void> {
  const now = Date.now();
  const invalidatedAt = now;
  const deletedAt = new Date(now).toISOString();
  const mutationNonce = `verification_quarantine:${crypto.randomUUID()}`;
  const invalidationNonce = `verification_invalidation:${crypto.randomUUID()}`;
  const snapshotGuard = `verification_id = ? AND lead_id = ? AND status = 'active'
    AND policy_version = ? AND canonical_digest = ? AND hmac_sha256 = ?
    AND verification_json = ? AND creation_nonce = ?`;
  const results = await env.DB.batch([
    env.DB.prepare(
      `/* manual_verification:quarantine */ UPDATE manual_news_assessment_verifications
       SET status = 'invalidated', reason = ?, invalidated_at = ?, invalidation_nonce = ?
       WHERE ${snapshotGuard}`,
    ).bind(
      reason, invalidatedAt, invalidationNonce, row.verification_id, row.lead_id, row.policy_version,
      row.canonical_digest, row.hmac_sha256, row.verification_json, row.creation_nonce,
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

export async function loadManualNewsEvidence(env: Env, leadId: string): Promise<ManualNewsEvidence[]> {
  const result = await env.DB.prepare(
    `/* manual_evidence:list */ SELECT * FROM manual_news_evidence WHERE lead_id = ? ORDER BY evidence_id`,
  ).bind(leadId).all<ManualEvidenceRow>();
  return (result.results || []).map(evidenceFromRow);
}

export async function verifyPersistedManualAssessment(
  env: Env,
  leadId: string,
  assessmentRaw: unknown,
  evidence: readonly ManualNewsEvidence[],
  verificationRow: PersistedManualVerificationRow,
  priorEvents: readonly ManualLeadPriorEvent[] = [],
): Promise<VerifiedPersistedManualAssessment | null> {
  if (verificationRow.status !== 'active'
    || verificationRow.lead_id !== leadId
    || !isManualNewsVerificationSecretConfigured(env.MANUAL_NEWS_VERIFICATION_SECRET)) return null;
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
      canonical_digest: verificationRow.canonical_digest,
      hmac_sha256: verificationRow.hmac_sha256,
    }, env.MANUAL_NEWS_VERIFICATION_SECRET);
    return current ? { assessment, verification, record: verificationRow, evidence: [...evidence] } : null;
  } catch {
    return null;
  }
}

export async function loadVerifiedManualAssessment(
  env: Env,
  leadId: string,
  providedEvidence?: readonly ManualNewsEvidence[],
): Promise<VerifiedPersistedManualAssessment | null> {
  return loadVerifiedManualAssessmentInternal(env, leadId, providedEvidence, new Set<string>());
}

async function loadVerifiedManualAssessmentInternal(
  env: Env,
  leadId: string,
  providedEvidence: readonly ManualNewsEvidence[] | undefined,
  ancestors: Set<string>,
): Promise<VerifiedPersistedManualAssessment | null> {
  if (ancestors.has(leadId)) return null;
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(leadId);
  const evidence = providedEvidence ? [...providedEvidence] : await loadManualNewsEvidence(env, leadId);
  const row = await env.DB.prepare(
    `/* manual_verification:active_assessment */ SELECT
       v.verification_id, v.lead_id, v.assessment_version, v.policy_version, v.canonical_digest,
       v.hmac_sha256, v.verification_json, v.processing_owner, v.processing_attempt,
       v.creation_nonce, v.status, v.reason, v.created_at, v.invalidated_at,
       a.assessment_json, l.review_date
     FROM manual_news_assessment_verifications v
     JOIN manual_news_event_assessments a
       ON a.lead_id = v.lead_id AND a.assessment_version = v.assessment_version
     JOIN manual_news_leads l ON l.id = v.lead_id
     WHERE v.lead_id = ? AND v.status = 'active'
     ORDER BY v.created_at DESC LIMIT 1`,
  ).bind(leadId).first<PersistedManualVerificationRow>();
  if (!row?.assessment_json) return null;
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
    const prior = await loadVerifiedManualAssessmentInternal(env, priorLeadId, undefined, nextAncestors);
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
  const verified = await verifyPersistedManualAssessment(
    env, leadId, parseJson<unknown>(row.assessment_json, null), evidence, row,
    priorContextLoadFailed ? [] : priorEvents,
  );
  if (verified) return verified;
  await quarantineInvalidManualAssessment(
    env,
    row,
    isManualNewsVerificationSecretConfigured(env.MANUAL_NEWS_VERIFICATION_SECRET)
      ? 'verification_integrity_invalid'
      : 'verification_secret_invalid',
  );
  return null;
}
