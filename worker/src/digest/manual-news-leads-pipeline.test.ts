import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  isTransientManualLeadError,
  processManualNewsLead,
  type ManualLeadProcessingStore,
  type ManualNewsLeadRecord,
} from './manual-news-leads-pipeline';
import {
  applyManualLeadEvidencePolicy,
  validateManualLeadGeneratedAssessment,
  MANUAL_LEAD_EDITORIAL_PROJECTION_CONTRACT,
  MANUAL_LEAD_EVIDENCE_DISPOSITION_CONTRACT,
  MANUAL_LEAD_GENERATED_CLAIM_CONTRACT,
  MANUAL_LEAD_SOURCE_FACT_CONTRACT,
  MANUAL_LEAD_VERIFICATION_POLICY_VERSION,
  type ManualNewsEvidence,
  type ManualLeadPriorEvent,
  type ManualNewsProcessedAssessment,
} from './manual-news-leads';
import type { DocumentFetchAudit, PublicDocument } from '../security/safe-url-fetch';
import { callDeepSeekJson, DEEPSEEK_PRO } from '../hf-paper/llm';
import { ManualNewsProviderError } from './manual-news-provider';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function documentFixture(
  url: string,
  body: string,
  extraction: DocumentFetchAudit['extraction'] = 'html',
): PublicDocument {
  const bytes = new TextEncoder().encode(body).byteLength;
  const contentType = extraction === 'pdf_text' ? 'application/pdf' : 'text/html';
  const limits = {
    source_bytes: 8_388_608, extracted_text_bytes: 2_097_152, extracted_text_characters: 1_000_000,
  };
  return {
    response_key_id: 'response-key-2026-08-11',
    url, content_type: contentType, extraction, excerpt: body, redirects: 0,
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
  let saveCalls = 0;
  let generationCycle: any = null;
  const transitionPatches: Array<Record<string, unknown>> = [];
  const priorEvents: ManualLeadPriorEvent[] = [];
  const store: ManualLeadProcessingStore = {
    async getLead() { return structuredClone(current); },
    async getPaidRetrievalEpoch() { return 0; },
    async hasPersistedAssessment() { return !!current.assessment; },
    async transition(_id, from, to, patch = {}) {
      expect(current.status).toBe(from);
      transitions.push(`${from}->${to}`);
      transitionPatches.push(structuredClone(patch as Record<string, unknown>));
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
      saveCalls += 1;
      current.assessment = structuredClone(assessment);
      return { assessment_version: expectedVersion };
    },
    async invalidateAssessment(_id, expectedVersion) {
      expect(current.version).toBe(expectedVersion);
      invalidateCalls += 1;
      current.assessment = null;
    },
    async beginAssessmentGenerationCycle(_id, expectedVersion) {
      expect(current.version).toBe(expectedVersion);
      if (!generationCycle) {
        generationCycle = {
          cycle_id: `memory-cycle-${expectedVersion}`, base_version: expectedVersion,
          generation_revision: 1, call_state: 'initial_started', acquired_call: true,
          regeneration_consumed: false,
        };
        return structuredClone(generationCycle);
      }
      return { ...structuredClone(generationCycle), acquired_call: false };
    },
    async recordAssessmentGenerationValidation(_id, expectedVersion, result) {
      expect(current.version).toBe(expectedVersion);
      generationCycle = {
        ...generationCycle,
        generation_revision: result.generation_revision,
        call_state: result.validation_code === 'valid'
          ? 'validated'
          : (result.generation_revision === 1 && result.regeneratable ? 'regeneration_ready' : 'terminal'),
        first_validation_code: generationCycle.first_validation_code || result.validation_code,
        first_validation_path: generationCycle.first_validation_path || result.validation_path,
        last_validation_code: result.validation_code,
        last_validation_path: result.validation_path,
        ...(result.validated_assessment ? { validated_assessment: structuredClone(result.validated_assessment) } : {}),
        ...(result.provider_failure ? { provider_failure: structuredClone(result.provider_failure) } : {}),
        acquired_call: false,
      };
      return structuredClone(generationCycle);
    },
    async consumeAssessmentRegeneration(_id, expectedVersion) {
      expect(current.version).toBe(expectedVersion);
      if (generationCycle.call_state !== 'regeneration_ready') {
        return { ...structuredClone(generationCycle), acquired_call: false };
      }
      generationCycle = {
        ...generationCycle, generation_revision: 2, call_state: 'regeneration_started',
        regeneration_consumed: true, acquired_call: true,
      };
      return structuredClone(generationCycle);
    },
  };
  return {
    store, transitions, transitionPatches, current: () => current, priorEvents,
    invalidateCalls: () => invalidateCalls, saveCalls: () => saveCalls,
  };
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
    'Anthropic documented Claude watermark provenance on 2026-08-10.',
  ],
  reliable: true,
};

const sourceSupportFact = 'Anthropic 开放 Model Hardware Standard（MHS）研究预览。';
const sourceSupportExcerpt = 'We’re opening a research preview of the Model Hardware Standard (MHS), '
  + 'a shared specification for AI agents to safely operate physical devices, '
  + 'to a first group of scientific research labs and advanced manufacturers.';
const sourceSupportEvidence: ManualNewsEvidence = {
  id: 'ev-anthropic-mhs',
  url: 'https://www.anthropic.com/news/model-hardware-standard-research-preview',
  source_type: 'official_primary',
  publisher: 'anthropic.com',
  published_at: '2026-08-28T00:00:00.000Z',
  retrieved_at: 1,
  title: 'Previewing the Model Hardware Standard \\ Anthropic',
  excerpt: sourceSupportExcerpt,
  claims_supported: [sourceSupportExcerpt],
  reliable: true,
};

const supportedAssessmentFact = officialEvidence.claims_supported[0];

const techCrunchAlibabaEvidence: ManualNewsEvidence = {
  id: 'ev-techcrunch-alibaba-ban',
  url: 'https://techcrunch.com/example/alibaba-claude-code-ban',
  source_type: 'independent_media',
  publisher: 'TechCrunch',
  published_at: '2026-08-11T01:00:00Z',
  retrieved_at: 2,
  title: 'Alibaba reportedly bans employees from using Claude Code',
  excerpt: 'Alibaba reportedly bans employees from using Claude Code.',
  claims_supported: ['Alibaba reportedly bans employees from using Claude Code.'],
  reliable: true,
};

const googleSheetsCanvasEvidence: ManualNewsEvidence = {
  id: 'ev-google-sheets-canvas-production',
  url: 'https://blog.google/products/workspace/build-mini-apps-gemini-sheets/',
  source_type: 'official_primary',
  publisher: 'Google Blog',
  published_at: null,
  retrieved_at: 2,
  title: 'Build mini-apps with Gemini in Google Sheets',
  excerpt: 'Google releases Sheets canvas feature in Google Sheets.',
  claims_supported: ['Google releases Sheets canvas feature in Google Sheets.'],
  reliable: true,
};

function assessed(overrides: Record<string, unknown> = {}) {
  const overrideClaims = Array.isArray(overrides.claims) ? overrides.claims : null;
  const baseFact = {
    subject: 'Anthropic', subject_role: 'organization', predicate: 'documented',
    object: 'Claude watermark provenance on 2026-08-10',
  };
  const sourceFacts = (overrideClaims || [{
    atomic_fact: baseFact, evidence_ids: ['ev-official'],
  }]).map((claim, index) => {
    const row = claim as { atomic_fact?: Record<string, unknown>; evidence_ids?: string[] };
    const atomic = row.atomic_fact;
    const subject = String(atomic?.subject || '');
    const subjectRole = atomic?.subject_role
      || (/参议员|法院|监管/u.test(subject) ? 'authority' : 'organization');
    return {
      fact_ref: `fact-${String(index + 1).padStart(2, '0')}`,
      source_language: /\p{Script=Han}/u.test(JSON.stringify(atomic)) ? 'zh' : 'en',
      ...(atomic ? { atomic_fact: { subject_role: subjectRole, ...atomic } } : {}),
      evidence_ids: row.evidence_ids,
      ...(!atomic ? claim as Record<string, unknown> : {}),
    };
  });
  const firstAtomic = sourceFacts[0]?.atomic_fact as Record<string, unknown> | undefined;
  const defaultProjection = overrideClaims && firstAtomic && /\p{Script=Han}/u.test(JSON.stringify(firstAtomic))
    ? firstAtomic
    : {
      subject: 'Anthropic', subject_role: 'organization', predicate: '已披露',
      object: '2026年8月10日的Claude水印来源信息',
    };
  const { claims: _claims, title: _title, summary: _summary, ...rest } = overrides;
  const dispositionIds = [...new Set(sourceFacts.flatMap((fact) => fact.evidence_ids || []))];
  return {
    event_key: 'anthropic-output-provenance-2026-08',
    event_type: 'product_documentation',
    material_update: false,
    score: 82,
    recommendation: 'recommended',
    occurred_at: '2026-08-10',
    uncertainties: ['并非所有Claude输出均适用。'],
    source_facts: sourceFacts,
    evidence_dispositions: dispositionIds.map((evidenceId) => ({
      evidence_id: evidenceId,
      disposition: 'supports_core',
      source_fact_refs: sourceFacts
        .filter((fact) => (fact.evidence_ids || []).includes(evidenceId))
        .map((fact) => fact.fact_ref),
      reason_code: null,
    })),
    editorial_projection: {
      title: { projection_ref: 'title-01', source_fact_refs: ['fact-01'], atomic_fact: defaultProjection },
      summary: [{ projection_ref: 'summary-01', source_fact_refs: ['fact-01'], atomic_fact: defaultProjection }],
    },
    matched_event_key: null,
    ...rest,
  };
}

function alibabaCoreAssessment(overrides: Record<string, unknown> = {}) {
  return {
    event_key: 'alibaba-claude-code-employee-ban-2026-08-11',
    event_type: 'industry_event',
    material_update: false,
    score: 88,
    recommendation: 'needs_review',
    occurred_at: null,
    uncertainties: [],
    source_facts: [{
      fact_ref: 'fact-01', source_language: 'en',
      atomic_fact: {
        subject: 'Alibaba', subject_role: 'organization',
        predicate: 'reportedly bans', object: 'employees from using Claude Code',
      },
      evidence_ids: [techCrunchAlibabaEvidence.id],
    }],
    evidence_dispositions: [{
      evidence_id: techCrunchAlibabaEvidence.id, disposition: 'supports_core',
      source_fact_refs: ['fact-01'], reason_code: null,
    }],
    editorial_projection: {
      title: {
        projection_ref: 'title-01', source_fact_refs: ['fact-01'],
        atomic_fact: {
          subject: '阿里巴巴', subject_role: 'organization',
          predicate: '据称禁止', object: '员工使用Claude Code',
        },
      },
      summary: [{
        projection_ref: 'summary-01', source_fact_refs: ['fact-01'],
        atomic_fact: {
          subject: '阿里巴巴', subject_role: 'organization',
          predicate: '据称禁止', object: '员工使用Claude Code',
        },
      }],
    },
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
    untrusted_evidence: Array<{ id: string; title: string; excerpt: string; claims_supported: string[] }>;
    facts: Array<{
      fact_id: string;
      untrusted_candidate_value: string | boolean;
      untrusted_prior_events?: Array<{ event_key: string }>;
      allowed_evidence_ids: string[];
    }>;
    projections?: Array<{ projection_id: string; source_fact_ids: string[] }>;
    evidence_dispositions?: Array<{ evidence_id: string; disposition: string }>;
  };
  const evidenceById = new Map(body.untrusted_evidence.map((item) => [item.id, item]));
  const hasConflict = body.evidence_dispositions?.some((item) =>
    item.disposition === 'contradicts_core' || item.disposition === 'material_update') || false;
  return {
    overall_verdict: hasConflict ? 'conflicted' : 'supported',
    fact_results: body.facts.map((fact) => {
      const evidence = evidenceById.get(fact.allowed_evidence_ids[0])!;
      const quote = evidence.claims_supported[0] || evidence.excerpt || evidence.title;
      return {
      fact_id: fact.fact_id,
      supported: true,
      issue_code: 'none',
      source_quotes: [{
        evidence_id: evidence.id,
        quote,
      }],
      ...(fact.fact_id === 'field:material_update' ? {
        comparison_result: {
          value: fact.untrusted_candidate_value,
          matched_event_key: fact.untrusted_prior_events?.[0]?.event_key || null,
          prior_event_keys: fact.untrusted_prior_events?.map((event) => event.event_key) || [],
          reason_code: fact.untrusted_prior_events?.length
            ? (fact.untrusted_candidate_value ? 'material_change' : 'no_material_change')
            : 'no_prior_match',
          current_evidence_id: evidence.id,
          current_quote: quote,
        },
      } : {}),
    };
    }),
    ...(body.projections?.length ? {
      projection_results: body.projections.map((projection) => ({
        projection_id: projection.projection_id,
        source_fact_ids: projection.source_fact_ids,
        supported: true,
        issue_code: 'none',
      })),
    } : {}),
    ...(body.evidence_dispositions?.length ? {
      disposition_results: body.evidence_dispositions.map((disposition) => {
        const evidence = evidenceById.get(disposition.evidence_id)!;
        const quote = evidence.claims_supported[0] || evidence.excerpt || evidence.title;
        return {
          evidence_id: disposition.evidence_id,
          disposition: disposition.disposition,
          supported: true,
          issue_code: 'none',
          source_quotes: [{ evidence_id: disposition.evidence_id, quote }],
        };
      }),
    } : {}),
  };
}

function processed(overrides: Record<string, unknown> = {}): ManualNewsProcessedAssessment {
  const core = applyManualLeadEvidencePolicy(
    validateManualLeadGeneratedAssessment(assessed(), [officialEvidence]),
    [officialEvidence],
  );
  return { ...core, duplicate_scope: null, matched_lead_id: null, ...overrides } as ManualNewsProcessedAssessment;
}

function deepSeekJsonResponse(value: unknown): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: typeof value === 'string' ? value : JSON.stringify(value) } }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

async function assessThroughRealDeepSeekJson(): Promise<unknown> {
  const result = await callDeepSeekJson<unknown>('test-key', DEEPSEEK_PRO, '{}', {
    retries: 0, timeoutMs: 1_000, systemPrompt: 'test-contract',
  });
  if (!result.data) throw new Error(result.error || 'empty_model_assessment');
  return result.data;
}

describe('manual lead processing pipeline', () => {
  test('moves through observable stages and produces an evidence-bounded recommendation', async () => {
    const memory = memoryStore();
    let verifyCalls = 0;
    const modelContexts: unknown[] = [];
    await processManualNewsLead('ml-20260811-abc123', memory.store, {
      search: async () => [],
      fetch: async () => documentFixture(officialEvidence.url, '<p>doc</p>'),
      extract: async () => officialEvidence,
      assess: async (_prompt, context) => { modelContexts.push(context); return assessed(); },
      verify: async (prompt, context) => {
        verifyCalls += 1;
        modelContexts.push(context);
        return verifiedFromPrompt(prompt);
      },
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
    expect(modelContexts).toEqual([
      {
        request_id: 'ml-20260811-abc123:p0:assessment:1',
        evidence_count: 1,
        attempt: 0,
      },
      {
        request_id: 'ml-20260811-abc123:p0:verification:2',
        evidence_count: 1,
        attempt: 0,
      },
    ]);
  });

  test('processes a URL-only TechCrunch Alibaba Claude Code restriction as one atomic fact row', async () => {
    const memory = memoryStore(lead({
      input_url: techCrunchAlibabaEvidence.url,
      input_text: '',
      input_type: 'url',
    }));
    let assessCalls = 0;
    let verifyCalls = 0;
    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => [],
      fetch: async () => documentFixture(techCrunchAlibabaEvidence.url, '<title>Alibaba reportedly bans employees from using Claude Code</title>'),
      extract: async () => techCrunchAlibabaEvidence,
      assess: async () => {
        assessCalls += 1;
        return {
          event_key: 'alibaba-claude-code-employee-ban-2026-08-11',
          event_type: 'industry_event', material_update: false, score: 88,
          recommendation: 'recommended', occurred_at: null,
          uncertainties: ['TechCrunch is the only currently collected source.'],
          source_facts: [{
            fact_ref: 'fact-01', source_language: 'en',
            atomic_fact: {
              subject: 'Alibaba', subject_role: 'organization', predicate: 'reportedly bans',
              object: 'employees from using Claude Code',
            },
            evidence_ids: [techCrunchAlibabaEvidence.id],
          }],
          evidence_dispositions: [{
            evidence_id: techCrunchAlibabaEvidence.id, disposition: 'supports_core',
            source_fact_refs: ['fact-01'], reason_code: null,
          }],
          editorial_projection: {
            title: {
              projection_ref: 'title-01', source_fact_refs: ['fact-01'],
              atomic_fact: {
                subject: '阿里巴巴', subject_role: 'organization',
                predicate: '据称禁止', object: '员工使用Claude Code',
              },
            },
            summary: [{
              projection_ref: 'summary-01', source_fact_refs: ['fact-01'],
              atomic_fact: {
                subject: '阿里巴巴', subject_role: 'organization',
                predicate: '据称禁止', object: '员工使用Claude Code',
              },
            }],
          },
          matched_event_key: null,
        };
      },
      verify: async (prompt) => {
        verifyCalls += 1;
        return verifiedFromPrompt(prompt);
      },
    });

    expect(assessCalls).toBe(1);
    expect(verifyCalls).toBe(1);
    expect(memory.saveCalls()).toBe(1);
    expect(memory.current()).toMatchObject({
      status: 'needs_review',
      assessment: {
        title: '阿里巴巴据称禁止员工使用Claude Code。',
        summary: '阿里巴巴据称禁止员工使用Claude Code。',
        claims: [{
          text: 'Alibaba reportedly bans employees from using Claude Code.',
          evidence_ids: [techCrunchAlibabaEvidence.id],
        }],
        source_fact_contract: MANUAL_LEAD_SOURCE_FACT_CONTRACT,
        editorial_projection_contract: MANUAL_LEAD_EDITORIAL_PROJECTION_CONTRACT,
      },
    });
    expect(memory.transitionPatches).toContainEqual(expect.objectContaining({
      audit_metadata: expect.objectContaining({
        assessment_generation_attempts: 1,
        assessment_last_validation_code: 'valid',
        assessment_claim_contract: MANUAL_LEAD_GENERATED_CLAIM_CONTRACT,
      }),
    }));
  });

  test.each([
    ['title negation reversal', 'projection:title-01', 'unsupported'],
    ['summary scope or time mismatch', 'projection:summary-01', 'unsupported'],
    ['event identity absent from evidence', 'field:event_key', 'not_found'],
    ['source fact unsupported', 'source_fact', 'unsupported'],
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
        if (factId.startsWith('projection:')) {
          const projectionId = factId.slice('projection:'.length);
          return {
            ...result,
            overall_verdict: 'unsupported',
            projection_results: result.projection_results?.map((projection) => projection.projection_id === projectionId
              ? { ...projection, supported: false, issue_code: 'translation_mismatch' }
              : projection),
          };
        }
        return {
          ...result,
          overall_verdict: 'unsupported',
          fact_results: result.fact_results.map((fact) => (fact.fact_id === factId
            || (factId === 'source_fact' && fact.fact_id.startsWith('source-')))
            ? { ...fact, supported: false, issue_code: issueCode }
            : fact),
          ...(factId === 'source_fact' ? {
            projection_results: result.projection_results?.map((projection) => ({
              ...projection, supported: false, issue_code: 'fact_omission',
            })),
          } : {}),
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
      error_code: 'fact_verification_failed',
      error_message: 'manual_news_provider_error:verification:provider_json_parse_fail',
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
      error_code: 'assessment_validation_failed',
      error_message: 'manual_news_provider_error:assessment:provider_json_parse_fail',
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

    expect(calls).toBe(2);
    expect(memory.invalidateCalls()).toBe(1);
    expect(memory.current()).toMatchObject({
      status: 'needs_review',
      error_code: 'assessment_validation_failed',
      error_message: 'invalid_assessment_identity',
      assessment: null,
    });
  });

  test('regenerates once after an unknown evidence id and verifies only the valid replacement', async () => {
    const memory = memoryStore();
    const prompts: Array<{ system: string; user: string }> = [];
    let assessCalls = 0;
    let verifyCalls = 0;
    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => [], fetch: async () => documentFixture(officialEvidence.url, 'doc'),
      extract: async () => officialEvidence,
      assess: async (prompt) => {
        prompts.push(prompt);
        assessCalls += 1;
        return assessCalls === 1
          ? assessed({ claims: [{
            atomic_fact: {
              subject: 'Anthropic', predicate: 'documented',
              object: 'Claude watermark provenance on 2026-08-10',
            },
            evidence_ids: ['ev-missing'],
          }] })
          : assessed();
      },
      verify: async (prompt) => { verifyCalls += 1; return verifiedFromPrompt(prompt); },
    });

    expect(assessCalls).toBe(2);
    expect(verifyCalls).toBe(1);
    expect(memory.saveCalls()).toBe(1);
    expect(memory.current()).toMatchObject({ status: 'recommended', assessment: { score: 82 } });
    const regeneration = JSON.parse(prompts[1].user) as {
      regeneration: { failure_code: string };
      allowed_evidence_ids: string[];
    };
    expect(regeneration).toMatchObject({
      regeneration: { failure_code: 'unknown_evidence_id' },
      allowed_evidence_ids: ['ev-official'],
    });
    expect(prompts[1].user).not.toContain('ev-missing');
    expect(memory.transitionPatches).toContainEqual(expect.objectContaining({
      audit_metadata: expect.objectContaining({
        assessment_generation_attempts: 2,
        assessment_last_validation_code: 'valid',
        assessment_regeneration_trigger_code: 'unknown_evidence_id',
        assessment_claim_contract: MANUAL_LEAD_GENERATED_CLAIM_CONTRACT,
        assessment_source_fact_contract: MANUAL_LEAD_SOURCE_FACT_CONTRACT,
        assessment_editorial_projection_contract: MANUAL_LEAD_EDITORIAL_PROJECTION_CONTRACT,
        assessment_evidence_disposition_contract: MANUAL_LEAD_EVIDENCE_DISPOSITION_CONTRACT,
        assessment_verification_policy: MANUAL_LEAD_VERIFICATION_POLICY_VERSION,
      }),
    }));
  });

  test('normalizes corroborated company role drift before strict validation and reaches verification', async () => {
    const memory = memoryStore();
    let assessCalls = 0;
    let verifyCalls = 0;
    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => [], fetch: async () => documentFixture(techCrunchAlibabaEvidence.url, 'doc'),
      extract: async () => techCrunchAlibabaEvidence,
      assess: async () => {
        assessCalls += 1;
        const raw = structuredClone(alibabaCoreAssessment()) as Record<string, any>;
        raw.source_facts[0].atomic_fact.subject_role = 'company';
        raw.editorial_projection.title.atomic_fact.subject_role = 'company';
        raw.editorial_projection.summary[0].atomic_fact.subject_role = 'company';
        return raw;
      },
      verify: async (prompt) => { verifyCalls += 1; return verifiedFromPrompt(prompt); },
    });

    expect(assessCalls).toBe(1);
    expect(verifyCalls).toBe(1);
    expect(memory.saveCalls()).toBe(1);
    expect(memory.current()).toMatchObject({
      status: 'needs_review',
      assessment: {
        source_facts: [{ atomic_fact: { subject_role: 'organization' } }],
        editorial_projection: { title: { atomic_fact: { subject_role: 'organization' } } },
      },
    });
    expect(memory.transitionPatches).toContainEqual(expect.objectContaining({
      audit_metadata: expect.objectContaining({
        assessment_generation_attempts: 1,
        assessment_first_validation_code: 'valid',
        assessment_last_validation_code: 'valid',
      }),
    }));
  });

  test('sends the exact production Google Sheets canvas assessment to verification', async () => {
    const memory = memoryStore(lead({
      input_type: 'url', input_url: googleSheetsCanvasEvidence.url, input_text: '',
    }));
    let assessCalls = 0;
    let verifyCalls = 0;
    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => [],
      fetch: async () => documentFixture(googleSheetsCanvasEvidence.url, 'doc'),
      extract: async () => googleSheetsCanvasEvidence,
      assess: async () => {
        assessCalls += 1;
        return {
          event_key: 'google-sheets-canvas-feature-2026-08-14',
          event_type: 'product_release', material_update: false, score: 86,
          recommendation: 'recommended', occurred_at: null, uncertainties: [],
          source_facts: [{
            fact_ref: 'fact-01', source_language: 'en',
            atomic_fact: {
              subject: 'Google', subject_role: 'organization', predicate: 'releases',
              object: 'Sheets canvas feature in Google Sheets',
            },
            evidence_ids: [googleSheetsCanvasEvidence.id],
          }],
          evidence_dispositions: [{
            evidence_id: googleSheetsCanvasEvidence.id, disposition: 'supports_core',
            source_fact_refs: ['fact-01'], reason_code: null,
          }],
          editorial_projection: {
            title: {
              projection_ref: 'title-01', source_fact_refs: ['fact-01'],
              atomic_fact: {
                subject: 'Google', subject_role: 'organization', predicate: '发布',
                object: 'Google Sheets 的 Sheets canvas 功能',
              },
            },
            summary: [{
              projection_ref: 'summary-01', source_fact_refs: ['fact-01'],
              atomic_fact: {
                subject: 'Google', subject_role: 'organization', predicate: '发布',
                object: 'Google Sheets 的 Sheets canvas 功能',
              },
            }],
          },
          matched_event_key: null,
        };
      },
      verify: async (prompt) => { verifyCalls += 1; return verifiedFromPrompt(prompt); },
    });

    expect(assessCalls).toBe(1);
    expect(verifyCalls).toBe(1);
    expect(memory.saveCalls()).toBe(1);
    expect(memory.current()).toMatchObject({
      status: 'recommended',
      assessment: {
        title: 'Google发布Google Sheets 的 Sheets canvas 功能。',
        source_facts: [{ atomic_fact: {
          subject: 'Google', predicate: 'releases', object: 'Sheets canvas feature in Google Sheets',
        } }],
      },
    });
  });

  test('regenerates then fails closed before verification for a generic Google Sheets feature concept', async () => {
    const memory = memoryStore(lead({
      input_type: 'url', input_url: googleSheetsCanvasEvidence.url, input_text: '',
    }));
    let assessCalls = 0;
    let verifyCalls = 0;
    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => [],
      fetch: async () => documentFixture(googleSheetsCanvasEvidence.url, 'doc'),
      extract: async () => ({
        ...googleSheetsCanvasEvidence,
        title: 'Google releases feature in Google Sheets',
        excerpt: 'Google releases feature in Google Sheets.',
        claims_supported: ['Google releases feature in Google Sheets.'],
      }),
      assess: async () => {
        assessCalls += 1;
        return {
          event_key: 'google-sheets-generic-feature-2026-08-14',
          event_type: 'product_release', material_update: false, score: 86,
          recommendation: 'recommended', occurred_at: null, uncertainties: [],
          source_facts: [{
            fact_ref: 'fact-01', source_language: 'en',
            atomic_fact: {
              subject: 'Google', subject_role: 'organization', predicate: 'releases',
              object: 'feature in Google Sheets',
            },
            evidence_ids: [googleSheetsCanvasEvidence.id],
          }],
          evidence_dispositions: [{
            evidence_id: googleSheetsCanvasEvidence.id, disposition: 'supports_core',
            source_fact_refs: ['fact-01'], reason_code: null,
          }],
          editorial_projection: {
            title: {
              projection_ref: 'title-01', source_fact_refs: ['fact-01'],
              atomic_fact: {
                subject: 'Google', subject_role: 'organization', predicate: '发布',
                object: 'Google Sheets功能',
              },
            },
            summary: [{
              projection_ref: 'summary-01', source_fact_refs: ['fact-01'],
              atomic_fact: {
                subject: 'Google', subject_role: 'organization', predicate: '发布',
                object: 'Google Sheets功能',
              },
            }],
          },
          matched_event_key: null,
        };
      },
      verify: async () => { verifyCalls += 1; throw new Error('unexpected_verify'); },
    });

    expect(assessCalls).toBe(2);
    expect(verifyCalls).toBe(0);
    expect(memory.saveCalls()).toBe(0);
    expect(memory.current()).toMatchObject({
      status: 'needs_review', assessment: null,
      error_code: 'assessment_validation_failed', error_message: 'invalid_claim_object',
    });
    expect(memory.transitionPatches.at(-1)).toMatchObject({
      audit_metadata: expect.objectContaining({
        assessment_first_validation_code: 'invalid_claim_object',
        assessment_first_validation_path: 'source_facts[0].atomic_fact.object',
        assessment_last_validation_code: 'invalid_claim_object',
        assessment_last_validation_path: 'source_facts[0].atomic_fact.object',
      }),
    });
  });

  test('keeps unknown subject-role failure code and both safe paths observable across regeneration', async () => {
    const memory = memoryStore();
    const prompts: Array<{ system: string; user: string }> = [];
    let assessCalls = 0;
    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => [], fetch: async () => documentFixture(techCrunchAlibabaEvidence.url, 'doc'),
      extract: async () => techCrunchAlibabaEvidence,
      assess: async (prompt) => {
        prompts.push(prompt);
        assessCalls += 1;
        const raw = structuredClone(alibabaCoreAssessment()) as Record<string, any>;
        if (assessCalls === 1) raw.source_facts[0].atomic_fact.subject_role = 'publisher';
        else raw.editorial_projection.title.atomic_fact.subject_role = 'publisher';
        return raw;
      },
      verify: async () => { throw new Error('unexpected_verify'); },
    });

    const regeneration = JSON.parse(prompts[1].user) as {
      regeneration: {
        failure_code: string; failure_path: string; mechanical_instruction: string;
        failure_slot_text?: string;
      };
    };
    expect(regeneration.regeneration).toMatchObject({
      failure_code: 'invalid_claim_subject_role',
      failure_path: 'source_facts[0].atomic_fact.subject_role',
    });
    expect(regeneration.regeneration.mechanical_instruction).toContain('subject_role');
    expect(memory.current()).toMatchObject({
      status: 'needs_review', assessment: null,
      error_code: 'assessment_validation_failed', error_message: 'invalid_claim_subject_role',
    });
    expect(memory.transitionPatches.at(-1)).toMatchObject({
      audit_metadata: expect.objectContaining({
        assessment_generation_attempts: 2,
        assessment_first_validation_code: 'invalid_claim_subject_role',
        assessment_first_validation_path: 'source_facts[0].atomic_fact.subject_role',
        assessment_last_validation_code: 'invalid_claim_subject_role',
        assessment_last_validation_path: 'editorial_projection.title.atomic_fact.subject_role',
        assessment_regeneration_trigger_code: 'invalid_claim_subject_role',
        assessment_regeneration_trigger_path: 'source_facts[0].atomic_fact.subject_role',
      }),
    });
  });

  test('regenerates once after a non-atomic claim and keeps the TechCrunch-style control action atomic', async () => {
    const memory = memoryStore();
    let assessCalls = 0;
    let verifyCalls = 0;
    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => [], fetch: async () => documentFixture(officialEvidence.url, 'doc'),
      extract: async () => officialEvidence,
      assess: async () => {
        assessCalls += 1;
        return assessCalls === 1 ? assessed({
          claims: [{
            atomic_fact: {
              subject: '阿里巴巴', predicate: '将禁止',
              object: '员工使用Claude Code，因为担忧数据安全，并要求改用其他产品',
            },
            evidence_ids: ['ev-official'],
          }],
        }) : assessed();
      },
      verify: async (prompt) => { verifyCalls += 1; return verifiedFromPrompt(prompt); },
    });

    expect(assessCalls).toBe(2);
    expect(verifyCalls).toBe(1);
    expect(memory.current()).toMatchObject({ status: 'recommended' });
    expect(memory.transitionPatches).toContainEqual(expect.objectContaining({
      audit_metadata: expect.objectContaining({
        assessment_generation_attempts: 2,
        assessment_regeneration_trigger_code: 'non_atomic_source_object',
      }),
    }));
  });

  test('regenerates the failing source object slot once and audits first/last safe validation paths', async () => {
    const memory = memoryStore();
    const prompts: Array<{ system: string; user: string }> = [];
    let assessCalls = 0;
    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => [], fetch: async () => documentFixture(techCrunchAlibabaEvidence.url, 'doc'),
      extract: async () => techCrunchAlibabaEvidence,
      assess: async (prompt) => {
        prompts.push(prompt);
        assessCalls += 1;
        return assessCalls === 1
          ? alibabaCoreAssessment({
            source_facts: [{
              fact_ref: 'fact-01', source_language: 'en',
              atomic_fact: {
                subject: 'Alibaba', subject_role: 'organization', predicate: 'reportedly bans',
                object: 'employees from using Claude Code, because of security concerns',
              },
              evidence_ids: [techCrunchAlibabaEvidence.id],
            }],
          })
          : alibabaCoreAssessment();
      },
      verify: async (prompt) => verifiedFromPrompt(prompt),
    });

    expect(assessCalls).toBe(2);
    const regeneration = JSON.parse(prompts[1].user) as {
      regeneration: {
        failure_code: string; failure_path: string; mechanical_instruction: string;
        failure_slot_text?: string;
      };
    };
    expect(regeneration.regeneration).toMatchObject({
      failure_code: 'non_atomic_source_object',
      failure_path: 'source_facts[0].atomic_fact.object',
    });
    expect(regeneration.regeneration.mechanical_instruction).toContain('删除非核心背景');
    // 2026-09-03 起只回显「出错的那一个槽位」原文（模型看不到自己写错哪一段就只能瞎猜），
    // 上一次输出的其它部分仍然一律不回喂。
    expect(regeneration.regeneration.failure_slot_text)
      .toBe('employees from using Claude Code, because of security concerns');
    expect(prompts[1].user.split('because of security concerns').length - 1).toBe(1);
    expect(Object.keys(regeneration.regeneration).sort()).toEqual([
      'failure_code', 'failure_path', 'failure_slot_text', 'instruction',
      'matched_actions', 'mechanical_instruction', 'mode',
    ]);
    expect(memory.transitionPatches).toContainEqual(expect.objectContaining({
      audit_metadata: expect.objectContaining({
        assessment_generation_attempts: 2,
        assessment_first_validation_code: 'non_atomic_source_object',
        assessment_first_validation_path: 'source_facts[0].atomic_fact.object',
        assessment_last_validation_code: 'valid',
        assessment_regeneration_trigger_code: 'non_atomic_source_object',
        assessment_regeneration_trigger_path: 'source_facts[0].atomic_fact.object',
      }),
    }));
  });

  test('keeps both safe paths when the sole regeneration fails in a different generated slot', async () => {
    const memory = memoryStore();
    let assessCalls = 0;
    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => [], fetch: async () => documentFixture(techCrunchAlibabaEvidence.url, 'doc'),
      extract: async () => techCrunchAlibabaEvidence,
      assess: async () => {
        assessCalls += 1;
        if (assessCalls === 1) return alibabaCoreAssessment({
          source_facts: [{
            fact_ref: 'fact-01', source_language: 'en',
            atomic_fact: {
              subject: 'Alibaba', subject_role: 'organization', predicate: 'reportedly bans',
              object: 'employees from using Claude Code, because of security concerns',
            }, evidence_ids: [techCrunchAlibabaEvidence.id],
          }],
        });
        return alibabaCoreAssessment({
          editorial_projection: {
            title: {
              projection_ref: 'title-01', source_fact_refs: ['fact-01'],
              atomic_fact: {
                subject: '阿里巴巴', subject_role: 'organization',
                predicate: '据称禁止并要求', object: '员工使用Claude Code',
              },
            },
            summary: [{
              projection_ref: 'summary-01', source_fact_refs: ['fact-01'],
              atomic_fact: {
                subject: '阿里巴巴', subject_role: 'organization',
                predicate: '据称禁止', object: '员工使用Claude Code',
              },
            }],
          },
        });
      },
      verify: async () => { throw new Error('unexpected_verify'); },
    });

    expect(memory.current()).toMatchObject({
      status: 'needs_review', assessment: null,
      error_code: 'assessment_validation_failed',
      error_message: 'non_atomic_editorial_predicate',
    });
    expect(memory.transitionPatches.at(-1)).toMatchObject({
      audit_metadata: expect.objectContaining({
        assessment_generation_attempts: 2,
        assessment_first_validation_code: 'non_atomic_source_object',
        assessment_first_validation_path: 'source_facts[0].atomic_fact.object',
        assessment_last_validation_code: 'non_atomic_editorial_predicate',
        assessment_last_validation_path: 'editorial_projection.title.atomic_fact.predicate',
        assessment_regeneration_trigger_code: 'non_atomic_source_object',
        assessment_regeneration_trigger_path: 'source_facts[0].atomic_fact.object',
      }),
    });
  });

  test('accepts the URL-only Alibaba lead as one minimal core source fact without regeneration', async () => {
    const memory = memoryStore(lead({
      input_type: 'url', input_url: techCrunchAlibabaEvidence.url, input_text: '',
    }));
    let assessCalls = 0;
    let verifyCalls = 0;
    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => [], fetch: async () => documentFixture(techCrunchAlibabaEvidence.url, 'doc'),
      extract: async () => techCrunchAlibabaEvidence,
      assess: async () => { assessCalls += 1; return alibabaCoreAssessment(); },
      verify: async (prompt) => { verifyCalls += 1; return verifiedFromPrompt(prompt); },
    });

    expect(assessCalls).toBe(1);
    expect(verifyCalls).toBe(1);
    expect(memory.current().assessment).toMatchObject({
      title: '阿里巴巴据称禁止员工使用Claude Code。',
      source_facts: [expect.objectContaining({
        atomic_fact: expect.objectContaining({ object: 'employees from using Claude Code' }),
      })],
      editorial_projection: { summary: [expect.any(Object)] },
    });
  });

  test('stops after two invalid assessment generations without verification or HMAC persistence', async () => {
    const memory = memoryStore();
    let assessCalls = 0;
    let verifyCalls = 0;
    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => [], fetch: async () => documentFixture(officialEvidence.url, 'doc'),
      extract: async () => officialEvidence,
      assess: async () => {
        assessCalls += 1;
        return assessCalls === 1
          ? assessed({ claims: [{
            atomic_fact: {
              subject: 'Anthropic', predicate: 'documented',
              object: 'Claude watermark provenance on 2026-08-10',
            },
            evidence_ids: ['ev-missing'],
          }] })
          : assessed({ claims: [{
            atomic_fact: {
              subject: 'OpenAI', predicate: '发布', object: 'GPT 5，并暂停GPT 6',
            },
            evidence_ids: ['ev-official'],
          }] });
      },
      verify: async () => { verifyCalls += 1; throw new Error('unexpected_verify'); },
    });

    expect(assessCalls).toBe(2);
    expect(verifyCalls).toBe(0);
    expect(memory.saveCalls()).toBe(0);
    expect(memory.current()).toMatchObject({
      status: 'needs_review', assessment: null,
      error_code: 'assessment_validation_failed', error_message: 'non_atomic_source_object',
    });
    expect(memory.transitionPatches.at(-1)).toMatchObject({
      audit_metadata: {
        assessment_generation_attempts: 2,
        assessment_last_validation_code: 'non_atomic_source_object',
        assessment_regeneration_trigger_code: 'unknown_evidence_id',
        assessment_claim_contract: MANUAL_LEAD_GENERATED_CLAIM_CONTRACT,
      },
    });
  });

  test('does not regenerate a valid assessment to disguise independent fact insufficiency', async () => {
    const memory = memoryStore();
    let assessCalls = 0;
    let verifyCalls = 0;
    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => [], fetch: async () => documentFixture(officialEvidence.url, 'doc'),
      extract: async () => officialEvidence,
      assess: async () => { assessCalls += 1; return assessed(); },
      verify: async (prompt) => {
        verifyCalls += 1;
        const result = verifiedFromPrompt(prompt);
        return {
          ...result,
          overall_verdict: 'unsupported',
          fact_results: result.fact_results.map((fact, index) => index === 0
            ? { ...fact, supported: false, issue_code: 'not_found' }
            : fact),
        };
      },
    });

    expect(assessCalls).toBe(1);
    expect(verifyCalls).toBe(1);
    expect(memory.saveCalls()).toBe(0);
    expect(memory.current()).toMatchObject({
      status: 'needs_review', assessment: null, error_code: 'fact_verification_failed',
    });
  });

  test('a consumed regeneration is never repeated after a transient provider failure', async () => {
    const memory = memoryStore();
    let assessCalls = 0;
    let verifyCalls = 0;
    const adapters = {
      search: async () => [], fetch: async () => documentFixture(officialEvidence.url, 'doc'),
      extract: async () => officialEvidence,
      assess: async () => {
        assessCalls += 1;
        if (assessCalls === 1) {
          return assessed({ claims: [{
            atomic_fact: {
              subject: 'Anthropic', predicate: 'documented',
              object: 'Claude watermark provenance on 2026-08-10',
            },
            evidence_ids: ['ev-missing'],
          }] });
        }
        if (assessCalls === 2) throw new Error('trusted_gateway_http_503');
        return assessed();
      },
      verify: async (prompt: { system: string; user: string }) => {
        verifyCalls += 1;
        return verifiedFromPrompt(prompt);
      },
    };

    await processManualNewsLead(memory.current().id, memory.store, adapters);
    expect(memory.current()).toMatchObject({
      status: 'needs_review', assessment: null, error_code: 'assessment_validation_failed',
    });
    expect(memory.saveCalls()).toBe(0);
    expect(assessCalls).toBe(2);
    expect(verifyCalls).toBe(0);
  });

  test('fails closed on Workflow recovery after regeneration was consumed before its call completed', async () => {
    const memory = memoryStore();
    const originalConsume = memory.store.consumeAssessmentRegeneration.bind(memory.store);
    let injectCrash = true;
    memory.store.consumeAssessmentRegeneration = async (...args) => {
      const state = await originalConsume(...args);
      if (injectCrash) {
        injectCrash = false;
        const error = new Error('simulated crash after durable consume');
        error.name = 'TypeError';
        throw error;
      }
      return state;
    };
    let calls = 0;
    const adapters = {
      search: async () => [], fetch: async () => documentFixture(officialEvidence.url, 'doc'),
      extract: async () => officialEvidence,
      assess: async () => {
        calls += 1;
        return assessed({ claims: [{
          atomic_fact: { subject: 'Anthropic', predicate: 'documented', object: 'Claude provenance' },
          evidence_ids: ['ev-missing'],
        }] });
      },
      verify: async (prompt: { system: string; user: string }) => verifiedFromPrompt(prompt),
    };

    await expect(processManualNewsLead(memory.current().id, memory.store, adapters))
      .rejects.toThrow(/simulated crash/);
    await processManualNewsLead(memory.current().id, memory.store, adapters);
    expect(calls).toBe(1);
    expect(memory.current()).toMatchObject({
      status: 'needs_review', error_code: 'assessment_validation_failed',
    });
  });

  test('recovers after save-before-transition crash with the persisted bilingual contract audit intact', async () => {
    const memory = memoryStore();
    let crashAfterSave = true;
    let assessCalls = 0;
    let verifyCalls = 0;
    const crashingStore: ManualLeadProcessingStore = {
      ...memory.store,
      transition: async (id, from, to, patch) => {
        if (from === 'verifying' && to === 'clustering' && crashAfterSave) {
          crashAfterSave = false;
          const error = new Error('simulated runtime fetch interruption');
          error.name = 'TypeError';
          throw error;
        }
        return memory.store.transition(id, from, to, patch);
      },
    };
    const adapters = {
      search: async () => [], fetch: async () => documentFixture(officialEvidence.url, 'doc'),
      extract: async () => officialEvidence,
      assess: async () => { assessCalls += 1; return assessed(); },
      verify: async (prompt: { system: string; user: string }) => {
        verifyCalls += 1;
        return verifiedFromPrompt(prompt);
      },
    };

    await expect(processManualNewsLead(memory.current().id, crashingStore, adapters))
      .rejects.toMatchObject({ name: 'TypeError' });
    expect(memory.current()).toMatchObject({
      status: 'verifying',
      assessment: {
        source_fact_contract: MANUAL_LEAD_SOURCE_FACT_CONTRACT,
        editorial_projection_contract: MANUAL_LEAD_EDITORIAL_PROJECTION_CONTRACT,
      },
    });

    await processManualNewsLead(memory.current().id, crashingStore, adapters);
    expect(assessCalls).toBe(1);
    expect(verifyCalls).toBe(1);
    expect(memory.transitionPatches).toContainEqual(expect.objectContaining({
      audit_metadata: {
        assessment_claim_contract: MANUAL_LEAD_GENERATED_CLAIM_CONTRACT,
        assessment_source_fact_contract: MANUAL_LEAD_SOURCE_FACT_CONTRACT,
        assessment_editorial_projection_contract: MANUAL_LEAD_EDITORIAL_PROJECTION_CONTRACT,
        assessment_evidence_disposition_contract: MANUAL_LEAD_EVIDENCE_DISPOSITION_CONTRACT,
        assessment_verification_policy: MANUAL_LEAD_VERIFICATION_POLICY_VERSION,
        assessment_recovery: 'persisted_verified',
      },
    }));
    expect(memory.current().status).toBe('recommended');
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
      title: '美国参议员桑德斯要求OpenAI停止AI开发',
      excerpt: '美国参议员桑德斯要求OpenAI停止AI开发。',
      claims_supported: ['美国参议员桑德斯要求OpenAI停止AI开发。'],
    };
    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => [],
      fetch: async () => documentFixture(letter.url, 'letter', 'pdf_text'),
      extract: async () => letter,
      assess: async () => assessed({
        title: '美国参议员桑德斯要求OpenAI停止AI开发',
        summary: '美国参议员桑德斯要求OpenAI停止AI开发。',
        event_key: 'sanders-ai-pause-letter-2026-08-10',
        event_type: 'political_regulatory',
        claims: [{
          atomic_fact: {
            subject: '美国参议员桑德斯', predicate: '要求', object: 'OpenAI停止AI开发',
          },
          evidence_ids: ['ev-letter'],
        }],
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
      excerpt: supportedAssessmentFact,
      claims_supported: [supportedAssessmentFact, evidenceText],
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
      excerpt: supportedAssessmentFact,
      claims_supported: [supportedAssessmentFact, evidenceText],
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

    expect(assessCalls, JSON.stringify(memory.current())).toBe(1);
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
      assess: async () => assessed({ claims: [{
        atomic_fact: {
          subject: 'Anthropic', predicate: 'documented',
          object: 'Claude watermark provenance on 2026-08-10',
        },
        evidence_ids: ['ev-missing'],
      }] }),
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
      ...processed(),
      claims: [{ text: '旧事实。', evidence_ids: ['ev-removed'] }],
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
    if (_label === 'search timeout') {
      await expect(processManualNewsLead(memory.current().id, memory.store, adapters))
        .rejects.toThrow(/gateway_timeout/);
      expect(memory.current().status).toBe('researching');
    } else {
      await processManualNewsLead(memory.current().id, memory.store, adapters);
      expect(memory.current()).toMatchObject({
        status: 'needs_review', error_code: 'assessment_validation_failed',
      });
    }
  });

  test.each([
    ['assessment', 'provider_timeout'],
    ['assessment', 'provider_output_exhausted'],
    ['assessment', 'provider_empty_final'],
    ['verification', 'provider_http_503'],
    ['verification', 'provider_capacity'],
  ] as const)('preserves the safe %s provider root cause for Workflow exhaustion', async (
    stage,
    providerErrorCode,
  ) => {
    const memory = memoryStore();
    const failure = new ManualNewsProviderError({
      stage,
      provider_error_code: providerErrorCode,
      metrics: {
        stage,
        request_id: `ml-20260811-abc123:p4:${stage}:1`,
        system_chars: 120,
        user_chars: 3_200,
        evidence_count: 1,
        attempt: 4,
      },
    });
    const processing = processManualNewsLead(memory.current().id, memory.store, {
      search: async () => [], fetch: async () => documentFixture(officialEvidence.url, 'doc'),
      extract: async () => officialEvidence,
      assess: async () => {
        if (stage === 'assessment') throw failure;
        return assessed();
      },
      verify: async (prompt) => {
        if (stage === 'verification') throw failure;
        return verifiedFromPrompt(prompt);
      },
    });
    if (stage === 'verification') {
      await expect(processing).rejects.toMatchObject({
        message: expect.stringMatching(
          new RegExp(`^manual_news_provider_error:${stage}:${providerErrorCode}:`),
        ),
        provider_error_code: providerErrorCode,
        stage,
      });
    } else {
      await processing;
    }
    expect(isTransientManualLeadError(failure)).toBe(true);
    expect(memory.current()).toMatchObject(stage === 'assessment'
      ? { status: 'needs_review', assessment: null, error_code: 'assessment_validation_failed' }
      : { status: 'verifying', assessment: null });
  });

  test.each(['assessment', 'verification'] as const)(
    'fails closed with an audited stable %s prompt-too-large terminal error',
    async (stage) => {
      const memory = memoryStore();
      const failure = new ManualNewsProviderError({
        stage,
        provider_error_code: 'provider_prompt_too_large',
        metrics: {
          stage,
          request_id: `ml-20260811-abc123:p4:${stage}:1`,
          system_chars: 20_000,
          user_chars: 50_000,
          evidence_count: 6,
          attempt: 4,
        },
      });

      await processManualNewsLead(memory.current().id, memory.store, {
        search: async () => [], fetch: async () => documentFixture(officialEvidence.url, 'doc'),
        extract: async () => officialEvidence,
        assess: async () => {
          if (stage === 'assessment') throw failure;
          return assessed();
        },
        verify: async (prompt) => {
          if (stage === 'verification') throw failure;
          return verifiedFromPrompt(prompt);
        },
      });

      expect(isTransientManualLeadError(failure)).toBe(false);
      expect(memory.current()).toMatchObject({
        status: 'failed', assessment: null,
        error_code: stage === 'assessment' ? 'assessment_failed' : 'fact_verification_failed',
        error_message: `manual_news_provider_error:${stage}:provider_prompt_too_large`,
      });
      expect(memory.transitionPatches.at(-1)).toMatchObject({
        audit_metadata: {
          provider_failure: {
            stage,
            provider_error_code: 'provider_prompt_too_large',
            request_id: `ml-20260811-abc123:p4:${stage}:1`,
            system_chars: 20_000,
            user_chars: 50_000,
            evidence_count: 6,
            attempt: 4,
          },
        },
      });
    },
  );

  test.each([
    ['HTTP 503', 503],
    ['HTTP 502', 502],
    ['HTTP 429', 429],
    ['HTTP 408', 408],
    ['TypeError', 'TypeError'],
    ['AbortError', 'AbortError'],
    ['TimeoutError', 'TimeoutError'],
  ] as const)('uses the real callDeepSeekJson %s contract for Workflow retry', async (expectedError, outcome) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (typeof outcome === 'number') return new Response('provider failure', { status: outcome });
      const error = outcome === 'TypeError'
        ? new TypeError('transport failure')
        : new Error('transport failure');
      error.name = outcome;
      throw error;
    }));
    const memory = memoryStore();

    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => [], fetch: async () => documentFixture(officialEvidence.url, 'doc'),
      extract: async () => officialEvidence,
      assess: assessThroughRealDeepSeekJson,
      verify: async () => { throw new Error('unexpected_verify'); },
    });

    expect(isTransientManualLeadError(new Error(expectedError))).toBe(true);
    expect(memory.current()).toMatchObject({
      status: 'needs_review', assessment: null, error_code: 'assessment_validation_failed',
    });
    expect(memory.transitions).not.toContain('verifying->failed');
  });

  test.each([400, 401, 403, 409, 422])(
    'keeps permanent DeepSeek HTTP %i on the terminal assessment failure path',
    async (status) => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      vi.stubGlobal('fetch', vi.fn(async () => new Response('permanent provider rejection', { status })));
      const memory = memoryStore();

      await processManualNewsLead(memory.current().id, memory.store, {
        search: async () => [], fetch: async () => documentFixture(officialEvidence.url, 'doc'),
        extract: async () => officialEvidence,
        assess: assessThroughRealDeepSeekJson,
        verify: async () => { throw new Error('unexpected_verify'); },
      });

      expect(isTransientManualLeadError(new Error(`HTTP ${status}`))).toBe(false);
      expect(memory.current()).toMatchObject({
        status: 'failed', error_code: 'assessment_failed', error_message: `HTTP ${status}`,
      });
    },
  );

  test.each([
    'provider_billing_indeterminate',
    'provider_billing_retry_exhausted',
    'provider_operation_identity_mismatch',
    'provider_identity_rejected',
  ])(
    'never classifies terminal RedFox outcome %s as a durable Workflow retry',
    (code) => {
      expect(isTransientManualLeadError(new Error(code))).toBe(false);
    },
  );

  test('keeps real callDeepSeekJson parse failure on deterministic needs-review path', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn(async () => deepSeekJsonResponse('{not-json')));
    const memory = memoryStore();

    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => [], fetch: async () => documentFixture(officialEvidence.url, 'doc'),
      extract: async () => officialEvidence,
      assess: assessThroughRealDeepSeekJson,
      verify: async () => { throw new Error('unexpected_verify'); },
    });

    expect(isTransientManualLeadError(new Error('json_parse_fail'))).toBe(false);
    expect(memory.current()).toMatchObject({
      status: 'needs_review', assessment: null,
      error_code: 'assessment_validation_failed',
      error_message: 'manual_news_provider_error:assessment:provider_json_parse_fail',
    });
  });

  test('never classifies strict unknown evidence validation as transient from model or d1 substrings', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const invalid = assessed({
      claims: [{
        atomic_fact: {
          subject: 'Anthropic', predicate: 'documented',
          object: 'Claude watermark provenance on 2026-08-10',
        },
        evidence_ids: ['ev-model-d1-invented'],
      }],
    });
    const fetchMock = vi.fn(async () => deepSeekJsonResponse(invalid));
    vi.stubGlobal('fetch', fetchMock);
    const memory = memoryStore();

    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => [], fetch: async () => documentFixture(officialEvidence.url, 'doc'),
      extract: async () => officialEvidence,
      assess: assessThroughRealDeepSeekJson,
      verify: async () => { throw new Error('unexpected_verify'); },
    });

    expect(isTransientManualLeadError(
      new Error('unknown_evidence_id:ev-model-d1-invented'),
    )).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(memory.current()).toMatchObject({
      status: 'needs_review', assessment: null,
      error_code: 'assessment_validation_failed', error_message: 'unknown_evidence_id',
    });
  });

  test('routes an authorized source-support lead through selector and verifier directly into atomic append', async () => {
    const memory = memoryStore(lead({
      review_date: '2026-08-28', input_type: 'text_url', input_text: sourceSupportFact,
      input_url: sourceSupportEvidence.url, status: 'verifying', version: 4,
      processing_owner: 'source-support-owner', processing_attempt: 1,
      evidence: [sourceSupportEvidence],
    }));
    const saveSourceSupportedCandidate = vi.fn(async (_id, _version, payload) => ({
      ...memory.current(),
      status: 'recommended' as const,
      version: 5,
      processing_owner: null,
      processing_lease_until: null,
      confirmed_batch_id: 'source-support-batch',
      confirmed_at: 100,
      source_support_payload: payload,
    }));
    Object.assign(memory.store, {
      getSourceSupportAuthorization: async () => ({
        audit_id: 41,
        candidate_authorization: 'source_support_v1',
        submit_identity_digest: '1'.repeat(64),
        idempotency_key: 'submit-source-support',
      }),
      listSourceSupportPriorEvents: async () => [],
      saveSourceSupportedCandidate,
    });
    const assess = vi.fn(async (prompt: { user: string }) => {
      expect(JSON.parse(prompt.user)).toEqual({
        fact: sourceSupportFact,
        untrusted_evidence: [{ evidence_id: sourceSupportEvidence.id, excerpt: sourceSupportExcerpt }],
      });
      return { evidence_id: sourceSupportEvidence.id, quote: sourceSupportExcerpt };
    });
    const verify = vi.fn(async (prompt: { user: string }) => {
      expect(JSON.parse(prompt.user)).toEqual({
        fact: sourceSupportFact,
        selected_evidence: {
          evidence_id: sourceSupportEvidence.id,
          excerpt: sourceSupportExcerpt,
          quote: sourceSupportExcerpt,
          verification_quote: sourceSupportExcerpt.replace(
            'We’re opening', 'Anthropic is opening',
          ),
          binding_contract: 'official_primary_first_person_actor_v1',
        },
      });
      return { supported: true, evidence_id: sourceSupportEvidence.id };
    });

    const result = await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => { throw new Error('unexpected_search'); },
      fetch: async () => { throw new Error('unexpected_fetch'); },
      extract: async () => { throw new Error('unexpected_extract'); },
      assess,
      verify,
    });

    expect(assess).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(saveSourceSupportedCandidate).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 'recommended', confirmed_at: 100 });
  });

  test('keeps an official first-person lead blocked when the verifier returns false', async () => {
    const memory = memoryStore(lead({
      review_date: '2026-08-28', input_type: 'text_url', input_text: sourceSupportFact,
      input_url: sourceSupportEvidence.url, status: 'verifying', version: 4,
      processing_owner: 'source-support-owner', processing_attempt: 1,
      evidence: [sourceSupportEvidence],
    }));
    const saveSourceSupportedCandidate = vi.fn();
    Object.assign(memory.store, {
      getSourceSupportAuthorization: async () => ({
        audit_id: 41, candidate_authorization: 'source_support_v1',
        submit_identity_digest: '1'.repeat(64), idempotency_key: 'submit-source-support',
      }),
      listSourceSupportPriorEvents: async () => [],
      saveSourceSupportedCandidate,
    });
    const verify = vi.fn(async () => ({
      supported: false, evidence_id: sourceSupportEvidence.id,
    }));

    const result = await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => { throw new Error('unexpected_search'); },
      fetch: async () => { throw new Error('unexpected_fetch'); },
      extract: async () => { throw new Error('unexpected_extract'); },
      assess: async () => ({ evidence_id: sourceSupportEvidence.id, quote: sourceSupportExcerpt }),
      verify,
    });

    expect(verify).toHaveBeenCalledTimes(1);
    expect(saveSourceSupportedCandidate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'needs_review', error_code: 'source_support_verification_failed',
      error_message: 'source_support_not_supported',
    });
  });

  test('classifies a concurrent source-support event loser as duplicate instead of failed', async () => {
    const memory = memoryStore(lead({
      review_date: '2026-08-28', input_type: 'text_url', input_text: sourceSupportFact,
      input_url: sourceSupportEvidence.url, status: 'verifying', version: 4,
      processing_owner: 'source-support-owner', processing_attempt: 1,
      evidence: [sourceSupportEvidence],
    }));
    Object.assign(memory.store, {
      getSourceSupportAuthorization: async () => ({
        audit_id: 41, candidate_authorization: 'source_support_v1',
        submit_identity_digest: '1'.repeat(64), idempotency_key: 'submit-source-support',
      }),
      listSourceSupportPriorEvents: async () => [],
      saveSourceSupportedCandidate: async () => { throw new Error('manual_candidate_event_conflict'); },
    });

    const result = await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => { throw new Error('unexpected_search'); },
      fetch: async () => { throw new Error('unexpected_fetch'); },
      extract: async () => { throw new Error('unexpected_extract'); },
      assess: async () => ({ evidence_id: sourceSupportEvidence.id, quote: sourceSupportExcerpt }),
      verify: async () => ({ supported: true, evidence_id: sourceSupportEvidence.id }),
    });

    expect(result).toMatchObject({ status: 'duplicate', error_code: null, error_message: null });
  });
});

// ── X 链接补录:推文取证通道（2026-09-03）──────────────────────────────────────
// owner 提交的 X 链接线索此前全部失败:线索 URL 被交给 /v1/document 直抓 x.com,
// 大陆机房被墙 → 超时 502 → 判 transient → 3 次重试烧掉约 5 分钟。
// 现在按 host 分流到网关的 POST /v1/tweet(ScrapeBadger 推文接口取证)。
describe('X 链接线索走推文取证通道', () => {
  const TWEET_URL = 'https://x.com/AnthropicAI/status/1234567890123456789';

  function tweetDocument(url = TWEET_URL): PublicDocument {
    return {
      response_key_id: 'response-key-2026-08-11',
      url,
      content_type: 'application/json',
      extraction: 'tweet_api',
      excerpt: 'Anthropic 发布了新模型。',
      redirects: 0,
      title: 'Anthropic（@AnthropicAI）',
      publisher: 'X @AnthropicAI',
      published_at: '2026-09-03T04:05:06.000Z',
      fetch_audit: {
        kind: 'tweet_api',
        provider: 'scrapebadger',
        tweet_id: '1234567890123456789',
        requested_url: url,
        canonical_url: TWEET_URL,
        fetched_at: '2026-09-03T04:05:07.000Z',
        provider_status: 200,
        protocol_version: 'tweet_evidence_v1',
        request_nonce: 'a'.repeat(32),
        request_timestamp: '2026-09-03T04:05:06.000Z',
        body_sha256: 'b'.repeat(64),
        response_hmac: 'c'.repeat(64),
      },
    };
  }

  test.each([
    ['https://x.com/AnthropicAI/status/1234567890123456789'],
    ['https://twitter.com/AnthropicAI/status/1234567890123456789'],
    ['https://www.x.com/AnthropicAI/status/1234567890123456789'],
    ['https://mobile.twitter.com/AnthropicAI/status/1234567890123456789'],
  ])('%s 走 fetchTweet,不再走网页直抓', async (url) => {
    const memory = memoryStore(lead({ input_url: url }));
    const webFetched: string[] = [];
    const tweetFetched: string[] = [];
    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => [],
      fetch: async (target: string) => { webFetched.push(target); return documentFixture(target, 'doc'); },
      fetchTweet: async (target: string) => { tweetFetched.push(target); return tweetDocument(target); },
      extract: async () => officialEvidence,
      assess: async () => assessed(),
      verify: async (prompt: { system: string; user: string }) => verifiedFromPrompt(prompt),
    });

    expect(tweetFetched).toEqual([url]);
    expect(webFetched).toEqual([]);
  });

  test.each([
    // 非 status 路径本来就不是推文取证的对象,拦下来只会把一类失败换成另一类。
    ['https://x.com/AnthropicAI'],
    ['https://x.com/i/lists/123'],
    // 相近 host 绝不能误分流。
    ['https://x.com.evil.test/a/status/1'],
    ['https://support.claude.com/example'],
  ])('%s 维持网页直抓路径', async (url) => {
    const memory = memoryStore(lead({ input_url: url }));
    const webFetched: string[] = [];
    const tweetFetched: string[] = [];
    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => [],
      fetch: async (target: string) => { webFetched.push(target); return documentFixture(target, 'doc'); },
      fetchTweet: async (target: string) => { tweetFetched.push(target); return tweetDocument(target); },
      extract: async () => officialEvidence,
      assess: async () => assessed(),
      verify: async (prompt: { system: string; user: string }) => verifiedFromPrompt(prompt),
    });

    expect(webFetched).toEqual([url]);
    expect(tweetFetched).toEqual([]);
  });

  test('没有注入 fetchTweet 时退回旧行为(回滚安全)', async () => {
    const memory = memoryStore(lead({ input_url: TWEET_URL }));
    const webFetched: string[] = [];
    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => [],
      fetch: async (target: string) => { webFetched.push(target); return documentFixture(target, 'doc'); },
      extract: async () => officialEvidence,
      assess: async () => assessed(),
      verify: async (prompt: { system: string; user: string }) => verifiedFromPrompt(prompt),
    });
    expect(webFetched).toEqual([TWEET_URL]);
  });

  test('推文取证失败时,owner 看到的是具体原因而不是笼统的「未取得证据」', async () => {
    const memory = memoryStore(lead({ input_url: TWEET_URL }));
    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => [],
      fetch: async (target: string) => documentFixture(target, 'doc'),
      fetchTweet: async () => { throw new Error('tweet_evidence:tweet_provider_auth'); },
      extract: async () => officialEvidence,
      assess: async () => assessed(),
      verify: async (prompt: { system: string; user: string }) => verifiedFromPrompt(prompt),
    });

    const current = memory.current();
    expect(current.status).toBe('needs_review');
    expect(current.error_code).toBe('evidence_insufficient');
    expect(current.error_message).toContain('推文提供方拒绝了凭证');
    // 变异对照:没有这层映射时 owner 只会看到这句通用文案。
    expect(current.error_message).not.toBe('未取得可核验的一手或独立证据，请补充链接后重试。');
  });

  test('止血码 x_link_requires_tweet_api 也有人话,并判终态', async () => {
    const memory = memoryStore(lead({ input_url: TWEET_URL }));
    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => [],
      fetch: async () => { throw new Error('tweet_evidence:x_link_requires_tweet_api'); },
      extract: async () => officialEvidence,
      assess: async () => assessed(),
      verify: async (prompt: { system: string; user: string }) => verifiedFromPrompt(prompt),
    });

    const current = memory.current();
    expect(current.status).toBe('needs_review');
    expect(current.error_message).toContain('X 链接需要走推文取证通道');
    expect(isTransientManualLeadError(new Error('tweet_evidence:x_link_requires_tweet_api'))).toBe(false);
  });

  test.each([
    ['tweet_provider_unavailable', true],
    ['egress_proxy_unavailable', true],
    // 5xx 但不会自愈的配置/凭证问题,必须从通用 5xx transient 规则里摘出来。
    ['tweet_provider_auth', false],
    ['tweet_provider_not_configured', false],
    ['tweet_response_signing_unavailable', false],
    ['tweet_not_found', false],
    ['tweet_empty', false],
    ['invalid_tweet_url', false],
    ['unauthorized', false],
  ])('never misclassifies tweet outcome %s as a durable Workflow retry', (code, transient) => {
    expect(isTransientManualLeadError(new Error(`tweet_evidence:${code}`))).toBe(transient);
  });

  test('变异验证:去掉 tweet 分级后,tweet_provider_auth 会被通用 5xx 规则误判为可重试', () => {
    // 通用规则只看到 502 就判 transient(这正是 5 分钟白重试的来源)。
    expect(isTransientManualLeadError(new Error('trusted_gateway_http_502'))).toBe(true);
    // 加了分级之后,同一个底层 502 的推文凭证错误判终态。
    expect(isTransientManualLeadError(new Error('tweet_evidence:tweet_provider_auth'))).toBe(false);
  });
});
