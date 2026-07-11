// ─────────────────────────────────────────────────────────────────────────────
// API_BASE —— worker API 域名解析的【唯一事实源】(single source of truth)
//
// ⚠️ 本模块必须【零依赖】且是全站【唯一】定义 API_BASE 的地方。任何文件想要
//    worker 的 base URL,一律从这里(或从 api.ts 的 re-export)import,
//    绝不允许再抄一份解析逻辑 —— 镜像迟早分叉。
//
// 【为什么必须唯一 —— 2026-07-05 镜像分叉事故】
//    历史上 api.ts 和 lib/auth.ts 各自维护了一份 API_BASE 解析逻辑(镜像)。
//    api.ts 的版本带 staging 分支(staging.ai-feeds.com → staging-api),
//    auth.ts 的镜像却漏了这一段。当 staging 构建缺 dashboard/.env.staging
//    (worktree / CI 构建必缺)导致 VITE_API_BASE 为空、运行时兜底生效时:
//      - 业务请求(api.ts)      → staging-api.ai-feeds.com  ✅
//      - auth 请求(auth.ts 镜像漏 staging 分支)→ prod api.ai-feeds.com  ✗
//    于是登录永远打到 prod("成功"),业务永远打 staging(401)→ 登出 + 弹登录
//    的无限循环。教训:base 解析只能有一份。
//
// 解析优先级:
//   1. VITE_API_SAME_ORIGIN=true → ''(显式实验/生产切换,优先于 checked-in staging env)
//   2. VITE_API_BASE 环境变量(构建期由 .env / .env.staging 注入)
//   3. localhost / 127.0.0.1 / perf-staging → ''(相对路径)
//   4. staging.ai-feeds.com / *.xlist-dashboard-staging.pages.dev → staging-api
//   5. 其余(prod 域名及一切兜底)→ prod api.ai-feeds.com
//
// host fallback 不能覆盖显式 env base：普通 staging/Pages 构建必须继续走外域 API；
// 只有专用 same-origin build flag 能越过 `.env.staging`。
// ─────────────────────────────────────────────────────────────────────────────
export interface ApiBaseResolutionInput {
  hostname?: string;
  envBase?: string;
  sameOriginFlag?: boolean | string;
}

function isStagingHostname(hostname: string): boolean {
  return hostname === "staging.ai-feeds.com" ||
    hostname === "perf-staging.ai-feeds.com" ||
    hostname === "xlist-dashboard-staging.pages.dev" ||
    hostname.endsWith(".xlist-dashboard-staging.pages.dev");
}

export function resolveApiBase({
  hostname = "",
  envBase,
  sameOriginFlag,
}: ApiBaseResolutionInput = {}): string {
  if (sameOriginFlag === true || sameOriginFlag === "true") return "";
  if (envBase) return envBase;

  if (hostname === "localhost" || hostname === "127.0.0.1") return "";
  if (hostname === "www.ai-feeds.com" || hostname === "perf-staging.ai-feeds.com") return "";
  if (isStagingHostname(hostname)) {
    return "https://staging-api.ai-feeds.com";
  }
  return "https://api.ai-feeds.com";
}

// Absolute Worker origin for public routes that the site-origin nginx route
// intentionally does not proxy (/s, /r, /img). Unlike API_BASE, the explicit
// same-origin flag never collapses this value to an empty string.
export function resolvePublicWorkerBase({
  hostname = "",
  envBase,
}: ApiBaseResolutionInput = {}): string {
  if (envBase) return envBase;
  if (hostname === "localhost" || hostname === "127.0.0.1" || isStagingHostname(hostname)) {
    return "https://staging-api.ai-feeds.com";
  }
  return "https://api.ai-feeds.com";
}

const viteEnv = import.meta.env ?? {};
const runtimeResolutionInput: ApiBaseResolutionInput = {
  hostname: typeof window === "undefined" ? "" : window.location.hostname,
  envBase: viteEnv.VITE_API_BASE,
  sameOriginFlag: viteEnv.VITE_API_SAME_ORIGIN,
};

export const API_BASE = resolveApiBase(runtimeResolutionInput);
export const PUBLIC_WORKER_BASE = resolvePublicWorkerBase(runtimeResolutionInput);

export function buildPublicWorkerUrl(path: string, base: string = PUBLIC_WORKER_BASE): string {
  const normalizedBase = base.endsWith("/") ? base.slice(0, -1) : base;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}
