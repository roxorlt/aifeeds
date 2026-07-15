import type { Env } from '../index';
import type { BlogExtra, FeedBodyMeta } from './types';
import {
  isTheVergeAuthorProfileImage,
  normalizeImageAlias,
  removeSkippableMarkdownImages,
} from './editorial-image';

export interface BlogEditorialImagePatch {
  body?: FeedBodyMeta;
  body_markdown?: string;
  body_markdown_zh?: string;
  cover_image?: string;
  editorial_image_blocked_urls?: string[];
}

export interface BlogEditorialImageCleanup {
  changed: boolean;
  removedImages: number;
  blockedUrls: string[];
  patch: BlogEditorialImagePatch;
}

/**
 * 纯函数：清理一条 blog extra 中的作者署名头像，并保留原始 URL → R2 URL 的对应关系。
 * cover 命中脏图时优先换成剩余正文图的 R2 地址；没有合格替代图则清空走 monogram。
 */
export function cleanBlogEditorialImages(extra: BlogExtra): BlogEditorialImageCleanup {
  const assets = extra.body?.assets || [];
  const blockedAliases = new Set<string>();
  const addBlockedAlias = (url: string) => {
    const raw = String(url || '').trim();
    if (!raw) return;
    blockedAliases.add(raw);
    const normalized = normalizeImageAlias(raw);
    if (normalized) blockedAliases.add(normalized);
  };
  const existingBlocked = Array.isArray(extra.editorial_image_blocked_urls)
    ? extra.editorial_image_blocked_urls
    : [];
  for (const url of existingBlocked) addBlockedAlias(url);
  let discoveredBlocked = false;
  const cleanAssets = assets.filter((asset) => {
    if (asset.kind !== 'image') return true;
    const original = String(asset.url || '').trim();
    const r2 = String(asset.r2_url || '').trim();
    const reject = isTheVergeAuthorProfileImage(original) || (!!r2 && isTheVergeAuthorProfileImage(r2));
    if (!reject) return true;
    discoveredBlocked = true;
    addBlockedAlias(original);
    addBlockedAlias(r2);
    return false;
  });

  const patch: BlogEditorialImagePatch = {};
  if (cleanAssets.length !== assets.length && extra.body) {
    patch.body = { ...extra.body, assets: cleanAssets };
  }
  if (discoveredBlocked) {
    patch.editorial_image_blocked_urls = [...new Set(
      [...existingBlocked, ...blockedAliases]
        .map((url) => normalizeImageAlias(String(url || '')))
        .filter(Boolean),
    )];
  }

  if (typeof extra.body_markdown === 'string') {
    const cleaned = removeSkippableMarkdownImages(
      extra.body_markdown,
      blockedAliases,
      isTheVergeAuthorProfileImage,
    );
    if (cleaned !== extra.body_markdown) patch.body_markdown = cleaned;
  }
  if (typeof extra.body_markdown_zh === 'string') {
    const cleaned = removeSkippableMarkdownImages(
      extra.body_markdown_zh,
      blockedAliases,
      isTheVergeAuthorProfileImage,
    );
    if (cleaned !== extra.body_markdown_zh) patch.body_markdown_zh = cleaned;
  }

  const cover = String(extra.cover_image || '').trim();
  if (
    cover
    && (
      blockedAliases.has(cover)
      || blockedAliases.has(normalizeImageAlias(cover))
      || isTheVergeAuthorProfileImage(cover)
    )
  ) {
    const replacement = cleanAssets.find(
      (asset) => asset.kind === 'image' && (asset.r2_url || asset.url),
    );
    patch.cover_image = String(replacement?.r2_url || replacement?.url || '');
  }

  return {
    changed: Object.keys(patch).length > 0,
    removedImages: assets.length - cleanAssets.length,
    blockedUrls: [...blockedAliases],
    patch,
  };
}

/** 清理 items.media 中仍引用的头像；未变化时逐字节返回原 JSON。 */
export function cleanBlogMediaJson(
  media: string | null,
  blockedUrls: ReadonlySet<string>,
): { media: string | null; changed: boolean; removedImages: number } {
  if (!media) return { media, changed: false, removedImages: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(media);
  } catch {
    return { media, changed: false, removedImages: 0 };
  }
  if (!Array.isArray(parsed)) return { media, changed: false, removedImages: 0 };
  const clean = parsed.filter((entry) => {
    if (!entry || typeof entry !== 'object') return true;
    const item = entry as { type?: unknown; url?: unknown };
    if (item.type !== 'image' || typeof item.url !== 'string') return true;
    const url = item.url.trim();
    return !blockedUrls.has(url)
      && !blockedUrls.has(normalizeImageAlias(url))
      && !isTheVergeAuthorProfileImage(url);
  });
  const removedImages = parsed.length - clean.length;
  return removedImages > 0
    ? { media: JSON.stringify(clean), changed: true, removedImages }
    : { media, changed: false, removedImages: 0 };
}

const THE_VERGE_CLEANUP_PREDICATE = `
  source_type = 'blog'
  AND (
    json_extract(extra, '$.feed_key') = 'the-verge'
    OR id LIKE 'blog:the-verge:%'
  )
  AND json_extract(extra, '$.workflow_completed_at') IS NOT NULL
  AND json_extract(extra, '$.blog_media_r2_at') IS NOT NULL
  AND json_extract(extra, '$.editorial_image_cleaned_at') IS NULL`;

interface CleanupRow {
  id: string;
  extra: string | null;
  media: string | null;
}

/** 一次性分页清理 The Verge 存量；新数据由 extract.ts 入库前过滤。 */
export async function runTheVergeEditorialImageCleanup(
  env: Env,
  opts: { limit: number; dry: boolean },
): Promise<{
  scanned: number;
  fixed: number;
  removedImages: number;
  conflicts: number;
  remaining: number;
}> {
  const nowIso = new Date().toISOString();
  const batch = await env.DB.prepare(
    `SELECT id, extra, media FROM items WHERE ${THE_VERGE_CLEANUP_PREDICATE} LIMIT ?`,
  )
    .bind(opts.limit)
    .all<CleanupRow>();

  let scanned = 0;
  let fixed = 0;
  let removedImages = 0;
  let conflicts = 0;

  for (const row of batch.results || []) {
    scanned++;
    let extra: BlogExtra = {};
    try {
      extra = row.extra ? JSON.parse(row.extra) : {};
    } catch {
      extra = {};
    }
    const cleanup = cleanBlogEditorialImages(extra);
    const mediaCleanup = cleanBlogMediaJson(row.media, new Set(cleanup.blockedUrls));
    const changed = cleanup.changed || mediaCleanup.changed;
    const removed = cleanup.removedImages + mediaCleanup.removedImages;
    if (opts.dry) {
      if (changed) fixed++;
      removedImages += removed;
      continue;
    }

    const setters: string[] = [];
    const binds: unknown[] = [];
    if (cleanup.patch.body) {
      setters.push("'$.body', json(?)");
      binds.push(JSON.stringify(cleanup.patch.body));
    }
    if (cleanup.patch.body_markdown !== undefined) {
      setters.push("'$.body_markdown', ?");
      binds.push(cleanup.patch.body_markdown);
    }
    if (cleanup.patch.body_markdown_zh !== undefined) {
      setters.push("'$.body_markdown_zh', ?");
      binds.push(cleanup.patch.body_markdown_zh);
    }
    if (cleanup.patch.cover_image !== undefined) {
      setters.push("'$.cover_image', ?");
      binds.push(cleanup.patch.cover_image);
    }
    if (cleanup.patch.editorial_image_blocked_urls !== undefined) {
      setters.push("'$.editorial_image_blocked_urls', json(?)");
      binds.push(JSON.stringify(cleanup.patch.editorial_image_blocked_urls));
    }
    setters.push("'$.editorial_image_cleaned_at', ?");
    binds.push(nowIso);

    const mediaSet = mediaCleanup.changed ? ', media = ?' : '';
    if (mediaCleanup.changed) binds.push(mediaCleanup.media);
    binds.push(row.id, row.extra, row.media);

    const update = await env.DB.prepare(
      `UPDATE items
       SET extra = json_set(COALESCE(extra,'{}'), ${setters.join(', ')})${mediaSet}
       WHERE id = ? AND extra = ? AND COALESCE(media, '') = COALESCE(?, '')`,
    )
      .bind(...binds)
      .run();
    if (!update.meta?.changes) {
      conflicts++;
      continue;
    }
    if (changed) fixed++;
    removedImages += removed;
  }

  const remaining = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM items WHERE ${THE_VERGE_CLEANUP_PREDICATE}`,
  ).first<{ c: number }>();

  return {
    scanned,
    fixed,
    removedImages,
    conflicts,
    remaining: remaining?.c ?? 0,
  };
}
