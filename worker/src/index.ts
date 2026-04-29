import {
  runBackfillQuotes,
  runCleanup,
  runRefreshMetrics,
  runRefreshTiered,
  runFillTranslations,
} from './enrich';

export interface Env {
  DB: D1Database;
  INGEST_TOKEN: string;
  DEEPSEEK_API_KEY?: string;
  // M4: refresh-metrics mode dispatch.
  //   'tiered'  → runRefreshTiered (uses tier/next_refresh_at/last_velocity)
  //   'legacy'  → runRefreshMetrics (round-robin, default — preserves pre-M4 behavior)
  //   'off'     → skip refresh entirely
  REFRESH_MODE?: string;
  // Cap on which tiers the tiered refresher touches. Default '1' = gradual
  // rollout (L0+L1 only); set to '4' for full coverage once stable.
  REFRESH_TIER_MAX?: string;
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
  // Allow any *.pages.dev, ai-feeds.com, or configured localhost origins
  const allowed = ALLOWED_ORIGINS.includes(origin) || origin.endsWith('.pages.dev');
  return {
    'Access-Control-Allow-Origin': allowed ? origin : '',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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
      if (path === '/api/sources' && request.method === 'GET') {
        return handleSources(request, env);
      }
      if (path === '/api/stats' && request.method === 'GET') {
        return handleStats(request, env);
      }
      if (path === '/api/enrich/run' && request.method === 'POST') {
        return handleEnrichRun(request, env);
      }
      if (path === '/img' && request.method === 'GET') {
        return handleImageProxy(request);
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
    //   others (8 slots)  → backfill-quotes     (8x/hour)
    // 2026-04-21: rolled back from fill-heavy. Backlog cleared — only ~0.3%
    // of quote_pending is non-Chinese, so 2/hr sentinel is enough for incoming.
    // backfill-quotes is the real bottleneck (syndication API hydration).
    const utc = new Date(event.scheduledTime);
    const minute = utc.getUTCMinutes();
    const hour = utc.getUTCHours();
    // 03:35 UTC daily → cleanup (steals one backfill slot per day, runs ~1s)
    const isCleanupSlot = hour === 3 && minute === 35;
    let mode: 'refresh-metrics' | 'fill-translations' | 'backfill-quotes' | 'cleanup';
    if (isCleanupSlot) mode = 'cleanup';
    else if (minute === 0 || minute === 30) mode = 'refresh-metrics';
    else if (minute === 15 || minute === 45) mode = 'fill-translations';
    else mode = 'backfill-quotes';
    const refreshMode = (env.REFRESH_MODE || 'legacy').toLowerCase();
    const maxTier = Math.min(
      Math.max(parseInt(env.REFRESH_TIER_MAX || '1', 10) || 1, 0),
      4,
    );
    ctx.waitUntil(
      (async () => {
        try {
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
            content = excluded.content,
            content_translated = excluded.content_translated,
            media = excluded.media,
            metrics = excluded.metrics,
            is_relevant = excluded.is_relevant,
            matched_by = excluded.matched_by,
            extra = excluded.extra
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
  return jsonResponse({ error: `Unknown mode: ${mode}` }, 400, request, env);
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
