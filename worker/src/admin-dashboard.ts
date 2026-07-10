// /admin/dashboard 仪表盘：基于 events 表算 DAU/WAU/MAU、留存、漏斗、会话时长、错误分桶等。
// JSON endpoint 在 /api/admin/analytics?metric=<name>，HTML 在 serveAdminDashboardHtml。
// 鉴权同其他 /api/admin/* — Cloudflare Access JWT（Basic Auth fallback，见 admin.ts checkAdminAuth）。

import type { Env } from './index';
import { ADMIN_SHARED_CSS, adminNavHtml, requireAuth, jsonRes } from './admin';

// ─── /api/admin/analytics?metric=<name> ─────────────────────────
export async function handleAdminAnalytics(request: Request, env: Env): Promise<Response> {
  const guard = await requireAuth(request, env);
  if (guard) return guard;

  const url = new URL(request.url);
  const metric = url.searchParams.get('metric') || 'overview';

  switch (metric) {
    case 'overview':
      return jsonRes(await metricOverview(env));
    case 'dau-trend':
      return jsonRes(await metricDauTrend(env));
    case 'retention':
      return jsonRes(await metricRetention(env));
    case 'returning':
      return jsonRes(await metricReturning(env));
    case 'event-distribution':
      return jsonRes(await metricEventDistribution(env));
    case 'funnel':
      return jsonRes(await metricFunnel(env));
    case 'session-duration':
      return jsonRes(await metricSessionDuration(env));
    case 'errors':
      return jsonRes(await metricErrors(env));
    case 'error-trend':
      return jsonRes(await metricErrorTrend(env));
    case 'top-devices':
      return jsonRes(await metricTopDevices(env));
    case 'channel-dwell':
      return jsonRes(await metricChannelDwell(env));
    case 'drawer-by-source':
      return jsonRes(await metricDrawerBySource(env));
    case 'dub-wishlist':
      return jsonRes(await metricDubWishlist(env));
    case 'feed-depth':
      return jsonRes(await metricFeedDepth(env));
    case 'load-perf':
      return jsonRes(await metricLoadPerf(env));
    case 'search':
      return jsonRes(await metricSearch(env));
    default:
      return jsonRes({ error: `unknown metric: ${metric}`, available: [
        'overview', 'dau-trend', 'retention', 'returning', 'event-distribution',
        'funnel', 'session-duration', 'errors', 'error-trend',
        'top-devices', 'channel-dwell', 'drawer-by-source', 'feed-depth',
        'load-perf', 'dub-wishlist', 'search',
      ] }, 400);
  }
}

// Error event types — 与 metricErrors 保持一致，error-trend 走同一名单，
// event-distribution / dau-trend 用来排除（避免错误事件混进业务统计）。
const ERROR_EVENT_TYPES = ['api_error', 'js_error', 'feed_load_error', 'image_load_error', 'unhandled_promise'];

// Bot UA 过滤 — 用于 retention / top-devices 等"人"指标。这些 UA 子串虽然在
// worker 入口已经被 isBlockedBot 拦了大部分，但有些 bot（如 Twitterbot / 老 Bingbot
// / 部分爬虫）走 SEO 白名单仍能跑 JS 进 events 表，会污染留存数字。
// SQL 用一段 OR 表达式拼到 NOT (...)，复用统一名单。
const BOT_UA_LIKE = `(
  ua LIKE '%bot%' OR ua LIKE '%Bot%' OR ua LIKE '%BOT%'
  OR ua LIKE '%spider%' OR ua LIKE '%Spider%'
  OR ua LIKE '%crawler%' OR ua LIKE '%Crawler%'
  OR ua LIKE '%python-requests%' OR ua LIKE '%Python-urllib%'
  OR ua LIKE 'curl/%' OR ua LIKE 'Wget/%'
  OR ua LIKE 'Go-http-client%' OR ua LIKE 'okhttp%'
  OR ua = ''
)`;

// 项目 owner 的 device：从报表里整体踢掉，避免自己开发 / 测试访问污染数据。
// 两层识别：
//   1. OWNER_EMAILS — 登录过的 email，自动反查 user_id → events.user_id → device_id
//   2. OWNER_DEVICE_IDS — 没登录就用的 device，手动加（看 top-devices 表挑明显的）
// 业务读取的所有 device 维度 metric (retention / dau-trend / top-devices /
// channel-dwell / drawer-by-source / feed-depth) 都套上 NOT IN (owner_devices)。
const OWNER_EMAILS = ['ltsms86@gmail.com'];
const OWNER_DEVICE_IDS = [
  'XVsq80drDCUOo3CSXJbrm',  // active_days 17, user_id=null（chrome 隐身 / 测试 profile）
  'isNbeSgimLuEPGnI4dvF9',  // active_days 15, 关联 ltsms86 user（冗余覆盖）
];

// SQL fragment: device_id 子查询，含 owner 的所有 device。CTE 形式给 caller 用：
//   WITH owner_devices AS (${OWNER_DEVICE_CTE}) SELECT ... WHERE device_id NOT IN owner_devices
// 两个数据源 union：
//   1. events.user_id 关联到 identities.user_id 匹配 OWNER_EMAILS（自动发现登录设备）
//   2. OWNER_DEVICE_IDS hardcoded（未登录设备手动加）
const OWNER_DEVICE_CTE = (() => {
  const emails = OWNER_EMAILS.map((e) => `'${e.replace(/'/g, "''")}'`).join(',');
  const deviceUnions = OWNER_DEVICE_IDS.map((d) => `SELECT '${d.replace(/'/g, "''")}' AS device_id`).join(' UNION ');
  const fromEmail = `
    SELECT DISTINCT device_id FROM events
    WHERE user_id IN (
      SELECT user_id FROM identities
      WHERE identity_value IN (${emails || "''"}) AND unbound_at IS NULL
    )`;
  return deviceUnions ? `${fromEmail} UNION ${deviceUnions}` : fromEmail;
})();

// 直接拼到 WHERE 子句的 fragment：device_id NOT IN (...owner devices...)
const NOT_OWNER_SQL = `device_id NOT IN (${OWNER_DEVICE_CTE})`;

export const PERFORMANCE_ENGAGEMENT_EVENTS = [
  'item_click',
  'item_open_drawer',
  'image_lightbox_open',
  'external_link_click',
  'source_filter_change',
  'sort_change',
  'new_content_banner_click',
  'search_submit',
  'search_suggest_click',
  'search_result_click',
  'share_click',
  'login_success',
  'favorite_toggle',
  'subscribe_toggle',
] as const;

export type PerformanceCohortName = 'all_clean' | 'engaged' | 'synthetic';

export function performanceCohortWhere(cohort: PerformanceCohortName, alias: string = 'e'): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error('invalid SQL alias');
  const syntheticMarker = `(
    json_extract(${alias}.event_payload,'$.traffic_kind') = 'synthetic'
    OR instr(COALESCE(${alias}.page_path,''), 'codex_perf_probe') > 0
  )`;
  if (cohort === 'synthetic') return syntheticMarker;

  const allClean = `
    ${alias}.device_id NOT IN (${OWNER_DEVICE_CTE})
    AND NOT ${syntheticMarker}
  `;
  if (cohort === 'all_clean') return allClean;

  const actions = PERFORMANCE_ENGAGEMENT_EVENTS.map((event) => `'${event}'`).join(',');
  return `
    ${allClean}
    AND EXISTS (
      SELECT 1 FROM events action
      WHERE action.device_id = ${alias}.device_id
        AND action.event_type IN (${actions})
        AND ABS(action.occurred_at - ${alias}.occurred_at) <= 30 * 60 * 1000
        AND (
          (${alias}.session_token_hash IS NOT NULL AND action.session_token_hash = ${alias}.session_token_hash)
          OR (${alias}.session_token_hash IS NULL AND action.session_token_hash IS NULL)
        )
    )
  `;
}

interface PerformanceCohortData {
  overall: Array<{ metric: string; p50: number; p75: number; p95: number; samples: number }>;
  slices: unknown[];
}

export function shapePerformanceAnalyticsOutput(
  allClean: PerformanceCohortData,
  engaged: PerformanceCohortData,
  synthetic: PerformanceCohortData,
) {
  return {
    all_clean: allClean,
    engaged,
    synthetic,
    // Backward-compatible aliases consumed by the existing embedded dashboard JS.
    overall: allClean.overall,
    slices: allClean.slices,
  };
}

// "真实用户" device 子查询 — 排除 itdog/ping 测速、link preview 爬虫、SEO 监控
// 等"打开页面就走"的合成流量。判定:30 天内有 interact 事件 (点击/抽屉/视频/筛选/
// impression 等) OR 总停留 > 5 秒。
// 2026-05-27: user 反馈今日 DAU 49 异常,排查发现 38 个零互动 < 5 秒,正是 itdog 全国
// 节点测速 (一次测速 30-50 个不同 device_id 独立 Chrome UA)。事件数据保留不动,只在
// metric query 加这层过滤。
// 窗口取 30 天 = 覆盖 MAU 最大需求;30 天内有过 1 次互动的 device,以后即使快速访问也算真人。
const REAL_USER_INTERACT_EVENTS = [
  'item_click',
  'item_open_drawer',
  'video_play_start',
  'video_effective_play',
  'image_lightbox_open',
  'source_filter_change',
  'sort_change',
  'new_content_banner_click',
  'item_impression',
] as const;
const REAL_USER_DEVICE_CTE = `
  SELECT device_id FROM events
  WHERE occurred_at > (strftime('%s','now') - 30 * 86400) * 1000
  GROUP BY device_id
  HAVING MAX(CASE WHEN event_type IN (${REAL_USER_INTERACT_EVENTS.map((e) => `'${e}'`).join(',')}) THEN 1 ELSE 0 END) = 1
      OR (MAX(occurred_at) - MIN(occurred_at)) > 5000
`;
const IS_REAL_USER_SQL = `device_id IN (${REAL_USER_DEVICE_CTE})`;

async function metricOverview(env: Env) {
  // DAU "今日" = 自然日（BJT 0 点 - 当前时刻），不是最近 24h 滚动。
  // 滚动窗口的 bug：同一天里 DAU 可能上下波动 — 昨天某时段的 device 滑出窗口
  // 比新增的 device 还多 → DAU 下降。自然日窗口下一天内单调递增，BJT 24 点归零。
  //
  // BJT 今日 0 点的 unix 秒：strftime('%s', date('now','+8 hours'), '-8 hours')
  //   date('now','+8 hours') → BJT 当前日期 'YYYY-MM-DD'
  //   strftime('%s', 日期, '-8 hours') → 该 BJT 日期 0 点的 UTC unix 秒
  //
  // WAU / MAU 仍保留 last 7d / last 30d 滚动（业内 product analytics 标准）。
  const row = await env.DB.prepare(`
    SELECT
      COUNT(DISTINCT CASE WHEN occurred_at >= strftime('%s', date('now', '+8 hours'), '-8 hours') * 1000 THEN device_id END) AS dau,
      COUNT(DISTINCT CASE WHEN occurred_at > (strftime('%s','now')-7*86400)*1000 THEN device_id END) AS wau,
      COUNT(DISTINCT CASE WHEN occurred_at > (strftime('%s','now')-30*86400)*1000 THEN device_id END) AS mau,
      COUNT(DISTINCT device_id) AS total_devices,
      COUNT(*) AS total_events
    FROM events
    WHERE ${NOT_OWNER_SQL}
      AND ${IS_REAL_USER_SQL}
  `).first<{ dau: number; wau: number; mau: number; total_devices: number; total_events: number }>();

  // 同时算一下被过滤的合成流量数 (transparency 用,方便日后审计)
  const synth = await env.DB.prepare(`
    SELECT COUNT(DISTINCT device_id) AS synthetic_today
    FROM events
    WHERE occurred_at >= strftime('%s', date('now', '+8 hours'), '-8 hours') * 1000
      AND ${NOT_OWNER_SQL}
      AND device_id NOT IN (${REAL_USER_DEVICE_CTE})
  `).first<{ synthetic_today: number }>();

  return { ...row, synthetic_today: synth?.synthetic_today ?? 0 };
}

async function metricDauTrend(env: Env) {
  // events 列只算业务事件（排除 ERROR_EVENT_TYPES），人均事件数才有意义；
  // dau 列仍按所有事件去重 device 算（错误事件也算"那天来过"）。
  // 整个 query 排除 owner devices。
  const placeholders = ERROR_EVENT_TYPES.map(() => '?').join(',');
  const rs = await env.DB.prepare(`
    SELECT
      date(occurred_at/1000, 'unixepoch', '+8 hours') AS day,
      COUNT(DISTINCT device_id) AS dau,
      COUNT(CASE WHEN event_type NOT IN (${placeholders}) THEN 1 END) AS events
    FROM events
    WHERE occurred_at > (strftime('%s','now')-30*86400)*1000
      AND ${NOT_OWNER_SQL}
      AND ${IS_REAL_USER_SQL}
    GROUP BY day
    ORDER BY day
  `).bind(...ERROR_EVENT_TYPES).all();
  return { days: rs.results };
}

async function metricRetention(env: Env) {
  // Cohort × N-day retention. cohort_day = device 第一次出现的日期。
  // d1 / d3 / d7 = 那天首次访问的 device，N 天后是否还回访。
  // 排除 bot device：MAX(ua) 命中 BOT_UA_LIKE 的 device 整个剔除（这些"留存"
  // 都是噪声，bot 不会真回访）。
  const rs = await env.DB.prepare(`
    WITH bot_devices AS (
      SELECT device_id FROM events
      GROUP BY device_id
      HAVING MAX(CASE WHEN ${BOT_UA_LIKE} THEN 1 ELSE 0 END) = 1
    ),
    first_seen AS (
      SELECT device_id, MIN(date(occurred_at/1000,'unixepoch','+8 hours')) AS cohort_day
      FROM events
      WHERE device_id NOT IN (SELECT device_id FROM bot_devices)
        AND ${NOT_OWNER_SQL}
        AND ${IS_REAL_USER_SQL}
      GROUP BY device_id
    )
    SELECT
      fs.cohort_day,
      COUNT(DISTINCT fs.device_id) AS cohort_size,
      -- 成熟度门槛:cohort 还没到「第 N 天的次日」(age_days <= N,即第 N 天当天仍在累计
      -- 或更早还没到)时返回 NULL,前端渲染成「—」而非误导性的 0%。age_days = 今日(BJT)距
      -- cohort_day 的天数。只有 age_days > N(第 N 天已完整过完)才给出最终留存数。
      CASE WHEN CAST(julianday(date('now','+8 hours')) - julianday(fs.cohort_day) AS INTEGER) > 1
           THEN COUNT(DISTINCT CASE WHEN CAST(julianday(date(e.occurred_at/1000,'unixepoch','+8 hours')) - julianday(fs.cohort_day) AS INTEGER) = 1 THEN fs.device_id END)
           ELSE NULL END AS d1,
      CASE WHEN CAST(julianday(date('now','+8 hours')) - julianday(fs.cohort_day) AS INTEGER) > 3
           THEN COUNT(DISTINCT CASE WHEN CAST(julianday(date(e.occurred_at/1000,'unixepoch','+8 hours')) - julianday(fs.cohort_day) AS INTEGER) = 3 THEN fs.device_id END)
           ELSE NULL END AS d3,
      CASE WHEN CAST(julianday(date('now','+8 hours')) - julianday(fs.cohort_day) AS INTEGER) > 7
           THEN COUNT(DISTINCT CASE WHEN CAST(julianday(date(e.occurred_at/1000,'unixepoch','+8 hours')) - julianday(fs.cohort_day) AS INTEGER) = 7 THEN fs.device_id END)
           ELSE NULL END AS d7
    FROM first_seen fs
    JOIN events e ON e.device_id = fs.device_id
    WHERE fs.cohort_day >= date('now','-30 days','+8 hours')
    GROUP BY fs.cohort_day
    ORDER BY fs.cohort_day DESC
  `).all();
  return { cohorts: rs.results };
}

async function metricReturning(env: Env) {
  // 反向口径(回访率):分母是「当天 DAU」,往回看有多少是回头客。和正向 cohort 留存
  // (metricRetention)互补 —— 正向问「获取的用户留得住吗」(对今天这行天然算不出,未来没发生),
  // 反向问「今天来的人里多少是回头客」(每天都有意义,适合日常看体感)。
  // 每日 DAU 拆三段(加和 = DAU):
  //   new_devices = 该 device 第一次出现(全历史 MIN)就是当天 → 新增
  //   back_7d     = 非新增,且过去 7 天[T-7,T-1]内有活跃 → 近期回访
  //   更早回流    = 非新增,且过去 7 天内没活跃 → 前端算(dau - new_devices - back_7d)
  // 回访率 = (dau - new_devices)/dau。⚠️ 回访率被当天新增量强烈影响(新增越多分母越大、率越低),
  // 必须和新增数并看。过滤口径同 retention:真人 + 非 owner + 非 bot。
  const rs = await env.DB.prepare(`
    WITH bot_devices AS (
      SELECT device_id FROM events
      GROUP BY device_id
      HAVING MAX(CASE WHEN ${BOT_UA_LIKE} THEN 1 ELSE 0 END) = 1
    ),
    daily AS (
      SELECT DISTINCT device_id, date(occurred_at/1000,'unixepoch','+8 hours') AS day
      FROM events
      WHERE occurred_at > (strftime('%s','now') - 38 * 86400) * 1000
        AND device_id NOT IN (SELECT device_id FROM bot_devices)
        AND ${NOT_OWNER_SQL}
        AND ${IS_REAL_USER_SQL}
    ),
    first_seen AS (
      SELECT device_id, MIN(date(occurred_at/1000,'unixepoch','+8 hours')) AS fs
      FROM events
      WHERE device_id NOT IN (SELECT device_id FROM bot_devices)
        AND ${NOT_OWNER_SQL}
        AND ${IS_REAL_USER_SQL}
      GROUP BY device_id
    ),
    target_days AS (
      SELECT DISTINCT day AS t FROM daily WHERE day >= date('now','-30 days','+8 hours')
    )
    SELECT
      t.t AS day,
      COUNT(DISTINCT a.device_id) AS dau,
      COUNT(DISTINCT CASE WHEN fs.fs = t.t THEN a.device_id END) AS new_devices,
      COUNT(DISTINCT CASE WHEN fs.fs <> t.t AND EXISTS (
        SELECT 1 FROM daily x WHERE x.device_id = a.device_id AND x.day < t.t AND x.day >= date(t.t,'-7 day')
      ) THEN a.device_id END) AS back_7d
    FROM target_days t
    JOIN daily a ON a.day = t.t
    JOIN first_seen fs ON fs.device_id = a.device_id
    GROUP BY t.t
    ORDER BY t.t
  `).all();
  return { days: rs.results };
}

async function metricEventDistribution(env: Env) {
  // 错误类事件单独由 metric=errors / error-trend 呈现，event-distribution 排除掉
  // 防止两个模块重复占用顶部位置。ERROR_EVENT_TYPES 名单见文件顶部。
  // 排除 owner devices。
  const placeholders = ERROR_EVENT_TYPES.map(() => '?').join(',');
  const rs = await env.DB.prepare(`
    SELECT event_type, COUNT(*) AS events, COUNT(DISTINCT device_id) AS devices
    FROM events
    WHERE occurred_at > (strftime('%s','now')-7*86400)*1000
      AND event_type NOT IN (${placeholders})
      AND ${NOT_OWNER_SQL}
      AND ${IS_REAL_USER_SQL}
    GROUP BY event_type
    ORDER BY events DESC
    LIMIT 25
  `).bind(...ERROR_EVENT_TYPES).all();
  return { events: rs.results };
}

async function metricFunnel(env: Env) {
  // 4 步漏斗（每步算独立 device 数，过滤 7d）：
  //   1. app_open / page_view (启动)
  //   2. item_impression / item_open_drawer (看到内容)
  //   3. item_click / external_link_click (点击)
  //   4. share_click / favorite_toggle / login_success (深度互动)
  const row = await env.DB.prepare(`
    WITH dev_steps AS (
      SELECT
        device_id,
        MAX(CASE WHEN event_type IN ('app_open','page_view') THEN 1 ELSE 0 END) AS s1,
        MAX(CASE WHEN event_type IN ('item_impression','item_open_drawer') THEN 1 ELSE 0 END) AS s2,
        MAX(CASE WHEN event_type IN ('item_click','external_link_click') THEN 1 ELSE 0 END) AS s3,
        MAX(CASE WHEN event_type IN ('share_click','favorite_toggle','login_success') THEN 1 ELSE 0 END) AS s4
      FROM events
      WHERE occurred_at > (strftime('%s','now')-7*86400)*1000
        AND ${NOT_OWNER_SQL}
        AND ${IS_REAL_USER_SQL}
      GROUP BY device_id
    )
    SELECT
      SUM(s1) AS s1_open,
      SUM(s2) AS s2_view,
      SUM(s3) AS s3_click,
      SUM(s4) AS s4_deep
    FROM dev_steps
  `).first<{ s1_open: number; s2_view: number; s3_click: number; s4_deep: number }>();
  return {
    steps: [
      { name: '1. 启动', label: 'app_open / page_view', count: row?.s1_open ?? 0 },
      { name: '2. 看到内容', label: 'item_impression / item_open_drawer', count: row?.s2_view ?? 0 },
      { name: '3. 点击', label: 'item_click / external_link_click', count: row?.s3_click ?? 0 },
      { name: '4. 深度互动', label: 'share / favorite / login', count: row?.s4_deep ?? 0 },
    ],
  };
}

async function metricSessionDuration(env: Env) {
  // 同 device 同一天的事件 max-min 作为粗略 session_duration（session_end 在 mobile 大量丢失，
  // 不能直接靠 session_start ↔ session_end 配对）。需要至少 2 个事件才能算出 > 0 的时长。
  const rs = await env.DB.prepare(`
    WITH device_sessions AS (
      SELECT
        date(occurred_at/1000,'unixepoch','+8 hours') AS day,
        device_id,
        (MAX(occurred_at) - MIN(occurred_at)) / 1000 AS session_seconds
      FROM events
      WHERE occurred_at > (strftime('%s','now')-7*86400)*1000
        AND ${NOT_OWNER_SQL}
        AND ${IS_REAL_USER_SQL}
      GROUP BY day, device_id
      HAVING COUNT(*) >= 2 AND session_seconds > 0
    )
    SELECT
      CASE
        WHEN session_seconds < 10 THEN '0-10s'
        WHEN session_seconds < 60 THEN '10-60s'
        WHEN session_seconds < 300 THEN '1-5min'
        WHEN session_seconds < 900 THEN '5-15min'
        WHEN session_seconds < 1800 THEN '15-30min'
        WHEN session_seconds < 3600 THEN '30-60min'
        ELSE '60min+'
      END AS bucket,
      COUNT(*) AS sessions,
      CAST(AVG(session_seconds) AS INTEGER) AS avg_sec,
      MIN(session_seconds) AS min_sec
    FROM device_sessions
    GROUP BY bucket
    ORDER BY min_sec
  `).all();
  // 同时返回总体均值 / 中位数（粗略：用桶中点估）
  const overall = await env.DB.prepare(`
    WITH device_sessions AS (
      SELECT (MAX(occurred_at) - MIN(occurred_at)) / 1000 AS session_seconds
      FROM events
      WHERE occurred_at > (strftime('%s','now')-7*86400)*1000
        AND ${NOT_OWNER_SQL}
        AND ${IS_REAL_USER_SQL}
      GROUP BY date(occurred_at/1000,'unixepoch','+8 hours'), device_id
      HAVING COUNT(*) >= 2 AND session_seconds > 0
    )
    SELECT CAST(AVG(session_seconds) AS INTEGER) AS avg_sec, COUNT(*) AS total_sessions
    FROM device_sessions
  `).first<{ avg_sec: number; total_sessions: number }>();
  return { buckets: rs.results, avg_sec: overall?.avg_sec ?? 0, total_sessions: overall?.total_sessions ?? 0 };
}

// load-perf: 页面打开耗时。perf_nav 各相位 + FCP/LCP 的 p50/p75/p95（7 天窗口）。
// pctl: 单个事件单个 payload 字段的分位数。SQLite 无内置 percentile —— 用 window
// function 先按 v 升序编号（ROW_NUMBER），再挑第 ceil(pct*n) 名（CAST(pct*n AS INT)+1）。
// path 来自下方 metricLoadPerf 的 hardcoded 名单（非用户输入），直接拼进 json_extract 安全。
async function pctl(
  env: Env,
  eventType: string,
  path: string,
  cohort: PerformanceCohortName,
) {
  const cohortWhere = performanceCohortWhere(cohort, 'e');
  const row = await env.DB.prepare(`
    WITH vals AS (
      SELECT CAST(json_extract(e.event_payload,'$.${path}') AS REAL) AS v
      FROM events e
      WHERE e.event_type=? AND e.occurred_at > (strftime('%s','now')-7*86400)*1000
        AND ${cohortWhere} AND json_extract(e.event_payload,'$.${path}') IS NOT NULL
    ),
    ranked AS (SELECT v, COUNT(*) OVER() AS n, ROW_NUMBER() OVER(ORDER BY v) AS rn FROM vals)
    SELECT MAX(CASE WHEN rn=CAST(0.50*n AS INT)+1 THEN v END) AS p50,
           MAX(CASE WHEN rn=CAST(0.75*n AS INT)+1 THEN v END) AS p75,
           MAX(CASE WHEN rn=CAST(0.95*n AS INT)+1 THEN v END) AS p95,
           MAX(n) AS samples FROM ranked
  `).bind(eventType).first<{ p50: number; p75: number; p95: number; samples: number }>();
  return row ?? { p50: 0, p75: 0, p95: 0, samples: 0 };
}

const LOAD_PERF_METRICS: [string, string, string][] = [
  ['ttfb', 'perf_nav', 'ttfb'], ['response', 'perf_nav', 'response'],
  ['dom', 'perf_nav', 'dom_interactive'], ['dcl', 'perf_nav', 'dcl'],
  ['fcp', 'perf_fcp', 'value'], ['lcp', 'perf_lcp', 'value'],
  ['load', 'perf_nav', 'load'],
  ['img', 'perf_img', 'dur'],
];

async function loadPerformanceCohort(env: Env, cohort: PerformanceCohortName): Promise<PerformanceCohortData> {
  const cohortWhere = performanceCohortWhere(cohort, 'e');
  const [overall, slices] = await Promise.all([
    Promise.all(LOAD_PERF_METRICS.map(async ([name, type, path]) => ({
      metric: name,
      ...(await pctl(env, type, path, cohort)),
    }))),
    env.DB.prepare(`
      WITH base AS (
        SELECT CASE WHEN json_extract(e.event_payload,'$.is_wechat')=1 THEN 'wechat' ELSE 'other' END AS client,
               COALESCE(json_extract(e.event_payload,'$.nettype'),'unknown') AS net,
               CAST(json_extract(e.event_payload,'$.load') AS REAL) AS load_ms,
               CAST(json_extract(e.event_payload,'$.ttfb') AS REAL) AS ttfb_ms
        FROM events e WHERE e.event_type='perf_nav'
          AND e.occurred_at > (strftime('%s','now')-7*86400)*1000 AND ${cohortWhere})
      SELECT client, net, COUNT(*) AS samples,
             CAST(AVG(load_ms) AS INT) AS avg_load, CAST(AVG(ttfb_ms) AS INT) AS avg_ttfb
      FROM base GROUP BY client, net HAVING samples >= 3 ORDER BY avg_load DESC
    `).all(),
  ]);
  return { overall, slices: slices.results };
}

async function metricLoadPerf(env: Env) {
  // 各里程碑 → [展示名, 事件类型, payload 字段]。perf_nav 拆相位（ttfb/dom/dcl/response/load），
  // FCP/LCP 来自 web-vitals 各自的 value 字段。
  // 按时间线顺序排:除 response(正文下载段)/img(单图,独立)外,其余都是
  // 「从点击起的累计时刻」,后一根天然 ≥ 前一根 — 总耗时 = load 那一根,不能相加。
  const [allClean, engaged, synthetic] = await Promise.all([
    loadPerformanceCohort(env, 'all_clean'),
    loadPerformanceCohort(env, 'engaged'),
    loadPerformanceCohort(env, 'synthetic'),
  ]);
  return shapePerformanceAnalyticsOutput(allClean, engaged, synthetic);
}

async function metricErrors(env: Env) {
  const byMsg = await env.DB.prepare(`
    SELECT
      event_type,
      COALESCE(NULLIF(json_extract(event_payload,'$.error_msg'),''),
               'status_' || COALESCE(CAST(json_extract(event_payload,'$.status') AS TEXT), 'na')) AS error_msg,
      COUNT(*) AS errors,
      COUNT(DISTINCT device_id) AS devices
    FROM events
    WHERE event_type IN ('api_error','js_error','feed_load_error','image_load_error','unhandled_promise')
      AND occurred_at > (strftime('%s','now')-7*86400)*1000
      AND ${NOT_OWNER_SQL}
    GROUP BY event_type, error_msg
    ORDER BY errors DESC
    LIMIT 20
  `).all();
  const byDevice = await env.DB.prepare(`
    SELECT device_id, COUNT(*) AS errors, COUNT(DISTINCT event_type) AS error_types
    FROM events
    WHERE event_type IN ('api_error','js_error','feed_load_error','image_load_error','unhandled_promise')
      AND occurred_at > (strftime('%s','now')-7*86400)*1000
      AND ${NOT_OWNER_SQL}
    GROUP BY device_id
    ORDER BY errors DESC
    LIMIT 10
  `).all();
  return { by_msg: byMsg.results, by_device: byDevice.results };
}

async function metricErrorTrend(env: Env) {
  // 最近 30 天每天每类错误数 + 独立 device 数。前端把它 pivot 成
  // stacked bar（x=日期 / y=次数 / 每个 event_type 一段颜色）。
  const placeholders = ERROR_EVENT_TYPES.map(() => '?').join(',');
  const rs = await env.DB.prepare(`
    SELECT
      date(occurred_at/1000,'unixepoch','+8 hours') AS day,
      event_type,
      COUNT(*) AS errors,
      COUNT(DISTINCT device_id) AS devices
    FROM events
    WHERE event_type IN (${placeholders})
      AND occurred_at > (strftime('%s','now')-30*86400)*1000
      AND ${NOT_OWNER_SQL}
    GROUP BY day, event_type
    ORDER BY day, event_type
  `).bind(...ERROR_EVENT_TYPES).all();
  return { rows: rs.results };
}

// 邮箱脱敏:本地部分保留首2 + 末1,中间打码,域名保留(lt***6@gmail.com)。短本地名只留首字。
function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at < 1) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at);
  if (local.length <= 2) return local.slice(0, 1) + '***' + domain;
  const tail = local.length > 3 ? local.slice(-1) : '';
  return local.slice(0, 2) + '***' + tail + domain;
}

async function metricTopDevices(env: Env) {
  // active_date_counts = 该 device 28 天内每天事件数 json {"YYYY-MM-DD": N},前端渲 28 格(7×4)贡献图。
  // event_type_counts  = 该 device 各事件类型次数 json {event_type: N},前端译中文名展示(替代裸数字)。
  // email = 该 device 关联登录 user 的邮箱(provider=email),metric 内脱敏后返回 email_masked,原始邮箱不出 worker。
  const rs = await env.DB.prepare(`
    WITH per_dev_day AS (
      SELECT
        device_id,
        date(occurred_at/1000,'unixepoch','+8 hours') AS day,
        COUNT(*) AS cnt
      FROM events
      WHERE occurred_at > (strftime('%s','now')-28*86400)*1000
        AND ${NOT_OWNER_SQL}
        AND ${IS_REAL_USER_SQL}
      GROUP BY device_id, day
    ),
    per_dev_evt AS (
      SELECT device_id, json_group_object(event_type, n) AS event_type_counts
      FROM (
        SELECT device_id, event_type, COUNT(*) AS n
        FROM events
        WHERE occurred_at > (strftime('%s','now')-28*86400)*1000
          AND ${NOT_OWNER_SQL}
          AND ${IS_REAL_USER_SQL}
        GROUP BY device_id, event_type
      )
      GROUP BY device_id
    ),
    per_dev AS (
      SELECT
        device_id,
        substr(COALESCE(MAX(ua),''), 1, 80) AS ua_sample
      FROM events
      WHERE occurred_at > (strftime('%s','now')-28*86400)*1000
        AND ${NOT_OWNER_SQL}
        AND ${IS_REAL_USER_SQL}
      GROUP BY device_id
    ),
    per_dev_email AS (
      SELECT e.device_id, MAX(i.identity_value) AS email
      FROM events e
      JOIN identities i ON i.user_id = e.user_id AND i.provider = 'email' AND i.unbound_at IS NULL
      WHERE e.user_id IS NOT NULL
        AND e.occurred_at > (strftime('%s','now')-28*86400)*1000
      GROUP BY e.device_id
    )
    SELECT
      d.device_id,
      SUM(d.cnt) AS events,
      COUNT(*) AS active_days,
      pe.event_type_counts,
      MIN(d.day) AS first_seen,
      MAX(d.day) AS last_seen,
      p.ua_sample,
      em.email,
      json_group_object(d.day, d.cnt) AS active_date_counts
    FROM per_dev_day d
    JOIN per_dev p ON p.device_id = d.device_id
    JOIN per_dev_evt pe ON pe.device_id = d.device_id
    LEFT JOIN per_dev_email em ON em.device_id = d.device_id
    GROUP BY d.device_id, pe.event_type_counts, p.ua_sample, em.email
    ORDER BY active_days DESC, events DESC
    LIMIT 30
  `).all();
  // 脱敏邮箱,原始邮箱不发前端
  const devices = ((rs.results || []) as any[]).map((d) => {
    const masked = d.email ? maskEmail(d.email as string) : null;
    delete d.email;
    d.email_masked = masked;
    return d;
  });
  return { devices };
}

async function metricDrawerBySource(env: Env) {
  // 7 天 item_open_drawer 按 source GROUP。payload.source 直接给了 source 名（如
  // hf_paper / github / clawhub / x_list / product_hunt / huodongxing），无需从
  // item_id 前缀推。返回 source / opens / devices，前端画横条 bar。
  const rs = await env.DB.prepare(`
    SELECT
      json_extract(event_payload, '$.source') AS source,
      COUNT(*) AS opens,
      COUNT(DISTINCT device_id) AS devices
    FROM events
    WHERE event_type = 'item_open_drawer'
      AND occurred_at > (strftime('%s','now')-7*86400)*1000
      AND ${NOT_OWNER_SQL}
      AND ${IS_REAL_USER_SQL}
    GROUP BY source
    ORDER BY opens DESC
  `).all();
  return { sources: rs.results };
}

// 「翻译成中文音频」假门需求信号。KPI + 需求强度漏斗(打开播客详情→点想听)+
// 需求排行(决定先配哪几集)+ 按节目聚合 + 每日趋势。计数全在这看,不暴露 C 端。
async function metricDubWishlist(env: Env) {
  // KPI:想听人次 / 去重设备 / 覆盖集数(排除 owner 自己点的)
  const kpi = await env.DB.prepare(`
    SELECT COUNT(*) AS total_wishes,
           COUNT(DISTINCT device_id) AS devices,
           COUNT(DISTINCT item_id) AS items
    FROM dub_wishlist WHERE ${NOT_OWNER_SQL}
  `).first<{ total_wishes: number; devices: number; items: number }>();

  // 需求强度漏斗。分母 = 假门上线后打开过播客详情的去重设备(之前打开的没机会点,
  // 用首条 wishlist 的时间当起算点排除掉,避免低估转化率)。分子 = 点了想听的去重设备。
  const funnel = await env.DB.prepare(`
    SELECT
      (SELECT COUNT(DISTINCT device_id) FROM events
        WHERE event_type = 'item_open_drawer'
          AND json_extract(event_payload, '$.source') = 'podcast'
          AND occurred_at >= COALESCE((SELECT MIN(created_at) FROM dub_wishlist), strftime('%s','now')*1000)
          AND ${NOT_OWNER_SQL} AND ${IS_REAL_USER_SQL}) AS openers,
      (SELECT COUNT(DISTINCT device_id) FROM dub_wishlist WHERE ${NOT_OWNER_SQL}) AS wishers
  `).first<{ openers: number; wishers: number }>();

  // 需求排行:哪几集最多人想听(去重设备计数)。真做时先配票数高的。
  const ranking = await env.DB.prepare(`
    SELECT w.item_id,
           COUNT(DISTINCT w.device_id) AS wishes,
           COALESCE(json_extract(i.extra, '$.show_name'), i.author) AS show,
           COALESCE(json_extract(i.extra, '$.title_zh'), i.title) AS title
    FROM dub_wishlist w JOIN items i ON i.id = w.item_id
    WHERE w.${NOT_OWNER_SQL}
    GROUP BY w.item_id
    ORDER BY wishes DESC
    LIMIT 50
  `).all();

  // 按节目聚合:哪个节目源需求最旺,决定优先级
  const byShow = await env.DB.prepare(`
    SELECT COALESCE(json_extract(i.extra, '$.show_name'), i.author) AS show,
           COUNT(DISTINCT w.device_id) AS wishes
    FROM dub_wishlist w JOIN items i ON i.id = w.item_id
    WHERE w.${NOT_OWNER_SQL}
    GROUP BY show
    ORDER BY wishes DESC
    LIMIT 20
  `).all();

  // 每日趋势:去重设备数 + 人次
  const trend = await env.DB.prepare(`
    SELECT day, COUNT(DISTINCT device_id) AS devices, COUNT(*) AS wishes
    FROM dub_wishlist WHERE ${NOT_OWNER_SQL}
    GROUP BY day ORDER BY day
  `).all();

  return {
    kpi: kpi ?? { total_wishes: 0, devices: 0, items: 0 },
    funnel: funnel ?? { openers: 0, wishers: 0 },
    ranking: ranking.results,
    by_show: byShow.results,
    trend: trend.results,
  };
}

async function metricFeedDepth(env: Env) {
  // 翻页深度 = 用户在 feed 上浏览了多少 item。
  // 严格"翻页"需要前端发 feed_load_more 事件（当前没埋，需要 FE 加）。
  // 用 item_impression 作近似：每天每个 device 平均看了多少 item（impression 数）。
  // 也算 item_open_drawer / app_open 的 per-device per-day 平均值，给一个全景。
  const rs = await env.DB.prepare(`
    WITH per_dev_day AS (
      SELECT
        date(occurred_at/1000,'unixepoch','+8 hours') AS day,
        device_id,
        COUNT(CASE WHEN event_type = 'item_impression' THEN 1 END) AS impressions,
        COUNT(CASE WHEN event_type = 'item_open_drawer' THEN 1 END) AS drawer_opens,
        COUNT(CASE WHEN event_type IN ('app_open','page_view') THEN 1 END) AS opens
      FROM events
      WHERE occurred_at > (strftime('%s','now')-30*86400)*1000
        AND ${NOT_OWNER_SQL}
        AND ${IS_REAL_USER_SQL}
      GROUP BY day, device_id
      HAVING opens > 0 OR impressions > 0 OR drawer_opens > 0
    )
    SELECT
      day,
      COUNT(*) AS active_devices,
      CAST(AVG(impressions) AS REAL) AS avg_impressions,
      CAST(AVG(drawer_opens) AS REAL) AS avg_drawer_opens,
      SUM(impressions) AS total_impressions
    FROM per_dev_day
    GROUP BY day
    ORDER BY day
  `).all();
  return { days: rs.results };
}

async function metricChannelDwell(env: Env) {
  // 频道停留时长。逻辑：source_filter_change.payload.from_id = 用户切走的频道。
  // 用 LAG 拿同一 device 上一次 source_filter_change 的 occurred_at + to_id。
  // 仅当 prev.to_id == current.from_id（连续切换、未中断）时算一段停留，
  // 时长 = current.occurred_at - prev.occurred_at。> 1h 视为离开会话不计。
  // 漏掉的：用户最初的频道（首次切换前）+ 最后一个频道（切换后离开）。
  // 这两段时间无 next event 无法精确推断，接受。
  const rs = await env.DB.prepare(`
    WITH switches AS (
      SELECT
        device_id,
        occurred_at,
        json_extract(event_payload, '$.from_id') AS from_id,
        json_extract(event_payload, '$.to_id') AS to_id,
        LAG(occurred_at) OVER (PARTITION BY device_id ORDER BY occurred_at) AS prev_occurred_at,
        LAG(json_extract(event_payload, '$.to_id')) OVER (PARTITION BY device_id ORDER BY occurred_at) AS prev_to
      FROM events
      WHERE event_type = 'source_filter_change'
        AND occurred_at > (strftime('%s','now')-7*86400)*1000
        AND ${NOT_OWNER_SQL}
        AND ${IS_REAL_USER_SQL}
    ),
    dwell AS (
      SELECT
        from_id AS channel,
        (occurred_at - prev_occurred_at) / 1000 AS dwell_sec,
        device_id
      FROM switches
      WHERE prev_occurred_at IS NOT NULL
        AND prev_to = from_id
        AND (occurred_at - prev_occurred_at) BETWEEN 1000 AND 3600 * 1000
    )
    SELECT
      channel,
      COUNT(*) AS sessions,
      COUNT(DISTINCT device_id) AS devices,
      CAST(AVG(dwell_sec) AS INTEGER) AS avg_sec,
      CAST(SUM(dwell_sec) AS INTEGER) AS total_sec
    FROM dwell
    WHERE channel IS NOT NULL
    GROUP BY channel
    ORDER BY total_sec DESC
  `).all();
  return { channels: rs.results };
}

// ─── 搜索监控（C 端搜索 feature）────────────────────────────────────
// 数据来自 events 表 search_* 事件（track.ts 白名单）+ search_sync_state.last_reconcile
// （search/sync.ts reconcile 写入）。窗口一律 7 天；PV/UV/CTR 复用 NOT_OWNER + IS_REAL_USER
// 剔除 owner 与合成流量（bot / 测速），跟其他"人"指标口径一致；错误 / 性能只剔 owner。

// 使用总览:近 7 天 PV(search_submit)/UV(去重 device)/无结果(search_empty)/点击(search_result_click)。
// 人均次数 / 无结果率 / CTR 交前端算(除零防护),与 loadDauTrend / loadReturning 一致。
async function metricSearchOverview(env: Env) {
  const row = await env.DB.prepare(`
    SELECT
      COUNT(CASE WHEN event_type='search_submit' THEN 1 END) AS pv,
      COUNT(DISTINCT CASE WHEN event_type='search_submit' THEN device_id END) AS uv,
      COUNT(CASE WHEN event_type='search_empty' THEN 1 END) AS empties,
      COUNT(CASE WHEN event_type='search_result_click' THEN 1 END) AS clicks
    FROM events
    WHERE event_type IN ('search_submit','search_empty','search_result_click')
      AND occurred_at > (strftime('%s','now')-7*86400)*1000
      AND ${NOT_OWNER_SQL}
      AND ${IS_REAL_USER_SQL}
  `).first<{ pv: number; uv: number; empties: number; clicks: number }>();
  return row ?? { pv: 0, uv: 0, empties: 0, clicks: 0 };
}

// 热门搜索词:近 7 天 top 20 query(按提交次数)。submits(search_submit)+ 各自无结果次数
// (search_empty)。q 是用户输入,前端渲染必须 esc() 转义(XSS)。
async function metricSearchTopQueries(env: Env) {
  const rs = await env.DB.prepare(`
    SELECT
      json_extract(event_payload,'$.q') AS q,
      COUNT(CASE WHEN event_type='search_submit' THEN 1 END) AS submits,
      COUNT(CASE WHEN event_type='search_empty' THEN 1 END) AS empties
    FROM events
    WHERE event_type IN ('search_submit','search_empty')
      AND occurred_at > (strftime('%s','now')-7*86400)*1000
      AND ${NOT_OWNER_SQL}
      AND ${IS_REAL_USER_SQL}
      AND json_extract(event_payload,'$.q') IS NOT NULL
      AND TRIM(json_extract(event_payload,'$.q')) <> ''
    GROUP BY q
    ORDER BY submits DESC, empties DESC
    LIMIT 20
  `).all();
  return { queries: rs.results };
}

// 单字段分位:复用 pctl() 的 ROW_NUMBER 分位技法,但分位点换成 50/90/99(pctl 固定 50/75/95)。
// path 为 hardcoded 字段名(server_ms/client_ms),非用户输入,直接拼 json_extract 安全(同 pctl)。
async function searchPctl(env: Env, path: string) {
  const row = await env.DB.prepare(`
    WITH vals AS (
      SELECT CAST(json_extract(event_payload,'$.${path}') AS REAL) AS v
      FROM events
      WHERE event_type='search_perf' AND occurred_at > (strftime('%s','now')-7*86400)*1000
        AND ${NOT_OWNER_SQL} AND json_extract(event_payload,'$.${path}') IS NOT NULL
    ),
    ranked AS (SELECT v, COUNT(*) OVER() AS n, ROW_NUMBER() OVER(ORDER BY v) AS rn FROM vals)
    SELECT MAX(CASE WHEN rn=CAST(0.50*n AS INT)+1 THEN v END) AS p50,
           MAX(CASE WHEN rn=CAST(0.90*n AS INT)+1 THEN v END) AS p90,
           MAX(CASE WHEN rn=CAST(0.99*n AS INT)+1 THEN v END) AS p99,
           MAX(n) AS samples FROM ranked
  `).first<{ p50: number; p90: number; p99: number; samples: number }>();
  return row ?? { p50: 0, p90: 0, p99: 0, samples: 0 };
}

// 搜索性能:server_ms(worker 端 query_time_ms)与 client_ms(前端总耗时,含网络)各 p50/p90/p99。
async function metricSearchPerf(env: Env) {
  return {
    server: await searchPctl(env, 'server_ms'),
    client: await searchPctl(env, 'client_ms'),
  };
}

// 搜索异常:近 7 天 按日 × kind(rate_limited/server/client/network)计数。429(限流)= kind
// ='rate_limited';单列 rate_limited_total 便于 KPI 直读。错误只剔 owner,口径同 metricErrors。
async function metricSearchErrors(env: Env) {
  const rows = await env.DB.prepare(`
    SELECT
      date(occurred_at/1000,'unixepoch','+8 hours') AS day,
      COALESCE(json_extract(event_payload,'$.kind'),'unknown') AS kind,
      COUNT(*) AS errors
    FROM events
    WHERE event_type='search_error'
      AND occurred_at > (strftime('%s','now')-7*86400)*1000
      AND ${NOT_OWNER_SQL}
    GROUP BY day, kind
    ORDER BY day, kind
  `).all();
  const rl = await env.DB.prepare(`
    SELECT COUNT(*) AS rate_limited_total
    FROM events
    WHERE event_type='search_error'
      AND json_extract(event_payload,'$.kind')='rate_limited'
      AND occurred_at > (strftime('%s','now')-7*86400)*1000
      AND ${NOT_OWNER_SQL}
  `).first<{ rate_limited_total: number }>();
  return { rows: rows.results, rate_limited_total: rl?.rate_limited_total ?? 0 };
}

// 索引滞后:读 search_sync_state.last_reconcile(sync.ts reconcile 写入的 JSON)。
// 字段:itemsEligible(items 合规行) / ftsRows(items_fts 行数) / drift(差值) / purged / at(ISO 时间)。
async function metricSearchIndexLag(env: Env) {
  const row = await env.DB.prepare(
    `SELECT v FROM search_sync_state WHERE k = 'last_reconcile'`,
  ).first<{ v: string }>();
  if (!row?.v) return { present: false as const };
  try {
    const p = JSON.parse(row.v) as {
      itemsEligible?: number; ftsRows?: number; drift?: number; purged?: number; at?: string;
    };
    const itemsEligible = p.itemsEligible ?? 0;
    const ftsRows = p.ftsRows ?? 0;
    return {
      present: true as const,
      itemsEligible,
      ftsRows,
      drift: p.drift ?? (itemsEligible - ftsRows),
      purged: p.purged ?? 0,
      at: p.at ?? null,
    };
  } catch {
    return { present: false as const };
  }
}

// 组装:一个 ?metric=search 端点,Promise.all 并发跑 5 个子指标,前端一次 fetch 渲染整块。
async function metricSearch(env: Env) {
  const [overview, topQueries, perf, errors, indexLag] = await Promise.all([
    metricSearchOverview(env),
    metricSearchTopQueries(env),
    metricSearchPerf(env),
    metricSearchErrors(env),
    metricSearchIndexLag(env),
  ]);
  return { overview, topQueries, perf, errors, indexLag };
}

// ─── /admin/dashboard → 仪表盘 HTML ──────────────────────────────
export async function serveAdminDashboardHtml(request: Request, env: Env): Promise<Response> {
  const guard = await requireAuth(request, env);
  if (guard) return guard;
  return new Response(DASHBOARD_HTML, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

export const DASHBOARD_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ai-feeds admin · 仪表盘</title>
<!-- echarts: cdnjs (Cloudflare CDN) 国内访问比 jsdelivr 稳；fallback 到 jsdelivr。
     注意：内嵌 HTML 字符串里 '</script>' 必须拆开，否则 HTML parser 会把它当成
     外层 <script> 闭合标签，导致后面所有 JS 语法错乱。这里用字符串拼接绕开。 -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/echarts/5.5.0/echarts.min.js"></script>
<script>
  if (typeof echarts === 'undefined') {
    document.write('<scr' + 'ipt src="https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js"></scr' + 'ipt>');
  }
</script>
<style>
${ADMIN_SHARED_CSS}
  .kpi-row { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); margin-bottom: 24px; }
  .kpi { background: #11161f; border: 1px solid #1f2937; border-radius: 8px; padding: 16px; }
  .kpi .label { font-size: 12px; color: #6b7280; text-transform: uppercase; letter-spacing: .05em; }
  .kpi .value { font-size: 28px; font-weight: 600; color: #e6e8eb; margin-top: 6px; font-family: ui-monospace, monospace; }
  .kpi .hint { font-size: 11px; color: #6b7280; margin-top: 4px; }

  .grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); }
  .card { background: #11161f; border: 1px solid #1f2937; border-radius: 8px; padding: 16px; }
  .card h2 { margin: 0 0 4px; font-size: 14px; font-weight: 600; color: #d1d5db; }
  .card p.hint { margin: 0 0 12px; font-size: 12px; color: #6b7280; }
  .card .chart { width: 100%; height: 280px; }
  .card.wide { grid-column: 1 / -1; }
  .card .chart.tall { height: 360px; }

  .perf-cohort-tabs { display: inline-flex; gap: 2px; margin: 2px 0 4px; padding: 3px;
                      background: #0b0e14; border: 1px solid #1f2937; border-radius: 8px; }
  .perf-cohort-btn { border: 0; border-radius: 5px; padding: 5px 10px; cursor: pointer;
                     color: #9ca3af; background: transparent; font-size: 11px; }
  .perf-cohort-btn:hover:not(:disabled) { color: #e6e8eb; background: #1a2230; }
  .perf-cohort-btn.active { color: #e6e8eb; background: #2a3441; }
  .perf-cohort-btn:focus-visible { outline: 2px solid #60a5fa; outline-offset: 1px; }
  .perf-cohort-btn:disabled { opacity: .35; cursor: not-allowed; }
  .perf-cohort-note { min-height: 18px; margin: 0 0 2px; color: #7c93b8; font-size: 11px; }

  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  thead th { text-align: left; padding: 6px 8px; color: #9ca3af; font-weight: 500;
             border-bottom: 1px solid #1f2937; font-size: 11px; text-transform: uppercase; letter-spacing: .05em;
             vertical-align: middle; }
  thead th.num { text-align: right; }
  tbody td { padding: 10px 8px; border-bottom: 1px solid #1f2937; color: #d1d5db; font-family: ui-monospace, monospace;
             vertical-align: top; }
  tbody tr:hover { background: #161b24; }
  td.num { text-align: right; }
  td.muted { color: #6b7280; }
  /* 设备表 UA 列：第一行设备名（大号），第二行原始 UA（灰小字） */
  .ua-cell { font-family: -apple-system, system-ui, sans-serif; }
  .ua-cell .device-name { color: #d1d5db; font-size: 12px; font-weight: 500; }
  .ua-cell .ua-raw { color: #6b7280; font-size: 10px; font-family: ui-monospace, monospace;
                     margin-top: 4px; line-height: 1.4; word-break: break-all; }
  .dev-id { color: #e6e8eb; font-family: ui-monospace, monospace; font-size: 12px; }
  .dev-email { color: #7c93b8; font-size: 11px; margin-top: 3px; font-family: ui-monospace, monospace; }

  .funnel-step { display: grid; grid-template-columns: 1fr auto; gap: 12px; margin: 8px 0;
                 padding: 12px; background: #0b0e14; border: 1px solid #1f2937; border-radius: 6px; }
  .funnel-step .name { font-size: 13px; color: #e6e8eb; font-weight: 500; }
  .funnel-step .sub { font-size: 11px; color: #6b7280; margin-top: 2px; font-family: ui-monospace, monospace; }
  .funnel-step .right { text-align: right; font-family: ui-monospace, monospace; }
  .funnel-step .count { font-size: 18px; color: #e6e8eb; font-weight: 600; }
  .funnel-step .pct { font-size: 11px; color: #6ee7b7; }

  .loading { color: #6b7280; font-size: 12px; text-align: center; padding: 24px; }
  .err { color: #fca5a5; font-size: 12px; padding: 12px; background: #1f1212; border: 1px solid #7f1d1d; border-radius: 6px; }

  /* GitHub-style 贡献小方格 — 28 天活跃日 7 列 × 4 行整齐。按当天 event 数 5 级染色，
     最右下角是今天（带 outline）。.lv0 无事件，.lv1-.lv4 由浅到深。 */
  .contrib { display: inline-grid; grid-template-columns: repeat(7, 12px); grid-auto-rows: 12px; gap: 3px;
             vertical-align: middle; }
  .contrib > span { width: 12px; height: 12px; border-radius: 2px; background: #1a2230; }
  .contrib > span.lv1 { background: #1f3a2e; }
  .contrib > span.lv2 { background: #2d6649; }
  .contrib > span.lv3 { background: #4ea876; }
  .contrib > span.lv4 { background: #6ee7b7; }
  .contrib > span.today { outline: 1px solid #9ca3af; outline-offset: 1px; }

  /* 表格默认折叠到前 N 行,超出的加 .collapsed-row 隐藏,配 .row-toggle 按钮展开/收起 */
  tr.collapsed-row { display: none; }
  .row-toggle { margin-top: 8px; font-size: 12px; color: #9ca3af; background: #1a2230;
                border: 1px solid #2a3441; border-radius: 6px; padding: 4px 12px; cursor: pointer; }
  .row-toggle:hover { background: #232d3d; color: #e6e8eb; }
</style>
</head>
<body>
${adminNavHtml('dashboard')}
<main>

<div class="kpi-row" id="kpis" data-testid="kpis-row">
  <div class="kpi" data-testid="kpi-dau"><div class="label">DAU · 今日</div><div class="value" id="kpi-dau">—</div><div class="hint" id="kpi-dau-hint">真实活跃 device (BJT 当日)</div></div>
  <div class="kpi" data-testid="kpi-wau"><div class="label">WAU · 7d</div><div class="value" id="kpi-wau">—</div><div class="hint">最近 7 天独立 device</div></div>
  <div class="kpi" data-testid="kpi-mau"><div class="label">MAU · 30d</div><div class="value" id="kpi-mau">—</div><div class="hint">最近 30 天独立 device</div></div>
  <div class="kpi" data-testid="kpi-total"><div class="label">累计 device</div><div class="value" id="kpi-total">—</div><div class="hint">events 表全部 unique</div></div>
  <div class="kpi" data-testid="kpi-events"><div class="label">累计事件</div><div class="value" id="kpi-events">—</div><div class="hint">events 表全部行数</div></div>
</div>

<div class="grid">

  <div class="card wide" data-testid="card-dau-trend">
    <h2>📈 DAU 趋势</h2>
    <p class="hint">最近 30 天每天独立 device 数 + 事件总数（双轴）</p>
    <div class="chart tall" id="ch-dau"></div>
  </div>

  <div class="card" data-testid="card-funnel">
    <h2>🎯 行为漏斗</h2>
    <p class="hint">7 天内每个 device 是否触达 4 步关键行为（独立 device 数）</p>
    <div id="ch-funnel"></div>
  </div>

  <div class="card" data-testid="card-session-duration">
    <h2>⏱ 会话时长分布</h2>
    <p class="hint">7 天内每个 device-day 的事件首末时间差。session_end 在 mobile 大量丢失，用 max-min 兜底</p>
    <div class="chart" id="ch-session"></div>
  </div>

  <div class="card" data-testid="card-channel-dwell">
    <h2>📺 频道停留时长</h2>
    <p class="hint">7 天每个 source 平均停留时长 + 总时长。算法：相邻 source_filter_change 间隔（&gt;1h 视为离开会话不计），漏算首尾两段</p>
    <div style="overflow-x:auto"><table id="tbl-channels"><thead><tr>
      <th>频道</th><th class="num">平均停留</th><th class="num">总时长</th><th class="num">切换次数</th><th class="num">device 数</th>
    </tr></thead><tbody><tr><td colspan="5" class="loading">loading…</td></tr></tbody></table></div>
  </div>

  <div class="card" data-testid="card-drawer-by-source">
    <h2>📂 详情打开 · 按数据源</h2>
    <p class="hint">7 天 item_open_drawer 按 source 分组。哪个源的内容最吸引用户进抽屉深读</p>
    <div class="chart" id="ch-drawer-source"></div>
  </div>

  <div class="card" data-testid="card-dub-wishlist">
    <h2>🎧 中文配音需求</h2>
    <p class="hint">「翻译成中文音频」按钮点击信号。一台设备一集只算一次。计数仅后台可见，不暴露 C 端。设计见 docs/plans/2026-06-20-podcast-dubbing-cost-and-painted-door.md</p>
    <div class="kpi-row" style="margin:8px 0 16px">
      <div class="kpi"><div class="label">想听人次</div><div class="value" id="dw-total">—</div></div>
      <div class="kpi"><div class="label">去重设备</div><div class="value" id="dw-devices">—</div></div>
      <div class="kpi"><div class="label">覆盖集数</div><div class="value" id="dw-items">—</div></div>
    </div>
    <div class="funnel-step">
      <div><div class="name">打开播客详情</div><div class="sub">item_open_drawer · source=podcast · 假门上线后</div></div>
      <div class="right"><div class="count" id="dw-openers">—</div></div>
    </div>
    <div class="funnel-step">
      <div><div class="name">点「想听中文版」</div><div class="sub">去重设备</div></div>
      <div class="right"><div class="count" id="dw-wishers">—</div><div class="pct" id="dw-cvr">—</div></div>
    </div>
    <p class="hint" style="margin-top:8px">转化率 = 想听设备 ÷ 打开播客详情设备。经验：&gt;5% 需求明显，&gt;10% 很强</p>
    <div style="overflow-x:auto;margin-top:16px"><table id="tbl-dub-wishlist"><thead><tr>
      <th class="num">#</th><th>节目</th><th>单集</th><th class="num">想听设备</th>
    </tr></thead><tbody><tr><td colspan="4" class="loading">loading…</td></tr></tbody></table></div>
  </div>

  <div class="card wide" data-testid="card-feed-depth">
    <h2>📜 人均浏览深度</h2>
    <p class="hint">最近 30 天每天人均 item_impression（曝光到屏幕中央的 item 数）+ 人均 item_open_drawer。粗略反映"翻多深"。严格翻页深度需 FE 加 feed_load_more 埋点</p>
    <div class="chart tall" id="ch-feed-depth"></div>
  </div>

  <div class="card wide" data-testid="card-load-perf">
    <h2>🚀 页面打开耗时</h2>
    <p class="hint">⚠️ 读法：柱子是「从点击到该节点」的累计时刻，互相包含、<b>不能相加</b> —— 总耗时只看「全就绪LOAD」一根；用户体感看「出内容FCP」。例外：「下载」「单图」是独立时长。7 天窗口 p50/p75/p95（ms）；可切换真实全量、明确互动与显式测速 cohort。</p>
    <div class="perf-cohort-tabs" id="perf-cohort-tabs" role="group" aria-label="性能样本 cohort">
      <button type="button" class="perf-cohort-btn active" data-perf-cohort="all_clean" aria-pressed="true">真实全量</button>
      <button type="button" class="perf-cohort-btn" data-perf-cohort="engaged" aria-pressed="false">明确互动</button>
      <button type="button" class="perf-cohort-btn" data-perf-cohort="synthetic" aria-pressed="false">显式测速</button>
    </div>
    <p class="perf-cohort-note" id="perf-cohort-note">排除 owner 与显式测速，保留无互动的真实慢用户</p>
    <div class="chart tall" id="ch-load-perf"></div>
    <div style="overflow-x:auto;margin-top:12px"><table id="tbl-load-slice"><thead><tr>
      <th>客户端</th><th>网络</th><th class="num">avg load</th><th class="num">avg ttfb</th><th class="num">样本</th>
    </tr></thead><tbody><tr><td colspan="5" class="loading">loading…</td></tr></tbody></table></div>
  </div>

  <div class="card wide" data-testid="card-returning">
    <h2>🔄 每日新增 vs 回访</h2>
    <p class="hint">最近 30 天每天真实 DAU 拆成 新增 / 7天内回访 / 更早回流（加和=DAU）+ 回访率（回头客÷DAU）。⚠️ 回访率受当天新增量影响（新增越多率越低），要和新增数并看。默认显示最近 5 天，可展开</p>
    <div style="overflow-x:auto"><table id="tbl-returning"><thead><tr>
      <th>日期</th><th class="num">DAU</th><th class="num">新增</th><th class="num">7天内回访</th><th class="num">更早回流</th><th class="num">回访率</th>
    </tr></thead><tbody><tr><td colspan="6" class="loading">loading…</td></tr></tbody></table></div>
  </div>

  <div class="card wide" data-testid="card-retention">
    <h2>♻️ 留存矩阵（正向 cohort）</h2>
    <p class="hint">最近 30 天每个 cohort（首次访问日期）在 +1/+3/+7 天的留存率。「—」表示该 cohort 还没到第 N 天、或第 N 天当天数据仍在累计（次日完整后才显示），不是 0%</p>
    <div style="overflow-x:auto"><table id="tbl-retention"><thead><tr>
      <th>cohort 日</th><th class="num">新增</th>
      <th class="num">+1d</th><th class="num">+3d</th><th class="num">+7d</th>
    </tr></thead><tbody><tr><td colspan="5" class="loading">loading…</td></tr></tbody></table></div>
  </div>

  <div class="card" data-testid="card-event-distribution">
    <h2>🧩 事件类型分布</h2>
    <p class="hint">7 天内 top 事件类型（按次数，排除错误类，错误见下方专门模块）</p>
    <div class="chart tall" id="ch-events"></div>
  </div>

  <div class="card wide" data-testid="card-error-trend">
    <h2>⚠️ 错误趋势</h2>
    <p class="hint">最近 30 天每天各类前端错误次数（堆叠柱状）。timeout_5000ms 是 fetch 5s 超时，不是后端 500</p>
    <div class="chart tall" id="ch-error-trend"></div>
  </div>

  <div class="card wide" data-testid="card-errors">
    <h2>⚠️ 错误明细（7 天 top 20）</h2>
    <p class="hint">同一 error_msg 聚合，可看具体超时端点 / JS 堆栈 / 网络抖动等真因。配合上面的「错误趋势」一起看</p>
    <div style="overflow-x:auto"><table id="tbl-errors"><thead><tr>
      <th>类型</th><th>error_msg</th><th class="num">errors</th><th class="num">devices</th>
    </tr></thead><tbody><tr><td colspan="4" class="loading">loading…</td></tr></tbody></table></div>
  </div>

  <div class="card wide" data-testid="card-top-devices">
    <h2>🧑‍💻 重度设备</h2>
    <p class="hint">最近 28 天按 active_days × events 排序前 30。每行都展示 GitHub 风格活跃日方格（7×4，由浅到深 4 级按当天 event 数：1-9 / 10-49 / 50-199 / 200+；带边框那格是今天）。「事件类型」列悬停看完整类型及次数；device_id 下方 ✉ 为该设备关联过的登录邮箱（已脱敏）</p>
    <div style="overflow-x:auto"><table id="tbl-devices"><thead><tr>
      <th>device_id</th><th class="num">events</th><th class="num">活跃天</th><th class="num">事件类型</th>
      <th>first seen</th><th>last seen</th><th>28 天分布</th><th>UA</th>
    </tr></thead><tbody><tr><td colspan="8" class="loading">loading…</td></tr></tbody></table></div>
  </div>

  <!-- ─── 搜索监控（C 端搜索 feature）─── -->
  <div class="card wide" data-testid="card-search-overview">
    <h2>🔍 搜索 · 使用总览</h2>
    <p class="hint">近 7 天。PV=搜索提交次数 / UV=去重 device / 人均=PV÷UV / 无结果率=无结果÷PV / CTR=结果点击÷PV。已剔 owner + 测速/bot 合成流量</p>
    <div class="kpi-row" style="margin:8px 0 0">
      <div class="kpi"><div class="label">搜索 PV</div><div class="value" id="se-pv">—</div><div class="hint">search_submit</div></div>
      <div class="kpi"><div class="label">搜索 UV</div><div class="value" id="se-uv">—</div><div class="hint">去重 device</div></div>
      <div class="kpi"><div class="label">人均次数</div><div class="value" id="se-per">—</div><div class="hint">PV ÷ UV</div></div>
      <div class="kpi"><div class="label">无结果率</div><div class="value" id="se-empty">—</div><div class="hint">search_empty ÷ PV</div></div>
      <div class="kpi"><div class="label">CTR</div><div class="value" id="se-ctr">—</div><div class="hint">result_click ÷ PV</div></div>
    </div>
  </div>

  <div class="card" data-testid="card-search-top-queries">
    <h2>🔥 热门搜索词</h2>
    <p class="hint">近 7 天 top 20 query（按提交次数）。「无结果」列 = 该词命中 search_empty 的次数，高说明供给缺口</p>
    <div style="overflow-x:auto"><table id="tbl-search-queries"><thead><tr>
      <th class="num">#</th><th>搜索词</th><th class="num">提交</th><th class="num">无结果</th>
    </tr></thead><tbody><tr><td colspan="4" class="loading">loading…</td></tr></tbody></table></div>
  </div>

  <div class="card" data-testid="card-search-perf">
    <h2>⚡ 搜索性能</h2>
    <p class="hint">近 7 天 search_perf 分位（ms）。server=worker 查询耗时 / client=前端总耗时（含网络）。p50/p90/p99</p>
    <div style="overflow-x:auto"><table id="tbl-search-perf"><thead><tr>
      <th>指标</th><th class="num">p50</th><th class="num">p90</th><th class="num">p99</th><th class="num">样本</th>
    </tr></thead><tbody><tr><td colspan="5" class="loading">loading…</td></tr></tbody></table></div>
  </div>

  <div class="card" data-testid="card-search-errors">
    <h2>🚨 搜索异常</h2>
    <p class="hint">近 7 天 search_error 按日 × kind。rate_limited=429 限流 / server=5xx / client=4xx / network=断网超时</p>
    <div style="overflow-x:auto"><table id="tbl-search-errors"><thead><tr>
      <th>日期</th><th class="num">限流429</th><th class="num">服务端</th><th class="num">客户端</th><th class="num">网络</th><th class="num">合计</th>
    </tr></thead><tbody><tr><td colspan="6" class="loading">loading…</td></tr></tbody></table></div>
  </div>

  <div class="card" data-testid="card-search-index-lag">
    <h2>🗂 搜索索引滞后</h2>
    <p class="hint">最近一次对账（search/sync.ts reconcile）。差值 = 合规 items − FTS 行数，|差值|&gt;500 会 PushDeer 告警</p>
    <div class="kpi-row" style="margin:8px 0 0">
      <div class="kpi"><div class="label">合规 items</div><div class="value" id="se-elig">—</div><div class="hint">满足索引五条件</div></div>
      <div class="kpi"><div class="label">FTS 行数</div><div class="value" id="se-fts">—</div><div class="hint">items_fts</div></div>
      <div class="kpi"><div class="label">差值 drift</div><div class="value" id="se-drift">—</div><div class="hint">合规 − FTS</div></div>
      <div class="kpi"><div class="label">本次清理</div><div class="value" id="se-purged">—</div><div class="hint">purged 行</div></div>
    </div>
    <p class="hint" id="se-reconcile-at" style="margin-top:12px">对账时间：—</p>
  </div>

</div>
</main>

<script>
function setMeta() {
  document.getElementById('metaText').textContent =
    location.host + ' · ' + new Date().toLocaleString('zh-CN', {hour12:false});
}
setMeta();
setInterval(setMeta, 30000);

// echarts 加载失败兜底：所有 .chart 容器换成提示，table 类继续 load
if (typeof echarts === 'undefined') {
  console.error('[admin/dashboard] echarts CDN 加载失败，图表区降级为文字提示');
  document.querySelectorAll('.chart').forEach(function(el) {
    el.innerHTML = '<div class="err">echarts CDN 加载失败 — 检查网络 / 刷新页面 / 浏览器开发者工具看具体错误</div>';
  });
}

async function getJson(url) {
  const r = await fetch(url, { credentials: 'include' });
  // CF Access JWT 过期时 fetch 会跟到 cloudflareaccess.com 拿 HTML 登录页 — 检测
  // 一下：URL 跨域或 Content-Type 不是 JSON 都给 user 提示重登
  if (r.redirected && !r.url.startsWith(location.origin)) {
    throw new Error('CF Access 会话过期，刷新整页重新登录');
  }
  const ct = r.headers.get('content-type') || '';
  if (!r.ok) throw new Error('HTTP ' + r.status + (ct.includes('text') ? ' · ' + (await r.text()).slice(0, 80) : ''));
  if (!ct.includes('application/json')) {
    const sample = (await r.text()).slice(0, 80);
    throw new Error('非 JSON 响应（' + ct + '）: ' + sample);
  }
  return r.json();
}

function fmt(n) { return (n || 0).toLocaleString('en-US'); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]; }); }
function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  if (sec < 60) return sec + 's';
  if (sec < 3600) return Math.round(sec/60) + 'm';
  return (sec/3600).toFixed(1) + 'h';
}

// event_type 中文标签 — 与 dashboard/src/lib/telemetry/event-types.ts 和
// worker/src/track.ts 的 EVENT_TYPE_WHITELIST 对齐。新增事件类型时这里要补一条。
const EVENT_LABELS = {
  'app_open': '应用启动',
  'page_view': '页面浏览',
  'session_start': '会话开始',
  'session_end': '会话结束',
  'item_impression': '内容曝光',
  'item_click': '内容点击',
  'item_open_drawer': '打开详情',
  'item_close_drawer': '关闭详情',
  'thread_expand': '展开 thread',
  'image_lightbox_open': '查看大图',
  'external_link_click': '外链点击',
  'source_filter_change': '切换信息源',
  'sort_change': '切换排序',
  'new_content_banner_click': '点新内容提示',
  'share_click': '点分享',
  'share_landing': '分享落地访问',
  'login_modal_open': '打开登录弹窗',
  'sms_send_attempt': '尝试发验证码',
  'sms_send_success': '验证码发送成功',
  'code_verify_attempt': '尝试验证码',
  'login_success': '登录成功',
  'logout': '登出',
  'account_delete': '删除账号',
  'favorite_toggle': '收藏 / 取消',
  'subscribe_toggle': '订阅 / 取消',
  'video_autoplay_attempt': '视频自动播放尝试',
  'video_autoplay_blocked': '自动播放被拦截',
  'video_play_start': '视频播放',
  'perf_lcp': '性能 · LCP',
  'perf_api': '性能 · API',
  'feed_ready': '性能 · 首流就绪',
  'perf_inp': '性能 · INP',
  'perf_cls': '性能 · CLS',
  'perf_ttfb': '性能 · TTFB',
  'perf_fcp': '性能 · FCP',
  'perf_img': '性能 · 封面图',
  'perf_nav': '性能 · 导航计时',
  'js_error': 'JS 错误',
  'unhandled_promise': 'Promise 错误',
  'api_error': 'API 错误',
  'image_load_error': '图片加载失败',
  'feed_load_error': 'Feed 加载失败',
};
function evtZh(type) { return EVENT_LABELS[type] || type; }

const COLORS = ['#6ee7b7','#93c5fd','#fcd34d','#fca5a5','#c4b5fd','#fdba74','#a7f3d0','#bfdbfe'];

async function loadOverview() {
  try {
    const d = await getJson('/api/admin/analytics?metric=overview');
    document.getElementById('kpi-dau').textContent = fmt(d.dau);
    document.getElementById('kpi-wau').textContent = fmt(d.wau);
    document.getElementById('kpi-mau').textContent = fmt(d.mau);
    document.getElementById('kpi-total').textContent = fmt(d.total_devices);
    document.getElementById('kpi-events').textContent = fmt(d.total_events);
    // 合成流量 (测速 / preview bot / SEO 监控) 提示
    const hintEl = document.getElementById('kpi-dau-hint');
    if (hintEl && d.synthetic_today != null) {
      hintEl.textContent = '真实活跃 device · 已剔 ' + fmt(d.synthetic_today) + ' 个测速/bot';
    }
  } catch (e) { console.error('overview', e); }
}

async function loadDubWishlist() {
  const tb = document.querySelector('#tbl-dub-wishlist tbody');
  try {
    const d = await getJson('/api/admin/analytics?metric=dub-wishlist');
    const k = d.kpi || {};
    document.getElementById('dw-total').textContent = fmt(k.total_wishes);
    document.getElementById('dw-devices').textContent = fmt(k.devices);
    document.getElementById('dw-items').textContent = fmt(k.items);
    const f = d.funnel || {};
    const openers = f.openers || 0, wishers = f.wishers || 0;
    document.getElementById('dw-openers').textContent = fmt(openers);
    document.getElementById('dw-wishers').textContent = fmt(wishers);
    document.getElementById('dw-cvr').textContent = openers > 0 ? (100 * wishers / openers).toFixed(1) + '%' : '—';
    const rows = d.ranking || [];
    if (!rows.length) {
      tb.innerHTML = '<tr><td colspan="4" class="muted">还没有人点（假门刚上线 / 等数据累积）</td></tr>';
      return;
    }
    tb.innerHTML = rows.map(function(r, i) {
      return '<tr><td class="num">' + (i + 1) + '</td><td>' + esc(r.show || '—') +
        '</td><td>' + esc(r.title || '—') + '</td><td class="num">' + fmt(r.wishes) + '</td></tr>';
    }).join('');
  } catch (e) {
    console.error('dub-wishlist', e);
    if (tb) tb.innerHTML = '<tr><td colspan="4" class="err">' + esc(e.message || e) + '</td></tr>';
  }
}

async function loadDauTrend() {
  const chart = echarts.init(document.getElementById('ch-dau'), 'dark', { renderer: 'canvas' });
  try {
    const d = await getJson('/api/admin/analytics?metric=dau-trend');
    const days = d.days.map(r => r.day);
    const dau = d.days.map(r => r.dau);
    const evs = d.days.map(r => r.events);
    // 人均事件数 = 事件总数 / DAU。挂左轴（跟 DAU 量级相近，10-200），
    // 虚线区分。判断「打开了就刷一刷」vs「打开了快速离开」很有用。
    const perUser = d.days.map(r => r.dau > 0 ? +(r.events / r.dau).toFixed(1) : 0);
    chart.setOption({
      backgroundColor: 'transparent',
      grid: { left: 50, right: 50, top: 30, bottom: 30 },
      tooltip: { trigger: 'axis' },
      legend: { data: ['DAU', '人均事件数', '事件数'], textStyle: { color: '#9ca3af' } },
      xAxis: { type: 'category', data: days, axisLabel: { color: '#6b7280', fontSize: 10 } },
      yAxis: [
        { type: 'value', name: 'DAU / 人均', axisLabel: { color: '#6b7280' }, splitLine: { lineStyle: { color: '#1f2937' } } },
        { type: 'value', name: '事件数', axisLabel: { color: '#6b7280' }, splitLine: { show: false } },
      ],
      series: [
        { name: 'DAU', type: 'line', data: dau, smooth: true, itemStyle: { color: COLORS[0] }, areaStyle: { opacity: 0.2 } },
        { name: '人均事件数', type: 'line', data: perUser, smooth: true, itemStyle: { color: COLORS[2] },
          lineStyle: { type: 'dashed', width: 2 } },
        { name: '事件数', type: 'line', data: evs, smooth: true, yAxisIndex: 1, itemStyle: { color: COLORS[1] } },
      ],
    });
  } catch (e) { document.getElementById('ch-dau').innerHTML = '<div class="err">' + e.message + '</div>'; }
}

async function loadFunnel() {
  const root = document.getElementById('ch-funnel');
  try {
    const d = await getJson('/api/admin/analytics?metric=funnel');
    const top = d.steps[0].count || 1;
    root.innerHTML = d.steps.map((s, i) => {
      const pct = top > 0 ? Math.round(s.count / top * 100) : 0;
      const dropPct = i > 0 && d.steps[i-1].count > 0 ? Math.round(s.count / d.steps[i-1].count * 100) : 100;
      return '<div class="funnel-step">'
        + '<div><div class="name">' + s.name + '</div><div class="sub">' + s.label + '</div></div>'
        + '<div class="right"><div class="count">' + fmt(s.count) + '</div>'
        + '<div class="pct">' + pct + '% · 上一步保留 ' + dropPct + '%</div></div>'
        + '</div>';
    }).join('');
  } catch (e) { root.innerHTML = '<div class="err">' + e.message + '</div>'; }
}

async function loadSession() {
  const chart = echarts.init(document.getElementById('ch-session'), 'dark', { renderer: 'canvas' });
  try {
    const d = await getJson('/api/admin/analytics?metric=session-duration');
    const buckets = d.buckets.map(r => r.bucket);
    const sessions = d.buckets.map(r => r.sessions);
    chart.setOption({
      backgroundColor: 'transparent',
      grid: { left: 50, right: 30, top: 50, bottom: 30 },
      title: { text: '总平均 ' + fmtDuration(d.avg_sec) + ' · ' + fmt(d.total_sessions) + ' sessions',
               textStyle: { color: '#9ca3af', fontSize: 11, fontWeight: 'normal' }, left: 'center', top: 5 },
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: buckets, axisLabel: { color: '#6b7280', fontSize: 10 } },
      yAxis: { type: 'value', name: 'sessions', axisLabel: { color: '#6b7280' }, splitLine: { lineStyle: { color: '#1f2937' } } },
      series: [{ type: 'bar', data: sessions, itemStyle: { color: COLORS[2] } }],
    });
  } catch (e) { document.getElementById('ch-session').innerHTML = '<div class="err">' + e.message + '</div>'; }
}

// 表格默认折叠到前 visibleCount 行,超出部分加 .collapsed-row,插一个展开/收起按钮。
// 回访表 / 留存表通用。重渲染时先清掉旧按钮 + 重置 class(防重复插)。
function applyRowCollapse(tableId, visibleCount) {
  const table = document.getElementById(tableId);
  if (!table) return;
  const rows = Array.from(table.querySelectorAll('tbody tr'));
  const card = table.closest('.card');
  const old = card && card.querySelector('.row-toggle[data-for="' + tableId + '"]');
  if (old) old.remove();
  rows.forEach(tr => tr.classList.remove('collapsed-row'));
  if (rows.length <= visibleCount) return;
  let collapsed = true;
  const apply = () => rows.forEach((tr, i) => { if (i >= visibleCount) tr.classList.toggle('collapsed-row', collapsed); });
  const label = () => btn.textContent = collapsed ? ('展开全部 ' + rows.length + ' 行（+' + (rows.length - visibleCount) + '）') : '收起';
  const btn = document.createElement('button');
  btn.className = 'row-toggle';
  btn.setAttribute('data-for', tableId);
  btn.onclick = () => { collapsed = !collapsed; apply(); label(); };
  apply(); label();
  const scrollDiv = table.closest('div[style*="overflow"]') || table.parentElement;
  scrollDiv.insertAdjacentElement('afterend', btn);
}

async function loadReturning() {
  const tb = document.querySelector('#tbl-returning tbody');
  try {
    const d = await getJson('/api/admin/analytics?metric=returning');
    if (!d.days.length) { tb.innerHTML = '<tr><td colspan="6" class="muted">无数据</td></tr>'; return; }
    const rows = d.days.slice().reverse(); // 最新在前
    tb.innerHTML = rows.map(r => {
      const older = Math.max(0, r.dau - r.new_devices - r.back_7d);
      const rate = r.dau > 0 ? Math.round((r.dau - r.new_devices) / r.dau * 100) : 0;
      return '<tr><td>' + r.day + '</td>'
        + '<td class="num">' + fmt(r.dau) + '</td>'
        + '<td class="num">' + fmt(r.new_devices) + '</td>'
        + '<td class="num">' + fmt(r.back_7d) + '</td>'
        + '<td class="num' + (older === 0 ? ' muted' : '') + '">' + fmt(older) + '</td>'
        + '<td class="num">' + rate + '%</td>'
        + '</tr>';
    }).join('');
    applyRowCollapse('tbl-returning', 5);
  } catch (e) { tb.innerHTML = '<tr><td colspan="6" class="err">' + e.message + '</td></tr>'; }
}

async function loadRetention() {
  const tb = document.querySelector('#tbl-retention tbody');
  try {
    const d = await getJson('/api/admin/analytics?metric=retention');
    if (!d.cohorts.length) { tb.innerHTML = '<tr><td colspan="5" class="muted">无数据</td></tr>'; return; }
    tb.innerHTML = d.cohorts.map(r => {
      // d1/d3/d7 为 null = 未到期(后端成熟度门槛返回 NULL),渲染成「—」而非 0%
      const pct = (n) => n == null ? '—' : (r.cohort_size > 0 ? Math.round(n / r.cohort_size * 100) + '%' : '—');
      const cls = (n) => 'class="num' + (n == null || n === 0 ? ' muted' : '') + '"';
      return '<tr><td>' + r.cohort_day + '</td>'
        + '<td class="num">' + fmt(r.cohort_size) + '</td>'
        + '<td ' + cls(r.d1) + '>' + pct(r.d1) + '</td>'
        + '<td ' + cls(r.d3) + '>' + pct(r.d3) + '</td>'
        + '<td ' + cls(r.d7) + '>' + pct(r.d7) + '</td>'
        + '</tr>';
    }).join('');
    applyRowCollapse('tbl-retention', 5);
  } catch (e) { tb.innerHTML = '<tr><td colspan="5" class="err">' + e.message + '</td></tr>'; }
}

async function loadEvents() {
  const chart = echarts.init(document.getElementById('ch-events'), 'dark', { renderer: 'canvas' });
  try {
    const d = await getJson('/api/admin/analytics?metric=event-distribution');
    const rows = d.events.slice().reverse();
    const names = rows.map(r => evtZh(r.event_type));
    const rawTypes = rows.map(r => r.event_type);
    const evs = rows.map(r => r.events);
    const devs = rows.map(r => r.devices);
    chart.setOption({
      backgroundColor: 'transparent',
      grid: { left: 170, right: 30, top: 30, bottom: 30 },
      tooltip: {
        trigger: 'axis', axisPointer: { type: 'shadow' },
        formatter: (params) => {
          const i = params[0].dataIndex;
          const raw = rawTypes[i];
          return '<b>' + names[i] + '</b><br/>'
            + '<span style="color:#6b7280;font-family:monospace;font-size:11px">' + raw + '</span><br/>'
            + params.map(p => p.marker + p.seriesName + ': <b>' + fmt(p.value) + '</b>').join('<br/>');
        },
      },
      legend: { data: ['事件数', '设备数'], textStyle: { color: '#9ca3af' } },
      xAxis: { type: 'value', axisLabel: { color: '#6b7280' }, splitLine: { lineStyle: { color: '#1f2937' } } },
      yAxis: { type: 'category', data: names, axisLabel: { color: '#d1d5db', fontSize: 11 } },
      series: [
        { name: '事件数', type: 'bar', data: evs, itemStyle: { color: COLORS[1] } },
        { name: '设备数', type: 'bar', data: devs, itemStyle: { color: COLORS[0] } },
      ],
    });
  } catch (e) { document.getElementById('ch-events').innerHTML = '<div class="err">' + e.message + '</div>'; }
}

async function loadErrors() {
  const tb = document.querySelector('#tbl-errors tbody');
  try {
    const d = await getJson('/api/admin/analytics?metric=errors');
    if (!d.by_msg.length) { tb.innerHTML = '<tr><td colspan="4" class="muted">无错误</td></tr>'; return; }
    tb.innerHTML = d.by_msg.map(r =>
      '<tr><td title="' + r.event_type + '">' + evtZh(r.event_type) + '</td>'
      + '<td>' + (r.error_msg || '—') + '</td>'
      + '<td class="num">' + fmt(r.errors) + '</td>'
      + '<td class="num">' + fmt(r.devices) + '</td></tr>'
    ).join('');
  } catch (e) { tb.innerHTML = '<tr><td colspan="4" class="err">' + e.message + '</td></tr>'; }
}

async function loadErrorTrend() {
  const chart = echarts.init(document.getElementById('ch-error-trend'), 'dark', { renderer: 'canvas' });
  try {
    const d = await getJson('/api/admin/analytics?metric=error-trend');
    if (!d.rows.length) {
      document.getElementById('ch-error-trend').innerHTML = '<div class="loading">最近 30 天无错误数据</div>';
      return;
    }
    // pivot: rows[{day,event_type,errors}] → days[] + 每个 event_type 一个 series
    const daySet = new Set();
    const typeSet = new Set();
    const cell = {};
    for (const r of d.rows) {
      daySet.add(r.day);
      typeSet.add(r.event_type);
      if (!cell[r.day]) cell[r.day] = {};
      cell[r.day][r.event_type] = r.errors;
    }
    const days = Array.from(daySet).sort();
    const types = Array.from(typeSet);
    const series = types.map((t, i) => ({
      name: evtZh(t),
      type: 'bar',
      stack: 'errors',
      data: days.map(day => cell[day] && cell[day][t] || 0),
      itemStyle: { color: COLORS[i % COLORS.length] },
    }));
    chart.setOption({
      backgroundColor: 'transparent',
      grid: { left: 50, right: 30, top: 30, bottom: 50 },
      tooltip: {
        trigger: 'axis', axisPointer: { type: 'shadow' },
        formatter: (params) => {
          const day = params[0].axisValue;
          const total = params.reduce((s, p) => s + (p.value || 0), 0);
          const lines = params.filter(p => p.value > 0).map(p =>
            p.marker + p.seriesName + ': <b>' + fmt(p.value) + '</b>');
          return '<b>' + day + '</b> · 合计 ' + fmt(total) + '<br/>' + lines.join('<br/>');
        },
      },
      legend: { data: types.map(evtZh), textStyle: { color: '#9ca3af' }, bottom: 0, type: 'scroll' },
      xAxis: { type: 'category', data: days, axisLabel: { color: '#6b7280', fontSize: 10 } },
      yAxis: { type: 'value', name: '错误数', axisLabel: { color: '#6b7280' }, splitLine: { lineStyle: { color: '#1f2937' } } },
      series,
    });
  } catch (e) { document.getElementById('ch-error-trend').innerHTML = '<div class="err">' + e.message + '</div>'; }
}

// GitHub-style 28 格贡献小方格 (7 列 × 4 行整齐，无 pad)。activeDateCounts 是
// JSON 对象 {"YYYY-MM-DD": N} (后端 json_group_object 输出)。按当天 event 数
// 5 级染色：0 / 1-9 / 10-49 / 50-199 / 200+。今天那格 (最右下角，i=0) 带 outline。
// BJT 时区下 user 本地时区跟 events 表的 +8h 对齐。
function eventLevel(n) {
  if (!n) return 'lv0';
  if (n < 10) return 'lv1';
  if (n < 50) return 'lv2';
  if (n < 200) return 'lv3';
  return 'lv4';
}
function renderContribGrid(activeDateCounts) {
  if (!activeDateCounts) return '<span class="muted">—</span>';
  // 后端 json_group_object 输出 string，前端 parse。容错：万一是 object 直接用
  let counts;
  try { counts = typeof activeDateCounts === 'string' ? JSON.parse(activeDateCounts) : activeDateCounts; }
  catch (e) { return '<span class="muted">—</span>'; }
  const today = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  let html = '<div class="contrib">';
  for (let i = 27; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    const cnt = counts[key] || 0;
    const lv = eventLevel(cnt);
    const todayMark = i === 0 ? ' today' : '';
    const title = key + (cnt ? ' · ' + cnt + ' events' : ' · 无');
    html += '<span class="' + lv + todayMark + '" title="' + title + '"></span>';
  }
  return html + '</div>';
}

// 把原始 UA 翻译成 "macOS · Chrome 120" 这种人话。识别不出的退到 "其他设备"。
// 主流就这几个 device family + browser，没必要上 ua-parser-js 依赖。
function parseUA(ua) {
  if (!ua) return { device: '未知', browser: '' };
  // 顺序很重要：先匹配更具体的，否则 Mobile Safari 会被当成普通 Safari
  let device = '其他';
  if (/iPhone/i.test(ua)) device = 'iPhone';
  else if (/iPad/i.test(ua)) device = 'iPad';
  else if (/Android/i.test(ua)) device = 'Android';
  else if (/Macintosh/i.test(ua)) device = 'Mac';
  else if (/Windows/i.test(ua)) device = 'Windows';
  else if (/Linux/i.test(ua)) device = 'Linux';

  let browser = '';
  // 微信内置浏览器优先识别（覆盖 Safari/Chrome 内核）
  // 注意：以下 regex 内的 \\/ 和 \\d+ 是为了在 TS 外层 template literal 里
  // 输出 \/ 和 \d+ 给浏览器 JS 解析。直接写 \/ / \d V8 会当 invalid escape
  // 吃掉 backslash，regex 失效引发 SyntaxError。
  if (/MicroMessenger/i.test(ua)) browser = '微信';
  else if (/Weibo/i.test(ua)) browser = '微博';
  else if (/Edg\\//i.test(ua)) browser = 'Edge';
  else if (/OPR\\/|Opera/i.test(ua)) browser = 'Opera';
  else if (/Firefox/i.test(ua)) browser = 'Firefox';
  else if (/Chrome\\//i.test(ua) && !/Chromium/i.test(ua)) browser = 'Chrome';
  else if (/CriOS/i.test(ua)) browser = 'Chrome (iOS)';
  else if (/FxiOS/i.test(ua)) browser = 'Firefox (iOS)';
  else if (/Safari/i.test(ua)) browser = 'Safari';
  // Chrome 版本号
  const m = ua.match(/(?:Chrome|CriOS|Edg|Firefox|FxiOS|Version)\\/(\\d+)/);
  if (m && browser) browser += ' ' + m[1];

  return { device, browser };
}

async function loadDevices() {
  const tb = document.querySelector('#tbl-devices tbody');
  try {
    const d = await getJson('/api/admin/analytics?metric=top-devices');
    if (!d.devices.length) { tb.innerHTML = '<tr><td colspan="8" class="muted">无数据</td></tr>'; return; }
    tb.innerHTML = d.devices.map(r => {
      // 28 天分布:所有行都展示(此前仅 active_days ≥ 5 才显示)
      const grid = renderContribGrid(r.active_date_counts);
      const ua = parseUA(r.ua_sample || '');
      const uaCell = '<div class="ua-cell">'
        + '<div class="device-name">' + ua.device + (ua.browser ? ' · ' + ua.browser : '') + '</div>'
        + '<div class="ua-raw" title="' + (r.ua_sample || '').replace(/"/g, '&quot;') + '">' + (r.ua_sample || '—') + '</div>'
        + '</div>';
      // device_id 下方挂脱敏邮箱(若该设备关联过登录邮箱)
      const idCell = '<div class="dev-id">' + r.device_id + '</div>'
        + (r.email_masked ? '<div class="dev-email" title="该设备关联过的登录邮箱(已脱敏)">✉ ' + r.email_masked + '</div>' : '');
      // 事件类型:译成中文名展示 top3 +「等N种」,悬停 tooltip 列全部类型及次数(替代裸数字)
      let evtCell = '<span class="muted">—</span>';
      try {
        const ec = typeof r.event_type_counts === 'string' ? JSON.parse(r.event_type_counts) : (r.event_type_counts || {});
        const entries = Object.entries(ec).sort((a, b) => b[1] - a[1]);
        if (entries.length) {
          const top = entries.slice(0, 3).map(e => evtZh(e[0])).join('·');
          const more = entries.length > 3 ? ' 等' + entries.length + '种' : '';
          const tip = entries.map(e => evtZh(e[0]) + ' ' + e[1]).join(' / ');
          evtCell = '<span title="' + tip.replace(/"/g, '&quot;') + '">' + top + more + '</span>';
        }
      } catch (e) {}
      return '<tr><td>' + idCell + '</td>'
        + '<td class="num">' + fmt(r.events) + '</td>'
        + '<td class="num">' + fmt(r.active_days) + '</td>'
        + '<td>' + evtCell + '</td>'
        + '<td>' + r.first_seen + '</td>'
        + '<td>' + r.last_seen + '</td>'
        + '<td>' + grid + '</td>'
        + '<td style="max-width:340px">' + uaCell + '</td>'
        + '</tr>';
    }).join('');
  } catch (e) { tb.innerHTML = '<tr><td colspan="8" class="err">' + e.message + '</td></tr>'; }
}

async function loadDrawerBySource() {
  const chart = echarts.init(document.getElementById('ch-drawer-source'), 'dark', { renderer: 'canvas' });
  try {
    const d = await getJson('/api/admin/analytics?metric=drawer-by-source');
    if (!d.sources.length) {
      document.getElementById('ch-drawer-source').innerHTML = '<div class="loading">7 天无 drawer 打开数据</div>';
      return;
    }
    const SRC_LABELS = {
      x_list: 'X 动态', github: 'GitHub 开源', product_hunt: '产品 (PH)',
      clawhub: 'Skill (龙虾)', hf_paper: '论文 (HF)', huodongxing: '活动',
      // 新闻&播客频道(blog+podcast 合并):drawer 事件按单源记 blog/podcast,各占一条;
      // 标签对齐前端 PosterCanvas(blog→新闻 / podcast→播客)。复合值防御性补一条。
      // youtube 暂无 drawer 数据,补上与 CHANNEL_LABELS 保持一致 + 未来防御。
      blog: '新闻', podcast: '播客', 'blog,podcast': '新闻&播客', youtube: 'YouTube',
    };
    const rows = d.sources.slice().reverse();
    const names = rows.map(r => SRC_LABELS[r.source] || r.source || '未知');
    const opens = rows.map(r => r.opens);
    const devices = rows.map(r => r.devices);
    chart.setOption({
      backgroundColor: 'transparent',
      grid: { left: 110, right: 30, top: 30, bottom: 30 },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { data: ['打开次数', '设备数'], textStyle: { color: '#9ca3af' } },
      xAxis: { type: 'value', axisLabel: { color: '#6b7280' }, splitLine: { lineStyle: { color: '#1f2937' } } },
      yAxis: { type: 'category', data: names, axisLabel: { color: '#d1d5db', fontSize: 11 } },
      series: [
        { name: '打开次数', type: 'bar', data: opens, itemStyle: { color: COLORS[1] } },
        { name: '设备数', type: 'bar', data: devices, itemStyle: { color: COLORS[0] } },
      ],
    });
  } catch (e) { document.getElementById('ch-drawer-source').innerHTML = '<div class="err">' + e.message + '</div>'; }
}

async function loadFeedDepth() {
  const chart = echarts.init(document.getElementById('ch-feed-depth'), 'dark', { renderer: 'canvas' });
  try {
    const d = await getJson('/api/admin/analytics?metric=feed-depth');
    if (!d.days.length) {
      document.getElementById('ch-feed-depth').innerHTML = '<div class="loading">无浏览数据</div>';
      return;
    }
    const days = d.days.map(r => r.day);
    const avgImp = d.days.map(r => Math.round((r.avg_impressions || 0) * 10) / 10);
    const avgDrawer = d.days.map(r => Math.round((r.avg_drawer_opens || 0) * 10) / 10);
    const totalImp = d.days.map(r => r.total_impressions || 0);
    chart.setOption({
      backgroundColor: 'transparent',
      grid: { left: 50, right: 50, top: 30, bottom: 30 },
      tooltip: { trigger: 'axis' },
      legend: { data: ['人均曝光 item', '人均打开 drawer', '曝光总数'], textStyle: { color: '#9ca3af' } },
      xAxis: { type: 'category', data: days, axisLabel: { color: '#6b7280', fontSize: 10 } },
      yAxis: [
        { type: 'value', name: '人均', axisLabel: { color: '#6b7280' }, splitLine: { lineStyle: { color: '#1f2937' } } },
        { type: 'value', name: '曝光总数', axisLabel: { color: '#6b7280' }, splitLine: { show: false } },
      ],
      series: [
        { name: '人均曝光 item', type: 'line', data: avgImp, smooth: true, itemStyle: { color: COLORS[0] }, areaStyle: { opacity: 0.2 } },
        { name: '人均打开 drawer', type: 'line', data: avgDrawer, smooth: true, itemStyle: { color: COLORS[2] }, lineStyle: { type: 'dashed' } },
        { name: '曝光总数', type: 'line', data: totalImp, smooth: true, yAxisIndex: 1, itemStyle: { color: COLORS[1] } },
      ],
    });
  } catch (e) { document.getElementById('ch-feed-depth').innerHTML = '<div class="err">' + e.message + '</div>'; }
}

async function loadChannels() {
  const tb = document.querySelector('#tbl-channels tbody');
  try {
    const d = await getJson('/api/admin/analytics?metric=channel-dwell');
    if (!d.channels.length) { tb.innerHTML = '<tr><td colspan="5" class="muted">无切换事件 — 没人切过频道</td></tr>'; return; }
    // 频道 id → 中文标签。跟前端 sources 配置对齐（dashboard/src/sources 那套）
    const CHANNEL_LABELS = {
      x_list: 'X List', github: 'GitHub', product_hunt: 'Product Hunt',
      clawhub: 'ClawHub', hf_paper: 'HuggingFace Paper', huodongxing: '活动行',
      // 新闻&播客频道:filter 哨兵值是复合 "blog,podcast"(频道切换事件记的就是它);
      // 个别 blog/podcast 单值防御性补,对齐前端标签。youtube 真实出现在切换数据里(此前裸显示)。
      'blog,podcast': '新闻&播客', blog: '新闻', podcast: '播客', youtube: 'YouTube',
    };
    tb.innerHTML = d.channels.map(r => {
      const name = CHANNEL_LABELS[r.channel] || r.channel;
      return '<tr><td title="' + r.channel + '">' + name + '</td>'
        + '<td class="num">' + fmtDuration(r.avg_sec) + '</td>'
        + '<td class="num">' + fmtDuration(r.total_sec) + '</td>'
        + '<td class="num">' + fmt(r.sessions) + '</td>'
        + '<td class="num">' + fmt(r.devices) + '</td></tr>';
    }).join('');
  } catch (e) { tb.innerHTML = '<tr><td colspan="5" class="err">' + e.message + '</td></tr>'; }
}

async function loadLoadPerf() {
  const chart = echarts.init(document.getElementById('ch-load-perf'), 'dark', { renderer: 'canvas' });
  const tb = document.querySelector('#tbl-load-slice tbody');
  try {
    const d = await getJson('/api/admin/analytics?metric=load-perf');
    const legacyCohort = {
      overall: Array.isArray(d.overall) ? d.overall : [],
      slices: Array.isArray(d.slices) ? d.slices : [],
    };
    const cohorts = {
      all_clean: d.all_clean || legacyCohort,
      engaged: d.engaged || null,
      synthetic: d.synthetic || null,
    };
    const cohortNotes = {
      all_clean: '排除 owner 与显式测速，保留无互动的真实慢用户',
      engaged: '真实全量中，同设备同 session 的 ±30 分钟内发生过明确操作',
      synthetic: '仅 payload traffic_kind=synthetic 或 codex_perf_probe 路径',
    };
    const buttons = Array.from(document.querySelectorAll('[data-perf-cohort]'));
    const note = document.getElementById('perf-cohort-note');
    const PERF_LABEL = { ttfb: '首字节TTFB', response: '下载(段)', dom: 'DOM就绪', dcl: '结构齐DCL', fcp: '出内容FCP', lcp: '主图LCP', load: '全就绪LOAD', img: '单图(独立)' };

    function renderLoadPerfCohort(key) {
      const cohort = cohorts[key];
      if (!cohort) return;
      buttons.forEach(function(button) {
        const selected = button.getAttribute('data-perf-cohort') === key;
        button.classList.toggle('active', selected);
        button.setAttribute('aria-pressed', selected ? 'true' : 'false');
      });
      if (note) note.textContent = cohortNotes[key] || '';

      const overall = Array.isArray(cohort.overall) ? cohort.overall : [];
      const names = overall.map(r => PERF_LABEL[r.metric] || (r.metric || '').toUpperCase());
      const p50 = overall.map(r => Math.round(r.p50 || 0));
      const p75 = overall.map(r => Math.round(r.p75 || 0));
      const p95 = overall.map(r => Math.round(r.p95 || 0));
      chart.setOption({
        backgroundColor: 'transparent',
        grid: { left: 60, right: 30, top: 40, bottom: 30 },
        tooltip: {
          trigger: 'axis', axisPointer: { type: 'shadow' },
          formatter: (params) => params[0].axisValue + '<br/>'
            + params.map(p => p.marker + p.seriesName + ': <b>' + fmt(p.value) + 'ms</b>').join('<br/>'),
        },
        legend: { data: ['P50', 'P75', 'P95'], textStyle: { color: '#9ca3af' } },
        xAxis: { type: 'category', data: names, axisLabel: { color: '#6b7280', fontSize: 10, interval: 0, rotate: 18 } },
        yAxis: { type: 'value', name: 'ms', axisLabel: { color: '#6b7280' }, splitLine: { lineStyle: { color: '#1f2937' } } },
        series: [
          { name: 'P50', type: 'bar', data: p50, itemStyle: { color: COLORS[0] } },
          { name: 'P75', type: 'bar', data: p75, itemStyle: { color: COLORS[2] } },
          { name: 'P95', type: 'bar', data: p95, itemStyle: { color: COLORS[3] } },
        ],
      }, true);

      const slices = Array.isArray(cohort.slices) ? cohort.slices : [];
      if (!slices.length) {
        tb.innerHTML = '<tr><td colspan="5" class="muted">暂无 perf_nav 样本（单切片需 ≥3 条）</td></tr>';
      } else {
        tb.innerHTML = slices.map(r =>
          '<tr><td>' + (r.client === 'wechat' ? '微信' : '其他') + '</td>'
          + '<td>' + (r.net || 'unknown') + '</td>'
          + '<td class="num">' + fmt(r.avg_load) + 'ms</td>'
          + '<td class="num">' + fmt(r.avg_ttfb) + 'ms</td>'
          + '<td class="num">' + fmt(r.samples) + '</td></tr>'
        ).join('');
      }
    }

    buttons.forEach(function(button) {
      const key = button.getAttribute('data-perf-cohort');
      button.disabled = !cohorts[key];
      button.addEventListener('click', function() { renderLoadPerfCohort(key); });
    });
    renderLoadPerfCohort('all_clean');
  } catch (e) {
    document.getElementById('ch-load-perf').innerHTML = '<div class="err">' + e.message + '</div>';
    tb.innerHTML = '<tr><td colspan="5" class="err">' + e.message + '</td></tr>';
  }
}

// 搜索监控:一次 fetch ?metric=search 拿 { overview, topQueries, perf, errors, indexLag }
// 全量渲染 5 张卡。搜索词 q 是用户输入 → 一律 esc() 转义防 XSS。
async function loadSearch() {
  try {
    const d = await getJson('/api/admin/analytics?metric=search');
    // 使用总览
    const o = d.overview || {};
    const pv = o.pv || 0, uv = o.uv || 0, empties = o.empties || 0, clicks = o.clicks || 0;
    document.getElementById('se-pv').textContent = fmt(pv);
    document.getElementById('se-uv').textContent = fmt(uv);
    document.getElementById('se-per').textContent = uv > 0 ? (pv / uv).toFixed(1) : '—';
    document.getElementById('se-empty').textContent = pv > 0 ? (100 * empties / pv).toFixed(1) + '%' : '—';
    document.getElementById('se-ctr').textContent = pv > 0 ? (100 * clicks / pv).toFixed(1) + '%' : '—';
    // 热门搜索词（q 转义）
    const qtb = document.querySelector('#tbl-search-queries tbody');
    const queries = (d.topQueries && d.topQueries.queries) || [];
    if (!queries.length) {
      qtb.innerHTML = '<tr><td colspan="4" class="muted">近 7 天无搜索</td></tr>';
    } else {
      qtb.innerHTML = queries.map(function(r, i) {
        return '<tr><td class="num">' + (i + 1) + '</td><td>' + esc(r.q) +
          '</td><td class="num">' + fmt(r.submits) +
          '</td><td class="num' + (r.empties > 0 ? '' : ' muted') + '">' + fmt(r.empties) + '</td></tr>';
      }).join('');
    }
    // 搜索性能
    const ptb = document.querySelector('#tbl-search-perf tbody');
    const perf = d.perf || {};
    const prow = function(label, m) {
      m = m || {};
      const cell = function(v) { return m.samples ? fmt(Math.round(v || 0)) + 'ms' : '—'; };
      return '<tr><td>' + label + '</td>'
        + '<td class="num">' + cell(m.p50) + '</td>'
        + '<td class="num">' + cell(m.p90) + '</td>'
        + '<td class="num">' + cell(m.p99) + '</td>'
        + '<td class="num">' + fmt(m.samples || 0) + '</td></tr>';
    };
    ptb.innerHTML = prow('server（worker 查询）', perf.server) + prow('client（前端总耗时）', perf.client);
    // 搜索异常（按日 pivot 成 kind 列）
    const etb = document.querySelector('#tbl-search-errors tbody');
    const erows = (d.errors && d.errors.rows) || [];
    if (!erows.length) {
      etb.innerHTML = '<tr><td colspan="6" class="muted">近 7 天无搜索异常</td></tr>';
    } else {
      const byDay = {};
      erows.forEach(function(r) {
        if (!byDay[r.day]) byDay[r.day] = { rate_limited: 0, server: 0, client: 0, network: 0, total: 0 };
        if (byDay[r.day][r.kind] != null) byDay[r.day][r.kind] += r.errors;
        byDay[r.day].total += r.errors;
      });
      const days = Object.keys(byDay).sort().reverse();
      etb.innerHTML = days.map(function(day) {
        const c = byDay[day];
        const cell = function(v) { return '<td class="num' + (v ? '' : ' muted') + '">' + fmt(v) + '</td>'; };
        return '<tr><td>' + esc(day) + '</td>'
          + cell(c.rate_limited) + cell(c.server) + cell(c.client) + cell(c.network)
          + '<td class="num">' + fmt(c.total) + '</td></tr>';
      }).join('');
    }
    // 索引滞后
    const lag = d.indexLag || {};
    if (lag.present) {
      document.getElementById('se-elig').textContent = fmt(lag.itemsEligible);
      document.getElementById('se-fts').textContent = fmt(lag.ftsRows);
      document.getElementById('se-drift').textContent = fmt(lag.drift);
      document.getElementById('se-purged').textContent = fmt(lag.purged);
      document.getElementById('se-reconcile-at').textContent =
        '对账时间：' + (lag.at ? new Date(lag.at).toLocaleString('zh-CN', { hour12: false }) : '—');
    } else {
      ['se-elig','se-fts','se-drift','se-purged'].forEach(function(id){ document.getElementById(id).textContent = '—'; });
      document.getElementById('se-reconcile-at').textContent = '对账时间：还没跑过 reconcile';
    }
  } catch (e) {
    console.error('search', e);
    [['tbl-search-queries',4],['tbl-search-perf',5],['tbl-search-errors',6]].forEach(function(p){
      const tb = document.querySelector('#' + p[0] + ' tbody');
      if (tb) tb.innerHTML = '<tr><td colspan="' + p[1] + '" class="err">' + esc(e.message || e) + '</td></tr>';
    });
  }
}

// Resize charts on window resize so cards don't overflow on mobile/tablet.
window.addEventListener('resize', () => {
  ['ch-dau','ch-session','ch-events','ch-error-trend','ch-drawer-source','ch-feed-depth','ch-load-perf'].forEach(id => {
    const el = document.getElementById(id);
    if (el && el.__echarts__) {
      const inst = echarts.getInstanceByDom(el);
      if (inst) inst.resize();
    }
  });
});

Promise.all([
  loadOverview(),
  loadDubWishlist(),
  loadDauTrend(),
  loadFunnel(),
  loadSession(),
  loadChannels(),
  loadDrawerBySource(),
  loadFeedDepth(),
  loadLoadPerf(),
  loadReturning(),
  loadRetention(),
  loadEvents(),
  loadErrorTrend(),
  loadErrors(),
  loadDevices(),
  loadSearch(),
]);
</script>
</body>
</html>`;
