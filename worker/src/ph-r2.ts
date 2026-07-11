// Product Hunt R2 asset migration.
//
// Pattern mirrors `github.ts` but for PH source items: pick rows where
// `extra.r2_migrated_at IS NULL`, fetch all asset URLs (logo / gallery /
// avatars / video), upload to R2 with `ph/<sha256>.<ext>` keys, rewrite
// URLs in `media` array + `extra` JSON in-place, mark migrated.
//
// Keys are content-addressed (SHA-256 of bytes) so re-uploading same image
// from a different launch / product is a no-op (same key, same content).
//
// Caps per item (design doc § 5.2):
//   - logo: 1 × ≤5MB
//   - gallery images: 5 × ≤5MB
//   - videos: 2 × ≤10MB
//   - avatars: 30 × ≤1MB
//
// Bucket: `xlist-readme-assets` (复用 GH bucket, prefix 区分)

import type { Env } from './index';
import {
  generateCardImageVariants,
  type CardImageVariant,
} from './card-image-variant';

const R2_KEY_PREFIX_PH = 'ph';
const IMG_MAX_BYTES = 5 * 1024 * 1024;       // 5 MB
const VIDEO_MAX_BYTES = 10 * 1024 * 1024;    // 10 MB
const AVATAR_MAX_BYTES = 1 * 1024 * 1024;    // 1 MB
const PH_R2_USER_AGENT =
  'Mozilla/5.0 (compatible; ai-feeds-r2-migrate/1.0)';

const ALLOWED_IMG_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'image/svg+xml', 'image/avif', 'image/x-icon',
]);
const ALLOWED_VIDEO_TYPES = new Set([
  'video/mp4', 'video/webm', 'video/quicktime',
]);
const EXT_FROM_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/x-icon': 'ico',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
};

interface AssetRequest {
  url: string;
  kind: 'logo' | 'gallery' | 'video' | 'avatar';
  maxBytes: number;
  width?: number;
  height?: number;
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function extFromUrl(url: string, contentType: string | null): string {
  if (contentType) {
    const ct = contentType.toLowerCase().split(';')[0].trim();
    if (EXT_FROM_TYPE[ct]) return EXT_FROM_TYPE[ct];
  }
  const m = url.match(/\.([a-zA-Z0-9]{2,5})(?:\?|$)/);
  return m ? m[1].toLowerCase() : 'bin';
}

function isAlreadyMigrated(url: string): boolean {
  return url.startsWith('/r/');
}

async function migrateOne(
  env: Env,
  asset: AssetRequest,
  withCardVariants = false,
): Promise<{ url: string; variants: CardImageVariant[] } | null> {
  if (!env.READMES) return null;
  if (isAlreadyMigrated(asset.url)) return { url: asset.url, variants: [] };
  try {
    const r = await fetch(asset.url, { headers: { 'User-Agent': PH_R2_USER_AGENT } });
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') || '';
    const ctLower = ct.toLowerCase().split(';')[0].trim();
    const isImage = ALLOWED_IMG_TYPES.has(ctLower);
    const isVideo = ALLOWED_VIDEO_TYPES.has(ctLower);
    if (!isImage && !isVideo) return null;
    if (asset.kind === 'video' && !isVideo) return null;
    if (asset.kind !== 'video' && !isImage) return null;

    const lenStr = r.headers.get('content-length');
    const len = lenStr ? parseInt(lenStr, 10) : -1;
    if (len > 0 && len > asset.maxBytes) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength > asset.maxBytes) return null;

    const hash = await sha256Hex(buf);
    const ext = extFromUrl(asset.url, ct);
    const key = `${R2_KEY_PREFIX_PH}/${hash}.${ext}`;

    await env.READMES.put(key, buf, {
      httpMetadata: { contentType: ct || 'application/octet-stream' },
      customMetadata: { 'src-url': asset.url, 'kind': asset.kind, 'source': 'ph' },
    });
    const variants = withCardVariants && asset.kind === 'gallery'
      ? await generateCardImageVariants(env.READMES, {
          sourceUrl: asset.url,
          sourcePrefix: 'ph',
          mediaKind: 'image',
          sourceContentType: ctLower,
          sourceWidth: asset.width,
          sourceHeight: asset.height,
          sourceRequestHeaders: { 'User-Agent': PH_R2_USER_AGENT },
        })
      : [];
    return { url: `/r/${key}`, variants };
  } catch (e) {
    console.error(`[ph-r2-migrate] asset error ${asset.url}:`, e);
    return null;
  }
}


// ---------------------------------------------------------------------------
// 收集所有要迁的 URL（logo / gallery / video / avatars）
// ---------------------------------------------------------------------------

interface ItemForMigrate {
  id: string;
  source_id: string;
  media_raw: string | null;
  extra_raw: string | null;
}

interface MediaItem {
  type?: string;
  url?: string;
  role?: string;
  width?: number;
  height?: number;
  card_variants?: CardImageVariant[];
  [k: string]: unknown;
}

interface AvatarBearingObj {
  avatar_url?: string | null;
  [k: string]: unknown;
}

interface PhExtra {
  makers?: AvatarBearingObj[];
  hunter?: AvatarBearingObj | null;
  top_comments?: AvatarBearingObj[];
  top_reviews?: AvatarBearingObj[];
  maker_post?: AvatarBearingObj | null;
  r2_migrated_at?: string | null;
  [k: string]: unknown;
}

function collectAssets(
  media: MediaItem[],
  extra: PhExtra,
): {
  logos: AssetRequest[];
  galleryImages: AssetRequest[];
  videos: AssetRequest[];
  avatars: AssetRequest[];
} {
  const logos: AssetRequest[] = [];
  const galleryImages: AssetRequest[] = [];
  const videos: AssetRequest[] = [];
  const avatars: AssetRequest[] = [];
  const seen = new Set<string>();

  for (const m of media || []) {
    if (!m.url || seen.has(m.url)) continue;
    seen.add(m.url);
    if (m.role === 'logo') {
      logos.push({ url: m.url, kind: 'logo', maxBytes: IMG_MAX_BYTES });
    } else if (m.type === 'video') {
      // PH video 大半是 YouTube / Vimeo embed（platform 非空），不能下成
      // 二进制。只迁直链 mp4（platform=""）。embed 视频靠前端 iframe 渲。
      const platform = (m as MediaItem & { platform?: string }).platform || '';
      if (platform) continue;
      videos.push({ url: m.url, kind: 'video', maxBytes: VIDEO_MAX_BYTES });
    } else {
      galleryImages.push({
        url: m.url,
        kind: 'gallery',
        maxBytes: IMG_MAX_BYTES,
        width: m.width,
        height: m.height,
      });
    }
  }

  const pushAvatar = (obj: AvatarBearingObj | null | undefined) => {
    if (!obj || !obj.avatar_url) return;
    if (seen.has(obj.avatar_url)) return;
    seen.add(obj.avatar_url);
    avatars.push({ url: obj.avatar_url, kind: 'avatar', maxBytes: AVATAR_MAX_BYTES });
  };
  for (const m of extra.makers || []) pushAvatar(m);
  pushAvatar(extra.hunter || undefined);
  pushAvatar(extra.maker_post || undefined);
  for (const c of extra.top_comments || []) pushAvatar(c);
  for (const r of extra.top_reviews || []) pushAvatar(r);

  // 应用 cap：logo=1, gallery=5, video=2, avatars=30
  return {
    logos: logos.slice(0, 1),
    galleryImages: galleryImages.slice(0, 5),
    videos: videos.slice(0, 2),
    avatars: avatars.slice(0, 30),
  };
}


// ---------------------------------------------------------------------------
// URL 重写 — 在 media 数组 + extra JSON 各处用 mapping 替换
// ---------------------------------------------------------------------------

function rewriteAvatar<T extends AvatarBearingObj>(obj: T, mapping: Map<string, string>): T {
  if (obj && obj.avatar_url && mapping.has(obj.avatar_url)) {
    obj.avatar_url = mapping.get(obj.avatar_url)!;
  }
  return obj;
}

function rewriteAllUrls(
  media: MediaItem[],
  extra: PhExtra,
  mapping: Map<string, string>,
  variantMapping: Map<string, CardImageVariant[]>,
): { media: MediaItem[]; extra: PhExtra } {
  const newMedia = media.map((m) => {
    const next = m.url && mapping.has(m.url)
      ? { ...m, url: mapping.get(m.url)! }
      : { ...m };
    if (m.url && variantMapping.has(m.url)) {
      next.card_variants = variantMapping.get(m.url)!;
    }
    return next;
  });
  const newExtra: PhExtra = { ...extra };
  if (newExtra.makers) {
    newExtra.makers = newExtra.makers.map((m) => rewriteAvatar({ ...m }, mapping));
  }
  if (newExtra.hunter) {
    newExtra.hunter = rewriteAvatar({ ...newExtra.hunter }, mapping);
  }
  if (newExtra.maker_post) {
    newExtra.maker_post = rewriteAvatar({ ...newExtra.maker_post }, mapping);
  }
  if (newExtra.top_comments) {
    newExtra.top_comments = newExtra.top_comments.map((c) => rewriteAvatar({ ...c }, mapping));
  }
  if (newExtra.top_reviews) {
    newExtra.top_reviews = newExtra.top_reviews.map((r) => rewriteAvatar({ ...r }, mapping));
  }
  return { media: newMedia, extra: newExtra };
}

async function migratePhRow(
  env: Env,
  row: ItemForMigrate,
): Promise<{ migrated: number; failed: number; total: number }> {
  const media: MediaItem[] = row.media_raw ? JSON.parse(row.media_raw) : [];
  const extra: PhExtra = row.extra_raw ? JSON.parse(row.extra_raw) : {};
  const { logos, galleryImages, videos, avatars } = collectAssets(media, extra);
  const all: AssetRequest[] = [...logos, ...galleryImages, ...videos, ...avatars];
  const primaryCardUrl = media.find((entry) =>
    entry.type === 'image' && entry.role !== 'logo' && Boolean(entry.url),
  )?.url;

  const mapping = new Map<string, string>();
  const variantMapping = new Map<string, CardImageVariant[]>();
  let migrated = 0;
  let failed = 0;
  for (const asset of all) {
    const result = await migrateOne(env, asset, asset.url === primaryCardUrl);
    if (result) {
      mapping.set(asset.url, result.url);
      if (result.variants.length > 0) {
        variantMapping.set(asset.url, result.variants);
      }
      migrated++;
    } else {
      failed++;
    }
  }

  const { media: newMedia, extra: rewrittenExtra } = rewriteAllUrls(
    media,
    extra,
    mapping,
    variantMapping,
  );
  const newExtra: PhExtra = {
    ...rewrittenExtra,
    r2_migrated_at: new Date().toISOString(),
  };
  if (variantMapping.size > 0) {
    newExtra.card_variant_version = 1;
    newExtra.card_variant_status = 'ok';
  }
  await env.DB.prepare(
    `UPDATE items SET media = ?, extra = ? WHERE id = ?`,
  ).bind(JSON.stringify(newMedia), JSON.stringify(newExtra), row.id).run();
  return { migrated, failed, total: all.length };
}


// ---------------------------------------------------------------------------
// 主入口：scheduled() 调用
// ---------------------------------------------------------------------------

export async function runPhR2Migrate(
  env: Env,
  limit = 1,
): Promise<{ picked: number; ok: number; assets_migrated: number; assets_failed: number; failed: number }> {
  const counts = { picked: 0, ok: 0, assets_migrated: 0, assets_failed: 0, failed: 0 };

  if (!env.READMES) {
    console.warn('[ph-r2-migrate] R2 binding READMES not configured — skipping');
    return counts;
  }

  const rows = await env.DB.prepare(
    `SELECT id, source_id, media as media_raw, extra as extra_raw
       FROM items
      WHERE source_type='product_hunt'
        AND is_relevant = 1
        AND json_extract(extra, '$.r2_migrated_at') IS NULL
      ORDER BY scraped_at DESC
      LIMIT ?`,
  )
    .bind(limit)
    .all<ItemForMigrate>();

  for (const row of rows.results || []) {
    counts.picked++;
    try {
      const result = await migratePhRow(env, row);
      counts.assets_migrated += result.migrated;
      counts.assets_failed += result.failed;

      counts.ok++;
      console.log(
        `[ph-r2-migrate] ${row.source_id}: migrated ${result.migrated}/${result.total} assets`,
      );
    } catch (e) {
      counts.failed++;
      console.error(`[ph-r2-migrate] item ${row.source_id} failed:`, e);
    }
  }

  return counts;
}


// ---------------------------------------------------------------------------
// COUNT helper — scheduled() 抢占决策用
// ---------------------------------------------------------------------------

// ═══════════════════════════════════════════════════════════════════════════
// 阶段 6 PH workflow step 2 — 单 itemId R2 迁移（复用 runPhR2Migrate loop body）
// ═══════════════════════════════════════════════════════════════════════════

export async function r2MigratePhItemById(
  env: Env,
  itemId: string,
): Promise<{ assets_migrated: number; assets_failed: number }> {
  if (!env.READMES) {
    console.warn(`[ph-workflow:step2] ${itemId}: R2 binding missing, skip`);
    return { assets_migrated: 0, assets_failed: 0 };
  }

  const row = await env.DB.prepare(
    `SELECT id, source_id, media as media_raw, extra as extra_raw
       FROM items
      WHERE id = ? AND source_type='product_hunt'`,
  ).bind(itemId).first<ItemForMigrate>();
  if (!row) throw new Error(`r2MigratePhItemById: item not found ${itemId}`);

  const extra: PhExtra = row.extra_raw ? JSON.parse(row.extra_raw) : {};

  // 已迁过的早退
  if (extra.r2_migrated_at) {
    return { assets_migrated: 0, assets_failed: 0 };
  }

  const result = await migratePhRow(env, row);
  console.log(`[ph-workflow:step2] ${itemId}: ${result.migrated}/${result.total} assets migrated`);
  return { assets_migrated: result.migrated, assets_failed: result.failed };
}

export async function countPhR2Pending(env: Env): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM items
      WHERE source_type='product_hunt'
        AND is_relevant = 1
        AND json_extract(extra, '$.r2_migrated_at') IS NULL`,
  ).first<{ n: number }>();
  return r?.n ?? 0;
}
