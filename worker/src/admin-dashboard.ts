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
    case 'feed-depth':
      return jsonRes(await metricFeedDepth(env));
    case 'load-perf':
      return jsonRes(await metricLoadPerf(env));
    default:
      return jsonRes({ error: `unknown metric: ${metric}`, available: [
        'overview', 'dau-trend', 'retention', 'event-distribution',
        'funnel', 'session-duration', 'errors', 'error-trend',
        'top-devices', 'channel-dwell', 'drawer-by-source', 'feed-depth',
        'load-perf',
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
      COUNT(DISTINCT CASE WHEN CAST(julianday(date(e.occurred_at/1000,'unixepoch','+8 hours')) - julianday(fs.cohort_day) AS INTEGER) = 1 THEN fs.device_id END) AS d1,
      COUNT(DISTINCT CASE WHEN CAST(julianday(date(e.occurred_at/1000,'unixepoch','+8 hours')) - julianday(fs.cohort_day) AS INTEGER) = 3 THEN fs.device_id END) AS d3,
      COUNT(DISTINCT CASE WHEN CAST(julianday(date(e.occurred_at/1000,'unixepoch','+8 hours')) - julianday(fs.cohort_day) AS INTEGER) = 7 THEN fs.device_id END) AS d7
    FROM first_seen fs
    JOIN events e ON e.device_id = fs.device_id
    WHERE fs.cohort_day >= date('now','-30 days','+8 hours')
    GROUP BY fs.cohort_day
    ORDER BY fs.cohort_day DESC
  `).all();
  return { cohorts: rs.results };
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
async function pctl(env: Env, eventType: string, path: string) {
  const row = await env.DB.prepare(`
    WITH vals AS (
      SELECT CAST(json_extract(event_payload,'$.${path}') AS REAL) AS v
      FROM events
      WHERE event_type=? AND occurred_at > (strftime('%s','now')-7*86400)*1000
        AND ${NOT_OWNER_SQL} AND json_extract(event_payload,'$.${path}') IS NOT NULL
    ),
    ranked AS (SELECT v, COUNT(*) OVER() AS n, ROW_NUMBER() OVER(ORDER BY v) AS rn FROM vals)
    SELECT MAX(CASE WHEN rn=CAST(0.50*n AS INT)+1 THEN v END) AS p50,
           MAX(CASE WHEN rn=CAST(0.75*n AS INT)+1 THEN v END) AS p75,
           MAX(CASE WHEN rn=CAST(0.95*n AS INT)+1 THEN v END) AS p95,
           MAX(n) AS samples FROM ranked
  `).bind(eventType).first<{ p50: number; p75: number; p95: number; samples: number }>();
  return row ?? { p50: 0, p75: 0, p95: 0, samples: 0 };
}

async function metricLoadPerf(env: Env) {
  // 各里程碑 → [展示名, 事件类型, payload 字段]。perf_nav 拆相位（ttfb/dom/dcl/response/load），
  // FCP/LCP 来自 web-vitals 各自的 value 字段。
  const M: [string, string, string][] = [
    ['ttfb', 'perf_nav', 'ttfb'], ['fcp', 'perf_fcp', 'value'], ['lcp', 'perf_lcp', 'value'],
    ['dom', 'perf_nav', 'dom_interactive'], ['dcl', 'perf_nav', 'dcl'],
    ['response', 'perf_nav', 'response'], ['load', 'perf_nav', 'load'],
    ['img', 'perf_img', 'dur'],
  ];
  const overall: Array<{ metric: string; p50: number; p75: number; p95: number; samples: number }> = [];
  for (const [name, t, p] of M) overall.push({ metric: name, ...(await pctl(env, t, p)) });
  // 切片：客户端（微信 vs 其他）× 网络（effectiveType，iOS 微信无 → unknown）。
  // is_wechat 客户端发 JS boolean → JSON true/false → json_extract 返回 1/0，故 =1 正确。
  const slices = await env.DB.prepare(`
    WITH base AS (
      SELECT CASE WHEN json_extract(event_payload,'$.is_wechat')=1 THEN 'wechat' ELSE 'other' END AS client,
             COALESCE(json_extract(event_payload,'$.nettype'),'unknown') AS net,
             CAST(json_extract(event_payload,'$.load') AS REAL) AS load_ms,
             CAST(json_extract(event_payload,'$.ttfb') AS REAL) AS ttfb_ms
      FROM events WHERE event_type='perf_nav'
        AND occurred_at > (strftime('%s','now')-7*86400)*1000 AND ${NOT_OWNER_SQL})
    SELECT client, net, COUNT(*) AS samples,
           CAST(AVG(load_ms) AS INT) AS avg_load, CAST(AVG(ttfb_ms) AS INT) AS avg_ttfb
    FROM base GROUP BY client, net HAVING samples >= 3 ORDER BY avg_load DESC
  `).all();
  return { overall, slices: slices.results };
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

async function metricTopDevices(env: Env) {
  // active_date_counts = 该 device 28 天内每天的事件数，json 对象 {"YYYY-MM-DD": N}。
  // 前端按 count 分级染色渲染 GitHub 风格 28 格（7×4）贡献小方格。28 而非 30 让
  // 7 列 × 4 行整齐，无需 pad；最右下角是今天（带 outline）。
  // 用 CTE 先按 device+day group 算 cnt，再 outer 用 json_group_object 拼。
  // 避免 correlated subquery 跟 NOT_OWNER_SQL 拼接时 alias 混乱。
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
    per_dev AS (
      SELECT
        device_id,
        COUNT(DISTINCT event_type) AS event_types,
        substr(COALESCE(MAX(ua),''), 1, 80) AS ua_sample
      FROM events
      WHERE occurred_at > (strftime('%s','now')-28*86400)*1000
        AND ${NOT_OWNER_SQL}
        AND ${IS_REAL_USER_SQL}
      GROUP BY device_id
    )
    SELECT
      d.device_id,
      SUM(d.cnt) AS events,
      COUNT(*) AS active_days,
      p.event_types,
      MIN(d.day) AS first_seen,
      MAX(d.day) AS last_seen,
      p.ua_sample,
      json_group_object(d.day, d.cnt) AS active_date_counts
    FROM per_dev_day d
    JOIN per_dev p ON p.device_id = d.device_id
    GROUP BY d.device_id, p.event_types, p.ua_sample
    ORDER BY active_days DESC, events DESC
    LIMIT 30
  `).all();
  return { devices: rs.results };
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

// ─── /admin/dashboard → 仪表盘 HTML ──────────────────────────────
export async function serveAdminDashboardHtml(request: Request, env: Env): Promise<Response> {
  const guard = await requireAuth(request, env);
  if (guard) return guard;
  return new Response(DASHBOARD_HTML, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

const DASHBOARD_HTML = `<!doctype html>
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

  <div class="card wide" data-testid="card-feed-depth">
    <h2>📜 人均浏览深度</h2>
    <p class="hint">最近 30 天每天人均 item_impression（曝光到屏幕中央的 item 数）+ 人均 item_open_drawer。粗略反映"翻多深"。严格翻页深度需 FE 加 feed_load_more 埋点</p>
    <div class="chart tall" id="ch-feed-depth"></div>
  </div>

  <div class="card wide" data-testid="card-load-perf">
    <h2>🚀 页面打开耗时</h2>
    <p class="hint">7 天内 perf_nav / FCP / LCP 的 p50/p75/p95（ms）；下表按 客户端×网络 切片，定位国内微信慢在哪</p>
    <div class="chart tall" id="ch-load-perf"></div>
    <div style="overflow-x:auto;margin-top:12px"><table id="tbl-load-slice"><thead><tr>
      <th>客户端</th><th>网络</th><th class="num">avg load</th><th class="num">avg ttfb</th><th class="num">样本</th>
    </tr></thead><tbody><tr><td colspan="5" class="loading">loading…</td></tr></tbody></table></div>
  </div>

  <div class="card wide" data-testid="card-retention">
    <h2>♻️ 留存矩阵</h2>
    <p class="hint">最近 30 天每个 cohort（首次访问日期）在 +1/+3/+7 天的留存率</p>
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
    <p class="hint">最近 28 天按 active_days × events 排序前 30。active_days ≥ 5 加 GitHub 风格活跃日方格（7×4 排列，由浅到深 4 级颜色按当天 event 数：1-9 / 10-49 / 50-199 / 200+；带边框那格是今天）</p>
    <div style="overflow-x:auto"><table id="tbl-devices"><thead><tr>
      <th>device_id</th><th class="num">events</th><th class="num">活跃天</th><th class="num">事件类型</th>
      <th>first seen</th><th>last seen</th><th>28 天分布</th><th>UA</th>
    </tr></thead><tbody><tr><td colspan="8" class="loading">loading…</td></tr></tbody></table></div>
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

async function loadRetention() {
  const tb = document.querySelector('#tbl-retention tbody');
  try {
    const d = await getJson('/api/admin/analytics?metric=retention');
    if (!d.cohorts.length) { tb.innerHTML = '<tr><td colspan="5" class="muted">无数据</td></tr>'; return; }
    tb.innerHTML = d.cohorts.map(r => {
      const pct = (n) => r.cohort_size > 0 ? Math.round(n / r.cohort_size * 100) + '%' : '—';
      const cls = (n) => 'class="num' + (n === 0 ? ' muted' : '') + '"';
      return '<tr><td>' + r.cohort_day + '</td>'
        + '<td class="num">' + fmt(r.cohort_size) + '</td>'
        + '<td ' + cls(r.d1) + '>' + pct(r.d1) + '</td>'
        + '<td ' + cls(r.d3) + '>' + pct(r.d3) + '</td>'
        + '<td ' + cls(r.d7) + '>' + pct(r.d7) + '</td>'
        + '</tr>';
    }).join('');
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
      const grid = r.active_days >= 5 ? renderContribGrid(r.active_date_counts) : '<span class="muted">—</span>';
      const ua = parseUA(r.ua_sample || '');
      const uaCell = '<div class="ua-cell">'
        + '<div class="device-name">' + ua.device + (ua.browser ? ' · ' + ua.browser : '') + '</div>'
        + '<div class="ua-raw" title="' + (r.ua_sample || '').replace(/"/g, '&quot;') + '">' + (r.ua_sample || '—') + '</div>'
        + '</div>';
      return '<tr><td>' + r.device_id + '</td>'
        + '<td class="num">' + fmt(r.events) + '</td>'
        + '<td class="num">' + fmt(r.active_days) + '</td>'
        + '<td class="num">' + fmt(r.event_types) + '</td>'
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
    // 分位柱状：x = 里程碑（大写），P50/P75/P95 三组（快→慢用 绿/黄/红）
    const names = d.overall.map(r => (r.metric || '').toUpperCase());
    const p50 = d.overall.map(r => Math.round(r.p50 || 0));
    const p75 = d.overall.map(r => Math.round(r.p75 || 0));
    const p95 = d.overall.map(r => Math.round(r.p95 || 0));
    chart.setOption({
      backgroundColor: 'transparent',
      grid: { left: 60, right: 30, top: 40, bottom: 30 },
      tooltip: {
        trigger: 'axis', axisPointer: { type: 'shadow' },
        formatter: (params) => params[0].axisValue + '<br/>'
          + params.map(p => p.marker + p.seriesName + ': <b>' + fmt(p.value) + 'ms</b>').join('<br/>'),
      },
      legend: { data: ['P50', 'P75', 'P95'], textStyle: { color: '#9ca3af' } },
      xAxis: { type: 'category', data: names, axisLabel: { color: '#6b7280', fontSize: 10 } },
      yAxis: { type: 'value', name: 'ms', axisLabel: { color: '#6b7280' }, splitLine: { lineStyle: { color: '#1f2937' } } },
      series: [
        { name: 'P50', type: 'bar', data: p50, itemStyle: { color: COLORS[0] } },
        { name: 'P75', type: 'bar', data: p75, itemStyle: { color: COLORS[2] } },
        { name: 'P95', type: 'bar', data: p95, itemStyle: { color: COLORS[3] } },
      ],
    });
    // 切片表：客户端 × 网络
    if (!d.slices.length) {
      tb.innerHTML = '<tr><td colspan="5" class="muted">暂无 perf_nav 样本（单切片需 ≥3 条）</td></tr>';
    } else {
      tb.innerHTML = d.slices.map(r =>
        '<tr><td>' + (r.client === 'wechat' ? '微信' : '其他') + '</td>'
        + '<td>' + (r.net || 'unknown') + '</td>'
        + '<td class="num">' + fmt(r.avg_load) + 'ms</td>'
        + '<td class="num">' + fmt(r.avg_ttfb) + 'ms</td>'
        + '<td class="num">' + fmt(r.samples) + '</td></tr>'
      ).join('');
    }
  } catch (e) {
    document.getElementById('ch-load-perf').innerHTML = '<div class="err">' + e.message + '</div>';
    tb.innerHTML = '<tr><td colspan="5" class="err">' + e.message + '</td></tr>';
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
  loadDauTrend(),
  loadFunnel(),
  loadSession(),
  loadChannels(),
  loadDrawerBySource(),
  loadFeedDepth(),
  loadLoadPerf(),
  loadRetention(),
  loadEvents(),
  loadErrorTrend(),
  loadErrors(),
  loadDevices(),
]);
</script>
</body>
</html>`;
