import { describe, expect, test, vi } from 'vitest';

import {
  CARD_IMAGE_WIDTHS,
  buildImageProxyCacheKey,
  generateCardImageVariants,
  isEligibleCardImageSource,
  negotiateImageFormat,
  normalizeImageProxyQuality,
  normalizeImageProxyWidth,
} from './card-image-variant';

function webpResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'image/webp' },
  });
}

const STATIC_WEBP_400 =
  'UklGRuAAAABXRUJQVlA4INQAAABQFwCdASqQAeEAPp1OpE4lpCOiICgAsBOJaW7hd2EbQAnsA99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ychvAA/v+4+QAAAAAAAAAAAAAAAA==';
const STATIC_WEBP_WITH_TRAILING_BYTES_800 =
  'UklGRsoCAABXRUJQVlA4IL4CAAAwUQCdASogA8IBPp1OpE4lpCOiIAgAsBOJaW7hd2EbQAnsA99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32rAAP7/uPkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

const STATIC_WEBP_800 =
  'UklGRjIAAABXRUJQVlA4TCUAAAAvH0NwAAdQ6lKXuv8BAEX6/58i+p/63//+97///e9///vf/9ADAA==';

function realStaticWebpResponse(width: 400 | 800 = 400): Response {
  return new Response(Buffer.from(width === 400 ? STATIC_WEBP_400 : STATIC_WEBP_800, 'base64'), {
    headers: { 'content-type': 'image/webp' },
  });
}

function webpVp8xResponse(width: number, height: number, animated = false): Response {
  const bytes = new Uint8Array(30);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  bytes.set(new TextEncoder().encode('WEBP'), 8);
  bytes.set(new TextEncoder().encode('VP8X'), 12);
  if (animated) bytes[20] = 0x02;
  const w = width - 1;
  const h = height - 1;
  bytes[24] = w & 0xff;
  bytes[25] = (w >>> 8) & 0xff;
  bytes[26] = (w >>> 16) & 0xff;
  bytes[27] = h & 0xff;
  bytes[28] = (h >>> 8) & 0xff;
  bytes[29] = (h >>> 16) & 0xff;
  return new Response(bytes, { headers: { 'content-type': 'image/webp' } });
}

describe('card image variant eligibility', () => {
  test('accepts only external, still-image HTTP sources', () => {
    expect(isEligibleCardImageSource({
      sourceUrl: 'https://pbs.twimg.com/media/example.jpg',
      mediaKind: 'image',
      sourceContentType: 'image/jpeg',
    })).toBe(true);

    for (const sourceUrl of [
      '/r/x/example.jpg',
      'https://api.ai-feeds.com/r/x/example.jpg',
      'https://staging-api.ai-feeds.com/r/x/example.jpg',
      'https://another-zone.workers.dev/r/x/example.jpg',
      'https://www.ai-feeds.com./r/x/example.jpg',
      'https://localhost./example.jpg',
      'http://cdn.example.com/example.jpg',
      'https://10.0.0.1/example.jpg',
      'data:image/png;base64,AA==',
      'javascript:alert(1)',
    ]) {
      expect(isEligibleCardImageSource({
        sourceUrl,
        mediaKind: 'image',
        sourceContentType: 'image/jpeg',
      }), sourceUrl).toBe(false);
    }
  });

  test('accepts GIF only as a static transform input', () => {
    expect(isEligibleCardImageSource({
      sourceUrl: 'https://cdn.example.com/launch.gif',
      mediaKind: 'image',
      sourceContentType: 'image/gif',
    })).toBe(true);
  });

  test.each([
    ['video', 'video/mp4'],
    ['audio', 'audio/mpeg'],
    ['image', 'image/svg+xml'],
  ] as const)('never transforms %s / %s assets', (mediaKind, sourceContentType) => {
    expect(isEligibleCardImageSource({
      sourceUrl: 'https://cdn.example.com/asset',
      mediaKind,
      sourceContentType,
    })).toBe(false);
  });
});

describe('card image variant generation', () => {
  test('stores immutable, width-specific WebP variants and keeps the original fallback separate', async () => {
    const puts: Array<{ key: string; value: ArrayBuffer; options: R2PutOptions }> = [];
    const bucket = {
      put: vi.fn(async (key: string, value: ArrayBuffer, options: R2PutOptions) => {
        puts.push({ key, value, options });
        return {} as R2Object;
      }),
    } as unknown as R2Bucket;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const width = Number((init as RequestInit & { cf?: { image?: { width?: number } } })?.cf?.image?.width);
      return webpResponse(`webp-${width}`);
    });

    const variants = await generateCardImageVariants(
      bucket,
      {
        sourceUrl: 'https://cdn.example.com/original-2280.jpg',
        sourcePrefix: 'x',
        mediaKind: 'image',
        sourceContentType: 'image/jpeg',
        sourceWidth: 2280,
        sourceHeight: 1452,
      },
      { fetcher },
    );

    expect(variants.map((variant) => variant.width)).toEqual([...CARD_IMAGE_WIDTHS]);
    expect(variants.every((variant) => variant.url.startsWith('/r/x/card/'))).toBe(true);
    expect(variants.every((variant) => variant.url.endsWith('.webp'))).toBe(true);
    expect(variants.map((variant) => variant.height)).toEqual([255, 509]);
    expect(variants.every((variant) => variant.format === 'webp')).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(puts).toHaveLength(2);

    const widths = fetcher.mock.calls.map(([, init]) =>
      (init as RequestInit & { cf?: { image?: { width?: number } } }).cf?.image?.width,
    );
    expect(widths).toEqual([400, 800]);
    for (const [, init] of fetcher.mock.calls) {
      const image = (init as RequestInit & {
        cf?: { image?: Record<string, unknown> };
      }).cf?.image;
      expect(image).toMatchObject({
        anim: false,
        fit: 'scale-down',
        format: 'webp',
        metadata: 'none',
        quality: 82,
      });
    }
    for (const put of puts) {
      expect(put.options.httpMetadata).toMatchObject({
        contentType: 'image/webp',
        cacheControl: 'public, max-age=31536000, immutable',
      });
    }
  });

  test('probes an extensionless GIF and transforms it with animation disabled', async () => {
    const bucket = {
      put: vi.fn(async () => ({} as R2Object)),
    } as unknown as R2Bucket;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'HEAD') {
        return new Response(null, { headers: { 'content-type': 'image/gif' } });
      }
      expect((init as RequestInit & {
        cf?: { image?: { anim?: boolean } };
      }).cf?.image?.anim).toBe(false);
      return realStaticWebpResponse();
    });

    const variants = await generateCardImageVariants(bucket, {
      sourceUrl: 'https://cdn.example.com/asset-without-extension',
      sourcePrefix: 'gh',
      mediaKind: 'image',
    }, { fetcher });

    expect(variants).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(bucket.put).toHaveBeenCalledTimes(1);
  });

  test('requests Product Hunt imgix GIFs as bounded first-frame WebP sources', async () => {
    const bucket = {
      put: vi.fn(async () => ({} as R2Object)),
    } as unknown as R2Bucket;
    const requestedUrls: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrls.push(String(input));
      const width = Number((init as RequestInit & {
        cf?: { image?: { width?: number } };
      }).cf?.image?.width);
      return realStaticWebpResponse(width === 800 ? 800 : 400);
    });

    const variants = await generateCardImageVariants(bucket, {
      sourceUrl: 'https://ph-files.imgix.net/launch.gif?auto=format&dpr=3',
      sourcePrefix: 'ph',
      mediaKind: 'image',
      sourceContentType: 'image/gif',
    }, { fetcher });

    expect(variants.map(({ width }) => width)).toEqual([400, 800]);
    expect(requestedUrls.map((value) => {
      const url = new URL(value);
      return {
        host: url.hostname,
        auto: url.searchParams.get('auto'),
        dpr: url.searchParams.get('dpr'),
        fm: url.searchParams.get('fm'),
        frame: url.searchParams.get('frame'),
        q: url.searchParams.get('q'),
        w: url.searchParams.get('w'),
      };
    })).toEqual([
      {
        host: 'ph-files.imgix.net',
        auto: null,
        dpr: '1',
        fm: 'webp',
        frame: '1',
        q: '82',
        w: '400',
      },
      {
        host: 'ph-files.imgix.net',
        auto: null,
        dpr: '1',
        fm: 'webp',
        frame: '1',
        q: '82',
        w: '800',
      },
    ]);
  });

  test.each([
    {
      label: 'a lookalike subdomain',
      sourceUrl: 'https://ph-files.imgix.net.evil.example/launch.gif?auto=format',
      sourcePrefix: 'ph',
    },
    {
      label: 'a lookalike prefixed hostname',
      sourceUrl: 'https://evil-ph-files.imgix.net/launch.gif?auto=format',
      sourcePrefix: 'ph',
    },
    {
      label: 'a non-Product-Hunt source',
      sourceUrl: 'https://ph-files.imgix.net/launch.gif?auto=format',
      sourcePrefix: 'x',
    },
  ] as const)('does not rewrite Product Hunt GIF parameters for $label', async ({
    sourceUrl,
    sourcePrefix,
  }) => {
    const bucket = {
      put: vi.fn(async () => ({} as R2Object)),
    } as unknown as R2Bucket;
    const requestedUrls: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrls.push(String(input));
      const width = Number((init as RequestInit & {
        cf?: { image?: { width?: number } };
      }).cf?.image?.width);
      return realStaticWebpResponse(width === 800 ? 800 : 400);
    });

    const variants = await generateCardImageVariants(bucket, {
      sourceUrl,
      sourcePrefix,
      mediaKind: 'image',
      sourceContentType: 'image/gif',
    }, { fetcher });

    expect(variants.map(({ width }) => width)).toEqual([400, 800]);
    expect(requestedUrls).toEqual([sourceUrl, sourceUrl]);
  });

  test('rejects an animated WebP response even when the transform endpoint labels it WebP', async () => {
    const bucket = { put: vi.fn() } as unknown as R2Bucket;
    const fetcher = vi.fn(async () => webpVp8xResponse(400, 225, true));

    const variants = await generateCardImageVariants(bucket, {
      sourceUrl: 'https://cdn.example.com/launch.gif',
      sourcePrefix: 'ph',
      mediaKind: 'image',
      sourceContentType: 'image/gif',
    }, { fetcher });

    expect(variants).toEqual([]);
    expect(bucket.put).not.toHaveBeenCalled();
  });

  test('rejects malformed WebP bytes for a GIF static preview', async () => {
    const bucket = { put: vi.fn() } as unknown as R2Bucket;
    const fetcher = vi.fn(async () => webpResponse('not-a-webp-container'));

    const variants = await generateCardImageVariants(bucket, {
      sourceUrl: 'https://cdn.example.com/launch.gif',
      sourcePrefix: 'ph',
      mediaKind: 'image',
      sourceContentType: 'image/gif',
    }, { fetcher });

    expect(variants).toEqual([]);
    expect(bucket.put).not.toHaveBeenCalled();
  });

  test('rejects a truncated VP8X-only container for a GIF static preview', async () => {
    const bucket = { put: vi.fn() } as unknown as R2Bucket;
    const fetcher = vi.fn(async () => webpVp8xResponse(400, 225));

    const variants = await generateCardImageVariants(bucket, {
      sourceUrl: 'https://cdn.example.com/launch.gif',
      sourcePrefix: 'ph',
      mediaKind: 'image',
      sourceContentType: 'image/gif',
    }, { fetcher });

    expect(variants).toEqual([]);
    expect(bucket.put).not.toHaveBeenCalled();
  });

  test('rejects a WebP RIFF container with bytes beyond its declared boundary', async () => {
    const bucket = { put: vi.fn() } as unknown as R2Bucket;
    const fetcher = vi.fn(async () => new Response(
      Buffer.from(STATIC_WEBP_WITH_TRAILING_BYTES_800, 'base64'),
      { headers: { 'content-type': 'image/webp' } },
    ));

    const variants = await generateCardImageVariants(bucket, {
      sourceUrl: 'https://cdn.example.com/launch.gif',
      sourcePrefix: 'ph',
      mediaKind: 'image',
      sourceContentType: 'image/gif',
    }, { fetcher });

    expect(variants).toEqual([]);
    expect(bucket.put).not.toHaveBeenCalled();
  });

  test('continues to bounded transforms when an origin rejects the advisory HEAD probe', async () => {
    const bucket = {
      put: vi.fn(async () => ({} as R2Object)),
    } as unknown as R2Bucket;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'HEAD') return new Response(null, { status: 405 });
      const width = Number((init as RequestInit & {
        cf?: { image?: { width?: number } };
      }).cf?.image?.width);
      return webpResponse(`webp-${width}`);
    });

    const variants = await generateCardImageVariants(bucket, {
      sourceUrl: 'https://cdn.example.com/head-not-supported',
      sourcePrefix: 'x',
      mediaKind: 'image',
      sourceWidth: 1200,
      sourceHeight: 600,
    }, { fetcher });

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.map(([, init]) => init?.redirect)).toEqual([
      'manual',
      'manual',
      'manual',
    ]);
    expect(variants.map(({ width, height }) => ({ width, height }))).toEqual([
      { width: 400, height: 200 },
      { width: 800, height: 400 },
    ]);
    expect(bucket.put).toHaveBeenCalledTimes(2);
  });

  test('fails open to the legacy original when transforms are unsupported', async () => {
    const bucket = { put: vi.fn() } as unknown as R2Bucket;
    const fetcher = vi.fn(async () => new Response('jpeg', {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    }));

    await expect(generateCardImageVariants(bucket, {
      sourceUrl: 'https://cdn.example.com/original.jpg',
      sourcePrefix: 'blog',
      mediaKind: 'image',
      sourceContentType: 'image/jpeg',
    }, { fetcher })).resolves.toEqual([]);
    expect(bucket.put).not.toHaveBeenCalled();
  });

  test('keeps a successful width when the sibling transform fails', async () => {
    const bucket = { put: vi.fn(async () => ({} as R2Object)) } as unknown as R2Bucket;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const width = (init as RequestInit & { cf?: { image?: { width?: number } } }).cf?.image?.width;
      return width === 400 ? webpResponse('small') : webpResponse('failed', 502);
    });

    const variants = await generateCardImageVariants(bucket, {
      sourceUrl: 'https://cdn.example.com/original.jpg',
      sourcePrefix: 'hf',
      mediaKind: 'image',
      sourceContentType: 'image/jpeg',
    }, { fetcher });

    expect(variants).toHaveLength(1);
    expect(variants[0].width).toBe(400);
  });

  test('describes scale-down output by its real width and deduplicates a smaller original', async () => {
    const bucket = { put: vi.fn(async () => ({} as R2Object)) } as unknown as R2Bucket;
    const fetcher = vi.fn(async () => webpResponse('same-small-image'));

    const variants = await generateCardImageVariants(bucket, {
      sourceUrl: 'https://cdn.example.com/original-300.jpg',
      sourcePrefix: 'ph',
      mediaKind: 'image',
      sourceContentType: 'image/jpeg',
      sourceWidth: 300,
      sourceHeight: 180,
    }, { fetcher });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(variants).toEqual([
      expect.objectContaining({ width: 300, height: 180 }),
    ]);
    expect(bucket.put).toHaveBeenCalledTimes(1);
  });

  test('reads the actual transformed WebP dimensions when source metadata is absent', async () => {
    const bucket = { put: vi.fn(async () => ({} as R2Object)) } as unknown as R2Bucket;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const requested = (init as RequestInit & { cf?: { image?: { width?: number } } }).cf?.image?.width;
      return requested === 400
        ? realStaticWebpResponse(400)
        : realStaticWebpResponse(800);
    });

    const variants = await generateCardImageVariants(bucket, {
      sourceUrl: 'https://cdn.example.com/unknown-dimensions.jpg',
      sourcePrefix: 'gh',
      mediaKind: 'image',
      sourceContentType: 'image/jpeg',
    }, { fetcher });

    expect(variants.map(({ width, height }) => ({ width, height }))).toEqual([
      { width: 400, height: 225 },
      { width: 800, height: 450 },
    ]);
  });
});

describe('controlled /img negotiation', () => {
  test('keys every validated upstream hop independently', () => {
    const requestUrl = new URL('https://api.ai-feeds.com/img?w=400&q=82');
    const first = new URL('https://github.com/user-attachments/assets/example');
    const redirected = new URL('https://objects.githubusercontent.com/example');

    const firstKey = buildImageProxyCacheKey(requestUrl, first, 400, 82, 'webp');
    const redirectedKey = buildImageProxyCacheKey(requestUrl, redirected, 400, 82, 'webp');

    expect(redirectedKey).not.toBe(firstKey);
    expect(decodeURIComponent(firstKey)).toContain(first.toString());
    expect(decodeURIComponent(redirectedKey)).toContain(redirected.toString());
  });

  test('buckets Accept by a format the caller explicitly supports', () => {
    expect(negotiateImageFormat('image/avif,image/webp,*/*')).toBe('avif');
    expect(negotiateImageFormat('image/webp,image/apng,*/*')).toBe('webp');
    expect(negotiateImageFormat('image/jpeg,*/*')).toBeNull();
    expect(negotiateImageFormat('image/avif;q=0,image/webp;q=0.8,*/*;q=0.1')).toBe('webp');
    expect(negotiateImageFormat('image/avif;q=0,image/webp;q=0,*/*')).toBeNull();
    expect(negotiateImageFormat('image/webp;q=1,image/avif;q=0.5')).toBe('webp');
    expect(negotiateImageFormat('image/avif;q=not-a-number,image/jpeg')).toBeNull();
  });

  test('bounds width and quality instead of forwarding attacker-controlled values', () => {
    expect(normalizeImageProxyWidth('400')).toBe(400);
    expect(normalizeImageProxyWidth('0')).toBeUndefined();
    expect(normalizeImageProxyWidth('999999')).toBe(1600);
    expect(normalizeImageProxyWidth('nope')).toBeUndefined();
    expect(normalizeImageProxyQuality('82')).toBe(82);
    expect(normalizeImageProxyQuality('1')).toBe(60);
    expect(normalizeImageProxyQuality('100')).toBe(90);
    expect(normalizeImageProxyQuality('nope')).toBe(85);
  });
});
