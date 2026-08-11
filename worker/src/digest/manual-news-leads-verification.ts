import type { Env } from '../index';
import {
  isCurrentManualLeadVerification,
  isManualNewsVerificationSecretConfigured,
  validateManualLeadFactVerification,
  validateManualNewsProcessedAssessment,
  type ManualLeadFactVerification,
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
  status: 'active' | 'invalidated';
  reason: string | null;
  created_at: number;
  invalidated_at: number | null;
  assessment_json?: string;
}

export interface VerifiedPersistedManualAssessment {
  assessment: ManualNewsProcessedAssessment;
  verification: ManualLeadFactVerification;
  record: PersistedManualVerificationRow;
  evidence: ManualNewsEvidence[];
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
): Promise<VerifiedPersistedManualAssessment | null> {
  if (verificationRow.status !== 'active'
    || verificationRow.lead_id !== leadId
    || !isManualNewsVerificationSecretConfigured(env.MANUAL_NEWS_VERIFICATION_SECRET)) return null;
  try {
    const assessment = validateManualNewsProcessedAssessment(assessmentRaw, evidence);
    const verificationRaw = parseJson<unknown>(verificationRow.verification_json, null);
    const verification = validateManualLeadFactVerification(verificationRaw, assessment, evidence);
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
  const evidence = providedEvidence ? [...providedEvidence] : await loadManualNewsEvidence(env, leadId);
  const row = await env.DB.prepare(
    `/* manual_verification:active_assessment */ SELECT
       v.verification_id, v.lead_id, v.assessment_version, v.policy_version, v.canonical_digest,
       v.hmac_sha256, v.verification_json, v.processing_owner, v.processing_attempt,
       v.status, v.reason, v.created_at, v.invalidated_at, a.assessment_json
     FROM manual_news_assessment_verifications v
     JOIN manual_news_event_assessments a
       ON a.lead_id = v.lead_id AND a.assessment_version = v.assessment_version
     WHERE v.lead_id = ? AND v.status = 'active'
     ORDER BY v.created_at DESC LIMIT 1`,
  ).bind(leadId).first<PersistedManualVerificationRow>();
  if (!row?.assessment_json) return null;
  return verifyPersistedManualAssessment(env, leadId, parseJson<unknown>(row.assessment_json, null), evidence, row);
}
