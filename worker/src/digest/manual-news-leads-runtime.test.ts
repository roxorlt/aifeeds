import { describe, expect, test, vi } from 'vitest';

import { applyManualLeadEvidencePolicy, validateManualLeadAssessment } from './manual-news-leads';
import {
  createManualNewsLeadRuntimeAdapters,
  extractManualNewsEvidence,
  MANUAL_NEWS_PROVIDER_PROMPT_MAX_CHARS,
  MANUAL_NEWS_PROVIDER_TIMEOUT_MS,
} from './manual-news-leads-runtime';
import type { PublicDocument } from '../security/safe-url-fetch';
import { callDeepSeekJson, DEEPSEEK_PRO } from '../hf-paper/llm';
import {
  ManualNewsProviderError,
  manualNewsProviderDiagnostics,
  manualNewsProviderFailureAudit,
} from './manual-news-provider';

vi.mock('../hf-paper/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hf-paper/llm')>();
  return { ...actual, callDeepSeekJson: vi.fn() };
});

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
  test('uses one 210-second provider call per assessment or verification invocation and records only safe metrics', async () => {
    const mockedCall = vi.mocked(callDeepSeekJson);
    mockedCall
      .mockResolvedValueOnce({ data: { event_key: 'safe-result' } })
      .mockResolvedValueOnce({ data: { overall_verdict: 'supported', claim_results: [] } });
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const adapters = createManualNewsLeadRuntimeAdapters({
      DB: {} as never,
      DEEPSEEK_API_KEY: 'test-key',
    } as never, { modelContext: { leadId: 'ml-safe-request', processingAttempt: 6 } });

    await expect(adapters.assess(
      { system: 'assessment secret body', user: '{"evidence":"https://private.example/path"}' },
      { request_id: 'ml-safe-request:p6:assessment:1', evidence_count: 1, attempt: 6 },
    )).resolves.toEqual({ event_key: 'safe-result' });
    await expect(adapters.verify(
      { system: 'independent verifier', user: '{"claims":[]}' },
      { request_id: 'ml-safe-request:p6:verification:2', evidence_count: 1, attempt: 6 },
    ))
      .resolves.toEqual({ overall_verdict: 'supported', claim_results: [] });
    expect(mockedCall).toHaveBeenNthCalledWith(
      1,
      'test-key', DEEPSEEK_PRO, '{"evidence":"https://private.example/path"}',
      expect.objectContaining({
        systemPrompt: 'assessment secret body', retries: 0, timeoutMs: 210_000, maxTokens: 12_000,
        requestId: 'ml-safe-request:p6:assessment:1',
      }),
    );
    expect(mockedCall).toHaveBeenNthCalledWith(
      2,
      'test-key', DEEPSEEK_PRO, '{"claims":[]}',
      expect.objectContaining({
        systemPrompt: 'independent verifier', retries: 0, timeoutMs: 210_000, maxTokens: 12_000,
        requestId: 'ml-safe-request:p6:verification:2',
      }),
    );
    expect(mockedCall).toHaveBeenCalledTimes(2);
    const logs = info.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(logs).toContain('"stage":"assessment"');
    expect(logs).toContain('"stage":"verification"');
    expect(logs).toContain('"evidence_count":1');
    expect(logs).toContain('"attempt":6');
    expect(logs).toContain('"system_chars":22');
    expect(logs).not.toContain('assessment secret body');
    expect(logs).not.toContain('private.example');
    expect(logs).not.toContain('test-key');
    mockedCall.mockReset();
  });

  test.each(['assessment', 'verification'] as const)(
    'fails closed before the %s provider call when the fully serialized prompt exceeds its hard limit',
    async (stage) => {
      const mockedCall = vi.mocked(callDeepSeekJson);
      const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
      const adapters = createManualNewsLeadRuntimeAdapters({
        DB: {} as never, DEEPSEEK_API_KEY: 'test-key',
      } as never, { modelContext: { leadId: 'ml-prompt-limit', processingAttempt: 3 } });
      const invoke = stage === 'assessment' ? adapters.assess : adapters.verify;

      const failure = await invoke(
        { system: 'trusted-rules', user: 'x'.repeat(MANUAL_NEWS_PROVIDER_PROMPT_MAX_CHARS) },
        { request_id: `ml-prompt-limit:p3:${stage}:1`, evidence_count: 6, attempt: 3 },
      ).catch((error) => error);

      expect(failure).toBeInstanceOf(ManualNewsProviderError);
      expect(failure).toMatchObject({ stage, provider_error_code: 'provider_prompt_too_large' });
      expect(mockedCall).not.toHaveBeenCalled();
      expect(info.mock.calls.flat().join(' ')).not.toContain('xxxxxxxxxx');
      mockedCall.mockReset();
    },
  );

  test('exports the provider timeout and complete serialized prompt boundary', () => {
    expect(MANUAL_NEWS_PROVIDER_TIMEOUT_MS).toBe(210_000);
    expect(MANUAL_NEWS_PROVIDER_PROMPT_MAX_CHARS).toBe(64_000);
  });

  test.each([
    ['assessment', 'AbortError', 'provider_timeout'],
    ['assessment', 'TimeoutError', 'provider_timeout'],
    ['assessment', 'TypeError', 'provider_transport_error'],
    ['assessment', 'HTTP 408', 'provider_http_408'],
    ['assessment', 'HTTP 429', 'provider_http_429'],
    ['assessment', 'HTTP 503', 'provider_http_503'],
    ['assessment', 'no_text', 'provider_no_text'],
    ['assessment', 'json_parse_fail', 'provider_json_parse_fail'],
    ['verification', 'HTTP 502', 'provider_http_502'],
  ] as const)('maps safe %s provider failures: %s', async (stage, rawCode, stableCode) => {
    const mockedCall = vi.mocked(callDeepSeekJson);
    mockedCall.mockResolvedValueOnce({ data: null, error: rawCode });
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const adapters = createManualNewsLeadRuntimeAdapters({
      DB: {} as never, DEEPSEEK_API_KEY: 'test-key',
    } as never, { modelContext: { leadId: 'ml-safe-request', processingAttempt: 2 } });
    const invoke = stage === 'assessment' ? adapters.assess : adapters.verify;

    const failure = await invoke(
      { system: 'rules', user: '{"evidence":[]}' },
      { request_id: `ml-safe-request:p2:${stage}:1`, evidence_count: 1, attempt: 2 },
    ).catch((error) => error);

    expect(failure).toBeInstanceOf(ManualNewsProviderError);
    expect(failure).toMatchObject({ stage, provider_error_code: stableCode });
    expect(String((failure as Error).message)).toMatch(
      new RegExp(`^manual_news_provider_error:${stage}:${stableCode}:`),
    );
    mockedCall.mockReset();
  });

  test('drops out-of-range or non-whitelisted provider diagnostics before audit', () => {
    expect(manualNewsProviderDiagnostics({
      finish_reason: 'length',
      content_chars: 0,
      reasoning_chars: 10_000_001,
      usage: { reasoning_tokens: 100_000_001 },
    })).toBeUndefined();
    expect(manualNewsProviderDiagnostics({
      finish_reason: 'future-provider-value' as never,
      content_chars: 0,
      reasoning_chars: 1,
      usage: {},
    })).toBeUndefined();
  });

  test.each([
    ['length', 'no_text', 3, 'provider_output_exhausted'],
    ['length', 'json_parse_fail', 17, 'provider_output_exhausted'],
    ['stop', 'no_text', 3, 'provider_empty_final'],
    ['insufficient_system_resource', 'no_text', 0, 'provider_capacity'],
    ['insufficient_system_resource', 'json_parse_fail', 17, 'provider_capacity'],
    ['unknown', 'no_text', 0, 'provider_no_text'],
  ] as const)('classifies null assessment finish=%s with bounded safe diagnostics', async (
    finishReason,
    rawError,
    contentChars,
    expectedCode,
  ) => {
    const mockedCall = vi.mocked(callDeepSeekJson);
    mockedCall.mockResolvedValueOnce({
      data: null,
      error: rawError,
      diagnostics: {
        finish_reason: finishReason,
        content_chars: contentChars,
        reasoning_chars: 3_500,
        usage: {
          prompt_tokens: 1_200,
          completion_tokens: 3_500,
          total_tokens: 4_700,
          reasoning_tokens: 3_500,
        },
      },
    } as never);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const adapters = createManualNewsLeadRuntimeAdapters({
      DB: {} as never, DEEPSEEK_API_KEY: 'test-key',
    } as never, { modelContext: { leadId: 'ml-safe-request', processingAttempt: 2 } });

    const failure = await adapters.assess(
      { system: 'rules', user: '{"evidence":[]}' },
      { request_id: 'ml-safe-request:p2:assessment:1', evidence_count: 1, attempt: 2 },
    ).catch((error) => error);

    expect(failure).toMatchObject({ provider_error_code: expectedCode });
    expect(manualNewsProviderFailureAudit(failure)).toMatchObject({
      provider_error_code: expectedCode,
      provider_diagnostics: {
        finish_reason: finishReason,
        content_chars: contentChars,
        reasoning_chars: 3_500,
        usage: { reasoning_tokens: 3_500 },
      },
    });
    expect(JSON.stringify(manualNewsProviderFailureAudit(failure))).not.toContain('reasoning_content');
    mockedCall.mockReset();
  });

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

  test('redacts every provider URL while preserving the search stage and stable gateway status', async () => {
    const statement = {
      bind() { return statement; },
      async all() { return { results: [] }; },
    };
    const adapters = createManualNewsLeadRuntimeAdapters({
      DB: { prepare() { return statement; } },
      MANUAL_NEWS_RESEARCH_ORIGIN: 'https://research-gateway.example',
      MANUAL_NEWS_RESEARCH_TOKEN: 'test-token',
    } as never, {
      researchFetcher: async () => {
        throw new Error(
          'trusted_gateway_http_502 fetching https://example.com/path?token=secret#frag '
          + 'via https://provider.example/private/report?id=hidden',
        );
      },
    });

    let message = '';
    try {
      await adapters.search({ date: '2026-08-11', text: 'Anthropic watermark', note: '' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe('search_public:trusted_gateway_http_502 fetching [url] via [url]');
    for (const leaked of ['example.com', '/path', 'token=secret', '#frag', 'provider.example', 'id=hidden']) {
      expect(message).not.toContain(leaked);
    }
  });

  test('redacts adversarial URL forms without leaving credential, path, query, or fragment suffixes', async () => {
    const statement = {
      bind() { return statement; },
      async all() { return { results: [] }; },
    };
    const unsafeMessage = [
      'trusted_gateway_http_503',
      '_https://u.example/p?q=1#uf',
      'HtTpS://c.example/P?Q=2#CF',
      "https://u:p's@d.example/c?t=3#df",
      "http://p.example/a'b?t=4#pf",
      '(https://r.example/i?q=5#rf),',
      'https://t.example/f?q=6#tf...',
    ].join(' ');
    const adapters = createManualNewsLeadRuntimeAdapters({
      DB: { prepare() { return statement; } },
      MANUAL_NEWS_RESEARCH_ORIGIN: 'https://research-gateway.example',
      MANUAL_NEWS_RESEARCH_TOKEN: 'test-token',
    } as never, {
      researchFetcher: async () => { throw new Error(unsafeMessage); },
    });

    let message = '';
    try {
      await adapters.search({ date: '2026-08-11', text: 'Anthropic watermark', note: '' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('search_public:trusted_gateway_http_503');
    expect(message.match(/\[url\]/g)).toHaveLength(6);
    expect(message).not.toMatch(/https?:\/\//i);
    for (const leaked of [
      'u.example', '/p', 'q=1', '#uf',
      'c.example', '/P', 'Q=2', '#CF',
      "u:p's", 'd.example', '/c', 't=3', '#df',
      'p.example', "/a'b", 't=4', '#pf',
      'r.example', '/i', 'q=5', '#rf',
      't.example', '/f', 'q=6', '#tf',
    ]) expect(message.toLowerCase()).not.toContain(leaked.toLowerCase());
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
      title: '美国参议员伯尼·桑德斯呼吁三家AI公司暂停AI开发',
      summary: '美国参议员伯尼·桑德斯呼吁三家AI公司暂停AI开发。',
      event_key: 'sanders-ai-pause-letter-2026-08-10', event_type: 'political_regulatory',
      material_update: false, score: 88, recommendation: 'recommended', occurred_at: null,
      uncertainties: ['公开信未提供有约束力的法律措施。'],
      claims: [
        {
          text: '美国参议员伯尼·桑德斯呼吁三家AI公司暂停AI开发。',
          evidence_ids: evidence.map((item) => item.id),
        },
      ],
      matched_event_key: null,
    }, evidence);
    expect(applyManualLeadEvidencePolicy(assessed, evidence))
      .toMatchObject({ recommendation: 'recommended', evidence_tier: 'original_plus_independent' });
  });
});
