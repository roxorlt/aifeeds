/**
 * Right-sized card images generated while an external asset is ingested.
 *
 * The source must be an external image. Animated GIF inputs are accepted only
 * because every transform explicitly requests a single static frame. This
 * module never
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
  'image/gif',
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

export async function detectCardImageSourceContentType(
  source: CardImageVariantSource,
  deps: { fetcher?: CardImageFetcher } = {},
): Promise<string | null> {
  if (!isEligibleCardImageSource({
    sourceUrl: source.sourceUrl,
    mediaKind: 'image',
    sourceContentType: null,
  })) return null;
  const fetcher = deps.fetcher ?? (fetch as unknown as CardImageFetcher);
  const sourceHeaders = {
    ...source.sourceRequestHeaders,
    'User-Agent': source.sourceRequestHeaders?.['User-Agent'] ||
      source.sourceRequestHeaders?.['user-agent'] ||
      'ai-feeds-card-image-variant/1.0',
  };
  try {
    const response = await fetcher(source.sourceUrl, {
      method: 'HEAD',
      redirect: 'manual',
      headers: { ...sourceHeaders, Accept: 'image/*' },
    });
    if (!response.ok) return null;
    const contentType = response.headers.get('content-type')?.trim();
    return contentType || null;
  } catch {
    return null;
  }
}

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
  if (/\.svg(?:$|[?#])/i.test(url.pathname)) return false;
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

function readUint32Le(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24)
  ) >>> 0;
}

function probeWebp(
  data: ArrayBuffer,
): { width: number; height: number; animated: boolean } | undefined {
  const bytes = new Uint8Array(data);
  if (
    bytes.length < 20
    || readAscii(bytes, 0, 4) !== 'RIFF'
    || readAscii(bytes, 8, 4) !== 'WEBP'
    || readUint32Le(bytes, 4) + 8 !== bytes.length
  ) {
    return undefined;
  }
  let offset = 12;
  let extendedDimensions: { width: number; height: number } | undefined;
  let imageDimensions: { width: number; height: number } | undefined;
  let animated = false;

  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) return undefined;
    const chunk = readAscii(bytes, offset, 4);
    const chunkSize = readUint32Le(bytes, offset + 4);
    const payload = offset + 8;
    const payloadEnd = payload + chunkSize;
    const paddedEnd = payloadEnd + (chunkSize & 1);
    if (payloadEnd < payload || paddedEnd > bytes.length) return undefined;

    if (chunk === 'VP8X') {
      if (chunkSize < 10) return undefined;
      animated ||= Boolean(bytes[payload] & 0x02);
      extendedDimensions = {
        width: 1 + bytes[payload + 4] + (bytes[payload + 5] << 8) + (bytes[payload + 6] << 16),
        height: 1 + bytes[payload + 7] + (bytes[payload + 8] << 8) + (bytes[payload + 9] << 16),
      };
    } else if (chunk === 'VP8L') {
      if (chunkSize < 5 || bytes[payload] !== 0x2f) return undefined;
      imageDimensions = {
        width: 1 + bytes[payload + 1] + ((bytes[payload + 2] & 0x3f) << 8),
        height: 1 + (bytes[payload + 2] >>> 6) + (bytes[payload + 3] << 2)
          + ((bytes[payload + 4] & 0x0f) << 10),
      };
    } else if (chunk === 'VP8 ') {
      if (
        chunkSize < 10
        || bytes[payload + 3] !== 0x9d
        || bytes[payload + 4] !== 0x01
        || bytes[payload + 5] !== 0x2a
      ) return undefined;
      imageDimensions = {
        width: (bytes[payload + 6] | (bytes[payload + 7] << 8)) & 0x3fff,
        height: (bytes[payload + 8] | (bytes[payload + 9] << 8)) & 0x3fff,
      };
    } else if (chunk === 'ANIM' || chunk === 'ANMF') {
      animated = true;
    }
    offset = paddedEnd;
  }

  // A VP8X container header only describes canvas features; it is not an
  // image. Require a complete top-level VP8/VP8L payload so truncated or
  // header-only transform responses can never be persisted as GIF previews.
  const dimensions = extendedDimensions ?? imageDimensions;
  if (
    offset !== bytes.length
    || !imageDimensions
    || !dimensions
    || dimensions.width <= 0
    || dimensions.height <= 0
  ) return undefined;
  return { ...dimensions, animated };
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
    sourceContentType = await detectCardImageSourceContentType(source, { fetcher });
    if (sourceContentType && !isEligibleCardImageSource({ ...source, sourceContentType })) {
      return [];
    }
  }
  const normalizedSourceContentType = (sourceContentType || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  const sourceIsGif = normalizedSourceContentType === 'image/gif'
    || /\.gif(?:$|[?#])/i.test(source.sourceUrl);
  const variants: CardImageVariant[] = [];
  const storedWidths = new Set<number>();

  // Keep this serial and bounded: one ingestion produces at most two extra
  // external subrequests and never fans out across every inline image.
  for (const width of CARD_IMAGE_WIDTHS) {
    try {
      const response = await fetcher(source.sourceUrl, {
        // A redirect could turn a validated external URL into a self-fetch.
        // Skip that optimization and retain the original fallback instead.
        redirect: 'manual',
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
      const transformed = probeWebp(body);
      // A GIF preview is a hard safety boundary, not a best-effort descriptor:
      // only a parseable, explicitly single-frame WebP may be persisted/marked
      // ready. Ordinary still-image migrations keep the historical dimension
      // fallback for older Cloudflare encoders.
      if (sourceIsGif && (!transformed || transformed.animated)) continue;
      if (transformed?.animated) continue;
      const knownSourceWidth = Number(source.sourceWidth);
      const actualWidth = transformed?.width ?? (knownSourceWidth > 0
        ? Math.max(1, Math.round(Math.min(width, knownSourceWidth)))
        : width);
      const actualHeight = transformed?.height ?? projectedHeight(source, actualWidth);
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
