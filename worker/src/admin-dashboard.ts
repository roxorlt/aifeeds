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
    default:
      return jsonRes({ error: `unknown metric: ${metric}`, available: [
        'overview', 'dau-trend', 'retention', 'event-distribution',
        'funnel', 'session-duration', 'errors', 'error-trend', 'top-devices',
      ] }, 400);
  }
}

// Error event types — 与 metricErrors 保持一致，error-trend 走同一名单，
// event-distribution 用来排除（避免 events 列表跟错误模块重复）。
const ERROR_EVENT_TYPES = ['api_error', 'js_error', 'feed_load_error', 'image_load_error', 'unhandled_promise'];

async function metricOverview(env: Env) {
  const row = await env.DB.prepare(`
    SELECT
      COUNT(DISTINCT CASE WHEN occurred_at > (strftime('%s','now')-1*86400)*1000 THEN device_id END) AS dau,
      COUNT(DISTINCT CASE WHEN occurred_at > (strftime('%s','now')-7*86400)*1000 THEN device_id END) AS wau,
      COUNT(DISTINCT CASE WHEN occurred_at > (strftime('%s','now')-30*86400)*1000 THEN device_id END) AS mau,
      COUNT(DISTINCT device_id) AS total_devices,
      COUNT(*) AS total_events
    FROM events
  `).first<{ dau: number; wau: number; mau: number; total_devices: number; total_events: number }>();
  return { ...row };
}

async function metricDauTrend(env: Env) {
  const rs = await env.DB.prepare(`
    SELECT
      date(occurred_at/1000, 'unixepoch', '+8 hours') AS day,
      COUNT(DISTINCT device_id) AS dau,
      COUNT(*) AS events
    FROM events
    WHERE occurred_at > (strftime('%s','now')-30*86400)*1000
    GROUP BY day
    ORDER BY day
  `).all();
  return { days: rs.results };
}

async function metricRetention(env: Env) {
  // Cohort × N-day retention. cohort_day = device 第一次出现的日期。
  // d1 / d3 / d7 = 那天首次访问的 device，N 天后是否还回访。
  const rs = await env.DB.prepare(`
    WITH first_seen AS (
      SELECT device_id, MIN(date(occurred_at/1000,'unixepoch','+8 hours')) AS cohort_day
      FROM events
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
  const placeholders = ERROR_EVENT_TYPES.map(() => '?').join(',');
  const rs = await env.DB.prepare(`
    SELECT event_type, COUNT(*) AS events, COUNT(DISTINCT device_id) AS devices
    FROM events
    WHERE occurred_at > (strftime('%s','now')-7*86400)*1000
      AND event_type NOT IN (${placeholders})
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
      GROUP BY date(occurred_at/1000,'unixepoch','+8 hours'), device_id
      HAVING COUNT(*) >= 2 AND session_seconds > 0
    )
    SELECT CAST(AVG(session_seconds) AS INTEGER) AS avg_sec, COUNT(*) AS total_sessions
    FROM device_sessions
  `).first<{ avg_sec: number; total_sessions: number }>();
  return { buckets: rs.results, avg_sec: overall?.avg_sec ?? 0, total_sessions: overall?.total_sessions ?? 0 };
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
    GROUP BY event_type, error_msg
    ORDER BY errors DESC
    LIMIT 20
  `).all();
  const byDevice = await env.DB.prepare(`
    SELECT device_id, COUNT(*) AS errors, COUNT(DISTINCT event_type) AS error_types
    FROM events
    WHERE event_type IN ('api_error','js_error','feed_load_error','image_load_error','unhandled_promise')
      AND occurred_at > (strftime('%s','now')-7*86400)*1000
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
    GROUP BY day, event_type
    ORDER BY day, event_type
  `).bind(...ERROR_EVENT_TYPES).all();
  return { rows: rs.results };
}

async function metricTopDevices(env: Env) {
  const rs = await env.DB.prepare(`
    SELECT
      device_id,
      COUNT(*) AS events,
      COUNT(DISTINCT date(occurred_at/1000,'unixepoch','+8 hours')) AS active_days,
      COUNT(DISTINCT event_type) AS event_types,
      MIN(date(occurred_at/1000,'unixepoch','+8 hours')) AS first_seen,
      MAX(date(occurred_at/1000,'unixepoch','+8 hours')) AS last_seen,
      substr(COALESCE(MAX(ua),''), 1, 80) AS ua_sample
    FROM events
    WHERE occurred_at > (strftime('%s','now')-30*86400)*1000
    GROUP BY device_id
    ORDER BY active_days DESC, events DESC
    LIMIT 30
  `).all();
  return { devices: rs.results };
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
<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js"></script>
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
             border-bottom: 1px solid #1f2937; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
  thead th.num { text-align: right; }
  tbody td { padding: 6px 8px; border-bottom: 1px solid #1f2937; color: #d1d5db; font-family: ui-monospace, monospace; }
  tbody tr:hover { background: #161b24; }
  td.num { text-align: right; }
  td.muted { color: #6b7280; }

  .funnel-step { display: grid; grid-template-columns: 1fr auto; gap: 12px; margin: 8px 0;
                 padding: 12px; background: #0b0e14; border: 1px solid #1f2937; border-radius: 6px; }
  .funnel-step .name { font-size: 13px; color: #e6e8eb; font-weight: 500; }
  .funnel-step .sub { font-size: 11px; color: #6b7280; margin-top: 2px; font-family: ui-monospace, monospace; }
  .funnel-step .right { text-align: right; font-family: ui-monospace, monospace; }
  .funnel-step .count { font-size: 18px; color: #e6e8eb; font-weight: 600; }
  .funnel-step .pct { font-size: 11px; color: #6ee7b7; }

  .loading { color: #6b7280; font-size: 12px; text-align: center; padding: 24px; }
  .err { color: #fca5a5; font-size: 12px; padding: 12px; background: #1f1212; border: 1px solid #7f1d1d; border-radius: 6px; }
</style>
</head>
<body>
${adminNavHtml('dashboard')}
<main>

<div class="kpi-row" id="kpis">
  <div class="kpi"><div class="label">DAU · 今日</div><div class="value" id="kpi-dau">—</div><div class="hint">最近 24h 独立 device</div></div>
  <div class="kpi"><div class="label">WAU · 7d</div><div class="value" id="kpi-wau">—</div><div class="hint">最近 7 天独立 device</div></div>
  <div class="kpi"><div class="label">MAU · 30d</div><div class="value" id="kpi-mau">—</div><div class="hint">最近 30 天独立 device</div></div>
  <div class="kpi"><div class="label">累计 device</div><div class="value" id="kpi-total">—</div><div class="hint">events 表全部 unique</div></div>
  <div class="kpi"><div class="label">累计事件</div><div class="value" id="kpi-events">—</div><div class="hint">events 表全部行数</div></div>
</div>

<div class="grid">

  <div class="card wide">
    <h2>📈 DAU 趋势</h2>
    <p class="hint">最近 30 天每天独立 device 数 + 事件总数（双轴）</p>
    <div class="chart tall" id="ch-dau"></div>
  </div>

  <div class="card">
    <h2>🎯 行为漏斗</h2>
    <p class="hint">7 天内每个 device 是否触达 4 步关键行为（独立 device 数）</p>
    <div id="ch-funnel"></div>
  </div>

  <div class="card">
    <h2>⏱ 会话时长分布</h2>
    <p class="hint">7 天内每个 device-day 的事件首末时间差。session_end 在 mobile 大量丢失，用 max-min 兜底</p>
    <div class="chart" id="ch-session"></div>
  </div>

  <div class="card wide">
    <h2>♻️ 留存矩阵</h2>
    <p class="hint">最近 30 天每个 cohort（首次访问日期）在 +1/+3/+7 天的留存率</p>
    <div style="overflow-x:auto"><table id="tbl-retention"><thead><tr>
      <th>cohort 日</th><th class="num">新增</th>
      <th class="num">+1d</th><th class="num">+3d</th><th class="num">+7d</th>
    </tr></thead><tbody><tr><td colspan="5" class="loading">loading…</td></tr></tbody></table></div>
  </div>

  <div class="card">
    <h2>🧩 事件类型分布</h2>
    <p class="hint">7 天内 top 事件类型（按次数，排除错误类，错误见下方专门模块）</p>
    <div class="chart tall" id="ch-events"></div>
  </div>

  <div class="card wide">
    <h2>⚠️ 错误趋势</h2>
    <p class="hint">最近 30 天每天各类前端错误次数（堆叠柱状）。timeout_5000ms 是 fetch 5s 超时，不是后端 500</p>
    <div class="chart tall" id="ch-error-trend"></div>
  </div>

  <div class="card wide">
    <h2>⚠️ 错误明细（7 天 top 20）</h2>
    <p class="hint">同一 error_msg 聚合，可看具体超时端点 / JS 堆栈 / 网络抖动等真因。配合上面的「错误趋势」一起看</p>
    <div style="overflow-x:auto"><table id="tbl-errors"><thead><tr>
      <th>类型</th><th>error_msg</th><th class="num">errors</th><th class="num">devices</th>
    </tr></thead><tbody><tr><td colspan="4" class="loading">loading…</td></tr></tbody></table></div>
  </div>

  <div class="card wide">
    <h2>🧑‍💻 重度设备</h2>
    <p class="hint">最近 30 天按 active_days × events 排序前 30，active_days ≥ 5 的高度可能是你自己或测试 / 老用户</p>
    <div style="overflow-x:auto"><table id="tbl-devices"><thead><tr>
      <th>device_id</th><th class="num">events</th><th class="num">active days</th><th class="num">event types</th>
      <th>first seen</th><th>last seen</th><th>UA</th>
    </tr></thead><tbody><tr><td colspan="7" class="loading">loading…</td></tr></tbody></table></div>
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

async function getJson(url) {
  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
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

async function loadDevices() {
  const tb = document.querySelector('#tbl-devices tbody');
  try {
    const d = await getJson('/api/admin/analytics?metric=top-devices');
    if (!d.devices.length) { tb.innerHTML = '<tr><td colspan="7" class="muted">无数据</td></tr>'; return; }
    tb.innerHTML = d.devices.map(r =>
      '<tr><td>' + r.device_id + '</td>'
      + '<td class="num">' + fmt(r.events) + '</td>'
      + '<td class="num">' + fmt(r.active_days) + '</td>'
      + '<td class="num">' + fmt(r.event_types) + '</td>'
      + '<td>' + r.first_seen + '</td>'
      + '<td>' + r.last_seen + '</td>'
      + '<td class="muted" style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + (r.ua_sample || '').replace(/"/g,'&quot;') + '">' + (r.ua_sample || '—') + '</td>'
      + '</tr>'
    ).join('');
  } catch (e) { tb.innerHTML = '<tr><td colspan="7" class="err">' + e.message + '</td></tr>'; }
}

// Resize charts on window resize so cards don't overflow on mobile/tablet.
window.addEventListener('resize', () => {
  ['ch-dau','ch-session','ch-events','ch-error-trend'].forEach(id => {
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
  loadRetention(),
  loadEvents(),
  loadErrorTrend(),
  loadErrors(),
  loadDevices(),
]);
</script>
</body>
</html>`;
