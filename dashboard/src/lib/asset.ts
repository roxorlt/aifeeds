// Resolve relative asset paths to absolute URLs.
//
// 两种 relative path:
//   1. `/r/...` — Worker R2 反代路径(GH README assets / PH logo / X media /
//      HF figure / HF submitted_by 头像 R2 迁后)。
//      prod ai-feeds.com 有 worker route 直接命中;preview Pages 域名 + localhost dev
//      没 worker route → 走 SPA fallback,需要拼 API_BASE → staging-api 命中。
//   2. `/avatars/<hash>.svg` — HF identicon 兜底路径(HF 用户无上传头像时返回)。
//      BE 没 R2 迁这种 identicon(数量大),FE 直接拼 https://huggingface.co 前缀
//      让浏览器去 HF CDN 取。中国大陆访问 HF CDN 慢但通常可达。

import { API_BASE } from "../api";

export function resolveAssetUrl(url: string | null | undefined): string {
  if (!url) return "";
  if (url.startsWith("/r/")) {
    // API_BASE is "" on localhost (vite proxy), absolute origin elsewhere
    const base = API_BASE || "";
    return `${base}${url}`;
  }
  if (url.startsWith("/avatars/")) {
    // HF identicon — BE 未 R2 迁(数量大),拼 HF host 直拉(CN 慢但可达)
    return `https://huggingface.co${url}`;
  }
  return url;
}
