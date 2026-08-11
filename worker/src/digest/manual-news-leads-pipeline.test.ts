import { describe, expect, test } from 'vitest';

import {
  processManualNewsLead,
  type ManualLeadProcessingStore,
  type ManualNewsLeadRecord,
} from './manual-news-leads-pipeline';
import {
  createManualLeadVerificationMarker,
  validateManualLeadAssessment,
  type ManualNewsEvidence,
} from './manual-news-leads';
import type { PublicDocument } from '../security/safe-url-fetch';

function documentFixture(
  url: string,
  body: string,
  extraction: PublicDocument['extraction'] = 'html',
): PublicDocument {
  const bytes = new TextEncoder().encode(body).byteLength;
  const contentType = extraction === 'pdf_text' ? 'application/pdf' : 'text/html';
  const limits = {
    source_bytes: 8_388_608, extracted_text_bytes: 2_097_152, extracted_text_characters: 1_000_000,
  };
  return {
    url, content_type: contentType, extraction, body, redirects: 0, bytes,
    fetch_audit: {
      hops: [{ url, validated_ip: '93.184.216.34', connected_ip: '93.184.216.34' }],
      source_content_type: contentType,
      extraction,
      requested_limits: limits,
      applied_limits: limits,
      actual_sizes: {
        source_bytes: extraction === 'pdf_text' ? 48_000 : bytes,
        extracted_text_bytes: bytes,
        extracted_text_characters: Array.from(body).length,
      },
      truncation: { source: false, extracted_text: false },
      parser: { result: 'success', version: 'fixture-parser/1.0.0' },
    },
  };
}

function lead(overrides: Partial<ManualNewsLeadRecord> = {}): ManualNewsLeadRecord {
  return {
    id: 'ml-20260811-abc123',
    review_date: '2026-08-11',
    input_type: 'url',
    input_text: '',
    input_url: 'https://support.claude.com/example',
    note: '',
    status: 'submitted',
    version: 1,
    error_code: null,
    error_message: null,
    processing_owner: null,
    processing_attempt: 0,
    processing_lease_until: null,
    assessment: null,
    evidence: [],
    confirmed_batch_id: null,
    confirmed_at: null,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

function memoryStore(initial = lead()) {
  let current = structuredClone(initial);
  const transitions: string[] = [];
  let clearCalls = 0;
  const priorEvents: Array<{ event_key: string; review_date: string; lead_id: string }> = [];
  const store: ManualLeadProcessingStore = {
    async getLead() { return structuredClone(current); },
    async transition(_id, from, to, patch = {}) {
      expect(current.status).toBe(from);
      transitions.push(`${from}->${to}`);
      current = { ...current, ...patch, status: to, version: current.version + 1 };
      return structuredClone(current);
    },
    async replaceEvidence(_id, evidence) {
      current.evidence = structuredClone([...evidence]);
    },
    async listRecentPriorEvents() { return structuredClone(priorEvents); },
    async findPriorEventsByEventKey() { return structuredClone(priorEvents); },
    async saveAssessment(_id, assessment) { current.assessment = structuredClone(assessment); },
    async clearAssessment() { clearCalls += 1; current.assessment = null; },
  };
  return { store, transitions, current: () => current, priorEvents, clearCalls: () => clearCalls };
}

const officialEvidence: ManualNewsEvidence = {
  id: 'ev-official',
  url: 'https://support.claude.com/example',
  source_type: 'official_help',
  publisher: 'Anthropic',
  published_at: null,
  retrieved_at: 2,
  title: 'How Claude marks AI-generated content',
  excerpt: 'Only supported models and products are covered.',
  claims_supported: ['Supported text may carry an invisible watermark.'],
  reliable: true,
};

function assessed(overrides = {}) {
  return {
    title: 'Anthropic披露部分Claude输出的水印与来源标记',
    summary: '官方文档把范围限定在受支持的模型和产品。',
    event_key: 'anthropic-output-provenance-2026-08',
    event_type: 'product_documentation',
    material_update: false,
    score: 82,
    recommendation: 'recommended',
    occurred_at: '2026-08-10T00:00:00.000Z',
    uncertainties: ['并非所有Claude输出均适用。'],
    claims: [{
      text: 'Anthropic官方文档披露部分受支持Claude输出的水印与来源标记，范围限定在受支持的模型和产品。',
      evidence_ids: ['ev-official'],
    }],
    matched_event_key: null,
    ...overrides,
  };
}

function verified(
  candidate = assessed(),
  overrides: Record<string, unknown> = {},
) {
  const claims = candidate.claims as Array<{ evidence_ids: string[] }>;
  return {
    overall_verdict: 'supported',
    claim_results: claims.map((claim, claimIndex) => ({
      claim_index: claimIndex,
      supported: true,
      issue_code: 'none',
      evidence_ids: claim.evidence_ids,
    })),
    ...overrides,
  };
}

function verifiedFromPrompt(prompt: { user: string }) {
  const body = JSON.parse(prompt.user) as {
    untrusted_candidate: { claims: Array<{ evidence_ids: string[] }> };
  };
  return {
    overall_verdict: 'supported',
    claim_results: body.untrusted_candidate.claims.map((claim, claimIndex) => ({
      claim_index: claimIndex,
      supported: true,
      issue_code: 'none',
      evidence_ids: claim.evidence_ids,
    })),
  };
}

describe('manual lead processing pipeline', () => {
  test('moves through observable stages and produces an evidence-bounded recommendation', async () => {
    const memory = memoryStore();
    let verifyCalls = 0;
    await processManualNewsLead('ml-20260811-abc123', memory.store, {
      search: async () => [],
      fetch: async () => documentFixture(officialEvidence.url, '<p>doc</p>'),
      extract: async () => officialEvidence,
      assess: async () => assessed(),
      verify: async () => { verifyCalls += 1; return verified(); },
    });

    expect(memory.transitions).toEqual([
      'submitted->validating', 'validating->researching', 'researching->extracting',
      'extracting->verifying', 'verifying->clustering', 'clustering->scored',
      'scored->recommended',
    ]);
    expect(memory.current()).toMatchObject({ status: 'recommended' });
    expect(memory.current().assessment).toMatchObject({
      recommendation: 'recommended', evidence_tier: 'official_primary',
      verification: {
        policy_version: expect.any(String),
        digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(verifyCalls).toBe(1);
  });

  test.each([
    ['negation reversal', 'contradicted'],
    ['scope or time mismatch', 'scope_or_time_mismatch'],
    ['claim absent from evidence', 'not_found'],
  ])('clears and reviews a claim rejected for %s', async (_label, issueCode) => {
    const memory = memoryStore();
    let verifyCalls = 0;
    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => [],
      fetch: async () => documentFixture(officialEvidence.url, 'doc'),
      extract: async () => officialEvidence,
      assess: async () => assessed(),
      verify: async () => {
        verifyCalls += 1;
        return verified(assessed(), {
          overall_verdict: 'unsupported',
          claim_results: [{
            claim_index: 0, supported: false, issue_code: issueCode, evidence_ids: ['ev-official'],
          }],
        });
      },
    });

    expect(verifyCalls).toBe(1);
    expect(memory.clearCalls()).toBe(1);
    expect(memory.current()).toMatchObject({
      status: 'needs_review', error_code: 'claim_verification_failed',
      error_message: issueCode, assessment: null,
    });
  });

  test.each([
    ['missing claim result', { overall_verdict: 'supported', claim_results: [] }, 'invalid_claim_verification_coverage'],
    ['duplicate claim index', {
      overall_verdict: 'supported',
      claim_results: [
        { claim_index: 0, supported: true, issue_code: 'none', evidence_ids: ['ev-official'] },
        { claim_index: 0, supported: true, issue_code: 'none', evidence_ids: ['ev-official'] },
      ],
    }, 'invalid_claim_verification_coverage'],
    ['unknown evidence id', {
      overall_verdict: 'supported',
      claim_results: [{ claim_index: 0, supported: true, issue_code: 'none', evidence_ids: ['ev-unknown'] }],
    }, 'unknown_claim_verification_evidence_id'],
  ])('fails closed on verifier schema: %s', async (_label, verification, expectedMessage) => {
    const memory = memoryStore();
    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => [],
      fetch: async () => documentFixture(officialEvidence.url, 'doc'),
      extract: async () => officialEvidence,
      assess: async () => assessed(),
      verify: async () => verification,
    });

    expect(memory.clearCalls()).toBe(1);
    expect(memory.current()).toMatchObject({
      status: 'needs_review', error_code: 'claim_verification_failed',
      error_message: expectedMessage, assessment: null,
    });
  });

  test('rethrows transient verifier failure without saving an assessment', async () => {
    const memory = memoryStore();
    await expect(processManualNewsLead(memory.current().id, memory.store, {
      search: async () => [],
      fetch: async () => documentFixture(officialEvidence.url, 'doc'),
      extract: async () => officialEvidence,
      assess: async () => assessed(),
      verify: async () => { throw new Error('trusted_gateway_http_503'); },
    })).rejects.toThrow(/trusted_gateway_http_503/);

    expect(memory.current()).toMatchObject({ status: 'verifying', assessment: null });
  });

  test('moves parsed but schema-invalid output to review without persisting or retrying it', async () => {
    const memory = memoryStore();
    let calls = 0;
    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => [],
      fetch: async () => documentFixture(officialEvidence.url, '<p>doc</p>'),
      extract: async () => officialEvidence,
      assess: async () => {
        calls += 1;
        return assessed({ event_key: 'Anthropic 水印 2026' });
      },
      verify: async () => { throw new Error('unexpected_verify'); },
    });

    expect(calls).toBe(1);
    expect(memory.clearCalls()).toBe(1);
    expect(memory.current()).toMatchObject({
      status: 'needs_review',
      error_code: 'assessment_validation_failed',
      error_message: 'invalid_assessment_identity',
      assessment: null,
    });
  });

  test('does not promote an unsupported political claim and surfaces uncertainty', async () => {
    const memory = memoryStore(lead({
      input_url: 'https://www.sanders.senate.gov/example.pdf',
      input_text: '美国议员要求三家公司暂停AI研发',
      input_type: 'text_url',
    }));
    const letter = {
      ...officialEvidence,
      id: 'ev-letter',
      url: 'https://www.sanders.senate.gov/example.pdf',
      source_type: 'original_document' as const,
      publisher: 'Office of Senator Bernie Sanders',
    };
    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => [],
      fetch: async () => documentFixture(letter.url, 'letter', 'pdf_text'),
      extract: async () => letter,
      assess: async () => assessed({
        title: '美国参议员桑德斯呼吁三家AI公司暂停AI开发',
        summary: '这是单名参议员的请求，并非有约束力的国会命令。',
        event_key: 'sanders-ai-pause-letter-2026-08-10',
        event_type: 'political_regulatory',
        claims: [{ text: '这是一名参议员的请求。', evidence_ids: ['ev-letter'] }],
      }),
      verify: async (prompt) => verifiedFromPrompt(prompt),
    });
    expect(memory.current()).toMatchObject({ status: 'needs_review' });
    expect(memory.current().assessment).toMatchObject({ recommendation: 'needs_review', evidence_tier: 'insufficient' });
  });

  test.each([
    ['missing C2PA despite matching vendors', 'Anthropic Claude C2PA provenance watermark', '', 'Anthropic Claude availability update'],
    ['missing o3 product token', 'OpenAI 发布 o3 模型', '', 'OpenAI announces a model update'],
    ['does not match o3 to a longer product token', 'OpenAI 发布 o3 模型', '', 'OpenAI releases o3-mini'],
    ['missing numeric version', '豆包发布 2.1 版本', '', '豆包发布新版本'],
    ['does not match a numeric version to a suffixed token', '豆包发布 2.1 版本', '', '豆包发布 2.1-beta'],
    ['bounded GPT version mismatch', 'OpenAI 发布 GPT-5.6', '', 'OpenAI releases GPT-5.60'],
    ['does not match GPT version to a preview token', 'OpenAI 发布 GPT-5.6', '', 'OpenAI releases GPT-5.6-preview'],
  ])('preflights %s before calling the model', async (_label, inputText, note, evidenceText) => {
    const evidence = {
      ...officialEvidence,
      title: evidenceText,
      excerpt: evidenceText,
      claims_supported: [evidenceText],
    };
    const memory = memoryStore(lead({
      status: 'verifying', input_type: 'text', input_text: inputText, input_url: '', note, evidence: [evidence],
    }));
    let assessCalls = 0;
    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => { throw new Error('unexpected_search'); },
      fetch: async () => { throw new Error('unexpected_fetch'); },
      extract: async () => { throw new Error('unexpected_extract'); },
      assess: async () => { assessCalls += 1; return assessed(); },
      verify: async () => { throw new Error('unexpected_verify'); },
    });

    expect(assessCalls).toBe(0);
    expect(memory.current()).toMatchObject({
      status: 'needs_review',
      error_code: 'evidence_relevance_unverified',
      error_message: 'high_confidence_anchor_missing',
      assessment: null,
    });
  });

  test.each([
    ['removes URL tokens', '线索见 https://example.com/GPT-5.6/details', '', 'Unrelated report'],
    ['matches anchors case-insensitively', 'c2pa 来源标记', '', 'The C2PA provenance standard'],
    ['allows pure Chinese without a hard anchor', '生成内容附带来源水印', '', 'Unrelated background report'],
    ['does not hard-gate a proper-case entity alone', 'Claude 发布水印能力', '', 'Unrelated background report'],
    ['ignores note-only anchors', 'Anthropic给生成内容附带水印', '务必核实 C2PA', 'Anthropic background report'],
    ['accepts an exact bounded version', 'OpenAI 发布 GPT-5.6', '', 'OpenAI releases gpt-5.6'],
    ['does not hard-gate ordinary English synonyms', 'invisible hidden watermark support', '', 'A provenance feature report'],
  ])('allows model assessment when preflight %s', async (_label, inputText, note, evidenceText) => {
    const evidence = {
      ...officialEvidence,
      title: evidenceText,
      excerpt: evidenceText,
      claims_supported: [evidenceText],
    };
    const memory = memoryStore(lead({
      status: 'verifying', input_type: 'text', input_text: inputText, input_url: '', note, evidence: [evidence],
    }));
    let assessCalls = 0;
    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => { throw new Error('unexpected_search'); },
      fetch: async () => { throw new Error('unexpected_fetch'); },
      extract: async () => { throw new Error('unexpected_extract'); },
      assess: async () => { assessCalls += 1; return assessed(); },
      verify: async (prompt) => verifiedFromPrompt(prompt),
    });

    expect(assessCalls).toBe(1);
    expect(memory.current().assessment).not.toBeNull();
  });

  test('marks same-event cross-day evidence as duplicate unless it is a material update', async () => {
    const memory = memoryStore();
    memory.priorEvents.push({
      event_key: 'anthropic-output-provenance-2026-08', review_date: '2026-08-10', lead_id: 'old-lead',
    });
    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => [],
      fetch: async () => documentFixture(officialEvidence.url, 'doc'),
      extract: async () => officialEvidence,
      assess: async () => assessed(),
      verify: async (prompt) => verifiedFromPrompt(prompt),
    });
    expect(memory.current()).toMatchObject({ status: 'duplicate' });
    expect(memory.current().assessment).toMatchObject({ recommendation: 'duplicate', duplicate_scope: 'cross_day' });
  });

  test('treats model duplicate as advisory without an exact event match', async () => {
    const memory = memoryStore();
    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => [], fetch: async () => documentFixture(officialEvidence.url, 'doc'),
      extract: async () => officialEvidence,
      assess: async () => assessed({ recommendation: 'duplicate' }),
      verify: async (prompt) => verifiedFromPrompt(prompt),
    });
    expect(memory.current()).toMatchObject({ status: 'needs_review' });
    expect(memory.current().assessment).toMatchObject({
      recommendation: 'needs_review', duplicate_scope: null, matched_lead_id: null,
    });
  });

  test('an exact match with material_update true never terminates as duplicate', async () => {
    const memory = memoryStore();
    memory.priorEvents.push({
      event_key: 'anthropic-output-provenance-2026-08', review_date: '2026-08-10', lead_id: 'old-lead',
    });
    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => [], fetch: async () => documentFixture(officialEvidence.url, 'doc'),
      extract: async () => officialEvidence,
      assess: async () => assessed({
        material_update: true, recommendation: 'duplicate',
        matched_event_key: 'anthropic-output-provenance-2026-08',
      }),
      verify: async (prompt) => verifiedFromPrompt(prompt),
    });
    expect(memory.current().status).not.toBe('duplicate');
    expect(memory.current().assessment).toMatchObject({
      material_update: true, recommendation: 'needs_review', matched_lead_id: 'old-lead',
    });
  });

  test('normalizes an unmatched material update to needs_review', async () => {
    const memory = memoryStore();
    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => [], fetch: async () => documentFixture(officialEvidence.url, 'doc'),
      extract: async () => officialEvidence,
      assess: async () => assessed({ material_update: true }),
      verify: async (prompt) => verifiedFromPrompt(prompt),
    });
    expect(memory.current()).toMatchObject({ status: 'needs_review' });
    expect(memory.current().assessment).toMatchObject({ material_update: false, recommendation: 'needs_review' });
  });

  test('fails closed when model JSON cites unknown evidence', async () => {
    const memory = memoryStore();
    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => [],
      fetch: async () => documentFixture(officialEvidence.url, 'doc'),
      extract: async () => officialEvidence,
      assess: async () => assessed({ claims: [{ text: 'invented', evidence_ids: ['ev-missing'] }] }),
      verify: async () => { throw new Error('unexpected_verify'); },
    });
    expect(memory.current()).toMatchObject({
      status: 'needs_review', error_code: 'assessment_validation_failed',
      error_message: 'unknown_evidence_id', assessment: null,
    });
  });

  test('fails closed when matched_event_key is not present in bounded prior-event context', async () => {
    const memory = memoryStore();
    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => [],
      fetch: async () => documentFixture(officialEvidence.url, 'doc'),
      extract: async () => officialEvidence,
      assess: async () => assessed({ matched_event_key: 'invented-prior-event-2026-08' }),
      verify: async () => { throw new Error('unexpected_verify'); },
    });
    expect(memory.current()).toMatchObject({
      status: 'needs_review', error_code: 'assessment_validation_failed',
      error_message: 'unknown_matched_event_key', assessment: null,
    });
  });

  test('clears a legacy unmarked assessment and regenerates both passes in the same replay', async () => {
    const persisted = {
      ...assessed(),
      event_type: 'product_documentation' as const,
      recommendation: 'recommended' as const,
      evidence_tier: 'official_primary' as const,
    };
    const memory = memoryStore(lead({
      status: 'verifying', evidence: [officialEvidence], assessment: persisted as never,
    }));
    let assessCalls = 0;
    let verifyCalls = 0;
    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => { throw new Error('unexpected_search'); },
      fetch: async () => { throw new Error('unexpected_fetch'); },
      extract: async () => { throw new Error('unexpected_extract'); },
      assess: async () => { assessCalls += 1; return assessed(); },
      verify: async (prompt) => { verifyCalls += 1; return verifiedFromPrompt(prompt); },
    });

    expect(memory.clearCalls()).toBe(1);
    expect(assessCalls).toBe(1);
    expect(verifyCalls).toBe(1);
    expect(memory.transitions).toEqual(['verifying->clustering', 'clustering->scored', 'scored->recommended']);
    expect(memory.current()).toMatchObject({
      status: 'recommended',
      assessment: { verification: { policy_version: expect.any(String), digest: expect.any(String) } },
    });
  });

  test('clears a stale digest after an assessment summary change and regenerates in the same replay', async () => {
    const core = validateManualLeadAssessment(assessed(), [officialEvidence]);
    const marker = await createManualLeadVerificationMarker(core, [officialEvidence]);
    const memory = memoryStore(lead({
      status: 'verifying', evidence: [officialEvidence],
      assessment: {
        ...core,
        summary: '被修改过的摘要。',
        evidence_tier: 'official_primary',
        verification: marker,
      },
    }));
    let assessCalls = 0;
    let verifyCalls = 0;
    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => { throw new Error('unexpected_search'); },
      fetch: async () => { throw new Error('unexpected_fetch'); },
      extract: async () => { throw new Error('unexpected_extract'); },
      assess: async () => { assessCalls += 1; return assessed(); },
      verify: async (prompt) => { verifyCalls += 1; return verifiedFromPrompt(prompt); },
    });

    expect(memory.clearCalls()).toBe(1);
    expect(assessCalls).toBe(1);
    expect(verifyCalls).toBe(1);
    expect(memory.current()).toMatchObject({ status: 'recommended' });
  });

  test('clears a persisted assessment that fails strict evidence revalidation and regenerates it', async () => {
    const invalidPersisted = {
      ...assessed({ claims: [{ text: '旧事实。', evidence_ids: ['ev-removed'] }] }),
      event_type: 'product_documentation' as const,
      recommendation: 'recommended' as const,
      evidence_tier: 'official_primary' as const,
      verification: { policy_version: 'claim-evidence-v1', digest: '0'.repeat(64) },
    };
    const memory = memoryStore(lead({
      status: 'verifying', evidence: [officialEvidence], assessment: invalidPersisted as never,
    }));
    let assessCalls = 0;
    let verifyCalls = 0;
    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => { throw new Error('unexpected_search'); },
      fetch: async () => { throw new Error('unexpected_fetch'); },
      extract: async () => { throw new Error('unexpected_extract'); },
      assess: async () => { assessCalls += 1; return assessed(); },
      verify: async (prompt) => { verifyCalls += 1; return verifiedFromPrompt(prompt); },
    });

    expect(memory.clearCalls()).toBe(1);
    expect(assessCalls).toBe(1);
    expect(verifyCalls).toBe(1);
    expect(memory.current()).toMatchObject({ status: 'recommended' });
  });

  test('reuses only a current marker and skips both model passes', async () => {
    const core = validateManualLeadAssessment(assessed(), [officialEvidence]);
    const marker = await createManualLeadVerificationMarker(core, [officialEvidence]);
    const memory = memoryStore(lead({
      status: 'verifying', evidence: [officialEvidence],
      assessment: { ...core, evidence_tier: 'official_primary', verification: marker },
    }));
    let assessCalls = 0;
    let verifyCalls = 0;
    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => { throw new Error('unexpected_search'); },
      fetch: async () => { throw new Error('unexpected_fetch'); },
      extract: async () => { throw new Error('unexpected_extract'); },
      assess: async () => { assessCalls += 1; return assessed(); },
      verify: async (prompt) => { verifyCalls += 1; return verifiedFromPrompt(prompt); },
    });

    expect(memory.clearCalls()).toBe(0);
    expect(assessCalls).toBe(0);
    expect(verifyCalls).toBe(0);
    expect(memory.current()).toMatchObject({ status: 'recommended' });
  });

  test('runs anchor preflight before marker reuse and clears a now-irrelevant assessment', async () => {
    const core = validateManualLeadAssessment(assessed(), [officialEvidence]);
    const marker = await createManualLeadVerificationMarker(core, [officialEvidence]);
    const memory = memoryStore(lead({
      status: 'verifying', input_type: 'text', input_text: 'Anthropic Claude C2PA', input_url: '',
      evidence: [officialEvidence],
      assessment: { ...core, evidence_tier: 'official_primary', verification: marker },
    }));
    let modelCalls = 0;
    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => { throw new Error('unexpected_search'); },
      fetch: async () => { throw new Error('unexpected_fetch'); },
      extract: async () => { throw new Error('unexpected_extract'); },
      assess: async () => { modelCalls += 1; return assessed(); },
      verify: async () => { modelCalls += 1; return verified(); },
    });

    expect(modelCalls).toBe(0);
    expect(memory.clearCalls()).toBe(1);
    expect(memory.current()).toMatchObject({
      status: 'needs_review', error_code: 'evidence_relevance_unverified', assessment: null,
    });
  });

  test('propagates assessment cleanup failure before changing status or regenerating', async () => {
    const persisted = {
      ...assessed(), event_type: 'product_documentation' as const,
      recommendation: 'recommended' as const, evidence_tier: 'official_primary' as const,
    };
    const memory = memoryStore(lead({
      status: 'verifying', evidence: [officialEvidence], assessment: persisted as never,
    }));
    memory.store.clearAssessment = async () => { throw new Error('D1_clear_failure'); };
    let modelCalls = 0;

    await expect(processManualNewsLead(memory.current().id, memory.store, {
      search: async () => { throw new Error('unexpected_search'); },
      fetch: async () => { throw new Error('unexpected_fetch'); },
      extract: async () => { throw new Error('unexpected_extract'); },
      assess: async () => { modelCalls += 1; return assessed(); },
      verify: async () => { modelCalls += 1; return verified(); },
    })).rejects.toThrow(/D1_clear_failure/);

    expect(modelCalls).toBe(0);
    expect(memory.current()).toMatchObject({ status: 'verifying', assessment: expect.any(Object) });
  });

  test('resumes safely from an intermediate extracting state after a durable workflow retry', async () => {
    const memory = memoryStore(lead({ status: 'extracting', version: 4 }));
    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => [],
      fetch: async () => documentFixture(officialEvidence.url, 'doc'),
      extract: async () => officialEvidence,
      assess: async () => assessed(),
      verify: async (prompt) => verifiedFromPrompt(prompt),
    });

    expect(memory.transitions).toEqual([
      'extracting->verifying', 'verifying->clustering', 'clustering->scored', 'scored->recommended',
    ]);
    expect(memory.current()).toMatchObject({ status: 'recommended' });
  });

  test.each([
    ['search timeout', () => ({ search: async () => { throw new Error('gateway_timeout'); } })],
    ['model gateway failure', () => ({ assess: async () => { throw new Error('trusted_gateway_http_503'); } })],
  ])('throws transient %s without terminalizing the intermediate row', async (_label, override) => {
    const memory = memoryStore();
    const adapters = {
      search: async () => [], fetch: async () => documentFixture(officialEvidence.url, 'doc'),
      extract: async () => officialEvidence, assess: async () => assessed(),
      verify: async (prompt: { user: string }) => verifiedFromPrompt(prompt),
      ...override(),
    };
    if (_label === 'search timeout') {
      memory.current().input_type = 'text';
      memory.current().input_text = 'Anthropic 水印';
      memory.current().input_url = '';
    }
    await expect(processManualNewsLead(memory.current().id, memory.store, adapters))
      .rejects.toThrow(/gateway_timeout|trusted_gateway_http_503/);
    expect(memory.current().status).not.toBe('failed');
    expect(['researching', 'verifying']).toContain(memory.current().status);
  });
});
