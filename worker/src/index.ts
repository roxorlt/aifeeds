import {
  runBackfillQuotes,
  runBackfillReplies,
  runBackfillRetweets,
  runDedupeQuoteContent,
  runLongformFetchOne,
  runReclassifyThreads,
  runReconstructThreads,
  runCleanup,
  runRefreshMetrics,
  runRefreshTiered,
  runFillTranslations,
  runDetectLongform,
  listPendingLongform,
  submitLongformText,
  refreshSingleItem,
  runListPollIngest,
  drainPendingWorkflowQueue,
  runLongformViaSb,
  runRetweetLongformBackfill,
  runClassifyPending,
  runBackfillVideoMp4,
  runPhEnrich,
  triggerXWorkflowForItem,
  runBackfillTruncatedFromSyndication,
  classifyAndTranslateForXTweet,
  runBackfillL3Translations,
  runBackfillTcoResolutions,
  runBackfillXArticles,
  runBackfillXArticleTranslations,
  runBackfillXArticleBodies,
  resolveTcoLinksForXTweet,
  fetchXArticlesForXTweet,
  fetchXArticleBodiesForXTweet,
  translateXArticlesForXTweet,
  backfillMediaForXTweet,
  backfillLinkCardForXTweet,
} from './enrich';
import {
  X_COOKIE_KV_KEY,
  getXCookie,
  saveXCookie,
  extractCookieValue,
  getDailyCount,
  getDailyCap,
} from './x-graphql';
import type { XCookieBlob } from './x-graphql';
import { authenticate } from './auth/session';
import { handleTrack } from './track';
import {
  runGithubFetchTrending,
  runGithubEnrichPending,
  runGithubReadmeTranslate,
  runGithubR2Migrate,
  triggerGhWorkflowForItem,
} from './github';
import { runPhR2Migrate, countPhR2Pending } from './ph-r2';
import { runXMediaR2Migrate, countXMediaR2Pending } from './x-media-r2';
import { renderXCardViaCodex, buildXCardPayload, runDrainXCardRenders, enqueueXCardRender, addManualXCardRender } from './x-card-render';
import { runPhDailyFetch, triggerPhWorkflowForItem, runBackfillPhCommentsTranslation } from './scrapers/ph';
import { runHfDailyFetch, triggerHfPaperWorkflowForItem } from './scrapers/hf-paper';
import { notifyCronSummary, sendDailyWarningDigest, runDailyHealthChecks } from './notifier';
import {
  handleHuodongxingPoc,
  runHuodongxingFetchList,
  runHuodongxingDetailEnrich,
  markStaleEventsHistorical,
  countHuodongxingDetailPending,
  triggerHdxWorkflowForItem,
  drainHdxPendingWorkflows,
} from './scrapers/huodongxing';
import type { HuodongxingCity } from './scrapers/huodongxing/cities';
import { HUODONGXING_CITIES } from './scrapers/huodongxing/cities';
import {
  runClawhubFetchList,
  runClawhubEnrichPending,
  refreshClawhubItem,
  countClawhubPending,
  triggerChWorkflowForItem,
} from './clawhub';
import {
  handleSmsSend,
  handleLogin,
  handleLogout,
  handleLogoutAll,
  handleMe,
  handlePutPreferences,
  handleDelete,
} from './auth/handlers';
import { handleEmailSend } from './auth/email-handlers';
import { handleWechatExchange } from './auth/wechat-handlers';
import {
  serveAdminToolsHtml,
  adminSmsStatus,
  adminUnlockSms,
  adminUser,
  adminCleanupAccount,
  adminDailyCap,
  adminClearPosterCache,
  checkAdminAuth,
} from './admin';
import { serveAdminDashboardHtml, handleAdminAnalytics } from './admin-dashboard';
import { serveAdminOpsHtml, handleAdminOps } from './admin-ops';
import { runOpsBaseline } from './ops/baseline';
import { runOpsDetect } from './ops/detect';
import { recordCronRun } from './cron-runs';
import { serveAdminTasksHtml, handleAdminTasks } from './admin-tasks';
import { serveAdminSubscriptionsHtml, handleAdminSubscriptions } from './admin-subscriptions';
import {
  handleShareCreate,
  handleSharePoster,
  handleShareRedirect,
  handleShareLanding,
  handleAdminShareStats,
} from './share/handlers';
import {
  handleSubscribe,
  handleGetMySubscription,
  handlePutMySubscription,
  handleUnsubMySubscription,
  handleUnsubscribeByToken,
  handleConfigure,
} from './digest/handlers';
import { handleDigestReturn, handleResendWebhook } from './digest/return-webhook';
import { handleDigestDaily } from './digest/daily-api';
import { slotKey } from './digest/lib';

export interface Env {
  DB: D1Database;
  AUTH_KV: KVNamespace;
  INGEST_TOKEN: string;
  DEEPSEEK_API_KEY?: string;
  // GITHUB_TOKEN: optional PAT (public_repo scope). Lifts API rate limit
  // 60→5000/hr. Without it, /repos/* /search/issues calls will be aggressively
  // throttled. Set via `wrangler secret put GITHUB_TOKEN`.
  GITHUB_TOKEN?: string;
  // R2 bucket for migrated README assets (v2.3). Bound via wrangler.toml
  // [[r2_buckets]]. Served via Worker /r/<key> with cache headers.
  READMES?: R2Bucket;
  // M4: refresh-metrics mode dispatch.
  //   'tiered'  → runRefreshTiered (uses tier/next_refresh_at/last_velocity)
  //   'legacy'  → runRefreshMetrics (round-robin, default — preserves pre-M4 behavior)
  //   'off'     → skip refresh entirely
  REFRESH_MODE?: string;
  // Cap on which tiers the tiered refresher touches. Default '1' = gradual
  // rollout (L0+L1 only); set to '4' for full coverage once stable.
  REFRESH_TIER_MAX?: string;
  // ScrapeBadger 第三方 X 抓取服务（替代 syndication 拿回 retweet/view 字段）
  // 接 refresh-tiered 路径；缺失时自动回落到 syndication
  SCRAPEBADGER_API_KEY?: string;
  // List 实验用：list-poll-ingest cron 抓哪个 list（默认 1643236611378008066）
  LIST_POLL_LIST_ID?: string;
  // PR2 auth secrets (上线前用 wrangler secret put 设置)
  TURNSTILE_SECRET_KEY?: string;
  TENCENT_SMS_SECRET_ID?: string;       // 腾讯云 API SecretId
  TENCENT_SMS_SECRET_KEY?: string;      // 腾讯云 API SecretKey
  TENCENT_SMS_SDK_APP_ID?: string;      // 短信应用 ID（控制台分配，1400 开头 7 位）
  TENCENT_SMS_SIGN_NAME?: string;       // 已审签名，例：xList
  TENCENT_SMS_TEMPLATE_ID?: string;     // 已审模板 ID
  TENCENT_SMS_REGION?: string;          // 默认 ap-guangzhou
  PUSHDEER_ADMIN_KEYS?: string;         // 逗号分隔多个 key
  // 运营看板内容池：'true' 开启 PushDeer 推送，否则只跑 cron 不推（首次上线先观察 3 天）
  OPS_PUSHDEER_ENABLED?: string;
  // X article body 抓取日总量 cap (PR6, 2026-05-22)。默认 50/天,可调
  // 走 X GraphQL TweetResultByRestId 需 cookie + 风控,KV 计数 UTC 0 重置
  X_GRAPHQL_DAILY_CAP?: string;
  // PR2 配置
  SMS_DAILY_CAP?: string;               // 默认 200，可临时降到 0 = kill switch
  SMS_PROVIDER?: string;                // 'tencent'（默认）/ 'pushdeer'（dev/staging 走 PushDeer 推到 admin）
  // Admin panel 凭据。优先级：CF Access JWT > Basic Auth fallback。
  // CF Access（推荐）：边缘节点 Access 拦截 + worker 校验 Cf-Access-Jwt-Assertion JWT。
  //   CF_ACCESS_TEAM_DOMAIN: wrangler.toml vars 明文配置（如 https://aifeeds.cloudflareaccess.com）
  //   CF_ACCESS_AUD: wrangler secret put（每个 Access Application 的 AUD tag）
  // Basic Auth（fallback / 应急通道）：CF Access 未配置时启用。
  //   ADMIN_USER / ADMIN_PASS: wrangler secret put 注入。
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  ADMIN_USER?: string;
  ADMIN_PASS?: string;
  // Dev/OPS CLI bypass token for the bot UA gate (see isBotGateExempt + bot gate
  // in default fetch handler). BE/OPS smoke scripts add `X-Dev-Token: $DEV_TOKEN`
  // to curl/python-requests calls to admin/write endpoints, otherwise their
  // default UA gets 403'd by the bot filter. Stored in
  // .secrets/aifeeds-{prod,staging}.env, injected via wrangler secret put.
  // Note: this does NOT bypass CF Access JWT on /admin* — that needs a separate
  // CF Access Service Token (see docs/operations.md § 7a).
  DEV_TOKEN?: string;
  // 香港中转回源密钥(2026-06-02)。VPS nginx 反代 api 时注入 X-Origin-Secret 头;
  // worker 据此判断"请求是否来自我的香港 VPS"——用于 (1) 拒绝直连 *.workers.dev 的匿名请求
  // (防白嫖额度 / 绕过 VPS 限流) (2) getClientIp 信任 X-Forwarded-For 取真实访客 IP。
  // 仅 prod 设置(staging 不设 = 该 gate 关闭)。存 .secrets/aifeeds-prod.env,wrangler secret put 注入。
  ORIGIN_SECRET?: string;
  // PR-EmailAuth：Resend + email 风控配置
  RESEND_API_KEY?: string;              // wrangler secret put 设置（不入 git）
  EMAIL_DAILY_CAP?: string;             // 默认 100（Resend free 100/天）
  EMAIL_MONTHLY_CAP?: string;           // 默认 3000（Resend free 3000/月）
  EMAIL_FROM?: string;                  // 默认 'AI Feeds <noreply@mail.ai-feeds.com>'
  SITE_BASE?: string;                   // 前端域(落地深链/进站),prod https://ai-feeds.com
  API_BASE?: string;                    // worker API 域(回流/退订端点),prod https://api.ai-feeds.com
  ENABLE_SMS_LOGIN?: string;            // 'true' = 开放 SMS 通道（备案后），缺省/'false' = 关闭
  ENABLE_EMAIL_LOGIN?: string;          // 默认开启；'false' = 紧急关闭 email 通道
  // PR-WechatAuth(worker)：微信扫码登录 — .cc 中转代理 ↔ worker 互信 HMAC
  // 架构见 docs/wechat/architecture.md §4-5。
  // BRIDGE_SECRET：.cc 调 /api/auth/wechat/exchange 时 HMAC 签名用的共享 secret，
  // wrangler secret put（每环境独立值，prod/staging 不能共用）。
  // ENABLE_WECHAT_LOGIN：默认开启；'false' = 紧急关停（rate-limited 等场景）。
  BRIDGE_SECRET?: string;
  ENABLE_WECHAT_LOGIN?: string;
  // PH GraphQL OAuth (client_credentials flow). Set via wrangler secret put.
  // Used by worker/src/scrapers/ph.ts (daily fetch cron).
  PH_CLIENT_ID?: string;
  PH_CLIENT_SECRET?: string;
  // 订阅推送子系统(migration 018)。secret 进 .secrets/aifeeds-{prod,staging}.env。
  DIGEST_EMAIL_HMAC?: string;             // 邮件回流 token HMAC secret(32B hex)
  RESEND_WEBHOOK_SECRET?: string;         // Resend(Svix)webhook 签名校验 secret
  DIGEST_API_KEY?: string;                // 对外日报 JSON API(GET /api/digest/daily)Bearer key
  X_CARD_SHARED_TOKEN?: string;           // 调 Codex X 卡片渲染 API 的 Bearer token(P3)
  X_CARD_RENDER_ENDPOINT?: string;        // Codex 渲染端点(默认 http://82.156.0.68/aifeeds/api/render/x-card)
  // CF Workflow binding for GH 抓取链 (worker/src/workflows/github-pipeline.ts)。
  // runGithubFetchTrending 解析 trending 后对每个新 repo create 一个 instance。
  // 替换原 3 个 preempt cron mode (github-enrich / github-r2-migrate /
  // github-readme-translate)。设计：docs/plans/2026-05-16-github-pipeline-workflows-design.md
  GITHUB_PIPELINE_WORKFLOW: Workflow;
  // CF Workflow binding for X 主链 (worker/src/workflows/x-tweet-pipeline.ts)。
  // runListPollIngest 拉 list 后对每条新 tweet create 一个 instance。
  // 替换 6 个 preempt cron mode (classify-pending / fill-translations /
  // backfill-quotes / backfill-replies / detect-longform / longform-via-sb)。
  // 设计：docs/plans/2026-05-16-x-main-pipeline-workflows-design.md
  X_TWEET_PIPELINE_WORKFLOW: Workflow;
  // 2026-05-17 重构:X workflow 完整性 gate filter 开关。'true' = 启用,筛掉
  // X 推文 workflow_completed_at IS NULL 的数据(翻译失败 / workflow 未完成)。
  // staging 先开 prod 等批 4 backfill 老数据完成后再开。详见 docs/plans/2026-05-17-x-workflow-rollout-plan.md
  WORKFLOW_COMPLETED_FILTER?: string;
  // CF Workflow binding for huodongxing detail enrich (worker/src/workflows/
  // huodongxing-detail.ts)。runHuodongxingFetchList 后对每条新事件 create
  // instance。替换原 isHdxEnrichSlot preempt cron。
  // 设计：docs/plans/2026-05-16-huodongxing-workflow-design.md
  HUODONGXING_DETAIL_WORKFLOW: Workflow;
  // CF Workflow binding for Product Hunt (worker/src/workflows/ph-pipeline.ts)。
  // runPhDailyFetch 后对每条新 post create instance。替换 ph-enrich +
  // ph-r2-migrate + fill-translations PH 字段 3 个 preempt cron。
  // 设计：docs/plans/2026-05-16-ph-clawhub-workflow-design.md
  PH_PIPELINE_WORKFLOW: Workflow;
  // CF Workflow binding for ClawHub (worker/src/workflows/clawhub-pipeline.ts)。
  // runClawhubFetchList 后对每条新 skill create instance。替换
  // clawhub-enrich preempt cron。设计同上。
  CH_PIPELINE_WORKFLOW: Workflow;
  // 订阅推送(worker/src/digest/):node-run 算榜单+起 deliver;deliver per-sub 投递。
  DIGEST_NODE_RUN_WORKFLOW: Workflow;
  DIGEST_DELIVER_WORKFLOW: Workflow;
  // HuggingFace Daily Papers token(read scope)— worker/src/scrapers/hf-paper.ts
  // 通过 Authorization: Bearer 调 GET /api/daily_papers + GET /api/papers/:id。
  // 2026-05-18 OPS verify staging + prod 均已配。
  HF_READ?: string;
  // CF Workflow binding for HF Daily Papers(worker/src/workflows/hf-paper-pipeline.ts,Phase 3 实现)。
  // runHfDailyFetch 后对每条 new paper create 1 个 instance,跑 8-step fan-out pipeline
  // (refresh-paper-detail / backfill-media-r2 / fetch-ar5iv-and-extract-figure /
  // fetch-discussion[svelte_ssr] / translate-ar5iv / translate-discussion-comments /
  // 7 段 deep_analysis pro reasoning + flash translate-title-summary / merge / gate)。
  // 设计:docs/plans/2026-05-18-hf-daily-papers-source-design.md §4
  // Phase 2 阶段 wrangler.toml binding 尚未加(等 Phase 3 写 class 一起 commit),
  // 故 optional。triggerHfPaperWorkflowForItem 内置 binding-missing fallback。
  HF_PAPER_PIPELINE_WORKFLOW?: Workflow;
}

// re-export workflow class 让 wrangler.toml [[workflows]] class_name 能找到
export { GithubPipelineWorkflow } from './workflows/github-pipeline';
export { XTweetPipelineWorkflow } from './workflows/x-tweet-pipeline';
export { HuodongxingDetailWorkflow } from './workflows/huodongxing-detail';
export { PhPipelineWorkflow } from './workflows/ph-pipeline';
export { ClawhubPipelineWorkflow } from './workflows/clawhub-pipeline';
export { HfPaperPipelineWorkflow } from './workflows/hf-paper-pipeline';
export { DigestNodeRunWorkflow } from './digest/node-run';
export { DigestDeliverWorkflow } from './digest/deliver';

// CORS origins allowed
const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:3000',
  'https://ai-feeds.com',
  'https://www.ai-feeds.com',
  'https://staging.ai-feeds.com',
];

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin') || '';
  // Allow any *.ai-feeds.com (含 staging.ai-feeds.com 等子域) /
  // any *.pages.dev / configured localhost ports.
  const allowed =
    ALLOWED_ORIGINS.includes(origin) ||
    origin.endsWith('.ai-feeds.com') ||
    origin.endsWith('.pages.dev') ||
    /^http:\/\/localhost:\d+$/.test(origin) ||
    /^http:\/\/127\.0\.0\.1:\d+$/.test(origin);
  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': allowed ? origin : '',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Device-Id',
    'Access-Control-Max-Age': '86400',
  };
  // Allow-Credentials 仅在 allowed origin 才返回，配合 dashboard 的 fetch credentials:'include'。
  // 浏览器规范：credentials=include 时 Allow-Credentials 必须 'true' 否则拒收响应；同时
  // Allow-Origin 不可为 '*'，必须具体 origin（上面已经是具体 origin）。
  if (allowed) {
    headers['Access-Control-Allow-Credentials'] = 'true';
    headers['Vary'] = 'Origin';
  }
  return headers;
}

function jsonResponse(data: unknown, status: number, request: Request, env: Env): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(request, env),
    },
  });
}

function withCors(resp: Response, request: Request, env: Env): Response {
  const newHeaders = new Headers(resp.headers);
  for (const [k, v] of Object.entries(corsHeaders(request, env))) {
    newHeaders.set(k, v);
  }
  return new Response(resp.body, { status: resp.status, headers: newHeaders });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    // ── Origin gate (2026-06-02 香港中转) ──────────────────────────────────
    // 中转上线后 api.ai-feeds.com 经香港 VPS 到达 worker(nginx 把 Host 改成
    // *.workers.dev),所以靠 hostname 没法区分"经中转"和"直连 *.workers.dev"。
    // VPS 注入 X-Origin-Secret;没带的就是直接打公开 *.workers.dev 的请求
    // (白嫖额度 / 绕过 VPS 限流),拒掉。仅当 ORIGIN_SECRET 设置时启用(prod);
    // staging/dev 不设 → 跳过。豁免:admin.ai-feeds.com(CF Access 把门,不经中转)、
    // Resend webhook(自带 Svix 签名)、邮件回流落地(公开 link)、BE/OPS 的
    // X-Dev-Token 逃生通道(可直连 *.workers.dev 调试)。
    if (env.ORIGIN_SECRET) {
      const viaRelay = request.headers.get('X-Origin-Secret') === env.ORIGIN_SECRET;
      const exempt =
        url.hostname === 'admin.ai-feeds.com' ||
        path === '/api/webhook/resend' ||
        path === '/api/digest/return' ||
        (!!env.DEV_TOKEN && request.headers.get('X-Dev-Token') === env.DEV_TOKEN);
      if (!viaRelay && !exempt) {
        return new Response('Forbidden', {
          status: 403,
          headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store' },
        });
      }
    }

    // Bot UA gate: cheap UA-string match to drop obvious scrapers/AI-training crawlers
    // before they hit D1/R2. Search engine bots + social previewers stay on the allowlist
    // since they drive SEO + share-card value.
    //
    // Three layers of exemption (see isBotGateExempt + DEV_TOKEN check below):
    //   1. /api/ingest /api/track — never UA-checked (own scrapers + browser analytics)
    //   2. Public read-only endpoints (/api/items GET, /img, /r/*, ...) — content is
    //      publicly crawlable anyway; UA filter here breaks BE/OPS curl smoke tests
    //      without any security benefit. Bot still hits D1, but these are cached + cheap.
    //   3. X-Dev-Token = DEV_TOKEN header bypass — for BE/OPS CLI smoke against
    //      admin/write endpoints (POST /api/admin/*, etc.) without changing UA.
    //
    // Empty UA is suspicious but we allow it — some monitoring tools and curl-style
    // health checks omit UA.
    if (!isBotGateExempt(path, request.method)) {
      const hasDevBypass =
        !!env.DEV_TOKEN && request.headers.get('X-Dev-Token') === env.DEV_TOKEN;
      if (!hasDevBypass) {
        const ua = request.headers.get('User-Agent') || '';
        if (ua && isBlockedBot(ua)) {
          return new Response('Forbidden', {
            status: 403,
            headers: {
              'Content-Type': 'text/plain; charset=utf-8',
              // No edge cache — earlier `public, max-age=86400` cached 403 for 24h,
              // which made debugging (and any rollback) painful.
              'Cache-Control': 'private, no-store',
            },
          });
        }
      }
    }

    try {
      if (path === '/api/ingest' && request.method === 'POST') {
        return handleIngest(request, env);
      }
      if (path === '/api/items' && request.method === 'GET') {
        return handleItems(request, env);
      }
      // POST /api/items/:id/refresh — drawer 打开时调用 on-demand enrich（PR6.6）
      const itemRefreshMatch = path.match(/^\/api\/items\/(.+)\/refresh$/);
      if (itemRefreshMatch && request.method === 'POST') {
        return withCors(await handleItemRefresh(request, env, decodeURIComponent(itemRefreshMatch[1])), request, env);
      }
      // POST /api/items/:id/refresh-hf-discussion — hf_paper 专用,drawer 第二个 useEffect 并发调
      // 跑 discussion fetch + content_html 内 <img> 抓 R2 + 翻译,wall-clock 5-10s
      // FE 单独 15s timeout(api.ts refreshHfDiscussion),避开通用 /refresh 5s cap
      const itemHfDiscRefreshMatch = path.match(/^\/api\/items\/(.+)\/refresh-hf-discussion$/);
      if (itemHfDiscRefreshMatch && request.method === 'POST') {
        return withCors(await handleHfDiscussionRefresh(request, env, decodeURIComponent(itemHfDiscRefreshMatch[1])), request, env);
      }
      // POST /api/items/:id/translate-now — 用户点译文按钮触发即时翻译(批 1.5)
      // cookie auth + per-user-per-item 60s 冷却 + per-user 每日 20 次上限
      const itemTranslateMatch = path.match(/^\/api\/items\/(.+)\/translate-now$/);
      if (itemTranslateMatch && request.method === 'POST') {
        return withCors(await handleItemTranslateNow(request, env, ctx, decodeURIComponent(itemTranslateMatch[1])), request, env);
      }
      const itemByIdMatch = path.match(/^\/api\/items\/(.+)$/);
      if (itemByIdMatch && request.method === 'GET') {
        return handleItemById(request, env, decodeURIComponent(itemByIdMatch[1]));
      }
      if (path === '/api/sources' && request.method === 'GET') {
        return handleSources(request, env);
      }
      if (path === '/api/stats' && request.method === 'GET') {
        return handleStats(request, env);
      }
      if (path === '/api/enrich/run' && request.method === 'POST') {
        return handleEnrichRun(request, env, ctx);
      }
      if (path === '/api/longform/pending' && request.method === 'GET') {
        return handleLongformPending(request, env);
      }
      if (path === '/api/longform/submit' && request.method === 'POST') {
        return handleLongformSubmit(request, env);
      }
      if (path === '/api/track' && request.method === 'POST') {
        return withCors(await handleTrack(request, env), request, env);
      }
      if (path === '/api/auth/sms/send' && request.method === 'POST') {
        return withCors(await handleSmsSend(request, env, ctx), request, env);
      }
      if (path === '/api/auth/email/send' && request.method === 'POST') {
        return withCors(await handleEmailSend(request, env, ctx), request, env);
      }
      // .cc 中转代理 POST 过来换 session（架构见 docs/wechat/architecture.md）
      // server-to-server，不走 dashboard，不需要 device_id header（device_id 在 body 里透传）
      if (path === '/api/auth/wechat/exchange' && request.method === 'POST') {
        return withCors(await handleWechatExchange(request, env, ctx), request, env);
      }
      if (path === '/api/auth/login' && request.method === 'POST') {
        return withCors(await handleLogin(request, env, ctx), request, env);
      }
      if (path === '/api/auth/logout' && request.method === 'POST') {
        return withCors(await handleLogout(request, env, ctx), request, env);
      }
      if (path === '/api/auth/logout-all' && request.method === 'POST') {
        return withCors(await handleLogoutAll(request, env, ctx), request, env);
      }
      if (path === '/api/auth/me' && request.method === 'GET') {
        return withCors(await handleMe(request, env, ctx), request, env);
      }
      if (path === '/api/auth/me/preferences' && request.method === 'PUT') {
        return withCors(await handlePutPreferences(request, env, ctx), request, env);
      }
      // 订阅推送(digest)。匿名订阅 + 登录态管理 + RFC8058 一键退订。
      if (path === '/api/subscribe' && request.method === 'POST') {
        return withCors(await handleSubscribe(request, env, ctx), request, env);
      }
      if (path === '/api/subscribe/configure' && request.method === 'POST') {
        return withCors(await handleConfigure(request, env), request, env);
      }
      if (path === '/api/auth/me/subscription' && request.method === 'GET') {
        return withCors(await handleGetMySubscription(request, env, ctx), request, env);
      }
      if (path === '/api/auth/me/subscription' && request.method === 'PUT') {
        return withCors(await handlePutMySubscription(request, env, ctx), request, env);
      }
      if (path === '/api/auth/me/subscription/unsubscribe' && request.method === 'POST') {
        return withCors(await handleUnsubMySubscription(request, env, ctx), request, env);
      }
      if (path === '/unsubscribe' && (request.method === 'GET' || request.method === 'POST')) {
        return await handleUnsubscribeByToken(request, env);
      }
      if (path === '/api/digest/return' && request.method === 'GET') {
        return await handleDigestReturn(request, env, ctx);
      }
      if (path === '/api/digest/daily' && request.method === 'GET') {
        return await handleDigestDaily(request, env);
      }
      if (path === '/api/webhook/resend' && request.method === 'POST') {
        return await handleResendWebhook(request, env, ctx);
      }
      if (path === '/api/auth/delete' && request.method === 'POST') {
        return withCors(await handleDelete(request, env, ctx), request, env);
      }
      // Admin panel（HTTP Basic Auth；不走 corsHeaders，同源访问）
      // /admin 默认进仪表盘；/admin/tools 是原运维工具页；两页共享顶部导航。
      if (path === '/admin' || path === '/admin/') {
        return Response.redirect(new URL('/admin/dashboard', request.url).toString(), 302);
      }
      if (path === '/admin/dashboard' && request.method === 'GET') {
        return serveAdminDashboardHtml(request, env);
      }
      if (path === '/admin/tools' && request.method === 'GET') {
        return serveAdminToolsHtml(request, env);
      }
      if (path === '/admin/ops' && request.method === 'GET') {
        return serveAdminOpsHtml(request, env);
      }
      if (path === '/admin/tasks' && request.method === 'GET') {
        return serveAdminTasksHtml(request, env);
      }
      if (path === '/admin/subscriptions' && request.method === 'GET') {
        return serveAdminSubscriptionsHtml(request, env);
      }
      if (path === '/api/admin/analytics' && request.method === 'GET') {
        return handleAdminAnalytics(request, env);
      }
      if (path === '/api/admin/ops' && request.method === 'GET') {
        return handleAdminOps(request, env);
      }
      if (path === '/api/admin/tasks' && request.method === 'GET') {
        return handleAdminTasks(request, env);
      }
      if (path === '/api/admin/subscriptions' && request.method === 'GET') {
        return handleAdminSubscriptions(request, env);
      }
      if (path === '/api/admin/sms-status' && request.method === 'GET') {
        return adminSmsStatus(request, env);
      }
      if (path === '/api/admin/unlock-sms' && request.method === 'POST') {
        return adminUnlockSms(request, env);
      }
      if (path === '/api/admin/user' && request.method === 'GET') {
        return adminUser(request, env);
      }
      if (path === '/api/admin/cleanup-account' && request.method === 'POST') {
        return adminCleanupAccount(request, env);
      }
      if (path === '/api/admin/daily-cap' && request.method === 'GET') {
        return adminDailyCap(request, env);
      }
      if (path === '/api/admin/share/poster-cleanup' && request.method === 'POST') {
        return adminClearPosterCache(request, env);
      }
      // 5/28 加: feature flag CRUD (admin /admin/tools UI 调). impression refresh
      // 开关 + 未来可扩其他 flag. 改完立即 invalidate worker memory cache.
      if (path === '/api/admin/feature-flags' && request.method === 'GET') {
        const { handleAdminListFlags } = await import('./feature-flags');
        return handleAdminListFlags(request, env);
      }
      const flagMatch = path.match(/^\/api\/admin\/feature-flags\/([a-z_]+)$/);
      if (flagMatch && request.method === 'POST') {
        const { handleAdminSetFlag } = await import('./feature-flags');
        return handleAdminSetFlag(request, env, flagMatch[1]);
      }
      // ─── PR5 share endpoints ───────────────────────────────────
      if (path === '/api/share/create' && request.method === 'POST') {
        return withCors(await handleShareCreate(request, env, ctx), request, env);
      }
      const sharePosterMatch = path.match(/^\/api\/share\/poster\/(.+)$/);
      if (sharePosterMatch && request.method === 'GET') {
        return handleSharePoster(request, env, sharePosterMatch[1]);
      }
      if (path === '/api/share/landing' && request.method === 'POST') {
        return withCors(await handleShareLanding(request, env), request, env);
      }
      const adminShareMatch = path.match(/^\/api\/admin\/share\/(.+)$/);
      if (adminShareMatch && request.method === 'GET') {
        return handleAdminShareStats(request, env, adminShareMatch[1]);
      }
      const shareRedirectMatch = path.match(/^\/s\/([^/]+)$/);
      if (shareRedirectMatch && request.method === 'GET') {
        return handleShareRedirect(request, env, ctx, shareRedirectMatch[1]);
      }
      if (path === '/img' && request.method === 'GET') {
        return handleImageProxy(request);
      }
      if (path.startsWith('/r/') && (request.method === 'GET' || request.method === 'HEAD')) {
        return handleR2Asset(request, env, path.slice(3));
      }
      // ─── PH admin debug endpoints ──────────────────────────────
      // POST /api/admin/ph-fetch-now?force=1&pt_date=YYYY-MM-DD
      // POST /api/admin/ph-enrich-now?limit=10
      // POST /api/admin/ph-r2-migrate-now?limit=N
      // 鉴权：HTTP Basic Auth (ADMIN_USER / ADMIN_PASS)，与其他 /api/admin/* 一致。
      if (path === '/api/admin/ph-fetch-now' && request.method === 'POST') {
        if (!(await checkAdminAuth(request, env))) {
          return new Response('Unauthorized', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="ai-feeds admin"' },
          });
        }
        const u = new URL(request.url);
        const force = u.searchParams.get('force') === '1';
        const ptDate = u.searchParams.get('pt_date') || undefined;
        const result = await runPhDailyFetch(env, { force, ptDate });
        return jsonResponse(result, 200, request, env);
      }
      if (path === '/api/admin/ph-enrich-now' && request.method === 'POST') {
        if (!(await checkAdminAuth(request, env))) {
          return new Response('Unauthorized', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="ai-feeds admin"' },
          });
        }
        const u = new URL(request.url);
        const limit = Math.min(parseInt(u.searchParams.get('limit') || '10', 10), 30);
        const result = await runPhEnrich(env, limit);
        return jsonResponse(result, 200, request, env);
      }
      if (path === '/api/admin/ph-r2-migrate-now' && request.method === 'POST') {
        if (!(await checkAdminAuth(request, env))) {
          return new Response('Unauthorized', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="ai-feeds admin"' },
          });
        }
        const u = new URL(request.url);
        const limit = Math.min(parseInt(u.searchParams.get('limit') || '1', 10), 5);
        const result = await runPhR2Migrate(env, limit);
        return jsonResponse(result, 200, request, env);
      }
      // ─── GH Phase 1 手动触发（admin debug + staging 端到端测试用） ─
      // POST /api/admin/gh-fetch-now
      // 拉 trending HTML → 写 stub 行 → trigger Workflow for new repos
      if (path === '/api/admin/gh-fetch-now' && request.method === 'POST') {
        if (!(await checkAdminAuth(request, env))) {
          return new Response('Unauthorized', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="ai-feeds admin"' },
          });
        }
        const result = await runGithubFetchTrending(env);
        return jsonResponse(result, 200, request, env);
      }
      // ─── HF Daily Papers 手动触发(admin debug + staging 端到端测试用)─
      // POST /api/admin/hf-fetch-now?force=1&date=YYYY-MM-DD
      //   - force=1:跳过 sentinel(允许同日多次跑)
      //   - date=YYYY-MM-DD:指定 BJT 日期(默认今天)
      // 跑 runHfDailyFetch:拉 daily_papers(50)+ paper detail × 50 + arxiv categories batch
      //   → INSERT items stub → trigger workflow(Phase 3 加 class 后生效,在那之前 triggered=0)
      if (path === '/api/admin/hf-fetch-now' && request.method === 'POST') {
        if (!(await checkAdminAuth(request, env))) {
          return new Response('Unauthorized', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="ai-feeds admin"' },
          });
        }
        const u = new URL(request.url);
        const force = u.searchParams.get('force') === '1';
        const date = u.searchParams.get('date') || undefined;
        const result = await runHfDailyFetch(env, { force, date });
        return jsonResponse(result, 200, request, env);
      }
      // ─── HF R2 staging → prod 搬运 endpoint(prod 上线一次性用)──
      // POST /api/admin/hf-r2-migrate-from-staging?force=1&dry_run=1
      //   body: { "keys": ["hf/abc.png", "hf/avatar/xyz.jpg"], "source_origin"?: "https://staging-api.ai-feeds.com" }
      //
      // 行为:对每个 key 走 source_origin + /r/<key> 拉 staging R2,put 到本地 prod R2。
      // - force=1:覆盖已存在的 key(默认 skip)
      // - dry_run=1:只检查 staging 可达 + prod 是否已有,不实际 put
      // - 单次 hard cap 200 key(避免 subrequest 超 1000/invocation)
      if (path === '/api/admin/hf-r2-migrate-from-staging' && request.method === 'POST') {
        if (!(await checkAdminAuth(request, env))) {
          return new Response('Unauthorized', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="ai-feeds admin"' },
          });
        }
        const u = new URL(request.url);
        const force = u.searchParams.get('force') === '1';
        const dryRun = u.searchParams.get('dry_run') === '1';
        type Body = { keys?: string[]; source_origin?: string };
        const body = (await request.json().catch(() => ({}))) as Body;
        const keys = Array.isArray(body.keys) ? body.keys.slice(0, 200) : [];
        const srcOrigin = body.source_origin || 'https://staging-api.ai-feeds.com';
        if (keys.length === 0) {
          return jsonResponse({ error: 'keys[] required (≤200/batch)' }, 400, request, env);
        }
        let migrated = 0;
        let skippedExisting = 0;
        const failed: Array<{ key: string; reason: string }> = [];
        for (const rawKey of keys) {
          const key = rawKey.replace(/^\/r\//, '');                                // 容忍 /r/ 前缀
          if (!key) { failed.push({ key: rawKey, reason: 'empty_after_strip' }); continue; }
          try {
            if (!force) {
              const existing = await env.READMES.head(key);
              if (existing) { skippedExisting++; continue; }
            }
            const srcUrl = `${srcOrigin}/r/${key}`;
            const srcResp = await fetch(srcUrl);
            if (!srcResp.ok) { failed.push({ key, reason: `src_http_${srcResp.status}` }); continue; }
            if (dryRun) { migrated++; continue; }
            const buf = await srcResp.arrayBuffer();
            const ct = srcResp.headers.get('content-type') || 'application/octet-stream';
            await env.READMES.put(key, buf, { httpMetadata: { contentType: ct } });
            migrated++;
          } catch (e) {
            failed.push({ key, reason: `exception:${(e as Error).message}` });
          }
        }
        return jsonResponse({
          requested: keys.length,
          migrated,
          skipped_existing: skippedExisting,
          failed,
          source_origin: srcOrigin,
          dry_run: dryRun,
          force,
        }, 200, request, env);
      }
      // ─── GH Workflow 一次性 drain pending（迁移后兜底） ───────────
      // POST /api/admin/gh-trigger-pending-workflows-now?limit=N
      //
      // 扫两类 item：
      //   (a) extra.gh_pending=true — Phase 1 写完 stub 但还没跑 Workflow（正常 pending）
      //   (b) is_relevant IS NULL — 已 enrich 但 LLM 判别失败的「卡死」item
      //       (老 preempt 流程下，LLM 失败时 gh_pending 被清成 0，留下 NULL is_relevant)
      //
      // Workflow 完全幂等：step 1 重写 metadata、step 2 重新 LLM、step 3/4 幂等。
      // 已存在 instance ID 自动跳过（同 itemId 不会被多次创建实例）。
      if (path === '/api/admin/gh-trigger-pending-workflows-now' && request.method === 'POST') {
        if (!(await checkAdminAuth(request, env))) {
          return new Response('Unauthorized', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="ai-feeds admin"' },
          });
        }
        const u = new URL(request.url);
        const limit = Math.min(parseInt(u.searchParams.get('limit') || '50', 10), 400);
        if (!env.GITHUB_PIPELINE_WORKFLOW) {
          return jsonResponse({ error: 'GITHUB_PIPELINE_WORKFLOW binding missing' }, 500, request, env);
        }
        // 扩 drain SQL：覆盖 4 种 stuck（pending / 未分类 / README 没译 / R2 没迁）
        // + marker filter (30min 内已触发的 skip)
        const pending = await env.DB.prepare(
          `SELECT id FROM items
            WHERE source_type='github'
              AND deleted_at IS NULL
              AND (
                COALESCE(json_extract(extra, '$.gh_pending'), 0) IN (1, 'true')               -- 初始 pending
                OR is_relevant IS NULL                                                          -- 未分类
                OR (is_relevant=1 AND json_extract(extra, '$.readme_translated') IS NULL
                    AND COALESCE(json_extract(extra, '$.readme_lang'), 'other') != 'zh'
                    AND json_extract(extra, '$.readme_excerpt') IS NOT NULL)                    -- README 没翻译
                OR (is_relevant=1 AND json_extract(extra, '$.r2_migrated_at') IS NULL
                    AND json_extract(extra, '$.readme_excerpt') IS NOT NULL)                    -- R2 资源没迁
              )
              AND (
                json_extract(extra, '$.workflow_triggered_at') IS NULL
                OR json_extract(extra, '$.workflow_triggered_at') < strftime('%s','now','-30 minutes')
              )
            ORDER BY scraped_at ASC
            LIMIT ?`,
        ).bind(limit).all<{ id: string }>();
        let triggered = 0;
        let skipped = 0;
        let failed = 0;
        for (const r of pending.results) {
          const result = await triggerGhWorkflowForItem(env, r.id);
          if (result === 'triggered') triggered++;
          else if (result === 'already_exists') skipped++;
          else failed++;
        }
        return jsonResponse({ found: pending.results.length, triggered, skipped, failed }, 200, request, env);
      }
      // ─── 阶段 6 PH workflow drain ──────────────────────────────
      // POST /api/admin/ph-trigger-pending-workflows-now?limit=N (上限 400)
      // 扫所有 stuck PH：未分类 / R2 没迁 / 翻译没补 — workflow 内部 step 1-3
      // 会按需做完整 pipeline 或早退。
      if (path === '/api/admin/ph-trigger-pending-workflows-now' && request.method === 'POST') {
        if (!(await checkAdminAuth(request, env))) {
          return new Response('Unauthorized', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="ai-feeds admin"' },
          });
        }
        const u = new URL(request.url);
        const limit = Math.min(parseInt(u.searchParams.get('limit') || '50', 10), 400);
        if (!env.PH_PIPELINE_WORKFLOW) {
          return jsonResponse({ error: 'PH_PIPELINE_WORKFLOW binding missing' }, 500, request, env);
        }
        const pending = await env.DB.prepare(
          `SELECT id FROM items
            WHERE source_type='product_hunt' AND deleted_at IS NULL
              AND (
                is_relevant IS NULL                                                  -- 未分类
                OR (is_relevant=1 AND json_extract(extra, '$.r2_migrated_at') IS NULL) -- R2 没迁
                OR (is_relevant=1 AND content IS NOT NULL AND content_translated IS NULL)
                OR (is_relevant=1 AND json_extract(extra, '$.maker_post_text') IS NOT NULL
                    AND json_extract(extra, '$.maker_post_translated') IS NULL)
              )
              AND (
                json_extract(extra, '$.workflow_triggered_at') IS NULL
                OR json_extract(extra, '$.workflow_triggered_at') < strftime('%s','now','-30 minutes')
              )
            ORDER BY scraped_at DESC
            LIMIT ?`,
        ).bind(limit).all<{ id: string }>();
        let triggered = 0, skipped = 0, failed = 0;
        for (const r of pending.results) {
          const res = await triggerPhWorkflowForItem(env, r.id);
          if (res === 'triggered') triggered++;
          else if (res === 'already_exists') skipped++;
          else failed++;
        }
        return jsonResponse({ found: pending.results.length, triggered, skipped, failed }, 200, request, env);
      }
      // ─── 阶段 6 CH workflow drain ──────────────────────────────
      // POST /api/admin/ch-trigger-pending-workflows-now?limit=N (上限 400)
      // 扫 ch_pending=true 的 skill 触发 workflow。
      if (path === '/api/admin/ch-trigger-pending-workflows-now' && request.method === 'POST') {
        if (!(await checkAdminAuth(request, env))) {
          return new Response('Unauthorized', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="ai-feeds admin"' },
          });
        }
        const u = new URL(request.url);
        const limit = Math.min(parseInt(u.searchParams.get('limit') || '50', 10), 400);
        if (!env.CH_PIPELINE_WORKFLOW) {
          return jsonResponse({ error: 'CH_PIPELINE_WORKFLOW binding missing' }, 500, request, env);
        }
        const pending = await env.DB.prepare(
          `SELECT id FROM items
            WHERE source_type='clawhub' AND deleted_at IS NULL
              AND json_extract(extra, '$.ch_pending') = 1
              AND (
                json_extract(extra, '$.workflow_triggered_at') IS NULL
                OR json_extract(extra, '$.workflow_triggered_at') < strftime('%s','now','-30 minutes')
              )
            ORDER BY CAST(json_extract(metrics, '$.stars') AS INTEGER) DESC
            LIMIT ?`,
        ).bind(limit).all<{ id: string }>();
        let triggered = 0, skipped = 0, failed = 0;
        for (const r of pending.results) {
          const res = await triggerChWorkflowForItem(env, r.id);
          if (res === 'triggered') triggered++;
          else if (res === 'already_exists') skipped++;
          else failed++;
        }
        return jsonResponse({ found: pending.results.length, triggered, skipped, failed }, 200, request, env);
      }
      // ─── X Phase 1 手动触发（staging E2E + admin debug） ─────────
      // POST /api/admin/x-list-poll-now?list_id=...&pages=N
      // 触发 runListPollIngest 拉新 tweet → 写 D1 + create workflow instance per new。
      if (path === '/api/admin/x-list-poll-now' && request.method === 'POST') {
        if (!(await checkAdminAuth(request, env))) {
          return new Response('Unauthorized', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="ai-feeds admin"' },
          });
        }
        const u = new URL(request.url);
        const listId = u.searchParams.get('list_id') || env.LIST_POLL_LIST_ID || '1643236611378008066';
        const pages = Math.min(parseInt(u.searchParams.get('pages') || '3', 10), 10);
        const result = await runListPollIngest(env, listId, pages);
        return jsonResponse(result, 200, request, env);
      }
      // ─── X Workflow 一次性 drain pending（cutover 后兜底） ────────
      // POST /api/admin/x-trigger-pending-workflows-now?limit=N
      // 扫 X tweet 里仍 is_relevant IS NULL（未分类，老 preempt 卡死）的 item，
      // 每条 create workflow instance 重新走完 pipeline。
      // 同 itemId 已存在 instance 自动跳过（workflow 幂等）。
      if (path === '/api/admin/x-trigger-pending-workflows-now' && request.method === 'POST') {
        if (!(await checkAdminAuth(request, env))) {
          return new Response('Unauthorized', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="ai-feeds admin"' },
          });
        }
        const u = new URL(request.url);
        const limit = Math.min(parseInt(u.searchParams.get('limit') || '50', 10), 400);
        if (!env.X_TWEET_PIPELINE_WORKFLOW) {
          return jsonResponse({ error: 'X_TWEET_PIPELINE_WORKFLOW binding missing' }, 500, request, env);
        }
        // 扩 drain SQL：覆盖 4 种 stuck（未分类 / 未翻译 / 长推没拉 / quote 没回填）
        // + marker filter (30min 内已触发的 skip)
        const pending = await env.DB.prepare(
          `SELECT id, extra FROM items
            WHERE source_type='x_list'
              AND deleted_at IS NULL
              AND (
                is_relevant IS NULL                                                              -- 未分类
                OR (is_relevant=1 AND content_translated IS NULL
                    AND lang IS NOT NULL AND lang != 'zh'
                    AND content IS NOT NULL AND length(content) > 0)                              -- 未翻译
                OR (is_relevant=1 AND json_extract(extra, '$.longform.note_id') IS NOT NULL
                    AND json_extract(extra, '$.longform.fetched_at') IS NULL)                     -- 长推没拉
                OR (is_relevant=1 AND json_extract(extra, '$.quote_of_id') IS NOT NULL
                    AND json_extract(extra, '$.quote_of') IS NULL)                                -- quote 没回填
                OR (is_relevant=1 AND json_extract(extra, '$.reply_to_id') IS NOT NULL
                    AND json_extract(extra, '$.reply_of') IS NULL)                                -- reply 没回填
              )
              AND (
                json_extract(extra, '$.workflow_triggered_at') IS NULL
                OR json_extract(extra, '$.workflow_triggered_at') < strftime('%s','now','-30 minutes')
              )
            ORDER BY scraped_at DESC
            LIMIT ?`,
        ).bind(limit).all<{ id: string; extra: string | null }>();
        let triggered = 0;
        let skipped = 0;
        let failed = 0;
        for (const r of pending.results) {
          let extraObj: Record<string, unknown> = {};
          try { extraObj = JSON.parse(r.extra || '{}') as Record<string, unknown>; } catch { /* ignore */ }
          const signals = {
            hasQuoteRef: !!(extraObj.quote_of_id || extraObj.quote_of),
            hasReplyRef: !!(extraObj.reply_to_id || extraObj.reply_of_id || extraObj.reply_of),
            hasLinkCard: !!extraObj.link_card,
            hasRetweetRef: !!(extraObj.is_retweet || extraObj.retweeted_status_id || extraObj.retweet_of_id || extraObj.retweet_of),
          };
          const result = await triggerXWorkflowForItem(env, r.id, signals);
          if (result === 'triggered') triggered++;
          else if (result === 'already_exists') skipped++;
          else failed++;
        }
        return jsonResponse({ found: pending.results.length, triggered, skipped, failed }, 200, request, env);
      }
      // ─── X Workflow 手动触发单 itemId（staging E2E + 阶段 4 cutover 前测试用） ───
      // POST /api/admin/x-workflow-trigger-now?itemId=x_list:1234567890
      //
      // 触发 1 个 instance 走完 5 step pipeline。signals (hasQuoteRef 等) 自动
      // 从 D1 extra 推导（生产路径 runListPollIngest 改造后会从 SB API 信号
      // 直接传入，避免 SELECT）。
      if (path === '/api/admin/x-workflow-trigger-now' && request.method === 'POST') {
        if (!(await checkAdminAuth(request, env))) {
          return new Response('Unauthorized', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="ai-feeds admin"' },
          });
        }
        const u = new URL(request.url);
        const itemId = u.searchParams.get('itemId');
        if (!itemId) {
          return jsonResponse({ error: 'itemId param required' }, 400, request, env);
        }
        if (!env.X_TWEET_PIPELINE_WORKFLOW) {
          return jsonResponse({ error: 'X_TWEET_PIPELINE_WORKFLOW binding missing' }, 500, request, env);
        }
        // 从 extra 推导信号
        const row = await env.DB.prepare(
          `SELECT extra FROM items WHERE id = ? AND source_type='x_list'`,
        ).bind(itemId).first<{ extra: string | null }>();
        if (!row) {
          return jsonResponse({ error: `item not found: ${itemId}` }, 404, request, env);
        }
        const extra = row.extra ? JSON.parse(row.extra) as Record<string, unknown> : {};
        const params = {
          itemId,
          hasQuoteRef: !!(extra.quote_of || extra.quote_of_id),
          hasReplyRef: !!(extra.reply_of_id || extra.reply_to_id),
          hasLinkCard: !!extra.link_card,
          hasRetweetRef: !!(extra.is_retweet || extra.retweeted_status_id || extra.retweet_of || extra.retweet_of_id),
          lang: 'zh' as const,
        };
        // 2026-05-17 fix workflow instance reuse:hour-bucket suffix
        const hourBucket = new Date().toISOString().slice(0, 13).replace('T', '-');
        const instanceId = `x-${itemId.replace(/[^a-zA-Z0-9-]/g, '-')}-${hourBucket}`;
        try {
          const instance = await env.X_TWEET_PIPELINE_WORKFLOW.create({ id: instanceId, params });
          return jsonResponse({
            ok: true,
            instance_id: instance.id,
            status: await instance.status(),
            params,
          }, 200, request, env);
        } catch (e) {
          const msg = String(e);
          if (msg.toLowerCase().includes('already exists')) {
            // 已存在 → 拉现有 instance 状态
            const existing = await env.X_TWEET_PIPELINE_WORKFLOW.get(instanceId);
            return jsonResponse({
              ok: true,
              instance_id: instanceId,
              already_exists: true,
              status: await existing.status(),
            }, 200, request, env);
          }
          return jsonResponse({ error: msg }, 500, request, env);
        }
      }
      // F1: 手动触发 retweet 父推回填（ADMIN basic auth wrapper）
      // ?limit=N (默认 20, 上限 100), ?rate_sleep_ms=400, ?recover=1
      // recover=1 时绕开 state KV sentinel + 选 "is_retweet=1 + retweet_of NULL"
      // 的 row（覆盖被 list-poll UPSERT 洗过的历史数据）
      if (path === '/api/admin/backfill-retweets-now' && request.method === 'POST') {
        if (!(await checkAdminAuth(request, env))) {
          return new Response('Unauthorized', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="ai-feeds admin"' },
          });
        }
        const u = new URL(request.url);
        const limit = Math.min(Math.max(parseInt(u.searchParams.get('limit') || '20', 10), 1), 100);
        const rateSleepMs = Math.max(parseInt(u.searchParams.get('rate_sleep_ms') || '400', 10), 0);
        const recover = u.searchParams.get('recover') === '1';
        const result = await runBackfillRetweets(env, limit, rateSleepMs, recover);
        return jsonResponse(result, 200, request, env);
      }
      // 手动触发 quote 父推回填（ADMIN basic auth wrapper）
      // ?recover=1 时选 "quote_of_id 有 + quote_of 空" 的 row（覆盖被 list-poll
      // UPSERT 洗过的历史数据），绕开 enriched_at sentinel + state KV
      if (path === '/api/admin/backfill-quotes-now' && request.method === 'POST') {
        if (!(await checkAdminAuth(request, env))) {
          return new Response('Unauthorized', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="ai-feeds admin"' },
          });
        }
        const u = new URL(request.url);
        const limit = Math.min(Math.max(parseInt(u.searchParams.get('limit') || '20', 10), 1), 100);
        const rateSleepMs = Math.max(parseInt(u.searchParams.get('rate_sleep_ms') || '400', 10), 0);
        const recover = u.searchParams.get('recover') === '1';
        const result = await runBackfillQuotes(env, limit, rateSleepMs, recover);
        return jsonResponse(result, 200, request, env);
      }
      // Bug #1 backfill (2026-05-20): 历史 X 推 L3 嵌套翻译漏洞补全
      // 选条件:is_relevant=1 + workflow_completed_at 有 + retweet_of.quote_of / reply_of.quote_of /
      // quote_of.quote_of 任一 path 有 content 但 content_translated=null。
      // 调 classifyAndTranslateForXTweet(prompt + 入库已升级覆盖 L3)。
      // ?limit=N (默认 20, 上限 100), ?rate_sleep_ms=500 (DeepSeek 速率保护)
      // 通用 workflow_completed_at backfill (2026-05-21):历史 is_relevant=1 但缺 wc_at 的
      // item 用 scraped_at 作 proxy mark complete。给 PH/GH/CH/HDX 4 个 source 用,X / HF 已有。
      // ?source_type=product_hunt|github|clawhub|huodongxing (必填) ?dry_run=0 (默认 1)
      if (path === '/api/admin/backfill-workflow-completed-now' && request.method === 'POST') {
        if (!(await checkAdminAuth(request, env))) {
          return new Response('Unauthorized', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="ai-feeds admin"' },
          });
        }
        const u = new URL(request.url);
        const sourceType = u.searchParams.get('source_type') || '';
        const dryRun = u.searchParams.get('dry_run') !== '0';
        const VALID = ['product_hunt', 'github', 'clawhub', 'huodongxing'];
        if (!VALID.includes(sourceType)) {
          return jsonResponse({ error: `source_type required, one of: ${VALID.join(', ')}` }, 400, request, env);
        }
        // 候选:is_relevant=1 + wc_at 缺 + 未 deleted
        const countRow = await env.DB.prepare(
          `SELECT COUNT(*) AS n FROM items
            WHERE source_type = ?
              AND is_relevant = 1
              AND json_extract(extra, '$.workflow_completed_at') IS NULL
              AND deleted_at IS NULL`,
        ).bind(sourceType).first<{ n: number }>();
        const candidates = countRow?.n || 0;
        if (dryRun) {
          return jsonResponse({ source_type: sourceType, dry_run: true, candidates }, 200, request, env);
        }
        // bulk UPDATE — D1 单次处理几千行约 100-500ms
        const result = await env.DB.prepare(
          `UPDATE items
              SET extra = json_set(coalesce(extra, '{}'), '$.workflow_completed_at', scraped_at)
            WHERE source_type = ?
              AND is_relevant = 1
              AND json_extract(extra, '$.workflow_completed_at') IS NULL
              AND deleted_at IS NULL`,
        ).bind(sourceType).run();
        return jsonResponse({
          source_type: sourceType,
          dry_run: false,
          candidates,
          updated: result.meta.changes || 0,
        }, 200, request, env);
      }
      if (path === '/api/admin/backfill-l3-translations-now' && request.method === 'POST') {
        if (!(await checkAdminAuth(request, env))) {
          return new Response('Unauthorized', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="ai-feeds admin"' },
          });
        }
        const u = new URL(request.url);
        const limit = Math.min(Math.max(parseInt(u.searchParams.get('limit') || '20', 10), 1), 100);
        const rateSleepMs = Math.max(parseInt(u.searchParams.get('rate_sleep_ms') || '500', 10), 0);
        const result = await runBackfillL3Translations(env, limit, rateSleepMs);
        return jsonResponse(result, 200, request, env);
      }
      // t.co resolve backfill (2026-05-21): 历史 X items 哪些 content 是裸 t.co
      // 短链(L1/L2/L3 共 6 个 path),HEAD 拉 redirect URL 写 content_resolved_url。
      // ?limit=N (默认 50, 上限 200), ?rate_sleep_ms=200 (t.co 是 CDN 速率宽松)
      if (path === '/api/admin/backfill-tco-resolutions-now' && request.method === 'POST') {
        if (!(await checkAdminAuth(request, env))) {
          return new Response('Unauthorized', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="ai-feeds admin"' },
          });
        }
        const u = new URL(request.url);
        const limit = Math.min(Math.max(parseInt(u.searchParams.get('limit') || '50', 10), 1), 200);
        const rateSleepMs = Math.max(parseInt(u.searchParams.get('rate_sleep_ms') || '200', 10), 0);
        const result = await runBackfillTcoResolutions(env, limit, rateSleepMs);
        return jsonResponse(result, 200, request, env);
      }
      // X cookie 状态查询 (GET):返 updated_at / invalid_at / daily_used / daily_cap
      // X cookie 更新 (POST):提交新 cookie blob,清 invalid_at。鉴权同其他 admin。
      // 2026-05-22 PR6: 配合 X article body 抓取(GraphQL TweetResultByRestId 需 cookie)
      if (path === '/api/admin/x-cookie' && request.method === 'GET') {
        if (!(await checkAdminAuth(request, env))) {
          return new Response('Unauthorized', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="ai-feeds admin"' },
          });
        }
        if (!env.AUTH_KV) {
          return jsonResponse({ error: 'AUTH_KV binding missing' }, 500, request, env);
        }
        const cookie = await getXCookie({ AUTH_KV: env.AUTH_KV });
        const dailyUsed = await getDailyCount({ AUTH_KV: env.AUTH_KV });
        const dailyCap = getDailyCap({ AUTH_KV: env.AUTH_KV, X_GRAPHQL_DAILY_CAP: env.X_GRAPHQL_DAILY_CAP });
        return jsonResponse({
          configured: !!cookie,
          updated_at: cookie?.updated_at || null,
          invalid_at: cookie?.invalid_at || null,
          invalid_reason: cookie?.invalid_reason || null,
          auth_token_prefix: cookie?.auth_token ? cookie.auth_token.slice(0, 8) + '...' : null,
          daily_used: dailyUsed,
          daily_cap: dailyCap,
        }, 200, request, env);
      }
      if (path === '/api/admin/x-cookie' && request.method === 'POST') {
        if (!(await checkAdminAuth(request, env))) {
          return new Response('Unauthorized', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="ai-feeds admin"' },
          });
        }
        if (!env.AUTH_KV) {
          return jsonResponse({ error: 'AUTH_KV binding missing' }, 500, request, env);
        }
        const body = await request.json<{ cookie_string?: string }>().catch(() => ({ cookie_string: undefined }));
        const cookieStr = (body.cookie_string || '').trim();
        if (!cookieStr) {
          return jsonResponse({ error: 'cookie_string required' }, 400, request, env);
        }
        const ct0 = extractCookieValue(cookieStr, 'ct0');
        const authToken = extractCookieValue(cookieStr, 'auth_token');
        if (!ct0 || !authToken) {
          return jsonResponse({
            error: 'cookie_string must contain ct0 and auth_token',
            extracted: { ct0: !!ct0, auth_token: !!authToken },
          }, 400, request, env);
        }
        const blob: XCookieBlob = {
          cookie_string: cookieStr,
          ct0,
          auth_token: authToken,
          updated_at: new Date().toISOString(),
        };
        await saveXCookie({ AUTH_KV: env.AUTH_KV }, blob);
        return jsonResponse({
          ok: true,
          updated_at: blob.updated_at,
          auth_token_prefix: authToken.slice(0, 8) + '...',
          message: 'Cookie updated. invalid_at flag cleared.',
        }, 200, request, env);
      }
      // X article body 抓取 backfill (2026-05-22 PR6)
      // 走 X GraphQL TweetResultByRestId 拿 plain_text 字段(login-gated)。
      // 风控:单 worker request 内 5-10s jitter,日 cap(默认 50,可配)。
      // ?limit=N (默认 30,上限 100 — 单次 worker request 上限,避免 worker timeout)
      if (path === '/api/admin/backfill-x-article-bodies-now' && request.method === 'POST') {
        if (!(await checkAdminAuth(request, env))) {
          return new Response('Unauthorized', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="ai-feeds admin"' },
          });
        }
        const u = new URL(request.url);
        const limit = Math.min(Math.max(parseInt(u.searchParams.get('limit') || '30', 10), 1), 100);
        const result = await runBackfillXArticleBodies(
          {
            DB: env.DB,
            DEEPSEEK_API_KEY: env.DEEPSEEK_API_KEY,
            AUTH_KV: env.AUTH_KV,
            PUSHDEER_ADMIN_KEYS: env.PUSHDEER_ADMIN_KEYS,
            X_GRAPHQL_DAILY_CAP: env.X_GRAPHQL_DAILY_CAP,
          },
          limit,
          ctx,
        );
        return jsonResponse(result, 200, request, env);
      }
      // D2: 一次性清掉历史脏数据 — 老 chrome scraper 抓时把 quoted preview
      // text 也包进主推 content，导致 main.content == quote_of.content 完全相同。
      // 备份 main.content 到 extra.original_content + 把 main.content 清空。
      // ?dry_run=0 真写 / ?limit=N (默认 500)
      if (path === '/api/admin/dedupe-quote-content-now' && request.method === 'POST') {
        if (!(await checkAdminAuth(request, env))) {
          return new Response('Unauthorized', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="ai-feeds admin"' },
          });
        }
        const u = new URL(request.url);
        const dryRun = u.searchParams.get('dry_run') !== '0';
        const limit = Math.min(Math.max(parseInt(u.searchParams.get('limit') || '500', 10), 1), 5000);
        const result = await runDedupeQuoteContent(env, dryRun, limit);
        return jsonResponse(result, 200, request, env);
      }
      // D3: 强制单条重抓 self.text 全文（覆盖 SB API truncate 的内容）
      // ?id=x_list:xxx 必填
      if (path === '/api/admin/longform-fetch-now' && request.method === 'POST') {
        if (!(await checkAdminAuth(request, env))) {
          return new Response('Unauthorized', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="ai-feeds admin"' },
          });
        }
        const u = new URL(request.url);
        const id = u.searchParams.get('id');
        if (!id) return jsonResponse({ error: 'id required' }, 400, request, env);
        const result = await runLongformFetchOne(env, id);
        return jsonResponse(result, 200, request, env);
      }
      // F5: 一次性反向重建 thread_root_id（针对 reply 链 self-thread 但 root 空）
      // ADMIN basic auth wrapper. 默认 dry_run=1 看效果，?dry_run=0 真正写入
      if (path === '/api/admin/reconstruct-threads-now' && request.method === 'POST') {
        if (!(await checkAdminAuth(request, env))) {
          return new Response('Unauthorized', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="ai-feeds admin"' },
          });
        }
        const u = new URL(request.url);
        const dryRun = u.searchParams.get('dry_run') !== '0';
        const maxPasses = Math.min(Math.max(parseInt(u.searchParams.get('max_passes') || '5', 10), 1), 20);
        const result = await runReconstructThreads(env, dryRun, maxPasses);
        return jsonResponse(result, 200, request, env);
      }
      // 运维:手动触发 warning 日报 flush(测试用,也可应急 force push)
      // POST /api/admin/notify-digest-now
      // 不带 dry_run 时真发 PushDeer(empty buffer 时也不发)
      if (path === '/api/admin/notify-digest-now' && request.method === 'POST') {
        if (!(await checkAdminAuth(request, env))) {
          return new Response('Unauthorized', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="ai-feeds admin"' },
          });
        }
        const result = await sendDailyWarningDigest(env);
        return jsonResponse(result, 200, request, env);
      }
      // 运维:手动 enqueue 一条 warning 验证日报机制(不真出问题时测 buffer + digest)
      // POST /api/admin/notify-warning-test?title=测试&body=...
      if (path === '/api/admin/notify-warning-test' && request.method === 'POST') {
        if (!(await checkAdminAuth(request, env))) {
          return new Response('Unauthorized', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="ai-feeds admin"' },
          });
        }
        const { pushDeerWarning } = await import('./notifier');
        const u = new URL(request.url);
        const title = u.searchParams.get('title') || '测试 warning';
        const body = u.searchParams.get('body') || `测试时间: ${new Date().toISOString()}`;
        await pushDeerWarning(env, title, body);
        return jsonResponse({ ok: true, enqueued: { title, body } }, 200, request, env);
      }
      // 运维：手动触发一条测试推送，验证 PUSHDEER 配置 + body 中文化效果
      // POST /api/admin/notify-test
      //   ?source=ph|x|gh|clawhub|hdx|hdx-skip|all
      //   不传或 source=all 时一次性推 5 条（覆盖所有 5 个 fetch 的字段结构 + 1 条 PH skip 路径）
      // 用模拟数据验证 notifyCronSummary i18n 是否覆盖了真实字段，不真的去抓数据。
      if (path === '/api/admin/notify-test' && request.method === 'POST') {
        if (!(await checkAdminAuth(request, env))) {
          return new Response('Unauthorized', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="ai-feeds admin"' },
          });
        }
        const u = new URL(request.url);
        const source = u.searchParams.get('source') || 'all';
        const hasKey = !!env.PUSHDEER_ADMIN_KEYS;
        const keyCount = hasKey ? env.PUSHDEER_ADMIN_KEYS!.split(',').filter((k) => k.trim()).length : 0;

        // 各 source 的模拟 result。**字段结构与 runXxxFetch 真实 return 完全一致**，
        // 验证 i18n 是否对得上：
        const samples: Record<string, { name: string; result: Record<string, unknown> }> = {
          ph: {
            name: 'PH 每日抓取',
            result: {
              mode: 'ph-daily-fetch',
              pt_date: '2026-05-13',
              list_size: 50,
              fetched: 50,
              ingested: { inserted: 47, updated: 3, errors: 0 },
              duration_ms: 128456,
            },
          },
          'ph-skip': {
            name: 'PH 每日抓取（跳过）',
            result: {
              mode: 'ph-daily-fetch',
              pt_date: '2026-05-13',
              skipped: 'sentinel',
              duration_ms: 5,
            },
          },
          x: {
            name: 'X List 抓取',
            result: {
              mode: 'list-poll-ingest',
              list_id: '1643236611378008066',
              pages: 3,
              tweets_seen: 147,
              inserted_or_updated: 147,
              newly_inserted: 12,
              credits_used: 150,
              rate_limit_remaining: 4823,
              duration_ms: 13691,
              early_stop: false,
            },
          },
          gh: {
            name: 'GitHub Trending 抓取',
            result: {
              parsed: 25,
              inserted: 3,
              updated_seen: 22,
              errors: 0,
            },
          },
          clawhub: {
            name: 'ClawHub 列表抓取',
            result: {
              total_unique: 1234,
              inserted: 48,
              updated: 1186,
              skipped: 0,
              errors: [],
            },
          },
          hdx: {
            name: '活动行抓取',
            result: {
              cities_processed: 3,
              cities_remaining: 0,
              pages_fetched: 18,
              cards_inserted_or_updated: 217,
              errors: [],
              budget_consumed: 18,
              finished: true,
              duration_ms: 24830,
            },
          },
        };

        const toPush = source === 'all'
          ? ['ph', 'ph-skip', 'x', 'gh', 'clawhub', 'hdx']
          : [source];
        const pushed: string[] = [];
        for (const s of toPush) {
          const sample = samples[s];
          if (!sample) continue;
          await notifyCronSummary(env, sample.name, sample.result);
          pushed.push(s);
        }
        return jsonResponse({ pushed_sources: pushed, key_count: keyCount }, 200, request, env);
      }
      // ─── Huodongxing POC (Phase 1) — no DB write, dev/QA validation only ────
      // GET /poc/hdx?city=北京&page=1&detail=1
      // Returns parsed listing cards + (optional) first detail enrich, with
      // field-extraction stats so we can confirm parsers match real HTML.
      if (path === '/poc/hdx' && request.method === 'GET') {
        return handleHuodongxingPoc(request, env);
      }
      // ─── Huodongxing admin endpoints (Phase 2) — manual fetch / enrich ──────
      //   POST /api/admin/hdx-fetch-now?budget=40&reset=1&only_city=北京
      //   POST /api/admin/hdx-enrich-now?limit=5
      //   POST /api/admin/hdx-sweep-now
      //   GET  /api/admin/hdx-status
      // 鉴权：HTTP Basic Auth（ADMIN_USER / ADMIN_PASS）。
      if (path === '/api/admin/hdx-fetch-now' && request.method === 'POST') {
        if (!(await checkAdminAuth(request, env))) {
          return new Response('Unauthorized', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="ai-feeds admin"' },
          });
        }
        const u = new URL(request.url);
        const budget = parseInt(u.searchParams.get('budget') || '40', 10);
        const reset = u.searchParams.get('reset') === '1';
        const onlyCityParam = u.searchParams.get('only_city');
        const onlyCity =
          onlyCityParam && HUODONGXING_CITIES.includes(onlyCityParam)
            ? (onlyCityParam as HuodongxingCity)
            : undefined;
        const result = await runHuodongxingFetchList(env, { budget, reset, onlyCity });
        return jsonResponse(result, 200, request, env);
      }
      if (path === '/api/admin/hdx-enrich-now' && request.method === 'POST') {
        if (!(await checkAdminAuth(request, env))) {
          return new Response('Unauthorized', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="ai-feeds admin"' },
          });
        }
        const u = new URL(request.url);
        const limit = Math.min(parseInt(u.searchParams.get('limit') || '3', 10), 20);
        const result = await runHuodongxingDetailEnrich(env, limit);
        return jsonResponse(result, 200, request, env);
      }
      if (path === '/api/admin/hdx-sweep-now' && request.method === 'POST') {
        if (!(await checkAdminAuth(request, env))) {
          return new Response('Unauthorized', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="ai-feeds admin"' },
          });
        }
        const result = await markStaleEventsHistorical(env);
        return jsonResponse(result, 200, request, env);
      }
      if (path === '/api/admin/hdx-status' && request.method === 'GET') {
        if (!(await checkAdminAuth(request, env))) {
          return new Response('Unauthorized', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="ai-feeds admin"' },
          });
        }
        const pending = await countHuodongxingDetailPending(env);
        const progressRaw = await env.AUTH_KV.get('hdx:fetch_progress');
        const progress = progressRaw ? JSON.parse(progressRaw) : null;
        return jsonResponse({ pending_detail_enrich: pending, fetch_progress: progress }, 200, request, env);
      }
      // ─── 阶段 5: hdx workflow drain pending（cutover 后兜底 / 老 backlog 清）
      // POST /api/admin/hdx-trigger-pending-workflows-now?limit=N
      //
      // 扫所有 detail_enriched_at IS NULL 的 hdx 事件，按 last_seen_at DESC 排序，
      // 用 throttleSec spacing 5s 错开 trigger workflow instance。
      // 默认 limit=100，N 个 instance 跨 5N 秒 wall time 处理。
      // 860 backlog → 9 批 limit=100 跑完。
      if (path === '/api/admin/hdx-trigger-pending-workflows-now' && request.method === 'POST') {
        if (!(await checkAdminAuth(request, env))) {
          return new Response('Unauthorized', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="ai-feeds admin"' },
          });
        }
        const u = new URL(request.url);
        const limit = Math.min(parseInt(u.searchParams.get('limit') || '100', 10), 400);
        const result = await drainHdxPendingWorkflows(env, limit, 5);
        return jsonResponse(result, 200, request, env);
      }
      // POST /api/admin/fill-translations-now?limit=30&batch_size=8
      // 鉴权：HTTP Basic Auth (ADMIN_USER / ADMIN_PASS)，与其他 /api/admin/* 一致
      // 用途：手动批量补翻积压（X content / quote_of / link_card + PH content / maker / comments）
      if (path === '/api/admin/fill-translations-now' && request.method === 'POST') {
        if (!(await checkAdminAuth(request, env))) {
          return new Response('Unauthorized', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="ai-feeds admin"' },
          });
        }
        const u = new URL(request.url);
        const limit = Math.min(
          Math.max(parseInt(u.searchParams.get('limit') || '30', 10), 1),
          100,
        );
        const batchSize = Math.min(
          Math.max(parseInt(u.searchParams.get('batch_size') || '8', 10), 1),
          20,
        );
        const result = await runFillTranslations(env, limit, batchSize);
        return jsonResponse(result, 200, request, env);
      }
      return jsonResponse({ error: 'Not found' }, 404, request, env);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Internal error';
      return jsonResponse({ error: msg }, 500, request, env);
    }
  },

  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    // Mode rotation on */5 cadence (12 triggers/hour):
    //   :00 :30           → refresh-metrics     (2x/hour)
    //   :15 :45           → fill-translations   (2x/hour)
    //   :10 :50           → detect-longform     (2x/hour, marks note_tweet candidates)
    //   :05 :35           → backfill-replies    (2x/hour, PR-B incremental)
    //   others (4 slots)  → backfill-quotes     (4x/hour, was 6, gave 2 to replies)
    // 2026-04-21: rolled back from fill-heavy. Backlog cleared — only ~0.3%
    // of quote_pending is non-Chinese, so 2/hr sentinel is enough for incoming.
    // 2026-04-29: detect-longform takes :10 :50 to keep up with new note tweets;
    // ~50/hr is enough for incoming. Browser-side fetch happens locally.
    // 2026-05-01: backfill-replies takes :05 :35 — historical 36k bulk runs
    // via local loop; cron is just incremental tail (~100 new replies/day).
    const utc = new Date(event.scheduledTime);
    const minute = utc.getUTCMinutes();
    const hour = utc.getUTCHours();

    // digest 推送节点:UTC 0/4/9 (= BJT 8/12/17),minute=0。独立触发 node-run workflow
    // (不占 X mode rotation);instance id 唯一 = 同节点同天幂等防重复 create。
    const digestSlotBjt =
      minute === 0 ? ({ 0: 8, 4: 12, 9: 17 } as Record<number, number>)[hour] : undefined;
    if (digestSlotBjt !== undefined) {
      ctx.waitUntil(
        env.DIGEST_NODE_RUN_WORKFLOW.create({
          id: `digest-node-${slotKey(digestSlotBjt)}`,
          params: { slotHourBjt: digestSlotBjt },
        })
          .then(() => undefined)
          .catch((e) => console.error('[digest] node-run create fail', e)),
      );
    }

    // X 卡片渲染队列:每 tick drain 2 条(空队列一次 SELECT 秒回,不阻塞主 cron)。
    // 设计 docs/plans/2026-06-05-x-card-ops-render-design.md §3。串行渲染天然符合
    // Codex 并发1/3-5s;低量(爆推/趋势每小时几条),24/h 容量充足。
    ctx.waitUntil(
      runDrainXCardRenders(env, 2)
        .then((res) => { if (res.picked > 0) console.log('[cron] x-card-render drain:', JSON.stringify(res)); })
        .catch((e) => console.error('[cron] x-card-render drain failed:', e)),
    );

    // GitHub trending fetch (phase 1) at BJT 01:00 + 13:00 (= UTC 17:00 + 05:00).
    // 2 subrequests, doesn't conflict with X cron rotation.
    const isGithubFetchSlot = (hour === 17 || hour === 5) && minute === 0;

    // ClawHub list fetch (phase 1) at BJT 04:00 + 16:00 (= UTC 20:00 + 08:00).
    // ~10 subrequests (8 list calls + D1 batch). Doesn't conflict with GH or X.
    const isClawhubFetchSlot = (hour === 20 || hour === 8) && minute === 0;

    // Huodongxing list-fetch state-machine triggers (Phase 3):
    //   起跑：BJT 04:30 + 16:30 (= UTC 20:30 + 08:30) reset KV 进度
    //   接力：之后 7 个 tick (UTC 20:35-21:05 / 08:35-09:05) 接着抓未完成的城市
    //   单 tick budget=40 subreq，节流间隔 2s/page。24 城 × ~5 page ≈ 120 fetch → 3-4 tick 拼齐。
    const isHdxFetchStartSlot = (hour === 20 || hour === 8) && minute === 30;
    const isHdxFetchContinueSlot =
      ((hour === 20 || hour === 8) && minute >= 35) ||
      ((hour === 21 || hour === 9) && minute <= 5);

    // Huodongxing detail-enrich slots: minute=20/50（2 tick/h，1/6 cycle 占用率）
    // 阶段 5 cutover (2026-05-16) 把这里改成 workflow auto-drain：
    //   - 之前是 legacy batch（runHuodongxingDetailEnrich），单 tick batch=3 + 5s 节流
    //   - 阶段 5 改 workflow 后 cutover 漏了 cron 自动 drain，老 backlog 卡 loading
    //   - 2026-05-17 补：cron tick 触发 25 个 pending workflow instance（throttleSec
    //     3s 错开 0/3/6...72s 启动 detail fetch 避免 site WAF），48 tick × 25 = 1200/day
    //     容量，存量 600+ 半天清完，增量 +150/天稳跑赢。
    //   - 治本 marker filter 跟 admin endpoint 共用（30min 窗口内已触发的跳过）
    const isHdxEnrichSlot = minute === 20 || minute === 50;

    // Huodongxing 历史活动 sweep：BJT 03:00 (UTC 19:00)，每日清扫一次
    const isHdxSweepSlot = hour === 19 && minute === 0;

    // X tweets 截断 backfill 兜底（2026-05-17）：workflow step 0 治本但旧
    // workflow instance 已过去；新 ingest 走 workflow step 0，老的 5% truncated
    // 存量靠这个 cron tick 慢慢消化。:15 / :45 (30min cadence)，limit=30 +
    // 400ms rateSleep ≈ 12s + syndication latency 内于 30s wall。
    // 48 tick × 30 = 1440 / day capacity，500 存量 < 1 天清完。
    const isXBackfillTruncatedSlot = minute === 15 || minute === 45;

    // X workflow_completed_at backfill 兜底（2026-05-17 批 4）:批 1 改造之前
    // ingest 的老数据 workflow_completed_at IS NULL,filter 打开后会被筛掉。
    // :10 / :40 (30min cadence) 自动 re-trigger workflow,每 tick 20 条 + 3s
    // throttle = 60s wall + DeepSeek 调用。48 tick × 20 = 960/day capacity,
    // prod 6000+ 老数据 ~7 天 backfill 完。OPS 一次性跑批可走
    // POST /api/enrich/run?mode=backfill-x-workflow&limit=200 加速。
    const isXBackfillWorkflowSlot = minute === 10 || minute === 40;

    // HF Paper backfill 兜底(2026-05-19 Phase 4):
    // :20 / :50 (30min cadence) 扫 stuck items 重 trigger workflow,limit=20 + 3s throttle
    // = ~60s wall。48 tick × 20 = 960/day capacity。HF daily 50/天,容量充足。
    // input-hash idempotency 保证 deep_analysis pro 不重跑(figure / ar5iv / discussion
    // fetch step 仍跑,免费)。OPS 跑批走 /api/enrich/run?mode=backfill-hf-paper-workflow&limit=200
    const isHfBackfillWorkflowSlot = minute === 20 || minute === 50;

    // X thread_root_id 反向重建（2026-05-17 task #34）:2026-05-06 切 ScrapeBadger
    // 后 ingest 不再写 extra.thread_root_id(SB API 不返 thread 关系),导致 prod
    // 5/7 之后 0 条新 thread → FE 详情页 thread 多卡渲染样本空。
    // runReconstructThreads helper 已有(enrich.ts L1126,multi-pass scan
    // self-reply chain 反向填 thread_root_id),每天 1 次跑足够(reconstruct 是
    // backfill 性质,不需实时)。UTC 04:05 = BJT 12:05 中午闲时段。
    const isXReconstructThreadsSlot = hour === 4 && minute === 5;

    // X Article body 抓取 + 翻译兜底(2026-05-25 PR6 follow-up):
    // PR #113/#114 上线后 prod 170 篇候选 article,日 cap 50 限制下需要 ~3-4 天 backfill。
    // 加 cron 自动跑,免人工撑。
    //   :05 (除 hour=4 让 reconstruct) → backfill-x-article-bodies limit=3 ≈ 20-30s wall
    //     288/24 = 12 tick/day,12 × 3 = 36/day,日 cap 50 短路保护
    //   :35 (除 hour=3 cleanup) → backfill-x-article-translations limit=2 ≈ 30s wall
    //     12 tick/day × 2 = 24/day(翻译比抓取慢,每 tick 少点)
    // Cookie 失效 / cap 撞顶 → graceful return,不阻塞别的 cron。
    const isXArticleBodyBackfillSlot = minute === 5 && hour !== 4;
    const isXArticleTranslateBackfillSlot = minute === 35 && hour !== 3;

    // GitHub enrich (phase 2) opportunistic: on any tick where pending exists,
    // preempt this slot for one repo's enrich (~9 subrequests vs running an X
    // mode). Phase-1 is only twice/day, so ≤20 enriches/day to drain → at most
    // 20 X cron slots stolen, ~7% of 288/day.
    // X 主链 classify-pending / fill-translations / backfill-quotes / backfill-replies /
    // detect-longform / longform-via-sb 6 个 cron mode 已迁 CF Workflow（阶段 4 cutover
    // 2026-05-16）。每条新 tweet 由 runListPollIngest 触发 Workflow instance 跑 5 step
    // pipeline。剩下的固定槽位 cron 只跑：list-poll-ingest（拉新）/ refresh-metrics
    // (ScrapeBadger batch metric 刷新) / cleanup / GH+ClawHub fetch / HDX。其余 tick
    // 走 'noop' catch-all（preempt 块 PH/Clawhub/PH-R2 仍跑）。
    let mode: 'refresh-metrics' | 'cleanup' | 'github-fetch' | 'clawhub-fetch' | 'list-poll-ingest' | 'noop';
    if (isGithubFetchSlot) mode = 'github-fetch';
    else if (isClawhubFetchSlot) mode = 'clawhub-fetch';
    else if (hour === 3 && minute === 35) mode = 'cleanup';
    else if (minute === 0 || minute === 30) mode = 'refresh-metrics';
    else if (minute === 25 || minute === 55) mode = 'list-poll-ingest';
    else mode = 'noop';
    const refreshMode = (env.REFRESH_MODE || 'legacy').toLowerCase();
    const maxTier = Math.min(
      Math.max(parseInt(env.REFRESH_TIER_MAX || '1', 10) || 1, 0),
      4,
    );
    ctx.waitUntil(
      (async () => {
        try {
          // ─── PH daily fetch (UTC 10:10-10:14 = 北京 18:10, 1 PT day) ─
          // PT 切日点：PDT 北京 15:00 / PST 北京 16:00。北京 18:10 = PDT
          // 切日后 3h10m / PST 切日后 2h10m，daily_rank 已 settle，全年通吃。
          // 用户体验：北京晚上 6 点就能看到当天 PT 榜（原 04:10 是次日凌晨）。
          // KV sentinel keys on PT date — won't double-fire across 5min window
          // or cross-day retries. Returns early so this tick is dedicated to PH
          // (~50+ detail queries + ingest + snapshot ≈ 110+ subreq).
          if (hour === 10 && minute >= 10 && minute < 15) {
            const r = await recordCronRun(
              env,
              { name: 'ph-daily-fetch', source: 'ph', category: 'fetch' },
              () => runPhDailyFetch(env),
            );
            console.log(`[cron] ph-daily-fetch result:`, JSON.stringify(r));
            await notifyCronSummary(env, 'PH 每日抓取', r as unknown as Record<string, unknown>);
            return;
          }
          // ─── HF Daily Papers fetch (UTC 00:00 = BJT 08:00, 1 BJT day) ───
          // HF Daily 在 UTC 00:00 出新榜,北京 08:00 早上看就有当天 papers。
          // KV sentinel on BJT date — 防 cron 同日重复跑(force=1 admin endpoint 覆盖)。
          // 单次 ~50 details + 1 arxiv batch + 50 ingest + 50 trigger ≈ 110 subreq,
          // 在 paid 1000/invocation cap 内宽松。
          // 8 段 deep_analysis pro reasoning 在 workflow 异步跑,不阻塞 cron tick。
          // Phase 8 通知:result 含 list_size / fetched_details / fetched_categories /
          // ingested / triggered / duration_ms,notifyCronSummary 自动展开成 markdown。
          if (hour === 0 && minute >= 0 && minute < 5) {
            const r = await recordCronRun(
              env,
              { name: 'hf-daily-fetch', source: 'hf', category: 'fetch' },
              () => runHfDailyFetch(env),
            );
            console.log(`[cron] hf-daily-fetch result:`, JSON.stringify(r));
            await notifyCronSummary(env, 'HF Daily Papers 每日抓取', r as unknown as Record<string, unknown>);
            return;
          }
          // ─── Daily warning digest + health checks (UTC 23:00 = BJT 07:00) ─
          // 2026-05-25 告警分级 Phase A:flush KV 攒批 warning,推一次合并日报。
          // 2026-05-27 Phase B:同 tick 跑 daily health checks(翻译失败率 +
          //   X metrics 覆盖率)。同一 cron tick 串行,~5s 总耗时。
          // 早 7 点发,user 起床看,不打扰半夜睡眠。
          // 没 warning + 无 alert 不推(empty 不打扰)。
          if (hour === 23 && minute === 0) {
            const r1 = await recordCronRun(
              env,
              { name: 'warning-digest', source: 'common', category: 'system' },
              () => sendDailyWarningDigest(env),
            );
            console.log(`[cron] warning-digest result:`, JSON.stringify(r1));
            const r2 = await recordCronRun(
              env,
              { name: 'daily-health-checks', source: 'common', category: 'system' },
              () => runDailyHealthChecks(env),
            );
            console.log(`[cron] daily-health-checks result:`, JSON.stringify(r2));
            return;
          }
          // ─── X list-poll-ingest (minute=25 / 55, 30 min cadence) ──
          // ScrapeBadger 替代本地 chrome list 抓取。
          // 提到 preempt 之前：之前在 preempt 之后，fill-translations 等
          // pending 长尾 hijack tick，X 30h+ 没新数据（2026-05-13 实测）。
          // 现在跟 PH daily fetch 同级，:25 / :55 时直接跑 + return。
          if (mode === 'list-poll-ingest') {
            const listId = env.LIST_POLL_LIST_ID || '1643236611378008066';
            const r = await recordCronRun(
              env,
              { name: 'list-poll-ingest', source: 'x', category: 'fetch' },
              () => runListPollIngest(env, listId, 3),
            );
            try {
              await env.DB.prepare(
                `INSERT INTO refresh_log (refreshed_at, tier, items_count, subrequests_used, duration_ms, errors)
                 VALUES (?, 99, ?, ?, ?, ?)`,
              ).bind(
                Math.floor(Date.now() / 1000),
                r.tweets_seen,
                r.credits_used,
                r.duration_ms,
                r.error ? 1 : 0,
              ).run();
            } catch (e) {
              console.error('[list-poll-ingest] log insert failed:', e);
            }
            console.log(`[cron] list-poll-ingest result:`, JSON.stringify(r));
            // M17 收尾：消化 pending_workflow 队列（不阻塞主结果通知）
            try {
              const drainRes = await drainPendingWorkflowQueue(env);
              if (drainRes.drained > 0 || drainRes.remaining > 0) {
                console.log(`[cron] list-poll-ingest drain-pending: drained=${drainRes.drained} remaining=${drainRes.remaining}`);
                // 把 drain 信息合并到通知 payload
                (r as unknown as Record<string, unknown>).pending_drained = drainRes.drained;
                (r as unknown as Record<string, unknown>).pending_remaining = drainRes.remaining;
              }
            } catch (e) {
              console.error('[cron] drain-pending failed:', e);
            }

            // M17 告警信号（除常规 summary 外的额外推送）
            const stopReason = (r as unknown as Record<string, unknown>).stop_reason as string | undefined;
            const newlyInserted = (r as unknown as Record<string, unknown>).newly_inserted as number | undefined;

            // 信号 1：catch-up 触发
            if (typeof newlyInserted === 'number' && newlyInserted > 70) {
              console.log(`[cron] CATCH-UP: newly_inserted=${newlyInserted}, pending=${newlyInserted - 70}`);
              // 单独 push（不打扰常规 summary，但运维要看到）
              try {
                await notifyCronSummary(env, 'X List 补漏触发', {
                  message: `本轮新增 ${newlyInserted} 条（>70），已分流，${newlyInserted - 70} 条进入待加工队列`,
                  newly_inserted: newlyInserted,
                  pending_added: newlyInserted - 70,
                });
              } catch (e) {
                console.error('[notify] catch-up push failed:', e);
              }
            }

            // 信号 2：硬上限触发（10 页都没撞 seen_set）
            if (stopReason === 'hard_max') {
              try {
                await notifyCronSummary(env, 'X List 警告: 翻满硬上限', {
                  message: '翻满 10 页未撞 seen_set。可能 seen_set 全被作者删 / list 突增 / SB 异常。需要人看一眼',
                  list_id: env.LIST_POLL_LIST_ID || '1643236611378008066',
                });
              } catch (e) {
                console.error('[notify] hard-max push failed:', e);
              }
            }

            // 信号 3：连续失败（依赖 KV state，跨 tick 累计）
            // 简化版：每次失败 KV +1，连续 3 次告警，成功清 0
            const FAIL_STREAK_KEY = 'x-list-poll-fail-streak';
            if ((r as unknown as Record<string, unknown>).error) {
              try {
                const cur = parseInt((await env.AUTH_KV.get(FAIL_STREAK_KEY)) || '0', 10);
                const next = cur + 1;
                await env.AUTH_KV.put(FAIL_STREAK_KEY, String(next), { expirationTtl: 86400 });
                if (next >= 3) {
                  await notifyCronSummary(env, 'X List 告警: 连续失败', {
                    message: `连续 ${next} 轮抓取失败，cursor 已停止推进`,
                    last_error: (r as unknown as Record<string, unknown>).error,
                    fail_streak: next,
                  });
                }
              } catch (e) {
                console.error('[notify] fail-streak track failed:', e);
              }
            } else {
              // 成功清 streak
              try { await env.AUTH_KV.delete(FAIL_STREAK_KEY); } catch { /* ignore */ }
            }

            await notifyCronSummary(env, 'X List 抓取', r as unknown as Record<string, unknown>);
            return;
          }
          // ─── Huodongxing scheduling (Phase 3) ─────────────────────────
          //   起跑：BJT 04:30/16:30 reset state，开抓
          //   接力：状态机 KV 有 cities_pending 时继续
          //   enrich：minute=20/50 跑 batch=3 detail（节流后 15-24s 单 tick）
          //   sweep：BJT 03:00 标过期
          if (isHdxFetchStartSlot) {
            const r = await recordCronRun(
              env,
              { name: 'hdx-fetch-start', source: 'hdx', category: 'fetch' },
              () => runHuodongxingFetchList(env, { budget: 40, reset: true }),
            );
            console.log(`[cron] hdx-fetch (start) result:`, JSON.stringify(r));
            await notifyCronSummary(env, '活动行抓取 (start)', r as unknown as Record<string, unknown>);
            return;
          }
          if (isHdxFetchContinueSlot) {
            // 仅当 KV 还有未完成时跑（否则让 X cron 拿这个 slot）
            const progressRaw = await env.AUTH_KV.get('hdx:fetch_progress');
            if (progressRaw) {
              try {
                const p = JSON.parse(progressRaw) as { cities_pending?: string[] };
                if (p.cities_pending && p.cities_pending.length > 0) {
                  const r = await recordCronRun(
                    env,
                    { name: 'hdx-fetch-continue', source: 'hdx', category: 'fetch' },
                    () => runHuodongxingFetchList(env, { budget: 40 }),
                  );
                  console.log(`[cron] hdx-fetch (continue) result:`, JSON.stringify(r));
                  await notifyCronSummary(env, '活动行抓取 (continue)', r as unknown as Record<string, unknown>);
                  return;
                }
              } catch {
                // 解析失败 → 清掉 KV 让下次 start tick 重置
                await env.AUTH_KV.delete('hdx:fetch_progress');
              }
            }
          }
          if (isHdxSweepSlot) {
            const r = await recordCronRun(
              env,
              { name: 'hdx-sweep', source: 'hdx', category: 'cleanup' },
              () => markStaleEventsHistorical(env),
            );
            console.log(`[cron] hdx-sweep result:`, JSON.stringify(r));
            return;
          }
          // 阶段 5 (2026-05-16): huodongxing detail enrich 迁 CF Workflow
          // (HuodongxingDetailWorkflow)。runHuodongxingFetchList 对每条新事件
          // 触发 instance，5s/instance throttleSec 错开避免 site rate limit。
          // 2026-05-17 补：cron auto-drain 处理 cutover 前 backlog + 触发失败的 retry。
          // SQL 跟 admin /api/admin/hdx-trigger-pending-workflows-now 共用（marker
          // 30min 窗口 filter），单 tick limit 25 → 48 tick × 25 = 1200/天 capacity。
          if (isHdxEnrichSlot && env.HUODONGXING_DETAIL_WORKFLOW) {
            const r = await recordCronRun(
              env,
              { name: 'hdx-auto-drain', source: 'hdx', category: 'enrich' },
              () => drainHdxPendingWorkflows(env, 25, 3),
            );
            console.log(`[cron] hdx-auto-drain result:`, JSON.stringify(r));
            return;
          }
          // X tweets 截断 backfill 兜底（2026-05-17）：workflow step 0 治本但旧
          // ingest 漏检的 ~500 条靠这个 cron tick 慢慢消化（也覆盖 workflow trigger 失败的 case）。
          if (isXBackfillTruncatedSlot) {
            const r = await recordCronRun(
              env,
              { name: 'x-backfill-truncated', source: 'x', category: 'backfill' },
              () => runBackfillTruncatedFromSyndication(env, 30, 400),
            );
            console.log(`[cron] x-backfill-truncated result:`, JSON.stringify(r));
            return;
          }
          // X thread_root_id 反向重建（2026-05-17 task #34）:每天 1 次跑
          // runReconstructThreads,从 self-reply chain 反向填 thread_root_id。
          // dryRun=false 真跑,maxPasses=5 覆盖普通 thread 链长。
          if (isXReconstructThreadsSlot) {
            const r = await recordCronRun(
              env,
              { name: 'x-reconstruct-threads', source: 'x', category: 'backfill' },
              () => runReconstructThreads(env, false, 5),
            );
            console.log(`[cron] x-reconstruct-threads result:`, JSON.stringify(r));
            return;
          }
          // X article body 抓取(2026-05-25 PR6 follow-up):
          // :05 每 hour(除 hour=4 让 reconstruct)limit=3 ≈ 20-30s wall。
          // 日 cap 50/天短路:用满后续 tick graceful return,等下次 UTC 0 重置。
          // Cookie 失效 / rate limit → markCookieInvalid + 中断,等 user 通过 admin 面板更新。
          if (isXArticleBodyBackfillSlot) {
            const r = await recordCronRun(
              env,
              { name: 'x-article-body-backfill', source: 'x', category: 'backfill' },
              () => runBackfillXArticleBodies(
                {
                  DB: env.DB,
                  DEEPSEEK_API_KEY: env.DEEPSEEK_API_KEY,
                  AUTH_KV: env.AUTH_KV,
                  PUSHDEER_ADMIN_KEYS: env.PUSHDEER_ADMIN_KEYS,
                  X_GRAPHQL_DAILY_CAP: env.X_GRAPHQL_DAILY_CAP,
                },
                3,
                ctx,
              ),
            );
            console.log(`[cron] x-article-body-backfill result:`, JSON.stringify(r));
            return;
          }
          // X article body 翻译(2026-05-25 PR6 follow-up):
          // :35 每 hour(除 hour=3 cleanup)limit=2 ≈ 30s wall。
          // 单 task 单 DeepSeek call,~15s/task。limit=2 保留 CF edge 30s 余量。
          if (isXArticleTranslateBackfillSlot) {
            const r = await recordCronRun(
              env,
              { name: 'x-article-translate-backfill', source: 'x', category: 'backfill' },
              () => runBackfillXArticleTranslations(env, 2, 200),
            );
            console.log(`[cron] x-article-translate-backfill result:`, JSON.stringify(r));
            return;
          }
          // X workflow backfill 兜底（2026-05-17 批 4）:扫 workflow_completed_at IS NULL
          // 老数据 → re-trigger workflow → 写完整性标记 + 翻译。inline 跟 admin endpoint
          // 同逻辑(/api/enrich/run?mode=backfill-x-workflow)用一份代码不抽 helper。
          if (isXBackfillWorkflowSlot) {
            if (!env.X_TWEET_PIPELINE_WORKFLOW) {
              console.warn('[cron] x-backfill-workflow: X_TWEET_PIPELINE_WORKFLOW binding missing');
              return;
            }
            const r = await recordCronRun(
              env,
              { name: 'x-backfill-workflow', source: 'x', category: 'backfill' },
              async () => {
                const t0 = Date.now();
                // 2026-05-17 加速 + prioritize:
                // - LIMIT 100(原 20)→ 每 30min 100 条 = 4800/day,prod 25k 老数据 ~5 天完成
                // - ORDER BY priority:retweet_pending(0)/ quote_pending(1)/ reply_pending(2)/ 其他(9)
                //   stuck 类型先 backfill,user 体验更快(retweet bug 等问题立即修)
                // - throttle 2s(原 3s)→ 100 条 × 2s = 200s wall + workflow async
                const pending = await env.DB.prepare(
                  `SELECT id, extra FROM items
                    WHERE source_type='x_list'
                      AND deleted_at IS NULL
                      AND json_extract(extra, '$.workflow_completed_at') IS NULL
                      AND (
                        json_extract(extra, '$.workflow_triggered_at') IS NULL
                        OR CAST(json_extract(extra, '$.workflow_triggered_at') AS INTEGER) < strftime('%s','now','-30 minutes')
                      )
                    ORDER BY
                      (CASE
                        WHEN json_extract(extra,'$.is_retweet')=1 AND json_extract(extra,'$.retweet_of') IS NULL THEN 0
                        WHEN json_extract(extra,'$.quote_of_id') IS NOT NULL AND json_extract(extra,'$.quote_of') IS NULL THEN 1
                        WHEN json_extract(extra,'$.reply_to_id') IS NOT NULL AND json_extract(extra,'$.reply_of') IS NULL THEN 2
                        ELSE 9
                      END),
                      published_at DESC
                    LIMIT 100`,
                ).all<{ id: string; extra: string | null }>();
                let triggered = 0;
                let skipped = 0;
                let failed = 0;
                for (let i = 0; i < pending.results.length; i++) {
                  const row = pending.results[i];
                  let extraObj: Record<string, unknown> = {};
                  try { extraObj = JSON.parse(row.extra || '{}') as Record<string, unknown>; } catch { /* ignore */ }
                  const signals = {
                    hasQuoteRef: !!(extraObj.quote_of_id || extraObj.quote_of),
                    hasReplyRef: !!(extraObj.reply_to_id || extraObj.reply_of_id || extraObj.reply_of),
                    hasLinkCard: !!extraObj.link_card,
                    hasRetweetRef: !!(extraObj.is_retweet || extraObj.retweeted_status_id || extraObj.retweet_of_id || extraObj.retweet_of),
                  };
                  const result = await triggerXWorkflowForItem(env, row.id, signals);
                  if (result === 'triggered') triggered++;
                  else if (result === 'already_exists') skipped++;
                  else failed++;
                  // throttle 2s/instance 避免 SB / syndication burst
                  if (i < pending.results.length - 1) {
                    await new Promise((resolve) => setTimeout(resolve, 2000));
                  }
                }
                return {
                  found: pending.results.length,
                  triggered,
                  skipped,
                  failed,
                  elapsed_ms: Date.now() - t0,
                };
              },
            );
            console.log(`[cron] x-backfill-workflow result:`, JSON.stringify(r));
            return;
          }
          // HF Paper backfill 兜底(2026-05-19 Phase 4)
          // :20 / :50 30min cadence 扫 stuck items 重 trigger workflow,
          // input-hash idempotency 保证 deep_analysis pro 不重跑(figure / discussion fetch
          // 仍跑免费),只补缺失。inline 跟 /api/enrich/run?mode=backfill-hf-paper-workflow 一份逻辑
          if (isHfBackfillWorkflowSlot) {
            if (!env.HF_PAPER_PIPELINE_WORKFLOW) {
              console.warn('[cron] hf-backfill-workflow: HF_PAPER_PIPELINE_WORKFLOW binding missing');
              return;
            }
            const r = await recordCronRun(
              env,
              { name: 'hf-backfill-workflow', source: 'hf', category: 'backfill' },
              async () => {
                const t0 = Date.now();
                const pending = await env.DB.prepare(
                  `SELECT id, extra FROM items
                    WHERE source_type='hf_paper'
                      AND deleted_at IS NULL
                      AND json_extract(extra, '$.workflow_completed_at') IS NULL
                      AND (
                        json_extract(extra, '$.workflow_triggered_at') IS NULL
                        OR CAST(json_extract(extra, '$.workflow_triggered_at') AS INTEGER) < strftime('%s','now','-30 minutes')
                      )
                    ORDER BY published_at DESC
                    LIMIT 20`,
                ).all<{ id: string; extra: string | null }>();
                let triggered = 0, skipped = 0, failed = 0;
                for (let i = 0; i < pending.results.length; i++) {
                  const row = pending.results[i];
                  let extraObj: Record<string, unknown> = {};
                  try { extraObj = JSON.parse(row.extra || '{}') as Record<string, unknown>; } catch { /* ignore */ }
                  const arxivId = String(row.id).replace(/^hf_paper:/, '');
                  const result = await triggerHfPaperWorkflowForItem(env, row.id, arxivId, {
                    hasGhRepo: !!extraObj.github_repo,
                    hasProjectPage: !!extraObj.project_page,
                    hasDiscussionId: !!extraObj.discussion_id,
                  });
                  if (result === 'triggered') triggered++;
                  else if (result === 'already_exists') skipped++;
                  else failed++;
                  if (i < pending.results.length - 1) {
                    await new Promise((resolve) => setTimeout(resolve, 3000));
                  }
                }
                return {
                  found: pending.results.length,
                  triggered, skipped, failed,
                  elapsed_ms: Date.now() - t0,
                };
              },
            );
            console.log(`[cron] hf-backfill-workflow result:`, JSON.stringify(r));
            return;
          }
          // 老 batch runHuodongxingDetailEnrich 保留作 admin fallback
          // (/api/admin/hdx-enrich-now)，不在 cron 跑。
          // GH 抓取链已迁 CF Workflow (worker/src/workflows/github-pipeline.ts)。
          // Phase 1 (github-fetch slot) 写 stub 行 + 立刻 create Workflow instance，
          // instance 自己跑 enrich / classify / r2-migrate / readme-translate。
          // 之前的 3 个 preempt 分支 (github-enrich / github-r2-migrate /
          // github-readme-translate) 已移除。设计：docs/plans/2026-05-16-github-pipeline-workflows-design.md
          //
          // 老 pending item 兜底：用 /api/admin/gh-trigger-pending-workflows-now
          // 手动 drain（迁移后一次性即可，未来正常流程不会再产生 pending）。
          // 阶段 6 cutover (2026-05-16): PH 链 (ph-enrich + ph-r2-migrate +
          // fill-translations PH 分支) + CH 链 (clawhub-enrich) 全迁 workflow，
          // 上述 4 个 preempt 块已删。Phase 1 (runPhDailyFetch + runClawhubFetchList)
          // 直接 trigger workflow。老 batch 函数保留作 /api/admin/*-now + /api/enrich/run
          // 兜底用。catch-all (mode !== github-fetch) tick 现在空转，等下次固定槽位
          // (github-fetch / clawhub-fetch / list-poll-ingest / refresh-metrics / cleanup)
          // 触发即可。
          //
          // 唯一保留的「PH 翻译 fallback」: 老 runFillTranslations admin endpoint
          // 仍能跑（/api/admin/fill-translations-now）。
          if (mode === 'github-fetch') {
            const r = await recordCronRun(
              env,
              { name: 'github-fetch', source: 'github', category: 'fetch' },
              () => runGithubFetchTrending(env),
            );
            console.log(`[cron] github-fetch result:`, JSON.stringify(r));
            await notifyCronSummary(env, 'GitHub Trending 抓取', r as unknown as Record<string, unknown>);
            return;
          }
          if (mode === 'clawhub-fetch') {
            const r = await recordCronRun(
              env,
              { name: 'clawhub-fetch', source: 'clawhub', category: 'fetch' },
              () => runClawhubFetchList(env),
            );
            console.log(`[cron] clawhub-fetch result:`, JSON.stringify(r));
            await notifyCronSummary(env, 'ClawHub 列表抓取', r as unknown as Record<string, unknown>);
            return;
          }
          if (mode === 'refresh-metrics') {
            if (refreshMode === 'off') {
              console.log('[cron] refresh-metrics skipped (REFRESH_MODE=off)');
              return;
            }
            const result = await recordCronRun(
              env,
              { name: 'refresh-metrics', source: 'common', category: 'refresh' },
              () =>
                refreshMode === 'tiered'
                  ? runRefreshTiered(env, 20, 400, maxTier)
                  : runRefreshMetrics(env),
            );
            console.log(
              `[cron] refresh-metrics(${refreshMode},maxTier=${maxTier}) result:`,
              JSON.stringify(result),
            );
            return;
          }
          // X 主链 longform-via-sb / detect-longform / backfill-replies /
          // backfill-quotes 4 mode 已迁 Workflow（阶段 4）。catch-all (mode='noop')
          // 让 cron tick 空转 — 等下次 list-poll-ingest / refresh-metrics /
          // cleanup 等固定槽位再触发。老 batch 函数保留作 /api/enrich/run?mode=X
          // 兜底（Bearer INGEST_TOKEN）。
          if (mode === 'cleanup') {
            const result = await recordCronRun(
              env,
              { name: 'cleanup', source: 'common', category: 'cleanup' },
              () => runCleanup(env),
            );
            console.log(`[cron] cleanup result:`, JSON.stringify(result));
          }
        } catch (e) {
          console.error(`[cron] ${mode} error:`, e);
        }
      })(),
    );

    // ─── Ops pool: baseline + detect (并行跑，不阻塞主 mode dispatch) ─
    // baseline 每日 BJT 02:10 (= UTC 18:10) 一次，KV 哨兵防多触发。
    // detect 每 30min (minute=0 / 30) 跟 refresh-metrics 同 tick，独立 waitUntil 不阻塞。
    // 设计：docs/plans/2026-05-21-ops-pool-design.md
    ctx.waitUntil(
      (async () => {
        try {
          if (hour === 18 && minute === 10) {
            const r = await recordCronRun(
              env,
              { name: 'ops-baseline', source: 'common', category: 'system' },
              () => runOpsBaseline(env),
            );
            console.log(`[cron] ops-baseline:`, JSON.stringify(r));
          }
          if (minute === 0 || minute === 30) {
            const r = await recordCronRun(
              env,
              { name: 'ops-detect', source: 'common', category: 'system' },
              () => runOpsDetect(env),
            );
            console.log(`[cron] ops-detect:`, JSON.stringify(r));
          }
        } catch (e) {
          console.error('[cron] ops error:', e);
        }
      })(),
    );
  },
};

// ─── POST /api/ingest ──────────────────────────────────────────

export interface IngestPayload {
  source?: { id?: string; cursor?: string; last_success_at?: string };
  items: ItemInput[];
}

export interface IngestResult {
  inserted: number;
  updated: number;
  errors: { source_id: string; error: string }[];
}

export interface ItemInput {
  source_type: string;
  source_id: string;
  source_ref?: string;
  title?: string;
  content?: string;
  content_translated?: string;
  author?: string;
  handle?: string;
  url?: string;
  media?: unknown;
  metrics?: unknown;
  published_at?: string;
  scraped_at: string;
  is_relevant?: number;
  matched_by?: string;
  lang?: string;
  extra?: unknown;
}

/**
 * Internal ingest entry — DB write logic, callable from worker code (e.g. PH cron)
 * without HTTP self-fetch. No auth check (caller is trusted); HTTP handler
 * still enforces INGEST_TOKEN. Returns counters + per-item errors.
 *
 * Behavior identical to former handleIngest body (verbatim cut/paste, no logic
 * change). GitHub metrics snapshot is included here so source_type='github'
 * callers (whether via HTTP or cron) get consistent treatment.
 */
export async function ingestItems(env: Env, items: ItemInput[]): Promise<IngestResult> {
  if (items.length > 500) {
    throw new Error('Max 500 items per call');
  }

  let inserted = 0;
  const errors: { source_id: string; error: string }[] = [];

  const BATCH_SIZE = 100;
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const stmts: D1PreparedStatement[] = [];

    for (const item of batch) {
      if (!item.source_type || !item.source_id || !item.scraped_at) {
        errors.push({ source_id: item.source_id || 'unknown', error: 'Missing required fields' });
        continue;
      }

      const id = `${item.source_type}:${item.source_id}`;
      stmts.push(
        env.DB.prepare(`
          INSERT INTO items (id, source_type, source_id, source_ref, title, content,
            content_translated, author, handle, url, media, metrics, published_at,
            scraped_at, is_relevant, matched_by, lang, extra)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            content = CASE
              WHEN items.content IS NULL OR length(coalesce(excluded.content, '')) >= length(items.content)
                THEN excluded.content
              ELSE items.content
            END,
            content_translated = CASE
              WHEN items.content IS NULL OR length(coalesce(excluded.content, '')) >= length(items.content)
                THEN excluded.content_translated
              ELSE items.content_translated
            END,
            media = excluded.media,
            metrics = excluded.metrics,
            is_relevant = excluded.is_relevant,
            matched_by = excluded.matched_by,
            -- 2026-05-21 重构:通用 extra 合并,不再 wholesale 覆盖。
            -- 老 ELSE 分支用 excluded.extra 整组替换 → workflow 写入的 enrichment 字段
            -- (PH 的 r2_migrated_at / ai_summary / classified_at / HF 的 deep_analysis /
            -- ar5iv_paragraphs / discussion_comments 等)被下次 daily fetch 擦掉。PR #100 已
            -- 用 app-level merge 给 PH 绕过,这次 SQL 层一次性通用化。
            -- 策略:json_patch(老 extra, strip-null 后的新 extra)
            -- - strip-null:新 ingest 的显式 null 占位(如 PH 的 r2_migrated_at: null /
            --   HF 的 github_stars: null)不会擦老的非 null 值
            -- - shallow:只过 root level 的 null,数组(top_comments[])整组替换 → 元素级保留
            --   仍需 caller app-level merge(如 PH 的 mergePhExtraPreservingEnrichment)
            extra = CASE
              WHEN items.extra IS NULL THEN excluded.extra
              WHEN excluded.extra IS NULL THEN items.extra
              ELSE json_patch(
                items.extra,
                (SELECT coalesce(json_group_object(key, value), '{}')
                   FROM json_each(excluded.extra)
                  WHERE value IS NOT NULL)
              )
            END
        `).bind(
          id,
          item.source_type,
          item.source_id,
          item.source_ref ?? null,
          item.title ?? null,
          item.content ?? null,
          item.content_translated ?? null,
          item.author ?? null,
          item.handle ?? null,
          item.url ?? null,
          typeof item.media === 'string' ? item.media : JSON.stringify(item.media ?? null),
          typeof item.metrics === 'string' ? item.metrics : JSON.stringify(item.metrics ?? null),
          item.published_at ?? null,
          item.scraped_at,
          item.is_relevant ?? null,
          item.matched_by ?? null,
          item.lang ?? null,
          typeof item.extra === 'string' ? item.extra : JSON.stringify(item.extra ?? null),
        )
      );
    }

    if (stmts.length > 0) {
      try {
        const results = await env.DB.batch(stmts);
        for (const r of results) {
          if (r.meta.changes > 0) {
            // D1 doesn't distinguish insert vs update in changes count for upsert
            inserted++;
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'batch error';
        for (const item of batch) {
          errors.push({ source_id: item.source_id, error: msg });
        }
      }
    }

    // GitHub metrics snapshot: append one row per github item per ingest.
    // metrics_snapshots_gh is append-only history (vs items.metrics which holds
    // the current state). Same pattern as X's metrics_snapshots.
    const githubItems = batch.filter(it => it.source_type === 'github');
    if (githubItems.length > 0) {
      const snapStmts: D1PreparedStatement[] = [];
      for (const item of githubItems) {
        const id = `${item.source_type}:${item.source_id}`;
        const m = (typeof item.metrics === 'string'
          ? safeJson(item.metrics)
          : item.metrics) as Record<string, unknown> | null;
        const ex = (typeof item.extra === 'string'
          ? safeJson(item.extra)
          : item.extra) as Record<string, unknown> | null;
        const capturedAt = Math.floor(Date.parse(item.scraped_at) / 1000) || Math.floor(Date.now() / 1000);
        snapStmts.push(
          env.DB.prepare(
            `INSERT INTO metrics_snapshots_gh
               (item_id, captured_at, trending_date_str,
                total_stars, today_stars, forks, watchers, open_issues, open_prs)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            id,
            capturedAt,
            (ex?.trending_date_str as string) ?? null,
            toIntOrNull(m?.stars ?? m?.total_stars),
            toIntOrNull(m?.today_stars),
            toIntOrNull(m?.forks),
            toIntOrNull(m?.watchers),
            toIntOrNull(m?.open_issues),
            toIntOrNull(m?.open_prs),
          ),
        );
      }
      try {
        await env.DB.batch(snapStmts);
      } catch (e) {
        // Don't fail the ingest if snapshot table is missing or full;
        // worker logs only.
        console.error('[ingest] metrics_snapshots_gh insert error:', e);
      }
    }
  }

  // inserted counter includes both inserts and updates (D1 limitation in upsert).
  return { inserted, updated: 0, errors };
}

async function handleIngest(request: Request, env: Env): Promise<Response> {
  // Auth check
  const auth = request.headers.get('Authorization');
  if (!auth || auth !== `Bearer ${env.INGEST_TOKEN}`) {
    return jsonResponse({ error: 'Unauthorized' }, 401, request, env);
  }

  const body = await request.json<IngestPayload>();
  if (!body.items || !Array.isArray(body.items)) {
    return jsonResponse({ error: 'items array required' }, 400, request, env);
  }

  let result: IngestResult;
  try {
    result = await ingestItems(env, body.items);
  } catch (e) {
    return jsonResponse({ error: (e as Error).message }, 400, request, env);
  }

  // Update source cursor if provided (HTTP-only — internal callers don't need this)
  if (body.source?.id) {
    try {
      await env.DB.prepare(`
        INSERT INTO sources (id, source_type, source_ref, cursor, last_success_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          cursor = excluded.cursor,
          last_success_at = excluded.last_success_at
      `).bind(
        body.source.id,
        body.source.id.split(':')[0] || '',
        body.source.id.split(':').slice(1).join(':') || '',
        body.source.cursor ?? null,
        body.source.last_success_at ?? null,
      ).run();
    } catch (e) {
      // Source update failure is not critical
    }
  }

  return jsonResponse(result, 200, request, env);
}

// ─── GET /api/items ────────────────────────────────────────────

async function handleItems(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const sourceType = url.searchParams.get('source_type');
  const since = url.searchParams.get('since');
  const until = url.searchParams.get('until');
  const relevant = url.searchParams.get('relevant') ?? '1';
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
  const cursor = url.searchParams.get('cursor');
  const sortParam = url.searchParams.get('sort');
  const isHot = sortParam === 'hot';
  const sort = sortParam === 'published_at' || isHot ? 'published_at' : 'scraped_at';

  // GitHub feed uses a totally different shape: pick today's AI-relevant
  // non-sponsor rows (latest trending_date_str in DB), order by daily_rank ASC,
  // optionally pin a specific id to the top (share-link strong-insert).
  if (sourceType === 'github') {
    return handleGithubFeed(request, env);
  }
  // ClawHub: marketplace style, order by stars DESC (most popular skills first).
  // hot 模式同样走 stars 排序（marketplace 没有 X 那种 likes/RT 互动信号）。
  if (sourceType === 'clawhub') {
    return handleClawhubFeed(request, env);
  }
  // Product Hunt: 跟 GH 同样的 (launch_date_pt DESC, daily_rank ASC) 排序。
  // 用户期望：日间倒序（最新日子在上）+ 日内排名升序（#1 在 #2 上面）。
  if (sourceType === 'product_hunt') {
    return handlePhFeed(request, env);
  }
  // Huodongxing: 状态优先（进行中 > 未开始 > 已结束）+ start_time ASC（最近发生在前）。
  // 默认 filter 过期活动：status != 'historical' AND end_time > now（兜底 start_time + 1d）。
  // include_historical=1 时取消 filter，用于"历史活动"页面。
  if (sourceType === 'huodongxing') {
    return handleHuodongxingFeed(request, env);
  }
  // Hot score: HN-style engagement with gravity decay so recent items win
  // but older high-engagement items can still bubble up.
  //   score = engagement / (age_hours + 2)^1.5
  // Paired with a 30d soft window (below) to keep the candidate set bounded
  // and let the pool feel rich without scanning the whole table.
  const HOT_EXPR = `(
    (
      COALESCE(CAST(json_extract(metrics, '$.likes') AS INTEGER), 0) +
      2 * COALESCE(CAST(json_extract(metrics, '$.retweets') AS INTEGER), 0) +
      3 * COALESCE(CAST(json_extract(metrics, '$.replies') AS INTEGER), 0)
    ) * 1.0 / POW((julianday('now') - julianday(published_at)) * 24 + 2, 1.5)
  )`;

  const conditions: string[] = [];
  const params: unknown[] = [];

  // Source type filter
  if (sourceType) {
    const types = sourceType.split(',').map(t => t.trim()).filter(Boolean);
    if (types.length === 1) {
      conditions.push('source_type = ?');
      params.push(types[0]);
    } else if (types.length > 1) {
      conditions.push(`source_type IN (${types.map(() => '?').join(',')})`);
      params.push(...types);
    }
  }

  // 通用 workflow 完整性 gate(2026-05-21 重构):所有源都过 workflow_completed_at filter。
  // 老的 X-only gate 已扩展到 PH/GH/CH/HDX/HF 5 个源 + X — 每个 workflow 末尾 mark wc_at
  // (workflows/*-pipeline.ts step "mark-completed"),feed 滤掉 wc_null 的半成品。
  // 历史数据通过 /api/admin/backfill-workflow-completed-now 一次性回填 wc_at = scraped_at。
  if (env.WORKFLOW_COMPLETED_FILTER === 'true') {
    conditions.push("json_extract(extra, '$.workflow_completed_at') IS NOT NULL");
  }

  // Relevance filter
  if (relevant === '1') {
    conditions.push('is_relevant = 1');
  } else if (relevant === '0') {
    conditions.push('is_relevant = 0');
  }

  // Time range
  if (isHot) {
    // Hot mode: 30d window on published_at (gravity decay handles ordering).
    // Wider than 24h so the pool stays rich after the user has seen recent peaks.
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    conditions.push(`published_at >= ?`);
    params.push(thirtyDaysAgo);
  } else {
    if (since) {
      conditions.push(`${sort} >= ?`);
      params.push(since);
    } else if (!cursor) {
      // Default: last 7 days
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      conditions.push(`${sort} >= ?`);
      params.push(sevenDaysAgo);
    }
    if (until) {
      conditions.push(`${sort} <= ?`);
      params.push(until);
    }
  }

  // Cursor pagination. For hot mode cursor is "score|id"; otherwise "time|id".
  if (cursor) {
    const [a, b] = cursor.split('|');
    if (a && b) {
      if (isHot) {
        conditions.push(`(${HOT_EXPR} < ? OR (${HOT_EXPR} = ? AND id < ?))`);
        params.push(parseFloat(a), parseFloat(a), b);
      } else {
        conditions.push(`(${sort} < ? OR (${sort} = ? AND id < ?))`);
        params.push(a, a, b);
      }
    }
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Fetch limit+1 to determine has_more
  // task #8 C 端展示策略：非 hot 模式下，已翻译 item 优先（content_translated IS
  // NOT NULL）。同时间戳内，已翻译靠前。降低用户「刷到一条英文 wait 翻译」体验。
  // hot 模式仍按 engagement score 排（翻译先后跟 hot score 无关）。
  const orderBy = isHot
    ? `${HOT_EXPR} DESC, id DESC`
    : `(content_translated IS NULL) ASC, ${sort} DESC, id DESC`;
  const selectHotScore = isHot ? `, ${HOT_EXPR} AS hot_score` : '';
  const sql = `SELECT *${selectHotScore} FROM items ${where} ORDER BY ${orderBy} LIMIT ?`;
  params.push(limit + 1);

  const start = Date.now();
  const result = await env.DB.prepare(sql).bind(...params).all();
  const queryTime = Date.now() - start;

  const hasMore = result.results.length > limit;
  const items = hasMore ? result.results.slice(0, limit) : result.results;

  // Parse JSON fields for response
  const parsed = items.map(parseItemRow);

  // Build next cursor from last item
  let nextCursor: string | null = null;
  if (hasMore && items.length > 0) {
    const last = items[items.length - 1] as Record<string, unknown>;
    nextCursor = isHot
      ? `${last.hot_score}|${last.id}`
      : `${last[sort]}|${last.id}`;
  }

  // B5: Thread completeness — 对 parsed 里 thread_root_id 非空的 item，
  // 把同 root 的其他楼也带上（即使 scraped_at 在 limit 之外）。这样前端
  // groupByThread 能完整分组成 ThreadCard 渲染 + click 时 siblings 完整。
  // 仅 x_list（其他 source 没 thread）。
  const isXList = !sourceType || sourceType === 'x_list' || sourceType.includes('x_list');
  if (isXList && parsed.length > 0) {
    const seenIds = new Set(parsed.map((p) => p.id as string));
    const threadRoots = new Set<string>();
    for (const item of parsed) {
      const ext = item.extra as { thread_root_id?: string } | null;
      const root = ext?.thread_root_id;
      if (root && !seenIds.has(`x_list:${root}`)) threadRoots.add(root);
      // root 本身已在 seen 时也加（确保根本身能拉同 root 的其他楼）
      else if (root) threadRoots.add(root);
    }
    if (threadRoots.size > 0) {
      const rootsArr = [...threadRoots];
      const rootsPh = rootsArr.map(() => '?').join(',');
      const seenArr = [...seenIds];
      const seenPh = seenArr.map(() => '?').join(',');
      const extraRows = await env.DB.prepare(
        `SELECT * FROM items
         WHERE source_type = 'x_list'
           AND deleted_at IS NULL
           AND extra ->> '$.thread_root_id' IN (${rootsPh})
           AND id NOT IN (${seenPh})
         ORDER BY ${sort} DESC
         LIMIT 200`,
      )
        .bind(...rootsArr, ...seenArr)
        .all();
      for (const r of extraRows.results) {
        parsed.push(parseItemRow(r as Record<string, unknown>));
      }
    }
  }

  return jsonResponse({
    items: parsed,
    next_cursor: nextCursor,
    has_more: hasMore,
    query_time_ms: queryTime,
  }, 200, request, env);
}

function parseItemRow(row: Record<string, unknown>): Record<string, unknown> {
  const parsed = { ...row };
  for (const field of ['media', 'metrics', 'extra']) {
    if (typeof parsed[field] === 'string') {
      try { parsed[field] = JSON.parse(parsed[field] as string); } catch {}
    }
  }
  return parsed;
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

function toIntOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}

// ─── GET /api/items?source_type=clawhub ────────────────────────
// ClawHub feed (marketplace style):
//   - is_relevant=1, deleted_at IS NULL
//   - sort 默认 stars desc；可选 downloads/installs/updated/newest/name
//   - category 默认 all；可选 mcp-tools/prompts/workflows/dev-tools/data/security/automation/other
//     （extra.category 由 phase 1 cron 端按关键词派生，存在 items.extra）
//   - cursor 格式按 sort 维度而异
//   - hide_suspicious 默认 true（fetch 时已过滤，DB 里全是 nonSuspicious 不需要再过滤）

const CLAWHUB_SORT_EXPR: Record<string, string> = {
  stars:     `CAST(json_extract(metrics, '$.stars') AS INTEGER)`,
  downloads: `CAST(json_extract(metrics, '$.downloads') AS INTEGER)`,
  installs:  `CAST(json_extract(metrics, '$.installsCurrent') AS INTEGER)`,
  updated:   `published_at`,
  name:      `LOWER(title)`,
};
const CLAWHUB_SORT_DIR: Record<string, 'DESC' | 'ASC'> = {
  stars: 'DESC', downloads: 'DESC', installs: 'DESC',
  updated: 'DESC', name: 'ASC',
};

async function handleClawhubFeed(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 200);
  const cursor = url.searchParams.get('cursor');
  const sort = (url.searchParams.get('sort') || 'stars').toLowerCase();
  const category = (url.searchParams.get('category') || 'all').toLowerCase();
  const includeSuspicious = url.searchParams.get('include_suspicious') === 'true';

  const sortExpr = CLAWHUB_SORT_EXPR[sort] || CLAWHUB_SORT_EXPR.stars;
  const sortDir = CLAWHUB_SORT_DIR[sort] || 'DESC';

  const conditions: string[] = [
    "source_type='clawhub'",
    'is_relevant=1',
    'deleted_at IS NULL',
  ];
  // 2026-05-21 统一 gate:WORKFLOW_COMPLETED_FILTER 开启时滤掉 wc_at=null 的半成品
  if (env.WORKFLOW_COMPLETED_FILTER === 'true') {
    conditions.push("json_extract(extra, '$.workflow_completed_at') IS NOT NULL");
  }
  const params: unknown[] = [];

  if (category !== 'all') {
    conditions.push(`json_extract(extra, '$.category') = ?`);
    params.push(category);
  }

  // 默认隐藏 suspicious skill（ClawHub 自家 LLM 标记 verdict !== 'benign'）。
  // 前端 toggle 切到「显示全部」时传 ?include_suspicious=true 解除过滤。
  // is_suspicious 字段在 enrich 时被写入 — 还没 enrich 的新 item 视作非 suspicious。
  if (!includeSuspicious) {
    conditions.push(`COALESCE(json_extract(extra, '$.is_suspicious'), 0) = 0`);
  }

  if (cursor) {
    const [valueStr, idStr] = cursor.split('|');
    if (valueStr && idStr) {
      // 按 sort dir 决定 cursor 比较运算符
      const cmpLT = sortDir === 'DESC' ? '<' : '>';
      const cmpGT = sortDir === 'DESC' ? '>' : '<';
      // value 类型按 sort 维度而异：name 是 string，其他是 number / time iso string
      const isNumeric = ['stars', 'downloads', 'installs'].includes(sort);
      const cursorValue = isNumeric ? parseInt(valueStr, 10) : valueStr;
      if (!isNumeric || !Number.isNaN(cursorValue as number)) {
        conditions.push(`(
          ${sortExpr} ${cmpLT} ?
          OR (${sortExpr} = ? AND id ${cmpGT === '>' ? '>' : '>'} ?)
        )`);
        params.push(cursorValue, cursorValue, idStr);
      }
    }
  }

  const where = conditions.join(' AND ');
  const sql = `
    SELECT * FROM items
    WHERE ${where}
    ORDER BY ${sortExpr} ${sortDir}, id ASC
    LIMIT ?
  `;
  params.push(limit + 1);

  const start = Date.now();
  const result = await env.DB.prepare(sql).bind(...params).all();
  const queryTime = Date.now() - start;

  const hasMore = result.results.length > limit;
  const rows = hasMore ? result.results.slice(0, limit) : result.results;
  const items = rows.map(parseItemRow);

  let nextCursor: string | null = null;
  if (hasMore && items.length > 0) {
    const last = items[items.length - 1] as Record<string, unknown>;
    const lastMetrics = last.metrics as Record<string, unknown> | null;
    let cursorValue: string | number = '';
    if (sort === 'stars') cursorValue = (lastMetrics?.stars as number) ?? 0;
    else if (sort === 'downloads') cursorValue = (lastMetrics?.downloads as number) ?? 0;
    else if (sort === 'installs') cursorValue = (lastMetrics?.installsCurrent as number) ?? 0;
    else if (sort === 'updated') cursorValue = (last.published_at as string) ?? '';
    else if (sort === 'name') cursorValue = ((last.title as string) ?? '').toLowerCase();
    nextCursor = `${cursorValue}|${last.id}`;
  }

  return jsonResponse({
    items,
    next_cursor: nextCursor,
    has_more: hasMore,
    query_time_ms: queryTime,
  }, 200, request, env);
}

// ─── GET /api/items?source_type=huodongxing ─────────────────────
// Huodongxing feed:
//   - 默认 filter: status != 'historical' AND (end_time > 今天 BJT 00:00 OR
//                                              (end_time IS NULL AND start_time + 1d > 今天 BJT 00:00))
//     即：今天结束的活动全天可见，BJT 隔天 00:00 才剔除
//     `?include_historical=1` 透传时取消该 filter
//   - 排序: 状态优先（进行中 > 未开始）+ start_time ASC
//   - cursor: 简化用 "start_time|id"（同 X cron-tail 模式，状态分桶通过 derive_state SQL 实现）
//   - v2 query params: city / when / form（FE 列头筛选 chip 用）
//   - when 用"区间重叠"语义：活动期跨过滤区间即命中；start_time IS NULL（detail 未 enrich）
//     的卡片也允许放进结果，等 enrich 后自动归位

/**
 * 当前真实时刻的 BJT ISO 字串（含 +08:00 后缀），用于派生状态判断（进行中/未开始/已结束）。
 * 字典序比较等价于时间比较（所有 huodongxing 入库时间都是 +08:00 格式）。
 */
function bjtNowIso(): string {
  const bjtNow = new Date(Date.now() + 8 * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${bjtNow.getUTCFullYear()}-${pad(bjtNow.getUTCMonth() + 1)}-${pad(bjtNow.getUTCDate())}` +
    `T${pad(bjtNow.getUTCHours())}:${pad(bjtNow.getUTCMinutes())}:${pad(bjtNow.getUTCSeconds())}+08:00`
  );
}

/**
 * 今天 BJT 00:00 的 ISO 字串，用于"按自然日剔除过期活动"边界。
 * 例如 BJT 14日全天 → "2026-05-14T00:00:00+08:00"，14日结束的活动 end_time
 * (如 18:00+08:00) 字典序仍 > 00:00+08:00，全天保留可见；隔天 0:00 后才剔除。
 */
function bjtTodayStartIso(): string {
  const bjtNow = new Date(Date.now() + 8 * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${bjtNow.getUTCFullYear()}-${pad(bjtNow.getUTCMonth() + 1)}-${pad(bjtNow.getUTCDate())}` +
    `T00:00:00+08:00`
  );
}

/**
 * BJT 视角下计算 ISO 字符串区间。返回 [startIso, endIso) 半开区间。
 * 所有 huodongxing 入库的 start_time 都是 "+08:00" 格式（parser-detail.ts 强制），
 * ISO 字符串字典序比较等价于时间比较。
 */
function computeWhenRange(when: string): { startIso: string; endIso: string } | null {
  const nowMs = Date.now();
  // bjtNow: 同时刻的 UTC 视角下 +8h，组件值即 BJT 实际时刻
  const bjtNow = new Date(nowMs + 8 * 3600 * 1000);
  const bjtDay = bjtNow.getUTCDay(); // 0=Sun..6=Sat
  const daysFromMonday = bjtDay === 0 ? 6 : bjtDay - 1;
  const bjtMonday = new Date(bjtNow);
  bjtMonday.setUTCDate(bjtNow.getUTCDate() - daysFromMonday);
  bjtMonday.setUTCHours(0, 0, 0, 0);

  const toBjtIso = (d: Date): string => {
    const pad = (n: number) => String(n).padStart(2, '0');
    return (
      `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
      `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+08:00`
    );
  };

  if (when === 'this') {
    const endBjt = new Date(bjtMonday);
    endBjt.setUTCDate(bjtMonday.getUTCDate() + 7);
    return { startIso: toBjtIso(bjtMonday), endIso: toBjtIso(endBjt) };
  }
  if (when === 'weekend') {
    const startBjt = new Date(bjtMonday);
    startBjt.setUTCDate(bjtMonday.getUTCDate() + 5); // 周六 00:00 BJT
    const endBjt = new Date(bjtMonday);
    endBjt.setUTCDate(bjtMonday.getUTCDate() + 7);   // 下周一 00:00 = 周日 24:00
    return { startIso: toBjtIso(startBjt), endIso: toBjtIso(endBjt) };
  }
  if (when === 'month') {
    const endBjt = new Date(bjtNow);
    endBjt.setUTCDate(bjtNow.getUTCDate() + 30);
    return { startIso: toBjtIso(bjtNow), endIso: toBjtIso(endBjt) };
  }
  return null;
}

async function handleHuodongxingFeed(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 200);
  const cursor = url.searchParams.get('cursor');
  const includeHistorical = url.searchParams.get('include_historical') === '1';
  // BJT 视角的两个时间基准：今天 00:00 用于"按自然日剔除过期"，真实时刻用于派生状态判断
  const todayStartIso = bjtTodayStartIso();
  const nowIso = bjtNowIso();

  // v2 列头筛选：city / when / form 三个 optional query params，AND 组合
  const cityFilter = url.searchParams.get('city') || '';
  const whenFilter = url.searchParams.get('when') || '';
  const formFilter = url.searchParams.get('form') || '';

  const conditions: string[] = [
    "source_type='huodongxing'",
    'is_relevant=1',
    'deleted_at IS NULL',
  ];
  // 2026-05-21 统一 gate
  if (env.WORKFLOW_COMPLETED_FILTER === 'true') {
    conditions.push("json_extract(extra, '$.workflow_completed_at') IS NOT NULL");
  }
  const params: unknown[] = [];

  if (!includeHistorical) {
    // 排除已过期：先排 status='historical'；再用时间兜底（detail 未 enrich 时 status 默认 active）
    // 边界用今天 BJT 00:00，今天结束的活动全天保留可见，BJT 隔天 00:00 后才隐藏
    conditions.push(`COALESCE(json_extract(extra, '$.status'), 'active') != 'historical'`);
    conditions.push(`(
      json_extract(extra, '$.end_time') > ?
      OR (json_extract(extra, '$.end_time') IS NULL
          AND (json_extract(extra, '$.start_time') IS NULL
               OR datetime(json_extract(extra, '$.start_time'), '+1 day') > datetime(?)))
    )`);
    params.push(todayStartIso, todayStartIso);
  }

  // v2 city filter — 严格 equal 匹配 extra.city（24 城市枚举之一）
  if (cityFilter) {
    conditions.push(`json_extract(extra, '$.city') = ?`);
    params.push(cityFilter);
  }

  // v2 when filter — 区间重叠语义：活动期 [start, end] 与过滤区间 [startIso, endIso) 重叠即命中
  // start_time IS NULL（detail 未 enrich）的卡片也放进结果，等 enrich 后自动归位
  if (whenFilter) {
    const range = computeWhenRange(whenFilter);
    if (range) {
      conditions.push(
        `(json_extract(extra, '$.start_time') IS NULL OR json_extract(extra, '$.start_time') < ?)`,
      );
      conditions.push(
        `(json_extract(extra, '$.end_time') IS NULL OR json_extract(extra, '$.end_time') >= ?)`,
      );
      params.push(range.endIso, range.startIso);
    }
  }

  // v2 form filter — online: is_online=true；offline: false 或 null（detail 未 enrich 时按 listing 字段判断也成立）
  if (formFilter === 'online') {
    conditions.push(`json_extract(extra, '$.is_online') = 1`);
  } else if (formFilter === 'offline') {
    conditions.push(`(json_extract(extra, '$.is_online') = 0 OR json_extract(extra, '$.is_online') IS NULL)`);
  }

  // 派生状态：0=进行中, 1=未开始, 2=已结束（用作 ORDER BY 主键）
  const derivedState = `
    CASE
      WHEN json_extract(extra, '$.start_time') IS NOT NULL
           AND json_extract(extra, '$.start_time') <= ?
           AND (json_extract(extra, '$.end_time') IS NULL
                OR json_extract(extra, '$.end_time') > ?)
        THEN 0
      WHEN json_extract(extra, '$.start_time') IS NULL
           OR json_extract(extra, '$.start_time') > ?
        THEN 1
      ELSE 2
    END
  `;

  if (cursor) {
    // cursor: "<state>|<start_time>|<id>"
    const [stateStr, startStr, idStr] = cursor.split('|');
    const state = parseInt(stateStr, 10);
    if (!Number.isNaN(state) && idStr) {
      conditions.push(`(
        (${derivedState}) > ?
        OR ((${derivedState}) = ? AND (
          COALESCE(json_extract(extra, '$.start_time'), '9999') > ?
          OR (COALESCE(json_extract(extra, '$.start_time'), '9999') = ? AND id > ?)
        ))
      )`);
      params.push(nowIso, nowIso, nowIso, state, nowIso, nowIso, nowIso, state, startStr, startStr, idStr);
    }
  }

  const where = conditions.join(' AND ');
  const sql = `
    SELECT *,
      (${derivedState}) AS _state
      FROM items
     WHERE ${where}
     ORDER BY _state ASC,
              COALESCE(json_extract(extra, '$.start_time'), '9999') ASC,
              id ASC
     LIMIT ?
  `;
  // ORDER BY 里再次引用 derivedState 时需要再 bind 3 个 now（_state 那次也要）
  const orderParams = [nowIso, nowIso, nowIso];
  const finalParams = [...orderParams, ...params, limit + 1];

  const start = Date.now();
  const result = await env.DB.prepare(sql).bind(...finalParams).all();
  const queryTime = Date.now() - start;

  const hasMore = result.results.length > limit;
  const rows = hasMore ? result.results.slice(0, limit) : result.results;
  const items = rows.map(parseItemRow);

  let nextCursor: string | null = null;
  if (hasMore && items.length > 0) {
    const last = items[items.length - 1] as Record<string, unknown>;
    const lastRaw = rows[rows.length - 1] as Record<string, unknown>;
    const lastExtra = last.extra as Record<string, unknown> | null;
    const lastState = lastRaw._state ?? 9;
    const lastStart =
      lastExtra && typeof lastExtra === 'object'
        ? (lastExtra.start_time as string | undefined) ?? ''
        : '';
    nextCursor = `${lastState}|${lastStart}|${last.id}`;
  }

  return jsonResponse({
    items,
    next_cursor: nextCursor,
    has_more: hasMore,
    query_time_ms: queryTime,
  }, 200, request, env);
}

// ─── GET /api/items?source_type=github ─────────────────────────
// GitHub feed (cross-day):
//   - is_relevant=1 AND extra.sponsor=0 (admin-only sponsors not in feed)
//   - ORDER BY trending_date_str DESC, daily_rank ASC, id ASC
//     (newest day first; within day, top-rank repos by today_stars first)
//   - optional ?pinned=gh:owner/repo to bubble a shared link to the top
//   - cursor: "trending_date|rank|id" for cross-day pagination
async function handleGithubFeed(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 200);
  const cursor = url.searchParams.get('cursor');
  const pinned = url.searchParams.get('pinned');

  const conditions: string[] = [
    "source_type='github'",
    'is_relevant=1',
    "COALESCE(CAST(json_extract(extra, '$.sponsor') AS INTEGER), 0) = 0",
    'deleted_at IS NULL',
  ];
  // 2026-05-21 统一 gate
  if (env.WORKFLOW_COMPLETED_FILTER === 'true') {
    conditions.push("json_extract(extra, '$.workflow_completed_at') IS NOT NULL");
  }
  const params: unknown[] = [];

  if (cursor) {
    const [dateStr, rankStr, idStr] = cursor.split('|');
    const rank = parseInt(rankStr, 10);
    if (dateStr && !Number.isNaN(rank) && idStr) {
      // Lexicographic on (date DESC, rank ASC, id ASC):
      //   date < cursor.date
      //   OR (date = cursor.date AND (rank > cursor.rank
      //                                OR (rank = cursor.rank AND id > cursor.id)))
      conditions.push(`(
        json_extract(extra, '$.trending_date_str') < ?
        OR (
          json_extract(extra, '$.trending_date_str') = ?
          AND (
            CAST(json_extract(extra, '$.daily_rank') AS INTEGER) > ?
            OR (CAST(json_extract(extra, '$.daily_rank') AS INTEGER) = ? AND id > ?)
          )
        )
      )`);
      params.push(dateStr, dateStr, rank, rank, idStr);
    }
  }

  const where = conditions.join(' AND ');
  // Pinned: bubble id to the top regardless of date/rank (share-link strong-insert).
  const pinExpr = pinned ? `(CASE WHEN id = ? THEN 0 ELSE 1 END), ` : '';
  if (pinned) params.unshift(pinned);

  const sql = `
    SELECT * FROM items
    WHERE ${where}
    ORDER BY ${pinExpr}
             json_extract(extra, '$.trending_date_str') DESC,
             CAST(json_extract(extra, '$.daily_rank') AS INTEGER) ASC,
             id ASC
    LIMIT ?
  `;
  params.push(limit + 1);

  const start = Date.now();
  const result = await env.DB.prepare(sql).bind(...params).all();
  const queryTime = Date.now() - start;

  const hasMore = result.results.length > limit;
  const rows = hasMore ? result.results.slice(0, limit) : result.results;
  const items = rows.map(parseItemRow);

  let nextCursor: string | null = null;
  if (hasMore && items.length > 0) {
    const last = items[items.length - 1] as Record<string, unknown>;
    const lastExtra = last.extra as Record<string, unknown> | null;
    const lastDate = lastExtra && typeof lastExtra === 'object' ? lastExtra.trending_date_str : null;
    const lastRank = lastExtra && typeof lastExtra === 'object' ? lastExtra.daily_rank : null;
    nextCursor = `${lastDate ?? ''}|${lastRank ?? 'null'}|${last.id}`;
  }

  return jsonResponse({
    items,
    next_cursor: nextCursor,
    has_more: hasMore,
    query_time_ms: queryTime,
  }, 200, request, env);
}

// ─── Product Hunt feed ────────────────────────────────────────
// 仿 GH feed 的 (date DESC, daily_rank ASC) 模式：
//   - SELECT source_type='product_hunt' AND is_relevant=1 AND deleted_at IS NULL
//   - ORDER BY launch_date_pt DESC, daily_rank ASC, id ASC
//   - optional ?pinned=product_hunt:<id> to bubble a shared link to the top
//   - cursor: "launch_date|rank|id" for cross-day pagination
//
// display_rank: SQL ROW_NUMBER 子查询给同日内连续编号 1,2,3...N。
// 用：PH dailyRank 实测有重复值 + 跳号（4,4 / 5,5 / 6→8→7→14...），原因
// 不明但前端要看到连续 1,2,3 序号。前端用 extra.display_rank 显示，daily_rank
// 仍保留供调试。子查询不带 cursor 过滤，cursor 应用在外层不影响 ROW_NUMBER。
async function handlePhFeed(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 200);
  const cursor = url.searchParams.get('cursor');
  const pinned = url.searchParams.get('pinned');

  const cursorConditions: string[] = [];
  const params: unknown[] = [];

  if (cursor) {
    const [dateStr, rankStr, idStr] = cursor.split('|');
    const rank = parseInt(rankStr, 10);
    if (dateStr && !Number.isNaN(rank) && idStr) {
      // Lexicographic cursor on (date DESC, daily_rank ASC, id ASC) — 用
      // sub-query 的 launch_date_pt / daily_rank / id 列名:
      cursorConditions.push(`(
        launch_date_pt < ?
        OR (
          launch_date_pt = ?
          AND (
            daily_rank_int > ?
            OR (daily_rank_int = ? AND id > ?)
          )
        )
      )`);
      params.push(dateStr, dateStr, rank, rank, idStr);
    }
  }

  const cursorWhere = cursorConditions.length > 0 ? `WHERE ${cursorConditions.join(' AND ')}` : '';
  const pinExpr = pinned ? `(CASE WHEN id = ? THEN 0 ELSE 1 END), ` : '';
  if (pinned) params.unshift(pinned);

  // 子查询给每行打 display_rank（同日内连续编号，绕过 PH dailyRank 跳号）。
  // 子查询不带 cursor 过滤，否则 ROW_NUMBER 会被分页边界破坏（同日跨页时从 1 重启）。
  // 2026-05-21 加 wc_at gate(在子查询内,确保 display_rank 计算只对完整 item)
  const wcGate = env.WORKFLOW_COMPLETED_FILTER === 'true'
    ? "AND json_extract(items.extra, '$.workflow_completed_at') IS NOT NULL"
    : '';
  const sql = `
    SELECT * FROM (
      SELECT
        items.*,
        json_extract(items.extra, '$.launch_date_pt') AS launch_date_pt,
        CAST(json_extract(items.extra, '$.daily_rank') AS INTEGER) AS daily_rank_int,
        ROW_NUMBER() OVER (
          PARTITION BY json_extract(items.extra, '$.launch_date_pt')
          ORDER BY
            CAST(json_extract(items.extra, '$.daily_rank') AS INTEGER) ASC,
            items.id ASC
        ) AS display_rank
      FROM items
      WHERE source_type = 'product_hunt'
        AND is_relevant = 1
        AND deleted_at IS NULL
        ${wcGate}
    ) sub
    ${cursorWhere}
    ORDER BY ${pinExpr}
             launch_date_pt DESC,
             display_rank ASC
    LIMIT ?
  `;
  params.push(limit + 1);

  const start = Date.now();
  const result = await env.DB.prepare(sql).bind(...params).all();
  const queryTime = Date.now() - start;

  const hasMore = result.results.length > limit;
  const rows = hasMore ? result.results.slice(0, limit) : result.results;
  const items = rows.map((row) => {
    const item = parseItemRow(row);
    // 把 display_rank 从 row 顶层字段塞到 extra 里供前端用
    const displayRank = (row as Record<string, unknown>).display_rank;
    if (displayRank !== null && displayRank !== undefined && item.extra && typeof item.extra === 'object') {
      (item.extra as Record<string, unknown>).display_rank = displayRank;
    }
    return item;
  });

  let nextCursor: string | null = null;
  if (hasMore && items.length > 0) {
    const last = items[items.length - 1] as Record<string, unknown>;
    const lastExtra = last.extra as Record<string, unknown> | null;
    const lastDate = lastExtra && typeof lastExtra === 'object' ? lastExtra.launch_date_pt : null;
    const lastRank = lastExtra && typeof lastExtra === 'object' ? lastExtra.daily_rank : null;
    nextCursor = `${lastDate ?? ''}|${lastRank ?? 'null'}|${last.id}`;
  }

  return jsonResponse({
    items,
    next_cursor: nextCursor,
    has_more: hasMore,
    query_time_ms: queryTime,
  }, 200, request, env);
}

// ─── POST /api/items/:id/refresh ──────────────────────────────
// Drawer 打开时 dashboard 主动调，触发 on-demand enrich（X 走 syndication）。
// KV throttle 5min；返回 { refreshed, source_type, reason, metrics? }，
// dashboard 拿到 refreshed=true 后重新 fetchItem 拿最新数据更新 UI。

async function handleItemRefresh(request: Request, env: Env, id: string): Promise<Response> {
  // 不需要登录：刷新公开 metrics 不涉及私密数据
  // 节流：worker 内部 KV throttle 5min；前端调用时 anti-burst 自己也加防抖
  // 触发源区分: ?trigger=impression (FE feed 卡曝光弱触发) 才走 feature flag 开关.
  // drawer 打开 / 海报触发 不带 trigger param, 不受 flag 影响 (这俩是 user-initiated
  // 强需求, 不该跟 ScrapeBadger 计费保护混在一起 mute).
  const url = new URL(request.url);
  const trigger = url.searchParams.get('trigger');

  // 2026-05-28 结构化 log:观察 impression vs drawer/share 调用比例 + throttle/disabled 比率
  // Workers Logs 可 grep:`evt=item_refresh trigger=impression reason=throttled` 等
  const logEvt = (reason: string, refreshed: boolean, sourceType: string): void => {
    console.log(JSON.stringify({
      evt: 'item_refresh',
      trigger: trigger || 'direct',  // 'impression' / 'direct'(drawer/share/manual)
      item_id: id,
      refreshed,
      reason,
      source_type: sourceType,
    }));
  };

  if (trigger === 'impression') {
    const { isFlagOn } = await import('./feature-flags');
    if (!(await isFlagOn(env, 'impression_refresh'))) {
      logEvt('disabled', false, 'unknown');
      return jsonResponse(
        { refreshed: false, source_type: 'unknown', reason: 'disabled' },
        200,
        request,
        env,
      );
    }
  }
  const r = await refreshSingleItem(env, id);
  logEvt(r.reason || 'no_reason', r.refreshed, r.source_type);
  return jsonResponse(r, 200, request, env);
}

// ─── POST /api/items/:id/refresh-hf-discussion ───────────────────
// hf_paper drawer 打开时 FE 第二个并发调用,5-10s wall-clock,FE 端 timeoutMs 15s。
// 跑:fetchDiscussionForHfPaper → mirrorCommentImagesForHfPaper → translateDiscussionCommentsForHfPaper
// 独立 KV throttle key(`hf-disc-refresh:<id>`)5min,跟通用 /refresh 不冲突。
const HF_DISC_REFRESH_THROTTLE_KEY = 'hf-disc-refresh:';
const HF_DISC_REFRESH_THROTTLE_TTL = 300;             // 5min

// Reconcile metrics.num_comments → extra.discussion_comments.length。
// 用于 throttle 命中时也能修正老数据 stale 状态(2026-05-20 FE 反馈:
// 抽屉显示评论 2 条但外卡片 1 条)。读 1 行 + 可能写 1 行,几 ms。
async function reconcileHfCommentsMetric(
  env: Env,
  id: string,
): Promise<{ changed: boolean; before: number | null; after: number | null }> {
  const row = await env.DB.prepare(
    `SELECT extra, metrics FROM items WHERE id = ?`,
  ).bind(id).first<{ extra: string | null; metrics: string | null }>();
  if (!row) return { changed: false, before: null, after: null };

  const extra = row.extra ? JSON.parse(row.extra) as { discussion_comments?: unknown[] } : {};
  const metrics = row.metrics ? JSON.parse(row.metrics) as { num_comments?: number } : {};

  const actual = Array.isArray(extra.discussion_comments) ? extra.discussion_comments.length : null;
  const stored = typeof metrics.num_comments === 'number' ? metrics.num_comments : null;

  // 没拉过 discussion 时 actual 是 null → 不强写(保留 HF API 给的 stored)
  if (actual === null) return { changed: false, before: stored, after: stored };
  if (stored === actual) return { changed: false, before: stored, after: stored };

  await env.DB.prepare(
    `UPDATE items SET metrics = json_set(coalesce(metrics, '{}'), '$.num_comments', ?) WHERE id = ?`,
  ).bind(actual, id).run();
  console.log(`[hf-disc-reconcile] ${id} num_comments ${stored} → ${actual}`);
  return { changed: true, before: stored, after: actual };
}

async function handleHfDiscussionRefresh(request: Request, env: Env, id: string): Promise<Response> {
  // 1. 校验 item + source_type
  const item = await env.DB.prepare(
    `SELECT id, source_type, source_id FROM items WHERE id = ?`,
  ).bind(id).first<{ id: string; source_type: string; source_id: string }>();
  if (!item) {
    return jsonResponse({ refreshed: false, reason: 'item_not_found' }, 404, request, env);
  }
  if (item.source_type !== 'hf_paper') {
    return jsonResponse({ refreshed: false, reason: 'unsupported_source' }, 400, request, env);
  }

  // 2. KV 5min throttle — 命中 throttle 时也跑一次轻量 reconcile,把
  //    metrics.num_comments 对齐到 extra.discussion_comments.length。
  //    背景:2026-05-20 BE 改 fetchDiscussionForHfPaper 同步 metrics 前,
  //    存量数据 metrics.num_comments 可能跟实际拉到的评论数不一致(HF
  //    daily papers API 不算 librarian-bot 等)。新版 fetch 会同步,但
  //    KV throttle 命中时不跑 fetch,老数据就一直 stale。这里加 reconcile
  //    确保老数据也能自愈。读 1 行 + 可能写 1 行,几 ms 开销可忽略。
  if (env.AUTH_KV) {
    const tKey = HF_DISC_REFRESH_THROTTLE_KEY + id;
    const last = await env.AUTH_KV.get(tKey);
    if (last) {
      const reconciled = await reconcileHfCommentsMetric(env, id);
      return jsonResponse(
        { refreshed: false, reason: 'throttled', reconciled },
        200, request, env,
      );
    }
  }

  // 3. discussion fetch + 评论 <img> R2 mirror + 翻译
  const arxivId = String(item.source_id);
  let commentsCount = 0;
  let translated = 0;
  let imagesMirrored = 0;
  try {
    const { fetchDiscussionForHfPaper, mirrorCommentImagesForHfPaper, translateDiscussionCommentsForHfPaper } =
      await import('./hf-paper/discussion');
    const dResult = await fetchDiscussionForHfPaper(env as Parameters<typeof fetchDiscussionForHfPaper>[0], id, arxivId);
    commentsCount = dResult.comments_count;
    if (dResult.fetched && commentsCount > 0) {
      const mResult = await mirrorCommentImagesForHfPaper(env as Parameters<typeof mirrorCommentImagesForHfPaper>[0], id);
      imagesMirrored = mResult.mirrored;
      const tResult = await translateDiscussionCommentsForHfPaper(env as Parameters<typeof translateDiscussionCommentsForHfPaper>[0], id);
      translated = tResult.translated;
    }
  } catch (e) {
    console.error(`[hf-disc-refresh] ${id} exception`, e);
    return jsonResponse(
      { refreshed: false, reason: 'fetch_failed', error: (e as Error).message.slice(0, 200) },
      500, request, env,
    );
  }

  if (env.AUTH_KV) {
    await env.AUTH_KV.put(HF_DISC_REFRESH_THROTTLE_KEY + id, String(Date.now()), {
      expirationTtl: HF_DISC_REFRESH_THROTTLE_TTL,
    });
  }

  return jsonResponse({
    refreshed: true,
    source_type: 'hf_paper',
    comments_count: commentsCount,
    translated_count: translated,
    images_mirrored: imagesMirrored,
  }, 200, request, env);
}

// ─── POST /api/items/:id/translate-now ────────────────────────
// 2026-05-17 批 1.5:用户点译文按钮 / 抽屉里的字段是 NULL 时,触发即时翻译。
// 走 cookie auth(同 /api/share/create 模式) + per-user-per-item 60s 冷却 +
// per-user 每日 20 次上限(KV-based,跟 REFRESH_THROTTLE 同模式)。
// 单条调 classifyAndTranslateForXTweet(批 1 合并调用函数),走完所有字段翻译 +
// 写回 D1 + 返回 JSON 给 FE 实时刷新。
//
// 错误码契约(plan 第九节 ④):
// - 200: 成功(或字段已有译文,直接读 D1 返回)
// - 401: cookie session 未登录
// - 404: item 不存在
// - 400: 不支持的 source_type(只支持 x_list)
// - 429: 限流(60s 冷却 / 每日 >20 次)
// - 5xx: 翻译失败

const TRANSLATE_NOW_THROTTLE_KEY = 'translate-now-throttle';
const TRANSLATE_NOW_THROTTLE_TTL = 60; // 60s per user per item
const TRANSLATE_NOW_DAILY_KEY = 'translate-now-daily';
const TRANSLATE_NOW_DAILY_CAP = 20;
const TRANSLATE_NOW_DAILY_TTL = 86400;

async function handleItemTranslateNow(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  id: string,
): Promise<Response> {
  // 1. cookie auth
  const auth = await authenticate(request, env, ctx);
  if (auth.kind !== 'authenticated') {
    return jsonResponse({ error: 'unauthorized' }, 401, request, env);
  }

  // 2. per-user-per-item 60s 冷却
  const throttleKey = `${TRANSLATE_NOW_THROTTLE_KEY}:${auth.userId}:${id}`;
  if (env.AUTH_KV) {
    const throttled = await env.AUTH_KV.get(throttleKey);
    if (throttled) {
      return jsonResponse(
        { error: 'rate_limited', retry_after_sec: TRANSLATE_NOW_THROTTLE_TTL },
        429,
        request,
        env,
      );
    }
  }

  // 3. per-user 每日 20 次上限
  const today = new Date().toISOString().slice(0, 10);
  const dailyKey = `${TRANSLATE_NOW_DAILY_KEY}:${auth.userId}:${today}`;
  let dailyCount = 0;
  if (env.AUTH_KV) {
    const dailyRaw = await env.AUTH_KV.get(dailyKey);
    dailyCount = parseInt(dailyRaw || '0', 10);
    if (dailyCount >= TRANSLATE_NOW_DAILY_CAP) {
      return jsonResponse(
        { error: 'daily_cap_exceeded', cap: TRANSLATE_NOW_DAILY_CAP, used: dailyCount },
        429,
        request,
        env,
      );
    }
  }

  // 4. 校验 item 存在 + 只支持 X
  const item = await env.DB.prepare(
    `SELECT id, source_type FROM items WHERE id = ? AND deleted_at IS NULL`,
  ).bind(id).first<{ id: string; source_type: string }>();
  if (!item) return jsonResponse({ error: 'not_found' }, 404, request, env);
  if (item.source_type !== 'x_list') {
    return jsonResponse(
      { error: 'unsupported_source', source_type: item.source_type },
      400,
      request,
      env,
    );
  }

  // 5. 调合并函数(批 1 已落) — 失败函数内 retry 1 次,仍失败标 translation_failed_at + 返回 failed 字段(不 throw)
  let result;
  try {
    result = await classifyAndTranslateForXTweet(env, id, { lang: 'zh' });
  } catch (err) {
    console.error(`[translate-now] ${id} ${auth.userId}: exception`, err);
    return jsonResponse({ error: 'translation_failed', detail: String(err) }, 500, request, env);
  }
  // 5b. 函数 graceful 失败(返回 failed 字段非 throw):按 plan 第九节 ④ 错误码契约返 5xx
  // FE 收到 5xx 即可统一走"翻译失败"分支(toast + 按钮恢复重试),不需要看 result_summary.failed
  if (result.failed) {
    console.warn(`[translate-now] ${id} ${auth.userId}: graceful failure reason=${result.failed} attempts=${result.attempts}`);
    return jsonResponse(
      { error: 'translation_failed', reason: result.failed, attempts: result.attempts },
      503,
      request,
      env,
    );
  }

  // 6. 写 throttle markers(成功后才写,失败不计 quota)
  if (env.AUTH_KV) {
    await env.AUTH_KV.put(throttleKey, '1', { expirationTtl: TRANSLATE_NOW_THROTTLE_TTL });
    await env.AUTH_KV.put(dailyKey, String(dailyCount + 1), { expirationTtl: TRANSLATE_NOW_DAILY_TTL });
  }

  // 7. SELECT 翻译后的字段返回(FE 直接拿值刷新流卡 + 抽屉)
  const row = await env.DB.prepare(
    `SELECT content_translated, extra, translated_at FROM items WHERE id = ?`,
  ).bind(id).first<{ content_translated: string | null; extra: string | null; translated_at: number | null }>();

  const extra: Record<string, unknown> = row?.extra ? (JSON.parse(row.extra) as Record<string, unknown>) : {};
  const qo = extra.quote_of as { content_translated?: string } | undefined;
  const ro = extra.reply_of as { content_translated?: string } | undefined;
  const rto = extra.retweet_of as { content_translated?: string } | undefined;
  const lc = extra.link_card as { title_translated?: string; description_translated?: string } | undefined;

  return jsonResponse(
    {
      content_zh: row?.content_translated || null,
      quote_of_zh: qo?.content_translated || null,
      reply_of_zh: ro?.content_translated || null,
      retweet_of_zh: rto?.content_translated || null,
      link_card_title_zh: lc?.title_translated || null,
      link_card_desc_zh: lc?.description_translated || null,
      translated_at: row?.translated_at ? new Date(row.translated_at * 1000).toISOString() : null,
      result_summary: {
        is_relevant: result.is_relevant,
        fields_translated: result.fields_translated,
        attempts: result.attempts,
        failed: result.failed,
      },
    },
    200,
    request,
    env,
  );
}

// ─── GET /api/items/:id ────────────────────────────────────────
// :id is the composite primary key `${source_type}:${source_id}`.
// Returns { item, siblings } where siblings are thread members
// (same extra.thread_root_id, ordered by published_at ASC) if any.

async function handleItemById(request: Request, env: Env, id: string): Promise<Response> {
  const item = await env.DB.prepare(
    'SELECT * FROM items WHERE id = ?'
  ).bind(id).first<Record<string, unknown>>();

  if (!item) {
    return jsonResponse({ error: 'not_found' }, 404, request, env);
  }

  const parsedItem = parseItemRow(item);
  const extra = parsedItem.extra as { thread_root_id?: string } | null | undefined;
  const threadRootId = extra && typeof extra === 'object' ? extra.thread_root_id : undefined;

  // 2026-05-17 重构:thread members 上限保护(覆盖 99% thread)。超 50 标 has_more flag,
  // FE 可显示「以下推文已截断」提示。不做 lazy load(产品低优先级)。
  let siblings: Record<string, unknown>[] = [];
  let siblingsHasMore = false;
  if (threadRootId) {
    const SIBLINGS_MAX = 50;
    const result = await env.DB.prepare(
      `SELECT * FROM items
       WHERE source_type = ?
         AND extra ->> '$.thread_root_id' = ?
       ORDER BY published_at ASC, id ASC
       LIMIT ?`
    ).bind(parsedItem.source_type, threadRootId, SIBLINGS_MAX + 1).all();
    siblingsHasMore = result.results.length > SIBLINGS_MAX;
    siblings = result.results.slice(0, SIBLINGS_MAX).map(parseItemRow);
  }

  // For GitHub / ClawHub items, attach metrics_history (last 30 days) so drawer can
  // render a sparkline (v2). Cheap query, ~20-60 rows per repo.
  let metricsHistory: Record<string, unknown>[] = [];
  if (parsedItem.source_type === 'github') {
    try {
      const thirtyDaysAgoUnix = Math.floor(Date.now() / 1000) - 30 * 86400;
      const histResult = await env.DB.prepare(
        `SELECT captured_at, trending_date_str,
                total_stars, today_stars, forks, watchers, open_issues, open_prs
           FROM metrics_snapshots_gh
          WHERE item_id = ? AND captured_at >= ?
       ORDER BY captured_at ASC`
      ).bind(id, thirtyDaysAgoUnix).all();
      metricsHistory = histResult.results;
    } catch (e) {
      // Table may not exist yet pre-migration — silently empty.
    }
  } else if (parsedItem.source_type === 'clawhub') {
    try {
      const thirtyDaysAgoUnix = Math.floor(Date.now() / 1000) - 30 * 86400;
      const histResult = await env.DB.prepare(
        `SELECT captured_at, stars, downloads, installs_current, installs_all_time
           FROM metrics_snapshots_clawhub
          WHERE item_id = ? AND captured_at >= ?
       ORDER BY captured_at ASC`
      ).bind(id, thirtyDaysAgoUnix).all();
      metricsHistory = histResult.results;
    } catch (e) {
      // ignore
    }
  }

  return jsonResponse({
    item: parsedItem,
    siblings,
    siblings_has_more: siblingsHasMore,
    metrics_history: metricsHistory,
  }, 200, request, env);
}

// ─── GET /api/sources ──────────────────────────────────────────

async function handleSources(request: Request, env: Env): Promise<Response> {
  const sources = await env.DB.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM items WHERE source_type = s.source_type
       AND source_ref = s.source_ref AND is_relevant = 1) as item_count
    FROM sources s
    ORDER BY s.last_success_at DESC
  `).all();

  return jsonResponse({ sources: sources.results }, 200, request, env);
}

// ─── GET /api/stats ────────────────────────────────────────────

async function handleStats(request: Request, env: Env): Promise<Response> {
  const total = await env.DB.prepare(
    'SELECT COUNT(*) as count FROM items'
  ).first<{ count: number }>();

  const relevant = await env.DB.prepare(
    'SELECT COUNT(*) as count FROM items WHERE is_relevant = 1'
  ).first<{ count: number }>();

  const bySource = await env.DB.prepare(
    'SELECT source_type, COUNT(*) as count FROM items WHERE is_relevant = 1 GROUP BY source_type'
  ).all<{ source_type: string; count: number }>();

  const lastUpdated = await env.DB.prepare(
    'SELECT MAX(scraped_at) as last FROM items'
  ).first<{ last: string }>();

  const today = new Date().toISOString().slice(0, 10);
  const itemsToday = await env.DB.prepare(
    'SELECT COUNT(*) as count FROM items WHERE scraped_at >= ? AND is_relevant = 1'
  ).bind(today).first<{ count: number }>();

  const bySourceMap: Record<string, number> = {};
  for (const row of bySource.results) {
    bySourceMap[row.source_type] = row.count;
  }

  return jsonResponse({
    total_items: total?.count ?? 0,
    relevant_items: relevant?.count ?? 0,
    by_source: bySourceMap,
    last_updated: lastUpdated?.last ?? null,
    items_today: itemsToday?.count ?? 0,
  }, 200, request, env);
}

// ─── POST /api/enrich/run ──────────────────────────────────────
// Manual trigger for enrich jobs (auth via INGEST_TOKEN).
// Query params:
//   ?mode=backfill-quotes|refresh-metrics|fill-translations  (default: backfill-quotes)
//   &limit=20               (refresh/backfill default 20, fill-translations default 30)
//   &rate_sleep_ms=400
//   &lookback_days=14       (refresh-metrics only)
//   &batch_size=5           (fill-translations only)

async function handleEnrichRun(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const auth = request.headers.get('Authorization');
  if (!auth || auth !== `Bearer ${env.INGEST_TOKEN}`) {
    return jsonResponse({ error: 'Unauthorized' }, 401, request, env);
  }
  const url = new URL(request.url);
  const mode = url.searchParams.get('mode') || 'backfill-quotes';
  const rateSleepMs = Math.max(
    parseInt(url.searchParams.get('rate_sleep_ms') || '400'),
    0,
  );

  if (mode === 'refresh-metrics') {
    const limit = Math.min(
      Math.max(parseInt(url.searchParams.get('limit') || '20'), 1),
      100,
    );
    const lookbackDays = Math.min(
      Math.max(parseInt(url.searchParams.get('lookback_days') || '14'), 1),
      90,
    );
    const result = await runRefreshMetrics(env, limit, rateSleepMs, lookbackDays);
    return jsonResponse(result, 200, request, env);
  }
  if (mode === 'refresh-tiered') {
    const limit = Math.min(
      Math.max(parseInt(url.searchParams.get('limit') || '20'), 1),
      100,
    );
    const maxTier = Math.min(
      Math.max(parseInt(url.searchParams.get('max_tier') || '4'), 0),
      4,
    );
    const result = await runRefreshTiered(env, limit, rateSleepMs, maxTier);
    return jsonResponse(result, 200, request, env);
  }
  if (mode === 'cleanup') {
    const retentionDays = Math.min(
      Math.max(parseInt(url.searchParams.get('retention_days') || '30'), 7),
      365,
    );
    const result = await runCleanup(env, retentionDays);
    return jsonResponse(result, 200, request, env);
  }
  // mode='hf-daily-fetch' — HF Daily Papers 抓取(Bearer INGEST_TOKEN 绕 CF Access)
  // 跟 /api/admin/hf-fetch-now 等价,但走 enrich/run 路径方便 OPS 跑批
  // query params:force=1 跳 sentinel / date=YYYY-MM-DD 指定 BJT 日期
  if (mode === 'hf-daily-fetch') {
    const force = url.searchParams.get('force') === '1';
    const date = url.searchParams.get('date') || undefined;
    const result = await runHfDailyFetch(env, { force, date });
    return jsonResponse(result, 200, request, env);
  }
  // Phase 4+ prompt 调优:单 paper rerun workflow(reset hash + 强制新 instance ID)
  // 用法:POST /api/enrich/run?mode=hf-rerun-paper&arxiv_id=2604.09839
  // 跑前清:workflow_completed_at / workflow_triggered_at / deep_analysis_input_hash /
  //         deep_analysis / title_zh / summary_zh / ai_summary_zh
  //         → 让 idempotency cache miss,workflow 重跑 8 段 pro + flash translate
  // figure / ar5iv / discussion / R2 迁移字段保留(那些 step 内是 idempotent,
  //   重跑 figure step 不会重抓 PDF 重迁 R2,只检查后跳过)
  // instance ID 用 hour-bucket + minute(防同小时反复 trigger 撞 already_exists)
  if (mode === 'hf-rerun-paper') {
    const arxivId = url.searchParams.get('arxiv_id');
    if (!arxivId) return jsonResponse({ error: 'missing arxiv_id query param' }, 400, request, env);
    if (!env.HF_PAPER_PIPELINE_WORKFLOW) {
      return jsonResponse({ error: 'HF_PAPER_PIPELINE_WORKFLOW binding missing' }, 500, request, env);
    }
    const itemId = `hf_paper:${arxivId}`;
    // 1. reset hash + analysis 字段 → idempotency cache miss
    await env.DB.prepare(
      `UPDATE items SET extra = json_remove(extra,
        '$.workflow_completed_at', '$.workflow_triggered_at',
        '$.deep_analysis_input_hash', '$.deep_analysis',
        '$.deep_analysis_at', '$.deep_analysis_model',
        '$.title_zh', '$.summary_zh', '$.ai_summary_zh')
        WHERE id = ?`,
    ).bind(itemId).run();
    // 2. 读 extra signals
    const row = await env.DB.prepare(
      `SELECT extra FROM items WHERE id = ?`,
    ).bind(itemId).first<{ extra: string | null }>();
    if (!row) return jsonResponse({ error: `paper not found: ${itemId}` }, 404, request, env);
    const extraObj = row.extra ? JSON.parse(row.extra) : {};
    // 3. trigger workflow with hour+minute+random suffix(防 already_exists)
    const now = new Date();
    const hourBucket = now.toISOString().slice(0, 13).replace('T', '-');  // YYYY-MM-DD-HH
    const minute = String(now.getUTCMinutes()).padStart(2, '0');
    const rand = Math.random().toString(36).slice(2, 6);
    const safeArxiv = arxivId.replace(/[^a-zA-Z0-9-]/g, '-');
    const instanceId = `hf-paper-${safeArxiv}-${hourBucket}-${minute}-${rand}`;
    try {
      await env.HF_PAPER_PIPELINE_WORKFLOW.create({
        id: instanceId,
        params: {
          itemId, arxivId,
          hasGhRepo: !!extraObj.github_repo,
          hasProjectPage: !!extraObj.project_page,
          hasDiscussionId: !!extraObj.discussion_id,
          lang: 'zh' as const,
        },
      });
      return jsonResponse({
        mode: 'hf-rerun-paper',
        arxiv_id: arxivId,
        item_id: itemId,
        instance_id: instanceId,
        message: '已 reset + trigger;workflow 跑 ~2-3 min(8 段 pro reasoning fan-out)。' +
                 '看 D1 字段 deep_analysis.* / workflow_completed_at 变化即知是否跑完。',
      }, 200, request, env);
    } catch (e) {
      return jsonResponse({
        error: 'workflow create fail',
        detail: String(e).slice(0, 200),
        instance_id: instanceId,
      }, 500, request, env);
    }
  }
  // Phase 4:HF Paper backfill — 扫 stuck items 重 trigger workflow
  // SOP §1.6 模板;按 published_at DESC 优先最新 paper
  // 30min triggered marker filter 防重复;input-hash idempotency 在 workflow step 内
  // 防重跑 deep_analysis pro(figure / discussion / ar5iv fetch 仍跑,免费)
  if (mode === 'backfill-hf-paper-workflow') {
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50'), 1), 200);
    const throttleMs = Math.max(parseInt(url.searchParams.get('throttle_ms') || '3000'), 0);
    if (!env.HF_PAPER_PIPELINE_WORKFLOW) {
      return jsonResponse({ error: 'HF_PAPER_PIPELINE_WORKFLOW binding missing' }, 500, request, env);
    }
    const t0 = Date.now();
    const pending = await env.DB.prepare(
      `SELECT id, extra FROM items
        WHERE source_type='hf_paper'
          AND deleted_at IS NULL
          AND json_extract(extra, '$.workflow_completed_at') IS NULL
          AND (
            json_extract(extra, '$.workflow_triggered_at') IS NULL
            OR CAST(json_extract(extra, '$.workflow_triggered_at') AS INTEGER) < strftime('%s','now','-30 minutes')
          )
        ORDER BY published_at DESC
        LIMIT ?`,
    ).bind(limit).all<{ id: string; extra: string | null }>();

    let triggered = 0, skipped = 0, failed = 0;
    let totalAnalysisTokens = 0;
    let sampledTokens = 0;
    for (let i = 0; i < pending.results.length; i++) {
      const r = pending.results[i];
      let extraObj: Record<string, unknown> = {};
      try { extraObj = JSON.parse(r.extra || '{}') as Record<string, unknown>; } catch { /* ignore */ }
      const arxivId = String(r.id).replace(/^hf_paper:/, '');
      const result = await triggerHfPaperWorkflowForItem(env, r.id, arxivId, {
        hasGhRepo: !!extraObj.github_repo,
        hasProjectPage: !!extraObj.project_page,
        hasDiscussionId: !!extraObj.discussion_id,
      });
      if (result === 'triggered') triggered++;
      else if (result === 'already_exists') skipped++;
      else failed++;
      if (throttleMs > 0 && i < pending.results.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, throttleMs));
      }
    }
    // sample deep_analysis token usage 给 OPS 月度成本校准
    // 拿最近 24h workflow_completed 的 N 条,看 deep_analysis 总 token 估算
    const tokenSample = await env.DB.prepare(
      `SELECT json_extract(extra, '$.deep_analysis_input_hash') AS hash
        FROM items WHERE source_type='hf_paper'
          AND json_extract(extra, '$.workflow_completed_at') IS NOT NULL
          AND json_extract(extra, '$.deep_analysis_input_hash') IS NOT NULL
        ORDER BY scraped_at DESC LIMIT 10`,
    ).all<{ hash: string | null }>();
    sampledTokens = tokenSample.results.length;
    // 注:实际 token usage 由 CF AI Gateway 统计;这里 placeholder count 已 hash 数

    return jsonResponse({
      mode: 'backfill-hf-paper-workflow',
      found: pending.results.length,
      triggered, skipped, failed,
      sampled_completed_paper: sampledTokens,
      elapsed_ms: Date.now() - t0,
      estimated_workflow_completion_min: Math.ceil((triggered * 60) / 60),  // ~60s/paper serial step
    }, 200, request, env);
  }
  if (mode === 'backfill-quotes') {
    const limit = Math.min(
      Math.max(parseInt(url.searchParams.get('limit') || '20'), 1),
      100,
    );
    const result = await runBackfillQuotes(env, limit, rateSleepMs);
    return jsonResponse(result, 200, request, env);
  }
  if (mode === 'backfill-replies') {
    const limit = Math.min(
      Math.max(parseInt(url.searchParams.get('limit') || '20'), 1),
      100,
    );
    const result = await runBackfillReplies(env, limit, rateSleepMs);
    return jsonResponse(result, 200, request, env);
  }
  if (mode === 'backfill-retweets') {
    const limit = Math.min(
      Math.max(parseInt(url.searchParams.get('limit') || '20'), 1),
      100,
    );
    // 2026-05-17 加 recover param:recover=1 绕开 state KV sentinel + 选
    // is_retweet=1 AND retweet_of NULL 行,覆盖被 workflow instance 复用旧代码
    // 跳过 backfill-retweet 的历史数据(P0 fix 后无法通过 workflow 路径修)。
    const recover = url.searchParams.get('recover') === '1';
    const result = await runBackfillRetweets(env, limit, rateSleepMs, recover);
    return jsonResponse(result, 200, request, env);
  }
  if (mode === 'retweet-longform-backfill') {
    // 2026-06-02 转推长推截断存量修复:用被转推原推 id 去 SB 拿全文(复用 fetchLongformViaScrapeBadger)
    // + preserveIsRelevant 重翻。SB 5 req/min,默认 limit 5,反复调直到 selected=0。
    const limit = Math.min(
      Math.max(parseInt(url.searchParams.get('limit') || '5'), 1),
      50,
    );
    const result = await runRetweetLongformBackfill(env, limit);
    return jsonResponse(result, 200, request, env);
  }
  if (mode === 'x-media-r2') {
    // 2026-06-04 P0:把 X 头像/媒体缓存进 R2,改写 media+extra 里的 twimg URL 为 /r/x/...
    // SB 无关,纯下载+R2 put。limit 默认 5,反复调直到 pending=0(见 countXMediaR2Pending)。
    const limit = Math.min(
      Math.max(parseInt(url.searchParams.get('limit') || '5'), 1),
      50,
    );
    // days=N:只迁最近 N 天(回填窗口);不传=全量。pending 也按同窗口算,drain 到 0 即停。
    const days = Math.max(parseInt(url.searchParams.get('days') || '0'), 0) || undefined;
    const result = await runXMediaR2Migrate(env, limit, days);
    const pending = await countXMediaR2Pending(env, days);
    return jsonResponse({ ...result, pending, days: days || null }, 200, request, env);
  }
  if (mode === 'x-card-render') {
    // P2/P3 联调:?mode=x-card-render&itemId=x_list:<tid>[&dry=1]
    // dry=1 只返拼好的 payload(P2 自测,不调 Codex);否则真渲染(P3)+ 转存 R2。
    const itemId = url.searchParams.get('itemId') || '';
    if (!itemId) return jsonResponse({ error: 'missing itemId' }, 400, request, env);
    if (url.searchParams.get('dry') === '1') {
      const payload = await buildXCardPayload(env, itemId);
      return jsonResponse(payload ? { ok: true, dry: true, payload } : { ok: false, error: 'item_not_found' }, 200, request, env);
    }
    const result = await renderXCardViaCodex(env, itemId);
    return jsonResponse(result, result.ok ? 200 : 502, request, env);
  }
  if (mode === 'x-card-enqueue') {
    // 测试/手动:把一条入渲染队列(?itemId=x_list:<tid>),等 drain 或 cron 渲。
    const itemId = url.searchParams.get('itemId') || '';
    if (!itemId) return jsonResponse({ error: 'missing itemId' }, 400, request, env);
    await enqueueXCardRender(env, itemId, 'manual');
    return jsonResponse({ ok: true, item_id: itemId, status: 'pending' }, 200, request, env);
  }
  if (mode === 'drain-x-card-renders') {
    // 渲染队列 drain(cron 每 tick 自动跑 limit=2;此 mode 供 OPS/测试手动触发)。
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '2'), 1), 10);
    const result = await runDrainXCardRenders(env, limit);
    return jsonResponse(result, 200, request, env);
  }
  if (mode === 'x-card-manual') {
    // 手动添加(Phase D 测试入口;UI 走 /api/admin/x-card-manual):?url=<x推文/抽屉地址>
    const u = url.searchParams.get('url') || '';
    if (!u) return jsonResponse({ error: 'missing url' }, 400, request, env);
    const result = await addManualXCardRender(env, u);
    return jsonResponse(result, result.ok ? 200 : 400, request, env);
  }
  if (mode === 'backfill-l3-translations') {
    // Bug #1 backfill (2026-05-20): 老数据 L3 嵌套翻译漏洞补全。
    // 跑 classifyAndTranslateForXTweet,prompt + 入库新版覆盖 retweet_of.quote_of /
    // reply_of.quote_of / quote_of.quote_of 三条 path 的 content_translated。
    const limit = Math.min(
      Math.max(parseInt(url.searchParams.get('limit') || '20'), 1),
      100,
    );
    const result = await runBackfillL3Translations(env, limit, rateSleepMs);
    return jsonResponse(result, 200, request, env);
  }
  if (mode === 'backfill-tco-resolutions') {
    // t.co resolve backfill (2026-05-21): L1/L2/L3 共 6 个 path 哪些 content 是裸 t.co,
    // HEAD 拉 redirect URL 写 extra.{path}.content_resolved_url。FE 渲染 link card。
    const limit = Math.min(
      Math.max(parseInt(url.searchParams.get('limit') || '50'), 1),
      200,
    );
    const result = await runBackfillTcoResolutions(env, limit, rateSleepMs);
    return jsonResponse(result, 200, request, env);
  }
  if (mode === 'backfill-x-articles') {
    // PR5 X Article backfill (2026-05-21):L1/L2/L3 共 6 path 哪些 content_resolved_url
    // 是 /i/article/<id>,调 X syndication API 拿 article detail + author,
    // 写 extra.{path}.x_article。FE 渲染 X-style rich link card。
    const limit = Math.min(
      Math.max(parseInt(url.searchParams.get('limit') || '30'), 1),
      100,
    );
    const result = await runBackfillXArticles(env, limit, rateSleepMs);
    return jsonResponse(result, 200, request, env);
  }
  if (mode === 'backfill-x-article-translations') {
    // PR5 follow-up:扫 x_article title/excerpt 已抓但未翻译的 item,DeepSeek
    // 翻译写 title_translated / excerpt_translated。FE Rich card 显示中文。
    const limit = Math.min(
      Math.max(parseInt(url.searchParams.get('limit') || '30'), 1),
      100,
    );
    const result = await runBackfillXArticleTranslations(env, limit, rateSleepMs);
    return jsonResponse(result, 200, request, env);
  }
  // 2026-05-25 告警分级 Phase A 测试 mode(走 INGEST_TOKEN,绕 CF Access):
  // /api/enrich/run?mode=notify-warning-test&title=X&body=Y → enqueue 一条 warning
  // /api/enrich/run?mode=notify-digest-now → flush KV buffer 推一次 digest
  if (mode === 'notify-warning-test') {
    const { pushDeerWarning } = await import('./notifier');
    const title = url.searchParams.get('title') || '测试 warning';
    const body = url.searchParams.get('body') || `测试时间: ${new Date().toISOString()}`;
    await pushDeerWarning(env, title, body);
    return jsonResponse({ ok: true, enqueued: { title, body } }, 200, request, env);
  }
  if (mode === 'notify-digest-now') {
    const result = await sendDailyWarningDigest(env);
    return jsonResponse(result, 200, request, env);
  }
  if (mode === 'daily-health-checks') {
    // Phase B 业务规则手动触发(测试 / 应急)。返 SQL stats + 触发的告警计数。
    const result = await runDailyHealthChecks(env);
    return jsonResponse(result, 200, request, env);
  }
  if (mode === 'zero-streak-test') {
    // 测试 / 模拟某 source 一轮 0 新增写入 ring buffer,验证 3 轮触发 critical。
    // ?source=ph|hf|x|hdx|gh|clawhub  必传
    // ?count=0  默认 0
    // ?reset=1  清空当前 source 的 ZERO_STREAK_<source> + dedup key,允许重新测
    const source = url.searchParams.get('source') || '';
    const allow = new Set(['ph', 'hf', 'x', 'hdx', 'gh', 'clawhub']);
    if (!allow.has(source)) {
      return jsonResponse({ error: 'source must be one of: ' + Array.from(allow).join(' / ') }, 400, request, env);
    }
    if (url.searchParams.get('reset') === '1') {
      if (env.AUTH_KV) {
        await env.AUTH_KV.delete(`ZERO_STREAK_${source}`);
        const utcDate = new Date().toISOString().slice(0, 10);
        await env.AUTH_KV.delete(`ZERO_STREAK_ALERTED_${source}_${utcDate}`);
      }
      return jsonResponse({ ok: true, reset: source }, 200, request, env);
    }
    const count = parseInt(url.searchParams.get('count') || '0', 10);
    const { checkZeroStreak } = await import('./notifier');
    const taskName = source === 'ph' ? 'PH 每日抓取' :
                     source === 'hf' ? 'HF Daily Papers 每日抓取' :
                     source === 'x' ? 'X List 抓取' :
                     source === 'hdx' ? '活动行抓取' :
                     source === 'gh' ? 'GitHub Trending 抓取' :
                     'ClawHub 列表抓取';
    // 模拟 result obj — 各 source 字段不同,这里用 inserted 兜底(所有 source 都识别)
    await checkZeroStreak(env, source, taskName, { inserted: count });
    // 返当前 KV buffer 状态便于检查
    let buffer: unknown = null;
    if (env.AUTH_KV) {
      const raw = await env.AUTH_KV.get(`ZERO_STREAK_${source}`);
      buffer = raw ? JSON.parse(raw) : null;
    }
    return jsonResponse({ ok: true, source, count, buffer }, 200, request, env);
  }
  if (mode === 'backfill-x-article-bodies') {
    // PR6 (2026-05-22):扫 x_article 已抓但 body 缺的 item,X GraphQL 拿 plain_text。
    // 走 cookie 鉴权 + 5-10s jitter + 日 cap。Cookie 失效 / cap 撞顶 → 中断返
    // stopped_reason,等下次 cron 续跑(KV 隔天自动重置 count)。
    const limit = Math.min(
      Math.max(parseInt(url.searchParams.get('limit') || '20'), 1),
      50,
    );
    const result = await runBackfillXArticleBodies(
      {
        DB: env.DB,
        DEEPSEEK_API_KEY: env.DEEPSEEK_API_KEY,
        AUTH_KV: env.AUTH_KV,
        PUSHDEER_ADMIN_KEYS: env.PUSHDEER_ADMIN_KEYS,
        X_GRAPHQL_DAILY_CAP: env.X_GRAPHQL_DAILY_CAP,
      },
      limit,
      ctx,
    );
    return jsonResponse(result, 200, request, env);
  }
  if (mode === 'backfill-ph-comments-translation') {
    // PH 评论翻译漏洞 backfill (2026-05-21):老版 translatePhBatch 单次发 10+ task
    // 用 max_tokens=4000 撞上限 → 尾部 comments 截断。新版拆 chunk 5/批 + 8000 tokens。
    // 跑此 backfill 让历史漏翻 71 条评论的 11 个 item 重跑 translatePhFieldsForItem。
    const limit = Math.min(
      Math.max(parseInt(url.searchParams.get('limit') || '20'), 1),
      100,
    );
    const result = await runBackfillPhCommentsTranslation(env, limit, rateSleepMs);
    return jsonResponse(result, 200, request, env);
  }
  if (mode === 'backfill-link-card') {
    // 2026-05-17:扫 content 内有 t.co URL 但 link_card 为空的 X 推文,
    // resolve 跳转 + 抓 OG meta 写 link_card。
    const limit = Math.min(
      Math.max(parseInt(url.searchParams.get('limit') || '50'), 1),
      300,
    );
    const throttleMs = Math.max(
      parseInt(url.searchParams.get('throttle_ms') || '1000'),
      0,
    );
    const t0 = Date.now();
    const pending = await env.DB.prepare(
      `SELECT id FROM items
        WHERE source_type='x_list'
          AND deleted_at IS NULL
          AND content LIKE '%https://t.co/%'
          AND json_extract(extra, '$.link_card') IS NULL
          AND json_extract(extra, '$.link_card_backfilled_at') IS NULL
        ORDER BY scraped_at DESC
        LIMIT ?`,
    ).bind(limit).all<{ id: string }>();
    let updated = 0;
    let no_url = 0;
    let redirect_failed = 0;
    let html_fetch_failed = 0;
    let no_og_meta = 0;
    let already = 0;
    let failed = 0;
    for (let i = 0; i < pending.results.length; i++) {
      try {
        const r = await backfillLinkCardForXTweet(env, pending.results[i].id);
        if (r.updated) updated++;
        else if (r.reason === 'already_attempted') already++;
        else if (r.reason === 'no_url') no_url++;
        else if (r.reason === 'redirect_failed') redirect_failed++;
        else if (r.reason === 'html_fetch_failed') html_fetch_failed++;
        else if (r.reason === 'no_og_meta') no_og_meta++;
      } catch (e) {
        console.error(`[backfill-link-card] ${pending.results[i].id}:`, e);
        failed++;
      }
      if (throttleMs > 0 && i < pending.results.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, throttleMs));
      }
    }
    return jsonResponse({
      mode: 'backfill-link-card',
      found: pending.results.length,
      updated,
      already_attempted: already,
      no_url,
      redirect_failed,
      html_fetch_failed,
      no_og_meta,
      failed,
      elapsed_ms: Date.now() - t0,
    }, 200, request, env);
  }
  if (mode === 'backfill-media') {
    // 2026-05-17 user 反馈 X 有图片/视频但 aifeeds media=[]。
    // 直接调 backfillMediaForXTweet,绕过 workflow instance 复用问题(老 instance
    // 跑旧代码没 backfill-media step)。SQL select media 为空 + 未 backfilled 的。
    const limit = Math.min(
      Math.max(parseInt(url.searchParams.get('limit') || '100'), 1),
      500,
    );
    const throttleMs = Math.max(
      parseInt(url.searchParams.get('throttle_ms') || '2000'),
      0,
    );
    const t0 = Date.now();
    const pending = await env.DB.prepare(
      `SELECT id FROM items
        WHERE source_type='x_list'
          AND deleted_at IS NULL
          AND (media IS NULL OR media = '[]' OR length(media) <= 2)
          AND json_extract(extra, '$.media_backfilled_at') IS NULL
        ORDER BY scraped_at DESC
        LIMIT ?`,
    ).bind(limit).all<{ id: string }>();
    let updated = 0;
    let already = 0;
    let no_media = 0;
    let not_found = 0;
    let failed = 0;
    for (let i = 0; i < pending.results.length; i++) {
      try {
        const r = await backfillMediaForXTweet(env, pending.results[i].id);
        if (r.updated) updated++;
        else if (r.reason === 'already_attempted' || r.reason === 'no_improvement') already++;
        else if (r.reason === 'no_media') no_media++;
        else if (r.reason === 'syndication_not_found') not_found++;
      } catch (e) {
        console.error(`[backfill-media] ${pending.results[i].id}:`, e);
        failed++;
      }
      if (throttleMs > 0 && i < pending.results.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, throttleMs));
      }
    }
    return jsonResponse({
      mode: 'backfill-media',
      found: pending.results.length,
      updated,
      no_media,
      not_found,
      already_attempted: already,
      failed,
      elapsed_ms: Date.now() - t0,
    }, 200, request, env);
  }
  if (mode === 'backfill-x-workflow') {
    // 批 4(2026-05-17):扫老 X 推文 extra.workflow_completed_at IS NULL,
    // 重 trigger 新 workflow → 写入 workflow_completed_at + 翻译(走批 1 合并调用)。
    // 30min marker filter 防重复 trigger;按 published_at DESC 优先最新 7 天。
    // throttle 5s/instance 避免 syndication / SB rate limit。
    const limit = Math.min(
      Math.max(parseInt(url.searchParams.get('limit') || '50'), 1),
      200,
    );
    const throttleMs = Math.max(
      parseInt(url.searchParams.get('throttle_ms') || '5000'),
      0,
    );
    if (!env.X_TWEET_PIPELINE_WORKFLOW) {
      return jsonResponse({ error: 'X_TWEET_PIPELINE_WORKFLOW binding missing' }, 500, request, env);
    }
    const t0 = Date.now();
    // 2026-05-17 prioritize:stuck 类型先 backfill(retweet/quote/reply pending),
    // 其他按 published_at DESC。这样 OPS 大批 trigger 时 user 关心的 retweet bug
    // 等问题立即被 backfill,而不是被新 published 但已完整的推文挤掉。
    const pending = await env.DB.prepare(
      `SELECT id, extra FROM items
        WHERE source_type='x_list'
          AND deleted_at IS NULL
          AND json_extract(extra, '$.workflow_completed_at') IS NULL
          AND (
            json_extract(extra, '$.workflow_triggered_at') IS NULL
            OR CAST(json_extract(extra, '$.workflow_triggered_at') AS INTEGER) < strftime('%s','now','-30 minutes')
          )
        ORDER BY
          (CASE
            WHEN json_extract(extra,'$.is_retweet')=1 AND json_extract(extra,'$.retweet_of') IS NULL THEN 0
            WHEN json_extract(extra,'$.quote_of_id') IS NOT NULL AND json_extract(extra,'$.quote_of') IS NULL THEN 1
            WHEN json_extract(extra,'$.reply_to_id') IS NOT NULL AND json_extract(extra,'$.reply_of') IS NULL THEN 2
            ELSE 9
          END),
          published_at DESC
        LIMIT ?`,
    ).bind(limit).all<{ id: string; extra: string | null }>();

    let triggered = 0;
    let skipped = 0;
    let failed = 0;
    for (let i = 0; i < pending.results.length; i++) {
      const r = pending.results[i];
      let extraObj: Record<string, unknown> = {};
      try { extraObj = JSON.parse(r.extra || '{}') as Record<string, unknown>; } catch { /* ignore */ }
      const signals = {
        hasQuoteRef: !!(extraObj.quote_of_id || extraObj.quote_of),
        hasReplyRef: !!(extraObj.reply_to_id || extraObj.reply_of_id || extraObj.reply_of),
        hasLinkCard: !!extraObj.link_card,
        hasRetweetRef: !!(extraObj.is_retweet || extraObj.retweeted_status_id || extraObj.retweet_of_id || extraObj.retweet_of),
      };
      const result = await triggerXWorkflowForItem(env, r.id, signals);
      if (result === 'triggered') triggered++;
      else if (result === 'already_exists') skipped++;
      else failed++;
      // throttle 避免 syndication / SB rate limit;最后一条不 sleep
      if (throttleMs > 0 && i < pending.results.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, throttleMs));
      }
    }
    return jsonResponse({
      mode: 'backfill-x-workflow',
      found: pending.results.length,
      triggered,
      skipped,
      failed,
      elapsed_ms: Date.now() - t0,
      estimated_workflow_completion_min: Math.ceil((triggered * 20) / 60),
    }, 200, request, env);
  }
  if (mode === 'reclassify-threads') {
    const dryRun = url.searchParams.get('dry_run') !== '0';
    const result = await runReclassifyThreads(env, dryRun);
    return jsonResponse(result, 200, request, env);
  }
  if (mode === 'list-poll-measure') {
    // Dry-run：调 SB list 但不写 D1，仅返回 tweet 形状预览 + credits + ID 摘要。
    // 用于排查 / 验证 SB 返回是否符合预期，不影响线上数据。
    const listId = url.searchParams.get('list_id');
    if (!listId) return jsonResponse({ error: 'list_id required' }, 400, request, env);
    const maxPages = Math.min(Math.max(parseInt(url.searchParams.get('max_pages') || '1'), 1), 5);
    const { fetchListTweetsPage } = await import('./scrapebadger');
    const pages: Array<{
      pageIdx: number;
      tweetCount: number;
      firstId?: string;
      lastId?: string;
      sampleAuthors?: string[];
      creditsUsed?: number;
      rateLimitRemaining?: number;
      durationMs?: number;
      error?: string;
      nextCursor?: string | null;
    }> = [];
    let cursor: string | null = null;
    let totalCredits = 0;
    let totalTweets = 0;
    for (let i = 0; i < maxPages; i++) {
      const r = await fetchListTweetsPage(env, listId, cursor);
      const tids = r.tweets.map((t) => t.id).filter(Boolean);
      pages.push({
        pageIdx: i,
        tweetCount: r.tweets.length,
        firstId: tids[0],
        lastId: tids[tids.length - 1],
        sampleAuthors: Array.from(new Set(r.tweets.slice(0, 5).map((t) => t.username || ''))).filter(Boolean),
        creditsUsed: r.creditsUsed,
        rateLimitRemaining: r.rateLimitRemaining,
        durationMs: r.durationMs,
        error: r.error,
        nextCursor: r.nextCursor,
      });
      totalCredits += r.creditsUsed || 0;
      totalTweets += r.tweets.length;
      if (r.error || !r.nextCursor) break;
      cursor = r.nextCursor;
    }
    return jsonResponse(
      {
        mode: 'list-poll-measure',
        list_id: listId,
        total_credits: totalCredits,
        total_tweets: totalTweets,
        pages,
      },
      200,
      request,
      env,
    );
  }
  if (mode === 'list-poll-ingest') {
    // 真实 ingest：上 D1（is_relevant=1，matched_by='list-poll-sb'）
    // 同 cron */30 入口走的是同一函数，仅 list_id / max_pages 可调。
    const listId = url.searchParams.get('list_id') || env.LIST_POLL_LIST_ID || '1643236611378008066';
    const maxPages = Math.min(Math.max(parseInt(url.searchParams.get('max_pages') || '3'), 1), 5);
    const result = await runListPollIngest(env, listId, maxPages);
    return jsonResponse(result, 200, request, env);
  }
  if (mode === 'longform-via-sb') {
    // 替代本地 .longform launchd：批量从 SB 拉 full_text 写回 items.content。
    // limit 默认 50；SB 端单次 200 IDs 会 125s 超时，前端 cap 50（实测稳定）。
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50'), 1), 50);
    const result = await runLongformViaSb(env, limit);
    return jsonResponse(result, 200, request, env);
  }
  if (mode === 'backfill-video-mp4') {
    // 一次性补齐：mp4 lookup key bug 修复前进来的 video item 全是 jpg
    // thumbnail，跑这个 mode 用 syndication 把 url 补成 mp4。
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '30'), 1), 50);
    const result = await runBackfillVideoMp4(env, limit);
    return jsonResponse(result, 200, request, env);
  }
  if (mode === 'classify-pending') {
    // DeepSeek 批量判定 is_relevant + ai_summary。manual 触发用于一次性清 backlog
    // 或验证 prompt 效果。limit 默认 15（每批 1 次 LLM call ~10-30s）。
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '15'), 1), 30);
    const result = await runClassifyPending(env, limit);
    return jsonResponse(result, 200, request, env);
  }
  if (mode === 'fill-translations') {
    const limit = Math.min(
      Math.max(parseInt(url.searchParams.get('limit') || '15'), 1),
      50,
    );
    const batchSize = Math.min(
      Math.max(parseInt(url.searchParams.get('batch_size') || '5'), 1),
      20,
    );
    const result = await runFillTranslations(env, limit, batchSize);
    return jsonResponse(result, 200, request, env);
  }
  if (mode === 'detect-longform') {
    const limit = Math.min(
      Math.max(parseInt(url.searchParams.get('limit') || '30'), 1),
      80,
    );
    const result = await runDetectLongform(env, limit, rateSleepMs);
    return jsonResponse(result, 200, request, env);
  }
  if (mode === 'github-fetch') {
    const result = await runGithubFetchTrending(env);
    return jsonResponse(result, 200, request, env);
  }
  if (mode === 'github-enrich') {
    const limit = Math.min(
      Math.max(parseInt(url.searchParams.get('limit') || '1'), 1),
      10,
    );
    const result = await runGithubEnrichPending(env, limit);
    return jsonResponse(result, 200, request, env);
  }
  if (mode === 'clawhub-fetch') {
    const result = await runClawhubFetchList(env);
    return jsonResponse(result, 200, request, env);
  }
  if (mode === 'clawhub-enrich') {
    const limit = Math.min(
      Math.max(parseInt(url.searchParams.get('limit') || '2'), 1),
      10,
    );
    const result = await runClawhubEnrichPending(env, limit);
    return jsonResponse(result, 200, request, env);
  }
  if (mode === 'github-readme-translate') {
    const limit = Math.min(
      Math.max(parseInt(url.searchParams.get('limit') || '1'), 1),
      10,
    );
    const result = await runGithubReadmeTranslate(env, limit);
    return jsonResponse(result, 200, request, env);
  }
  if (mode === 'github-r2-migrate') {
    const limit = Math.min(
      Math.max(parseInt(url.searchParams.get('limit') || '1'), 1),
      10,
    );
    const result = await runGithubR2Migrate(env, limit);
    return jsonResponse(result, 200, request, env);
  }
  // backfill-truncated-text：扫 X tweets 截断的 (content 末尾 … + length 130-150)，
  // 调 syndication API 补全。给一次性救存量 + cron 兜底用，跟 workflow step 0
  // (backfillTruncatedTextForXTweet) 共用单 item 逻辑。
  if (mode === 'backfill-truncated-text') {
    const limit = Math.min(
      Math.max(parseInt(url.searchParams.get('limit') || '30'), 1),
      200,
    );
    const result = await runBackfillTruncatedFromSyndication(env, limit, rateSleepMs);
    return jsonResponse(result, 200, request, env);
  }
  // hdx-drain-workflow：CLI 一次性触发 huodongxing pending workflow。
  // 跟 cron isHdxEnrichSlot + admin /api/admin/hdx-trigger-pending-workflows-now
  // 共用 drainHdxPendingWorkflows。Bearer INGEST_TOKEN 走 /api/enrich/run 跳过 CF Access。
  // limit ≤ 400（单 trigger ~2 subreq，400 = 800 subreq < 1000 cap）。
  if (mode === 'hdx-drain-workflow') {
    const limit = Math.min(
      Math.max(parseInt(url.searchParams.get('limit') || '100'), 1),
      400,
    );
    const throttleSec = Math.min(
      Math.max(parseInt(url.searchParams.get('throttle_sec') || '3'), 1),
      10,
    );
    const result = await drainHdxPendingWorkflows(env, limit, throttleSec);
    return jsonResponse(result, 200, request, env);
  }
  return jsonResponse({ error: `Unknown mode: ${mode}` }, 400, request, env);
}

// ─── GET /api/longform/pending ─────────────────────────────────
// Local browser fetcher pulls a batch of items that need full long-form text.
// Auth via INGEST_TOKEN. Caller iterates: fetch each URL with cookies, scrape
// [data-testid="tweetText"], POST result via /api/longform/submit.
//
// Query: ?limit=N (default 20, max 50), ?max_attempts=K (default 3)

async function handleLongformPending(
  request: Request,
  env: Env,
): Promise<Response> {
  const auth = request.headers.get('Authorization');
  if (!auth || auth !== `Bearer ${env.INGEST_TOKEN}`) {
    return jsonResponse({ error: 'Unauthorized' }, 401, request, env);
  }
  const url = new URL(request.url);
  const limit = Math.min(
    Math.max(parseInt(url.searchParams.get('limit') || '20'), 1),
    50,
  );
  const maxAttempts = Math.min(
    Math.max(parseInt(url.searchParams.get('max_attempts') || '3'), 1),
    5,
  );
  const items = await listPendingLongform(env, limit, maxAttempts);
  return jsonResponse({ items, count: items.length }, 200, request, env);
}

// ─── POST /api/longform/submit ─────────────────────────────────
// Local fetcher reports back the full text (or the error encountered).
// Body: { id: string, full_text?: string, error?: string }
//
// Worker validates: only commits when full_text > existing content length.
// On accepted update, content_translated is nulled so fill-translations
// re-translates the new full body.

interface SubmitBody {
  id?: unknown;
  full_text?: unknown;
  error?: unknown;
}

async function handleLongformSubmit(
  request: Request,
  env: Env,
): Promise<Response> {
  const auth = request.headers.get('Authorization');
  if (!auth || auth !== `Bearer ${env.INGEST_TOKEN}`) {
    return jsonResponse({ error: 'Unauthorized' }, 401, request, env);
  }
  let body: SubmitBody;
  try {
    body = await request.json<SubmitBody>();
  } catch {
    return jsonResponse({ error: 'invalid json' }, 400, request, env);
  }
  const id = typeof body.id === 'string' ? body.id : '';
  if (!id) {
    return jsonResponse({ error: 'missing id' }, 400, request, env);
  }
  const fullText =
    typeof body.full_text === 'string' ? body.full_text : null;
  const fetchError =
    typeof body.error === 'string' ? body.error : undefined;
  const result = await submitLongformText(env, id, fullText, fetchError);
  return jsonResponse(result, 200, request, env);
}

// ─── GET /img?url=... ──────────────────────────────────────────
// Proxy for twimg-hosted images. Avoids GFW blocking of pbs.twimg.com
// on CN networks. Whitelist twimg hosts only — never forward arbitrary
// URLs (no open proxy).

const ALLOWED_IMG_HOSTS = new Set([
  'pbs.twimg.com',
  'abs.twimg.com',
  'video.twimg.com',
  // GH 头像国内访问偶发慢 / 302 重定向到 camo；前端 proxyImg() 同步加白
  'avatars.githubusercontent.com',
  // HF Daily Papers 接入(2026-05-18):
  //   - cdn-avatars.huggingface.co: 用户头像(评论者 / submitter)
  //   - cdn-thumbnails.huggingface.co: paper social-thumbnail(1200×630 兜底卡片图)
  //   - cdn-uploads.huggingface.co: 用户自传头像变体
  //   - huggingface.co: 评论 author.avatarUrl 相对路径(/avatars/xxx.svg)的绝对化
  //   - arxiv.org: 论文首张 figure(extract-first-figure step,NEW #1)
  //     2026-05-18 从 ar5iv.labs.arxiv.org 切到 arxiv.org/html(arxiv 官方 HTML 服务,
  //     实时渲染,5 月新论文都有完整 HTML + figure;ar5iv 社区项目滞后几周)
  //   - ar5iv.labs.arxiv.org: 保留作 fallback(老 paper 兼容)
  'cdn-avatars.huggingface.co',
  'cdn-thumbnails.huggingface.co',
  'cdn-uploads.huggingface.co',
  'huggingface.co',
  'arxiv.org',
  'ar5iv.labs.arxiv.org',
  // 2026-05-19 FE 反馈:X 推文嵌外链卡片的 OG 图 host
  'opengraph.githubassets.com',          // GH 仓库 / issue OG image(X 嵌 GH 链接卡用)
  'og.luma.com',                          // Luma 活动 OG(X 嵌 Luma 活动链接卡)
  'jf.x.com',                             // Twitter media inflight gateway(部分推文图走这域)
  // 2026-05-20 FE 反馈:GH README / attachment 内嵌图片高频域(走 cf.image transform 提速)
  'raw.githubusercontent.com',           // README 内 ![](raw.githubusercontent.com/...) raw asset
  'user-images.githubusercontent.com',   // GH 老版 user-attachments 上传 image
  'github.com',                           // 新版 /user-attachments/ 路径(实际 redirect 到 githubusercontent)
]);

async function handleImageProxy(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const target = url.searchParams.get('url');
  if (!target) return new Response('missing url', { status: 400 });

  let targetUrl: URL;
  try {
    targetUrl = new URL(target);
  } catch {
    return new Response('invalid url', { status: 400 });
  }
  if (!ALLOWED_IMG_HOSTS.has(targetUrl.hostname)) {
    return new Response('host not allowed', { status: 403 });
  }

  // 转发 Range header 给上游 — video seek 必需。
  // video.twimg.com / pbs.twimg.com 都支持 Range request；浏览器 <video>
  // 在 seek 时会发 Range: bytes=N- 请求拿对应字节区间。代理之前没转发 Range，
  // 上游永远返完整流，浏览器认为该 source 不支持 seek → 拖进度条无效。
  const upstreamHeaders: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (compatible; ai-feeds-img-proxy/1.0)',
  };
  const rangeHeader = request.headers.get('range');
  if (rangeHeader) upstreamHeaders['Range'] = rangeHeader;
  // 透传客户端 Accept — cf.image format=auto 需要靠 Accept 决定输出 webp/avif
  const acceptHeader = request.headers.get('accept');
  if (acceptHeader) upstreamHeaders['Accept'] = acceptHeader;

  // video 类型不走 CF cache — 因为 Range request 跟全量请求会污染同一 cache key，
  // 长视频 seek 时拿到完整流又不能 partial 响应。图片（pbs.twimg.com）继续 cache。
  // 图片额外走 cf.image 边缘转换（format / w / q）。用 cf.image 而非 /cdn-cgi/image URL：
  // 从 worker 内部触发不受 zone "Allow external source" 限制，且 worker 已做过 host
  // 白名单验证（line 2627-2629）— CF 信任此处的 source。
  //
  // format 选择：cf.image format='auto' 在 worker fetch 上下文里实测不可靠（不论
  // Accept header 传啥都返原 mime，无 Vary）。直接 parse incoming request Accept 自己 pick：
  //   - Accept 含 image/avif → avif（Chrome 85+ / Firefox 93+）
  //   - 含 image/webp → webp（含 Safari 14+ / iOS 14+）
  //   - 都不含 → 不设 format，passthrough 原 mime
  // cacheKey 编入 format，防止跨 client 互污染（worker cache 是 binary blob，混 webp/jpeg
  // 会让老 Safari 拿到 webp cache 解码失败）。Response Vary: Accept 让 client / CDN
  // 知道按 Accept 分缓存。
  const isVideo = targetUrl.hostname === 'video.twimg.com';
  let cfOptions: { cf?: Record<string, unknown> };
  if (isVideo) {
    cfOptions = {};
  } else {
    const w = url.searchParams.get('w');
    const q = parseInt(url.searchParams.get('q') || '85', 10);
    const accept = request.headers.get('accept') || '';
    let format: 'avif' | 'webp' | null = null;
    if (/image\/avif/i.test(accept)) format = 'avif';
    else if (/image\/webp/i.test(accept)) format = 'webp';
    const imageOpts: Record<string, unknown> = { quality: q };
    if (format) imageOpts.format = format;
    if (w) imageOpts.width = parseInt(w, 10);
    const cacheKey = `${url.origin}${url.pathname}${url.search}&_fmt=${format ?? 'orig'}`;
    cfOptions = {
      cf: {
        image: imageOpts,
        // 2026-05-19 FE 反馈:cacheTtl=86400 + cacheEverything=true 会把上游瞬态
        // 502/404 也 cache 24h(典型 case:pbs.twimg.com/amplify_video_thumb/*
        // 上游限流时 worker cache 5xx,后续 24h 一直返同 502)。
        // 改 cacheTtlByStatus:2xx cache 24h / 3xx 5min / 4xx 1min / 5xx 不 cache。
        cacheTtlByStatus: { '200-299': 86400, '300-399': 300, '400-499': 60, '500-599': 0 },
        cacheEverything: true,
        cacheKey,
      },
    };
  }

  const upstream = await fetch(targetUrl.toString(), {
    ...cfOptions,
    headers: upstreamHeaders,
  });

  // 200 OK（无 Range 请求）或 206 Partial Content（有 Range 请求）都算成功
  if (!upstream.ok && upstream.status !== 206) {
    return new Response('upstream failed', { status: upstream.status });
  }

  const headers = new Headers();
  const ct = upstream.headers.get('content-type');
  if (ct) headers.set('Content-Type', ct);
  // 透传 Range 相关响应头 — 让 <video> 知道源支持 seek
  const acceptRanges = upstream.headers.get('accept-ranges');
  if (acceptRanges) headers.set('Accept-Ranges', acceptRanges);
  const contentLength = upstream.headers.get('content-length');
  if (contentLength) headers.set('Content-Length', contentLength);
  const contentRange = upstream.headers.get('content-range');
  if (contentRange) headers.set('Content-Range', contentRange);
  // 图片可长期 cache；video 不设 immutable（避免浏览器把"无 Range"的完整流
  // 当成 immutable 缓存住，后续 Range 请求拿不到 partial 响应）
  if (isVideo) {
    headers.set('Cache-Control', 'no-store');
  } else {
    headers.set('Cache-Control', 'public, max-age=604800, immutable');
    // 让 client / 中间 CDN 知道按 Accept 不同 cache（worker cacheKey 已按 format
    // 分桶，但 client 端 cache 也得有 Vary 提示，否则切浏览器会拿错格式）
    headers.set('Vary', 'Accept');
  }
  headers.set('Access-Control-Allow-Origin', '*');

  return new Response(upstream.body, {
    status: upstream.status, // 转发 200 或 206
    headers,
  });
}

// ─── Bot UA + hot-link defense ─────────────────────────────────
// Two cheap string matches that run before D1/R2 access:
//   1. isBlockedBot — catches AI-training crawlers + scripted scrapers
//      (GPTBot/ClaudeBot/python-requests/curl/scanners). Verified search-engine
//      bots (Googlebot/Bingbot/Baiduspider/Sogou) and social previewers
//      (Twitterbot/facebookexternalhit/Slackbot) intentionally NOT blocked
//      since they drive SEO + share-card previews.
//   2. R2_REFERER_WHITELIST — blocks hot-linking of /r/<key> images/videos
//      from third-party sites. Empty referer (direct hit / poster renderer)
//      always allowed; otherwise must come from our own domains or known
//      social media that strip referer naturally.
const BLOCKED_BOT_RE = /\b(gptbot|claudebot|claude-web|anthropic-ai|ccbot|perplexitybot|bytespider|meta-externalagent|amazonbot|cohere-training|google-extended|youbot|diffbot|ahrefsbot|semrushbot|mj12bot|dotbot|petalbot|seznambot|blexbot|magpie-crawler|datanyze|barkrowler|scrapy|httpie|python-requests|go-http-client|java-http-client|apache-httpclient|okhttp|libwww-perl|nikto|sqlmap|nmap|masscan|wfuzz|dirbuster|gobuster|nuclei|wpscan|acunetix|nessus|burp|zgrab|censys|shodan|headlesschrome|phantomjs|puppeteer|playwright)\b/i;
const CURL_WGET_RE = /^(curl|wget)\//i;
function isBlockedBot(ua: string): boolean {
  return BLOCKED_BOT_RE.test(ua) || CURL_WGET_RE.test(ua);
}

// Bot gate exemption: paths that always skip UA filter regardless of caller.
// Two groups:
//   1. Internal ingestion endpoints — already device/token-gated downstream
//      (/api/ingest from scrapers, /api/track from browser analytics).
//   2. Public read-only endpoints used by dashboard + open visitors.
//      Content is publicly crawlable anyway, so blocking curl/python-requests
//      here breaks BE/OPS smoke tests without any security benefit.
function isBotGateExempt(path: string, method: string): boolean {
  if (path === '/api/ingest' || path === '/api/track') return true;
  if (method === 'GET' || method === 'HEAD') {
    if (path === '/api/items' || path === '/api/sources' || path === '/api/stats') return true;
    if (path === '/img' || path.startsWith('/r/')) return true;
    // /api/digest/daily:Bearer key 鉴权(handler 内校验),受信设备 agent 调用 UA 可能非浏览器,不卡 UA 闸
    if (path === '/api/digest/daily') return true;
    // PM 2026-05-25:/s/<token> 是分享二维码扫码命中点,微信内置浏览器 / 二维码
    // 扫描 app 的 UA 经常被 bot gate 判 403,用户扫码看到"内容不存在".分享 redirect
    // 本身就是公开 endpoint,handler 内部有 token 校验,不该卡 UA 闸
    if (path.startsWith('/s/')) return true;
  }
  return false;
}

const R2_REFERER_ALLOW = new Set<string>([
  'ai-feeds.com', 'www.ai-feeds.com', 'api.ai-feeds.com',
  'staging.ai-feeds.com', 'staging-api.ai-feeds.com',
  'twitter.com', 'x.com', 'mobile.twitter.com', 'mobile.x.com', 't.co',
  'producthunt.com', 'www.producthunt.com',
  'github.com', 'www.github.com',
  'localhost', '127.0.0.1',
]);
function isAllowedR2Referer(referer: string): boolean {
  if (!referer) return true; // empty = direct hit, allow
  try {
    const host = new URL(referer).hostname;
    if (R2_REFERER_ALLOW.has(host)) return true;
    if (host.endsWith('.pages.dev')) return true; // CF Pages preview deploys
    if (host.endsWith('.localhost')) return true;
    return false;
  } catch {
    return false; // malformed referer → suspicious, block
  }
}

// ─── GET /r/:key ───────────────────────────────────────────────
// Serve migrated README assets from R2 with long cache + CORS.
// Key shape: gh/<owner>/<repo>/<sha256>.<ext>

async function handleR2Asset(request: Request, env: Env, key: string): Promise<Response> {
  if (!env.READMES) return new Response('R2 not configured', { status: 503 });
  if (!key) return new Response('missing key', { status: 400 });

  if (!isAllowedR2Referer(request.headers.get('Referer') || '')) {
    return new Response('Forbidden (hotlink)', {
      status: 403,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  }

  const obj = await env.READMES.get(key);
  if (!obj) return new Response('not found', { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('Access-Control-Allow-Origin', '*');
  // ETag from R2 lets browsers and CF edge revalidate.
  if (obj.httpEtag) headers.set('ETag', obj.httpEtag);

  return new Response(obj.body, { status: 200, headers });
}
