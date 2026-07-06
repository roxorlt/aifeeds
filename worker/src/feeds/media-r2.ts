// worker/src/feeds/media-r2.ts
//
// blog / podcast 媒体迁 R2（§9.1 / §9.2）。复用 ph-r2.ts / x-media-r2.ts 的
// 「collectAssets → migrateOne → rewrite」六步：mime 白名单 + size cap +
// SHA-256 内容寻址 key（同图自动去重）+ 跳 `/r/` 已迁路径。
//
// 迁什么（§9.1）：
//   - blog：封面（无条件，不过质量门控）+ 正文 inline 图（过 ar5iv 质量门控）
//           + 正文 inline 直链视频（mp4，仅过 size cap）+ publisher logo
//   - podcast：单集封面（无条件）+ publisher logo
//   - **音频绝不迁**（几十 MB + `/r/` 无 Range → seek 失效 + 1c1g 香港中转 OOM）
//
// 质量门控（仅 inline 图，抄 hf-paper/ar5iv.ts:migrateFigureToR2）：
//   aspect 0.25–4 + byte density ≥0.05 + maxDim ≥300（滤 logo/banner/icon）。
//   CF Workers 无 image decode API → 自己 parse PNG/JPEG/GIF magic bytes 读 dim。
//   webp/avif/svg 无法 probe：不一刀切拒绝（现代博客大量用 webp），改用最小字节
//   阈值兜底过滤 icon/spacer。封面 / logo 不过门控（明确选中的资产）。
//
// ⚠️ 防重 marker 用专属字段 `blog_media_r2_at` / `podcast_media_r2_at`，
//    **不撞** `r2_migrated_at`（GH/PH 已占，ph-r2.ts:285）/ `x_media_r2_at`（X 已占）。
// ⚠️ lost-update（§9.2）：step4 是 fan-out（enrich+translate 并行写 extra），
//    本步**只用 json_set 改自己字段**（cover_image / body / body_markdown /
//    publisher / marker），绝不整列 read-modify-write 擦掉并行的 enrich 字段。
//
// 设计文档：docs/plans/2026-06-09-ai-vendor-feeds-source-design.md §9.1 / §9.2

import type { Env } from "../index";
import type {
  ParsedFeedItem,
  BlogExtra,
  PodcastExtra,
  FeedBodyAsset,
  FeedPublisher,
} from "./types";
import { extractPageMeta, throttledFetchText } from "./extract";

const R2_PREFIX_BLOG = "blog";
const R2_PREFIX_PODCAST = "podcast";

const IMG_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const VIDEO_MAX_BYTES = 10 * 1024 * 1024; // 10 MB（blog 正文直链 mp4）
const LOGO_MAX_BYTES = 1 * 1024 * 1024; // 1 MB（publisher logo / favicon）
// 无法 probe 尺寸的 inline 图（webp/avif/svg）最小字节阈值——低于此判定为 icon/spacer 丢弃。
const MIN_UNPROBEABLE_INLINE_BYTES = 8 * 1024; // 8 KB

// 接近真实浏览器的 UA：部分博客/播客 CDN 对纯 bot UA 防盗链。
const FEED_R2_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const ALLOWED_IMG_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/svg+xml",
  "image/x-icon",
]);
const ALLOWED_VIDEO_TYPES = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime",
]);
const EXT_FROM_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "image/x-icon": "ico",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

// ─────────────────────────────────────────────────────────────────────────────
// §9.1 封面多源回退链（纯函数，fetch 侧 blog.ts/podcast.ts 在 parse 时调用填
// extra.cover_image；本文件迁移侧只消费已落库的 cover_image）。
//
// parse.ts 的 ParsedFeedItem.cover_url 已实现 item 级 ①–④（enclosure /
// media:content / media:thumbnail / itunes:image）。此处再叠加 ⑤ channel 级
// 封面 + ⑥ 详情页 og:image，取第一个非空。
// ─────────────────────────────────────────────────────────────────────────────

export function pickCoverUrl(
  parsed: ParsedFeedItem,
  channelImage?: string,
  detailOgImage?: string,
): string | undefined {
  const candidates = [parsed.cover_url, channelImage, detailOgImage];
  for (const c of candidates) {
    const v = (c || "").trim();
    if (v) return v;
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// 通用工具（抄 ph-r2 / x-media-r2 / ar5iv）
// ─────────────────────────────────────────────────────────────────────────────

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function extFromUrl(url: string, contentType: string | null): string {
  if (contentType) {
    const ct = contentType.toLowerCase().split(";")[0].trim();
    if (EXT_FROM_TYPE[ct]) return EXT_FROM_TYPE[ct];
  }
  const m = url.match(/\.([a-zA-Z0-9]{2,5})(?:\?|$)/);
  return m ? m[1].toLowerCase() : "bin";
}

function isAlreadyMigrated(url: string | null | undefined): boolean {
  return !!url && url.startsWith("/r/");
}

// 图片 magic bytes 解析（PNG/JPEG/GIF），抄 hf-paper/ar5iv.ts:probeImageDimensions。
// CF Workers 无原生 image decode API，只能自己 parse binary header 读 dimensions。
function probeImageDimensions(
  buf: ArrayBuffer,
): { width: number; height: number } | undefined {
  const png = probePngDimensions(buf);
  if (png) return png;
  if (buf.byteLength < 4) return undefined;
  const v = new DataView(buf);
  // JPEG: walk segments (FF Mn LL LL ...) 找 SOF (C0-CF except C4/C8/CC)
  if (v.getUint8(0) === 0xff && v.getUint8(1) === 0xd8) {
    let i = 2;
    while (i < buf.byteLength - 1) {
      if (v.getUint8(i) !== 0xff) return undefined;
      const marker = v.getUint8(i + 1);
      i += 2;
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        if (i + 7 > buf.byteLength) return undefined;
        const height = v.getUint16(i + 3);
        const width = v.getUint16(i + 5);
        if (!width || !height) return undefined;
        return { width, height };
      }
      if (i + 2 > buf.byteLength) return undefined;
      const segLen = v.getUint16(i);
      i += segLen;
    }
    return undefined;
  }
  // GIF: 47 49 46 38 ... 6,7=width(LE) 8,9=height(LE)
  if (v.getUint32(0) === 0x47494638 && buf.byteLength >= 10) {
    return { width: v.getUint16(6, true), height: v.getUint16(8, true) };
  }
  return undefined;
}

function probePngDimensions(
  buf: ArrayBuffer,
): { width: number; height: number } | undefined {
  // PNG: 89 50 4E 47 0D 0A 1A 0A，IHDR chunk @ offset 16: width(BE) + height(BE)
  if (buf.byteLength < 24) return undefined;
  const v = new DataView(buf);
  if (
    v.getUint8(0) !== 0x89 ||
    v.getUint8(1) !== 0x50 ||
    v.getUint8(2) !== 0x4e ||
    v.getUint8(3) !== 0x47
  ) {
    return undefined;
  }
  const width = v.getUint32(16);
  const height = v.getUint32(20);
  if (!width || !height) return undefined;
  return { width, height };
}

// ar5iv 风质量门控（图 buffer → 合格与否）。滤 logo/banner/icon/spacer。
// aspect 0.25–4 + byte density ≥0.05 + maxDim ≥300；webp/avif/svg 无法 probe →
// 最小字节阈值兜底。migrateAsset（inline 图 / 封面迁移）与 cover-quality-sweep 共用。
export function passesFeedImageQualityGate(buf: ArrayBuffer): boolean {
  const dim = probeImageDimensions(buf);
  if (!dim) return buf.byteLength >= MIN_UNPROBEABLE_INLINE_BYTES;
  const ar = dim.width / dim.height;
  if (ar > 4 || ar < 0.25) return false;
  if (buf.byteLength / (dim.width * dim.height) < 0.05) return false;
  if (Math.max(dim.width, dim.height) < 300) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// 单资产迁移：下载 → 校验（mime + size，inline 图额外过质量门控）→ 上传 R2。
// 返回 `/r/<prefix>/<sha256>.<ext>`；失败 / 不达标 / 已迁 → null。
// ─────────────────────────────────────────────────────────────────────────────

interface MigrateAssetOpts {
  prefix: string;
  kind: "image" | "video";
  maxBytes: number;
  /** 仅正文 inline 图开启：ar5iv 风质量门控（滤 logo/banner/icon）。 */
  qualityGate: boolean;
}

async function migrateAsset(
  env: Env,
  url: string,
  opts: MigrateAssetOpts,
): Promise<string | null> {
  if (!env.READMES) return null;
  if (isAlreadyMigrated(url)) return null; // 已是 /r/，调用方不重复入 mapping
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": FEED_R2_USER_AGENT, Accept: "*/*" },
    });
    if (!r.ok) return null;
    const ct = r.headers.get("content-type") || "";
    const ctLower = ct.toLowerCase().split(";")[0].trim();
    const isImage = ALLOWED_IMG_TYPES.has(ctLower);
    const isVideo = ALLOWED_VIDEO_TYPES.has(ctLower);
    if (opts.kind === "video" ? !isVideo : !isImage) return null;

    const lenStr = r.headers.get("content-length");
    const len = lenStr ? parseInt(lenStr, 10) : -1;
    if (len > 0 && len > opts.maxBytes) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength > opts.maxBytes) return null;

    // ─── 质量门控（inline 图 + 封面迁移共用）───
    if (opts.qualityGate && opts.kind === "image") {
      if (!passesFeedImageQualityGate(buf)) {
        console.log(`[feeds-r2] reject ${url}: quality gate (${buf.byteLength}B)`);
        return null;
      }
    }

    const hash = await sha256Hex(buf);
    const ext = extFromUrl(url, ct);
    const key = `${opts.prefix}/${hash}.${ext}`;
    await env.READMES.put(key, buf, {
      httpMetadata: { contentType: ct || "application/octet-stream" },
      customMetadata: { "src-url": url, kind: opts.kind, source: opts.prefix },
    });
    return `/r/${key}`;
  } catch (e) {
    console.error(`[feeds-r2] asset error ${url}:`, e);
    return null;
  }
}

// 单张 blog 封面 URL → R2（过质量门；Fix 3 backfill 复用）。合格返回 /r/key，否则 null。
export async function migrateFeedCover(
  env: Env,
  coverUrl: string,
): Promise<string | null> {
  return migrateAsset(env, coverUrl, {
    prefix: R2_PREFIX_BLOG,
    kind: "image",
    maxBytes: IMG_MAX_BYTES,
    qualityGate: true,
  });
}

// publisher logo / favicon 迁 R2（§9.1 / D9：BE 迁真实 logo）。
// icon_src_url → icon_r2；幂等（内容寻址 + 已是 /r/ 早退）。返回是否改动。
async function migratePublisherLogo(
  env: Env,
  publisher: FeedPublisher | undefined,
  prefix: string,
): Promise<boolean> {
  if (!publisher || !publisher.icon_src_url) return false;
  if (isAlreadyMigrated(publisher.icon_r2)) return false;
  const r2 = await migrateAsset(env, publisher.icon_src_url, {
    prefix,
    kind: "image",
    maxBytes: LOGO_MAX_BYTES,
    qualityGate: false, // logo 是明确选中的 chrome 资产，不过门控
  });
  if (!r2) return false;
  publisher.icon_r2 = r2;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// 字符串替换：把正文 markdown 里的原始 URL 改写成 /r/ key（split/join 免转义）。
// ─────────────────────────────────────────────────────────────────────────────

function rewriteMarkdownUrls(
  md: string,
  mapping: Map<string, string>,
): string {
  let out = md;
  for (const [from, to] of mapping) {
    if (out.includes(from)) out = out.split(from).join(to);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 防 lost-update：只用 json_set 改本步字段，不整列覆盖（§9.2）。
// path 全部来自固定字面量白名单（无注入风险）；value 走 bind。
// ─────────────────────────────────────────────────────────────────────────────

interface ExtraPatch {
  path: string;
  value: string;
  /** true → 用 json(?) 把字符串解析回 JSON 对象（嵌套 body / publisher）。 */
  json?: boolean;
}

async function applyExtraPatch(
  env: Env,
  itemId: string,
  patches: ExtraPatch[],
): Promise<void> {
  if (patches.length === 0) return;
  const setters = patches
    .map((p) => `'${p.path}', ${p.json ? "json(?)" : "?"}`)
    .join(", ");
  const sql = `UPDATE items SET extra = json_set(COALESCE(extra, '{}'), ${setters}) WHERE id = ?`;
  const binds = [...patches.map((p) => p.value), itemId];
  await env.DB.prepare(sql).bind(...binds).run();
}

interface ItemRow {
  id: string;
  extra_raw: string | null;
}

// ═════════════════════════════════════════════════════════════════════════════
// blog：封面 + 正文 inline 图/视频 + publisher logo 迁 R2（音频无）。
// ═════════════════════════════════════════════════════════════════════════════

export async function migrateMediaForBlog(
  env: Env,
  itemId: string,
): Promise<{ migrated: number; marker: "blog_media_r2_at" }> {
  const marker = "blog_media_r2_at" as const;
  if (!env.READMES) {
    console.warn("[feeds-r2:blog] R2 binding READMES 未配置 — 跳过");
    return { migrated: 0, marker };
  }
  const row = await env.DB.prepare(
    `SELECT id, extra as extra_raw FROM items WHERE id = ? AND source_type='blog'`,
  )
    .bind(itemId)
    .first<ItemRow>();
  if (!row) throw new Error(`migrateMediaForBlog: item not found ${itemId}`);

  const extra: BlogExtra = row.extra_raw ? JSON.parse(row.extra_raw) : {};
  if (extra.blog_media_r2_at) return { migrated: 0, marker }; // 已迁过早退（幂等）

  const nowIso = new Date().toISOString();
  const mapping = new Map<string, string>(); // 原始 URL → /r/key
  let migrated = 0;

  // ── 1. 封面（过质量门控；不合格/防盗链失败 → cover 落 null，不保留外链）──
  let newCover: string | undefined;
  let coverRejected = false;
  const cover = (extra.cover_image || "").trim();
  if (cover && !isAlreadyMigrated(cover)) {
    const r2 = await migrateAsset(env, cover, {
      prefix: R2_PREFIX_BLOG,
      kind: "image",
      maxBytes: IMG_MAX_BYTES,
      qualityGate: true,
    });
    if (r2) {
      mapping.set(cover, r2);
      newCover = r2;
      migrated++;
    } else {
      // 迁移/门控失败 → 清空 cover_image（渲染层 Fix 1 已不用外链 cover，
      // 前端/日报走 monogram / 节目图兜底，设计文档 §769）。
      coverRejected = true;
    }
  }

  // ── 2. 正文 inline 资产（图过质量门控；直链视频仅过 size cap）──
  const assets: FeedBodyAsset[] = extra.body?.assets ? [...extra.body.assets] : [];
  const newAssets: FeedBodyAsset[] = [];
  for (const a of assets) {
    const next: FeedBodyAsset = { ...a };
    const u = (a.url || "").trim();
    if (u && !isAlreadyMigrated(u) && !mapping.has(u)) {
      const isVideo = a.kind === "video";
      const r2 = await migrateAsset(env, u, {
        prefix: R2_PREFIX_BLOG,
        kind: isVideo ? "video" : "image",
        maxBytes: isVideo ? VIDEO_MAX_BYTES : IMG_MAX_BYTES,
        // 封面角色不过门控；inline 图过门控；视频无门控（仅 size cap）。
        qualityGate: a.role === "inline" && !isVideo,
      });
      if (r2) {
        mapping.set(u, r2);
        migrated++;
      }
    }
    // 已在 mapping 中（本轮迁或同 URL）→ 回填 r2_url
    const mapped = mapping.get(u);
    if (mapped) next.r2_url = mapped;
    else if (isAlreadyMigrated(u)) next.r2_url = u;
    newAssets.push(next);
  }

  // ── 3. publisher logo ──
  const publisher: FeedPublisher | undefined = extra.publisher
    ? { ...extra.publisher }
    : undefined;
  const logoChanged = await migratePublisherLogo(env, publisher, R2_PREFIX_BLOG);
  if (logoChanged) migrated++;

  // ── 4. 正文 markdown 内嵌 URL 改写 ──
  const oldMd = extra.body_markdown || "";
  const newMd = mapping.size ? rewriteMarkdownUrls(oldMd, mapping) : oldMd;

  // ── 5. 落库（json_set 只改自己字段，防擦并行 enrich）──
  const patches: ExtraPatch[] = [{ path: "$.blog_media_r2_at", value: nowIso }];
  if (newCover) {
    patches.push({ path: "$.cover_image", value: newCover });
    patches.push({ path: "$.cover_backfilled_at", value: nowIso });
  } else if (coverRejected) {
    // 空串 = 渲染层 falsy 处理（等价无封面）；不保留外链，避免日报/卡片挂图。
    patches.push({ path: "$.cover_image", value: "" });
    patches.push({ path: "$.cover_rejected_at", value: nowIso });
  }
  if (extra.body && assets.length) {
    const newBody = { ...extra.body, assets: newAssets };
    patches.push({ path: "$.body", value: JSON.stringify(newBody), json: true });
  }
  if (newMd !== oldMd) {
    patches.push({ path: "$.body_markdown", value: newMd });
  }
  if (logoChanged && publisher) {
    patches.push({
      path: "$.publisher",
      value: JSON.stringify(publisher),
      json: true,
    });
  }
  await applyExtraPatch(env, itemId, patches);

  console.log(`[feeds-r2:blog] ${itemId}: ${migrated} assets migrated`);
  return { migrated, marker };
}

// ═════════════════════════════════════════════════════════════════════════════
// podcast：只迁单集封面 + publisher logo。**音频绝不迁**（§9.1）。
// ═════════════════════════════════════════════════════════════════════════════

export async function migrateCoverForPodcast(
  env: Env,
  itemId: string,
): Promise<{ migrated: number; marker: "podcast_media_r2_at" }> {
  const marker = "podcast_media_r2_at" as const;
  if (!env.READMES) {
    console.warn("[feeds-r2:podcast] R2 binding READMES 未配置 — 跳过");
    return { migrated: 0, marker };
  }
  const row = await env.DB.prepare(
    `SELECT id, extra as extra_raw FROM items WHERE id = ? AND source_type='podcast'`,
  )
    .bind(itemId)
    .first<ItemRow>();
  if (!row) throw new Error(`migrateCoverForPodcast: item not found ${itemId}`);

  const extra: PodcastExtra = row.extra_raw ? JSON.parse(row.extra_raw) : {};
  if (extra.podcast_media_r2_at) return { migrated: 0, marker }; // 幂等早退

  const nowIso = new Date().toISOString();
  let migrated = 0;

  // ── 单集封面（过质量门控；不合格/防盗链失败 → cover 落 null；audio_url 完全不碰）──
  let newCover: string | undefined;
  let coverRejected = false;
  const cover = (extra.cover_image || "").trim();
  if (cover && !isAlreadyMigrated(cover)) {
    const r2 = await migrateAsset(env, cover, {
      prefix: R2_PREFIX_PODCAST,
      kind: "image",
      maxBytes: IMG_MAX_BYTES,
      qualityGate: true,
    });
    if (r2) {
      newCover = r2;
      migrated++;
    } else {
      coverRejected = true;
    }
  }

  // ── publisher logo ──
  const publisher: FeedPublisher | undefined = extra.publisher
    ? { ...extra.publisher }
    : undefined;
  const logoChanged = await migratePublisherLogo(
    env,
    publisher,
    R2_PREFIX_PODCAST,
  );
  if (logoChanged) migrated++;

  const patches: ExtraPatch[] = [
    { path: "$.podcast_media_r2_at", value: nowIso },
  ];
  if (newCover) {
    patches.push({ path: "$.cover_image", value: newCover });
    patches.push({ path: "$.cover_backfilled_at", value: nowIso });
  } else if (coverRejected) {
    patches.push({ path: "$.cover_image", value: "" });
    patches.push({ path: "$.cover_rejected_at", value: nowIso });
  }
  if (logoChanged && publisher) {
    patches.push({
      path: "$.publisher",
      value: JSON.stringify(publisher),
      json: true,
    });
  }
  await applyExtraPatch(env, itemId, patches);

  console.log(`[feeds-r2:podcast] ${itemId}: ${migrated} assets migrated`);
  return { migrated, marker };
}

// ═════════════════════════════════════════════════════════════════════════════
// podcast 音频迁 R2(2026-06-12 验收反馈 #3:干掉"直连原平台"文案,音频入库 R2,
// 经 /r/(已支持 Range seek)+ 香港中转服务大陆用户)。
//
// 与图片路径的关键差异 —— **流式直传,绝不 buffer**:
//   - 单集 30-200MB,worker 内存 128MB,arrayBuffer 必 OOM → resp.body 直接 put
//   - R2 put 流式要求已知长度 → 依赖上游 Content-Length;无(chunked)→ 跳过保留原链
//   - key 用 sha256(URL) 而非内容 hash(内容 hash 需全量读)
//   - >250MB 跳过保留原链(R2 存储成本 + workflow step 时长)
// 失败/跳过均保留原 enclosure 直链,前端播放器 graceful(直链兜底)。
// ═════════════════════════════════════════════════════════════════════════════

const AUDIO_MAX_BYTES = 250 * 1024 * 1024;
const AUDIO_EXT_FROM_TYPE: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
};

export async function migrateAudioForPodcast(
  env: Env,
  itemId: string,
): Promise<{ migrated: boolean; reason: string }> {
  if (!env.READMES) return { migrated: false, reason: "no-r2-binding" };
  const row = await env.DB.prepare(
    `SELECT id, extra as extra_raw FROM items WHERE id = ? AND source_type='podcast'`,
  )
    .bind(itemId)
    .first<ItemRow>();
  if (!row) return { migrated: false, reason: "not-found" };
  const extra: PodcastExtra & {
    audio_r2_at?: string;
    audio_r2_skip?: string;
    audio_src_url?: string;
  } = row.extra_raw ? JSON.parse(row.extra_raw) : {};

  const audio = String(extra.audio_url || "").trim();
  if (!audio) return { migrated: false, reason: "no-audio" };
  if (audio.startsWith("/r/")) return { migrated: false, reason: "already" };
  if (extra.audio_r2_at) return { migrated: false, reason: "already" };
  if (extra.audio_r2_skip) return { migrated: false, reason: `skip:${extra.audio_r2_skip}` };

  const markSkip = async (why: string) => {
    await applyExtraPatch(env, itemId, [{ path: "$.audio_r2_skip", value: why }]);
    return { migrated: false, reason: `skip:${why}` };
  };

  let resp: Response;
  try {
    resp = await fetch(audio, {
      redirect: "follow",
      headers: { "User-Agent": FEED_R2_USER_AGENT, Accept: "*/*" },
    });
  } catch {
    return { migrated: false, reason: "fetch-error" }; // 网络错不标 skip,下轮重试
  }
  if (!resp.ok || !resp.body) return { migrated: false, reason: `http-${resp.status}` };

  const len = parseInt(resp.headers.get("content-length") || "", 10);
  if (!Number.isFinite(len) || len <= 0) {
    // chunked 无长度 → R2 流式 put 不支持未知长度,保留原链
    try { await resp.body.cancel(); } catch { /* ignore */ }
    return markSkip("no-length");
  }
  if (len > AUDIO_MAX_BYTES) {
    try { await resp.body.cancel(); } catch { /* ignore */ }
    return markSkip("too-large");
  }

  const ct = (resp.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const ext = AUDIO_EXT_FROM_TYPE[ct] || extFromUrl(audio, ct) || "mp3";
  const urlDigest = await sha256Hex(new TextEncoder().encode(audio).buffer as ArrayBuffer);
  const key = `podcast-audio/${urlDigest}.${ext}`;

  try {
    await env.READMES.put(key, resp.body, {
      httpMetadata: { contentType: ct || "audio/mpeg" },
    });
  } catch (e) {
    console.error(`[feeds-r2:audio] ${itemId} put error:`, e);
    return { migrated: false, reason: "put-error" }; // 不标 skip,下轮重试
  }

  const nowIso = new Date().toISOString();
  await applyExtraPatch(env, itemId, [
    { path: "$.audio_src_url", value: audio },          // 原 enclosure 备份
    { path: "$.audio_url", value: `/r/${key}` },        // FE resolveAssetUrl 拼 API base
    { path: "$.audio_r2_at", value: nowIso },
  ]);
  console.log(`[feeds-r2:audio] ${itemId}: ${(len / 1048576).toFixed(1)}MB → ${key}`);
  return { migrated: true, reason: "ok" };
}

// ═════════════════════════════════════════════════════════════════════════════
// 一次性清洗:cover-quality-sweep（症状 2 + 外链残留）。
//   - R2 形态 cover_image 的 blog/podcast item：R2 读回图 buffer 过质量门，
//     不过 → cover_image 清空（json_remove）。
//   - 外链态 cover_image 且迁移 marker 已置位（~102 条永不重试）：直接清空。
//   - 通过 / 处理过的 item 打 `$.cover_swept_at` marker，下轮不再扫（分页前进）。
// 返回 {scanned, cleared, remaining} 供循环调用；dry=1 只统计不落盘。
// R2 读走 binding（非 HTTP 子请求），单次 limit 默认 40 稳在子请求限额内。
// ═════════════════════════════════════════════════════════════════════════════

// cover url（`/r/blog/hash.jpg` 或 api 域绝对形式）→ R2 key（`blog/hash.jpg`）。
function coverR2Key(u: string): string | null {
  const i = u.indexOf("/r/");
  return i >= 0 ? u.slice(i + 3) : null;
}

function isR2CoverUrl(u: string): boolean {
  return u.startsWith("/r/") || /^https?:\/\/[^/]+\/r\//i.test(u);
}

interface SweepRow {
  id: string;
  source_type: string;
  extra: string | null;
}

// 一批待扫 item 的 SQL 谓词（batch + remaining 共用，保证 remaining 单调递减）。
const SWEEP_PREDICATE = `
  source_type IN ('blog','podcast')
  AND json_extract(extra, '$.cover_swept_at') IS NULL
  AND COALESCE(json_extract(extra, '$.cover_image'), '') != ''
  AND (
    json_extract(extra, '$.cover_image') LIKE '/r/%'
    OR json_extract(extra, '$.cover_image') LIKE 'http%://%/r/%'
    OR json_extract(extra, '$.blog_media_r2_at') IS NOT NULL
    OR json_extract(extra, '$.podcast_media_r2_at') IS NOT NULL
  )`;

export async function runCoverQualitySweep(
  env: Env,
  opts: { limit: number; dry: boolean },
): Promise<{ scanned: number; cleared: number; remaining: number }> {
  const nowIso = new Date().toISOString();
  const batch = await env.DB.prepare(
    `SELECT id, source_type, extra FROM items WHERE ${SWEEP_PREDICATE} LIMIT ?`,
  )
    .bind(opts.limit)
    .all<SweepRow>();

  let scanned = 0;
  let cleared = 0;
  for (const row of batch.results || []) {
    scanned++;
    let extra: Record<string, unknown> = {};
    try {
      extra = row.extra ? JSON.parse(row.extra) : {};
    } catch {
      extra = {};
    }
    const cover = String(extra.cover_image || "").trim();
    let clear = false;
    if (isR2CoverUrl(cover)) {
      const key = coverR2Key(cover);
      let buf: ArrayBuffer | null = null;
      if (key && env.READMES) {
        try {
          const obj = await env.READMES.get(key);
          buf = obj ? await obj.arrayBuffer() : null;
        } catch {
          buf = null;
        }
      }
      // 读不到对象（已失联）或过不了门 → 清空。
      if (!buf || !passesFeedImageQualityGate(buf)) clear = true;
    } else {
      // 外链态（能进本批 ⇒ 迁移 marker 已置位）→ 直接清空，数据面归零。
      clear = true;
    }

    if (!opts.dry) {
      const sql = clear
        ? `UPDATE items SET extra = json_set(json_remove(COALESCE(extra,'{}'), '$.cover_image'), '$.cover_swept_at', ?) WHERE id = ?`
        : `UPDATE items SET extra = json_set(COALESCE(extra,'{}'), '$.cover_swept_at', ?) WHERE id = ?`;
      await env.DB.prepare(sql).bind(nowIso, row.id).run();
    }
    if (clear) cleared++;
  }

  const rem = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM items WHERE ${SWEEP_PREDICATE}`,
  ).first<{ c: number }>();
  return { scanned, cleared, remaining: rem?.c ?? 0 };
}

// ═════════════════════════════════════════════════════════════════════════════
// Fix 2a：源级通用图剔除（blog-cover-generic-sweep，2026-07-06）。
//   统计特征法：同一 blog source（feed_key）内 cover_image 命中**同一 R2 hash**
//   ≥ minCount 次 → 判为「源级通用图」（作者头像 / 站点通栏 / 二维码横幅都逃不过）。
//   整簇 cover_image 清空（json_remove），并**清掉 cover_og_backfilled_at 游标**，
//   使随后 Fix 3 blog-cover-og-backfill 能重新拉 og:image 回填真 hero。
//   dry=1 只列簇明细（src / cover / count）供人工核对，不落盘。
//   src 派生 = COALESCE(feed_key, show_key, source_type)，与两条 SQL 保持一致。
//
//   ⚠️ 只扫 source_type='blog'（审查修复，2026-07-06）：播客单集共用节目封面是
//      合法常态（一档节目所有 episode 天然同一张节目图），且 og-backfill 只回填 blog，
//      清了 podcast 簇没有回填方 → 永久掉封面。故收敛到 blog-only。
//   ⚠️ 清簇时把被清 R2 key 记到 `$.cover_generic_cleared_hash`（Fix C，2026-07-06）：
//      供 og-backfill 判定「回填的 og:image 又是同一张通用图」→ 跳过写入终止
//      sweep↔backfill 无限循环（og:image 本身就是站点通用图时）。
// ═════════════════════════════════════════════════════════════════════════════

// src 派生表达式（聚合 GROUP BY 与逐簇 UPDATE 复用同一字面量，保证匹配一致）。
const GENERIC_SRC_EXPR =
  "COALESCE(json_extract(extra,'$.feed_key'), json_extract(extra,'$.show_key'), source_type)";

interface GenericClusterRow {
  src: string;
  cover: string;
  n: number;
}

export async function runBlogCoverGenericSweep(
  env: Env,
  opts: { minCount: number; limit: number; dry: boolean },
): Promise<{
  clusters: Array<{ src: string; cover: string; count: number }>;
  clustersCleared: number;
  itemsCleared: number;
}> {
  const nowIso = new Date().toISOString();
  const agg = await env.DB.prepare(
    `SELECT ${GENERIC_SRC_EXPR} AS src,
            json_extract(extra,'$.cover_image') AS cover,
            COUNT(*) AS n
       FROM items
      WHERE source_type = 'blog'
        AND COALESCE(json_extract(extra,'$.cover_image'),'') != ''
        AND (json_extract(extra,'$.cover_image') LIKE '/r/%'
             OR json_extract(extra,'$.cover_image') LIKE 'http%://%/r/%')
      GROUP BY src, cover
     HAVING n >= ?
      ORDER BY n DESC
      LIMIT ?`,
  )
    .bind(opts.minCount, opts.limit)
    .all<GenericClusterRow>();

  const clusters = (agg.results || []).map((r) => ({
    src: String(r.src),
    cover: String(r.cover),
    count: Number(r.n),
  }));

  let clustersCleared = 0;
  let itemsCleared = 0;
  if (!opts.dry) {
    for (const c of clusters) {
      // 清簇：cover_image + cover_og_backfilled_at 一并移除（让 Fix 3 可重填），打 cleared marker
      // + 记被清 R2 key 到 cover_generic_cleared_hash（Fix C：og-backfill 判同 hash 回填终止循环）。
      const clearedKey = coverR2Key(c.cover) || c.cover;
      await env.DB.prepare(
        `UPDATE items
            SET extra = json_set(
                          json_remove(COALESCE(extra,'{}'),
                            '$.cover_image', '$.cover_og_backfilled_at'),
                          '$.cover_generic_cleared_at', ?,
                          '$.cover_generic_cleared_hash', ?)
          WHERE source_type = 'blog'
            AND json_extract(extra,'$.cover_image') = ?
            AND ${GENERIC_SRC_EXPR} = ?`,
      )
        .bind(nowIso, clearedKey, c.cover, c.src)
        .run();
      clustersCleared++;
      itemsCleared += c.count;
    }
  }

  return { clusters, clustersCleared, itemsCleared };
}

// ═════════════════════════════════════════════════════════════════════════════
// Fix 3：og:image 存量回填（blog-cover-og-backfill，2026-07-06）。
//   分页扫 blog items 中 cover_image 空（含 Fix 2 清空 / 迁移拒绝 '' / 天生无封面）
//   且未打 og 游标的行 → 外呼原文页取 og:image → 过质量门 + 迁 R2 → 写 cover_image。
//   游标字段 `cover_og_backfilled_at` 单调（每条处理后必置位，无论 adopt/skip），
//   与 cover_swept_at / cover_generic_cleared_at 独立防互相干扰。
//   外站拉不到 / 无 og:image / 门控拒 → 只推进游标，保持 monogram 兜底。
//   Fix C：若 og:image 迁出的 R2 key 与被 generic-sweep 清掉的 hash 相同
//   （`cover_generic_cleared_hash`），则跳过写入（否则回填→再清→死循环），仅推进游标。
//   deps 可注入（测试 mock 外呼）；默认走 throttledFetchText + migrateFeedCover。
//   单批默认 limit 15（每条外呼原文页，控制子请求量）。返回 {scanned,adopted,skipped,remaining}。
// ═════════════════════════════════════════════════════════════════════════════

const BACKFILL_OG_PREDICATE = `
  source_type = 'blog'
  AND COALESCE(json_extract(extra, '$.cover_image'), '') = ''
  AND json_extract(extra, '$.cover_og_backfilled_at') IS NULL
  AND COALESCE(url, '') != ''`;

interface BackfillRow {
  id: string;
  url: string | null;
  extra: string | null;
}

export async function runBlogCoverOgBackfill(
  env: Env,
  opts: { limit: number; dry: boolean },
  deps?: {
    fetchHtml?: (url: string) => Promise<string | null>;
    migrateCover?: (env: Env, coverUrl: string) => Promise<string | null>;
  },
): Promise<{ scanned: number; adopted: number; skipped: number; remaining: number }> {
  const fetchHtml = deps?.fetchHtml ?? throttledFetchText;
  const migrateCover = deps?.migrateCover ?? migrateFeedCover;
  const nowIso = new Date().toISOString();

  const batch = await env.DB.prepare(
    `SELECT id, url, extra FROM items WHERE ${BACKFILL_OG_PREDICATE} LIMIT ?`,
  )
    .bind(opts.limit)
    .all<BackfillRow>();

  let scanned = 0;
  let adopted = 0;
  let skipped = 0;

  for (const row of batch.results || []) {
    scanned++;
    let extra: Record<string, unknown> = {};
    try {
      extra = row.extra ? JSON.parse(row.extra) : {};
    } catch {
      extra = {};
    }
    const pageUrl = String(extra.canonical_url || row.url || "").trim();

    // 1. 外呼原文页 → 抽 og:image。
    let ogCover: string | undefined;
    if (pageUrl) {
      try {
        const html = await fetchHtml(pageUrl);
        if (html) ogCover = extractPageMeta(html, pageUrl).cover;
      } catch (e) {
        console.warn(`[feeds-r2:og-backfill] ${row.id} fetch/extract fail`, e);
      }
    }

    // 2. dry：只按 og 命中计数，零写。
    if (opts.dry) {
      if (ogCover) adopted++;
      else skipped++;
      continue;
    }

    // 3. og:image 过质量门 + 迁 R2 → 写 cover_image。
    let r2: string | null = null;
    if (ogCover) {
      try {
        r2 = await migrateCover(env, ogCover);
      } catch (e) {
        console.warn(`[feeds-r2:og-backfill] ${row.id} migrate fail`, e);
        r2 = null;
      }
    }

    // Fix C（2026-07-06）：sweep↔backfill 循环终止。若此 item 曾被 generic-sweep 清簇
    // （`cover_generic_cleared_at` 置位），且本次拟写入的 R2 key 与被清前的 hash 相同
    // （即 og:image 本身就是那张站点通用图 → 回填 → 下轮 sweep 再清 → 无限循环），
    // 则跳过写入、仅推进游标，保持 monogram 兜底、终止循环。不同 hash（真 hero）正常写入。
    const clearedHash = String(extra.cover_generic_cleared_hash || '');
    const r2Key = r2 ? coverR2Key(r2) || r2 : '';
    const isGenericLoop =
      !!r2 && !!extra.cover_generic_cleared_at && !!clearedHash && r2Key === clearedHash;

    if (r2 && !isGenericLoop) {
      await env.DB.prepare(
        `UPDATE items SET extra = json_set(COALESCE(extra,'{}'),
           '$.cover_image', ?, '$.cover_backfilled_at', ?, '$.cover_og_backfilled_at', ?)
         WHERE id = ?`,
      )
        .bind(r2, nowIso, nowIso, row.id)
        .run();
      adopted++;
    } else {
      // 拉不到 / 无 og / 门控拒 / 同 hash 循环命中 → 仅推进游标，保持 monogram 兜底。
      await env.DB.prepare(
        `UPDATE items SET extra = json_set(COALESCE(extra,'{}'), '$.cover_og_backfilled_at', ?) WHERE id = ?`,
      )
        .bind(nowIso, row.id)
        .run();
      skipped++;
    }
  }

  const rem = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM items WHERE ${BACKFILL_OG_PREDICATE}`,
  ).first<{ c: number }>();
  return { scanned, adopted, skipped, remaining: rem?.c ?? 0 };
}
