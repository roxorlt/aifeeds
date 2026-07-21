// Resolve relative asset paths to absolute URLs.
//
// 两种 relative path:
//   1. `/r/...` — Worker R2 反代路径(GH README assets / PH logo / X media /
//      HF figure / HF submitted_by 头像 R2 迁后)。
//      site origin 的同源实验只代理 /api/，不代理 /r/；所有环境都必须拼
//      PUBLIC_WORKER_BASE，避免落到 Pages/nginx SPA fallback。
//   2. `/avatars/<hash>.svg` — HF identicon 兜底路径(HF 用户无上传头像时返回)。
//      BE 没 R2 迁这种 identicon(数量大),FE 直接拼 https://huggingface.co 前缀
//      让浏览器去 HF CDN 取。中国大陆访问 HF CDN 慢但通常可达。

import { PUBLIC_WORKER_BASE } from "./apiBase.ts";

export function resolveAssetUrl(url: string | null | undefined): string {
  if (!url) return "";
  if (url.startsWith("/r/")) {
    return `${PUBLIC_WORKER_BASE}${url}`;
  }
  if (url.startsWith("/avatars/")) {
    // HF identicon — BE 未 R2 迁(数量大),拼 HF host 直拉(CN 慢但可达)
    return `https://huggingface.co${url}`;
  }
  return url;
}
