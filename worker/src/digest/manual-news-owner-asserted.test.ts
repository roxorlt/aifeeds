import { describe, expect, test } from 'vitest';

import { canonicalJson, sha256Hex, type ManualNewsEvidence } from './manual-news-leads';
import {
  createManualNewsOwnerAssertedPayload,
  createManualNewsOwnerAssertedProof,
  isCurrentManualNewsOwnerAssertedProof,
  MANUAL_NEWS_OWNER_ASSERTED_POLICY,
  ownerAssertedCandidateFromPayload,
} from './manual-news-owner-asserted';
import {
  testManualNewsResponseKeyring,
  testManualNewsVerificationKeyring,
  withSignedArticleTextV2Audit,
} from './manual-news-signed-evidence.test-fixture';

const VERIFICATION_SECRET = 'a'.repeat(64);
const STATEMENT = 'OpenAI发布Astra';
const LEAD_ID = 'ml-20260904-abc123def456';

function evidence(overrides: Partial<ManualNewsEvidence> = {}): ManualNewsEvidence {
  return withSignedArticleTextV2Audit({
    id: 'ev-openai',
    url: 'https://openai.com/index/astra/',
    source_type: 'official_primary',
    publisher: 'OpenAI',
    published_at: '2026-09-04T00:00:00.000Z',
    retrieved_at: 11,
    title: 'Introducing Astra',
    excerpt: 'OpenAI is releasing Astra today.',
    claims_supported: ['OpenAI is releasing Astra today.'],
    reliable: true,
    ...overrides,
  } as ManualNewsEvidence);
}

function payloadInput(overrides: Record<string, unknown> = {}) {
  return {
    lead: { id: LEAD_ID, review_date: '2026-09-04', input_url: '' },
    statement: STATEMENT,
    evidence: [],
    asserted_at: 1_757_000_000_000,
    ...overrides,
  } as Parameters<typeof createManualNewsOwnerAssertedPayload>[0];
}

describe('createManualNewsOwnerAssertedPayload', () => {
  test('projects a zero-evidence assertion with an empty url, not null', async () => {
    const payload = await createManualNewsOwnerAssertedPayload(payloadInput());

    expect(payload).toEqual({
      policy_version: MANUAL_NEWS_OWNER_ASSERTED_POLICY,
      lead_id: LEAD_ID,
      review_date: '2026-09-04',
      statement: STATEMENT,
      evidence: [],
      event_identity: { event_key: expect.stringMatching(/^mnoa1:[a-f0-9]{64}$/) },
      item_projection: {
        item_id: `blog:manual:${LEAD_ID}`,
        source_id: `manual:${LEAD_ID}`,
        title: STATEMENT,
        summary: STATEMENT,
        source: '手工补录',
        score: null,
        url: '',
        published_at: null,
      },
      asserted_at: 1_757_000_000_000,
    });
    // 正式新闻门用 `i.url IS json_extract(...,'$.item_projection.url')` 绑定,
    // items 写入走 `candidate.url || ''` —— null 与 '' 对不上会被判 stale。
    expect(payload.item_projection.url).not.toBeNull();
  });

  test('binds the event key to the lead id so two assertions never collide', async () => {
    const first = await createManualNewsOwnerAssertedPayload(payloadInput());
    const sameLead = await createManualNewsOwnerAssertedPayload(payloadInput({
      statement: '阿里发布通义千问新模型', asserted_at: 1_757_000_000_001,
    }));
    const otherLead = await createManualNewsOwnerAssertedPayload(payloadInput({
      lead: { id: 'ml-20260904-000000000000', review_date: '2026-09-04', input_url: '' },
    }));

    expect(sameLead.event_identity.event_key).toBe(first.event_identity.event_key);
    expect(otherLead.event_identity.event_key).not.toBe(first.event_identity.event_key);
  });

  test('falls back to an https lead url and ignores anything else', async () => {
    const https = await createManualNewsOwnerAssertedPayload(payloadInput({
      lead: { id: LEAD_ID, review_date: '2026-09-04', input_url: 'https://openai.com/astra/' },
    }));
    const http = await createManualNewsOwnerAssertedPayload(payloadInput({
      lead: { id: LEAD_ID, review_date: '2026-09-04', input_url: 'http://openai.com/astra/' },
    }));

    expect(https.item_projection.url).toBe('https://openai.com/astra/');
    expect(http.item_projection.url).toBe('');
  });

  test('attaches evidence and takes source, url and time from the primary entry', async () => {
    const payload = await createManualNewsOwnerAssertedPayload(payloadInput({
      lead: { id: LEAD_ID, review_date: '2026-09-04', input_url: 'https://example.com/ignored' },
      evidence: [evidence({
        id: 'ev-aaa-mirror', url: 'https://mirror.example.com/astra/', publisher: 'mirror.example.com',
        source_type: 'other', published_at: '2026-08-01T00:00:00.000Z', reliable: false,
      }), evidence()],
    }));

    expect(payload.evidence.map((item) => item.id)).toEqual(['ev-aaa-mirror', 'ev-openai']);
    expect(payload.item_projection).toMatchObject({
      source: 'OpenAI',
      url: 'https://openai.com/index/astra/',
      published_at: '2026-09-04T00:00:00.000Z',
      title: STATEMENT,
      summary: STATEMENT,
    });
  });

  test('rejects an invalid statement, lead id, review date or timestamp', async () => {
    await expect(createManualNewsOwnerAssertedPayload(payloadInput({ statement: 'aaaaaa' })))
      .rejects.toThrow('invalid_vouch_statement');
    await expect(createManualNewsOwnerAssertedPayload(payloadInput({
      lead: { id: 'not-a-lead', review_date: '2026-09-04', input_url: '' },
    }))).rejects.toThrow('owner_asserted_payload_invalid');
    await expect(createManualNewsOwnerAssertedPayload(payloadInput({
      lead: { id: LEAD_ID, review_date: '2026-9-4', input_url: '' },
    }))).rejects.toThrow('owner_asserted_payload_invalid');
    await expect(createManualNewsOwnerAssertedPayload(payloadInput({ asserted_at: -1 })))
      .rejects.toThrow('owner_asserted_payload_invalid');
  });
});

describe('ownerAssertedCandidateFromPayload', () => {
  test('passes the signed projection through verbatim plus the event key', async () => {
    const payload = await createManualNewsOwnerAssertedPayload(payloadInput());

    expect(ownerAssertedCandidateFromPayload(payload)).toEqual({
      ...payload.item_projection,
      event_key: payload.event_identity.event_key,
    });
  });
});

describe('createManualNewsOwnerAssertedProof', () => {
  const verificationKeys = () => testManualNewsVerificationKeyring(VERIFICATION_SECRET);
  const responseKeys = () => testManualNewsResponseKeyring();
  const proofInput = (payload: Awaited<ReturnType<typeof createManualNewsOwnerAssertedPayload>>) => ({
    lead_id: LEAD_ID, input_url: '', assessment_version: 4_800_000, payload,
  });

  test('round-trips a zero-evidence proof', async () => {
    const payload = await createManualNewsOwnerAssertedPayload(payloadInput());
    const proof = await createManualNewsOwnerAssertedProof(
      proofInput(payload), verificationKeys(), responseKeys(),
    );

    expect(proof).toMatchObject({
      policy_version: MANUAL_NEWS_OWNER_ASSERTED_POLICY,
      canonical_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      hmac_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    await expect(isCurrentManualNewsOwnerAssertedProof(
      proofInput(payload), proof, verificationKeys(), responseKeys(),
    )).resolves.toBe(true);
  });

  test('round-trips a proof that carries evidence', async () => {
    const payload = await createManualNewsOwnerAssertedPayload(payloadInput({ evidence: [evidence()] }));
    const proof = await createManualNewsOwnerAssertedProof(
      proofInput(payload), verificationKeys(), responseKeys(),
    );

    await expect(isCurrentManualNewsOwnerAssertedProof(
      proofInput(payload), proof, verificationKeys(), responseKeys(),
    )).resolves.toBe(true);
  });

  test('still verifies the signed evidence body digest when evidence is attached', async () => {
    const payload = await createManualNewsOwnerAssertedPayload(payloadInput({ evidence: [evidence()] }));
    const forged = {
      ...payload,
      evidence: [{
        ...payload.evidence[0],
        excerpt: 'forged excerpt',
        claims_supported: ['forged excerpt'],
      }],
    };

    await expect(createManualNewsOwnerAssertedProof(
      proofInput(forged), verificationKeys(), responseKeys(),
    )).rejects.toThrow('manual_news_evidence_proof_excerpt_invalid');
  });

  test('is not current after the statement, lead, url fallback or version drifts', async () => {
    const payload = await createManualNewsOwnerAssertedPayload(payloadInput());
    const proof = await createManualNewsOwnerAssertedProof(
      proofInput(payload), verificationKeys(), responseKeys(),
    );

    await expect(isCurrentManualNewsOwnerAssertedProof(
      { ...proofInput(payload), payload: { ...payload, statement: '阿里发布通义千问新模型' } },
      proof, verificationKeys(), responseKeys(),
    )).resolves.toBe(false);
    await expect(isCurrentManualNewsOwnerAssertedProof(
      { ...proofInput(payload), lead_id: 'ml-20260904-000000000000' },
      proof, verificationKeys(), responseKeys(),
    )).resolves.toBe(false);
    // 投影里的空 url 是从线索的 input_url 推出来的:线索改了 url,快照就不再当前。
    await expect(isCurrentManualNewsOwnerAssertedProof(
      { ...proofInput(payload), input_url: 'https://openai.com/astra/' },
      proof, verificationKeys(), responseKeys(),
    )).resolves.toBe(false);
    await expect(isCurrentManualNewsOwnerAssertedProof(
      { ...proofInput(payload), assessment_version: 5_800_000 },
      proof, verificationKeys(), responseKeys(),
    )).resolves.toBe(false);
  });

  test('is not current under another verification key or a mismatched policy', async () => {
    const payload = await createManualNewsOwnerAssertedPayload(payloadInput());
    const proof = await createManualNewsOwnerAssertedProof(
      proofInput(payload), verificationKeys(), responseKeys(),
    );

    await expect(isCurrentManualNewsOwnerAssertedProof(
      proofInput(payload), proof,
      testManualNewsVerificationKeyring('b'.repeat(64)), responseKeys(),
    )).resolves.toBe(false);
    await expect(isCurrentManualNewsOwnerAssertedProof(
      proofInput(payload), { ...proof, policy_version: 'owner_vouched_v1' },
      verificationKeys(), responseKeys(),
    )).resolves.toBe(false);
  });

  test('rejects a payload whose key set drifted from the signed contract', async () => {
    const payload = await createManualNewsOwnerAssertedPayload(payloadInput());
    const extended = { ...payload, extra_field: 'x' } as unknown as typeof payload;

    await expect(createManualNewsOwnerAssertedProof(
      proofInput(extended), verificationKeys(), responseKeys(),
    )).rejects.toThrow('owner_asserted_payload_invalid');
    await expect(isCurrentManualNewsOwnerAssertedProof(
      proofInput(extended),
      await createManualNewsOwnerAssertedProof(proofInput(payload), verificationKeys(), responseKeys()),
      verificationKeys(), responseKeys(),
    )).resolves.toBe(false);
  });

  test('signs under its own hmac domain, not the owner vouch one', async () => {
    // 域串写错(比如复制担保模块时忘了改)不会让任何一条自洽性断言变红 —— 两条通道的
    // payload 形状本来就不同 —— 所以这里直接把摘要口径钉死在域串上。
    const payload = await createManualNewsOwnerAssertedPayload(payloadInput({ evidence: [evidence()] }));
    const proof = await createManualNewsOwnerAssertedProof(
      proofInput(payload), verificationKeys(), responseKeys(),
    );

    expect(proof.canonical_digest).toBe(
      await sha256Hex(`manual-news-owner-asserted-hmac-v1\0${canonicalJson(payload)}`),
    );
    expect(proof.hmac_sha256).not.toBe(proof.canonical_digest);
  });

  test('does not collide with an owner_vouched_v1 proof over the same statement', async () => {
    const payload = await createManualNewsOwnerAssertedPayload(payloadInput({ evidence: [evidence()] }));
    const proof = await createManualNewsOwnerAssertedProof(
      proofInput(payload), verificationKeys(), responseKeys(),
    );
    const { createManualNewsOwnerVouchPayload, createManualNewsOwnerVouchProof } =
      await import('./manual-news-owner-vouch');
    const vouchProof = await createManualNewsOwnerVouchProof({
      lead_id: LEAD_ID,
      assessment_version: 4_800_000,
      payload: await createManualNewsOwnerVouchPayload({
        lead: { id: LEAD_ID, review_date: '2026-09-04' },
        statement: STATEMENT,
        evidence: [evidence()],
        vouched_at: 1_757_000_000_000,
      }),
    }, verificationKeys(), responseKeys());

    expect(proof.canonical_digest).not.toBe(vouchProof.canonical_digest);
    expect(proof.hmac_sha256).not.toBe(vouchProof.hmac_sha256);
  });
});
