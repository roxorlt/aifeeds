import fs from 'node:fs';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class {
    env: unknown;
    ctx: unknown;

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import worker, { type Env } from './index';

const source = fs.readFileSync(
  fileURLToPath(new NodeURL('./index.ts', import.meta.url)),
  'utf8',
);

describe('public media transport contract', () => {
  afterEach(() => vi.unstubAllGlobals());

  test('/media forwards a real byte range and preserves the partial response contract', async () => {
    const upstreamFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://video.twimg.com/ext_tw_video/range-fixture.mp4');
      expect(new Headers(init?.headers).get('Range')).toBe('bytes=0-1023');
      expect(init?.redirect).toBe('manual');
      expect(init).not.toHaveProperty('cf');
      return new Response(new Uint8Array(1024), {
        status: 206,
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Length': '1024',
          'Content-Range': 'bytes 0-1023/4096',
          'Accept-Ranges': 'bytes',
        },
      });
    });
    vi.stubGlobal('fetch', upstreamFetch);

    const response = await worker.fetch(
      new Request(
        'https://api.ai-feeds.com/media?url=' +
        encodeURIComponent('https://video.twimg.com/ext_tw_video/range-fixture.mp4'),
        { headers: { Range: 'bytes=0-1023' } },
      ),
      {} as Env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Length')).toBe('1024');
    expect(response.headers.get('Content-Range')).toBe('bytes 0-1023/4096');
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(new Uint8Array(await response.arrayBuffer())).toHaveLength(1024);
    expect(upstreamFetch).toHaveBeenCalledOnce();
  });

  test('/media is a dedicated video-only compatibility route', () => {
    expect(source).toMatch(/path === '\/media'/);
    expect(source).toMatch(/handleImageProxy\(request, 'video'\)/);
    expect(source).toMatch(/requestedKind === 'video' && targetUrl\.hostname !== 'video\.twimg\.com'/);
    expect(source).toMatch(/requestedKind === 'video' && redirected\.hostname !== 'video\.twimg\.com'/);
  });

  test('/img transforms only still images and preserves video Range', () => {
    const start = source.indexOf('async function handleImageProxy');
    const end = source.indexOf('// ─── Bot UA', start);
    const handler = source.slice(start, end);

    expect(handler).toMatch(/const isVideo = targetUrl\.hostname === 'video\.twimg\.com'/);
    expect(handler).toMatch(/if \(isVideo && rangeHeader\) upstreamHeaders\['Range'\] = rangeHeader/);
    expect(handler).toMatch(/const cfOptions:[\s\S]*?= isVideo\s*\? \{\}/);
    expect(handler).toMatch(/status: upstream\.status/);
    expect(handler).toMatch(/Content-Range/);
    expect(handler).toMatch(/redirect:\s*'manual'/);
    expect(handler).toMatch(/buildImageProxyCacheKey\(url, currentTarget,/);
    expect(handler).toMatch(/isAllowedImageProxyTarget\(redirected\)/);
    expect(handler).not.toMatch(/redirect:\s*'follow'/);
  });

  test('/img validates HTTPS and the host allowlist again on every redirect hop', () => {
    const allowlistStart = source.indexOf('const ALLOWED_IMG_HOSTS');
    const handlerEnd = source.indexOf('// ─── Bot UA', allowlistStart);
    const contract = source.slice(allowlistStart, handlerEnd);

    expect(contract).toMatch(/target\.protocol === 'https:'/);
    expect(contract).toMatch(/MAX_IMAGE_REDIRECTS/);
    expect(contract).toMatch(/new URL\(location, currentTarget\)/);
    expect(contract).toMatch(/return new Response\('redirect host not allowed'/);
  });

  test('/r keeps immutable still assets and byte-range audio/video seek', () => {
    const start = source.indexOf('function parseSingleByteRange');
    const handlerAndHelpers = source.slice(start);

    expect(handlerAndHelpers).toMatch(/request\.headers\.get\('Range'\)/);
    expect(handlerAndHelpers).toMatch(/READMES\.get\(key, \{ range: rangeParsed \}\)/);
    expect(handlerAndHelpers).toMatch(/status: 206/);
    expect(handlerAndHelpers).toMatch(/Content-Range/);
    expect(handlerAndHelpers).toMatch(/Accept-Ranges/);
    expect(handlerAndHelpers).toMatch(/Timing-Allow-Origin', '\*'/);
    expect(handlerAndHelpers).toMatch(/max-age=31536000, immutable/);
  });
});
