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
import {
  COVER_BLACKLIST,
  isBlacklistedCover,
  passesCoverSizeGate,
  isNoCoverSource,
  noCoverSourcesSqlExclusion,
} from "./cover-heuristics";
import { isTheVergeAuthorProfileImage } from "./editorial-image";
import { cleanBlogEditorialImages } from "./blog-editorial-image-cleanup";

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

// ICO/CUR 容器识别（magic bytes，Task B，2026-07-09）。头 = 00 00 01 00（reserved=0 + type=1
// ICO；CUR 是 type=2，封面里不会出现，只认 ICO）。ICO 是图标容器，48×48 之类小图靠字节兜底
// 误留为封面（prod 实测 7 条），一律拒。
//   ⚠️ 与 AVIF/HEIF 消歧：AVIF 以 ISOBMFF box 打头（4B box size + 'ftyp'），若某 avif 的 box
//      size 恰为 0x00000100 则前 4 字节也是 00 00 01 00 撞车。真 ICO 的 offset4-5 是「目录项数」
//      （小整数），而 AVIF 那两字节是 'ft'=0x7466≫255 —— 用 count∈[1,255] 把 avif 排除掉。
function isIcoContainer(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 6) return false;
  const v = new DataView(buf);
  if (
    v.getUint8(0) !== 0x00 ||
    v.getUint8(1) !== 0x00 ||
    v.getUint8(2) !== 0x01 ||
    v.getUint8(3) !== 0x00
  ) {
    return false;
  }
  const count = v.getUint16(4, true); // ICONDIRENTRY 数量；真 ICO 很小，排除 AVIF 'ftyp' 误判
  return count >= 1 && count <= 255;
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
  // Task B（2026-07-09）：ICO 容器直接拒，不落字节兜底。favicon.ico（48×48，>8KB）过去
  // 靠「>8KB 即通过」误留为封面。放在 probe 前：ICO 尺寸不可靠（0=256、多尺寸目录），
  // 按格式一刀切拒最稳，且不动 webp/avif（仍走下方字节兜底，避免误杀现代博客封面）。
  if (isIcoContainer(buf)) return false;
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

// 采用环节封面尺寸探针（关键词命中后的强信号复核，Fix 2026-07-09）。
// 只在 og cover 命中 COVER_BLACKLIST 时调用（罕见路径）——拉图读 magic bytes 出真实像素，
// 供 isBlacklistedCover 判「真头图（大图放行）vs 品牌 logo（小图/测不出维持拒绝）」。
// 拉不到 / 超大 / 非 png/jpeg/gif（webp/avif/ico probeImageDimensions 读不出）→ undefined（判为测不出）。
// _env 保留以对齐 migrateCover 的注入 seam 形状（本实现不需要 env）。
export async function probeRemoteCoverSize(
  _env: Env,
  url: string,
): Promise<{ width: number; height: number } | undefined> {
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": FEED_R2_USER_AGENT, Accept: "*/*" },
    });
    if (!r.ok) return undefined;
    const buf = await r.arrayBuffer();
    if (buf.byteLength > IMG_MAX_BYTES) return undefined; // 兜底防拉超大文件
    return probeImageDimensions(buf);
  } catch (e) {
    console.warn(`[feeds-r2:blog] probeRemoteCoverSize 失败 ${url}:`, e);
    return undefined;
  }
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
  deps?: {
    /** 封面迁移 seam（测试注入；默认走 migrateFeedCover）。 */
    migrateCover?: (env: Env, coverUrl: string) => Promise<string | null>;
    /** 关键词命中后的尺寸探针 seam（测试注入；默认走 probeRemoteCoverSize 拉图读 magic bytes）。 */
    probeCoverSize?: (
      env: Env,
      coverUrl: string,
    ) => Promise<{ width: number; height: number } | undefined>;
  },
): Promise<{ migrated: number; marker: "blog_media_r2_at" }> {
  const marker = "blog_media_r2_at" as const;
  const migrateCover = deps?.migrateCover ?? migrateFeedCover;
  const probeCoverSize = deps?.probeCoverSize ?? probeRemoteCoverSize;
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
  // 部署切换瞬间可能已有「已抓正文、尚未跑 step4」的旧格式 item。迁 R2 前再做一次同源
  // 强规则清理，避免头像先被内容寻址成 /r/hash、随后又被 body hero 回退选成封面。
  const editorialCleanup = cleanBlogEditorialImages(extra);
  const bodyForMigration = editorialCleanup.patch.body || extra.body;

  const nowIso = new Date().toISOString();
  const mapping = new Map<string, string>(); // 原始 URL → /r/key
  let migrated = 0;

  // src 派生（feed_key，退化到 show_key / 'blog'）—— 采用护栏 + no-cover 名单共用同一口径。
  const srcKey = String(
    extra.feed_key || (extra as { show_key?: string }).show_key || "blog",
  );
  // 源级 no-cover 名单（Fix B，2026-07-07）：名单内源一律不采用任何封面（og 不采、正文 hero
  // 不回退、cover_image 恒空走 monogram）。jiqizhixin 正文零图 + og 恒为品牌 logo → 写死 no-cover。
  const noCoverSrc = isNoCoverSource(srcKey);

  // ── 1. 封面（过质量门控；不合格/防盗链失败 → cover 落 null，不保留外链）──
  //   封面品牌 logo 三层防御（自最早到最晚）：
  //     层 0 关键词（Fix A，2026-07-07）：对**原始 og URL**（迁移前，关键词信息还在）跑
  //          COVER_BLACKLIST，命中即不迁 R2、不采用——在第 1 篇就拦住带关键词命名的品牌 logo
  //          （qbitai og 文件名字面含 'logo'），闭合统计护栏「新源前 2 篇成簇前泄漏」窗口。
  //     层 1/2 统计簇 + 持久 hash：见下方 isSourceLevelBrandLogo（迁移后按 R2 内容 hash 比对）。
  //   关键词先拦 → 命中时统计护栏无需再触发（迁都不迁，自然到不了层 1/2）。
  let newCover: string | undefined;
  let coverRejected = false;
  let coverKeywordBlocked = false;
  let coverEditorialBlocked = false;
  const cover = (extra.cover_image || "").trim();
  if (noCoverSrc) {
    // Fix B：源级 no-cover，跳过全部封面采用（护栏 / 正文回落一并跳过；落库统一清空）。
  } else if (cover && isTheVergeAuthorProfileImage(cover)) {
    // The Verge 会把 BLURPLE / chorus author_profile 署名头像暴露为正文或 RSS/OG 图。
    // 必须在迁 R2 前拦截；一旦内容寻址为 /r/hash，URL 语义永久丢失。
    coverEditorialBlocked = true;
  } else if (cover && !isAlreadyMigrated(cover)) {
    let coverBlocked = false;
    if (COVER_BLACKLIST.test(cover)) {
      // 层 0 关键词命中——弱信号（文件名判据无法区分「品牌 logo 本身」与「文件名恰好含 logo/icon
      //   的真头图」，如 nvidia `...-no-copy-logo.jpg` 2048×1024、techcrunch `...Claude-logo-...`）。
      //   改为尺寸复核（强信号，Fix 2026-07-09）：真品牌 logo 实测 maxDim ≤ 828（qbitai 300 / mit 32），
      //   真 og 头图 ≥ 1200（nvidia 2048 / techcrunch press hero 1200）。采用环节 probe 原始 og 像素：
      //     · 够大 → 判真头图，放行走正常迁移采用（下方 !coverBlocked 分支）；
      //     · 小图 / 测不出（webp/avif/防盗链失败）→ 维持拒绝，改走正文 hero / monogram。
      //   放行的大图仍会落到下方 isSourceLevelBrandLogo 统计簇护栏（层 1/2）——真品牌大图靠成簇兜住。
      const dim = await probeCoverSize(env, cover);
      if (isBlacklistedCover(cover, dim?.width, dim?.height)) {
        coverBlocked = true;
        coverKeywordBlocked = true;
        console.log(
          `[feeds-r2:blog] ${itemId}: og cover 关键词黑名单命中（尺寸复核未过 ${
            dim ? `${dim.width}x${dim.height}` : "unprobeable"
          }），不采用不迁移: ${cover}`,
        );
      }
      // else：尺寸 override（明显是大图头图）→ 落到下方分支，当作干净 og 正常迁移采用。
    }
    if (!coverBlocked) {
      const r2 = await migrateCover(env, cover);
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
  }

  // ── 2. 正文 inline 资产（图过质量门控；直链视频仅过 size cap）──
  //   ⚠️ 顺序（Fix 1，2026-07-06）：正文 assets 迁 R2 必须排在下方「采用护栏」**之前**——
  //   护栏命中要就地从已迁 R2 的 body.assets 选正文 hero 回落，故先拿到各 asset 的 r2_url。
  const assets: FeedBodyAsset[] = bodyForMigration?.assets ? [...bodyForMigration.assets] : [];
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

  // ── 2b. 采用护栏（层 1，Task 2；Fix 1 重排到 body.assets 迁移之后，2026-07-06）──
  //   og:image 迁 R2 后拿到内容寻址 R2 key，此刻比对同 source 是否为「源级品牌 logo」
  //   （① 已有 ≥3 条 item 用它作 cover，或 ② 该 hash 曾被同源清过——见 isSourceLevelBrandLogo）。
  //   命中即撤销本条 og 采用；**但不直接落 monogram**：先就地调用与 bodyhero-backfill 同一套
  //   `pickBodyHeroCover`，从**已迁 R2** 的 body.assets 里选合格 hero（过黑名单 + 尺寸门 + 排除
  //   logo 本身）——有则 live 当场用它作 cover（qbitai 类正文有真配图，不必等手动 backfill），
  //   无则清空走 monogram（jiqizhixin 类图荒）。两种都记 cover_generic_cleared_hash，供 og-backfill
  //   Fix C 拦截同图回填 + 持久拒绝集合（Fix 2）。Verge 每篇 og 不同且从未清过 → 恒不命中，不受影响。
  //   R2 对象内容寻址（同 hash 复用），不删除（其他 ≥3 条仍引用）；仅撤销本条引用。
  let brandLogoGuarded = false;
  let guardedHash = "";
  let bodyHeroCover: string | undefined; // 护栏/关键词命中后就地回落的正文 hero（无则 undefined → monogram）
  if (noCoverSrc) {
    // Fix B：源级 no-cover，不采用 og、不回落正文 hero（bodyHeroCover 保持 undefined）。
  } else if (newCover) {
    if (await isSourceLevelBrandLogo(env, itemId, srcKey, newCover)) {
      brandLogoGuarded = true;
      guardedHash = coverR2Key(newCover) || newCover;
      // 与 runBlogCoverBodyHeroBackfill 共用 pickBodyHeroCover（喂已迁 R2 的 body.assets）。
      bodyHeroCover =
        pickBodyHeroCover({ body: { assets: newAssets } }, guardedHash) ||
        undefined;
    }
  } else if (coverKeywordBlocked || coverEditorialBlocked) {
    // 层 0 关键词命中：og 已不采，比照统计护栏就地从已迁 R2 的正文 assets 回落合格 hero
    // （qbitai 正文有真配图 → 采用；jiqizhixin 类图荒 → 空走 monogram）。无 clearedHash：
    // pickBodyHeroCover 内部黑名单已排除 logo/qrcode 类 asset，不需额外 hash 排除。
    bodyHeroCover =
      pickBodyHeroCover({ body: { assets: newAssets } }) || undefined;
  }

  // ── 3. publisher logo ──
  const publisher: FeedPublisher | undefined = extra.publisher
    ? { ...extra.publisher }
    : undefined;
  const logoChanged = await migratePublisherLogo(env, publisher, R2_PREFIX_BLOG);
  if (logoChanged) migrated++;

  // ── 4. 正文 markdown 内嵌 URL 改写 ──
  const oldMd = extra.body_markdown || "";
  const cleanMd = editorialCleanup.patch.body_markdown ?? oldMd;
  const newMd = mapping.size ? rewriteMarkdownUrls(cleanMd, mapping) : cleanMd;

  // ── 5. 落库（json_set 只改自己字段，防擦并行 enrich）──
  const patches: ExtraPatch[] = [{ path: "$.blog_media_r2_at", value: nowIso }];
  if (noCoverSrc) {
    // Fix B：源级 no-cover，cover 恒空。仅当原 cover_image 有值（og 外链 / 旧值）才需清空。
    if (cover) {
      patches.push({ path: "$.cover_image", value: "" });
      patches.push({ path: "$.cover_nocover_source_at", value: nowIso });
    }
  } else if (newCover && !brandLogoGuarded) {
    patches.push({ path: "$.cover_image", value: newCover });
    patches.push({ path: "$.cover_backfilled_at", value: nowIso });
  } else if (brandLogoGuarded) {
    // 统计护栏命中（层 1/2）：撤销 og(logo) 采用。就地从正文 assets 选到合格 hero → live 当场落它作
    // cover（无需等手动 backfill）；无合格 hero → cover 落空走 monogram。两者都记被判 R2 key，供
    // og-backfill Fix C 拦截同图再灌 + 持久拒绝集合（Fix 2）复用。
    if (bodyHeroCover) {
      patches.push({ path: "$.cover_image", value: bodyHeroCover });
      patches.push({ path: "$.cover_backfilled_at", value: nowIso });
      patches.push({ path: "$.cover_bodyhero_backfilled_at", value: nowIso });
    } else {
      patches.push({ path: "$.cover_image", value: "" });
    }
    patches.push({ path: "$.cover_generic_cleared_hash", value: guardedHash });
    patches.push({ path: "$.cover_brandlogo_guarded_at", value: nowIso });
  } else if (coverKeywordBlocked || coverEditorialBlocked) {
    // 层 0 关键词命中：og 不采（也未迁 R2，无 R2 hash 可记）。就地正文 hero → 采用；
    // 否则空走 monogram。记 cover_keyword_blacklisted_at marker 供观测。
    if (bodyHeroCover) {
      patches.push({ path: "$.cover_image", value: bodyHeroCover });
      patches.push({ path: "$.cover_backfilled_at", value: nowIso });
      patches.push({ path: "$.cover_bodyhero_backfilled_at", value: nowIso });
    } else {
      patches.push({ path: "$.cover_image", value: "" });
    }
    patches.push({
      path: coverEditorialBlocked
        ? "$.editorial_image_cover_blocked_at"
        : "$.cover_keyword_blacklisted_at",
      value: nowIso,
    });
  } else if (coverRejected) {
    // 空串 = 渲染层 falsy 处理（等价无封面）；不保留外链，避免日报/卡片挂图。
    patches.push({ path: "$.cover_image", value: "" });
    patches.push({ path: "$.cover_rejected_at", value: nowIso });
  }
  if (bodyForMigration && (assets.length || editorialCleanup.patch.body)) {
    const newBody = { ...bodyForMigration, assets: newAssets };
    patches.push({ path: "$.body", value: JSON.stringify(newBody), json: true });
  }
  if (newMd !== oldMd) {
    patches.push({ path: "$.body_markdown", value: newMd });
  }
  if (editorialCleanup.patch.body_markdown_zh !== undefined) {
    patches.push({
      path: "$.body_markdown_zh",
      value: editorialCleanup.patch.body_markdown_zh,
    });
  }
  if (editorialCleanup.patch.editorial_image_blocked_urls !== undefined) {
    patches.push({
      path: "$.editorial_image_blocked_urls",
      value: JSON.stringify(editorialCleanup.patch.editorial_image_blocked_urls),
      json: true,
    });
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
// Fix 2a：源级通用图剔除（blog-cover-generic-sweep，2026-07-06；Task A 放宽外链形态 2026-07-09）。
//   统计特征法：同一 blog source（feed_key）内 cover_image 命中**同一封面**
//   ≥ minCount 篇**不同文章** → 判为「源级通用图」（作者头像 / 站点通栏 / 二维码横幅 /
//   站点 favicon 都逃不过）。整簇 cover_image 清空（json_remove），并**清掉
//   cover_og_backfilled_at 游标**，使随后 Fix 3 blog-cover-og-backfill 能重新拉
//   og:image 回填真 hero。dry=1 只列簇明细（src / cover / count）供人工核对，不落盘。
//   src 派生 = COALESCE(feed_key, show_key, source_type)，与两条 SQL 保持一致。
//
//   ⚠️ Task A（2026-07-09）：判簇谓词由「只扫 R2 形态 cover」放宽到**外链形态一并计入**。
//      旧版仅统计 `/r/<hash>` 形态（内容寻址天然同图同 key），遗漏 prod 存量里的外链通用
//      封面（techcrunch favicon ×27、the-verge RSS 头像 ×13 等）——它们无 R2 内容 hash、只有
//      URL，逃过判簇，前端 BlogCard/抽屉直读 cover_image 就显示这些 favicon/头像。放宽后
//      按**归一封面串完全相同**（GROUP BY cover）判簇，外链清后自动进 og-backfill 候选。
//   ⚠️ 防误伤（Task A 关键）：判簇口径由 `COUNT(*)`（数行）改为
//      `COUNT(DISTINCT 文章标识)`，文章标识 = COALESCE(canonical_url, url, id)。这样
//      「同一篇文章被多次抓取导致 URL 重复」（同 canonical_url 多行）只计 1 次，不会被
//      当成「一个站所有文章共用一张 favicon」而误清；只有**跨 ≥minCount 篇不同文章**
//      共用同一封面才判簇。对 R2 形态无行为变化（item id 天然唯一，distinct 计数 == 行数）。
//
//   ⚠️ 只扫 source_type='blog'（审查修复，2026-07-06）：播客单集共用节目封面是
//      合法常态（一档节目所有 episode 天然同一张节目图），且 og-backfill 只回填 blog，
//      清了 podcast 簇没有回填方 → 永久掉封面。故收敛到 blog-only。
//   ⚠️ 清簇时把被清封面记到 `$.cover_generic_cleared_hash`（Fix C，2026-07-06）：
//      R2 形态记归一 key（strip /r/），外链形态无 /r/ → 退化记原 URL。供 og-backfill 判定
//      「回填的 og:image 又是同一张通用图」→ 跳过写入终止 sweep↔backfill 无限循环
//      （外链簇清后 og-backfill 会外呼原文页取真 og:image，多数与被清 favicon 不同 → 正常回填）。
// ═════════════════════════════════════════════════════════════════════════════

// src 派生表达式（聚合 GROUP BY 与逐簇 UPDATE 复用同一字面量，保证匹配一致）。
const GENERIC_SRC_EXPR =
  "COALESCE(json_extract(extra,'$.feed_key'), json_extract(extra,'$.show_key'), source_type)";

// 采用护栏阈值：同 source 已有 ≥ 此数条 item 用同一 R2 图作 cover → 判源级品牌 logo。
// 与 generic-sweep 默认 minCount 一致（3）。
export const BRAND_LOGO_MIN_COUNT = 3;

// 采用护栏（层 1，Task 2）：判断某张 og→R2 封面是否属于「源级品牌 logo」，两条判据取或：
//   ① live 计数：同 source 已有 ≥ minCount 条**其他** item 正用它作 cover（稳态簇成形后拦）；
//   ② 持久拒绝（Fix 2，2026-07-06）：同 source **曾被清过**这张 logo（`cover_generic_cleared_hash`
//      记录了它的归一 key）——某源的 logo 一旦被清簇/护栏清过一次，之后任何一篇立即被拒，
//      不再有「清簇归零 COUNT → 前 ≤2 篇又把 logo 当 cover、到第 3 篇才自愈」的再泄漏窗口。
// coverUrl 为 migrateAsset 产出的 `/r/blog/<hash>.<ext>`；归一化用 coverR2Key（与四处一致），
//   ① 的 LIKE `%/r/<key>` 兼容相对（`/r/...`）与绝对（`<apiBase>/r/...`）两种存库形态，
//   ② 的 cover_generic_cleared_hash 本就以归一 key 形态落库（generic-sweep / 护栏两侧都写 coverR2Key）。
// 一次聚合查询（SUM/CASE）同时取两计数，src 口径与 GENERIC_SRC_EXPR 一致，避免二次全表扫。
export async function isSourceLevelBrandLogo(
  env: Env,
  itemId: string,
  srcVal: string,
  coverUrl: string,
  minCount: number = BRAND_LOGO_MIN_COUNT,
): Promise<boolean> {
  const r2Key = coverR2Key(coverUrl) || coverUrl;
  const row = await env.DB.prepare(
    `SELECT
        SUM(CASE WHEN json_extract(extra,'$.cover_image') LIKE ? THEN 1 ELSE 0 END) AS n,
        SUM(CASE WHEN json_extract(extra,'$.cover_generic_cleared_hash') = ? THEN 1 ELSE 0 END) AS cleared
       FROM items
      WHERE source_type = 'blog'
        AND id != ?
        AND ${GENERIC_SRC_EXPR} = ?`,
  )
    .bind(`%/r/${r2Key}`, r2Key, itemId, srcVal)
    .first<{ n: number | null; cleared: number | null }>();
  const liveCount = row?.n ?? 0;
  const clearedHits = row?.cleared ?? 0;
  return liveCount >= minCount || clearedHits >= 1;
}

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
  // Task A（2026-07-09）：判簇覆盖 R2 + 外链两种 cover 形态（去掉 R2-only 过滤）；
  // 计数按文章标识去重（canonical_url→url→id），防同文章重复抓取被误当成源级通用图。
  const agg = await env.DB.prepare(
    `SELECT ${GENERIC_SRC_EXPR} AS src,
            json_extract(extra,'$.cover_image') AS cover,
            COUNT(DISTINCT COALESCE(
              NULLIF(json_extract(extra,'$.canonical_url'), ''),
              NULLIF(url, ''),
              id
            )) AS n
       FROM items
      WHERE source_type = 'blog'
        AND COALESCE(json_extract(extra,'$.cover_image'),'') != ''
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
  AND COALESCE(url, '') != ''
  ${noCoverSourcesSqlExclusion(GENERIC_SRC_EXPR)}`;

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

    // Fix C（2026-07-06）：sweep/live 护栏 ↔ backfill 循环终止。若此 item 曾被判为
    // 站点通用图/logo 清掉（`cover_generic_cleared_hash` 置位），且本次拟写入的 R2 key
    // 与被清前的 hash 相同（即 og:image 本身就是那张图 → 回填 → 下轮再清 → 无限循环），
    // 则跳过写入、仅推进游标，保持 monogram 兜底、终止循环。不同 hash（真 hero）正常写入。
    // 终审 I1（2026-07-06）：判据只认 clearedHash，去掉 `cover_generic_cleared_at` 门 ——
    // generic-sweep 仍同时写 hash+at（无回归），但 live 采用护栏只写 hash 不写 at，
    // 留着 at 门会漏判 live 侧路把 logo 灌回。clearedHash 本身即「曾被判 logo 清掉」的充分标记。
    const clearedHash = String(extra.cover_generic_cleared_hash || '');
    const r2Key = r2 ? coverR2Key(r2) || r2 : '';
    const isGenericLoop = !!r2 && !!clearedHash && r2Key === clearedHash;

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

// ═════════════════════════════════════════════════════════════════════════════
// Task 2 层 2：正文 hero 存量差异回填（blog-cover-bodyhero-backfill，2026-07-06）。
//   针对被 generic-sweep / 采用护栏清簇（cover_generic_cleared_hash 置位）后 cover 落空的
//   blog item：og:image == 被清 logo（Fix C 已挡 og-backfill 再灌），改从**正文 body.assets**
//   选合格 hero 补 cover_image。天然按源分流：
//     - qbitai 正文有真配图（body.assets 非空）→ 选到 hero → 采用；
//     - jiqizhixin 图荒（body.assets=0）→ 选不到 → 保持空走 monogram，推游标不硬塞。
//   游标 `cover_bodyhero_backfilled_at` 单调（处理必置位，无论 adopt/skip）；dry=1 零写。
// ═════════════════════════════════════════════════════════════════════════════

// 黑名单 + 尺寸门统一到 feeds/cover-heuristics.ts（COVER_BLACKLIST / passesCoverSizeGate），
// 与 digest/render.ts pickNewsCoverGated 共用同一口径，消除复制漂移（Minor，2026-07-06）。

// 从 body.assets 选第一张合格正文 hero：已迁 R2 + 过黑名单 + 过尺寸门（maxDim≥240 且 0.5≤ar≤2）。
// 只用已迁 R2 的 asset（外链态不当封面，与渲染层一致）；排除与被清 logo 同 hash 的资产。
// 无合格图返回 null（图荒 → 保持 monogram）。
export function pickBodyHeroCover(
  extra: Record<string, unknown>,
  clearedHash?: string,
): string | null {
  const body = extra.body as { assets?: unknown } | undefined;
  const assets = body && Array.isArray(body.assets) ? body.assets : [];
  for (const asset of assets) {
    if (!asset || typeof asset !== "object") continue;
    const a = asset as {
      url?: unknown;
      r2_url?: unknown;
      kind?: unknown;
      width?: unknown;
      height?: unknown;
    };
    if (a.kind && a.kind !== "image") continue; // 跳视频/非图
    const r2 = typeof a.r2_url === "string" ? a.r2_url : "";
    if (!r2 || !isR2CoverUrl(r2)) continue; // 只用已迁 R2 的 asset
    const orig = typeof a.url === "string" ? a.url : "";
    if (COVER_BLACKLIST.test(orig) || COVER_BLACKLIST.test(r2)) continue;
    if (clearedHash && (coverR2Key(r2) || r2) === clearedHash) continue; // 排除被清 logo 本身
    const w = typeof a.width === "number" ? a.width : undefined;
    const h = typeof a.height === "number" ? a.height : undefined;
    // 与渲染层 pickNewsCoverGated / 前端卡片缩略图 qualityGate 同参（共享 passesCoverSizeGate）。
    if (!passesCoverSizeGate(w, h)) continue;
    return r2;
  }
  return null;
}

const BACKFILL_BODYHERO_PREDICATE = `
  source_type = 'blog'
  AND COALESCE(json_extract(extra, '$.cover_image'), '') = ''
  AND json_extract(extra, '$.cover_generic_cleared_hash') IS NOT NULL
  AND json_extract(extra, '$.cover_bodyhero_backfilled_at') IS NULL
  ${noCoverSourcesSqlExclusion(GENERIC_SRC_EXPR)}`;

interface BodyHeroRow {
  id: string;
  extra: string | null;
}

export async function runBlogCoverBodyHeroBackfill(
  env: Env,
  opts: { limit: number; dry: boolean },
): Promise<{ scanned: number; adopted: number; skipped: number; remaining: number }> {
  const nowIso = new Date().toISOString();
  const batch = await env.DB.prepare(
    `SELECT id, extra FROM items WHERE ${BACKFILL_BODYHERO_PREDICATE} LIMIT ?`,
  )
    .bind(opts.limit)
    .all<BodyHeroRow>();

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
    const clearedHash = String(extra.cover_generic_cleared_hash || "");
    const hero = pickBodyHeroCover(extra, clearedHash); // 已迁 R2 的 /r/ 路径 或 null

    if (opts.dry) {
      if (hero) adopted++;
      else skipped++;
      continue;
    }

    if (hero) {
      await env.DB.prepare(
        `UPDATE items SET extra = json_set(COALESCE(extra,'{}'),
           '$.cover_image', ?, '$.cover_backfilled_at', ?, '$.cover_bodyhero_backfilled_at', ?)
         WHERE id = ?`,
      )
        .bind(hero, nowIso, nowIso, row.id)
        .run();
      adopted++;
    } else {
      // 图荒 → 仅推进游标，保持 monogram 兜底（不硬塞低质图）。
      await env.DB.prepare(
        `UPDATE items SET extra = json_set(COALESCE(extra,'{}'), '$.cover_bodyhero_backfilled_at', ?) WHERE id = ?`,
      )
        .bind(nowIso, row.id)
        .run();
      skipped++;
    }
  }

  const rem = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM items WHERE ${BACKFILL_BODYHERO_PREDICATE}`,
  ).first<{ c: number }>();
  return { scanned, adopted, skipped, remaining: rem?.c ?? 0 };
}
