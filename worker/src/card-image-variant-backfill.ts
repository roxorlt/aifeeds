import {
  generateCardImageVariants,
  type CardImageVariant,
  type CardImageVariantSource,
} from './card-image-variant';

type JsonRecord = Record<string, unknown>;
type MediaRecord = JsonRecord & {
  type?: string;
  url?: string;
  poster?: string;
  role?: string;
  width?: number;
  height?: number;
  card_variants?: CardImageVariant[];
  poster_variants?: CardImageVariant[];
};

export type CardVariantTarget = {
  url: string;
  sourceUrlFallback?: string;
  sourcePrefix: CardImageVariantSource['sourcePrefix'];
  mediaKind: 'image';
  width?: number;
  height?: number;
  existingVariants?: CardImageVariant[];
  sourceRequestHeaders: Record<string, string>;
  apply: (variants: CardImageVariant[]) => void;
  markAttemptedWithoutVariants?: () => void;
};

const BROWSER_R2_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Keep these aligned with the source ingestion paths. Importing those modules
// here would pull their Worker workflows into this bounded ops helper.
const SOURCE_USER_AGENT: Record<CardImageVariantSource['sourcePrefix'], string> = {
  x: BROWSER_R2_USER_AGENT,
  blog: BROWSER_R2_USER_AGENT,
  podcast: BROWSER_R2_USER_AGENT,
  ph: 'Mozilla/5.0 (compatible; ai-feeds-r2-migrate/1.0)',
  hf: 'Mozilla/5.0 (compatible; aifeeds-r2-migrate/1.0)',
  gh: 'ai-feeds-scraper/1.0 (+https://ai-feeds.com)',
};

function asMedia(value: unknown): MediaRecord[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is MediaRecord => Boolean(entry) && typeof entry === 'object')
    : [];
}

function mediaTarget(
  entry: MediaRecord | undefined,
  sourcePrefix: CardImageVariantSource['sourcePrefix'],
  field: 'url' | 'poster' = 'url',
): CardVariantTarget | null {
  const url = entry?.[field];
  if (typeof url !== 'string' || !url) return null;
  const variantField = field === 'poster' ? 'poster_variants' : 'card_variants';
  return {
    url,
    sourcePrefix,
    mediaKind: 'image',
    width: entry.width,
    height: entry.height,
    existingVariants: entry[variantField],
    sourceRequestHeaders: { 'User-Agent': SOURCE_USER_AGENT[sourcePrefix] },
    apply: (variants) => {
      entry[variantField] = variants;
    },
  };
}

function scalarTarget(
  extra: JsonRecord,
  coverField: 'cover_url' | 'cover_image',
  variantsField: 'cover_variants' | 'cover_image_variants',
  sourcePrefix: CardImageVariantSource['sourcePrefix'],
): CardVariantTarget | null {
  const url = extra[coverField];
  if (typeof url !== 'string' || !url) return null;
  const existing = extra[variantsField];
  const variantsMatchCurrentCover = extra.cover_variant_source === url;
  return {
    url,
    sourcePrefix,
    mediaKind: 'image',
    existingVariants: variantsMatchCurrentCover && Array.isArray(existing)
      ? existing as CardImageVariant[]
      : undefined,
    sourceRequestHeaders: { 'User-Agent': SOURCE_USER_AGENT[sourcePrefix] },
    apply: (variants) => {
      extra[variantsField] = variants;
      extra.cover_variant_source = url;
    },
    markAttemptedWithoutVariants: () => {
      delete extra[variantsField];
      extra.cover_variant_source = url;
    },
  };
}

/** Locate the one visual actually used by a compact list card. */
export function locateCardVariantTarget(
  sourceType: string,
  media: MediaRecord[],
  extra: JsonRecord,
): CardVariantTarget | null {
  if (sourceType === 'x_list') {
    const retweet = extra.is_retweet && extra.retweet_of && typeof extra.retweet_of === 'object'
      ? extra.retweet_of as JsonRecord
      : undefined;
    const candidates = retweet ? asMedia(retweet.media) : media;
    const first = candidates[0];
    if (first?.type === 'image') return mediaTarget(first, 'x');
    if (first?.type === 'video' && first.poster) return mediaTarget(first, 'x', 'poster');
    return mediaTarget(candidates.find((entry) => entry.type === 'image'), 'x');
  }
  if (sourceType === 'product_hunt') {
    return mediaTarget(media.find((entry) =>
      entry.type === 'image' && entry.role !== 'logo',
    ), 'ph');
  }
  if (sourceType === 'hf_paper') {
    const primary = media.find((entry) => entry.type === 'image');
    const target = mediaTarget(primary, 'hf');
    if (!target || !primary) return target;
    const figure = extra.figure_image && typeof extra.figure_image === 'object'
      ? extra.figure_image as JsonRecord
      : undefined;
    const rawUrl = figure?.raw_url;
    const storedUrl = figure?.r2_url ?? figure?.src_url;
    if (
      typeof rawUrl === 'string' &&
      (primary.role === 'figure' || storedUrl === primary.url)
    ) {
      target.sourceUrlFallback = rawUrl;
    }
    return target;
  }
  if (sourceType === 'github') {
    return scalarTarget(extra, 'cover_url', 'cover_variants', 'gh');
  }
  if (sourceType === 'blog') {
    return scalarTarget(extra, 'cover_image', 'cover_image_variants', 'blog');
  }
  if (sourceType === 'podcast') {
    return scalarTarget(extra, 'cover_image', 'cover_image_variants', 'podcast');
  }
  return null;
}

const SUPPORTED_SOURCES = [
  'x_list',
  'product_hunt',
  'hf_paper',
  'github',
  'blog',
  'podcast',
] as const;

const BACKFILL_PREDICATE = `
  source_type IN (${SUPPORTED_SOURCES.map((source) => `'${source}'`).join(',')})
  AND is_relevant = 1
  AND deleted_at IS NULL
  AND CASE
    WHEN extra IS NULL OR json_valid(extra) = 0 THEN 1
    WHEN COALESCE(json_extract(extra, '$.card_variant_version'), 0) < 1 THEN 1
    WHEN source_type = 'github'
      AND json_type(extra, '$.cover_url') = 'text'
      AND length(trim(json_extract(extra, '$.cover_url'))) > 0
      AND COALESCE(json_extract(extra, '$.cover_variant_source'), '')
          <> json_extract(extra, '$.cover_url') THEN 1
    WHEN source_type IN ('blog', 'podcast')
      AND json_type(extra, '$.cover_image') = 'text'
      AND length(trim(json_extract(extra, '$.cover_image'))) > 0
      AND COALESCE(json_extract(extra, '$.cover_variant_source'), '')
          <> json_extract(extra, '$.cover_image') THEN 1
    ELSE 0
  END = 1
`;

type BackfillRow = {
  id: string;
  source_type: string;
  media: string | null;
  extra: string | null;
};

export type CardVariantBackfillOptions = {
  dryRun?: boolean;
  limit?: number;
  afterId?: string;
};

export type CardVariantBackfillResult = {
  dry_run: boolean;
  picked: number;
  resolvable: number;
  would_update: number;
  updated: number;
  source_unavailable: number;
  transform_failed: number;
  conflicts: number;
  errors: number;
  remaining: number;
  complete: boolean;
  next_cursor: string | null;
};

type BackfillEnv = { DB: D1Database; READMES?: R2Bucket };

type Generator = typeof generateCardImageVariants;

function r2Key(url: string): string | null {
  const marker = url.indexOf('/r/');
  return marker >= 0 ? url.slice(marker + 3) : null;
}

async function recoverExternalSource(
  bucket: R2Bucket,
  currentUrl: string,
  fallbackUrl?: string,
): Promise<string | null> {
  if (/^https:\/\//i.test(currentUrl) && !r2Key(currentUrl)) return currentUrl;
  const key = r2Key(currentUrl);
  if (key) {
    try {
      const object = await bucket.head(key);
      const source = object?.customMetadata?.['src-url'];
      if (typeof source === 'string' && /^https:\/\//i.test(source)) return source;
    } catch {
      // A legacy object can lack metadata or be temporarily unavailable. The
      // source-specific fallback below remains bounded to an HTTPS URL.
    }
  }
  return typeof fallbackUrl === 'string' && /^https:\/\//i.test(fallbackUrl)
    ? fallbackUrl
    : null;
}

function parseMedia(raw: string | null): MediaRecord[] {
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error('media JSON is not an array');
  return asMedia(parsed);
}

function parseExtra(raw: string | null): JsonRecord {
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('extra JSON is not an object');
  }
  return parsed as JsonRecord;
}

export async function runCardImageVariantBackfill(
  env: BackfillEnv,
  options: CardVariantBackfillOptions = {},
  deps: { generate?: Generator } = {},
): Promise<CardVariantBackfillResult> {
  const dryRun = options.dryRun !== false;
  const limit = Math.min(25, Math.max(1, Math.floor(options.limit ?? 10)));
  const afterId = options.afterId || '';
  const result: CardVariantBackfillResult = {
    dry_run: dryRun,
    picked: 0,
    resolvable: 0,
    would_update: 0,
    updated: 0,
    source_unavailable: 0,
    transform_failed: 0,
    conflicts: 0,
    errors: 0,
    remaining: 0,
    complete: false,
    next_cursor: null,
  };
  if (!env.READMES) return result;

  const rows = await env.DB.prepare(
    `SELECT id, source_type, media, extra
       FROM items
      WHERE ${BACKFILL_PREDICATE}
        AND id > ?
      ORDER BY id
      LIMIT ?`,
  ).bind(afterId, limit).all<BackfillRow>();
  const candidates = rows.results || [];
  result.picked = candidates.length;
  const generate = deps.generate ?? generateCardImageVariants;
  let lastId: string | null = null;

  for (const row of candidates) {
    lastId = row.id;
    try {
      const media = parseMedia(row.media);
      const extra = parseExtra(row.extra);
      const target = locateCardVariantTarget(row.source_type, media, extra);
      let status: 'ok' | 'none' | 'source_unavailable' | 'transform_failed' = 'none';
      let variants: CardImageVariant[] = [];

      if (target?.existingVariants?.length) {
        result.resolvable++;
        variants = target.existingVariants;
        status = 'ok';
      } else if (target) {
        const sourceUrl = await recoverExternalSource(
          env.READMES,
          target.url,
          target.sourceUrlFallback,
        );
        if (!sourceUrl) {
          status = 'source_unavailable';
          result.source_unavailable++;
        } else {
          result.resolvable++;
          if (!dryRun) {
            variants = await generate(env.READMES, {
              sourceUrl,
              sourcePrefix: target.sourcePrefix,
              mediaKind: 'image',
              sourceWidth: target.width,
              sourceHeight: target.height,
              sourceRequestHeaders: target.sourceRequestHeaders,
            });
            status = variants.length > 0 ? 'ok' : 'transform_failed';
            if (status === 'transform_failed') result.transform_failed++;
          }
        }
      }

      result.would_update++;
      if (dryRun) continue;
      if (target && status === 'ok') target.apply(variants);
      else if (target) target.markAttemptedWithoutVariants?.();
      extra.card_variant_version = 1;
      extra.card_variant_status = status;
      extra.card_variant_attempted_at = new Date().toISOString();

      const write = await env.DB.prepare(
        `UPDATE items
            SET media = ?, extra = ?
          WHERE id = ?
            AND COALESCE(media, '') = ?
            AND COALESCE(extra, '') = ?`,
      ).bind(
        JSON.stringify(media),
        JSON.stringify(extra),
        row.id,
        row.media || '',
        row.extra || '',
      ).run();
      if ((write.meta?.changes ?? 0) === 1) result.updated++;
      else result.conflicts++;
    } catch (error) {
      result.errors++;
      console.error(`[card-variant-backfill] ${row.id}`, error);
    }
  }

  const remaining = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM items WHERE ${BACKFILL_PREDICATE}`,
  ).first<{ n: number }>();
  result.remaining = remaining?.n ?? 0;
  result.complete = !dryRun && result.remaining === 0 && result.errors === 0 && result.conflicts === 0;
  result.next_cursor = result.errors === 0 && result.conflicts === 0 && candidates.length === limit
    ? lastId
    : null;
  return result;
}
