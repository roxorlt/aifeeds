// Step 1 helpers:backfill-media-r2 + refresh-gh-star
//
// - backfill-media-r2:HF social-thumbnail + submitter avatar + 评论者 avatar 全量迁 R2
//   key 前缀:hf/<sha256>.<ext>
//
// - refresh-gh-star:HF API 已抓的 githubStars 可能过期,workflow 跑时再 ping GH API
//   (option:如果 hasGhRepo 且 OPS 想节省 GH API 调用,可以跳过)

import type { Env } from '../index';
import {
  generateCardImageVariants,
  type CardImageVariant,
} from '../card-image-variant';

const R2_KEY_PREFIX = 'hf';
const HF_R2_USER_AGENT = 'Mozilla/5.0 (compatible; aifeeds-r2-migrate/1.0)';

const MAX_ASSET_BYTES = 5 * 1024 * 1024; // 5 MB cap
const MAX_AVATAR_BYTES = 1 * 1024 * 1024; // avatars 1 MB cap
const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024; // thumbnail 2 MB cap

const ALLOWED_IMG_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml',
]);

// ────────────────────────────────────────────────────────────────────
// backfill-media-r2
// ────────────────────────────────────────────────────────────────────

interface ItemMediaRow {
  id: string;
  media: string | null;
  extra: string | null;
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

interface HfExtra {
  submitted_by?: { avatar_url?: string; raw_avatar_url?: string; [k: string]: unknown };
  discussion_comments?: Array<{ author_avatar_url?: string; raw_author_avatar_url?: string; [k: string]: unknown }>;
  figure_image?: {
    raw_url?: string;
    r2_url?: string;
    width?: number;
    height?: number;
    [k: string]: unknown;
  };
  r2_migrated_at?: string | null;
  [k: string]: unknown;
}

export async function backfillMediaForHfPaper(
  env: Env,
  itemId: string,
): Promise<{ migrated: number; failed: number; skipped?: string }> {
  if (!env.READMES) {
    console.warn(`[hf-paper:media-r2] ${itemId}: READMES binding missing, skip`);
    return { migrated: 0, failed: 0, skipped: 'no_r2' };
  }

  const row = await env.DB.prepare(
    `SELECT id, media, extra FROM items WHERE id = ?`,
  ).bind(itemId).first<ItemMediaRow>();
  if (!row) return { migrated: 0, failed: 0, skipped: 'item_not_found' };

  const media: MediaItem[] = row.media ? JSON.parse(row.media) : [];
  const extra: HfExtra = row.extra ? JSON.parse(row.extra) : {};

  if (extra.r2_migrated_at) {
    return { migrated: 0, failed: 0, skipped: 'already_migrated' };
  }

  const primaryMediaIndex = media.findIndex((entry) =>
    entry.type === 'image' && Boolean(entry.url),
  );
  const primaryMedia = primaryMediaIndex >= 0 ? media[primaryMediaIndex] : undefined;
  const primaryRawUrl = primaryMedia?.url && !isAlreadyMigrated(primaryMedia.url)
    ? primaryMedia.url
    : primaryMedia?.role === 'figure'
      ? extra.figure_image?.raw_url
      : undefined;

  // 收集所有要迁的 URL(thumbnail + submitter avatar + 评论者 avatar)
  // 注意:figure_image 由 fetch-ar5iv-and-extract-figure 单独迁,这里不重复
  const urls: Array<{ url: string; cap: number }> = [];

  // 1. media[0] thumbnail
  for (const m of media) {
    if (m.url && !isAlreadyMigrated(m.url)) {
      urls.push({ url: m.url, cap: MAX_THUMBNAIL_BYTES });
    }
  }

  // 2. submitter avatar
  const submitterUrl = extra.submitted_by?.raw_avatar_url || extra.submitted_by?.avatar_url;
  if (submitterUrl && !isAlreadyMigrated(submitterUrl)) {
    urls.push({ url: absolutizeHfUrl(submitterUrl), cap: MAX_AVATAR_BYTES });
  }

  // 3. 评论者 avatar(若已 fetched discussion)
  for (const c of extra.discussion_comments || []) {
    const cu = c.raw_author_avatar_url || c.author_avatar_url;
    if (cu && !isAlreadyMigrated(cu)) {
      urls.push({ url: absolutizeHfUrl(cu), cap: MAX_AVATAR_BYTES });
    }
  }

  // 去重
  const uniqueUrls = Array.from(new Map(urls.map((u) => [u.url, u])).values());

  // 串行迁(并行 worker subrequest 可能超 1000 cap)
  const mapping = new Map<string, string>();
  let migrated = 0;
  let failed = 0;
  for (const { url, cap } of uniqueUrls) {
    const newUrl = await migrateOne(env, url, cap);
    if (newUrl) {
      mapping.set(url, newUrl);
      migrated++;
    } else {
      failed++;
    }
  }

  // 把 mapping 应用到 media + extra
  const newMedia = media.map((m) => {
    if (m.url && mapping.has(m.url)) return { ...m, url: mapping.get(m.url) };
    return m;
  });

  if (primaryMediaIndex >= 0 && primaryRawUrl && !isAlreadyMigrated(primaryRawUrl)) {
    const variants = await generateCardImageVariants(env.READMES, {
      sourceUrl: absolutizeHfUrl(primaryRawUrl),
      sourcePrefix: 'hf',
      mediaKind: 'image',
      sourceWidth: primaryMedia?.width || extra.figure_image?.width,
      sourceHeight: primaryMedia?.height || extra.figure_image?.height,
      sourceRequestHeaders: { 'User-Agent': HF_R2_USER_AGENT },
    });
    if (variants.length > 0) {
      newMedia[primaryMediaIndex] = {
        ...newMedia[primaryMediaIndex],
        card_variants: variants,
      };
    }
  }

  const newExtra: HfExtra = { ...extra };
  if (newExtra.submitted_by) {
    const orig = newExtra.submitted_by.raw_avatar_url || newExtra.submitted_by.avatar_url;
    if (orig) {
      const absUrl = absolutizeHfUrl(orig);
      if (mapping.has(absUrl)) {
        newExtra.submitted_by = { ...newExtra.submitted_by, avatar_url: mapping.get(absUrl) };
      }
    }
  }
  if (newExtra.discussion_comments) {
    newExtra.discussion_comments = newExtra.discussion_comments.map((c) => {
      const orig = c.raw_author_avatar_url || c.author_avatar_url;
      if (!orig) return c;
      const absUrl = absolutizeHfUrl(orig);
      if (mapping.has(absUrl)) {
        return { ...c, author_avatar_url: mapping.get(absUrl) };
      }
      return c;
    });
  }
  newExtra.r2_migrated_at = new Date().toISOString();
  if (newMedia.some((entry) => entry.card_variants?.length)) {
    newExtra.card_variant_version = 1;
    newExtra.card_variant_status = 'ok';
  }

  await env.DB.prepare(
    `UPDATE items SET media = ?, extra = ? WHERE id = ?`,
  ).bind(JSON.stringify(newMedia), JSON.stringify(newExtra), itemId).run();

  console.log(`[hf-paper:media-r2] ${itemId}: ${migrated}/${uniqueUrls.length} assets migrated`);
  return { migrated, failed };
}

function isAlreadyMigrated(url: string): boolean {
  return url.startsWith('/r/');
}

function absolutizeHfUrl(url: string): string {
  if (url.startsWith('http')) return url;
  if (url.startsWith('/')) return `https://huggingface.co${url}`;
  return url;
}

async function migrateOne(env: Env, url: string, maxBytes: number): Promise<string | null> {
  if (!env.READMES) return null;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': HF_R2_USER_AGENT } });
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') || '';
    const ctLower = ct.toLowerCase().split(';')[0].trim();
    if (!ALLOWED_IMG_TYPES.has(ctLower)) return null;

    const lenStr = r.headers.get('content-length');
    const len = lenStr ? parseInt(lenStr, 10) : -1;
    if (len > 0 && len > maxBytes) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength > maxBytes) return null;

    const hash = await sha256Hex(buf);
    const ext = extFromUrl(url, ctLower);
    const key = `${R2_KEY_PREFIX}/${hash}.${ext}`;

    await env.READMES.put(key, buf, {
      httpMetadata: { contentType: ctLower || 'application/octet-stream' },
      customMetadata: { 'src-url': url, 'source': 'hf' },
    });
    return `/r/${key}`;
  } catch (e) {
    console.error(`[hf-paper:media-r2] migrate fail ${url}`, e);
    return null;
  }
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', buf);
  const bytes = new Uint8Array(hash);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function extFromUrl(url: string, ctLower: string): string {
  // 优先看 URL 后缀
  const m = url.match(/\.(jpe?g|png|webp|gif|svg)(?:\?|$)/i);
  if (m) return m[1].toLowerCase().replace('jpeg', 'jpg');
  // fallback content-type
  if (ctLower === 'image/jpeg') return 'jpg';
  if (ctLower === 'image/png') return 'png';
  if (ctLower === 'image/webp') return 'webp';
  if (ctLower === 'image/gif') return 'gif';
  if (ctLower === 'image/svg+xml') return 'svg';
  return 'bin';
}

// ────────────────────────────────────────────────────────────────────
// refresh-gh-star(若 hasGhRepo)
// ────────────────────────────────────────────────────────────────────

interface ItemGhRow {
  extra: string | null;
}

export async function refreshGhStarForHfPaper(
  env: Env,
  itemId: string,
): Promise<{ updated: boolean; stars?: number; reason?: string }> {
  const row = await env.DB.prepare(
    `SELECT extra FROM items WHERE id = ?`,
  ).bind(itemId).first<ItemGhRow>();
  if (!row?.extra) return { updated: false, reason: 'no_extra' };

  const extra = JSON.parse(row.extra) as { github_repo?: string };
  if (!extra.github_repo) return { updated: false, reason: 'no_gh_repo' };

  // github_repo 可能是 "owner/repo" 或 "https://github.com/owner/repo"
  const match = extra.github_repo.match(/github\.com\/([^/]+)\/([^/?#]+)/);
  if (!match) {
    // 试纯 owner/repo 格式
    const m2 = extra.github_repo.match(/^([^/]+)\/([^/?#]+)$/);
    if (!m2) return { updated: false, reason: 'invalid_repo_format' };
    return await refreshStarsViaApi(env, itemId, m2[1], m2[2]);
  }
  return await refreshStarsViaApi(env, itemId, match[1], match[2]);
}

async function refreshStarsViaApi(
  env: Env,
  itemId: string,
  owner: string,
  repo: string,
): Promise<{ updated: boolean; stars?: number; reason?: string }> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'aifeeds-bot/1.0',
  };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  try {
    const r = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
    if (!r.ok) {
      console.warn(`[hf-paper:gh-star] ${owner}/${repo} HTTP ${r.status}`);
      return { updated: false, reason: `http_${r.status}` };
    }
    const data = (await r.json()) as { stargazers_count?: number };
    const stars = data.stargazers_count ?? null;
    if (stars === null) return { updated: false, reason: 'no_stars_field' };
    await env.DB.prepare(
      `UPDATE items
        SET extra = json_set(coalesce(extra, '{}'), '$.github_stars', ?),
            metrics = json_set(coalesce(metrics, '{}'), '$.github_stars', ?)
        WHERE id = ?`,
    ).bind(stars, stars, itemId).run();
    return { updated: true, stars };
  } catch (e) {
    console.error(`[hf-paper:gh-star] ${owner}/${repo} exception`, e);
    return { updated: false, reason: 'exception' };
  }
}
