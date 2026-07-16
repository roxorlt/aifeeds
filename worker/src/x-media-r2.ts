// X (Twitter) media R2 migration.  (P0 of docs/plans/2026-06-04-x-card-render-api.md)
//
// 镜像 ph-r2.ts 的模式,但针对 x_list item:挑 extra.x_media_r2_at IS NULL 的行,
// 把头像 + 媒体(图片/视频 mp4 + 视频封面)+ L2 嵌套(quote_of / retweet_of)的同名资源
// 下载上传到 R2(key = `x/<sha256>.<ext>`,内容寻址、自动去重),把 media 数组 + extra JSON
// 里的原始 twimg URL 就地改写成 `/r/x/<hash>.<ext>`,最后标 extra.x_media_r2_at。
//
// 目的:twimg 原始链接会过期 / 对陌生服务器 IP 防盗链 / 头像链接轮换;迁到 aifeeds R2 后
// 给稳定 https 链接(走 Cloudflare CDN),供 X 卡片渲染 + 日报 API + 前端统一消费。
//
// Bucket: `xlist-readme-assets`(复用,prefix `x/` 区分 PH 的 `ph/`)。

import type { Env } from './index';
import {
  generateCardImageVariants,
  type CardImageVariant,
} from './card-image-variant';

const R2_KEY_PREFIX_X = 'x';
const IMG_MAX_BYTES = 5 * 1024 * 1024;       // 5 MB
const VIDEO_MAX_BYTES = 20 * 1024 * 1024;    // 20 MB(X 视频偏大,超限优雅跳过、保留 twimg 链接)
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;    // 2 MB
// twimg 对纯 bot UA 偶尔防盗链,用接近真实浏览器的 UA。
const X_R2_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const ALLOWED_IMG_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif',
]);
const ALLOWED_VIDEO_TYPES = new Set([
  'video/mp4', 'video/webm', 'video/quicktime',
]);
const EXT_FROM_TYPE: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/avif': 'avif',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
};

interface XAsset {
  url: string;        // DB 里的原始 URL(改写映射的 key)
  fetchUrl?: string;  // 实际下载的 URL(默认 = url;头像用高清变体覆盖)
  kind: 'avatar' | 'image' | 'video';
  maxBytes: number;
  width?: number;
  height?: number;
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function extFromUrl(url: string, contentType: string | null): string {
  if (contentType) {
    const ct = contentType.toLowerCase().split(';')[0].trim();
    if (EXT_FROM_TYPE[ct]) return EXT_FROM_TYPE[ct];
  }
  const m = url.match(/\.([a-zA-Z0-9]{2,5})(?:\?|$)/);
  return m ? m[1].toLowerCase() : 'bin';
}

function isAlreadyMigrated(url: string | null | undefined): boolean {
  return !!url && url.startsWith('/r/');
}

// X 头像默认是 `_normal`(48px)。渲染要清晰,下载时升到 `_400x400`。
// 改写映射仍用原始 `_normal` URL 当 key(DB 里存的是它)。
function avatarHiRes(url: string): string {
  return url.replace(/_normal(\.[a-zA-Z0-9]+)(\?|$)/, '_400x400$1$2');
}

async function migrateOne(
  env: Env,
  asset: XAsset,
  withCardVariants = false,
): Promise<{ url: string; variants: CardImageVariant[] } | null> {
  if (!env.READMES) return null;
  if (isAlreadyMigrated(asset.url)) return { url: asset.url, variants: [] };
  try {
    const r = await fetch(asset.fetchUrl || asset.url, {
      headers: { 'User-Agent': X_R2_USER_AGENT, 'Accept': '*/*' },
    });
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
    const ext = extFromUrl(asset.fetchUrl || asset.url, ct);
    const key = `${R2_KEY_PREFIX_X}/${hash}.${ext}`;
    await env.READMES.put(key, buf, {
      httpMetadata: { contentType: ct || 'application/octet-stream' },
      customMetadata: { 'src-url': asset.url, 'kind': asset.kind, 'source': 'x' },
    });
    const variants = withCardVariants && asset.kind === 'image'
      ? await generateCardImageVariants(env.READMES, {
          sourceUrl: asset.fetchUrl || asset.url,
          sourcePrefix: 'x',
          mediaKind: 'image',
          sourceContentType: ctLower,
          sourceWidth: asset.width,
          sourceHeight: asset.height,
          sourceRequestHeaders: { 'User-Agent': X_R2_USER_AGENT },
        })
      : [];
    return { url: `/r/${key}`, variants };
  } catch (e) {
    console.error(`[x-media-r2] asset error ${asset.url}:`, e);
    return null;
  }
}

// ─── 收集一条 X item 要迁的资源 ────────────────────────────────
interface XMediaItem {
  type?: string;
  url?: string;
  poster?: string | null;
  width?: number;
  height?: number;
  card_variants?: CardImageVariant[];
  poster_variants?: CardImageVariant[];
  [k: string]: unknown;
}
interface XQuoteLike {
  profile_image_url?: string | null;
  media?: XMediaItem[];
  [k: string]: unknown;
}
interface XExtra {
  profile_image_url?: string | null;
  card_thumbnail?: string | null;
  quote_of?: XQuoteLike | null;
  retweet_of?: XQuoteLike | null;
  reply_of?: XQuoteLike | null;
  x_media_r2_at?: string | null;
  x_card_variants_at?: string | null;
  card_variant_version?: number;
  card_variant_status?: string;
  card_thumbnail_variants?: CardImageVariant[];
  [k: string]: unknown;
}

function collectAssets(media: XMediaItem[], extra: XExtra): XAsset[] {
  const out: XAsset[] = [];
  const seen = new Set<string>();

  const pushAvatar = (url: string | null | undefined) => {
    if (!url || seen.has(url) || isAlreadyMigrated(url)) return;
    seen.add(url);
    out.push({ url, fetchUrl: avatarHiRes(url), kind: 'avatar', maxBytes: AVATAR_MAX_BYTES });
  };
  const pushMedia = (arr: XMediaItem[] | undefined, cap = 4) => {
    for (const m of (arr || []).slice(0, cap)) {
      // 图片(或视频封面 poster)
      const isVideo = m.type === 'video';
      if (m.url && !seen.has(m.url) && !isAlreadyMigrated(m.url)) {
        seen.add(m.url);
        out.push(isVideo
          ? { url: m.url, kind: 'video', maxBytes: VIDEO_MAX_BYTES }
          : {
              url: m.url,
              kind: 'image',
              maxBytes: IMG_MAX_BYTES,
              width: m.width,
              height: m.height,
            });
      }
      if (m.poster && !seen.has(m.poster) && !isAlreadyMigrated(m.poster)) {
        seen.add(m.poster);
        out.push({
          url: m.poster,
          kind: 'image',
          maxBytes: IMG_MAX_BYTES,
          width: m.width,
          height: m.height,
        });
      }
    }
  };

  pushAvatar(extra.profile_image_url);
  pushMedia(media);
  if (extra.card_thumbnail && !seen.has(extra.card_thumbnail) && !isAlreadyMigrated(extra.card_thumbnail)) {
    seen.add(extra.card_thumbnail);
    out.push({ url: extra.card_thumbnail, kind: 'image', maxBytes: IMG_MAX_BYTES });
  }
  // L2 嵌套:引用推 / 被转推 / 回复父推 的头像 + 媒体
  for (const c of [extra.quote_of, extra.retweet_of, extra.reply_of]) {
    if (!c) continue;
    pushAvatar(c.profile_image_url);
    pushMedia(c.media);
  }
  return out;
}

// ─── 用 mapping 改写 media + extra 里的所有 URL ─────────────────
function rewriteMedia(
  arr: XMediaItem[] | undefined,
  map: Map<string, string>,
  variantMap: Map<string, CardImageVariant[]>,
): XMediaItem[] | undefined {
  if (!arr) return arr;
  return arr.map((m) => {
    const next: XMediaItem = { ...m };
    if (m.url && map.has(m.url)) next.url = map.get(m.url)!;
    if (m.poster && map.has(m.poster)) next.poster = map.get(m.poster)!;
    if (m.url && variantMap.has(m.url)) next.card_variants = variantMap.get(m.url)!;
    if (m.poster && variantMap.has(m.poster)) next.poster_variants = variantMap.get(m.poster)!;
    return next;
  });
}
function rewriteQuoteLike(
  c: XQuoteLike | null | undefined,
  map: Map<string, string>,
  variantMap: Map<string, CardImageVariant[]>,
): XQuoteLike | null | undefined {
  if (!c) return c;
  const next: XQuoteLike = { ...c };
  if (c.profile_image_url && map.has(c.profile_image_url)) next.profile_image_url = map.get(c.profile_image_url)!;
  next.media = rewriteMedia(c.media, map, variantMap);
  return next;
}
function rewriteAll(
  media: XMediaItem[],
  extra: XExtra,
  map: Map<string, string>,
  variantMap: Map<string, CardImageVariant[]>,
): { media: XMediaItem[]; extra: XExtra } {
  const newMedia = rewriteMedia(media, map, variantMap) || [];
  const newExtra: XExtra = { ...extra };
  if (extra.profile_image_url && map.has(extra.profile_image_url)) newExtra.profile_image_url = map.get(extra.profile_image_url)!;
  if (extra.card_thumbnail && map.has(extra.card_thumbnail)) newExtra.card_thumbnail = map.get(extra.card_thumbnail)!;
  if (extra.card_thumbnail && variantMap.has(extra.card_thumbnail)) {
    newExtra.card_thumbnail_variants = variantMap.get(extra.card_thumbnail)!;
  }
  newExtra.quote_of = rewriteQuoteLike(extra.quote_of, map, variantMap);
  newExtra.retweet_of = rewriteQuoteLike(extra.retweet_of, map, variantMap);
  newExtra.reply_of = rewriteQuoteLike(extra.reply_of, map, variantMap);
  return { media: newMedia, extra: newExtra };
}

function selectPrimaryCardAsset(media: XMediaItem[], extra: XExtra): string | null {
  const primaryMedia = extra.is_retweet && extra.retweet_of?.media?.length
    ? extra.retweet_of.media
    : media;
  const first = primaryMedia[0];
  if (first?.type === 'image' && first.url) return first.url;
  if (first?.type === 'video' && first.poster) return first.poster;
  const image = primaryMedia.find((entry) => entry.type === 'image' && entry.url);
  if (image?.url) return image.url;
  return extra.card_thumbnail || null;
}

interface XItemRow { id: string; source_id: string; media_raw: string | null; extra_raw: string | null; }

// 单条迁移核心(batch + workflow step 共用)。
async function migrateRow(env: Env, row: XItemRow): Promise<{ migrated: number; failed: number; total: number }> {
  const media: XMediaItem[] = row.media_raw ? JSON.parse(row.media_raw) : [];
  const extra: XExtra = row.extra_raw ? JSON.parse(row.extra_raw) : {};
  const assets = collectAssets(media, extra);
  const primaryCardAsset = selectPrimaryCardAsset(media, extra);

  const map = new Map<string, string>();
  const variantMap = new Map<string, CardImageVariant[]>();
  let migrated = 0, failed = 0;
  for (const a of assets) {
    const result = await migrateOne(env, a, a.url === primaryCardAsset);
    if (result) {
      map.set(a.url, result.url);
      if (result.variants.length > 0) variantMap.set(a.url, result.variants);
      migrated++;
    } else {
      failed++;
    }
  }

  const { media: newMedia, extra: rewritten } = rewriteAll(media, extra, map, variantMap);
  const now = new Date().toISOString();
  const newExtra: XExtra = {
    ...rewritten,
    x_media_r2_at: now,
    x_card_variants_at: now,
  };
  if (variantMap.size > 0) {
    newExtra.card_variant_version = 1;
    newExtra.card_variant_status = 'ok';
  }
  await env.DB.prepare(`UPDATE items SET media = ?, extra = ? WHERE id = ?`)
    .bind(JSON.stringify(newMedia), JSON.stringify(newExtra), row.id).run();

  return { migrated, failed, total: assets.length };
}

// ─── 批量迁移(enrich mode / cron)───────────────────────────────
export async function runXMediaR2Migrate(
  env: Env,
  limit = 5,
  sinceDays?: number,
): Promise<{ picked: number; ok: number; assets_migrated: number; assets_failed: number; failed: number }> {
  const counts = { picked: 0, ok: 0, assets_migrated: 0, assets_failed: 0, failed: 0 };
  if (!env.READMES) {
    console.warn('[x-media-r2] R2 binding READMES not configured — skip');
    return counts;
  }
  // sinceDays>0:只迁最近 N 天(scraped_at 窗口),供"回填最近 N 天"用;不传则全量。
  const dateFilter = sinceDays && sinceDays > 0
    ? `AND scraped_at >= datetime('now', '-${Math.floor(sinceDays)} days')`
    : '';
  const rows = await env.DB.prepare(
    `SELECT id, source_id, media as media_raw, extra as extra_raw
       FROM items
      WHERE source_type='x_list'
        AND is_relevant = 1
        AND json_extract(extra, '$.x_media_r2_at') IS NULL
        ${dateFilter}
      ORDER BY scraped_at DESC
      LIMIT ?`,
  ).bind(Math.min(Math.max(limit, 1), 50)).all<XItemRow>();

  for (const row of rows.results || []) {
    counts.picked++;
    try {
      const r = await migrateRow(env, row);
      counts.assets_migrated += r.migrated;
      counts.assets_failed += r.failed;
      counts.ok++;
      console.log(`[x-media-r2] ${row.source_id}: ${r.migrated}/${r.total} assets migrated`);
    } catch (e) {
      counts.failed++;
      console.error(`[x-media-r2] item ${row.source_id} failed:`, e);
    }
  }
  return counts;
}

// ─── 单 itemId 迁移(供 X workflow step 实时迁新推用)──────────────
export async function migrateXMediaForItem(env: Env, itemId: string): Promise<{ migrated: number; failed: number }> {
  if (!env.READMES) return { migrated: 0, failed: 0 };
  const row = await env.DB.prepare(
    `SELECT id, source_id, media as media_raw, extra as extra_raw
       FROM items WHERE id = ? AND source_type='x_list'`,
  ).bind(itemId).first<XItemRow>();
  if (!row) throw new Error(`migrateXMediaForItem: item not found ${itemId}`);
  const extra: XExtra = row.extra_raw ? JSON.parse(row.extra_raw) : {};
  if (extra.x_media_r2_at) return { migrated: 0, failed: 0 }; // 已迁过早退
  const r = await migrateRow(env, row);
  console.log(`[x-media-r2:item] ${itemId}: ${r.migrated}/${r.total} assets`);
  return { migrated: r.migrated, failed: r.failed };
}

export async function countXMediaR2Pending(env: Env, sinceDays?: number): Promise<number> {
  const dateFilter = sinceDays && sinceDays > 0
    ? `AND scraped_at >= datetime('now', '-${Math.floor(sinceDays)} days')`
    : '';
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM items
      WHERE source_type='x_list' AND is_relevant = 1
        AND json_extract(extra, '$.x_media_r2_at') IS NULL
        ${dateFilter}`,
  ).first<{ n: number }>();
  return r?.n ?? 0;
}
