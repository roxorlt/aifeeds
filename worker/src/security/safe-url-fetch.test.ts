import { describe, expect, test, vi } from 'vitest';

import {
  fetchPublicDocument,
  searchPublicWeb,
  validatePublicHttpUrl,
  type TrustedResearchService,
} from './safe-url-fetch';

function service(fetcher: typeof fetch): TrustedResearchService {
  return { origin: 'https://research-gateway.example', token: 'test-token', fetcher };
}

function fetchAudit(input: {
  hops: Array<{ url: string; validated_ip: string; connected_ip: string }>;
  source_content_type?: string;
  extraction?: string;
}): string {
  return encodeURIComponent(JSON.stringify({
    hops: input.hops,
    source_content_type: input.source_content_type || 'text/html',
    extraction: input.extraction || 'html',
  }));
}

function gatewayResponse(body: BodyInit | null, input: Parameters<typeof fetchAudit>[0], headers: Record<string, string> = {}) {
  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-AIFeeds-Fetch-Audit': fetchAudit(input),
      ...headers,
    },
  });
}

const publicHop = (url = 'https://example.com/story') => ({
  url, validated_ip: '93.184.216.34', connected_ip: '93.184.216.34',
});

describe('trusted manual-news research boundary', () => {
  test('accepts only credential-free HTTP(S) target URLs on standard ports', () => {
    expect(validatePublicHttpUrl('https://example.com/news').toString()).toBe('https://example.com/news');
    for (const unsafe of [
      'file:///etc/passwd', 'https://user:pass@example.com/news', 'https://example.com:8443/news',
      'http://localhost/news', 'http://127.0.0.1/news', 'http://[::1]/news',
      'http://[::ffff:7f00:1]/news', 'http://169.254.169.254/latest/meta-data',
    ]) expect(() => validatePublicHttpUrl(unsafe), unsafe).toThrow(/unsafe_url/);
  });

  test('fails closed without a trusted fixed-origin service and never directly fetches an arbitrary hostname', async () => {
    await expect(fetchPublicDocument('https://example.com/story')).rejects.toThrow(/trusted_research_service_required/);
    await expect(fetchPublicDocument('https://example.com/story', {
      service: { origin: 'https://127.0.0.1', token: 'test-token', fetcher: vi.fn() },
    })).rejects.toThrow(/invalid_trusted_research_origin/);
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      gatewayResponse('<p>safe</p>', { hops: [publicHop()] }));
    await fetchPublicDocument('https://example.com/story', { service: service(fetcher as typeof fetch) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toBe('https://research-gateway.example/v1/document');
    expect(String(fetcher.mock.calls[0][0])).not.toContain('example.com/story');
  });

  test('rejects fetch-time peer mismatch, private peers, and unvalidated redirect hops', async () => {
    for (const hops of [
      [{ ...publicHop(), connected_ip: '93.184.216.35' }],
      [{ ...publicHop(), connected_ip: '10.0.0.8' }],
      [publicHop(), { url: 'http://internal.example/admin', validated_ip: '127.0.0.1', connected_ip: '127.0.0.1' }],
    ]) {
      await expect(fetchPublicDocument('https://example.com/story', {
        service: service(async () => gatewayResponse('never trusted', { hops }) as never),
      })).rejects.toThrow(/unsafe_gateway_audit/);
    }
  });

  test('validates redirect audit order and redirect count before accepting the final URL', async () => {
    const hops = [
      publicHop('https://example.com/story'),
      publicHop('https://www.example.com/final'),
    ];
    const document = await fetchPublicDocument('https://example.com/story', {
      service: service(async () => gatewayResponse('<p>final</p>', { hops }) as never),
    });
    expect(document).toMatchObject({ url: 'https://www.example.com/final', redirects: 1, body: '<p>final</p>' });

    await expect(fetchPublicDocument('https://example.com/story', {
      maxRedirects: 1,
      service: service(async () => gatewayResponse('too far', {
        hops: [publicHop(), publicHop('https://example.com/2'), publicHop('https://example.com/3')],
      }) as never),
    })).rejects.toThrow(/too_many_redirects/);
  });

  test('keeps the deadline active while consuming a slow response body', async () => {
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        controller.enqueue(new TextEncoder().encode('late'));
        controller.close();
      },
    });
    await expect(fetchPublicDocument('https://example.com/story', {
      timeoutMs: 5,
      service: service(async () => gatewayResponse(body, { hops: [publicHop()] }) as never),
    })).rejects.toThrow(/gateway_timeout/);
  });

  test('enforces an incremental cap on chunked bodies before buffering the whole response', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('123'));
        controller.enqueue(new TextEncoder().encode('456'));
        controller.close();
      },
    });
    await expect(fetchPublicDocument('https://example.com/story', {
      maxBytes: 4,
      service: service(async () => gatewayResponse(body, { hops: [publicHop()] }) as never),
    })).rejects.toThrow(/response_too_large/);
  });

  test('accepts PDF only as bounded trusted pdf_text extraction, never as decoded binary bytes', async () => {
    const pdfText = await fetchPublicDocument('https://www.sanders.senate.gov/letter.pdf', {
      service: service(async () => gatewayResponse('Senator Sanders asks three AI company leaders to pause development.', {
        hops: [publicHop('https://www.sanders.senate.gov/letter.pdf')],
        source_content_type: 'application/pdf', extraction: 'pdf_text',
      }) as never),
    });
    expect(pdfText).toMatchObject({ content_type: 'application/pdf', extraction: 'pdf_text' });

    await expect(fetchPublicDocument('https://www.sanders.senate.gov/letter.pdf', {
      service: service(async () => gatewayResponse('%PDF-1.7\u0000binary', {
        hops: [publicHop('https://www.sanders.senate.gov/letter.pdf')],
        source_content_type: 'application/pdf', extraction: 'binary',
      }) as never),
    })).rejects.toThrow(/invalid_pdf_extraction/);
  });

  test('validates open-web search response schema and target URLs through the same fixed origin', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ results: [{
      url: 'https://www.axios.com/story', title: 'Independent report', snippet: 'Report text.',
      published_at: '2026-08-10T12:00:00Z',
    }] }), { headers: { 'Content-Type': 'application/json' } }));
    const results = await searchPublicWeb({ text: 'AI pause request', date: '2026-08-11' }, {
      service: service(fetcher as typeof fetch),
    });
    expect(results).toEqual([{
      url: 'https://www.axios.com/story', title: 'Independent report', snippet: 'Report text.',
      published_at: '2026-08-10T12:00:00.000Z',
    }]);
    expect(String(fetcher.mock.calls[0][0])).toBe('https://research-gateway.example/v1/search');

    await expect(searchPublicWeb({ text: 'x', date: '2026-08-11' }, {
      service: service(async () => new Response(JSON.stringify({ results: [{
        url: 'http://127.0.0.1/admin', title: 'bad', snippet: 'bad', published_at: null,
      }] }), { headers: { 'Content-Type': 'application/json' } }) as never),
    })).rejects.toThrow(/invalid_search_response/);
  });
});
