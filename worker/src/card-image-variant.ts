/**
 * Right-sized card images generated while an external asset is ingested.
 *
 * The source must be an external still image. In particular, this module never
 * fetches our own `/r/` URLs: doing that from the Worker can recurse through the
 * Hong Kong relay and back into the same Worker. Original objects remain the
 * detail/lightbox and legacy fallback; these variants are an optional compact
 * list-card enhancement.
 */

export const CARD_IMAGE_WIDTHS = [400, 800] as const;

const CARD_IMAGE_QUALITY = 82;
const CARD_IMAGE_MAX_BYTES = 512 * 1024;
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

const OWN_OR_RELAY_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
]);

const TRANSFORMABLE_SOURCE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
]);

function isPrivateOrLoopbackHost(hostname: string): boolean {
  if (hostname.includes(':')) return true; // IPv6 literals are not needed by current sources.
  const octets = hostname.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) {
    return hostname.endsWith('.localhost');
  }
  const [a, b] = octets;
  return a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224;
}

export type CardImageVariant = {
  url: string;
  width: number;
  height?: number;
  format: 'webp';
  bytes: number;
};

export type CardImageVariantSource = {
  sourceUrl: string;
  sourcePrefix: 'x' | 'blog' | 'podcast' | 'hf' | 'ph' | 'gh';
  mediaKind: 'image' | 'video' | 'audio';
  sourceContentType?: string | null;
  sourceWidth?: number;
  sourceHeight?: number;
  sourceRequestHeaders?: Record<string, string>;
};

type ImageTransformInit = RequestInit & {
  cf?: {
    image?: {
      width: number;
      quality: number;
      format: 'webp';
      fit: 'scale-down';
      metadata: 'none';
      anim: false;
    };
  };
};

type CardImageFetcher = (
  input: RequestInfo | URL,
  init?: ImageTransformInit,
) => Promise<Response>;

export function isEligibleCardImageSource(
  source: Pick<CardImageVariantSource, 'sourceUrl' | 'mediaKind' | 'sourceContentType'>,
): boolean {
  if (source.mediaKind !== 'image') return false;
  const contentType = (source.sourceContentType || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (contentType && !TRANSFORMABLE_SOURCE_TYPES.has(contentType)) return false;

  let url: URL;
  try {
    url = new URL(source.sourceUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  // URL keeps a DNS root-label trailing dot (`example.com.`). Normalize it
  // before allow/deny checks so equivalent own/loopback hosts cannot bypass
  // the self-fetch guard.
  const hostname = url.hostname.toLowerCase().replace(/\.+$/, '');
  if (
    OWN_OR_RELAY_HOSTS.has(hostname) ||
    isPrivateOrLoopbackHost(hostname) ||
    hostname === 'ai-feeds.com' ||
    hostname.endsWith('.ai-feeds.com') ||
    hostname.endsWith('.workers.dev')
  ) return false;
  if (/\.(?:gif|svg)(?:$|[?#])/i.test(url.pathname)) return false;
  return true;
}

function projectedHeight(source: CardImageVariantSource, width: number): number | undefined {
  const sourceWidth = Number(source.sourceWidth);
  const sourceHeight = Number(source.sourceHeight);
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) return undefined;
  return Math.max(1, Math.round((width * sourceHeight) / sourceWidth));
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function probeWebpDimensions(data: ArrayBuffer): { width: number; height: number } | undefined {
  const bytes = new Uint8Array(data);
  if (bytes.length < 30 || readAscii(bytes, 0, 4) !== 'RIFF' || readAscii(bytes, 8, 4) !== 'WEBP') {
    return undefined;
  }
  const chunk = readAscii(bytes, 12, 4);
  if (chunk === 'VP8X') {
    const width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
    const height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
    return width > 0 && height > 0 ? { width, height } : undefined;
  }
  if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
    const width = 1 + bytes[21] + ((bytes[22] & 0x3f) << 8);
    const height = 1 + (bytes[22] >>> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10);
    return { width, height };
  }
  if (
    chunk === 'VP8 ' &&
    bytes.length >= 30 &&
    bytes[23] === 0x9d &&
    bytes[24] === 0x01 &&
    bytes[25] === 0x2a
  ) {
    const width = (bytes[26] | (bytes[27] << 8)) & 0x3fff;
    const height = (bytes[28] | (bytes[29] << 8)) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : undefined;
  }
  return undefined;
}

export async function generateCardImageVariants(
  bucket: R2Bucket | undefined,
  source: CardImageVariantSource,
  deps: { fetcher?: CardImageFetcher } = {},
): Promise<CardImageVariant[]> {
  if (!bucket || !isEligibleCardImageSource(source)) return [];
  const fetcher = deps.fetcher ?? (fetch as unknown as CardImageFetcher);
  const sourceHeaders = {
    ...source.sourceRequestHeaders,
    'User-Agent': source.sourceRequestHeaders?.['User-Agent'] ||
      source.sourceRequestHeaders?.['user-agent'] ||
      'ai-feeds-card-image-variant/1.0',
  };
  let sourceContentType = source.sourceContentType;
  if (!sourceContentType) {
    try {
      const probe = await fetcher(source.sourceUrl, {
        method: 'HEAD',
        redirect: 'error',
        headers: { ...sourceHeaders, Accept: 'image/*' },
      });
      if (probe.ok) sourceContentType = probe.headers.get('content-type');
    } catch {
      // HEAD is advisory. Some otherwise valid image origins reject HEAD from
      // edge networks; the bounded transform GET below remains authoritative.
    }
    if (sourceContentType && !isEligibleCardImageSource({ ...source, sourceContentType })) {
      return [];
    }
  }
  const variants: CardImageVariant[] = [];
  const storedWidths = new Set<number>();

  // Keep this serial and bounded: one ingestion produces at most two extra
  // external subrequests and never fans out across every inline image.
  for (const width of CARD_IMAGE_WIDTHS) {
    try {
      const response = await fetcher(source.sourceUrl, {
        // A redirect could turn a validated external URL into a self-fetch.
        // Skip that optimization and retain the original fallback instead.
        redirect: 'error',
        headers: {
          ...sourceHeaders,
          Accept: 'image/webp',
        },
        cf: {
          image: {
            width,
            quality: CARD_IMAGE_QUALITY,
            format: 'webp',
            fit: 'scale-down',
            metadata: 'none',
            anim: false,
          },
        },
      });
      if (!response.ok) continue;
      const contentType = (response.headers.get('content-type') || '')
        .split(';')[0]
        .trim()
        .toLowerCase();
      if (contentType !== 'image/webp') continue;

      const declaredBytes = Number(response.headers.get('content-length') || 0);
      if (declaredBytes > CARD_IMAGE_MAX_BYTES) continue;
      const body = await response.arrayBuffer();
      if (body.byteLength === 0 || body.byteLength > CARD_IMAGE_MAX_BYTES) continue;

      // `fit: scale-down` never upscales a smaller source. Read the actual WebP
      // dimensions first; source metadata is only a fallback for encoders whose
      // container shape we cannot parse. This prevents an `800w` descriptor from
      // describing a 622px response.
      const transformedDimensions = probeWebpDimensions(body);
      const knownSourceWidth = Number(source.sourceWidth);
      const actualWidth = transformedDimensions?.width ?? (knownSourceWidth > 0
        ? Math.max(1, Math.round(Math.min(width, knownSourceWidth)))
        : width);
      const actualHeight = transformedDimensions?.height ?? projectedHeight(source, actualWidth);
      if (storedWidths.has(actualWidth)) continue;

      const hash = await sha256Hex(body);
      const key = `${source.sourcePrefix}/card/${hash}-w${actualWidth}.webp`;
      await bucket.put(key, body, {
        httpMetadata: {
          contentType: 'image/webp',
          cacheControl: IMMUTABLE_CACHE_CONTROL,
        },
        customMetadata: {
          'src-url': source.sourceUrl,
          kind: 'card-image',
          width: String(actualWidth),
        },
      });
      storedWidths.add(actualWidth);
      variants.push({
        url: `/r/${key}`,
        width: actualWidth,
        height: actualHeight,
        format: 'webp',
        bytes: body.byteLength,
      });
    } catch (error) {
      // Variant generation is an optimization. A failure must never discard a
      // successfully migrated original or make ingestion retry forever.
      console.warn(`[card-image-variant] ${source.sourceUrl} w=${width} skipped`, error);
    }
  }
  return variants;
}

export function buildImageProxyCacheKey(
  requestUrl: URL,
  upstreamUrl: URL,
  width: number | undefined,
  quality: number,
  format: 'avif' | 'webp' | null,
): string {
  const normalizedSearch = new URLSearchParams({ url: upstreamUrl.toString() });
  if (width) normalizedSearch.set('w', String(width));
  normalizedSearch.set('q', String(quality));
  normalizedSearch.set('_fmt', format ?? 'orig');
  return `${requestUrl.origin}${requestUrl.pathname}?${normalizedSearch.toString()}`;
}

export function negotiateImageFormat(accept: string): 'avif' | 'webp' | null {
  const quality = (mime: string): number => {
    let best = 0;
    for (const rawPart of accept.split(',')) {
      const [rawType, ...rawParams] = rawPart.trim().split(';');
      if (rawType.trim().toLowerCase() !== mime) continue;
      let q = 1;
      for (const rawParam of rawParams) {
        const match = rawParam.trim().match(/^q\s*=\s*(.*)$/i);
        if (!match) continue;
        const parsed = Number(match[1]);
        q = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0;
      }
      best = Math.max(best, q);
    }
    return best;
  };
  const avif = quality('image/avif');
  const webp = quality('image/webp');
  if (avif <= 0 && webp <= 0) return null;
  return avif >= webp ? 'avif' : 'webp';
}

export function normalizeImageProxyWidth(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  const requested = Math.min(1600, Math.max(1, Math.round(parsed)));
  return [80, 160, 200, 240, 320, 400, 800, 1200, 1600]
    .find((bucket) => bucket >= requested) ?? 1600;
}

export function normalizeImageProxyQuality(raw: string | null): number {
  const parsed = Number(raw ?? 85);
  if (!Number.isFinite(parsed)) return 85;
  const requested = Math.min(90, Math.max(60, Math.round(parsed)));
  return [60, 75, 82, 85, 90]
    .reduce((best, bucket) =>
      Math.abs(bucket - requested) < Math.abs(best - requested) ? bucket : best,
    85);
}
