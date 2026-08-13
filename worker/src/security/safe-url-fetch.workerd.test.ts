import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac } from 'node:crypto';

import { build } from 'esbuild';
import { Log, LogLevel, Miniflare } from 'miniflare';
import { expect, test } from 'vitest';

const workerRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const responseSecret = '11'.repeat(32);

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

test('workerd rejects unsupported redirect before outbound and accepts the production manual redirect', async () => {
  const entry = `
    import { fetchPublicDocument } from './src/security/safe-url-fetch.ts';
    export default {
      async fetch(request) {
        try {
          if (new URL(request.url).searchParams.get('redirect') === 'error') {
            await fetch('https://research-gateway.example/v1/document', {
              method: 'POST',
              redirect: 'error',
              body: '{}',
            });
            return Response.json({ ok: true });
          }
          const document = await fetchPublicDocument('https://example.com/', {
            service: {
              origin: 'https://research-gateway.example', token: 'test-token',
              responseSecret: '${responseSecret}',
            },
          });
          return Response.json({ ok: true, url: document.url, excerpt: document.excerpt });
        } catch (error) {
          return Response.json({
            ok: false,
            name: error instanceof Error ? error.name : 'unknown',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
    };
  `;
  const bundle = await build({
    stdin: {
      contents: entry,
      resolveDir: workerRoot,
      sourcefile: 'safe-url-fetch-workerd-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
  });
  const body = 'Example document';
  const bytes = new TextEncoder().encode(body).byteLength;
  const auditBase = {
    hops: [{
      url: 'https://example.com/',
      validated_ip: '93.184.216.34',
      connected_ip: '93.184.216.34',
    }],
    source_content_type: 'text/html',
    extraction: 'article_text',
    requested_limits: {
      source_bytes: 8_388_608,
      extracted_text_bytes: 2_097_152,
      extracted_text_characters: 1_000_000,
    },
    applied_limits: {
      source_bytes: 8_388_608,
      extracted_text_bytes: 28_000,
      extracted_text_characters: 28_000,
    },
    actual_sizes: {
      source_bytes: bytes,
      extracted_text_bytes: bytes,
      extracted_text_characters: body.length,
    },
    truncation: { source: false, extracted_text: false },
    parser: { result: 'success', version: 'chromium/149.0.7735.12' },
    document: {
      title: 'Example document', published_at: null,
      selection: 'article', content_complete: true,
    },
  };
  let gatewayCalls = 0;
  const miniflare = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: '2024-12-01',
    compatibilityFlags: ['nodejs_compat'],
    outboundService: async (request: Request) => {
      gatewayCalls += 1;
      const payload = await request.clone().json() as {
        extraction_mode: string; response_profile: string;
        request_nonce: string; request_timestamp: string;
      };
      expect(payload).toMatchObject({
        extraction_mode: 'article_text_v2', response_profile: 'proof_excerpt_v1',
      });
      const unsigned = {
        ...auditBase,
        protocol_version: 'article_text_v2',
        request_nonce: payload.request_nonce,
        request_timestamp: payload.request_timestamp,
        extracted_at: payload.request_timestamp,
        final_url: 'https://example.com/',
        body_sha256: createHash('sha256').update(body).digest('hex'),
        response_profile: 'proof_excerpt_v1',
        response_hmac_contract: 'hmac-sha256-canonical-json-all-fields-except-response_hmac-v1',
        proof_excerpt: {
          contract: 'proof_excerpt_v1',
          algorithm: 'utf8-nfc-ws1-codepoint-prefix-v1',
          max: 3_000,
          sha256: createHash('sha256').update(body).digest('hex'),
          utf8_bytes: bytes,
          code_points: Array.from(body).length,
        },
      };
      const audit = encodeURIComponent(JSON.stringify({
        ...unsigned,
        response_hmac: createHmac('sha256', Buffer.from(responseSecret, 'hex'))
          .update(canonicalJson(unsigned)).digest('hex'),
      }));
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'X-AIFeeds-Fetch-Audit': audit,
        },
      });
    },
    log: new Log(LogLevel.NONE),
  });

  try {
    await miniflare.ready;
    const rejectedResponse = await miniflare.dispatchFetch('http://local.test/?redirect=error');
    const rejected = await rejectedResponse.json() as { ok: boolean; name?: string; message?: string };
    expect(rejected).toMatchObject({ ok: false, name: 'TypeError' });
    expect(rejected.message).toMatch(/redirect|invocation/i);
    expect(gatewayCalls).toBe(0);

    const response = await miniflare.dispatchFetch('http://local.test/');
    expect(await response.json()).toEqual({
      ok: true,
      url: 'https://example.com/',
      excerpt: body,
    });
    expect(gatewayCalls).toBe(1);
  } finally {
    await miniflare.dispose();
  }
}, 15_000);
