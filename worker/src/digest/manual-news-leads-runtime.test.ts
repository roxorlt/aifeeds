import { describe, expect, test, vi } from 'vitest';

import { applyManualLeadEvidencePolicy, validateManualLeadAssessment } from './manual-news-leads';
import { createManualNewsLeadRuntimeAdapters, extractManualNewsEvidence } from './manual-news-leads-runtime';
import type { PublicDocument } from '../security/safe-url-fetch';

function auditObject(
  url: string,
  sourceContentType: string,
  extraction: PublicDocument['extraction'],
  body: string,
): PublicDocument['fetch_audit'] {
  const extractedBytes = new TextEncoder().encode(body).byteLength;
  return {
    hops: [{ url, validated_ip: '93.184.216.34', connected_ip: '93.184.216.34' }],
    source_content_type: sourceContentType, extraction,
    requested_limits: {
      source_bytes: 8_388_608, extracted_text_bytes: 2_097_152, extracted_text_characters: 1_000_000,
    },
    applied_limits: {
      source_bytes: 8_388_608, extracted_text_bytes: 2_097_152, extracted_text_characters: 1_000_000,
    },
    actual_sizes: {
      source_bytes: sourceContentType === 'application/pdf' ? 48_000 : extractedBytes,
      extracted_text_bytes: extractedBytes,
      extracted_text_characters: Array.from(body).length,
    },
    truncation: { source: false, extracted_text: false },
    parser: { result: 'success' as const, version: 'research-gateway-parser/1.0.0' },
  };
}

function audit(url: string, sourceContentType: string, extraction: PublicDocument['extraction'], body: string): string {
  return encodeURIComponent(JSON.stringify(auditObject(url, sourceContentType, extraction, body)));
}

function documentFixture(
  url: string,
  body: string,
  extraction: PublicDocument['extraction'] = 'html',
): PublicDocument {
  const contentType = extraction === 'pdf_text' ? 'application/pdf' : 'text/html';
  return {
    url, content_type: contentType, extraction, body, redirects: 0,
    bytes: new TextEncoder().encode(body).byteLength,
    fetch_audit: auditObject(url, contentType, extraction, body),
  };
}

describe('manual lead evidence extraction', () => {
  test('keeps an explicit source publication time separate from retrieval time', async () => {
    const evidence = await extractManualNewsEvidence(documentFixture(
      'https://www.anthropic.com/news/example',
      '<html><head><title>Supported output provenance</title><meta property="article:published_time" content="2026-08-10T09:30:00-04:00"></head><body>Scope is limited to supported products.</body></html>',
    ), {
      url: 'https://www.anthropic.com/news/example', title: 'Search title', snippet: 'Search snippet.',
      published_at: '2026-08-09T00:00:00Z',
    }, 1234);

    expect(evidence).toMatchObject({
      source_type: 'official_primary',
      published_at: '2026-08-10T13:30:00.000Z',
      retrieved_at: 1234,
    });
  });

  test('does not invent a publication time when the source and search hint omit it', async () => {
    const evidence = await extractManualNewsEvidence(documentFixture(
      'https://www.axios.com/example', '<title>Report</title><p>No machine-readable publication time.</p>',
    ), undefined, 1234);
    expect(evidence?.published_at).toBeNull();
  });

  test('classifies authority only from the exact allowlisted registrable domain of the final fetched URL', async () => {
    const deceptive = await extractManualNewsEvidence(documentFixture(
      'https://support.claude.com.evil.example/notice', '<title>Fake help</title><p>Untrusted copy.</p>',
    ), {
      url: 'https://support.claude.com/real', title: 'Malicious hint', snippet: 'Pretend official.',
      source_type: 'official_help', publisher: 'Anthropic', reliable: true,
    }, 1234);
    expect(deceptive).toMatchObject({
      url: 'https://support.claude.com.evil.example/notice',
      source_type: 'other', publisher: 'evil.example', reliable: false,
    });

    const official = await extractManualNewsEvidence(documentFixture(
      'https://support.claude.com/en/articles/notice', '<title>Official help</title><p>Supported products only.</p>',
    ), undefined, 1234);
    expect(official).toMatchObject({ source_type: 'official_help', publisher: 'claude.com', reliable: true });
  });

  test('text-only research requires and combines a trusted open-web search with existing D1 evidence', async () => {
    const db = {
      prepare() {
        const stmt = {
          bind() { return stmt; },
          async all() { return { results: [{
            title: 'Existing item', content: 'Existing body', content_translated: null,
            url: 'https://www.anthropic.com/news/existing', published_at: '2026-08-10T00:00:00Z', extra: '{}',
          }] }; },
        };
        return stmt;
      },
    };
    const baseEnv = { DB: db } as never;
    await expect(createManualNewsLeadRuntimeAdapters(baseEnv).search({
      date: '2026-08-11', text: 'Anthropic watermark', note: '',
    })).rejects.toThrow(/trusted_research_service_required/);

    const adapters = createManualNewsLeadRuntimeAdapters({
      DB: db,
      MANUAL_NEWS_RESEARCH_ORIGIN: 'https://research-gateway.example',
      MANUAL_NEWS_RESEARCH_TOKEN: 'test-token',
    } as never, {
      researchFetcher: async () => new Response(JSON.stringify({ results: [{
        url: 'https://www.axios.com/report', title: 'Independent report', snippet: 'Independent evidence.',
        published_at: '2026-08-10T12:00:00Z',
      }] }), { headers: { 'Content-Type': 'application/json' } }),
    });
    const results = await adapters.search({ date: '2026-08-11', text: 'Anthropic watermark', note: '' });
    expect(results.map((item) => item.url)).toEqual([
      'https://www.anthropic.com/news/existing', 'https://www.axios.com/report',
    ]);
  });

  test('identifies a failure in the existing-news search branch without preventing open-web search startup', async () => {
    const researchFetcher = vi.fn(async () => new Response(JSON.stringify({ results: [] }), {
      headers: { 'Content-Type': 'application/json' },
    }));
    const adapters = createManualNewsLeadRuntimeAdapters({
      DB: { prepare() { throw new TypeError('D1 receiver mismatch'); } },
      MANUAL_NEWS_RESEARCH_ORIGIN: 'https://research-gateway.example',
      MANUAL_NEWS_RESEARCH_TOKEN: 'test-token',
    } as never, { researchFetcher });

    await expect(adapters.search({ date: '2026-08-11', text: 'Anthropic watermark', note: '' }))
      .rejects.toThrow(/^search_existing:D1 receiver mismatch$/);
    expect(researchFetcher).toHaveBeenCalledTimes(1);
  });

  test('identifies a failure in the public-web search branch without exposing the gateway token', async () => {
    const statement = {
      bind() { return statement; },
      async all() { return { results: [] }; },
    };
    const adapters = createManualNewsLeadRuntimeAdapters({
      DB: { prepare() { return statement; } },
      MANUAL_NEWS_RESEARCH_ORIGIN: 'https://research-gateway.example',
      MANUAL_NEWS_RESEARCH_TOKEN: 'secret-test-token',
    } as never, {
      researchFetcher: async () => {
        throw new TypeError('Illegal invocation for Bearer secret-test-token');
      },
    });

    let failure: unknown;
    try {
      await adapters.search({ date: '2026-08-11', text: 'Anthropic watermark', note: '' });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('search_public:Illegal invocation for Bearer [redacted]');
    expect((failure as Error).message).not.toContain('secret-test-token');
    expect((failure as Error).cause).toBeUndefined();
  });

  test('Bernie letter uses bounded trusted PDF text conversion and still needs an independent report', async () => {
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const target = JSON.parse(String(init?.body || '{}')).url as string;
      const pdf = target.endsWith('.pdf');
      const body = pdf
        ? 'Senator Bernie Sanders asks OpenAI, Anthropic, and Meta leaders to pause AI development.'
        : 'Independent reporting says one senator made the request; it is not a binding congressional order.';
      return new Response(body, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'X-AIFeeds-Fetch-Audit': audit(
            target, pdf ? 'application/pdf' : 'text/html', pdf ? 'pdf_text' : 'html', body,
          ),
        },
      });
    };
    const adapters = createManualNewsLeadRuntimeAdapters({
      DB: {} as never,
      MANUAL_NEWS_RESEARCH_ORIGIN: 'https://research-gateway.example',
      MANUAL_NEWS_RESEARCH_TOKEN: 'test-token',
    } as never, { researchFetcher: fetcher });
    const letter = await adapters.extract(await adapters.fetch('https://www.sanders.senate.gov/letter.pdf'));
    const report = await adapters.extract(await adapters.fetch('https://www.axios.com/report'));
    expect(letter).toMatchObject({
      source_type: 'original_document',
      reliable: true,
      fetch_audit: {
        source_content_type: 'application/pdf', extraction: 'pdf_text',
        actual_sizes: { source_bytes: 48_000 },
        parser: { result: 'success', version: 'research-gateway-parser/1.0.0' },
      },
    });
    expect(report).toMatchObject({ source_type: 'independent_media', reliable: true });
    const evidence = [letter!, report!];
    const assessed = validateManualLeadAssessment({
      title: '美国参议员桑德斯呼吁三家AI公司暂停AI开发',
      summary: '这是单名参议员提出的请求，并非有约束力的国会命令。',
      event_key: 'sanders-ai-pause-letter-2026-08-10', event_type: 'political_regulatory',
      material_update: false, score: 88, recommendation: 'recommended', occurred_at: null,
      uncertainties: ['公开信未提供有约束力的法律措施。'],
      claims: [{
        text: '美国参议员伯尼·桑德斯向OpenAI、Anthropic和Meta负责人提出暂停AI开发的请求；这不是有约束力的国会命令。',
        evidence_ids: evidence.map((item) => item.id),
      }],
      matched_event_key: null,
    }, evidence);
    expect(applyManualLeadEvidencePolicy(assessed, evidence))
      .toMatchObject({ recommendation: 'recommended', evidence_tier: 'original_plus_independent' });
  });
});
