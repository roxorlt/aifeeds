import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { Log, LogLevel, Miniflare } from 'miniflare';
import { expect, test } from 'vitest';

const workerRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

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
            service: { origin: 'https://research-gateway.example', token: 'test-token' },
          });
          return Response.json({ ok: true, url: document.url, bytes: document.bytes });
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
  const audit = encodeURIComponent(JSON.stringify({
    hops: [{
      url: 'https://example.com/',
      validated_ip: '93.184.216.34',
      connected_ip: '93.184.216.34',
    }],
    source_content_type: 'text/html',
    extraction: 'html',
    requested_limits: {
      source_bytes: 8_388_608,
      extracted_text_bytes: 2_097_152,
      extracted_text_characters: 1_000_000,
    },
    applied_limits: {
      source_bytes: 8_388_608,
      extracted_text_bytes: 2_097_152,
      extracted_text_characters: 1_000_000,
    },
    actual_sizes: {
      source_bytes: bytes,
      extracted_text_bytes: bytes,
      extracted_text_characters: body.length,
    },
    truncation: { source: false, extracted_text: false },
    parser: { result: 'success', version: 'workerd-test/1.0' },
  }));
  let gatewayCalls = 0;
  const miniflare = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: '2024-12-01',
    compatibilityFlags: ['nodejs_compat'],
    outboundService: async () => {
      gatewayCalls += 1;
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
      bytes,
    });
    expect(gatewayCalls).toBe(1);
  } finally {
    await miniflare.dispose();
  }
}, 15_000);
