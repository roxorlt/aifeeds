// 行业要闻滚动热榜（hot.ai-feeds.com）。
//
// 三条硬规矩（设计稿 2026-09-06 B1/B2）：
//   1. 快照只由 cron（每 30 分钟）与手动入口（POST /api/enrich/run?mode=hot-news-snapshot）生产，
//      对外读路径绝不现算 —— 公开接口无鉴权无限流，现算等于把 D1 直接暴露给任何人。
//   2. 计算走纯打分层：selectNewsByScoreWithAudit(editorialReview:false)，不调大模型，
//      窗口沿用 news 的「此刻往前 3 天」（不传 asOfDate）。
//   3. 只存最新一份：KV `hot:news:72h` 是热路径，D1 hot_news_snapshots 一行一窗口作持久副本。
//
// 物化查询用 json_each(?) 单参数绑定（D1 单语句绑参上限 100，按条数展开会随榜长突然崩），
// 一次往返取回全部展示字段。

import type { Env } from '../index';
import { selectNewsByScoreWithAudit, type NewsSelectionAuditEntry } from './selection';

export const HOT_NEWS_HOSTNAME = 'hot.ai-feeds.com';
export const HOT_NEWS_PATH = '/api/hot/news';
export const HOT_NEWS_WINDOW_HOURS = 72;
export const HOT_NEWS_LIMIT = 20;
export const HOT_NEWS_KV_KEY = 'hot:news:72h';
/** 边缘缓存挡量：浏览器 60s、CDN 5 分钟；快照本身每 30 分钟才换一次。 */
export const HOT_NEWS_CACHE_CONTROL = 'public, max-age=60, s-maxage=300';

export interface HotNewsSnapshotItem {
  rank: number;
  id: string;
  title_zh: string;
  summary_zh: string;
  source: string;
  url: string;
  published_at: string;
  score: number | null;
  event_source_count: number;
}

export interface HotNewsSnapshot {
  version: 1;
  computed_at: string;
  window_hours: number;
  limit: number;
  item_count: number;
  items: HotNewsSnapshotItem[];
}

interface HotNewsDisplayRow {
  id: string;
  title: string | null;
  url: string | null;
  published_at: string | null;
  title_zh: string | null;
  ai_summary_zh: string | null;
  summary_zh: string | null;
  source_company: string | null;
}

/**
 * hot host 上 `/` 与 `/news` 映射到同一个 handler；`/api/hot/news` 在任何 host 上都可用
 * （api.ai-feeds.com 经香港中转，仅作内部/调试用）。
 */
export function isHotNewsRequestPath(hostname: string, path: string): boolean {
  if (path === HOT_NEWS_PATH) return true;
  return hostname === HOT_NEWS_HOSTNAME && (path === '/' || path === '/news');
}

/** 只读、无鉴权、无 credentials 的公开接口：CORS 一律放开到 `*`。 */
export function hotNewsCorsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

// extra 不是合法 JSON 时退回空对象:与 selection.ts 的授权查询逐字同一种写法。
const SAFE_EXTRA = `CASE WHEN i.extra IS NOT NULL AND json_valid(i.extra) = 1 THEN i.extra ELSE '{}' END`;
// 只取展示要用的四个 extra 字段,不把整个 extra blob（blog 正文可能几十 KB）拉进 Worker。
const HOT_NEWS_DISPLAY_SQL = `/* hot_news:materialize */
WITH requested AS (SELECT value AS id FROM json_each(?))
SELECT i.id, i.title, i.url, i.published_at,
       json_extract(${SAFE_EXTRA}, '$.title_zh') AS title_zh,
       json_extract(${SAFE_EXTRA}, '$.ai_summary_zh') AS ai_summary_zh,
       json_extract(${SAFE_EXTRA}, '$.summary_zh') AS summary_zh,
       json_extract(${SAFE_EXTRA}, '$.source_company') AS source_company
  FROM requested q
  CROSS JOIN items i ON i.id = q.id
 WHERE i.deleted_at IS NULL`;

async function fetchHotNewsDisplayRows(env: Env, ids: readonly string[]): Promise<HotNewsDisplayRow[]> {
  if (!ids.length) return [];
  const result = await env.DB.prepare(HOT_NEWS_DISPLAY_SQL)
    .bind(JSON.stringify([...ids]))
    .all<HotNewsDisplayRow>();
  return result.results || [];
}

/**
 * 算一份最新快照。条目在选品之后被删（items 行没了或 deleted_at 有值）时**原样发布、不补位**，
 * item_count 如实反映实际条数 —— 补位要么再查一次库，要么让榜单顺序与打分脱节，两样都不值。
 */
export async function computeHotNewsSnapshot(env: Env, now = Date.now()): Promise<HotNewsSnapshot> {
  const { ids, audit } = await selectNewsByScoreWithAudit(env, HOT_NEWS_LIMIT, {
    editorialReview: false,
    strictCrossDayEventDedup: true,
  });
  const auditById = new Map<string, NewsSelectionAuditEntry>(
    (audit?.candidates || []).map((entry) => [entry.id, entry]),
  );
  const rows = await fetchHotNewsDisplayRows(env, ids);
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const items: HotNewsSnapshotItem[] = [];
  for (const id of ids) {
    const row = rowById.get(id);
    if (!row) continue;
    const entry = auditById.get(id);
    items.push({
      rank: items.length + 1,
      id,
      title_zh: row.title_zh || entry?.title_zh || row.title || entry?.title || '',
      summary_zh: row.ai_summary_zh || row.summary_zh || '',
      source: entry?.source_company || row.source_company || '',
      url: row.url || '',
      published_at: row.published_at || entry?.published_at || '',
      score: typeof entry?.adjusted_score === 'number' ? entry.adjusted_score : null,
      event_source_count: typeof entry?.event_source_count === 'number' ? entry.event_source_count : 0,
    });
  }
  return {
    version: 1,
    computed_at: new Date(now).toISOString(),
    window_hours: HOT_NEWS_WINDOW_HOURS,
    limit: HOT_NEWS_LIMIT,
    item_count: items.length,
    items,
  };
}

/** 覆盖写：先落 D1（持久副本），再写 KV（热路径）。KV 写失败不算整轮失败，读路径会回源 D1。 */
export async function storeHotNewsSnapshot(
  env: Env,
  snapshot: HotNewsSnapshot,
): Promise<{ kv_written: boolean }> {
  const payload = JSON.stringify(snapshot);
  await env.DB.prepare(
    `INSERT INTO hot_news_snapshots (window_hours, computed_at, payload_json, item_count)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(window_hours) DO UPDATE SET
       computed_at = excluded.computed_at,
       payload_json = excluded.payload_json,
       item_count = excluded.item_count`,
  )
    .bind(snapshot.window_hours, snapshot.computed_at, payload, snapshot.item_count)
    .run();
  try {
    await env.AUTH_KV.put(HOT_NEWS_KV_KEY, payload);
    return { kv_written: true };
  } catch (error) {
    console.error('[hot-news] KV put failed, D1 copy still authoritative:', error);
    return { kv_written: false };
  }
}

export interface HotNewsSnapshotRunResult {
  ok: true;
  window_hours: number;
  computed_at: string;
  item_count: number;
  kv_written: boolean;
}

/** cron（每 30 分钟）与手动入口共用的整轮：算一份 → 覆盖写 KV + D1。 */
export async function runHotNewsSnapshot(env: Env, now = Date.now()): Promise<HotNewsSnapshotRunResult> {
  const snapshot = await computeHotNewsSnapshot(env, now);
  const stored = await storeHotNewsSnapshot(env, snapshot);
  return {
    ok: true,
    window_hours: snapshot.window_hours,
    computed_at: snapshot.computed_at,
    item_count: snapshot.item_count,
    kv_written: stored.kv_written,
  };
}

function parseSnapshot(payload: string | null): HotNewsSnapshot | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as HotNewsSnapshot;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 读路径：KV → 缺则 D1 → 都缺返回 null（调用方 503）。任何分支都不现算。 */
export async function readHotNewsSnapshot(env: Env): Promise<HotNewsSnapshot | null> {
  let cached: string | null = null;
  try {
    cached = await env.AUTH_KV.get(HOT_NEWS_KV_KEY);
  } catch (error) {
    console.error('[hot-news] KV get failed, falling back to D1:', error);
  }
  const fromKv = parseSnapshot(cached);
  if (fromKv) return fromKv;
  const row = await env.DB.prepare(
    `/* hot_news:read_fallback */ SELECT payload_json FROM hot_news_snapshots WHERE window_hours = ?`,
  )
    .bind(HOT_NEWS_WINDOW_HOURS)
    .first<{ payload_json: string }>();
  return parseSnapshot(row?.payload_json ?? null);
}

function hotNewsResponse(payload: unknown, status: number, extraHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...hotNewsCorsHeaders(),
      ...extraHeaders,
    },
  });
}

/** GET /api/hot/news?limit=&window_hours= —— 只读快照，绝不现算。 */
export async function handleHotNewsRequest(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return hotNewsResponse({ ok: false, error: 'method_not_allowed' }, 405, {
      'Cache-Control': 'no-store',
    });
  }
  const url = new URL(request.url);
  const windowParam = url.searchParams.get('window_hours');
  if (windowParam && Number(windowParam) !== HOT_NEWS_WINDOW_HOURS) {
    return hotNewsResponse(
      { ok: false, error: 'unsupported_window', window_hours: HOT_NEWS_WINDOW_HOURS },
      400,
      { 'Cache-Control': 'no-store' },
    );
  }
  const limitParam = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(limitParam) && limitParam > 0
    ? Math.min(Math.floor(limitParam), HOT_NEWS_LIMIT)
    : HOT_NEWS_LIMIT;
  const snapshot = await readHotNewsSnapshot(env);
  if (!snapshot) {
    return hotNewsResponse({ ok: false, error: 'snapshot_unavailable' }, 503, {
      'Cache-Control': 'no-store',
      'Retry-After': '60',
    });
  }
  const items = snapshot.items.slice(0, limit);
  return hotNewsResponse(
    {
      version: snapshot.version,
      computed_at: snapshot.computed_at,
      window_hours: snapshot.window_hours,
      limit,
      item_count: items.length,
      items,
    },
    200,
    { 'Cache-Control': HOT_NEWS_CACHE_CONTROL },
  );
}
