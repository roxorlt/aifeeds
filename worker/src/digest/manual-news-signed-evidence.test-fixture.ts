import { createHash, createHmac } from 'node:crypto';

import type { ManualNewsEvidence, ManualLeadVerificationProof } from './manual-news-leads';
import { parseManualNewsKeyring } from '../security/manual-news-keyring';

export const TEST_MANUAL_NEWS_RESPONSE_SECRET = '11'.repeat(32);
export const TEST_MANUAL_NEWS_RESPONSE_KEY_ID = 'response-key-2026-08-11';
export const TEST_MANUAL_NEWS_VERIFICATION_KEY_ID = 'verification-key-2026-08-11';

export function testManualNewsResponseKeyring(
  secret = TEST_MANUAL_NEWS_RESPONSE_SECRET,
  keyId = TEST_MANUAL_NEWS_RESPONSE_KEY_ID,
) {
  return parseManualNewsKeyring({ keyId, secret });
}

export function testManualNewsVerificationKeyring(
  secret: string,
  keyId = TEST_MANUAL_NEWS_VERIFICATION_KEY_ID,
) {
  return parseManualNewsKeyring({ keyId, secret });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

export function withSignedArticleTextV2Audit<T extends ManualNewsEvidence>(
  evidence: T,
  completeBody = evidence.excerpt,
): T & {
  response_key_id: string;
  fetch_audit: NonNullable<ManualNewsEvidence['fetch_audit']>;
} {
  const bytes = Buffer.byteLength(completeBody, 'utf8');
  const excerptBytes = Buffer.byteLength(evidence.excerpt, 'utf8');
  const publishedAt = evidence.published_at && !/^\d{4}-\d{2}-\d{2}$/.test(evidence.published_at)
    ? new Date(evidence.published_at).toISOString()
    : evidence.published_at;
  const unsignedAudit = {
    hops: [{
      url: evidence.url,
      validated_ip: '93.184.216.34',
      connected_ip: '93.184.216.34',
    }],
    source_content_type: 'text/html',
    extraction: 'article_text' as const,
    requested_limits: {
      source_bytes: 8_388_608,
      extracted_text_bytes: 2_097_152,
      extracted_text_characters: 1_000_000,
    },
    applied_limits: {
      source_bytes: 8_388_608,
      extracted_text_bytes: 28_000,
      extracted_text_characters: 28_000,
    },
    actual_sizes: {
      source_bytes: bytes,
      extracted_text_bytes: bytes,
      extracted_text_characters: Array.from(completeBody).length,
    },
    truncation: { source: false, extracted_text: false },
    parser: { result: 'success' as const, version: 'chromium/149.0.7735.12' },
    document: {
      title: evidence.title,
      published_at: publishedAt,
      selection: 'article' as const,
      content_complete: true as const,
    },
    protocol_version: 'article_text_v2' as const,
    request_nonce: '22'.repeat(16),
    request_timestamp: '2026-08-11T00:00:00.000Z',
    extracted_at: '2026-08-11T00:00:01.000Z',
    final_url: evidence.url,
    body_sha256: createHash('sha256').update(completeBody).digest('hex'),
    response_profile: 'proof_excerpt_v1' as const,
    response_hmac_contract: 'hmac-sha256-canonical-json-all-fields-except-response_hmac-v1' as const,
    proof_excerpt: {
      contract: 'proof_excerpt_v1' as const,
      algorithm: 'utf8-nfc-ws1-codepoint-prefix-v1' as const,
      max: 3_000 as const,
      sha256: createHash('sha256').update(evidence.excerpt).digest('hex'),
      utf8_bytes: excerptBytes,
      code_points: Array.from(evidence.excerpt).length,
    },
  };
  return {
    ...evidence,
    response_key_id: TEST_MANUAL_NEWS_RESPONSE_KEY_ID,
    published_at: publishedAt,
    claims_supported: [evidence.excerpt],
    fetch_audit: {
      ...unsignedAudit,
      response_hmac: createHmac('sha256', Buffer.from(TEST_MANUAL_NEWS_RESPONSE_SECRET, 'hex'))
        .update(canonicalJson(unsignedAudit)).digest('hex'),
    },
  } as T & {
    response_key_id: string;
    fetch_audit: NonNullable<ManualNewsEvidence['fetch_audit']>;
  };
}

export function proofForLegacyPolicy(
  proof: Pick<ManualLeadVerificationProof, 'canonical_digest' | 'hmac_sha256'> & { policy_version: string },
  input: { lead_id: string; assessment_version: number },
  secret: string,
  policyVersion = 'fact-evidence-projection-hmac-v9',
) {
  const hmacPayload = [
    policyVersion, input.lead_id, String(input.assessment_version), proof.canonical_digest,
  ].join('\n');
  return {
    ...proof,
    policy_version: policyVersion,
    hmac_sha256: createHmac('sha256', secret).update(hmacPayload).digest('hex'),
  };
}
