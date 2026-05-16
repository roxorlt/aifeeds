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
  runLongformViaSb,
  runClassifyPending,
  runBackfillVideoMp4,
  runPhEnrich,
  triggerXWorkflowForItem,
} from './enrich';
import { handleTrack } from './track';
import {
  runGithubFetchTrending,
  runGithubEnrichPending,
  runGithubReadmeTranslate,
  runGithubR2Migrate,
  triggerGhWorkflowForItem,
} from './github';
import { runPhR2Migrate, countPhR2Pending } from './ph-r2';
import { runPhDailyFetch } from './scrapers/ph';
import { notifyCronSummary } from './notifier';
import {
  handleHuodongxingPoc,
  runHuodongxingFetchList,
  runHuodongxingDetailEnrich,
  markStaleEventsHistorical,
  countHuodongxingDetailPending,
  triggerHdxWorkflowForItem,
} from './scrapers/huodongxing';
import type { HuodongxingCity } from './scrapers/huodongxing/cities';
import { HUODONGXING_CITIES } from './scrapers/huodongxing/cities';
import {
  runClawhubFetchList,
  runClawhubEnrichPending,
  refreshClawhubItem,
  countClawhubPending,
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
import {
  serveAdminHtml,
  adminSmsStatus,
  adminUnlockSms,
  adminUser,
  adminCleanupAccount,
  adminDailyCap,
  checkAdminAuth,
} from './admin';
import {
  handleShareCreate,
  handleSharePoster,
  handleShareRedirect,
  handleShareLanding,
  handleAdminShareStats,
} from './share/handlers';

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
  // PR2 配置
  SMS_DAILY_CAP?: string;               // 默认 200，可临时降到 0 = kill switch
  SMS_PROVIDER?: string;                // 'tencent'（默认）/ 'pushdeer'（dev/staging 走 PushDeer 推到 admin）
  // Admin panel 凭据（HTTP Basic Auth）。用 wrangler secret put 注入，git 不留痕。
  ADMIN_USER?: string;
  ADMIN_PASS?: string;
  // PR-EmailAuth：Resend + email 风控配置
  RESEND_API_KEY?: string;              // wrangler secret put 设置（不入 git）
  EMAIL_DAILY_CAP?: string;             // 默认 100（Resend free 100/天）
  EMAIL_MONTHLY_CAP?: string;           // 默认 3000（Resend free 3000/月）
  EMAIL_FROM?: string;                  // 默认 'AI Feeds <noreply@mail.ai-feeds.com>'
  ENABLE_SMS_LOGIN?: string;            // 'true' = 开放 SMS 通道（备案后），缺省/'false' = 关闭
  ENABLE_EMAIL_LOGIN?: string;          // 默认开启；'false' = 紧急关闭 email 通道
  // PH GraphQL OAuth (client_credentials flow). Set via wrangler secret put.
  // Used by worker/src/scrapers/ph.ts (daily fetch cron).
  PH_CLIENT_ID?: string;
  PH_CLIENT_SECRET?: string;
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
  // CF Workflow binding for huodongxing detail enrich (worker/src/workflows/
  // huodongxing-detail.ts)。runHuodongxingFetchList 后对每条新事件 create
  // instance。替换原 isHdxEnrichSlot preempt cron。
  // 设计：docs/plans/2026-05-16-huodongxing-workflow-design.md
  HUODONGXING_DETAIL_WORKFLOW: Workflow;
}

// re-export workflow class 让 wrangler.toml [[workflows]] class_name 能找到
export { GithubPipelineWorkflow } from './workflows/github-pipeline';
export { XTweetPipelineWorkflow } from './workflows/x-tweet-pipeline';
export { HuodongxingDetailWorkflow } from './workflows/huodongxing-detail';

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
        return handleEnrichRun(request, env);
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
      if (path === '/api/auth/delete' && request.method === 'POST') {
        return withCors(await handleDelete(request, env, ctx), request, env);
      }
      // Admin panel（HTTP Basic Auth；不走 corsHeaders，同源访问）
      if (path === '/admin' || path === '/admin/') {
        return serveAdminHtml(request, env);
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
        if (!checkAdminAuth(request, env)) {
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
        if (!checkAdminAuth(request, env)) {
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
        if (!checkAdminAuth(request, env)) {
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
        if (!checkAdminAuth(request, env)) {
          return new Response('Unauthorized', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="ai-feeds admin"' },
          });
        }
        const result = await runGithubFetchTrending(env);
        return jsonResponse(result, 200, request, env);
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
        if (!checkAdminAuth(request, env)) {
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
      // ─── X Phase 1 手动触发（staging E2E + admin debug） ─────────
      // POST /api/admin/x-list-poll-now?list_id=...&pages=N
      // 触发 runListPollIngest 拉新 tweet → 写 D1 + create workflow instance per new。
      if (path === '/api/admin/x-list-poll-now' && request.method === 'POST') {
        if (!checkAdminAuth(request, env)) {
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
        if (!checkAdminAuth(request, env)) {
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
            hasRetweetRef: !!(extraObj.retweet_of_id || extraObj.retweet_of),
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
        if (!checkAdminAuth(request, env)) {
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
          hasRetweetRef: !!(extra.retweet_of || extra.retweet_of_id),
          lang: 'zh' as const,
        };
        const instanceId = `x-${itemId.replace(/[^a-zA-Z0-9-]/g, '-')}`;
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
        if (!checkAdminAuth(request, env)) {
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
        if (!checkAdminAuth(request, env)) {
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
      // D2: 一次性清掉历史脏数据 — 老 chrome scraper 抓时把 quoted preview
      // text 也包进主推 content，导致 main.content == quote_of.content 完全相同。
      // 备份 main.content 到 extra.original_content + 把 main.content 清空。
      // ?dry_run=0 真写 / ?limit=N (默认 500)
      if (path === '/api/admin/dedupe-quote-content-now' && request.method === 'POST') {
        if (!checkAdminAuth(request, env)) {
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
        if (!checkAdminAuth(request, env)) {
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
        if (!checkAdminAuth(request, env)) {
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
      // 运维：手动触发一条测试推送，验证 PUSHDEER 配置 + body 中文化效果
      // POST /api/admin/notify-test
      //   ?source=ph|x|gh|clawhub|hdx|hdx-skip|all
      //   不传或 source=all 时一次性推 5 条（覆盖所有 5 个 fetch 的字段结构 + 1 条 PH skip 路径）
      // 用模拟数据验证 notifyCronSummary i18n 是否覆盖了真实字段，不真的去抓数据。
      if (path === '/api/admin/notify-test' && request.method === 'POST') {
        if (!checkAdminAuth(request, env)) {
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
        if (!checkAdminAuth(request, env)) {
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
        if (!checkAdminAuth(request, env)) {
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
        if (!checkAdminAuth(request, env)) {
          return new Response('Unauthorized', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="ai-feeds admin"' },
          });
        }
        const result = await markStaleEventsHistorical(env);
        return jsonResponse(result, 200, request, env);
      }
      if (path === '/api/admin/hdx-status' && request.method === 'GET') {
        if (!checkAdminAuth(request, env)) {
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
        if (!checkAdminAuth(request, env)) {
          return new Response('Unauthorized', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="ai-feeds admin"' },
          });
        }
        const u = new URL(request.url);
        const limit = Math.min(parseInt(u.searchParams.get('limit') || '100', 10), 400);
        if (!env.HUODONGXING_DETAIL_WORKFLOW) {
          return jsonResponse({ error: 'HUODONGXING_DETAIL_WORKFLOW binding missing' }, 500, request, env);
        }
        // 治本 marker filter：30 min 内已触发的跳过（避免重复 trigger 已 in-flight）
        // 30 min 后视为 stuck，可重新触发
        const pending = await env.DB.prepare(
          `SELECT id FROM items
            WHERE source_type='huodongxing'
              AND deleted_at IS NULL
              AND json_extract(extra, '$.detail_enriched_at') IS NULL
              AND (
                json_extract(extra, '$.workflow_triggered_at') IS NULL
                OR json_extract(extra, '$.workflow_triggered_at') < strftime('%s','now','-30 minutes')
              )
            ORDER BY json_extract(extra, '$.last_seen_at') DESC
            LIMIT ?`,
        ).bind(limit).all<{ id: string }>();
        let triggered = 0;
        let skipped = 0;
        let failed = 0;
        let throttleIndex = 0;
        for (const r of pending.results) {
          const result = await triggerHdxWorkflowForItem(env, r.id, throttleIndex * 5);
          if (result === 'triggered') {
            triggered++;
            throttleIndex++;
          } else if (result === 'already_exists') {
            skipped++;
          } else {
            failed++;
          }
        }
        return jsonResponse({
          found: pending.results.length,
          triggered,
          skipped,
          failed,
          drain_wall_time_estimate_min: Math.round((throttleIndex * 5) / 60),
        }, 200, request, env);
      }
      // POST /api/admin/fill-translations-now?limit=30&batch_size=8
      // 鉴权：HTTP Basic Auth (ADMIN_USER / ADMIN_PASS)，与其他 /api/admin/* 一致
      // 用途：手动批量补翻积压（X content / quote_of / link_card + PH content / maker / comments）
      if (path === '/api/admin/fill-translations-now' && request.method === 'POST') {
        if (!checkAdminAuth(request, env)) {
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
    // 单 tick batch=3 + 5s/detail 节流 = 15-24s 内于 worker 30s wall。
    // 全天 48 tick × 3 = 144 detail/天，覆盖每天 ~150 新 event 增量。
    const isHdxEnrichSlot = minute === 20 || minute === 50;

    // Huodongxing 历史活动 sweep：BJT 03:00 (UTC 19:00)，每日清扫一次
    const isHdxSweepSlot = hour === 19 && minute === 0;

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
            const r = await runPhDailyFetch(env);
            console.log(`[cron] ph-daily-fetch result:`, JSON.stringify(r));
            await notifyCronSummary(env, 'PH 每日抓取', r as unknown as Record<string, unknown>);
            return;
          }
          // ─── X list-poll-ingest (minute=25 / 55, 30 min cadence) ──
          // ScrapeBadger 替代本地 chrome list 抓取。
          // 提到 preempt 之前：之前在 preempt 之后，fill-translations 等
          // pending 长尾 hijack tick，X 30h+ 没新数据（2026-05-13 实测）。
          // 现在跟 PH daily fetch 同级，:25 / :55 时直接跑 + return。
          if (mode === 'list-poll-ingest') {
            const listId = env.LIST_POLL_LIST_ID || '1643236611378008066';
            const r = await runListPollIngest(env, listId, 3);
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
            await notifyCronSummary(env, 'X List 抓取', r as unknown as Record<string, unknown>);
            return;
          }
          // ─── Huodongxing scheduling (Phase 3) ─────────────────────────
          //   起跑：BJT 04:30/16:30 reset state，开抓
          //   接力：状态机 KV 有 cities_pending 时继续
          //   enrich：minute=20/50 跑 batch=3 detail（节流后 15-24s 单 tick）
          //   sweep：BJT 03:00 标过期
          if (isHdxFetchStartSlot) {
            const r = await runHuodongxingFetchList(env, { budget: 40, reset: true });
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
                  const r = await runHuodongxingFetchList(env, { budget: 40 });
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
            const r = await markStaleEventsHistorical(env);
            console.log(`[cron] hdx-sweep result:`, JSON.stringify(r));
            return;
          }
          // 阶段 5 (2026-05-16): huodongxing detail enrich 迁 CF Workflow
          // (HuodongxingDetailWorkflow)。runHuodongxingFetchList 对每条新事件
          // 触发 instance，5s/instance throttleSec 错开避免 site rate limit。
          // isHdxEnrichSlot preempt 已删。老 batch runHuodongxingDetailEnrich
          // 保留作 admin fallback (/api/admin/hdx-enrich-now)。
          // GH 抓取链已迁 CF Workflow (worker/src/workflows/github-pipeline.ts)。
          // Phase 1 (github-fetch slot) 写 stub 行 + 立刻 create Workflow instance，
          // instance 自己跑 enrich / classify / r2-migrate / readme-translate。
          // 之前的 3 个 preempt 分支 (github-enrich / github-r2-migrate /
          // github-readme-translate) 已移除。设计：docs/plans/2026-05-16-github-pipeline-workflows-design.md
          //
          // 老 pending item 兜底：用 /api/admin/gh-trigger-pending-workflows-now
          // 手动 drain（迁移后一次性即可，未来正常流程不会再产生 pending）。
          if (mode !== 'github-fetch') {
            // PH enrich — DeepSeek 一次性产 is_ai + ai_category + ai_summary
            // (仿 github-enrich 模式)。先于 fill-translations 跑：is_relevant=0
            // 的 PH item 不进翻译流程，省 DeepSeek 翻译额度。
            // 每 tick 10 个 item，30/天 ~3 tick 完成。
            const phEnrichPending = await env.DB.prepare(
              `SELECT count(*) AS n FROM items
                WHERE source_type='product_hunt' AND deleted_at IS NULL AND is_relevant IS NULL`,
            ).first<{ n: number }>();
            if ((phEnrichPending?.n ?? 0) > 0) {
              const r = await runPhEnrich(env, 10);
              console.log(`[cron] ph-enrich (preempt, ${phEnrichPending?.n} pending) result:`, JSON.stringify(r));
              return;
            }
            // X 主链 classify + fill-translations 已迁 CF Workflow (阶段 4 cutover
            // 2026-05-16)。每条新 tweet 由 runListPollIngest 触发 instance，跑 5 step
            // pipeline 含 classify + 翻译。preempt cron 删了，老 batch 函数保留作
            // /api/enrich/run?mode=classify-pending|fill-translations 兜底（Bearer
            // INGEST_TOKEN）+ /api/admin/x-trigger-pending-workflows-now 手动 drain。
            //
            // PH fill-translations 仍走 preempt 而非 workflow（PH 量小、跟 X 流水
            // 解耦），但走的是同一个 runFillTranslations batch 函数 — 这里改 SQL
            // 范围只保留 PH，X 的翻译完全交给 workflow。
            const phTranslatePending = await env.DB.prepare(
              `SELECT count(*) AS n FROM items
                 WHERE deleted_at IS NULL AND is_relevant=1
                   AND source_type='product_hunt' AND (
                     (content_translated IS NULL AND content IS NOT NULL)
                     OR (json_extract(extra, '$.maker_post_text') IS NOT NULL
                         AND json_extract(extra, '$.maker_post_translated') IS NULL)
                     OR (json_extract(extra, '$.top_comments') IS NOT NULL
                         AND EXISTS (
                           SELECT 1 FROM json_each(json_extract(extra, '$.top_comments')) AS c
                           WHERE json_extract(c.value, '$.text') IS NOT NULL
                             AND json_extract(c.value, '$.translated') IS NULL
                         ))
                   )`,
            ).first<{ n: number }>();
            if ((phTranslatePending?.n ?? 0) > 0) {
              const r = await runFillTranslations(env, 15, 5);
              console.log(`[cron] fill-translations PH (preempt, ${phTranslatePending?.n} pending) result:`, JSON.stringify(r));
              return;
            }
            // ClawHub enrich pending — 抢占同一 cron slot，每 tick 8 个 item。
            // 内部用 Promise.all 并行，wall clock 一 tick ~6s（瓶颈最长一条）。
            // 单 item subrequest 预算：1 detail + 1 readme + 3 LLM call + 1 UPDATE ≈ 6
            // → 8 × 6 = 48 subreq/tick (CF Paid 1000 上限内非常宽松)。
            //
            // 2026-05-11 PR #4 hotfix: 移到 X classify / 翻译之后。优先 UX 直接
            // 感知的中文翻译，ClawHub enrich 是后台丰富化慢点 OK。
            const clawhubPending = await countClawhubPending(env);
            if (clawhubPending > 0) {
              const r = await runClawhubEnrichPending(env, 8);
              console.log(`[cron] clawhub-enrich (preempt, ${clawhubPending} pending) result:`, JSON.stringify(r));
              return;
            }
            // PH 资源迁移 — 优先级最低（移到所有翻译/分类之后）。
            // 之前在 ph-enrich 后面，但 9 PH item r2 pending 会占 9 个 cron tick，
            // fill-translations 永远等不到，prod 用户看不到中文翻译。改成 r2 在
            // 所有翻译之后跑：用户先看到中文内容，r2 域名替换属后台过程慢慢补。
            // 单次 1 个 item，subrequest 预算：1 SELECT + 1 × (~38 GET + 1 UPDATE) = 40。
            const phR2Pending = await countPhR2Pending(env);
            if (phR2Pending > 0) {
              const r = await runPhR2Migrate(env, 1);
              console.log(`[cron] ph-r2-migrate (preempt, ${phR2Pending} pending) result:`, JSON.stringify(r));
              return;
            }
          }
          if (mode === 'github-fetch') {
            const r = await runGithubFetchTrending(env);
            console.log(`[cron] github-fetch result:`, JSON.stringify(r));
            await notifyCronSummary(env, 'GitHub Trending 抓取', r as unknown as Record<string, unknown>);
            return;
          }
          if (mode === 'clawhub-fetch') {
            const r = await runClawhubFetchList(env);
            console.log(`[cron] clawhub-fetch result:`, JSON.stringify(r));
            await notifyCronSummary(env, 'ClawHub 列表抓取', r as unknown as Record<string, unknown>);
            return;
          }
          if (mode === 'refresh-metrics') {
            if (refreshMode === 'off') {
              console.log('[cron] refresh-metrics skipped (REFRESH_MODE=off)');
              return;
            }
            const result =
              refreshMode === 'tiered'
                ? await runRefreshTiered(env, 20, 400, maxTier)
                : await runRefreshMetrics(env);
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
            const result = await runCleanup(env);
            console.log(`[cron] cleanup result:`, JSON.stringify(result));
          }
        } catch (e) {
          console.error(`[cron] ${mode} error:`, e);
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
            extra = CASE
              WHEN (items.extra -> '$.longform') IS NOT NULL
                   OR (items.extra -> '$.enriched_at') IS NOT NULL
                THEN json_patch(
                  coalesce(excluded.extra, '{}'),
                  json_object(
                    'longform',    items.extra -> '$.longform',
                    'enriched_at', items.extra -> '$.enriched_at'
                  )
                )
              ELSE excluded.extra
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
  const r = await refreshSingleItem(env, id);
  return jsonResponse(r, 200, request, env);
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

  let siblings: Record<string, unknown>[] = [];
  if (threadRootId) {
    const result = await env.DB.prepare(
      `SELECT * FROM items
       WHERE source_type = ?
         AND extra ->> '$.thread_root_id' = ?
       ORDER BY published_at ASC, id ASC`
    ).bind(parsedItem.source_type, threadRootId).all();
    siblings = result.results.map(parseItemRow);
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

async function handleEnrichRun(request: Request, env: Env): Promise<Response> {
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
    const result = await runBackfillRetweets(env, limit, rateSleepMs);
    return jsonResponse(result, 200, request, env);
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

  // video 类型不走 CF cache — 因为 Range request 跟全量请求会污染同一 cache key，
  // 长视频 seek 时拿到完整流又不能 partial 响应。图片（pbs.twimg.com）继续 cache。
  const isVideo = targetUrl.hostname === 'video.twimg.com';
  const cfOptions = isVideo
    ? {}
    : { cf: { cacheTtl: 86400, cacheEverything: true } };

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
  }
  headers.set('Access-Control-Allow-Origin', '*');

  return new Response(upstream.body, {
    status: upstream.status, // 转发 200 或 206
    headers,
  });
}

// ─── GET /r/:key ───────────────────────────────────────────────
// Serve migrated README assets from R2 with long cache + CORS.
// Key shape: gh/<owner>/<repo>/<sha256>.<ext>

async function handleR2Asset(request: Request, env: Env, key: string): Promise<Response> {
  if (!env.READMES) return new Response('R2 not configured', { status: 503 });
  if (!key) return new Response('missing key', { status: 400 });

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
