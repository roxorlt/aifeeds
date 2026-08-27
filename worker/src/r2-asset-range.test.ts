import { describe, expect, test, vi } from 'vitest';

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

vi.mock('./digest/publication-release', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./digest/publication-release')>();
  return { ...actual, readAuthorizedDailyVideoObject: vi.fn() };
});

import worker, { type Env } from './index';
import { readAuthorizedDailyVideoObject } from './digest/publication-release';

const KEY = 'podcast/seek-fixture.mp3';
const ASSET = new TextEncoder().encode('0123456789');

type TestRange = { offset?: number; length?: number; suffix?: number };

function metadataObject() {
  return {
    key: KEY,
    size: ASSET.byteLength,
    etag: 'fixture-etag',
    httpEtag: '"fixture-etag"',
    uploaded: new Date('2026-07-13T00:00:00.000Z'),
    httpMetadata: { contentType: 'audio/mpeg' },
    customMetadata: {},
    writeHttpMetadata(headers: Headers) {
      headers.set('Content-Type', 'audio/mpeg');
    },
  };
}

function createBucket() {
  const head = vi.fn(async (key: string) => key === KEY ? metadataObject() : null);
  const get = vi.fn(async (key: string, options?: { range?: TestRange }) => {
    if (key !== KEY) return null;

    const requested = options?.range;
    let offset = 0;
    let length = ASSET.byteLength;
    if (requested) {
      if (requested.suffix !== undefined) {
        if (requested.suffix <= 0 || requested.suffix > ASSET.byteLength) {
          throw new RangeError('unsatisfiable suffix');
        }
        offset = ASSET.byteLength - requested.suffix;
        length = requested.suffix;
      } else {
        offset = requested.offset ?? 0;
        length = requested.length ?? ASSET.byteLength - offset;
        if (offset < 0 || offset >= ASSET.byteLength || length <= 0) {
          throw new RangeError('unsatisfiable range');
        }
      }
    }

    const body = new Response(ASSET.slice(offset, offset + length)).body;
    return {
      ...metadataObject(),
      body,
      range: requested,
    };
  });

  return {
    bucket: { head, get } as unknown as R2Bucket,
    head,
    get,
  };
}

async function requestAsset(
  method: 'GET' | 'HEAD' | 'OPTIONS',
  bucket: R2Bucket,
  range?: string,
  key = KEY,
  referer?: string,
): Promise<Response> {
  const headers = new Headers();
  if (range !== undefined) headers.set('Range', range);
  if (referer !== undefined) headers.set('Referer', referer);
  return worker.fetch(
    new Request(`https://api.ai-feeds.com/r/${key}`, { method, headers }),
    { READMES: bucket } as unknown as Env,
    {} as ExecutionContext,
  );
}

function expectPublicAssetHeaders(response: Response): void {
  expect(response.headers.get('Content-Type')).toBe('audio/mpeg');
  expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  expect(response.headers.get('Timing-Allow-Origin')).toBe('*');
  expect(response.headers.get('Accept-Ranges')).toBe('bytes');
  expect(response.headers.get('ETag')).toBe('"fixture-etag"');
}

describe('Worker /r/* HEAD and single byte-range contract', () => {
  test('virtual daily video path uses the authorized full-byte reader before serving Range', async () => {
    vi.mocked(readAuthorizedDailyVideoObject).mockResolvedValue({
      bytes: ASSET, mime: 'video/mp4', sha256: 'a'.repeat(64), size: ASSET.byteLength,
    });
    const { bucket, head, get } = createBucket();
    const id = 'b'.repeat(64);
    const response = await requestAsset('GET', bucket, 'bytes=2-5', `daily-video/public/${id}/mp4`);
    expect(response.status).toBe(206);
    expect(await response.text()).toBe('2345');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(readAuthorizedDailyVideoObject).toHaveBeenCalledWith(expect.anything(), id, 'mp4');
    expect(head).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  test.each([
    ['GET', 'daily/versions/a/page.html', undefined, undefined],
    ['HEAD', 'daily/publications/a/page.html', undefined, 'https://ai-feeds.com/daily/2026-08-27'],
    ['GET', 'daily/2026-08-27.html', 'bytes=0-10', 'https://attacker.example/'],
    ['GET', 'daily-video/candidates/a/video.mp4', 'bytes=0-10', undefined],
    ['HEAD', 'daily-video/private/a/poster.jpg', undefined, 'https://api.ai-feeds.com/'],
    ['GET', 'daily-video/a/video.mp4', undefined, 'https://aifeeds.workers.dev/'],
    ['OPTIONS', 'daily/versions/a/page.html', undefined, undefined],
  ] as const)(
    '%s permanently hides publication namespace %s before any R2 read',
    async (method, key, range, referer) => {
      const { bucket, head, get } = createBucket();
      const response = await requestAsset(method, bucket, range, key, referer);

      expect(response.status).toBe(404);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(head).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
    },
  );

  test.each(['GET', 'HEAD'] as const)(
    '%s permanently hides private cc immutable page versions before any R2 read',
    async (method) => {
      const { bucket, head, get } = createBucket();
      const response = await requestAsset(
        method,
        bucket,
        undefined,
        'cc-item-pages/news/blog%3Aitem/abc.html',
      );

      expect(response.status).toBe(404);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(head).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
    },
  );

  test('HEAD reads metadata only, returns no body, and preserves public asset headers', async () => {
    const { bucket, head, get } = createBucket();

    const response = await requestAsset('HEAD', bucket);

    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(await response.text()).toBe('');
    expect(response.headers.get('Content-Length')).toBe(String(ASSET.byteLength));
    expectPublicAssetHeaders(response);
    expect(head).toHaveBeenCalledOnce();
    expect(head).toHaveBeenCalledWith(KEY);
    expect(get).not.toHaveBeenCalled();
  });

  test('ordinary GET keeps the existing full-body cache and CORS behavior', async () => {
    const { bucket, head, get } = createBucket();

    const response = await requestAsset('GET', bucket);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('0123456789');
    expectPublicAssetHeaders(response);
    expect(head).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledWith(KEY);
  });

  test.each([
    {
      label: 'bounded',
      header: 'bytes=2-5',
      expectedRange: { offset: 2, length: 4 },
      contentRange: 'bytes 2-5/10',
      body: '2345',
    },
    {
      label: 'open ended',
      header: 'bytes=6-',
      expectedRange: { offset: 6, length: 4 },
      contentRange: 'bytes 6-9/10',
      body: '6789',
    },
    {
      label: 'suffix',
      header: 'bytes=-3',
      expectedRange: { offset: 7, length: 3 },
      contentRange: 'bytes 7-9/10',
      body: '789',
    },
    {
      label: 'end past representation is clipped',
      header: 'bytes=7-99',
      expectedRange: { offset: 7, length: 3 },
      contentRange: 'bytes 7-9/10',
      body: '789',
    },
    {
      label: 'oversized suffix selects the whole representation',
      header: 'bytes=-99',
      expectedRange: { offset: 0, length: 10 },
      contentRange: 'bytes 0-9/10',
      body: '0123456789',
    },
    {
      label: 'arbitrarily large end is clipped without numeric precision loss',
      header: 'bytes=7-999999999999999999999999999999999999',
      expectedRange: { offset: 7, length: 3 },
      contentRange: 'bytes 7-9/10',
      body: '789',
    },
    {
      label: 'arbitrarily large suffix selects the whole representation',
      header: 'bytes=-999999999999999999999999999999999999',
      expectedRange: { offset: 0, length: 10 },
      contentRange: 'bytes 0-9/10',
      body: '0123456789',
    },
  ])('valid $label single range returns 206', async ({
    header,
    expectedRange,
    contentRange,
    body,
  }) => {
    const { bucket, head, get } = createBucket();

    const response = await requestAsset('GET', bucket, header);

    expect(response.status).toBe(206);
    expect(await response.text()).toBe(body);
    expect(response.headers.get('Content-Range')).toBe(contentRange);
    expect(response.headers.get('Content-Length')).toBe(String(body.length));
    expectPublicAssetHeaders(response);
    expect(head).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledWith(KEY, { range: expectedRange });
  });

  test.each([
    ['start at representation size', 'bytes=10-'],
    ['start beyond representation size', 'bytes=11-12'],
    ['reversed bounds', 'bytes=8-5'],
    ['zero suffix', 'bytes=-0'],
    ['multiple ranges', 'bytes=0-1,3-4'],
    ['wrong unit', 'items=0-1'],
    ['empty header value', ''],
    ['missing bounds', 'bytes=-'],
    ['non-decimal bounds', 'bytes=a-b'],
    ['embedded whitespace', 'bytes= 0-1'],
    ['signed bound', 'bytes=+0-1'],
    ['unsafe integer', 'bytes=9007199254740992-'],
  ])('%s is a strict 416 and never falls back to a full GET', async (_label, range) => {
    const { bucket, head, get } = createBucket();

    const response = await requestAsset('GET', bucket, range);

    expect(response.status).toBe(416);
    expect(response.headers.get('Content-Range')).toBe(`bytes */${ASSET.byteLength}`);
    expectPublicAssetHeaders(response);
    expect(head).toHaveBeenCalledOnce();
    expect(get).not.toHaveBeenCalled();
  });
});
