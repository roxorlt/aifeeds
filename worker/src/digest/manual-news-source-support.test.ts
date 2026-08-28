import { describe, expect, test } from 'vitest';

import {
  buildManualNewsSourceSupportSelectionPrompt,
  buildManualNewsSourceSupportVerificationPrompt,
  createManualNewsSourceSupportPayload,
  createManualNewsSourceSupportProof,
  deriveAutomaticManualEventIdentityV1,
  deriveManualEventIdentityV1,
  isCurrentManualNewsSourceSupportProof,
  mergeAuthorizedManualNewsCandidates,
  validateManualNewsSourceSupportSelection,
  validateManualNewsSourceSupportVerification,
  type ManualNewsEvidence,
  type ManualNewsSourceSupportPayload,
} from './manual-news-leads';
import {
  testManualNewsResponseKeyring,
  testManualNewsVerificationKeyring,
  withSignedArticleTextV2Audit,
} from './manual-news-signed-evidence.test-fixture';

const verificationSecret = 'a'.repeat(64);
const fact = 'Anthropic 开放 Model Hardware Standard（MHS）研究预览。';
const excerpt = 'Anthropic is opening a research preview of the Model Hardware Standard (MHS), '
  + 'a shared specification for AI agents to safely operate physical devices, '
  + 'to a first group of scientific research labs and advanced manufacturers.';

function evidence(overrides: Partial<ManualNewsEvidence> = {}): ManualNewsEvidence {
  return withSignedArticleTextV2Audit({
    id: 'ev-anthropic-mhs',
    url: 'https://www.anthropic.com/news/model-hardware-standard-research-preview',
    source_type: 'official_primary',
    publisher: 'Anthropic',
    published_at: '2026-08-28T00:00:00.000Z',
    retrieved_at: 1_777_000_000_000,
    title: 'Previewing the Model Hardware Standard \\ Anthropic',
    excerpt,
    claims_supported: [excerpt],
    reliable: true,
    ...overrides,
  });
}

async function payload(): Promise<ManualNewsSourceSupportPayload> {
  const selection = validateManualNewsSourceSupportSelection(
    { evidence_id: 'ev-anthropic-mhs', quote: excerpt },
    { fact, evidence: [evidence()] },
  );
  const verification = validateManualNewsSourceSupportVerification(
    { supported: true, evidence_id: 'ev-anthropic-mhs' }, selection,
  );
  return createManualNewsSourceSupportPayload({
    lead: {
      id: 'ml-20260828-mhs', review_date: '2026-08-28', input_type: 'text_url',
      input_text: fact,
      input_url: 'https://www.anthropic.com/news/model-hardware-standard-research-preview',
      note: '',
    },
    authorization: {
      audit_id: 41,
      candidate_authorization: 'source_support_v1',
      submit_identity_digest: '1'.repeat(64),
      idempotency_key: 'submit-mhs',
    },
    evidence: [evidence()],
    selection,
    verification,
  });
}

describe('manual news source_support_v1', () => {
  test('derives one strict MHS preview identity locally and keeps preview distinct', async () => {
    const identity = await deriveManualEventIdentityV1(fact);
    expect(identity).toMatchObject({
      contract: 'mnev1',
      slots: {
        actor: 'anthropic', action: 'preview', object: 'mhs',
        versions: [], event_times: [], polarity: 'positive', modality: 'ongoing',
      },
    });
    expect(identity.event_key).toMatch(/^mnev1:[a-f0-9]{64}$/);
    await expect(deriveManualEventIdentityV1('Anthropic 发布 MHS。'))
      .resolves.not.toMatchObject({ event_key: identity.event_key });
    await expect(deriveManualEventIdentityV1('Anthropic 开放 MHS。'))
      .resolves.not.toMatchObject({ event_key: identity.event_key });
  });

  test('projects only a complete high-confidence automatic fingerprint into the same canonical tuple', async () => {
    const manual = await deriveManualEventIdentityV1(fact);
    const automatic = await deriveAutomaticManualEventIdentityV1({
      event_type: 'research_result',
      primary_actor: 'Anthropic',
      primary_object: 'Model Hardware Standard (MHS)',
      object_family: '',
      object_variant: '',
      object_version: '',
      action: 'preview',
      canonical_event: 'Anthropic MHS research preview',
      confidence: 0.98,
    });
    expect(automatic?.event_key).toBe(manual.event_key);
    await expect(deriveAutomaticManualEventIdentityV1({
      event_type: 'product_launch', primary_actor: 'Anthropic',
      primary_object: 'MHS', object_family: '', object_variant: '', object_version: '',
      action: 'launch', canonical_event: 'Anthropic launches MHS', confidence: 0.98,
    })).resolves.not.toMatchObject({ event_key: manual.event_key });
    await expect(deriveAutomaticManualEventIdentityV1({
      event_type: 'research_result', primary_actor: 'Anthropic',
      primary_object: 'MHS', action: 'preview', confidence: 0.4,
    })).resolves.toBeNull();
    await expect(deriveAutomaticManualEventIdentityV1({
      event_type: 'research_result', primary_actor: 'Anthropic',
      primary_object: 'Model Hardware Standard (MHS)', object_family: '',
      object_variant: 'Enterprise', object_version: '', action: 'preview',
      canonical_event: 'Anthropic MHS research preview', confidence: 0.98,
    })).resolves.toBeNull();
    await expect(deriveAutomaticManualEventIdentityV1({
      event_type: 'product_launch', primary_actor: 'Anthropic',
      primary_object: 'Model Hardware Standard (MHS)', object_family: '',
      object_variant: '', object_version: '', action: 'preview',
      canonical_event: 'Anthropic releases MHS', confidence: 0.98,
    })).resolves.toBeNull();
  });

  test('keeps automatic order, sorts manual suffix by authorization, and replaces same-event in place', () => {
    const automatic = Array.from({ length: 10 }, (_, index) => ({
      item_id: `auto-${index + 1}`, title: `自动${index + 1}`, summary: '摘要', source: '来源',
      score: 100 - index, event_key: `event-${index + 1}`,
    }));
    const merged = mergeAuthorizedManualNewsCandidates({
      previous_candidates: automatic,
      previous_default_selected_ids: automatic.slice(0, 5).map((item) => item.item_id),
      published_selected_ids: automatic.slice(0, 5).map((item) => item.item_id),
      manual_candidates: [
        {
          authorization_order: 20,
          candidate: {
            item_id: 'blog:manual:b', title: 'B', summary: 'B', source: 'Anthropic', score: null,
            event_key: 'manual-b', origin: 'manual_lead', lead_id: 'b',
          },
        },
        {
          authorization_order: 10,
          candidate: {
            item_id: 'blog:manual:a', title: 'A', summary: 'A', source: 'Anthropic', score: null,
            event_key: 'event-4', origin: 'manual_lead', lead_id: 'a',
          },
        },
      ],
    });
    expect(merged.candidates.map((item) => item.item_id)).toEqual([
      'auto-1', 'auto-2', 'auto-3', 'blog:manual:a', 'auto-5', 'auto-6', 'auto-7', 'auto-8',
      'auto-9', 'auto-10', 'blog:manual:b',
    ]);
    expect(merged.default_selected_ids).toEqual([
      'auto-1', 'auto-2', 'auto-3', 'blog:manual:a', 'auto-5',
    ]);
    expect(merged.published_selected_ids).toEqual(merged.default_selected_ids);
    expect(merged.event_aliases).toEqual({ 'auto-4': 'blog:manual:a' });
    expect(merged.enqueue_rerender).toBe(false);
  });

  test.each([
    'Anthropic 未开放 Model Hardware Standard（MHS）研究预览。',
    'Anthropic 计划开放 Model Hardware Standard（MHS）研究预览。',
    'Anthropic 开放 Model Hardware Standard（MHS）研究预览并发布 Gemini。',
    'Google 开放 Model Hardware Standard（MHS）研究预览。',
    'Anthropic 开放 Unknown Hardware Standard 研究预览。',
  ])('fails closed for ambiguous, weak, compound, or unsupported fact: %s', async (value) => {
    await expect(deriveManualEventIdentityV1(value)).rejects.toThrow(/manual_event_identity_invalid/);
  });

  test('uses exact-schema prompts containing only the fact and signed excerpts', () => {
    const selection = buildManualNewsSourceSupportSelectionPrompt({ fact, evidence: [evidence()] });
    const selectionBody = JSON.parse(selection.user);
    expect(selection.system).toContain('evidence_id');
    expect(selection.system).toContain('quote');
    expect(selectionBody).toEqual({
      fact,
      untrusted_evidence: [{ evidence_id: 'ev-anthropic-mhs', excerpt }],
    });
    expect(selection.user).not.toContain('Previewing the Model Hardware Standard');

    const verification = buildManualNewsSourceSupportVerificationPrompt({
      fact,
      evidence: [evidence()],
      selection: { evidence_id: 'ev-anthropic-mhs', quote: excerpt },
    });
    expect(JSON.parse(verification.user)).toEqual({
      fact,
      selected_evidence: { evidence_id: 'ev-anthropic-mhs', excerpt, quote: excerpt },
    });
  });

  test('accepts only one reliable signed-prefix exact quote and a matching independent verdict', () => {
    const selected = validateManualNewsSourceSupportSelection(
      { evidence_id: 'ev-anthropic-mhs', quote: excerpt },
      { fact, evidence: [evidence()] },
    );
    expect(selected).toEqual({ evidence_id: 'ev-anthropic-mhs', quote: excerpt });
    expect(validateManualNewsSourceSupportVerification(
      { supported: true, evidence_id: 'ev-anthropic-mhs' }, selected,
    )).toEqual({ supported: true, evidence_id: 'ev-anthropic-mhs' });

    expect(() => validateManualNewsSourceSupportSelection(
      { evidence_id: 'ev-anthropic-mhs', quote: 'Model Hardware Standard' },
      { fact, evidence: [evidence({ reliable: false })] },
    )).toThrow(/source_support_evidence_invalid/);
    expect(() => validateManualNewsSourceSupportVerification(
      { supported: true, evidence_id: 'another-evidence' }, selected,
    )).toThrow(/source_support_verification_invalid/);
  });

  test.each([
    ['title text is not evidence', 'Previewing the Model Hardware Standard \\ Anthropic'],
    ['body tail outside the prefix is not evidence', 'Anthropic later made the preview generally available.'],
    ['unrelated excerpt is not support', 'Anthropic published a safety policy for Claude.'],
    ['zero-width quote is rejected', `Anthropic\u200bis opening a research preview of the Model Hardware Standard (MHS)`],
    ['bidi quote is rejected', `Anthropic\u202e is opening a research preview of the Model Hardware Standard (MHS)`],
  ])('rejects %s', (_label, quote) => {
    expect(() => validateManualNewsSourceSupportSelection(
      { evidence_id: 'ev-anthropic-mhs', quote }, { fact, evidence: [evidence()] },
    )).toThrow(/source_support_(?:quote|fact|evidence)_invalid/);
  });

  test('normalizes NFC and whitespace but still requires a contiguous excerpt substring', () => {
    const spacedExcerpt = excerpt.replace('is opening', 'is   opening');
    const signed = evidence({ excerpt: spacedExcerpt, claims_supported: [spacedExcerpt] });
    expect(validateManualNewsSourceSupportSelection(
      { evidence_id: signed.id, quote: excerpt }, { fact, evidence: [signed] },
    ).quote).toBe(excerpt);
    expect(() => validateManualNewsSourceSupportSelection(
      { evidence_id: signed.id, quote: 'Anthropic opening Model Hardware Standard (MHS)' },
      { fact, evidence: [signed] },
    )).toThrow(/source_support_quote_invalid/);
  });

  test('binds authorization, input, signed evidence, quote, identity, and item projection to a new HMAC domain', async () => {
    const value = await payload();
    const proof = await createManualNewsSourceSupportProof(
      { lead_id: 'ml-20260828-mhs', assessment_version: 7, payload: value },
      testManualNewsVerificationKeyring(verificationSecret),
      testManualNewsResponseKeyring(),
    );
    expect(proof).toMatchObject({ policy_version: 'source_support_v1' });
    await expect(isCurrentManualNewsSourceSupportProof(
      { lead_id: 'ml-20260828-mhs', assessment_version: 7, payload: value },
      proof,
      testManualNewsVerificationKeyring(verificationSecret),
      testManualNewsResponseKeyring(),
    )).resolves.toBe(true);

    for (const changed of [
      { ...value, selection: { ...value.selection, quote: `${value.selection.quote} altered` } },
      { ...value, authorization: { ...value.authorization, audit_id: 42 } },
      { ...value, item_projection: { ...value.item_projection, title: 'tampered' } },
      { ...value, event_identity: { ...value.event_identity, event_key: `mnev1:${'0'.repeat(64)}` } },
    ]) {
      await expect(isCurrentManualNewsSourceSupportProof(
        { lead_id: 'ml-20260828-mhs', assessment_version: 7, payload: changed },
        proof,
        testManualNewsVerificationKeyring(verificationSecret),
        testManualNewsResponseKeyring(),
      )).resolves.toBe(false);
    }
  });
});
