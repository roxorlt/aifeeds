// Resolve `/r/...` R2-proxy paths to absolute API origin.
//
// On production (ai-feeds.com), CF Worker Routes intercept `/r/*` and serve
// from R2 directly — relative path works.
//
// On preview (*.xlist-dashboard.pages.dev) and local dev, no such routing
// exists, so `/r/...` 404s. Rewrite to `https://api.ai-feeds.com/r/...`
// (or VITE_API_BASE override) so images load consistently in all envs.

import { API_BASE } from "../api";

export function resolveAssetUrl(url: string | null | undefined): string {
  if (!url) return "";
  if (url.startsWith("/r/")) {
    // API_BASE is "" on localhost (vite proxy), absolute origin elsewhere
    const base = API_BASE || "";
    return `${base}${url}`;
  }
  return url;
}
