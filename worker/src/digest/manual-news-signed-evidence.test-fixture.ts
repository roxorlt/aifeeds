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

/**
 * 推文取证网关（dailyVideo 的 `manual-news-research-gateway.mjs`，`signTweetAudit`）
 * 签的 `body_sha256` 覆盖的是**整个 JSON 响应体**（`JSON.stringify(tweet.document)`），
 * 不是推文正文。夹具照抄这个语义：拿 `sha256(推文正文)` 冒充它会让证据链校验在测试里
 * 成立、在 prod 上必然不成立（2026-09-03 vouch-candidate 409 事故就是这么漏过去的）。
 */
export interface TweetGatewayDocument {
  tweet_id: string;
  canonical_url: string;
  text: string;
  author?: string;
  author_handle?: string;
  published_at?: string | null;
}

/** 字段照抄 `fetchTweetEvidence` 从响应体里读的那些（`security/safe-url-fetch.ts`）。 */
export function tweetGatewayResponseBody(document: TweetGatewayDocument): string {
  return JSON.stringify({
    tweet_id: document.tweet_id,
    canonical_url: document.canonical_url,
    author: document.author ?? '',
    author_handle: document.author_handle ?? '',
    published_at: document.published_at ?? null,
    language: 'en',
    text: document.text,
    images: [],
    metrics: {},
  });
}

export function tweetGatewayBodySha256(document: TweetGatewayDocument): string {
  return createHash('sha256').update(tweetGatewayResponseBody(document)).digest('hex');
}

/** 网关签名的推文 audit：`body_sha256` 走真实语义，`response_hmac` 用测试响应密钥。 */
export function signedTweetEvidenceAudit(
  document: TweetGatewayDocument,
  overrides: Record<string, unknown> = {},
) {
  const unsigned = {
    kind: 'tweet_api',
    provider: 'scrapebadger',
    tweet_id: document.tweet_id,
    requested_url: document.canonical_url,
    canonical_url: document.canonical_url,
    fetched_at: '2026-09-03T04:05:07.000Z',
    provider_status: 200,
    protocol_version: 'tweet_evidence_v1',
    request_nonce: 'a'.repeat(32),
    request_timestamp: '2026-09-03T04:05:06.000Z',
    body_sha256: tweetGatewayBodySha256(document),
    ...overrides,
  };
  return {
    ...unsigned,
    response_hmac: createHmac('sha256', Buffer.from(TEST_MANUAL_NEWS_RESPONSE_SECRET, 'hex'))
      .update(canonicalJson(unsigned)).digest('hex'),
  };
}

/** 推文证据行：url 必须是规范化的 x.com status 链接，audit 由上面的真实语义夹具签出。 */
export function withSignedTweetEvidenceAudit<T extends ManualNewsEvidence>(evidence: T): T & {
  response_key_id: string;
  fetch_audit: NonNullable<ManualNewsEvidence['fetch_audit']>;
} {
  const match = /^https:\/\/x\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,25})$/.exec(evidence.url);
  if (!match) throw new Error('test fixture: 推文证据的 url 必须是规范化的 x.com status 链接');
  return {
    ...evidence,
    response_key_id: TEST_MANUAL_NEWS_RESPONSE_KEY_ID,
    claims_supported: [evidence.excerpt],
    fetch_audit: signedTweetEvidenceAudit({
      tweet_id: match[2],
      canonical_url: evidence.url,
      text: evidence.excerpt,
      author: evidence.title,
      author_handle: match[1],
      published_at: evidence.published_at,
    }),
  } as unknown as T & {
    response_key_id: string;
    fetch_audit: NonNullable<ManualNewsEvidence['fetch_audit']>;
  };
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
      max_code_points: 3_000 as const,
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
