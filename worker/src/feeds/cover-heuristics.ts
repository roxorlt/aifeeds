// worker/src/feeds/cover-heuristics.ts
//
// 封面选图共享启发式（叶子模块，无依赖，避免 digest ↔ feeds 循环）。
//
// 三处历史各自复制的口径统一到此处，消除复制漂移风险（Minor，2026-07-06）：
//   - digest/render.ts pickNewsCoverGated（日报静态页封面质量门）
//   - feeds/media-r2.ts pickBodyHeroCover（正文 hero 回落 / bodyhero-backfill）
// 前端卡片缩略图 qualityGate 亦同参（TS/JS 分居两端，值保持一致即可）。

// 封面垃圾 URL 黑名单（不区分大小写）：二维码 / logo / 头像 / 图标 / 徽章 / 页脚 banner。
//
// 路径段/词边界锚定（Fix 1，2026-07-07）：关键词两侧都不得紧贴字母，即只在被非字母字符
// （`/ _ - . @ ?`… 及数字，或串首尾）分隔时命中。消除无边界子串误伤：
//   - `icon` 不再误命中 `silicon-valley-ai.jpg`（silICON，前邻 'l'）/ `iconic-design.png`（ICONic，后邻 'i'）
//   - `logo` 不再误命中 `catalogo-cover.png`（catalOGO，前邻 'a'）
// 用「非字母」而非狭义 `[/_\-.]` 作分隔判据：数字/`@`/`?` 等都算词界，故 `brand_logo@2x.png`
//   （后邻 '@'）、`logo2x.png`（后邻数字）仍被拦。
// `favicon` 单列为独立关键词：其含 `icon` 子串但前邻 'v' 是字母，边界化后 `icon` 关键词管不住
//   → 加 `favicon` 保证 `favicon.ico` 仍拦。lookbehind/lookahead 不消费字符，相邻关键词不互相遮挡。
const COVER_BLACKLIST_WORDS = [
  'qrcode',
  'qr_code',
  'qr-code',
  'erweima',
  '二维码',
  'logo',
  'avatar',
  'favicon',
  'icon',
  'badge',
  'banner_footer',
  'footer',
];
export const COVER_BLACKLIST = new RegExp(
  `(?<![a-z])(?:${COVER_BLACKLIST_WORDS.join('|')})s?(?![a-z])`,
  'i',
);

// ─────────────────────────────────────────────────────────────────────────────
// 关键词 = 弱信号，尺寸 = 强信号（Fix，2026-07-09）。
//
// COVER_BLACKLIST 是词边界锚定的**文件名**判据，无法区分「品牌 logo 本身」与「文件名里
// 恰好含关键词的真头图」：
//   - nvidia GFN Thursday 头图 `...-2048x1024-no-copy-logo.jpg`（no-copy-logo = 不带文案和
//     logo 的版本）—— 'logo' 前邻 '-'、后邻 '.' 命中词边界，被旧纯关键词逻辑误拒（本次 bug）；
//   - techcrunch 产品 press hero `...Claude-logo-1920x1080-1.png`（logo 是画面主体但仍是真头图）
//     同样误命中。
// 尺寸是可靠得多的判据：2026-07-09 prod 取样实测——
//   真品牌 logo maxDim ≤ 828（qbitai 300×300 / jiqizhixin 828×828 / mit-tech-review 32px）；
//   真 og 头图 maxDim ≥ 1200（nvidia 2048×1024 / techcrunch press hero 1200×675）。
// 阈值取 1000，落在 (828, 1200) 安全间隙：拦住已知最大品牌 logo，放行真头图。
//   注：jiqizhixin（828）已单列 NO_COVER_SOURCES 硬拦，不靠本阈值；本阈值面向仍靠关键词层的源
//   （qbitai 等）。若未来某源用 ≥1000px 大图 logo 作 og，前 1-2 篇成簇前可能漏放，随后由采用护栏
//   统计簇（isSourceLevelBrandLogo，第二道防线）在第 3 篇兜住——这是刻意的取舍。
export const COVER_KEYWORD_OVERRIDE_MIN_DIM = 1000;

/**
 * 封面 URL 是否应按垃圾关键词拒绝（弱信号关键词 + 强信号尺寸联合判据）。
 *   - 不含黑名单关键词 → 不拒（返回 false，尺寸不参与）。
 *   - 含关键词 + 尺寸可测且 maxDim ≥ COVER_KEYWORD_OVERRIDE_MIN_DIM → 判真头图，放行（false）。
 *   - 含关键词 + 小图 / 尺寸测不出（width|height 缺失或为 0）→ 拒（true，回退纯关键词判据）。
 *
 * 「尺寸 override」的前提是采用环节能 probe 出真实像素（magic bytes：png/jpeg/gif）。
 * webp/avif/ico 或防盗链失败 → 测不出 → 维持拒绝，不放行——宁可漏放个别真头图，也绝不放进品牌
 * logo（安全优先于召回）。
 */
export function isBlacklistedCover(
  url: string,
  width?: number,
  height?: number,
): boolean {
  if (!COVER_BLACKLIST.test(url)) return false;
  const maxDim = width && height ? Math.max(width, height) : 0;
  return maxDim < COVER_KEYWORD_OVERRIDE_MIN_DIM;
}

// 封面尺寸门：maxDim ≥ 240 且 0.5 ≤ 宽高比 ≤ 2。
// 缺尺寸元数据（webp/avif/svg 无法 probe，或 asset 无 width/height）→ 放行（返回 true），
// 与两处调用点原有「有尺寸才过门」的行为一致。
export function passesCoverSizeGate(width?: number, height?: number): boolean {
  if (!width || !height) return true;
  const maxDim = Math.max(width, height);
  const ar = width / height;
  return maxDim >= 240 && ar >= 0.5 && ar <= 2;
}

// ─────────────────────────────────────────────────────────────────────────────
// 源级「不采用任何封面」名单（Fix B，2026-07-07；feed_key 口径）。
//
// 名单内源的 blog item **一律不设 cover**：og 不采、正文 hero 不回退、cover_image 恒空
// → 前端 / 日报走 monogram（品牌字母）兜底。
//
// 生效点分两层：
//   ▸ 数据层（三点，写库即清空，名单外源不受影响）：
//     ① migrateMediaForBlog 采用路径入口直接跳过（og / 正文 hero 一并不采、cover_image 落空）；
//     ② og-backfill 谓词排除（noCoverSourcesSqlExclusion，防清空后又被拉回）；
//     ③ bodyhero-backfill 谓词排除（同上）。
//   ▸ 渲染层纵深（Fix 2，2026-07-07，四处按调用路径计）：pickNewsCoverGated 入口对 no-cover 源
//     直接返回 null 短路（daily gated 路径专用；旧数据残留 cover_image / 正文图也不出封面）。
//     这层是硬约束，使名单在任何数据形态下都成立——名单扩容因此安全（新增源无需回填清库即刻生效）。
//
// jiqizhixin（机器之心）：官网直连全文 154 篇正文零内嵌图、og:image 恒为站点品牌 logo
//   （828×828 方图，尺寸门放行、迁 R2 后内容 hash 命名使关键词信息丢失，下游全部失守），
//   用户 2026-07-07 拍板写死 no-cover。未来若该源开始在正文出图，从名单移除即可恢复取图。
// qbitai（量子位）**不进**此名单：正文有真 hero（12/116），其 og 文件名字面含 'logo'
//   → 靠 COVER_BLACKLIST 关键词层在采用前拦住品牌 logo，正文真 hero 正常回落，不误杀。
export const NO_COVER_SOURCES = new Set<string>(["jiqizhixin"]);

/** src（feed_key，或 show_key / source_type 派生）是否属于源级 no-cover 名单。 */
export function isNoCoverSource(srcKey: string | null | undefined): boolean {
  return !!srcKey && NO_COVER_SOURCES.has(srcKey);
}

/**
 * 生成「排除 no-cover 源」的 SQL 片段（`AND <srcExpr> NOT IN (...)`），拼进 backfill 谓词，
 * 让 no-cover 源的 item 永不进任何封面回填批（否则 Fix B 清空后又被 og/bodyhero-backfill 灌回）。
 * srcExpr 传调用点的 src 派生表达式（如 GENERIC_SRC_EXPR）。名单为空返回空串。
 * 名单值均为受控字面量标识符（[a-z0-9-]），无注入风险。
 */
export function noCoverSourcesSqlExclusion(srcExpr: string): string {
  if (NO_COVER_SOURCES.size === 0) return "";
  const list = [...NO_COVER_SOURCES].map((s) => `'${s}'`).join(", ");
  return `AND ${srcExpr} NOT IN (${list})`;
}
