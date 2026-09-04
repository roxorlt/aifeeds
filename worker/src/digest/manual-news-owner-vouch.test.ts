import { describe, expect, test } from 'vitest';

import type { ManualNewsEvidence } from './manual-news-leads';
import {
  createManualNewsOwnerVouchPayload,
  createManualNewsOwnerVouchProof,
  isCurrentManualNewsOwnerVouchProof,
  MANUAL_NEWS_OWNER_VOUCH_POLICY,
  normalizeOwnerVouchStatement,
  ownerVouchCandidateFromPayload,
} from './manual-news-owner-vouch';
import {
  testManualNewsResponseKeyring,
  testManualNewsVerificationKeyring,
  withSignedArticleTextV2Audit,
} from './manual-news-signed-evidence.test-fixture';

const VERIFICATION_SECRET = 'a'.repeat(64);
const STATEMENT = 'OpenAI 发布 GPT-6 并向 Plus 用户开放。';
const LEAD_ID = 'ml-20260903-abc123def456';

function evidence(overrides: Partial<ManualNewsEvidence> = {}): ManualNewsEvidence {
  return withSignedArticleTextV2Audit({
    id: 'ev-openai',
    url: 'https://openai.com/index/gpt-6/',
    source_type: 'official_primary',
    publisher: 'OpenAI',
    published_at: '2026-09-03T00:00:00.000Z',
    retrieved_at: 11,
    title: 'Introducing GPT-6',
    excerpt: 'OpenAI is rolling out GPT-6 to Plus users today.',
    claims_supported: ['OpenAI is rolling out GPT-6 to Plus users today.'],
    reliable: true,
    ...overrides,
  } as ManualNewsEvidence);
}

function payloadInput(overrides: Record<string, unknown> = {}) {
  return {
    lead: { id: LEAD_ID, review_date: '2026-09-03' },
    statement: STATEMENT,
    evidence: [evidence()],
    vouched_at: 1_756_000_000_000,
    ...overrides,
  } as Parameters<typeof createManualNewsOwnerVouchPayload>[0];
}

describe('normalizeOwnerVouchStatement', () => {
  test('normalizes whitespace and keeps the owner wording', () => {
    expect(normalizeOwnerVouchStatement('  OpenAI   发布 GPT-6 并向 Plus 用户开放。 '))
      .toBe('OpenAI 发布 GPT-6 并向 Plus 用户开放。');
  });

  test('accepts an English statement with at least three words', () => {
    expect(normalizeOwnerVouchStatement('OpenAI released GPT-6')).toBe('OpenAI released GPT-6');
  });

  test('applies NFC so the same visible statement has one canonical form', () => {
    expect(normalizeOwnerVouchStatement('caf\u0065\u0301 launches a new model'))
      .toBe('caf\u00e9 launches a new model');
  });

  test.each([
    ['non string', 42],
    ['blank', '   '],
    ['too short', '发布新模型'],
    ['too long', '我'.repeat(161)],
    ['newline', 'OpenAI 发布 GPT-6\n并向用户开放'],
    ['carriage return', 'OpenAI 发布 GPT-6\r并向用户开放'],
    ['control character', 'OpenAI 发布 GPT-6\u0007 并向用户开放'],
    ['zero width', 'OpenAI 发布\u200bGPT-6 并向用户开放'],
    ['bidi override', 'OpenAI \u202e发布 GPT-6 并向用户开放'],
    ['too few han characters', '发布 GPT-6'],
    ['too few english words', 'GPT-6 shipped'],
  ])('rejects %s', (_label, value) => {
    expect(() => normalizeOwnerVouchStatement(value)).toThrow('invalid_vouch_statement');
  });

  // 2026-09-04 owner 实测:AI 新闻里公司名 / 产品名几乎都是英文,中英混写是常态。
  // 「至少 4 个汉字或 3 个英文单词」把 `OpenAI发布Astra` 这种完整陈述拒在门外,
  // 放宽为「内容 token 数 >= 3」(一段连续汉字 = 1 个,一个 ASCII 单词 = 1 个)。
  test.each([
    ['OpenAI发布Astra'],
    ['GPT、claude、Grok三家服务宕机'],
    ['OpenAI发布新模型Astra'],
  ])('accepts the real 2026-09-04 owner statement %s', (value) => {
    expect(normalizeOwnerVouchStatement(value)).toBe(value);
  });

  test.each([
    ['punctuation only', '。。。。。。'],
    ['a single repeated ascii token', 'aaaaaa'],
    ['a single ascii token with digits', 'Gemini3Gemini3'],
    ['two mixed tokens', 'Astra发布'],
  ])('still rejects %s', (_label, value) => {
    expect(() => normalizeOwnerVouchStatement(value)).toThrow('invalid_vouch_statement');
  });

  test('accepts exactly six code points and exactly 160 code points', () => {
    expect(normalizeOwnerVouchStatement('阿里发布模型')).toBe('阿里发布模型');
    const long = `阿里发布模型${'字'.repeat(154)}`;
    expect(Array.from(normalizeOwnerVouchStatement(long)).length).toBe(160);
  });
});

describe('createManualNewsOwnerVouchPayload', () => {
  test('projects the statement as the candidate title and summary', async () => {
    const payload = await createManualNewsOwnerVouchPayload(payloadInput());

    expect(payload).toMatchObject({
      policy_version: MANUAL_NEWS_OWNER_VOUCH_POLICY,
      lead_id: LEAD_ID,
      review_date: '2026-09-03',
      statement: STATEMENT,
      primary_evidence_id: 'ev-openai',
      vouched_at: 1_756_000_000_000,
      item_projection: {
        item_id: `blog:manual:${LEAD_ID}`,
        source_id: `manual:${LEAD_ID}`,
        title: STATEMENT,
        summary: STATEMENT,
        source: 'OpenAI',
        score: null,
        url: 'https://openai.com/index/gpt-6/',
        published_at: '2026-09-03T00:00:00.000Z',
      },
    });
    expect(payload.event_identity.event_key).toMatch(/^mnvo1:[a-f0-9]{64}$/);
  });

  test('derives the event key from the primary evidence url only', async () => {
    const first = await createManualNewsOwnerVouchPayload(payloadInput());
    const second = await createManualNewsOwnerVouchPayload(payloadInput({
      statement: '另一位记者报道 OpenAI 的同一件事情。', vouched_at: 1_756_000_000_001,
    }));
    const third = await createManualNewsOwnerVouchPayload(payloadInput({
      evidence: [evidence({ id: 'ev-other', url: 'https://openai.com/index/gpt-6-plus/' })],
    }));

    expect(second.event_identity.event_key).toBe(first.event_identity.event_key);
    expect(third.event_identity.event_key).not.toBe(first.event_identity.event_key);
  });

  test('prefers the first reliable evidence and falls back to the first entry', async () => {
    const unreliable = evidence({
      id: 'ev-aaa', url: 'https://example.com/aaa', publisher: 'example.com',
      source_type: 'other', reliable: false,
    });
    const reliable = evidence({ id: 'ev-zzz' });

    const preferred = await createManualNewsOwnerVouchPayload(payloadInput({
      evidence: [unreliable, reliable],
    }));
    const fallback = await createManualNewsOwnerVouchPayload(payloadInput({
      evidence: [unreliable],
    }));

    expect(preferred.primary_evidence_id).toBe('ev-zzz');
    expect(preferred.item_projection.source).toBe('OpenAI');
    expect(fallback.primary_evidence_id).toBe('ev-aaa');
    expect(fallback.item_projection.source).toBe('example.com');
  });

  test('canonicalizes the evidence set by id', async () => {
    const payload = await createManualNewsOwnerVouchPayload(payloadInput({
      evidence: [evidence({ id: 'ev-zzz' }), evidence({
        id: 'ev-aaa', url: 'https://example.com/aaa', publisher: 'example.com',
        source_type: 'other', reliable: false,
      })],
    }));

    expect(payload.evidence.map((item) => item.id)).toEqual(['ev-aaa', 'ev-zzz']);
  });

  test('rejects an empty evidence set and an invalid vouch timestamp', async () => {
    await expect(createManualNewsOwnerVouchPayload(payloadInput({ evidence: [] })))
      .rejects.toThrow(/owner_vouch_payload_invalid|manual_news_evidence_set_invalid/);
    await expect(createManualNewsOwnerVouchPayload(payloadInput({ vouched_at: -1 })))
      .rejects.toThrow('owner_vouch_payload_invalid');
    await expect(createManualNewsOwnerVouchPayload(payloadInput({
      lead: { id: LEAD_ID, review_date: '2026-9-3' },
    }))).rejects.toThrow('owner_vouch_payload_invalid');
  });
});

describe('ownerVouchCandidateFromPayload', () => {
  test('passes the signed projection through verbatim plus the event key', async () => {
    const payload = await createManualNewsOwnerVouchPayload(payloadInput());

    expect(ownerVouchCandidateFromPayload(payload)).toEqual({
      ...payload.item_projection,
      event_key: payload.event_identity.event_key,
    });
  });
});

describe('createManualNewsOwnerVouchProof', () => {
  const verificationKeys = () => testManualNewsVerificationKeyring(VERIFICATION_SECRET);
  const responseKeys = () => testManualNewsResponseKeyring();

  test('round-trips a freshly created proof', async () => {
    const payload = await createManualNewsOwnerVouchPayload(payloadInput());
    const proof = await createManualNewsOwnerVouchProof(
      { lead_id: LEAD_ID, assessment_version: 4_900_000, payload },
      verificationKeys(), responseKeys(),
    );

    expect(proof).toMatchObject({
      policy_version: MANUAL_NEWS_OWNER_VOUCH_POLICY,
      canonical_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      hmac_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    await expect(isCurrentManualNewsOwnerVouchProof(
      { lead_id: LEAD_ID, assessment_version: 4_900_000, payload }, proof,
      verificationKeys(), responseKeys(),
    )).resolves.toBe(true);
  });

  test('is not current after the statement, evidence, lead or version drifts', async () => {
    const payload = await createManualNewsOwnerVouchPayload(payloadInput());
    const proof = await createManualNewsOwnerVouchProof(
      { lead_id: LEAD_ID, assessment_version: 4_900_000, payload },
      verificationKeys(), responseKeys(),
    );

    await expect(isCurrentManualNewsOwnerVouchProof(
      {
        lead_id: LEAD_ID,
        assessment_version: 4_900_000,
        payload: { ...payload, statement: '阿里巴巴发布通义千问新模型。' },
      },
      proof, verificationKeys(), responseKeys(),
    )).resolves.toBe(false);
    await expect(isCurrentManualNewsOwnerVouchProof(
      {
        lead_id: LEAD_ID,
        assessment_version: 4_900_000,
        payload: {
          ...payload,
          evidence: [{
            ...payload.evidence[0],
            excerpt: 'forged excerpt',
            claims_supported: ['forged excerpt'],
          }],
        },
      },
      proof, verificationKeys(), responseKeys(),
    )).resolves.toBe(false);
    await expect(isCurrentManualNewsOwnerVouchProof(
      { lead_id: 'ml-20260903-000000000000', assessment_version: 4_900_000, payload },
      proof, verificationKeys(), responseKeys(),
    )).resolves.toBe(false);
    await expect(isCurrentManualNewsOwnerVouchProof(
      { lead_id: LEAD_ID, assessment_version: 5_900_000, payload },
      proof, verificationKeys(), responseKeys(),
    )).resolves.toBe(false);
  });

  test('is not current under another verification key or a mismatched policy', async () => {
    const payload = await createManualNewsOwnerVouchPayload(payloadInput());
    const proof = await createManualNewsOwnerVouchProof(
      { lead_id: LEAD_ID, assessment_version: 4_900_000, payload },
      verificationKeys(), responseKeys(),
    );

    await expect(isCurrentManualNewsOwnerVouchProof(
      { lead_id: LEAD_ID, assessment_version: 4_900_000, payload }, proof,
      testManualNewsVerificationKeyring('b'.repeat(64)), responseKeys(),
    )).resolves.toBe(false);
    await expect(isCurrentManualNewsOwnerVouchProof(
      { lead_id: LEAD_ID, assessment_version: 4_900_000, payload },
      { ...proof, policy_version: 'source_support_v1' },
      verificationKeys(), responseKeys(),
    )).resolves.toBe(false);
  });

  test('rejects a payload whose key set drifted from the signed contract', async () => {
    const payload = await createManualNewsOwnerVouchPayload(payloadInput());
    const extended = { ...payload, extra_field: 'x' } as unknown as typeof payload;

    await expect(createManualNewsOwnerVouchProof(
      { lead_id: LEAD_ID, assessment_version: 4_900_000, payload: extended },
      verificationKeys(), responseKeys(),
    )).rejects.toThrow('owner_vouch_payload_invalid');
    await expect(isCurrentManualNewsOwnerVouchProof(
      { lead_id: LEAD_ID, assessment_version: 4_900_000, payload: extended },
      await createManualNewsOwnerVouchProof(
        { lead_id: LEAD_ID, assessment_version: 4_900_000, payload },
        verificationKeys(), responseKeys(),
      ),
      verificationKeys(), responseKeys(),
    )).resolves.toBe(false);
  });

  test('rejects evidence whose signed body digest no longer matches', async () => {
    const payload = await createManualNewsOwnerVouchPayload(payloadInput());
    const forged = {
      ...payload,
      evidence: [{
        ...payload.evidence[0],
        excerpt: 'forged excerpt',
        claims_supported: ['forged excerpt'],
      }],
    };

    await expect(createManualNewsOwnerVouchProof(
      { lead_id: LEAD_ID, assessment_version: 4_900_000, payload: forged },
      verificationKeys(), responseKeys(),
    )).rejects.toThrow('manual_news_evidence_proof_excerpt_invalid');
  });
});
