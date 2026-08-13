import { describe, expect, test, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  fetchPublicDocument,
  isPublicIpAddress,
  searchPublicWeb,
  validatePublicHttpUrl,
  type TrustedResearchService,
} from './safe-url-fetch';

const responseSecret = '11'.repeat(32);
const requestNonce = '22'.repeat(16);
const protocolNow = Date.parse('2026-08-12T00:00:00.000Z');
const requestTimestamp = new Date(protocolNow).toISOString();
const responseProfile = 'proof_excerpt_v1';
const responseHmacContract = 'hmac-sha256-canonical-json-all-fields-except-response_hmac-v1';
const proofExcerptAlgorithm = 'utf8-nfc-ws1-codepoint-prefix-v1';
const goldenFixtureSha256 = '213f5b82e0e89d6c66b7c41d7d44824eea77196b5ee032c8b02e971adffb5a4c';
const expectedExtractionModes = ['article_text', 'text', 'json', 'pdf_text'] as const;
type GoldenExtractionMode = typeof expectedExtractionModes[number];
const goldenFixturePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../workflows/aifeeds-daily/fixtures/proof-excerpt-v1-golden.json',
);
const goldenFixtureRaw = readFileSync(goldenFixturePath);
const goldenFixture = JSON.parse(goldenFixtureRaw.toString('utf8')) as {
  contract: string;
  algorithm: string;
  max_code_points: number;
  response_hmac_contract: string;
  extraction_modes?: GoldenExtractionMode[];
  whitespace_code_points: string[];
  vectors: Array<{
    name: string;
    input: {
      text?: string; repeat?: number; left?: string; right?: string;
      code_points_between?: string[];
      segments?: Array<{ text: string; repeat?: number }>;
    };
    expected: {
      excerpt: { text: string; repeat?: number };
      code_points: number;
      utf8_bytes: number;
      sha256: string;
    };
  }>;
};

function referenceProofExcerpt(value: string): string {
  return Array.from(value.normalize('NFC')
    .replace(/[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/gu, ' ')
    .replace(/^ +| +$/gu, ''))
    .slice(0, 3_000)
    .join('')
    .replace(/ +$/gu, '');
}

function expandGoldenText(value: {
  text?: string; repeat?: number; left?: string; right?: string;
  code_points_between?: string[];
  segments?: Array<{ text: string; repeat?: number }>;
}): string {
  if (value.segments) {
    return value.segments.map((segment) => segment.text.repeat(segment.repeat || 1)).join('');
  }
  if (value.code_points_between) {
    return `${value.left || ''}${value.code_points_between
      .map((codePoint) => String.fromCodePoint(Number.parseInt(codePoint, 16))).join('')}${value.right || ''}`;
  }
  return String(value.text || '').repeat(value.repeat || 1);
}

function proofExcerptClaims(body: string) {
  const excerpt = referenceProofExcerpt(body);
  return {
    contract: responseProfile,
    algorithm: proofExcerptAlgorithm,
    max: 3_000,
    sha256: createHash('sha256').update(excerpt).digest('hex'),
    utf8_bytes: new TextEncoder().encode(excerpt).byteLength,
    code_points: Array.from(excerpt).length,
  };
}

function service(fetcher: typeof fetch, overrides: Partial<TrustedResearchService> = {}): TrustedResearchService {
  return {
    origin: 'https://research-gateway.example', token: 'test-token', responseSecret, fetcher,
    protocolNow: () => protocolNow, nonceFactory: () => requestNonce, ...overrides,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

const documentLimits = {
  source_bytes: 8 * 1024 * 1024,
  extracted_text_bytes: 2 * 1024 * 1024,
  extracted_text_characters: 1_000_000,
};
const articleAppliedLimits = {
  ...documentLimits,
  extracted_text_bytes: 28_000,
  extracted_text_characters: 28_000,
};

function fetchAudit(input: {
  hops: Array<{ url: string; validated_ip: string; connected_ip: string }>;
  source_content_type?: string;
  extraction?: string;
  requested_limits?: typeof documentLimits;
  applied_limits?: typeof documentLimits;
  actual_sizes?: typeof documentLimits;
  truncation?: { source: boolean; extracted_text: boolean };
  parser?: { result: 'success' | 'failed'; version: string };
  document?: {
    title: string;
    published_at: string | null;
    selection: 'article' | 'main';
    content_complete: boolean;
  };
  protocol?: Partial<{
    protocol_version: string;
    request_nonce: string;
    request_timestamp: string;
    extracted_at: string;
    final_url: string;
    body_sha256: string;
    response_hmac: string;
  }>;
  profile?: false | Partial<{
    response_profile: string;
    response_hmac_contract: string;
    proof_excerpt: ReturnType<typeof proofExcerptClaims>;
  }>;
  body?: string;
}): string {
  const sourceContentType = input.source_content_type || 'text/html';
  const extraction = input.extraction || (sourceContentType === 'text/html'
    || sourceContentType === 'application/xhtml+xml' ? 'article_text' : 'text');
  const articleText = extraction === 'article_text';
  const body = input.body || '';
  const unsigned = {
    hops: input.hops,
    source_content_type: sourceContentType,
    extraction,
    requested_limits: input.requested_limits || documentLimits,
    applied_limits: input.applied_limits || input.requested_limits
      || (articleText ? articleAppliedLimits : documentLimits),
    actual_sizes: input.actual_sizes || { source_bytes: 12, extracted_text_bytes: 12, extracted_text_characters: 12 },
    truncation: input.truncation || { source: false, extracted_text: false },
    parser: input.parser || {
      result: 'success', version: articleText ? 'chromium/149.0.7735.12' : 'research-gateway-parser/1.0.0',
    },
    ...(articleText ? { document: input.document || {
      title: 'Validated source title', published_at: '2026-07-04T08:00:00.000Z',
      selection: 'article', content_complete: true,
    } } : {}),
    protocol_version: input.protocol?.protocol_version || 'article_text_v2',
    request_nonce: input.protocol?.request_nonce || requestNonce,
    request_timestamp: input.protocol?.request_timestamp || requestTimestamp,
    extracted_at: input.protocol?.extracted_at || requestTimestamp,
    final_url: input.protocol?.final_url || input.hops.at(-1)!.url,
    body_sha256: input.protocol?.body_sha256 || createHash('sha256').update(body).digest('hex'),
    ...(input.profile === false ? {} : {
      response_profile: input.profile?.response_profile || responseProfile,
      response_hmac_contract: input.profile?.response_hmac_contract || responseHmacContract,
      proof_excerpt: input.profile?.proof_excerpt || proofExcerptClaims(body),
    }),
  };
  const audit = {
    ...unsigned,
    response_hmac: input.protocol?.response_hmac
      || createHmac('sha256', Buffer.from(responseSecret, 'hex')).update(canonicalJson(unsigned)).digest('hex'),
  };
  return encodeURIComponent(JSON.stringify(audit));
}

function gatewayResponse(body: BodyInit | null, input: Parameters<typeof fetchAudit>[0], headers: Record<string, string> = {}) {
  const bodyText = typeof body === 'string' ? body : null;
  const bodyBytes = bodyText === null ? null : new TextEncoder().encode(bodyText).byteLength;
  const auditInput = bodyText === null || input.actual_sizes
    ? input
    : {
      ...input,
      body: bodyText,
      actual_sizes: {
        source_bytes: bodyBytes!,
        extracted_text_bytes: bodyBytes!,
        extracted_text_characters: Array.from(bodyText).length,
      },
    };
  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-AIFeeds-Fetch-Audit': fetchAudit({ ...auditInput, body: bodyText || '' }),
      ...headers,
    },
  });
}

const publicHop = (url = 'https://example.com/story') => ({
  url, validated_ip: '93.184.216.34', connected_ip: '93.184.216.34',
});

describe('trusted manual-news research boundary', () => {
  test.each([
    ['unspecified IPv4', '0.0.0.1'],
    ['private IPv4', '10.2.3.4'],
    ['shared address space', '100.64.0.1'],
    ['loopback IPv4', '127.1.2.3'],
    ['link-local IPv4', '169.254.1.1'],
    ['IETF protocol assignments', '192.0.0.9'],
    ['documentation IPv4 TEST-NET-1', '192.0.2.1'],
    ['6to4 relay anycast', '192.88.99.1'],
    ['private IPv4 192.168', '192.168.1.1'],
    ['benchmark IPv4', '198.18.0.1'],
    ['documentation IPv4 TEST-NET-2', '198.51.100.1'],
    ['documentation IPv4 TEST-NET-3', '203.0.113.1'],
    ['multicast IPv4', '224.0.0.1'],
    ['reserved IPv4', '240.0.0.1'],
    ['unspecified IPv6', '::'],
    ['loopback IPv6', '::1'],
    ['discard-only IPv6', '100::1'],
    ['documentation IPv6', '2001:db8::1'],
    ['benchmark IPv6', '2001:2::1'],
    ['site-local IPv6', 'fec0::1'],
    ['unique-local IPv6', 'fd00::1'],
    ['link-local IPv6', 'fe80::1'],
    ['multicast IPv6', 'ff02::1'],
    ['future/reserved IPv6', '4000::1'],
    ['documentation IPv6 3fff', '3fff::1'],
    ['segment-routing SIDs', '5f00::1'],
    ['IPv4 mapped private', '::ffff:10.0.0.1'],
    ['IPv4 compatible private', '::10.0.0.1'],
    ['NAT64 well-known private', '64:ff9b::a00:1'],
    ['NAT64 local-use private', '64:ff9b:1:a00:0:100::'],
    ['6to4 private', '2002:0a00:0001::'],
    ['Teredo private client', '2001:0:808:808::f5ff:fffe'],
  ])('rejects non-global-unicast %s (%s)', (_label, address) => {
    expect(isPublicIpAddress(address)).toBe(false);
  });

  test.each([
    ['public IPv4', '8.8.8.8'],
    ['public IPv4 documentation host replacement', '93.184.216.34'],
    ['public IPv6 Cloudflare', '2606:4700:4700::1111'],
    ['public IPv6 Google', '2001:4860:4860::8888'],
    ['IPv4 mapped public', '::ffff:8.8.8.8'],
    ['IPv4 compatible public', '::8.8.8.8'],
    ['NAT64 well-known public', '64:ff9b::808:808'],
    ['NAT64 local-use public', '64:ff9b:1:808:8:800::'],
    ['6to4 public', '2002:0808:0808::'],
    ['Teredo public server and client', '2001:0:808:808::f7f7:f7f7'],
  ])('accepts recursively validated global-unicast %s (%s)', (_label, address) => {
    expect(isPublicIpAddress(address)).toBe(true);
  });

  test('applies the same global-unicast policy to literal URLs and gateway peer audits', async () => {
    expect(() => validatePublicHttpUrl('https://[64:ff9b::a00:1]/story')).toThrow(/unsafe_url:literal_address/);
    await expect(fetchPublicDocument('https://example.com/story', {
      service: service(async () => gatewayResponse('blocked', {
        hops: [{ ...publicHop(), validated_ip: '64:ff9b::a00:1', connected_ip: '64:ff9b::a00:1' }],
      }) as never),
    })).rejects.toThrow(/unsafe_gateway_audit:peer_mismatch/);
  });

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
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      url: 'https://example.com/story',
      limits: documentLimits,
      max_redirects: 3,
      extraction_mode: 'article_text_v2',
      response_profile: 'proof_excerpt_v1',
      request_nonce: requestNonce,
      request_timestamp: requestTimestamp,
    });
  });

  test('requests and exposes a signed complete Chromium article_text_v2 document contract', async () => {
    const body = 'Alibaba reportedly bans employees from using Claude Code. Full article context remains intact.';
    const fetcher = vi.fn(async () => gatewayResponse(body, {
      hops: [publicHop()],
      document: {
        title: 'Alibaba reportedly bans employees from using Claude Code | TechCrunch',
        published_at: '2026-07-04T08:00:00.000Z',
        selection: 'article', content_complete: true,
      },
    }));

    const document = await fetchPublicDocument('https://example.com/story', {
      service: service(fetcher as typeof fetch),
    });

    expect(document).toMatchObject({
      extraction: 'article_text',
      title: 'Alibaba reportedly bans employees from using Claude Code | TechCrunch',
      published_at: '2026-07-04T08:00:00.000Z',
      content_complete: true,
      selection: 'article',
      excerpt: body,
      fetch_audit: {
        extraction: 'article_text',
        applied_limits: articleAppliedLimits,
        parser: { result: 'success', version: 'chromium/149.0.7735.12' },
        protocol_version: 'article_text_v2',
        request_nonce: requestNonce,
        final_url: 'https://example.com/story',
      },
    });
  });

  test('negotiates proof_excerpt_v1 and returns only the independently derived excerpt', async () => {
    const completeBody = `${'A'.repeat(3_001)} COMPLETE-BODY-TAIL-SENTINEL`;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        extraction_mode: 'article_text_v2', response_profile: responseProfile,
      });
      return gatewayResponse(completeBody, { hops: [publicHop()], profile: {} });
    });

    const document = await fetchPublicDocument('https://example.com/story', {
      service: service(fetcher as typeof fetch),
    });

    expect(document).toMatchObject({
      excerpt: 'A'.repeat(3_000),
      fetch_audit: {
        response_profile: responseProfile,
        response_hmac_contract: responseHmacContract,
        proof_excerpt: proofExcerptClaims(completeBody),
      },
    });
    expect(document).not.toHaveProperty('body');
    expect(JSON.stringify(document)).not.toContain('COMPLETE-BODY-TAIL-SENTINEL');
  });

  test('pins the byte-identical HK proof_excerpt_v1 golden schema and checksum', () => {
    expect(createHash('sha256').update(goldenFixtureRaw).digest('hex')).toBe(goldenFixtureSha256);
    expect(Object.keys(goldenFixture)).toEqual([
      'contract', 'algorithm', 'max_code_points', 'response_hmac_contract',
      'extraction_modes', 'whitespace_code_points', 'vectors',
    ]);
    expect(goldenFixture).toMatchObject({
      contract: responseProfile,
      algorithm: proofExcerptAlgorithm,
      max_code_points: 3_000,
      response_hmac_contract: responseHmacContract,
      extraction_modes: expectedExtractionModes,
    });
    expect(new Set(goldenFixture.vectors.map((vector) => vector.name)).size)
      .toBe(goldenFixture.vectors.length);
    for (const vector of goldenFixture.vectors) {
      expect(Object.keys(vector), vector.name).toEqual(['name', 'input', 'expected']);
      expect(Object.keys(vector.expected), vector.name)
        .toEqual(['excerpt', 'code_points', 'utf8_bytes', 'sha256']);
      expect(vector.name, vector.name).toMatch(/^[a-z0-9-]+$/);
      expect(vector.expected.code_points, vector.name).toBeGreaterThan(0);
      expect(vector.expected.utf8_bytes, vector.name).toBeGreaterThan(0);
      expect(vector.expected.sha256, vector.name).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(goldenFixture.vectors.find((vector) => vector.name === 'emoji-zwj-sequence')).toEqual({
      name: 'emoji-zwj-sequence',
      input: { text: '研究 👩‍💻 协作' },
      expected: {
        excerpt: { text: '研究 👩‍💻 协作' },
        code_points: 9,
        utf8_bytes: 25,
        sha256: 'a741431324b910330a9abbcb136bca40bfdc1b621f700a06638ce25755b53b1b',
      },
    });
  });

  test('matches every proof_excerpt_v1 extraction mode and vector from the artifact', async () => {
    expect(goldenFixture.extraction_modes).toEqual(expectedExtractionModes);
    for (const extraction of goldenFixture.extraction_modes!) {
      const sourceContentType = {
        article_text: 'text/html', text: 'text/plain', json: 'application/json', pdf_text: 'application/pdf',
      }[extraction];
      for (const vector of goldenFixture.vectors) {
        const body = expandGoldenText(vector.input);
        const expected = expandGoldenText(vector.expected.excerpt);
        const document = await fetchPublicDocument('https://example.com/story', {
          service: service(async () => gatewayResponse(body, {
            hops: [publicHop()], source_content_type: sourceContentType, extraction, profile: {},
            ...(extraction === 'article_text' ? {
              document: {
                title: 'Golden vector', published_at: null,
                selection: 'article' as const, content_complete: true as const,
              },
            } : {}),
          }) as never),
        });
        expect(document.excerpt, vector.name).toBe(expected);
        expect(document.fetch_audit.proof_excerpt, vector.name).toEqual({
          contract: goldenFixture.contract,
          algorithm: goldenFixture.algorithm,
          max: goldenFixture.max_code_points,
          sha256: vector.expected.sha256,
          utf8_bytes: vector.expected.utf8_bytes,
          code_points: vector.expected.code_points,
        });
      }
    }
  });

  test('fails closed when the negotiated profile is absent or its signed excerpt claims are substituted', async () => {
    const body = 'Signed complete body.';
    await expect(fetchPublicDocument('https://example.com/story', {
      service: service(async () => gatewayResponse(body, { hops: [publicHop()], profile: false }) as never),
    })).rejects.toThrow(/unsafe_gateway_audit:(invalid_schema|profile)/);

    await expect(fetchPublicDocument('https://example.com/story', {
      service: service(async () => gatewayResponse(body, {
        hops: [publicHop()],
        profile: { proof_excerpt: { ...proofExcerptClaims(body), sha256: '00'.repeat(32) } },
      }) as never),
    })).rejects.toThrow(/unsafe_gateway_audit:proof_excerpt/);
  });

  test.each([
    ['text/plain', 'text'],
    ['application/json', 'json'],
    ['application/pdf', 'pdf_text'],
  ])('accepts a max-size signed %s %s body without retaining its tail', async (sourceType, extraction) => {
    const tail = '🔒MAX-BODY-TAIL-SENTINEL';
    const completeBody = `${'😀'.repeat(524_281)}${tail}`;
    const bytes = new TextEncoder().encode(completeBody).byteLength;
    expect(bytes).toBeLessThanOrEqual(documentLimits.extracted_text_bytes);
    const document = await fetchPublicDocument('https://example.com/story', {
      service: service(async () => gatewayResponse(completeBody, {
        hops: [publicHop()], source_content_type: sourceType, extraction, profile: {},
        actual_sizes: {
          source_bytes: sourceType === 'application/pdf' ? 8_000_000 : bytes,
          extracted_text_bytes: bytes,
          extracted_text_characters: Array.from(completeBody).length,
        },
      }) as never),
    });
    expect(Array.from(document.excerpt)).toHaveLength(3_000);
    expect(JSON.stringify(document)).not.toContain(tail);
  });

  test('rejects legacy HTML and forged or incomplete article_text audits for the opt-in request', async () => {
    const body = 'Complete article text.';
    const cases = [
      { extraction: 'html' },
      { parser: { result: 'success' as const, version: 'research-gateway-parser/1.0.0' } },
      { document: { title: 'Title', published_at: null, selection: 'article' as const, content_complete: false } },
      { document: { title: '', published_at: null, selection: 'article' as const, content_complete: true } },
      { document: { title: 'Title', published_at: 'July 4', selection: 'article' as const, content_complete: true } },
      { document: { title: 'Title', published_at: null, selection: 'main' as const, content_complete: true },
        applied_limits: documentLimits },
    ];
    for (const mutation of cases) {
      await expect(fetchPublicDocument('https://example.com/story', {
        service: service(async () => gatewayResponse(body, {
          hops: [publicHop()], ...mutation,
        }) as never),
      })).rejects.toThrow(/unsafe_gateway_audit/);
    }
  });

  test('fails closed before outbound document fetch when the response HMAC dependency is absent or malformed', async () => {
    const fetcher = vi.fn();
    for (const responseSecretValue of [undefined, '', 'aa', 'AA'.repeat(32)]) {
      await expect(fetchPublicDocument('https://example.com/story', {
        service: service(fetcher as typeof fetch, { responseSecret: responseSecretValue }),
      })).rejects.toThrow(/trusted_research_response_secret_required/);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  test('rejects v2 nonce, timestamp, final URL, body digest, HMAC, and Chromium version tampering', async () => {
    const body = 'Alibaba reportedly bans employees from using Claude Code.';
    const cases: Array<{ protocol?: Parameters<typeof fetchAudit>[0]['protocol']; parser?: { result: 'success'; version: string } }> = [
      { protocol: { request_nonce: '33'.repeat(16) } },
      { protocol: { request_timestamp: '2026-08-11T23:59:59.000Z' } },
      { protocol: { extracted_at: '2026-08-11T23:50:00.000Z' } },
      { protocol: { extracted_at: '2026-08-12T00:01:00.000Z' } },
      { protocol: { final_url: 'https://example.com/other' } },
      { protocol: { body_sha256: '00'.repeat(32) } },
      { protocol: { response_hmac: '00'.repeat(32) } },
      { protocol: { protocol_version: 'article_text_v1' } },
      { parser: { result: 'success', version: 'chromium/1.0.0.0' } },
      { parser: { result: 'success', version: 'chromium/149' } },
    ];
    for (const mutation of cases) {
      await expect(fetchPublicDocument('https://example.com/story', {
        service: service(async () => gatewayResponse(body, {
          hops: [publicHop()], ...mutation,
        }) as never),
      })).rejects.toThrow(/unsafe_gateway_audit/);
    }
  });

  test('rejects a replayed v2 response bound to a prior request nonce', async () => {
    const body = 'Complete article text.';
    await expect(fetchPublicDocument('https://example.com/story', {
      service: service(async () => gatewayResponse(body, {
        hops: [publicHop()], protocol: { request_nonce: requestNonce },
      }) as never, { nonceFactory: () => '44'.repeat(16) }),
    })).rejects.toThrow(/unsafe_gateway_audit:protocol/);
  });

  test('rejects unsafe invisible or over-cap article text instead of accepting a truncated prefix', async () => {
    for (const body of [
      'Alibaba reportedly bans employees\u200b from using Claude Code.',
      'क\u200dष'.repeat(10),
      'x'.repeat(28_001),
      '界'.repeat(9_334),
    ]) {
      const bytes = new TextEncoder().encode(body).byteLength;
      await expect(fetchPublicDocument('https://example.com/story', {
        service: service(async () => gatewayResponse(body, {
          hops: [publicHop()],
          actual_sizes: {
            source_bytes: bytes,
            extracted_text_bytes: bytes,
            extracted_text_characters: Array.from(body).length,
          },
        }) as never),
      })).rejects.toThrow(/unsafe_gateway_(audit|article_text)/);
    }
  });

  test('calls the Worker intrinsic fetch lexically when no gateway fetcher is injected', async () => {
    const receiverAwareFetch = vi.fn(function (this: unknown) {
      if (this !== undefined) {
        throw new TypeError('Illegal invocation: function called with incorrect this reference');
      }
      return Promise.resolve(new Response(JSON.stringify({ results: [] }), {
        headers: { 'Content-Type': 'application/json' },
      }));
    });
    vi.stubGlobal('fetch', receiverAwareFetch);
    try {
      await expect(searchPublicWeb({ text: 'Anthropic watermark', date: '2026-08-11' }, {
        service: { origin: 'https://research-gateway.example', token: 'test-token' },
      })).resolves.toEqual([]);
      expect(receiverAwareFetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
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
    expect(document).toMatchObject({ url: 'https://www.example.com/final', redirects: 1, excerpt: '<p>final</p>' });

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
      service: service(async () => gatewayResponse(body, {
        hops: [publicHop()],
        actual_sizes: { source_bytes: 4, extracted_text_bytes: 4, extracted_text_characters: 4 },
      }) as never),
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
      service: service(async () => gatewayResponse(body, {
        hops: [publicHop()],
        requested_limits: { ...documentLimits, extracted_text_bytes: 4 },
        applied_limits: {
          ...articleAppliedLimits,
          extracted_text_bytes: 4,
        },
        actual_sizes: { source_bytes: 4, extracted_text_bytes: 4, extracted_text_characters: 4 },
      }) as never),
    })).rejects.toThrow(/response_too_large/);
  });

  test('rejects missing or inconsistent bounded-extraction audit fields', async () => {
    const oldAudit = encodeURIComponent(JSON.stringify({
      hops: [publicHop()], source_content_type: 'text/html', extraction: 'html',
    }));
    await expect(fetchPublicDocument('https://example.com/story', {
      service: service(async () => new Response('text', { headers: {
        'Content-Type': 'text/plain', 'X-AIFeeds-Fetch-Audit': oldAudit,
      } }) as never),
    })).rejects.toThrow(/unsafe_gateway_audit:invalid_schema/);

    await expect(fetchPublicDocument('https://example.com/story', {
      service: service(async () => gatewayResponse('text', {
        hops: [publicHop()],
        applied_limits: { ...documentLimits, source_bytes: documentLimits.source_bytes + 1 },
      }) as never),
    })).rejects.toThrow(/unsafe_gateway_audit:limit_mismatch/);
  });

  test('rejects oversized audited source or extracted sizes and any truncation', async () => {
    for (const input of [
      { actual_sizes: { ...documentLimits, source_bytes: documentLimits.source_bytes + 1 } },
      { actual_sizes: { ...documentLimits, extracted_text_bytes: documentLimits.extracted_text_bytes + 1 } },
      { truncation: { source: true, extracted_text: false } },
      { truncation: { source: false, extracted_text: true } },
    ]) {
      await expect(fetchPublicDocument('https://example.com/story', {
        service: service(async () => gatewayResponse('text', { hops: [publicHop()], ...input }) as never),
      })).rejects.toThrow(/unsafe_gateway_audit:(actual_size|truncated)/);
    }
  });

  test('rejects parser failure and a body whose actual size disagrees with the signed audit', async () => {
    await expect(fetchPublicDocument('https://example.com/story', {
      service: service(async () => gatewayResponse('text', {
        hops: [publicHop()], parser: { result: 'failed', version: 'pdf-parser/4.2.0' },
      }) as never),
    })).rejects.toThrow(/unsafe_gateway_audit:parser_failed/);

    await expect(fetchPublicDocument('https://example.com/story', {
      service: service(async () => gatewayResponse('actual text', {
        hops: [publicHop()],
        actual_sizes: { source_bytes: 11, extracted_text_bytes: 4, extracted_text_characters: 4 },
      }) as never),
    })).rejects.toThrow(/unsafe_gateway_audit:body_size_mismatch/);
  });

  test('accepts PDF only with a complete, internally consistent bounded extraction audit', async () => {
    const pdfBody = 'Senator Sanders asks three AI company leaders to pause development.';
    const pdfBytes = new TextEncoder().encode(pdfBody).byteLength;
    const pdfText = await fetchPublicDocument('https://www.sanders.senate.gov/letter.pdf', {
      service: service(async () => gatewayResponse(pdfBody, {
        hops: [publicHop('https://www.sanders.senate.gov/letter.pdf')],
        source_content_type: 'application/pdf', extraction: 'pdf_text',
        actual_sizes: {
          source_bytes: 48_000,
          extracted_text_bytes: pdfBytes,
          extracted_text_characters: Array.from(pdfBody).length,
        },
      }) as never),
    });
    expect(pdfText).toMatchObject({
      content_type: 'application/pdf', extraction: 'pdf_text',
      fetch_audit: {
        requested_limits: documentLimits,
        applied_limits: documentLimits,
        actual_sizes: { source_bytes: 48_000, extracted_text_bytes: pdfBytes },
        truncation: { source: false, extracted_text: false },
        parser: { result: 'success', version: 'research-gateway-parser/1.0.0' },
      },
    });

    await expect(fetchPublicDocument('https://www.sanders.senate.gov/letter.pdf', {
      service: service(async () => gatewayResponse('%PDF-1.7\u0000binary', {
        hops: [publicHop('https://www.sanders.senate.gov/letter.pdf')],
        source_content_type: 'application/pdf', extraction: 'binary',
      }) as never),
    })).rejects.toThrow(/invalid_pdf_extraction/);
  });

  test.each([
    ['text/plain', 'text', 'Plain trusted document.'],
    ['application/json', 'json', '{"ok":true}'],
  ])('keeps signed v2 envelope verification for non-HTML %s documents', async (sourceType, extraction, body) => {
    const document = await fetchPublicDocument('https://example.com/story', {
      service: service(async () => gatewayResponse(body, {
        hops: [publicHop()], source_content_type: sourceType, extraction,
      }) as never),
    });
    expect(document).toMatchObject({
      content_type: sourceType, extraction, excerpt: body,
      fetch_audit: { protocol_version: 'article_text_v2', body_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
  });

  test('uses an edge-supported manual redirect mode and rejects gateway redirects without following them', async () => {
    const edgeStrictFetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.redirect === 'error') {
        throw new TypeError('Invalid redirect value, must be one of "follow" or "manual"');
      }
      expect(init?.redirect).toBe('manual');
      return new Response(null, {
        status: 302,
        headers: { Location: 'https://untrusted.example/v1/search' },
      });
    });

    await expect(searchPublicWeb({ text: 'Anthropic watermark', date: '2026-08-11' }, {
      service: service(edgeStrictFetcher as typeof fetch),
    })).rejects.toThrow(/trusted_gateway_http_302/);
    expect(edgeStrictFetcher).toHaveBeenCalledTimes(1);
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
