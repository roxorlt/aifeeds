import { describe, expect, test } from 'vitest';

import { normalizeFeedEventFingerprint } from '../feeds/classify-translate';

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
const firstPersonExcerpt = 'We’re opening a research preview of the Model Hardware Standard (MHS), '
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

function firstPersonEvidence(overrides: Partial<ManualNewsEvidence> = {}): ManualNewsEvidence {
  return evidence({
    publisher: 'anthropic.com',
    excerpt: firstPersonExcerpt,
    ...overrides,
  });
}

async function firstPersonPayload(rawExcerpt = firstPersonExcerpt): Promise<ManualNewsSourceSupportPayload> {
  const signedEvidence = firstPersonEvidence({ excerpt: rawExcerpt });
  const selection = validateManualNewsSourceSupportSelection(
    { evidence_id: signedEvidence.id, quote: rawExcerpt },
    { fact, evidence: [signedEvidence] },
  );
  const verification = validateManualNewsSourceSupportVerification(
    { supported: true, evidence_id: signedEvidence.id }, selection,
  );
  return createManualNewsSourceSupportPayload({
    lead: {
      id: 'ml-20260828-mhs-first-person', review_date: '2026-08-28', input_type: 'text_url',
      input_text: fact, input_url: signedEvidence.url, note: '',
    },
    authorization: {
      audit_id: 42,
      candidate_authorization: 'source_support_v1',
      submit_identity_digest: '2'.repeat(64),
      idempotency_key: 'submit-mhs-first-person',
    },
    evidence: [signedEvidence], selection, verification,
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
  test('accepts the raw Anthropic first-person production excerpt and binds it byte-for-byte', async () => {
    const signedEvidence = firstPersonEvidence();
    const selection = validateManualNewsSourceSupportSelection(
      { evidence_id: signedEvidence.id, quote: firstPersonExcerpt },
      { fact, evidence: [signedEvidence] },
    );
    expect(selection).toEqual({ evidence_id: signedEvidence.id, quote: firstPersonExcerpt });

    const curlyPayload = await firstPersonPayload();
    expect(JSON.stringify(curlyPayload)).not.toContain('official_primary_first_person_actor_v1');
    expect(JSON.stringify(curlyPayload)).not.toContain('verification_quote');
    const curlyProof = await createManualNewsSourceSupportProof(
      { lead_id: 'ml-20260828-mhs-first-person', assessment_version: 7, payload: curlyPayload },
      testManualNewsVerificationKeyring(verificationSecret), testManualNewsResponseKeyring(),
    );
    await expect(isCurrentManualNewsSourceSupportProof(
      { lead_id: 'ml-20260828-mhs-first-person', assessment_version: 7, payload: curlyPayload },
      curlyProof,
      testManualNewsVerificationKeyring(verificationSecret), testManualNewsResponseKeyring(),
    )).resolves.toBe(true);

    const asciiExcerpt = firstPersonExcerpt.replace('We’re', "We're");
    const asciiPayload = await firstPersonPayload(asciiExcerpt);
    const asciiProof = await createManualNewsSourceSupportProof(
      { lead_id: 'ml-20260828-mhs-first-person', assessment_version: 7, payload: asciiPayload },
      testManualNewsVerificationKeyring(verificationSecret), testManualNewsResponseKeyring(),
    );
    expect(asciiProof.canonical_digest).not.toBe(curlyProof.canonical_digest);
    await expect(isCurrentManualNewsSourceSupportProof(
      {
        lead_id: 'ml-20260828-mhs-first-person', assessment_version: 7,
        payload: { ...curlyPayload, selection: asciiPayload.selection },
      },
      curlyProof,
      testManualNewsVerificationKeyring(verificationSecret), testManualNewsResponseKeyring(),
    )).resolves.toBe(false);
  });

  test.each([
    firstPersonExcerpt,
    firstPersonExcerpt.replace('We’re', "We're"),
    firstPersonExcerpt.replace('We’re', 'We are'),
  ])('accepts only an enumerated first-person opening prefix: %s', (rawExcerpt) => {
    const signedEvidence = firstPersonEvidence({ excerpt: ` \t\r\n${rawExcerpt}` });
    const selection = validateManualNewsSourceSupportSelection(
      { evidence_id: signedEvidence.id, quote: rawExcerpt },
      { fact, evidence: [signedEvidence] },
    );
    expect(selection).toEqual({ evidence_id: signedEvidence.id, quote: rawExcerpt });
    const prompt = buildManualNewsSourceSupportVerificationPrompt({
      fact, evidence: [signedEvidence], selection,
    });
    expect(JSON.parse(prompt.user).selected_evidence).toMatchObject({
      excerpt: ` \t\r\n${rawExcerpt}`,
      quote: rawExcerpt,
      verification_quote: rawExcerpt.replace(
        /^(?:We’re|We're|We are) opening a research preview of /u,
        'Anthropic is opening a research preview of ',
      ),
      binding_contract: 'official_primary_first_person_actor_v1',
    });
  });

  test('gives the second verifier raw production evidence plus the indivisible actor-binding view', () => {
    const signedEvidence = firstPersonEvidence();
    const selection = validateManualNewsSourceSupportSelection(
      { evidence_id: signedEvidence.id, quote: firstPersonExcerpt },
      { fact, evidence: [signedEvidence] },
    );
    const prompt = buildManualNewsSourceSupportVerificationPrompt({
      fact, evidence: [signedEvidence], selection,
    });
    expect(prompt.system).toContain('official_primary_first_person_actor_v1');
    expect(prompt.system).toContain('不得因该绑定自动判 true');
    expect(prompt.system).toContain('第二动作');
    expect(JSON.parse(prompt.user)).toEqual({
      fact,
      selected_evidence: {
        evidence_id: signedEvidence.id,
        excerpt: firstPersonExcerpt,
        quote: firstPersonExcerpt,
        verification_quote: excerpt,
        binding_contract: 'official_primary_first_person_actor_v1',
      },
    });
  });

  test.each([
    [
      'whitespace folding cannot create a quote match',
      firstPersonExcerpt.replace('We’re opening', 'We’re  opening'),
      firstPersonExcerpt,
    ],
    [
      'NFC composition cannot create a quote match',
      excerpt.replace('specification', 'spe\u0301cification'),
      excerpt.replace('specification', 'spécification'),
    ],
  ])('requires a raw code-unit substring: %s', (_label, rawExcerpt, rawQuote) => {
    const signedEvidence = firstPersonEvidence({ excerpt: rawExcerpt });
    expect(() => validateManualNewsSourceSupportSelection(
      { evidence_id: signedEvidence.id, quote: rawQuote },
      { fact, evidence: [signedEvidence] },
    )).toThrow(/source_support_quote_invalid/);
  });

  test.each([
    ['bare domain', { url: 'https://anthropic.com/news/model-hardware-standard-research-preview' }],
    ['other subdomain', { url: 'https://evil.www.anthropic.com/news/model-hardware-standard-research-preview' }],
    ['suffix deception', { url: 'https://www.anthropic.com.evil/news/model-hardware-standard-research-preview' }],
    ['userinfo', { url: 'https://user:pass@www.anthropic.com/news/model-hardware-standard-research-preview' }],
    ['port', { url: 'https://www.anthropic.com:8443/news/model-hardware-standard-research-preview' }],
    ['trailing dot', { url: 'https://www.anthropic.com./news/model-hardware-standard-research-preview' }],
    ['IDN host', { url: 'https://www.anthrοpic.com/news/model-hardware-standard-research-preview' }],
    ['http', { url: 'http://www.anthropic.com/news/model-hardware-standard-research-preview' }],
    ['wrong path', { url: 'https://www.anthropic.com/news/model-hardware-standard' }],
    ['query', { url: 'https://www.anthropic.com/news/model-hardware-standard-research-preview?ref=test' }],
    ['hash', { url: 'https://www.anthropic.com/news/model-hardware-standard-research-preview#intro' }],
    ['wrong publisher', { publisher: 'Anthropic' }],
    ['unsafe publisher', { publisher: 'anthropic.com\u061c' }],
    ['secondary evidence', { source_type: 'independent_media' as const }],
    ['unreliable evidence', { reliable: false }],
  ])('rejects first-person evidence with invalid official binding: %s', (_label, overrides) => {
    const signedEvidence = firstPersonEvidence(overrides);
    expect(() => validateManualNewsSourceSupportSelection(
      { evidence_id: signedEvidence.id, quote: firstPersonExcerpt },
      { fact, evidence: [signedEvidence] },
    )).toThrow();
    expect(() => buildManualNewsSourceSupportVerificationPrompt({
      fact,
      evidence: [signedEvidence],
      selection: { evidence_id: signedEvidence.id, quote: firstPersonExcerpt },
    })).toThrow();
  });

  test.each([
    `Partner says, “${firstPersonExcerpt}”`,
    `“${firstPersonExcerpt}”`,
    `—${firstPersonExcerpt}`,
    `\u00a0${firstPersonExcerpt}`,
    `Earlier context. ${firstPersonExcerpt}`,
  ])('rejects an internal or non-ASCII-leading first-person quote: %s', (rawExcerpt) => {
    const signedEvidence = firstPersonEvidence({ excerpt: rawExcerpt });
    expect(() => validateManualNewsSourceSupportSelection(
      { evidence_id: signedEvidence.id, quote: firstPersonExcerpt },
      { fact, evidence: [signedEvidence] },
    )).toThrow();
    expect(() => buildManualNewsSourceSupportVerificationPrompt({
      fact,
      evidence: [signedEvidence],
      selection: { evidence_id: signedEvidence.id, quote: firstPersonExcerpt },
    })).toThrow();
  });

  test.each([
    'We plan to open a research preview of the Model Hardware Standard (MHS).',
    'We intend to open a research preview of the Model Hardware Standard (MHS).',
    'We will open a research preview of the Model Hardware Standard (MHS).',
    'We may open a research preview of the Model Hardware Standard (MHS).',
    'We’re not opening a research preview of the Model Hardware Standard (MHS).',
    'We’re opening access to the Model Hardware Standard (MHS).',
    'We’re releasing the Model Hardware Standard (MHS).',
  ])('does not reinterpret non-preview first-person semantics: %s', (rawExcerpt) => {
    const signedEvidence = firstPersonEvidence({ excerpt: rawExcerpt });
    expect(() => validateManualNewsSourceSupportSelection(
      { evidence_id: signedEvidence.id, quote: rawExcerpt },
      { fact, evidence: [signedEvidence] },
    )).toThrow();
    expect(() => buildManualNewsSourceSupportVerificationPrompt({
      fact,
      evidence: [signedEvidence],
      selection: { evidence_id: signedEvidence.id, quote: rawExcerpt },
    })).toThrow();
  });

  test('keeps actor, object, atomicity, bidi, and zero-width gates after first-person binding', () => {
    const signedEvidence = firstPersonEvidence();
    for (const unsupportedFact of [
      'Google 开放 Model Hardware Standard（MHS）研究预览。',
      'Anthropic 开放 Claude 研究预览。',
    ]) {
      expect(() => validateManualNewsSourceSupportSelection(
        { evidence_id: signedEvidence.id, quote: firstPersonExcerpt },
        { fact: unsupportedFact, evidence: [signedEvidence] },
      )).toThrow();
      expect(() => buildManualNewsSourceSupportVerificationPrompt({
        fact: unsupportedFact,
        evidence: [signedEvidence],
        selection: { evidence_id: signedEvidence.id, quote: firstPersonExcerpt },
      })).toThrow();
    }
    for (const rawExcerpt of [
      `${firstPersonExcerpt.slice(0, -1)}, and we also release Claude.`,
      firstPersonExcerpt.replace('We’re', 'We\u202ere'),
      firstPersonExcerpt.replace('We’re', 'We\u200bre'),
    ]) {
      const unsafeEvidence = firstPersonEvidence({ excerpt: rawExcerpt });
      expect(() => validateManualNewsSourceSupportSelection(
        { evidence_id: unsafeEvidence.id, quote: rawExcerpt },
        { fact, evidence: [unsafeEvidence] },
      )).toThrow();
      expect(() => buildManualNewsSourceSupportVerificationPrompt({
        fact,
        evidence: [unsafeEvidence],
        selection: { evidence_id: unsafeEvidence.id, quote: rawExcerpt },
      })).toThrow();
    }
  });

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
    const realAutomatic = normalizeFeedEventFingerprint({
      event_type: 'research_result',
      primary_actor: 'Anthropic',
      primary_object: 'Model Hardware Standard (MHS)',
      object_family: '',
      object_variant: '',
      object_version: '',
      action: 'other',
      canonical_event: 'Anthropic MHS research preview',
      confidence: 0.98,
    });
    expect(realAutomatic).not.toBeNull();
    const automatic = await deriveAutomaticManualEventIdentityV1(realAutomatic);
    expect(automatic?.event_key).toBe(manual.event_key);

    const release = normalizeFeedEventFingerprint({
      event_type: 'product_launch', primary_actor: 'Anthropic',
      primary_object: 'MHS', object_family: '', object_variant: '', object_version: '',
      action: 'launch', canonical_event: 'Anthropic launches MHS', confidence: 0.98,
    });
    await expect(deriveAutomaticManualEventIdentityV1(release))
      .resolves.not.toMatchObject({ event_key: manual.event_key });
    const openAccess = normalizeFeedEventFingerprint({
      event_type: 'policy_access', primary_actor: 'Anthropic',
      primary_object: 'MHS', object_family: '', object_variant: '', object_version: '',
      action: 'other', canonical_event: 'Anthropic opens access to MHS', confidence: 0.98,
    });
    await expect(deriveAutomaticManualEventIdentityV1(openAccess)).resolves.toBeNull();
    const lowConfidence = normalizeFeedEventFingerprint({
      event_type: 'research_result', primary_actor: 'Anthropic',
      primary_object: 'MHS', object_family: '', object_variant: '', object_version: '',
      action: 'other', canonical_event: 'Anthropic MHS research preview', confidence: 0.4,
    });
    await expect(deriveAutomaticManualEventIdentityV1(lowConfidence)).resolves.toBeNull();
    const wrongActor = normalizeFeedEventFingerprint({
      event_type: 'research_result', primary_actor: 'Google',
      primary_object: 'MHS', object_family: '', object_variant: '', object_version: '',
      action: 'other', canonical_event: 'Google MHS research preview', confidence: 0.98,
    });
    await expect(deriveAutomaticManualEventIdentityV1(wrongActor)).resolves.toBeNull();
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

  test('rejects U+061C across fact, signed excerpt, quote, and automatic fingerprint fields', async () => {
    await expect(deriveManualEventIdentityV1(
      `Anthropic\u061c 开放 Model Hardware Standard（MHS）研究预览。`,
    )).rejects.toThrow(/source_support_fact_invalid/);

    const bidiExcerpt = `${excerpt}\u061c`;
    const signed = evidence({ excerpt: bidiExcerpt, claims_supported: [bidiExcerpt] });
    expect(() => validateManualNewsSourceSupportSelection(
      { evidence_id: signed.id, quote: excerpt }, { fact, evidence: [signed] },
    )).toThrow(/source_support_quote_invalid/);
    expect(() => validateManualNewsSourceSupportSelection(
      { evidence_id: 'ev-anthropic-mhs', quote: `${excerpt}\u061c` },
      { fact, evidence: [evidence()] },
    )).toThrow(/source_support_quote_invalid/);

    const automatic = normalizeFeedEventFingerprint({
      event_type: 'research_result', primary_actor: 'Anthropic', primary_object: 'MHS',
      object_family: '', object_variant: '', object_version: '', action: 'other',
      canonical_event: `Anthropic MHS research preview\u061c`, confidence: 0.98,
    });
    await expect(deriveAutomaticManualEventIdentityV1(automatic)).resolves.toBeNull();
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
    expect(verification).toEqual({
      system: '独立判断 selected_evidence.quote 是否在同一原子关系、主体、动作、对象、极性、模态和时间上支持 fact。只输出且必须输出精确 JSON {"supported":true|false,"evidence_id":"..."}；evidence_id 必须保持不变。',
      user: JSON.stringify({
        fact,
        selected_evidence: { evidence_id: 'ev-anthropic-mhs', excerpt, quote: excerpt },
      }),
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

  test('does not use normalized whitespace to manufacture a contiguous excerpt substring', () => {
    const spacedExcerpt = excerpt.replace('is opening', 'is   opening');
    const signed = evidence({ excerpt: spacedExcerpt, claims_supported: [spacedExcerpt] });
    expect(() => validateManualNewsSourceSupportSelection(
      { evidence_id: signed.id, quote: excerpt }, { fact, evidence: [signed] },
    )).toThrow(/source_support_quote_invalid/);
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
