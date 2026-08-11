import { describe, expect, test } from 'vitest';

import { applyManualLeadEvidencePolicy, validateManualLeadAssessment } from './manual-news-leads';
import { createManualNewsLeadRuntimeAdapters, extractManualNewsEvidence } from './manual-news-leads-runtime';

function audit(url: string, sourceContentType: string, extraction: string): string {
  return encodeURIComponent(JSON.stringify({
    hops: [{ url, validated_ip: '93.184.216.34', connected_ip: '93.184.216.34' }],
    source_content_type: sourceContentType, extraction,
  }));
}

describe('manual lead evidence extraction', () => {
  test('keeps an explicit source publication time separate from retrieval time', async () => {
    const evidence = await extractManualNewsEvidence({
      url: 'https://www.anthropic.com/news/example',
      content_type: 'text/html',
      extraction: 'html',
      body: '<html><head><title>Supported output provenance</title><meta property="article:published_time" content="2026-08-10T09:30:00-04:00"></head><body>Scope is limited to supported products.</body></html>',
      redirects: 0,
      bytes: 220,
    }, {
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
    const evidence = await extractManualNewsEvidence({
      url: 'https://www.axios.com/example', content_type: 'text/html',
      extraction: 'html',
      body: '<title>Report</title><p>No machine-readable publication time.</p>', redirects: 0, bytes: 70,
    }, undefined, 1234);
    expect(evidence?.published_at).toBeNull();
  });

  test('classifies authority only from the exact allowlisted registrable domain of the final fetched URL', async () => {
    const deceptive = await extractManualNewsEvidence({
      url: 'https://support.claude.com.evil.example/notice', content_type: 'text/html',
      extraction: 'html',
      body: '<title>Fake help</title><p>Untrusted copy.</p>', redirects: 0, bytes: 48,
    }, {
      url: 'https://support.claude.com/real', title: 'Malicious hint', snippet: 'Pretend official.',
      source_type: 'official_help', publisher: 'Anthropic', reliable: true,
    }, 1234);
    expect(deceptive).toMatchObject({
      url: 'https://support.claude.com.evil.example/notice',
      source_type: 'other', publisher: 'evil.example', reliable: false,
    });

    const official = await extractManualNewsEvidence({
      url: 'https://support.claude.com/en/articles/notice', content_type: 'text/html',
      extraction: 'html',
      body: '<title>Official help</title><p>Supported products only.</p>', redirects: 0, bytes: 62,
    }, undefined, 1234);
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

  test('Bernie letter uses bounded trusted PDF text conversion and still needs an independent report', async () => {
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const target = JSON.parse(String(init?.body || '{}')).url as string;
      const pdf = target.endsWith('.pdf');
      return new Response(pdf
        ? 'Senator Bernie Sanders asks OpenAI, Anthropic, and Meta leaders to pause AI development.'
        : 'Independent reporting says one senator made the request; it is not a binding congressional order.', {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'X-AIFeeds-Fetch-Audit': audit(target, pdf ? 'application/pdf' : 'text/html', pdf ? 'pdf_text' : 'html'),
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
    expect(letter).toMatchObject({ source_type: 'original_document', reliable: true });
    expect(report).toMatchObject({ source_type: 'independent_media', reliable: true });
    const evidence = [letter!, report!];
    const assessed = validateManualLeadAssessment({
      title: '美国参议员桑德斯呼吁三家AI公司暂停AI开发',
      summary: '这是单名参议员提出的请求，并非有约束力的国会命令。',
      event_key: 'sanders-ai-pause-letter-2026-08-10', event_type: 'political_regulatory',
      material_update: false, score: 88, recommendation: 'recommended', occurred_at: null,
      uncertainties: ['公开信未提供有约束力的法律措施。'],
      claims: [{ text: '一名参议员向三家公司负责人提出暂停请求。', evidence_ids: evidence.map((item) => item.id) }],
      matched_event_key: null,
    }, evidence);
    expect(applyManualLeadEvidencePolicy(assessed, evidence))
      .toMatchObject({ recommendation: 'recommended', evidence_tier: 'original_plus_independent' });
  });
});
