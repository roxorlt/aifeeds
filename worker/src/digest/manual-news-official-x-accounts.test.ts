// 官方 X 账号白名单（2026-09-03）。
//
// 一条推文的权威性取决于**账号**而不是域名，所以默认所有推文都是 reliable=false / 'other'。
// 白名单只对「厂商官方账号」这一小撮 handle 开口子：它们发的推文就是一手公告，
// 与官网 blog 同级。handle 只能从**已签名**的 audit.canonical_url 里取，
// 绝不能用未签名的 tweet.author_handle —— 后者是 provider 返回的裸字段，可被伪造。

import { createHash, createHmac } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';

import {
  extractManualNewsEvidence,
  officialXAccountActors,
  OFFICIAL_X_ACCOUNT_ACTORS,
} from './manual-news-leads-runtime';
import { officialXAccountFirstPersonRewrite } from './manual-news-leads';
import { manualNewsEvidenceDetail } from './manual-news-leads-api';
import {
  buildManualNewsSourceSupportVerificationPrompt,
  createManualNewsSourceSupportPayload,
  createManualNewsSourceSupportProof,
  isCurrentManualNewsSourceSupportProof,
  validateManualNewsSourceSupportSelection,
  validateManualNewsSourceSupportVerification,
} from './manual-news-leads';
import type { PublicDocument } from '../security/safe-url-fetch';
import {
  TEST_MANUAL_NEWS_RESPONSE_KEY_ID,
  TEST_MANUAL_NEWS_RESPONSE_SECRET,
  testManualNewsResponseKeyring,
  testManualNewsVerificationKeyring,
} from './manual-news-signed-evidence.test-fixture';

const verificationSecret = 'a'.repeat(64);

const TWEET_TEXT = 'We\u2019ve released Gemini 3.8 Flash.';

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(object[k])}`).join(',')}}`;
}

function tweetDocument(handle: string, tweetId = '2095175881690173885'): PublicDocument {
  const canonicalUrl = `https://x.com/${handle}/status/${tweetId}`;
  const unsigned = {
    kind: 'tweet_api',
    provider: 'scrapebadger',
    tweet_id: tweetId,
    requested_url: canonicalUrl,
    canonical_url: canonicalUrl,
    fetched_at: '2026-09-03T04:05:07.000Z',
    provider_status: 200,
    protocol_version: 'tweet_evidence_v1',
    request_nonce: 'a'.repeat(32),
    request_timestamp: '2026-09-03T04:05:06.000Z',
    body_sha256: createHash('sha256').update(TWEET_TEXT).digest('hex'),
  };
  const fetchAudit = {
    ...unsigned,
    response_hmac: createHmac('sha256', Buffer.from(TEST_MANUAL_NEWS_RESPONSE_SECRET, 'hex'))
      .update(canonicalJson(unsigned)).digest('hex'),
  };
  return {
    response_key_id: TEST_MANUAL_NEWS_RESPONSE_KEY_ID,
    url: canonicalUrl,
    content_type: 'application/json',
    extraction: 'tweet_api',
    excerpt: TWEET_TEXT,
    redirects: 0,
    title: `X @${handle}`,
    publisher: `X @${handle}`,
    published_at: '2026-09-03T04:05:06.000Z',
    fetch_audit: fetchAudit as never,
  };
}

describe('官方 X 账号白名单', () => {
  test('白名单账号的推文算一手公告', async () => {
    const evidence = await extractManualNewsEvidence(tweetDocument('GoogleAI'));
    expect(evidence).toBeTruthy();
    expect(evidence!.source_type).toBe('official_primary');
    expect(evidence!.reliable).toBe(true);
    // publisher 的写法不变，仍是「X @handle」。
    expect(evidence!.publisher).toBe('X @GoogleAI');
  });

  test('handle 大小写不影响判定', async () => {
    const evidence = await extractManualNewsEvidence(tweetDocument('OpenAI'));
    expect(evidence!.reliable).toBe(true);
    expect(evidence!.source_type).toBe('official_primary');
  });

  test('不在白名单的账号维持原状：other / 不可靠', async () => {
    const evidence = await extractManualNewsEvidence(tweetDocument('officiallogank'));
    expect(evidence!.source_type).toBe('other');
    expect(evidence!.reliable).toBe(false);
  });

  test('handle 只认已签名的 canonical_url，不认文档上的 publisher 字段', async () => {
    const document = tweetDocument('officiallogank');
    const evidence = await extractManualNewsEvidence({
      ...document,
      publisher: 'X @GoogleAI',
      title: 'X @GoogleAI',
    });
    expect(evidence!.reliable).toBe(false);
    expect(evidence!.source_type).toBe('other');
  });

  test('内置白名单覆盖规格给定的 15 个账号', () => {
    expect([...OFFICIAL_X_ACCOUNT_ACTORS.keys()].sort()).toEqual([
      'aiatmeta', 'alibaba_qwen', 'anthropicai', 'cohere', 'deepseek_ai', 'github',
      'googleai', 'googledeepmind', 'huggingface', 'microsoft', 'mistralai', 'nvidia',
      'openai', 'perplexity_ai', 'xai',
    ]);
    for (const [handle, entry] of OFFICIAL_X_ACCOUNT_ACTORS) {
      expect(handle).toMatch(/^[a-z0-9_]{1,15}$/u);
      expect(entry.actor.length).toBeGreaterThan(0);
      expect(entry.label.length).toBeGreaterThan(0);
    }
  });
});

describe('白名单的 env 覆盖', () => {
  test('合法的 env 值会并入并覆盖内置项', () => {
    const merged = officialXAccountActors({
      MANUAL_NEWS_OFFICIAL_X_HANDLES: 'acmeai=Acme AI, googleai=Google Research',
    } as never);
    expect(merged.get('acmeai')?.actor).toBe('Acme AI');
    expect(merged.get('googleai')?.actor).toBe('Google Research');
    expect(merged.get('openai')?.actor).toBe('OpenAI');
  });

  test('任何一项写坏就整体忽略，并打一条 warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const merged = officialXAccountActors({
        MANUAL_NEWS_OFFICIAL_X_HANDLES: 'acmeai=Acme AI,坏掉的条目',
      } as never);
      expect(merged.get('acmeai')).toBeUndefined();
      expect(merged.get('googleai')?.actor).toBe('Google');
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test('没有 env 值时就是内置白名单', () => {
    expect(officialXAccountActors({} as never)).toEqual(OFFICIAL_X_ACCOUNT_ACTORS);
  });

  test('env 里的 handle / actor 不合法（非法字符、超长）也整体忽略', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(officialXAccountActors({
        MANUAL_NEWS_OFFICIAL_X_HANDLES: 'acme-ai=Acme AI',
      } as never).get('acme-ai')).toBeUndefined();
      expect(officialXAccountActors({
        MANUAL_NEWS_OFFICIAL_X_HANDLES: `acmeai=${'A'.repeat(100)}`,
      } as never).get('acmeai')).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('证据列表里的来源标签', () => {
  test('白名单推文标「官方账号推文」，其余推文标普通推文', async () => {
    const official = await extractManualNewsEvidence(tweetDocument('GoogleAI'));
    const ordinary = await extractManualNewsEvidence(tweetDocument('officiallogank'));
    expect(manualNewsEvidenceDetail(official!)).toMatchObject({
      evidence_kind: 'tweet_api',
      source_label: 'X/Twitter 官方账号推文（ScrapeBadger）',
      source_type: 'official_primary',
      reliable: true,
    });
    expect(manualNewsEvidenceDetail(ordinary!)).toMatchObject({
      evidence_kind: 'tweet_api',
      source_label: 'X/Twitter 推文（ScrapeBadger）',
      source_type: 'other',
      reliable: false,
    });
  });
});

describe('官方 X 账号的第一人称放行（source_support_v1 全链路）', () => {
  const fact = 'Google 已发布 Gemini 3.8 Flash。';

  async function officialTweetEvidence(handle: string) {
    const evidence = await extractManualNewsEvidence(tweetDocument(handle));
    return evidence!;
  }

  test('@GoogleAI 的第一人称推文可以支持 owner 写的事实，一路走到 proof', async () => {
    const evidence = await officialTweetEvidence('GoogleAI');
    const selection = validateManualNewsSourceSupportSelection(
      { evidence_id: evidence.id, quote: TWEET_TEXT },
      { fact, evidence: [evidence] },
    );
    expect(selection).toEqual({ evidence_id: evidence.id, quote: TWEET_TEXT });

    const verification = validateManualNewsSourceSupportVerification(
      { supported: true, evidence_id: evidence.id }, selection,
    );
    const payload = await createManualNewsSourceSupportPayload({
      lead: {
        id: 'ml-20260903-googleai-flash', review_date: '2026-09-03', input_type: 'text_url',
        input_text: fact, input_url: evidence.url, note: '',
      },
      authorization: {
        audit_id: 77,
        candidate_authorization: 'source_support_v1',
        submit_identity_digest: '3'.repeat(64),
        idempotency_key: 'submit-googleai-flash',
      },
      evidence: [evidence], selection, verification,
    });
    // 绑定只作用于送给模型的核验句，不写进签名载荷。
    expect(JSON.stringify(payload)).not.toContain('official_x_account_first_person_actor_v1');
    expect(JSON.stringify(payload)).not.toContain('verification_quote');

    const proofInput = {
      lead_id: 'ml-20260903-googleai-flash', assessment_version: 9, payload,
    };
    const proof = await createManualNewsSourceSupportProof(
      proofInput,
      testManualNewsVerificationKeyring(verificationSecret), testManualNewsResponseKeyring(),
    );
    await expect(isCurrentManualNewsSourceSupportProof(
      proofInput, proof,
      testManualNewsVerificationKeyring(verificationSecret), testManualNewsResponseKeyring(),
    )).resolves.toBe(true);
  });

  test('核验提示词声明了官方 X 账号的绑定契约', async () => {
    const evidence = await officialTweetEvidence('GoogleAI');
    const selection = validateManualNewsSourceSupportSelection(
      { evidence_id: evidence.id, quote: TWEET_TEXT }, { fact, evidence: [evidence] },
    );
    const prompt = buildManualNewsSourceSupportVerificationPrompt({
      fact, evidence: [evidence], selection,
    });
    expect(prompt.system).toContain('official_x_account_first_person_actor_v1');
    const body = JSON.parse(prompt.user) as {
      selected_evidence: { verification_quote?: string; binding_contract?: string };
    };
    expect(body.selected_evidence.verification_quote)
      .toBe('Google has released Gemini 3.8 Flash.');
    expect(body.selected_evidence.binding_contract).toBe('official_x_account_first_person_actor_v1');
  });

  test('同一条推文换成不在白名单的账号，证据不可靠，直接拒绝', async () => {
    const evidence = await officialTweetEvidence('officiallogank');
    expect(() => validateManualNewsSourceSupportSelection(
      { evidence_id: evidence.id, quote: TWEET_TEXT }, { fact, evidence: [evidence] },
    )).toThrow('source_support_evidence_invalid');
  });

  test('即使证据被标成一手，handle 不在白名单也不给第一人称绑定', async () => {
    // 纵深防御：证据形状（reliable / official_primary）与 URL 里的 handle 是两道独立的闸门，
    // 只有其中一道被绕过时，第一人称仍然不放行。
    const ordinary = await officialTweetEvidence('officiallogank');
    const forged = { ...ordinary, source_type: 'official_primary' as const, reliable: true };
    expect(() => validateManualNewsSourceSupportSelection(
      { evidence_id: forged.id, quote: TWEET_TEXT }, { fact, evidence: [forged] },
    )).toThrow('source_support_fact_invalid:fact_verification_action_mismatch');
  });

  test('白名单账号但事实主体对不上时，第一人称不放行', async () => {
    const evidence = await officialTweetEvidence('GoogleAI');
    expect(() => validateManualNewsSourceSupportSelection(
      { evidence_id: evidence.id, quote: TWEET_TEXT },
      { fact: 'OpenAI 已发布 Gemini 3.8 Flash。', evidence: [evidence] },
    )).toThrow('source_support_fact_invalid:fact_verification_action_mismatch');
  });
});

describe('第一人称主语替换', () => {
  test('保持时态：we\u2019re → is、we\u2019ve → has、we → 原形', () => {
    expect(officialXAccountFirstPersonRewrite('We\u2019re rolling out Gemini 3.8 Flash.', 'Google'))
      .toBe('Google is rolling out Gemini 3.8 Flash.');
    expect(officialXAccountFirstPersonRewrite('We are rolling out Gemini 3.8 Flash.', 'Google'))
      .toBe('Google is rolling out Gemini 3.8 Flash.');
    expect(officialXAccountFirstPersonRewrite('We\u2019ve released Gemini 3.8 Flash.', 'Google'))
      .toBe('Google has released Gemini 3.8 Flash.');
    expect(officialXAccountFirstPersonRewrite('We have released Gemini 3.8 Flash.', 'Google'))
      .toBe('Google has released Gemini 3.8 Flash.');
    expect(officialXAccountFirstPersonRewrite('We released Gemini 3.8 Flash.', 'Google'))
      .toBe('Google released Gemini 3.8 Flash.');
    // 句首的「Today,」保留，不能悄悄丢内容。
    expect(officialXAccountFirstPersonRewrite('Today, we released Gemini 3.8 Flash.', 'Google'))
      .toBe('Today, Google released Gemini 3.8 Flash.');
  });

  test('不是第一人称开头就不替换', () => {
    expect(officialXAccountFirstPersonRewrite('Google released Gemini 3.8 Flash.', 'Google')).toBeNull();
    expect(officialXAccountFirstPersonRewrite('Weather models improved.', 'Google')).toBeNull();
  });
});

describe('推文证据的正文完整性', () => {
  test('推文正文被改动后，证据摘要校验拦下', async () => {
    const evidence = await extractManualNewsEvidence(tweetDocument('GoogleAI'));
    const tamperedText = `${TWEET_TEXT} And more.`;
    const tampered = { ...evidence!, excerpt: tamperedText, claims_supported: [tamperedText] };
    const selection = { evidence_id: evidence!.id, quote: TWEET_TEXT };
    await expect(createManualNewsSourceSupportProof(
      {
        lead_id: 'ml-20260903-tampered',
        assessment_version: 9,
        payload: await createManualNewsSourceSupportPayload({
          lead: {
            id: 'ml-20260903-tampered', review_date: '2026-09-03', input_type: 'text_url',
            input_text: 'Google 已发布 Gemini 3.8 Flash。', input_url: evidence!.url, note: '',
          },
          authorization: {
            audit_id: 78, candidate_authorization: 'source_support_v1',
            submit_identity_digest: '4'.repeat(64), idempotency_key: 'submit-tampered',
          },
          evidence: [tampered], selection,
          verification: { supported: true, evidence_id: evidence!.id },
        }),
      },
      testManualNewsVerificationKeyring(verificationSecret), testManualNewsResponseKeyring(),
    )).rejects.toThrow('manual_news_evidence_proof_excerpt_invalid');
  });
});
