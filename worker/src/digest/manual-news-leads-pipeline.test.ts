import { describe, expect, test } from 'vitest';

import {
  processManualNewsLead,
  type ManualLeadProcessingStore,
  type ManualNewsLeadRecord,
} from './manual-news-leads-pipeline';
import type { ManualNewsEvidence } from './manual-news-leads';
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
  };
  return { store, transitions, current: () => current, priorEvents };
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
    claims: [{ text: '范围限于受支持的输出。', evidence_ids: ['ev-official'] }],
    matched_event_key: null,
    ...overrides,
  };
}

describe('manual lead processing pipeline', () => {
  test('moves through observable stages and produces an evidence-bounded recommendation', async () => {
    const memory = memoryStore();
    await processManualNewsLead('ml-20260811-abc123', memory.store, {
      search: async () => [],
      fetch: async () => documentFixture(officialEvidence.url, '<p>doc</p>'),
      extract: async () => officialEvidence,
      assess: async () => assessed(),
    });

    expect(memory.transitions).toEqual([
      'submitted->validating', 'validating->researching', 'researching->extracting',
      'extracting->verifying', 'verifying->clustering', 'clustering->scored',
      'scored->recommended',
    ]);
    expect(memory.current()).toMatchObject({ status: 'recommended' });
    expect(memory.current().assessment).toMatchObject({
      recommendation: 'recommended', evidence_tier: 'official_primary',
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
    });
    expect(memory.current()).toMatchObject({ status: 'needs_review' });
    expect(memory.current().assessment).toMatchObject({ recommendation: 'needs_review', evidence_tier: 'insufficient' });
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
    });
    expect(memory.current()).toMatchObject({ status: 'duplicate' });
    expect(memory.current().assessment).toMatchObject({ recommendation: 'duplicate', duplicate_scope: 'cross_day' });
  });

  test('fails closed when model JSON cites unknown evidence', async () => {
    const memory = memoryStore();
    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => [],
      fetch: async () => documentFixture(officialEvidence.url, 'doc'),
      extract: async () => officialEvidence,
      assess: async () => assessed({ claims: [{ text: 'invented', evidence_ids: ['ev-missing'] }] }),
    });
    expect(memory.current()).toMatchObject({ status: 'failed', error_code: 'assessment_validation_failed' });
  });

  test('fails closed when matched_event_key is not present in bounded prior-event context', async () => {
    const memory = memoryStore();
    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => [],
      fetch: async () => documentFixture(officialEvidence.url, 'doc'),
      extract: async () => officialEvidence,
      assess: async () => assessed({ matched_event_key: 'invented-prior-event-2026-08' }),
    });
    expect(memory.current()).toMatchObject({ status: 'failed', error_code: 'assessment_validation_failed' });
  });

  test('resumes safely from an intermediate extracting state after a durable workflow retry', async () => {
    const memory = memoryStore(lead({ status: 'extracting', version: 4 }));
    await processManualNewsLead(memory.current().id, memory.store, {
      search: async () => [],
      fetch: async () => documentFixture(officialEvidence.url, 'doc'),
      extract: async () => officialEvidence,
      assess: async () => assessed(),
    });

    expect(memory.transitions).toEqual([
      'extracting->verifying', 'verifying->clustering', 'clustering->scored', 'scored->recommended',
    ]);
    expect(memory.current()).toMatchObject({ status: 'recommended' });
  });
});
