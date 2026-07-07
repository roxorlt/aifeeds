// worker/src/feeds/cover-heuristics.ts
//
// 封面选图共享启发式（叶子模块，无依赖，避免 digest ↔ feeds 循环）。
//
// 三处历史各自复制的口径统一到此处，消除复制漂移风险（Minor，2026-07-06）：
//   - digest/render.ts pickNewsCoverGated（日报静态页封面质量门）
//   - feeds/media-r2.ts pickBodyHeroCover（正文 hero 回落 / bodyhero-backfill）
// 前端卡片缩略图 qualityGate 亦同参（TS/JS 分居两端，值保持一致即可）。

// 封面垃圾 URL 黑名单（不区分大小写）：二维码 / logo / 头像 / 图标 / 徽章 / 页脚 banner。
export const COVER_BLACKLIST =
  /qrcode|qr_code|qr-code|erweima|二维码|logo|avatar|icon|badge|banner_footer|footer/i;

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
// → 前端 / 日报走 monogram（品牌字母）兜底。生效点：migrateMediaForBlog 采用路径入口直接跳过、
// og-backfill / bodyhero-backfill 谓词排除该源（noCoverSourcesSqlExclusion）。
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
