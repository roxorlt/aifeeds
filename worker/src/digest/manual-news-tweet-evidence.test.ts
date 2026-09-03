// 推文证据并入证据链（2026-09-03）。
//
// 契约第 7 节第 4 条:推文证据在下游的呈现要与网页证据可区分,published_at 用推文自己的发布时间。
// 另有一处契约没点名但会直接卡死的整合点:证据签名前会跑 normalizedSignedEvidenceProvenance,
// 它原本只认「直抓 audit」和「provider audit」两种形状,推文 audit 会被判
// manual_news_evidence_provenance_invalid —— 不补这一支,推文线索能取证却签不出证据。

import { createHash, createHmac } from 'node:crypto';
import { describe, expect, test } from 'vitest';

import { extractManualNewsEvidence } from './manual-news-leads-runtime';
import {
  assertManualNewsEvidenceBodyDigests,
  normalizedSignedEvidenceProvenance,
} from './manual-news-leads';
import type { ManualNewsEvidence } from './manual-news-leads';
import {
  createManualNewsOwnerVouchPayload,
  createManualNewsOwnerVouchProof,
  isCurrentManualNewsOwnerVouchProof,
} from './manual-news-owner-vouch';
import {
  isTweetEvidenceAudit,
  verifyTweetEvidenceAuditResponseHmac,
  type PublicDocument,
} from '../security/safe-url-fetch';
import {
  TEST_MANUAL_NEWS_RESPONSE_KEY_ID,
  TEST_MANUAL_NEWS_RESPONSE_SECRET,
  testManualNewsResponseKeyring,
  testManualNewsVerificationKeyring,
  tweetGatewayBodySha256,
} from './manual-news-signed-evidence.test-fixture';

const TWEET_URL = 'https://x.com/AnthropicAI/status/1234567890123456789';
const TWEET_TEXT = 'Anthropic 发布了新模型,并公布了权重开放计划。';
const TWEET_PUBLISHED_AT = '2026-09-03T04:05:06.000Z';

/**
 * 网关签的 body_sha256 覆盖的是整个 JSON 响应体(JSON.stringify(tweet.document)),
 * 与 sha256(推文正文) 必然不同 —— 夹具照抄这个语义,别再用正文的哈希顶包。
 */
const TWEET_BODY_SHA256 = tweetGatewayBodySha256({
  tweet_id: '1234567890123456789',
  canonical_url: TWEET_URL,
  text: TWEET_TEXT,
  author: 'Anthropic',
  author_handle: 'AnthropicAI',
  published_at: TWEET_PUBLISHED_AT,
});

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(object[k])}`).join(',')}}`;
}

function signedTweetAudit(overrides: Record<string, unknown> = {}) {
  const unsigned = {
    kind: 'tweet_api',
    provider: 'scrapebadger',
    tweet_id: '1234567890123456789',
    requested_url: TWEET_URL,
    canonical_url: TWEET_URL,
    fetched_at: '2026-09-03T04:05:07.000Z',
    provider_status: 200,
    protocol_version: 'tweet_evidence_v1',
    request_nonce: 'a'.repeat(32),
    request_timestamp: '2026-09-03T04:05:06.000Z',
    body_sha256: TWEET_BODY_SHA256,
    ...overrides,
  };
  return {
    ...unsigned,
    response_hmac: createHmac('sha256', Buffer.from(TEST_MANUAL_NEWS_RESPONSE_SECRET, 'hex'))
      .update(canonicalJson(unsigned)).digest('hex'),
  };
}

function tweetDocument(overrides: Partial<PublicDocument> = {}): PublicDocument {
  return {
    response_key_id: TEST_MANUAL_NEWS_RESPONSE_KEY_ID,
    url: TWEET_URL,
    content_type: 'application/json',
    extraction: 'tweet_api',
    excerpt: TWEET_TEXT,
    redirects: 0,
    title: 'Anthropic（@AnthropicAI）',
    publisher: 'X @AnthropicAI',
    published_at: '2026-09-03T04:05:06.000Z',
    fetch_audit: signedTweetAudit() as never,
    ...overrides,
  };
}

function tweetEvidence(overrides: Partial<ManualNewsEvidence> = {}): ManualNewsEvidence {
  return {
    id: 'ev-tweet0000001',
    response_key_id: TEST_MANUAL_NEWS_RESPONSE_KEY_ID,
    url: TWEET_URL,
    source_type: 'other',
    publisher: 'X @AnthropicAI',
    published_at: '2026-09-03T04:05:06.000Z',
    retrieved_at: Date.parse('2026-09-03T04:05:07.000Z'),
    title: 'Anthropic（@AnthropicAI）',
    excerpt: TWEET_TEXT,
    claims_supported: [TWEET_TEXT],
    reliable: false,
    fetch_audit: signedTweetAudit() as never,
    ...overrides,
  };
}

describe('推文文档 → 证据', () => {
  test('推文证据带 tweet_api audit、推文自己的发布时间与可区分的来源标注', async () => {
    const evidence = await extractManualNewsEvidence(
      tweetDocument(), undefined, Date.parse('2026-09-03T04:05:08.000Z'),
    );

    expect(evidence).toBeTruthy();
    expect(evidence!.url).toBe(TWEET_URL);
    expect(evidence!.excerpt).toBe(TWEET_TEXT);
    // published_at 用推文自己的发布时间,不是取证时刻。
    expect(evidence!.published_at).toBe('2026-09-03T04:05:06.000Z');
    expect(evidence!.retrieved_at).toBe(Date.parse('2026-09-03T04:05:08.000Z'));
    // 来源标注与网页证据可区分。
    expect(evidence!.publisher).toBe('X @AnthropicAI');
    expect(isTweetEvidenceAudit(evidence!.fetch_audit)).toBe(true);
    // 一条推文的权威性取决于账号而不是域名,x.com 这个 host 不构成一手信源。
    // @AnthropicAI 在官方账号白名单里(2026-09-03 起),所以这条算一手公告;
    // 白名单之外的账号仍是 'other' / reliable=false,见
    // manual-news-official-x-accounts.test.ts。
    expect(evidence!.source_type).toBe('official_primary');
    expect(evidence!.reliable).toBe(true);
    expect(evidence!.claims_supported).toEqual([TWEET_TEXT]);
  });

  test('正文为空的推文不产出证据', async () => {
    expect(await extractManualNewsEvidence(tweetDocument({ excerpt: '   ' }))).toBeNull();
  });

  test('推文证据不会被误当成网页证据去跑 article_text 完整性校验', async () => {
    // 网页直抓路径要求 completeTrustedArticle 通过;推文文档没有 proof_excerpt / limits,
    // 若走错分支必然返回 null。这里断言它确实走了推文分支。
    const evidence = await extractManualNewsEvidence(tweetDocument());
    expect(evidence).not.toBeNull();
  });
});

describe('推文证据的持久化 provenance', () => {
  test('合法签名的推文 audit 通过证据签名前的 provenance 归一化,并被逐字重建', () => {
    const provenance = normalizedSignedEvidenceProvenance(tweetEvidence());
    expect(provenance).toEqual(signedTweetAudit());
    // 归一化结果必须仍是推文形状,不能被塞进直抓 audit 的字段。
    expect('hops' in provenance).toBe(false);
  });

  test('response_hmac 被篡改:形状归一化放行,签名校验拦下(职责分离)', async () => {
    // 归一化只管形状,签名正确性由 assertManualNewsEvidenceBodyDigests 里的
    // verifyTweetEvidenceAuditResponseHmac 负责 —— 与直抓/provider 路径同一套分工。
    const tampered = { ...signedTweetAudit(), response_hmac: 'd'.repeat(64) };
    expect(() => normalizedSignedEvidenceProvenance(tweetEvidence({ fetch_audit: tampered as never })))
      .not.toThrow();
    expect(await verifyTweetEvidenceAuditResponseHmac(tampered as never, TEST_MANUAL_NEWS_RESPONSE_SECRET))
      .toBe(false);
    // 未篡改时同一把密钥能验过。
    expect(await verifyTweetEvidenceAuditResponseHmac(signedTweetAudit() as never, TEST_MANUAL_NEWS_RESPONSE_SECRET))
      .toBe(true);
  });

  test.each([
    ['canonical_url 换成另一条推文', { canonical_url: 'https://x.com/openai/status/999' }],
    ['tweet_id 与 URL 不一致', { tweet_id: '999' }],
    ['provider 不在白名单', { provider: 'someone_else' }],
    ['protocol_version 不对', { protocol_version: 'article_text_v2' }],
  ])('拒绝 %s 的推文 audit', (_case, overrides) => {
    const audit = { ...signedTweetAudit(), ...overrides };
    expect(() => normalizedSignedEvidenceProvenance(tweetEvidence({ fetch_audit: audit as never })))
      .toThrow('manual_news_evidence_provenance_invalid');
  });

  test('拒绝多带一个键的推文 audit(严格键集合)', () => {
    const audit = { ...signedTweetAudit(), hops: [] };
    expect(() => normalizedSignedEvidenceProvenance(tweetEvidence({ fetch_audit: audit as never })))
      .toThrow('manual_news_evidence_provenance_invalid');
  });

  test('证据行必须指向 audit 里那条推文,不能挂到别的 URL 上', () => {
    expect(() => normalizedSignedEvidenceProvenance(tweetEvidence({ url: 'https://example.com/story' })))
      .toThrow('manual_news_evidence_provenance_invalid');
  });

  test('回归:真实网关语义下 body_sha256 与 sha256(推文正文) 不同,证据摘要校验必须放行', async () => {
    // prod(2026-09-03)实测:sha256(excerpt)=d4b347cb… 而 body_sha256=31d01068…,
    // 因为网关签的是整个 JSON 响应体。这条用例把「两者不相等」当前提钉死,
    // 再断言 assertManualNewsEvidenceBodyDigests 通过 —— 旧断言在这里必然报
    // manual_news_evidence_proof_excerpt_invalid。
    const evidence = tweetEvidence();
    const excerptDigest = createHash('sha256').update(TWEET_TEXT).digest('hex');
    expect(TWEET_BODY_SHA256).not.toBe(excerptDigest);
    await expect(assertManualNewsEvidenceBodyDigests([evidence], testManualNewsResponseKeyring()))
      .resolves.toBeUndefined();
  });

  test('回归:审计签名字段被改动,证据摘要校验仍然拦下(完整性锚点是 HMAC)', async () => {
    // excerpt 没有可比的签名摘要,推文证据的完整性锚点只剩审计 HMAC:
    // audit 里任何被签字段被动过,签名就对不上。
    const responseKeys = testManualNewsResponseKeyring();
    // body_sha256 被改:形状仍然合法,只能靠 HMAC 拦。
    await expect(assertManualNewsEvidenceBodyDigests([tweetEvidence({
      fetch_audit: { ...signedTweetAudit(), body_sha256: 'e'.repeat(64) } as never,
    })], responseKeys)).rejects.toThrow('manual_news_evidence_response_hmac_invalid');
    // 整条推文被换成另一条(tweet_id 与 URL 一起换,绕过形状校验):同样只能靠 HMAC 拦。
    const otherId = '1234567890123456780';
    const otherUrl = `https://x.com/AnthropicAI/status/${otherId}`;
    await expect(assertManualNewsEvidenceBodyDigests([tweetEvidence({
      url: otherUrl,
      fetch_audit: {
        ...signedTweetAudit(),
        tweet_id: otherId, requested_url: otherUrl, canonical_url: otherUrl,
      } as never,
    })], responseKeys)).rejects.toThrow('manual_news_evidence_response_hmac_invalid');
  });

  test('回归:推文证据线索能签出 owner 担保 payload 与 proof', async () => {
    // prod 上 vouch-candidate 返回 409 lead_not_vouchable 的直接成因就是这一步抛异常。
    const evidence = tweetEvidence();
    const responseKeys = testManualNewsResponseKeyring();
    const verificationKeys = testManualNewsVerificationKeyring('a'.repeat(64));
    const input = {
      lead_id: 'ml-20260903-abc123def456',
      assessment_version: 4_900_000,
    };
    const payload = await createManualNewsOwnerVouchPayload({
      lead: { id: input.lead_id, review_date: '2026-09-03' },
      statement: 'Anthropic 发布新模型并公布权重开放计划。',
      evidence: [evidence],
      vouched_at: 1_756_000_000_000,
    });
    expect(payload.primary_evidence_id).toBe(evidence.id);
    const proof = await createManualNewsOwnerVouchProof(
      { ...input, payload }, verificationKeys, responseKeys,
    );
    expect(proof.policy_version).toBe('owner_vouched_v1');
    expect(await isCurrentManualNewsOwnerVouchProof(
      { ...input, payload }, proof, verificationKeys, responseKeys,
    )).toBe(true);
  });

  test('变异验证:不补 tweet 分支时,推文 audit 会被当成直抓 audit 判为无效来源', () => {
    // 直抓分支要求 hops / limits / parser 等键齐全;推文 audit 一个都没有。
    // 这条用例锁住「必须有独立分支」这个前提本身。
    const audit = signedTweetAudit();
    expect('hops' in audit).toBe(false);
    expect('requested_limits' in audit).toBe(false);
    expect('parser' in audit).toBe(false);
    // 而带上 kind 之后能通过。
    expect(audit.kind).toBe('tweet_api');
    // 去掉 kind 之后就会掉进直抓分支,被判无效来源 —— 这正是不补分支时的结果。
    const { kind: _kind, ...withoutKind } = audit;
    expect(() => normalizedSignedEvidenceProvenance(tweetEvidence({ fetch_audit: withoutKind as never })))
      .toThrow('manual_news_evidence_provenance_invalid');
    expect(normalizedSignedEvidenceProvenance(tweetEvidence())).toEqual(audit);
  });
});
