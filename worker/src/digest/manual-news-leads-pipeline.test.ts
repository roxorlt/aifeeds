import { describe, expect, test } from 'vitest';

import {
  processManualNewsLead,
  type ManualLeadProcessingStore,
  type ManualNewsLeadRecord,
} from './manual-news-leads-pipeline';
import {
  applyManualLeadEvidencePolicy,
  validateManualLeadAssessment,
  type ManualNewsEvidence,
  type ManualLeadPriorEvent,
  type ManualNewsProcessedAssessment,
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
  let invalidateCalls = 0;
  const priorEvents: ManualLeadPriorEvent[] = [];
  const store: ManualLeadProcessingStore = {
    async getLead() { return structuredClone(current); },
    async hasPersistedAssessment() { return !!current.assessment; },
    async transition(_id, from, to, patch = {}) {
      expect(current.status).toBe(from);
      transitions.push(`${from}->${to}`);
      current = { ...current, ...patch, status: to, version: current.version + 1 };
      return structuredClone(current);
    },
    async replaceEvidence(_id, expectedVersion, evidence) {
      expect(current.version).toBe(expectedVersion);
      current.evidence = structuredClone([...evidence]);
    },
    async listRecentPriorEvents() { return structuredClone(priorEvents); },
    async findPriorEventsByEventKey() { return structuredClone(priorEvents); },
    async saveVerifiedAssessment(_id, expectedVersion, assessment) {
      expect(current.version).toBe(expectedVersion);
      current.assessment = structuredClone(assessment);
      return { assessment_version: expectedVersion };
    },
    async invalidateAssessment(_id, expectedVersion) {
      expect(current.version).toBe(expectedVersion);
      invalidateCalls += 1;
      current.assessment = null;
    },
  };
  return { store, transitions, current: () => current, priorEvents, invalidateCalls: () => invalidateCalls };
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
  claims_supported: [
    'On 2026-08-10, Anthropic Claude supported output provenance documentation covers watermark features for supported models and products.',
  ],
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
    occurred_at: '2026-08-10',
    uncertainties: ['并非所有Claude输出均适用。'],
    claims: [{
      text: 'Anthropic官方文档披露部分受支持Claude输出的水印与来源标记，范围限定在受支持的模型和产品。',
      evidence_ids: ['ev-official'],
    }],
    matched_event_key: null,
    ...overrides,
  };
}

function verifiedPriorEvent(): ManualLeadPriorEvent {
  return {
    event_key: 'anthropic-output-provenance-2026-08',
    review_date: '2026-08-10',
    lead_id: 'old-lead',
    verification_digest: 'a'.repeat(64),
    title: '此前Claude输出来源标记文档',
    summary: '此前文档覆盖受支持产品。',
    claims: [{ text: '此前文档覆盖受支持产品。', evidence_ids: ['ev-old'] }],
  };
}

function verifiedFromPrompt(prompt: { user: string }) {
  const body = JSON.parse(prompt.user) as {
    facts: Array<{
      fact_id: string;
      untrusted_candidate_value: string | boolean;
      untrusted_prior_events?: Array<{ event_key: string }>;
      allowed_evidence: Array<{ id: string; title: string; excerpt: string; claims_supported: string[] }>;
    }>;
  };
  return {
    overall_verdict: 'supported',
    fact_results: body.facts.map((fact) => ({
      fact_id: fact.fact_id,
      supported: true,
      issue_code: 'none',
      source_quotes: [{
        evidence_id: fact.allowed_evidence[0].id,
        quote: fact.allowed_evidence[0].claims_supported[0],
      }],
      ...(fact.fact_id === 'field:material_update' ? {
        comparison_result: {
          value: fact.untrusted_candidate_value,
          matched_event_key: fact.untrusted_prior_events?.[0]?.event_key || null,
          prior_event_keys: fact.untrusted_prior_events?.map((event) => event.event_key) || [],
          reason_code: fact.untrusted_prior_events?.length
            ? (fact.untrusted_candidate_value ? 'material_change' : 'no_material_change')
            : 'no_prior_match',
          current_evidence_id: fact.allowed_evidence[0].id,
          current_quote: fact.allowed_evidence[0].claims_supported[0],
        },
      } : {}),
    })),
  };
}

function processed(overrides: Record<string, unknown> = {}): ManualNewsProcessedAssessment {
  const core = applyManualLeadEvidencePolicy(validateManualLeadAssessment(assessed(), [officialEvidence]), [officialEvidence]);
  return { ...core, duplicate_scope: null, matched_lead_id: null, ...overrides } as ManualNewsProcessedAssessment;
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
      verify: async (prompt) => { verifyCalls += 1; return verifiedFromPrompt(prompt); },
    });

    expect(memory.transitions).toEqual([
      'submitted->validating', 'validating->researching', 'researching->extracting',
      'extracting->verifying', 'verifying->clustering', 'clustering->scored',
      'scored->recommended',
    ]);
    expect(memory.current()).toMatchObject({ status: 'recommended' });
    expect(memory.current().assessment).toMatchObject({
      recommendation: 'recommended', evidence_tier: 'official_primary',
      duplicate_scope: null, matched_lead_id: null,
    });
    expect(verifyCalls).toBe(1);
  });

  test.each([
    ['title negation reversal', 'field:title', 'contradicted'],
    ['summary scope or time mismatch', 'field:summary', 'scope_or_time_mismatch'],
    ['event identity absent from evidence', 'field:event_key', 'not_found'],
    ['claim unsupported', 'claim:0', 'unsupported'],
  ])('invalidates and reviews a factual field rejected for %s', async (_label, factId, issueCode) => {
    const memory = memoryStore();
    let verifyCalls = 0;
    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => [],
      fetch: async () => documentFixture(officialEvidence.url, 'doc'),
      extract: async () => officialEvidence,
      assess: async () => assessed(),
      verify: async (prompt) => {
        verifyCalls += 1;
        const result = verifiedFromPrompt(prompt);
        return {
          ...result,
          overall_verdict: 'unsupported',
          fact_results: result.fact_results.map((fact) => fact.fact_id === factId
            ? { ...fact, supported: false, issue_code: issueCode }
            : fact),
        };
      },
    });

    expect(verifyCalls).toBe(1);
    expect(memory.invalidateCalls()).toBe(1);
    expect(memory.current()).toMatchObject({
      status: 'needs_review', error_code: 'fact_verification_failed',
      error_message: issueCode, assessment: null,
    });
  });

  test.each([
    ['missing fact result', (result: ReturnType<typeof verifiedFromPrompt>) => ({
      ...result, fact_results: result.fact_results.slice(1),
    }), 'invalid_fact_verification_coverage'],
    ['duplicate fact id', (result: ReturnType<typeof verifiedFromPrompt>) => ({
      ...result, fact_results: [...result.fact_results, result.fact_results[0]],
    }), 'invalid_fact_verification_coverage'],
    ['unknown evidence id', (result: ReturnType<typeof verifiedFromPrompt>) => ({
      ...result,
      fact_results: result.fact_results.map((fact, index) => index === 0
        ? { ...fact, source_quotes: [{ evidence_id: 'ev-unknown', quote: 'unknown' }] }
        : fact),
    }), 'unknown_fact_verification_evidence_id'],
  ])('fails closed on verifier schema: %s', async (_label, mutate, expectedMessage) => {
    const memory = memoryStore();
    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => [],
      fetch: async () => documentFixture(officialEvidence.url, 'doc'),
      extract: async () => officialEvidence,
      assess: async () => assessed(),
      verify: async (prompt) => mutate(verifiedFromPrompt(prompt)),
    });

    expect(memory.invalidateCalls()).toBe(1);
    expect(memory.current()).toMatchObject({
      status: 'needs_review', error_code: 'fact_verification_failed',
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

  test('routes exhausted verifier JSON parsing to review instead of Workflow retry', async () => {
    const memory = memoryStore();
    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => [],
      fetch: async () => documentFixture(officialEvidence.url, 'doc'),
      extract: async () => officialEvidence,
      assess: async () => assessed(),
      verify: async () => { throw new Error('json_parse_fail'); },
    });

    expect(memory.current()).toMatchObject({
      status: 'needs_review', assessment: null,
      error_code: 'fact_verification_failed', error_message: 'invalid_fact_verification',
    });
  });

  test('routes exhausted assessment JSON parsing to review instead of Workflow retry', async () => {
    const memory = memoryStore();
    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => [],
      fetch: async () => documentFixture(officialEvidence.url, 'doc'),
      extract: async () => officialEvidence,
      assess: async () => { throw new Error('json_parse_fail'); },
      verify: async () => { throw new Error('unexpected_verify'); },
    });

    expect(memory.current()).toMatchObject({
      status: 'needs_review', assessment: null,
      error_code: 'assessment_validation_failed', error_message: 'invalid_assessment',
    });
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
    expect(memory.invalidateCalls()).toBe(1);
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
    expect(memory.current()).toMatchObject({
      status: 'needs_review',
      assessment: null,
      error_code: 'fact_verification_failed',
    });
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
    let verifyCalls = 0;
    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => { throw new Error('unexpected_search'); },
      fetch: async () => { throw new Error('unexpected_fetch'); },
      extract: async () => { throw new Error('unexpected_extract'); },
      assess: async () => { assessCalls += 1; return assessed(); },
      verify: async (prompt) => { verifyCalls += 1; return verifiedFromPrompt(prompt); },
    });

    expect(assessCalls).toBe(1);
    expect(verifyCalls).toBe(1);
    expect(memory.current().error_code).not.toBe('evidence_relevance_unverified');
  });

  test('marks same-event cross-day evidence as duplicate unless it is a material update', async () => {
    const memory = memoryStore();
    memory.priorEvents.push(verifiedPriorEvent());
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
    memory.priorEvents.push(verifiedPriorEvent());
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

  test('invalidates an exposed malformed assessment and regenerates both passes in the same replay', async () => {
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

    expect(memory.invalidateCalls()).toBe(1);
    expect(assessCalls).toBe(1);
    expect(verifyCalls).toBe(1);
    expect(memory.transitions).toEqual(['verifying->clustering', 'clustering->scored', 'scored->recommended']);
    expect(memory.current()).toMatchObject({
      status: 'recommended',
      assessment: { duplicate_scope: null, matched_lead_id: null },
    });
  });

  test('reuses an active store-verified assessment and skips both model passes', async () => {
    const memory = memoryStore(lead({
      status: 'verifying', evidence: [officialEvidence],
      assessment: processed(),
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

    expect(memory.invalidateCalls()).toBe(0);
    expect(assessCalls).toBe(0);
    expect(verifyCalls).toBe(0);
    expect(memory.current()).toMatchObject({ status: 'recommended' });
  });

  test('replays a verified all-history event match outside the bounded recent-event prompt window', async () => {
    const memory = memoryStore(lead({
      status: 'verifying', evidence: [officialEvidence],
      assessment: processed({
        material_update: true,
        matched_event_key: assessed().event_key,
        matched_lead_id: 'old-lead-outside-recent-window',
      }),
    }));
    let modelCalls = 0;

    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => { throw new Error('unexpected_search'); },
      fetch: async () => { throw new Error('unexpected_fetch'); },
      extract: async () => { throw new Error('unexpected_extract'); },
      assess: async () => { modelCalls += 1; return assessed(); },
      verify: async (prompt) => { modelCalls += 1; return verifiedFromPrompt(prompt); },
    });

    expect(modelCalls).toBe(0);
    expect(memory.invalidateCalls()).toBe(0);
    expect(memory.current()).toMatchObject({ status: 'recommended' });
  });

  test('clears a persisted assessment that fails strict evidence revalidation and regenerates it', async () => {
    const invalidPersisted = {
      ...assessed({ claims: [{ text: '旧事实。', evidence_ids: ['ev-removed'] }] }),
      event_type: 'product_documentation' as const,
      recommendation: 'recommended' as const,
      evidence_tier: 'official_primary' as const,
      duplicate_scope: null,
      matched_lead_id: null,
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

    expect(memory.invalidateCalls()).toBe(1);
    expect(assessCalls).toBe(1);
    expect(verifyCalls).toBe(1);
    expect(memory.current()).toMatchObject({ status: 'recommended' });
  });

  test('runs anchor preflight before active assessment reuse and invalidates a now-irrelevant assessment', async () => {
    const memory = memoryStore(lead({
      status: 'verifying', input_type: 'text', input_text: 'Anthropic Claude C2PA', input_url: '',
      evidence: [officialEvidence],
      assessment: processed(),
    }));
    let modelCalls = 0;
    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => { throw new Error('unexpected_search'); },
      fetch: async () => { throw new Error('unexpected_fetch'); },
      extract: async () => { throw new Error('unexpected_extract'); },
      assess: async () => { modelCalls += 1; return assessed(); },
      verify: async (prompt) => { modelCalls += 1; return verifiedFromPrompt(prompt); },
    });

    expect(modelCalls).toBe(0);
    expect(memory.invalidateCalls()).toBe(1);
    expect(memory.current()).toMatchObject({
      status: 'needs_review', error_code: 'evidence_relevance_unverified', assessment: null,
    });
  });

  test('invalidates an active assessment when its persisted evidence is missing', async () => {
    const memory = memoryStore(lead({
      status: 'verifying', evidence: [], assessment: processed(),
    }));

    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => { throw new Error('unexpected_search'); },
      fetch: async () => { throw new Error('unexpected_fetch'); },
      extract: async () => { throw new Error('unexpected_extract'); },
      assess: async () => { throw new Error('unexpected_assess'); },
      verify: async () => { throw new Error('unexpected_verify'); },
    });

    expect(memory.invalidateCalls()).toBe(1);
    expect(memory.current()).toMatchObject({
      status: 'needs_review', error_code: 'evidence_insufficient', assessment: null,
    });
  });

  test('propagates assessment invalidation failure before changing status or regenerating', async () => {
    const persisted = processed({ claims: [{ text: '旧事实。', evidence_ids: ['ev-removed'] }] });
    const memory = memoryStore(lead({
      status: 'verifying', evidence: [officialEvidence], assessment: persisted as never,
    }));
    memory.store.invalidateAssessment = async () => { throw new Error('D1_invalidate_failure'); };
    let modelCalls = 0;

    await expect(processManualNewsLead(memory.current().id, memory.store, {
      search: async () => { throw new Error('unexpected_search'); },
      fetch: async () => { throw new Error('unexpected_fetch'); },
      extract: async () => { throw new Error('unexpected_extract'); },
      assess: async () => { modelCalls += 1; return assessed(); },
      verify: async (prompt) => { modelCalls += 1; return verifiedFromPrompt(prompt); },
    })).rejects.toThrow(/D1_invalidate_failure/);

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
