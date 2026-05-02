import {
  runBackfillQuotes,
  runBackfillReplies,
  runReclassifyThreads,
  runCleanup,
  runRefreshMetrics,
  runRefreshTiered,
  runFillTranslations,
  runDetectLongform,
  listPendingLongform,
  submitLongformText,
} from './enrich';
import { handleTrack } from './track';
import {
  runGithubFetchTrending,
  runGithubEnrichPending,
  runGithubReadmeTranslate,
  runGithubR2Migrate,
  countGithubPending,
  countGithubReadmeTranslatePending,
  countGithubR2Pending,
} from './github';
import {
  handleSmsSend,
  handleLogin,
  handleLogout,
  handleLogoutAll,
  handleMe,
  handleDelete,
} from './auth/handlers';
import {
  serveAdminHtml,
  adminSmsStatus,
  adminUnlockSms,
  adminUser,
  adminCleanupAccount,
  adminDailyCap,
} from './admin';

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
  // CF Browser Rendering binding — used by PH source POC + Phase 2 scraper.
  // Set in wrangler.toml `[browser] binding = "BROWSER"`.
  // Requires Workers Paid plan (10h browser/month included).
  BROWSER?: Fetcher;
}

// CORS origins allowed
const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:3000',
  'https://ai-feeds.com',
  'https://www.ai-feeds.com',
];

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin') || '';
  // Allow any *.pages.dev, ai-feeds.com, configured localhost origins,
  // or any localhost:<port> / 127.0.0.1:<port> for dev convenience
  // (Vite often falls back to 5174+ when 5173 is in use)
  const allowed =
    ALLOWED_ORIGINS.includes(origin) ||
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
      if (path === '/img' && request.method === 'GET') {
        return handleImageProxy(request);
      }
      if (path.startsWith('/r/') && (request.method === 'GET' || request.method === 'HEAD')) {
        return handleR2Asset(request, env, path.slice(3));
      }
      if (path === '/poc/ph' && request.method === 'GET') {
        const { handlePhPoc } = await import('./scrapers/ph_poc');
        return handlePhPoc(request, env);
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

    // GitHub enrich (phase 2) opportunistic: on any tick where pending exists,
    // preempt this slot for one repo's enrich (~9 subrequests vs running an X
    // mode). Phase-1 is only twice/day, so ≤20 enriches/day to drain → at most
    // 20 X cron slots stolen, ~7% of 288/day.
    let mode: 'refresh-metrics' | 'fill-translations' | 'backfill-quotes' | 'backfill-replies' | 'cleanup' | 'detect-longform' | 'github-fetch' | 'github-enrich';
    if (isGithubFetchSlot) mode = 'github-fetch';
    else if (hour === 3 && minute === 35) mode = 'cleanup';
    else if (minute === 0 || minute === 30) mode = 'refresh-metrics';
    else if (minute === 15 || minute === 45) mode = 'fill-translations';
    else if (minute === 10 || minute === 50) mode = 'detect-longform';
    else if (minute === 5 || minute === 35) mode = 'backfill-replies';
    else mode = 'backfill-quotes';
    const refreshMode = (env.REFRESH_MODE || 'legacy').toLowerCase();
    const maxTier = Math.min(
      Math.max(parseInt(env.REFRESH_TIER_MAX || '1', 10) || 1, 0),
      4,
    );
    ctx.waitUntil(
      (async () => {
        try {
          // Github preempt order (each preempt drains a batch sequentially —
          // no 5-min gap between rows):
          //   1. enrich (initial API + LLM judge, ~5-10s/row)
          //   2. r2-migrate (download + upload assets, ~5-15s/row capped 8 assets)
          //   3. readme-translate (DeepSeek translate, ~3-5s/row)
          //   ↓ if no github work, fall through to X cron rotation.
          // github-fetch slot itself never gets preempted (it's the only window
          // for fresh trending data).
          //
          // Per-tick batch sizes sized to fit ~30s of wall time — drain queue
          // fast without bumping CF Worker time limit. translate is the
          // cheapest so largest batch.
          if (mode !== 'github-fetch') {
            const pending = await countGithubPending(env);
            if (pending > 0) {
              const r = await runGithubEnrichPending(env, 3);
              console.log(`[cron] github-enrich (preempt, ${pending} pending) result:`, JSON.stringify(r));
              return;
            }
            const r2Pending = await countGithubR2Pending(env);
            if (r2Pending > 0) {
              // Bumped per-repo cap to 20; lower batch size to 1 so each tick
              // does one repo fully (vs 2 partial repos). Subrequest budget:
              // 1 SELECT + 1 × (20 GET + 1 UPDATE) = 22 (CF Free 50 OK).
              const r = await runGithubR2Migrate(env, 1);
              console.log(`[cron] github-r2-migrate (preempt, ${r2Pending} pending) result:`, JSON.stringify(r));
              return;
            }
            const trPending = await countGithubReadmeTranslatePending(env);
            if (trPending > 0) {
              const r = await runGithubReadmeTranslate(env, 6);
              console.log(`[cron] github-readme-translate (preempt, ${trPending} pending) result:`, JSON.stringify(r));
              return;
            }
          }
          if (mode === 'github-fetch') {
            const r = await runGithubFetchTrending(env);
            console.log(`[cron] github-fetch result:`, JSON.stringify(r));
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
          const result =
            mode === 'cleanup'
              ? await runCleanup(env)
              : mode === 'fill-translations'
                ? await runFillTranslations(env)
                : mode === 'detect-longform'
                  ? await runDetectLongform(env, 25, 400)
                  : mode === 'backfill-replies'
                    ? await runBackfillReplies(env, 40, 200)
                    : await runBackfillQuotes(env);
          console.log(`[cron] ${mode} result:`, JSON.stringify(result));
        } catch (e) {
          console.error(`[cron] ${mode} error:`, e);
        }
      })(),
    );
  },
};

// ─── POST /api/ingest ──────────────────────────────────────────

interface IngestPayload {
  source?: { id?: string; cursor?: string; last_success_at?: string };
  items: ItemInput[];
}

interface ItemInput {
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
  if (body.items.length > 500) {
    return jsonResponse({ error: 'Max 500 items per request' }, 400, request, env);
  }

  let inserted = 0;
  let updated = 0;
  const errors: { source_id: string; error: string }[] = [];

  // Process in batches of 100 (D1 batch limit)
  const BATCH_SIZE = 100;
  for (let i = 0; i < body.items.length; i += BATCH_SIZE) {
    const batch = body.items.slice(i, i + BATCH_SIZE);
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

  // Update source cursor if provided
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

  // Adjust counts: inserted includes both inserts and updates from upsert
  // For accurate counts we'd need to check pre-existence, but for MVP this is fine
  return jsonResponse({ inserted, updated: 0, errors }, 200, request, env);
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
  const orderBy = isHot
    ? `${HOT_EXPR} DESC, id DESC`
    : `${sort} DESC, id DESC`;
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

  // For GitHub items, attach metrics_history (last 30 days) so drawer can
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
  if (mode === 'reclassify-threads') {
    const dryRun = url.searchParams.get('dry_run') !== '0';
    const result = await runReclassifyThreads(env, dryRun);
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

  const upstream = await fetch(targetUrl.toString(), {
    cf: { cacheTtl: 86400, cacheEverything: true },
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ai-feeds-img-proxy/1.0)' },
  });

  if (!upstream.ok) {
    return new Response('upstream failed', { status: upstream.status });
  }

  const headers = new Headers();
  const ct = upstream.headers.get('content-type');
  if (ct) headers.set('Content-Type', ct);
  headers.set('Cache-Control', 'public, max-age=604800, immutable');
  headers.set('Access-Control-Allow-Origin', '*');

  return new Response(upstream.body, {
    status: 200,
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
