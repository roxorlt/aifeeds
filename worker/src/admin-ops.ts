// /admin/ops 运营看板：3 个池子（爆推 / 趋势推 / 发现博主）展示 + JSON endpoint
// 设计：docs/plans/2026-05-21-ops-pool-design.md § 7
// 鉴权同其他 /api/admin/* — CF Access JWT（admin.ts requireAuth）
//
// HTML 模板用 String concat（不用 regex literal）— 之前 PR #95 踩过 template literal
// 内 \d \/ 被 V8 当 invalid escape 吃掉的坑。

import type { Env } from './index';
import { ADMIN_SHARED_CSS, adminNavHtml, requireAuth, jsonRes } from './admin';

// ─── /api/admin/ops?metric=<name> ────────────────────────────────
export async function handleAdminOps(request: Request, env: Env): Promise<Response> {
  const guard = await requireAuth(request, env);
  if (guard) return guard;

  const url = new URL(request.url);
  const metric = url.searchParams.get('metric') || 'overview';

  switch (metric) {
    case 'overview':
      return jsonRes(await metricOverview(env));
    case 'baopui':
      return jsonRes(await metricBaopui(env));
    case 'trend':
      return jsonRes(await metricTrend(env));
    case 'discover':
      return jsonRes(await metricDiscover(env));
    default:
      return jsonRes({ error: `unknown metric: ${metric}`, available: [
        'overview', 'baopui', 'trend', 'discover',
      ] }, 400);
  }
}

async function metricOverview(env: Env) {
  // 基线值 + 池子总数（24h 内的爆推/趋势 + 14d 内的发现博主）
  const baseline = await env.DB.prepare(
    `SELECT source_type, metric_key, value, sample_size,
            datetime(computed_at, 'unixepoch', '+8 hours') AS computed_bjt
     FROM ops_pool_baseline ORDER BY source_type, metric_key`,
  ).all<{ source_type: string; metric_key: string; value: number; sample_size: number; computed_bjt: string }>();

  const counts = await env.DB.prepare(`
    SELECT
      SUM(CASE WHEN pool_type='baopui' AND added_at > strftime('%s','now')-24*3600 THEN 1 ELSE 0 END) AS baopui_24h,
      SUM(CASE WHEN pool_type='trend' AND added_at > strftime('%s','now')-24*3600 THEN 1 ELSE 0 END) AS trend_24h,
      SUM(CASE WHEN pool_type='discover' AND added_at > strftime('%s','now')-14*86400 THEN 1 ELSE 0 END) AS discover_14d,
      SUM(CASE WHEN pushed_at IS NOT NULL AND added_at > strftime('%s','now')-24*3600 THEN 1 ELSE 0 END) AS pushed_24h
    FROM ops_pool_items
  `).first<{ baopui_24h: number; trend_24h: number; discover_14d: number; pushed_24h: number }>();

  const hotCount = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM items WHERE is_hot = 1
     AND scraped_at > datetime('now', '-7 days')`,
  ).first<{ n: number }>();

  return {
    baseline: baseline.results,
    pool_counts: counts,
    hot_7d: hotCount?.n ?? 0,
  };
}

async function metricBaopui(env: Env) {
  // 24h 爆推：JOIN items 拉 content + handle + metrics
  const rs = await env.DB.prepare(`
    SELECT
      p.item_id, p.added_at, p.pushed_at, p.payload,
      i.handle, i.content, i.content_translated, i.url,
      datetime(p.added_at, 'unixepoch', '+8 hours') AS added_bjt
    FROM ops_pool_items p
    JOIN items i ON i.id = p.item_id
    WHERE p.pool_type = 'baopui'
      AND p.added_at > strftime('%s','now') - 24 * 3600
    ORDER BY p.added_at DESC
    LIMIT 50
  `).all();
  return { items: rs.results };
}

async function metricTrend(env: Env) {
  // 24h 趋势：拉 item + sparkline data（最近 12 个 snapshot 的 likes 序列）
  const rs = await env.DB.prepare(`
    SELECT
      p.item_id, p.added_at, p.pushed_at, p.payload,
      i.handle, i.content, i.content_translated, i.url,
      datetime(p.added_at, 'unixepoch', '+8 hours') AS added_bjt
    FROM ops_pool_items p
    JOIN items i ON i.id = p.item_id
    WHERE p.pool_type = 'trend'
      AND p.added_at > strftime('%s','now') - 24 * 3600
    ORDER BY p.added_at DESC
    LIMIT 30
  `).all<{
    item_id: string; added_at: number; pushed_at: number | null; payload: string;
    handle: string; content: string | null; content_translated: string | null; url: string | null;
    added_bjt: string;
  }>();

  // sparkline: per item 取最近 12 snapshot 的 likes
  const items = [];
  for (const r of rs.results || []) {
    const snaps = await env.DB.prepare(`
      SELECT captured_at, likes FROM metrics_snapshots
      WHERE item_id = ?
      ORDER BY captured_at DESC
      LIMIT 12
    `).bind(r.item_id).all<{ captured_at: number; likes: number }>();
    items.push({
      ...r,
      sparkline: (snaps.results || []).reverse().map((s) => ({ t: s.captured_at, l: s.likes })),
    });
  }

  return { items };
}

async function metricDiscover(env: Env) {
  // 14d 发现博主池（按 distinct_tweets 倒序）
  const rs = await env.DB.prepare(`
    SELECT item_id, added_at, pushed_at, payload,
           datetime(added_at, 'unixepoch', '+8 hours') AS added_bjt
    FROM ops_pool_items
    WHERE pool_type = 'discover'
      AND added_at > strftime('%s','now') - 14 * 86400
    ORDER BY json_extract(payload, '$.distinct_tweets') DESC
    LIMIT 60
  `).all();
  return { items: rs.results };
}

// ─── /admin/ops → 运营看板 HTML ──────────────────────────────────
export async function serveAdminOpsHtml(request: Request, env: Env): Promise<Response> {
  const guard = await requireAuth(request, env);
  if (guard) return guard;
  return new Response(OPS_HTML, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

const OPS_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ai-feeds admin · 运营看板</title>
<style>
${ADMIN_SHARED_CSS}
  .kpi-row { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); margin-bottom: 24px; }
  .kpi { background: #11161f; border: 1px solid #1f2937; border-radius: 8px; padding: 14px; }
  .kpi .label { font-size: 12px; color: #6b7280; text-transform: uppercase; letter-spacing: .05em; }
  .kpi .value { font-size: 26px; font-weight: 600; color: #e6e8eb; margin-top: 4px; font-family: ui-monospace, monospace; }
  .kpi .hint { font-size: 11px; color: #6b7280; margin-top: 4px; }

  .section { background: #11161f; border: 1px solid #1f2937; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  .section h2 { margin: 0 0 4px; font-size: 14px; font-weight: 600; color: #d1d5db; }
  .section p.hint { margin: 0 0 14px; font-size: 12px; color: #6b7280; }

  .baopui-grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }
  .card-item { background: #0b0e14; border: 1px solid #1f2937; border-radius: 6px; padding: 12px; }
  .card-item .head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; }
  .card-item .handle { color: #6ee7b7; font-weight: 600; font-size: 13px; }
  .card-item .score { color: #6b7280; font-size: 11px; font-family: ui-monospace, monospace; }
  .card-item .metrics { color: #9ca3af; font-size: 11px; margin-bottom: 8px; font-family: ui-monospace, monospace; }
  .card-item .snippet { color: #d1d5db; font-size: 12px; line-height: 1.5; }
  .card-item a { color: #93c5fd; text-decoration: none; font-size: 11px; }
  .card-item a:hover { text-decoration: underline; }

  .trend-row { display: grid; grid-template-columns: 1fr auto; gap: 12px; padding: 10px 0;
               border-bottom: 1px solid #1f2937; align-items: center; }
  .trend-row:last-child { border-bottom: none; }
  .trend-row .info .handle { color: #6ee7b7; font-weight: 600; font-size: 13px; }
  .trend-row .info .meta { color: #9ca3af; font-size: 11px; font-family: ui-monospace, monospace; }
  .trend-row .info .snippet { color: #d1d5db; font-size: 12px; margin-top: 4px; }
  .trend-row .spark { color: #fcd34d; }

  .discover-row { display: grid; grid-template-columns: 200px 120px 1fr auto; gap: 12px;
                  padding: 10px 0; border-bottom: 1px solid #1f2937; align-items: center; font-size: 12px; }
  .discover-row:last-child { border-bottom: none; }
  .discover-row .handle { color: #6ee7b7; font-weight: 600; font-family: ui-monospace, monospace; }
  .discover-row .counts { color: #9ca3af; font-family: ui-monospace, monospace; }
  .discover-row .dilution { color: #6b7280; font-size: 11px; font-family: ui-monospace, monospace; }
  .discover-row a { color: #93c5fd; text-decoration: none; }
  .discover-row a:hover { text-decoration: underline; }

  .loading { color: #6b7280; font-size: 12px; text-align: center; padding: 24px; }
  .empty { color: #6b7280; font-size: 12px; padding: 24px; text-align: center; }
  .err { color: #fca5a5; font-size: 12px; padding: 12px; background: #1f1212; border: 1px solid #7f1d1d; border-radius: 6px; }
</style>
</head>
<body>
${adminNavHtml('ops')}
<main>

<div class="kpi-row" id="kpis">
  <div class="kpi"><div class="label">🔥 hot (7d)</div><div class="value" id="kpi-hot">—</div><div class="hint">items.is_hot=1</div></div>
  <div class="kpi"><div class="label">爆推 (24h)</div><div class="value" id="kpi-baopui">—</div><div class="hint">score &gt; P99</div></div>
  <div class="kpi"><div class="label">趋势推 (24h)</div><div class="value" id="kpi-trend">—</div><div class="hint">增速 &gt; P95</div></div>
  <div class="kpi"><div class="label">发现博主 (14d)</div><div class="value" id="kpi-discover">—</div><div class="hint">distinct ≥ 5</div></div>
  <div class="kpi"><div class="label">已推送 (24h)</div><div class="value" id="kpi-pushed">—</div><div class="hint">PushDeer 触发</div></div>
</div>

<div class="section">
  <h2>🔥 爆推（24h 内 score &gt; P99 + likes ≥ 300）</h2>
  <p class="hint">基线 P99 / 阈值 / 当前互动数详见 hover；点击 handle 跳详情页</p>
  <div id="baopui-list" class="baopui-grid"><div class="loading">loading…</div></div>
</div>

<div class="section">
  <h2>📈 趋势推（24h 内增速 &gt; P95 + likes_total ≥ 50）</h2>
  <p class="hint">右侧 sparkline 显示最近 12 个 snapshot 的 likes 序列（粒度 30min）</p>
  <div id="trend-list"><div class="loading">loading…</div></div>
</div>

<div class="section">
  <h2>👤 发现博主（14d 内 distinct_tweets ≥ 5，按去重后引用数倒序）</h2>
  <p class="hint">dilution 接近 1 = 持续输出；&gt; 1.5 = 单条爆款被多次引用（事件信号）</p>
  <div id="discover-list"><div class="loading">loading…</div></div>
</div>

</main>

<script>
async function getJson(url) {
  const r = await fetch(url, { credentials: 'include' });
  if (r.redirected && !r.url.startsWith(location.origin)) {
    throw new Error('CF Access 会话过期，刷新整页重新登录');
  }
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    throw new Error('非 JSON: ' + (await r.text()).slice(0, 80));
  }
  return r.json();
}

function fmt(n) { return (n || 0).toLocaleString('en-US'); }
function esc(s) {
  return String(s == null ? '' : s)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

// 60×20 SVG sparkline。data = [{t,l}, ...] 按时间正序。
function sparkSvg(data, w, h) {
  w = w || 80; h = h || 22;
  if (!data || data.length < 2) return '<span class="meta">—</span>';
  const xs = data.map(function(d, i) { return i; });
  const ys = data.map(function(d) { return d.l; });
  const minY = Math.min.apply(null, ys);
  const maxY = Math.max.apply(null, ys);
  const range = Math.max(maxY - minY, 1);
  const stepX = w / Math.max(xs.length - 1, 1);
  const pts = data.map(function(d, i) {
    const x = (i * stepX).toFixed(1);
    const y = (h - ((d.l - minY) / range) * (h - 2) - 1).toFixed(1);
    return x + ',' + y;
  }).join(' ');
  return '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">'
    + '<polyline fill="none" stroke="#fcd34d" stroke-width="1.5" points="' + pts + '"/>'
    + '</svg>';
}

async function loadOverview() {
  try {
    const d = await getJson('/api/admin/ops?metric=overview');
    document.getElementById('kpi-hot').textContent = fmt(d.hot_7d);
    document.getElementById('kpi-baopui').textContent = fmt(d.pool_counts && d.pool_counts.baopui_24h);
    document.getElementById('kpi-trend').textContent = fmt(d.pool_counts && d.pool_counts.trend_24h);
    document.getElementById('kpi-discover').textContent = fmt(d.pool_counts && d.pool_counts.discover_14d);
    document.getElementById('kpi-pushed').textContent = fmt(d.pool_counts && d.pool_counts.pushed_24h);
  } catch (e) { console.error('overview', e); }
}

async function loadBaopui() {
  const root = document.getElementById('baopui-list');
  try {
    const d = await getJson('/api/admin/ops?metric=baopui');
    if (!d.items.length) { root.innerHTML = '<div class="empty">24 小时内无爆推（等基线更稳定 / 阈值需调）</div>'; return; }
    root.innerHTML = d.items.map(function(r) {
      const p = (function() { try { return JSON.parse(r.payload || '{}'); } catch (e) { return {}; } })();
      const snippet = esc((r.content_translated || r.content || '').slice(0, 120));
      const url = r.url || ('https://ai-feeds.com/x/' + String(r.item_id).replace('x_list:', ''));
      return '<div class="card-item">'
        + '<div class="head">'
        + '  <a class="handle" href="' + esc(url) + '" target="_blank">@' + esc(r.handle) + '</a>'
        + '  <span class="score">score ' + fmt(p.score) + ' / 阈值 ' + fmt(p.threshold) + '</span>'
        + '</div>'
        + '<div class="metrics">likes ' + fmt(p.likes) + ' / rt ' + fmt(p.retweets) + ' / rp ' + fmt(p.replies) + ' / bm ' + fmt(p.bookmarks) + '</div>'
        + '<div class="snippet">' + snippet + '</div>'
        + '</div>';
    }).join('');
  } catch (e) { root.innerHTML = '<div class="err">' + esc(e.message) + '</div>'; }
}

async function loadTrend() {
  const root = document.getElementById('trend-list');
  try {
    const d = await getJson('/api/admin/ops?metric=trend');
    if (!d.items.length) { root.innerHTML = '<div class="empty">24 小时内无趋势推</div>'; return; }
    root.innerHTML = d.items.map(function(r) {
      const p = (function() { try { return JSON.parse(r.payload || '{}'); } catch (e) { return {}; } })();
      const snippet = esc((r.content_translated || r.content || '').slice(0, 100));
      const url = r.url || ('https://ai-feeds.com/x/' + String(r.item_id).replace('x_list:', ''));
      const spark = sparkSvg(r.sparkline);
      return '<div class="trend-row">'
        + '<div class="info">'
        + '  <a class="handle" href="' + esc(url) + '" target="_blank">@' + esc(r.handle) + '</a>'
        + '  <span class="meta"> · 增速 ' + fmt(p.rate) + ' likes/h（阈值 ' + fmt(p.threshold) + '） · 当前 ' + fmt(p.likes) + '</span>'
        + '  <div class="snippet">' + snippet + '</div>'
        + '</div>'
        + '<div class="spark">' + spark + '</div>'
        + '</div>';
    }).join('');
  } catch (e) { root.innerHTML = '<div class="err">' + esc(e.message) + '</div>'; }
}

async function loadDiscover() {
  const root = document.getElementById('discover-list');
  try {
    const d = await getJson('/api/admin/ops?metric=discover');
    if (!d.items.length) { root.innerHTML = '<div class="empty">14 天内无发现博主（阈值需调，目前 distinct_tweets ≥ 5）</div>'; return; }
    root.innerHTML = d.items.map(function(r) {
      const p = (function() { try { return JSON.parse(r.payload || '{}'); } catch (e) { return {}; } })();
      return '<div class="discover-row">'
        + '<div class="handle">@' + esc(p.handle) + '</div>'
        + '<div class="counts">' + fmt(p.distinct_tweets) + ' 条 · 共 ' + fmt(p.total_mentions) + ' 次</div>'
        + '<div class="dilution">dilution ' + (p.dilution || '—') + ' · 首次进池 ' + esc(r.added_bjt) + '</div>'
        + '<a href="https://x.com/' + esc(p.handle) + '" target="_blank">→ X 主页</a>'
        + '</div>';
    }).join('');
  } catch (e) { root.innerHTML = '<div class="err">' + esc(e.message) + '</div>'; }
}

Promise.all([loadOverview(), loadBaopui(), loadTrend(), loadDiscover()]);
</script>
</body>
</html>`;
