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
