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

function webpVp8xResponse(width: number, height: number): Response {
  const bytes = new Uint8Array(30);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  bytes.set(new TextEncoder().encode('WEBP'), 8);
  bytes.set(new TextEncoder().encode('VP8X'), 12);
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

  test.each([
    ['video', 'video/mp4'],
    ['audio', 'audio/mpeg'],
    ['image', 'image/gif'],
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

  test('probes an unknown source type and rejects extensionless GIF before transforming', async () => {
    const bucket = { put: vi.fn() } as unknown as R2Bucket;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('HEAD');
      return new Response(null, { headers: { 'content-type': 'image/gif' } });
    });

    const variants = await generateCardImageVariants(bucket, {
      sourceUrl: 'https://cdn.example.com/asset-without-extension',
      sourcePrefix: 'gh',
      mediaKind: 'image',
    }, { fetcher });

    expect(variants).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
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
        ? webpVp8xResponse(400, 257)
        : webpVp8xResponse(622, 399);
    });

    const variants = await generateCardImageVariants(bucket, {
      sourceUrl: 'https://cdn.example.com/unknown-dimensions.jpg',
      sourcePrefix: 'gh',
      mediaKind: 'image',
      sourceContentType: 'image/jpeg',
    }, { fetcher });

    expect(variants.map(({ width, height }) => ({ width, height }))).toEqual([
      { width: 400, height: 257 },
      { width: 622, height: 399 },
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
