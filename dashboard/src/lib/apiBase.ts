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
// 解析优先级(与事故前 api.ts:32-46 版本逐字一致,不要改动语义):
//   1. VITE_API_BASE 环境变量(构建期由 .env / .env.staging 注入)—— 最高优先
//   2. localhost / 127.0.0.1 → ''(相对路径,交给 vite dev proxy 透传)
//   3. staging.ai-feeds.com / *.xlist-dashboard-staging.pages.dev → staging-api
//   4. 其余(prod 域名及一切兜底)→ prod api.ai-feeds.com
// ─────────────────────────────────────────────────────────────────────────────
export const API_BASE = (() => {
  if (import.meta.env.VITE_API_BASE) return import.meta.env.VITE_API_BASE;
  if (typeof window !== "undefined") {
    const host = window.location.hostname;
    // Dev: 走相对路径 → vite proxy 透传到目标 worker（默认 staging，可用 VITE_API_PROXY 覆盖）
    if (host === "localhost" || host === "127.0.0.1") {
      return "";
    }
    // Staging dashboard 必须打 staging worker，否则线上 prod 没有最新 endpoint
    // 时（例如 PR 部署的新接口）会全线 404
    if (host === "staging.ai-feeds.com" || host.endsWith(".xlist-dashboard-staging.pages.dev")) {
      return "https://staging-api.ai-feeds.com";
    }
  }
  return "https://api.ai-feeds.com";
})();
