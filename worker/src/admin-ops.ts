// /admin/ops 运营看板：3 个池子（爆推 / 趋势推 / 发现博主）展示 + JSON endpoint
// 设计：docs/plans/2026-05-21-ops-pool-design.md § 7
// 鉴权同其他 /api/admin/* — CF Access JWT（admin.ts requireAuth）
//
// HTML 模板用 String concat（不用 regex literal）— 之前 PR #95 踩过 template literal
// 内 \d \/ 被 V8 当 invalid escape 吃掉的坑。

import type { Env } from './index';
import { ADMIN_SHARED_CSS, adminNavHtml, requireAuth, jsonRes } from './admin';
import { OPS_CONFIG } from './ops/config';
import { addManualXCardRender, enqueueXCardRender } from './x-card-render';

// ─── POST /api/admin/x-card-manual + /api/admin/x-card-render-repush ──
// 运营面板「手动渲染」+「重推」按钮调用,CF Access 鉴权同 handleAdminOps。
export async function handleXCardManual(request: Request, env: Env): Promise<Response> {
  const guard = await requireAuth(request, env);
  if (guard) return guard;
  let body: { url?: string };
  try { body = (await request.json()) as { url?: string }; } catch { return jsonRes({ ok: false, error: 'bad_json' }, 400); }
  if (!body.url) return jsonRes({ ok: false, error: 'missing url' }, 400);
  const r = await addManualXCardRender(env, body.url);
  return jsonRes(r, r.ok ? 200 : 400);
}

export async function handleXCardRepush(request: Request, env: Env): Promise<Response> {
  const guard = await requireAuth(request, env);
  if (guard) return guard;
  let body: { item_id?: string };
  try { body = (await request.json()) as { item_id?: string }; } catch { return jsonRes({ ok: false, error: 'bad_json' }, 400); }
  if (!body.item_id) return jsonRes({ ok: false, error: 'missing item_id' }, 400);
  await enqueueXCardRender(env, body.item_id, 'manual'); // upsert → status=pending, attempts=0
  return jsonRes({ ok: true, item_id: body.item_id, status: 'pending' });
}

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
    case 'renders':
      return jsonRes(await metricRenders(env));
    default:
      return jsonRes({ error: `unknown metric: ${metric}`, available: [
        'overview', 'baopui', 'trend', 'discover', 'renders',
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
      SUM(CASE WHEN pool_type='baopui' AND added_at > strftime('%s','now') - ${OPS_CONFIG.POOL_DISPLAY_WINDOW_HOURS} * 3600 THEN 1 ELSE 0 END) AS baopui_24h,
      SUM(CASE WHEN pool_type='trend' AND added_at > strftime('%s','now') - ${OPS_CONFIG.POOL_DISPLAY_WINDOW_HOURS} * 3600 THEN 1 ELSE 0 END) AS trend_24h,
      SUM(CASE WHEN pool_type='discover' AND added_at > strftime('%s','now') - ${OPS_CONFIG.DISCOVER_DISPLAY_WINDOW_DAYS} * 86400 THEN 1 ELSE 0 END) AS discover_14d,
      SUM(CASE WHEN pushed_at IS NOT NULL AND added_at > strftime('%s','now') - ${OPS_CONFIG.POOL_DISPLAY_WINDOW_HOURS} * 3600 THEN 1 ELSE 0 END) AS pushed_24h
    FROM ops_pool_items
  `).first<{ baopui_24h: number; trend_24h: number; discover_14d: number; pushed_24h: number }>();

  const hotCount = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM items WHERE is_hot = 1
     AND scraped_at > datetime('now', '-${OPS_CONFIG.HOT_DISPLAY_WINDOW_DAYS} days')`,
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
      rc.status AS render_status, rc.image_url AS render_image, rc.error AS render_error,
      datetime(p.added_at, 'unixepoch', '+8 hours') AS added_bjt
    FROM ops_pool_items p
    JOIN items i ON i.id = p.item_id
    LEFT JOIN x_card_renders rc ON rc.item_id = p.item_id
    WHERE p.pool_type = 'baopui'
      AND p.added_at > strftime('%s','now') - ${OPS_CONFIG.POOL_DISPLAY_WINDOW_HOURS} * 3600
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
      rc.status AS render_status, rc.image_url AS render_image, rc.error AS render_error,
      datetime(p.added_at, 'unixepoch', '+8 hours') AS added_bjt
    FROM ops_pool_items p
    JOIN items i ON i.id = p.item_id
    LEFT JOIN x_card_renders rc ON rc.item_id = p.item_id
    WHERE p.pool_type = 'trend'
      AND p.added_at > strftime('%s','now') - ${OPS_CONFIG.POOL_DISPLAY_WINDOW_HOURS} * 3600
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
      AND added_at > strftime('%s','now') - ${OPS_CONFIG.DISCOVER_DISPLAY_WINDOW_DAYS} * 86400
    ORDER BY json_extract(payload, '$.distinct_tweets') DESC
    LIMIT 60
  `).all();
  return { items: rs.results };
}

async function metricRenders(env: Env) {
  // 最近渲染(手动 + 自动池),给「手动渲染 / 渲染队列」区显示。
  const rs = await env.DB.prepare(`
    SELECT
      rc.item_id, rc.status, rc.image_url, rc.error, rc.source, rc.attempts,
      datetime(rc.created_at, 'unixepoch', '+8 hours') AS created_bjt,
      CASE WHEN rc.rendered_at IS NOT NULL THEN datetime(rc.rendered_at, 'unixepoch', '+8 hours') ELSE NULL END AS rendered_bjt,
      i.handle, i.content, i.content_translated
    FROM x_card_renders rc
    LEFT JOIN items i ON i.id = rc.item_id
    ORDER BY rc.created_at DESC
    LIMIT 40
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

  /* X 卡片渲染状态 */
  .rbadge { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; padding: 2px 7px; border-radius: 10px;
            font-family: ui-monospace, monospace; margin-top: 8px; }
  .rbadge.ok { background: #052e1a; color: #6ee7b7; border: 1px solid #14532d; }
  .rbadge.pending { background: #1f1b08; color: #fcd34d; border: 1px solid #713f12; }
  .rbadge.failed { background: #1f1212; color: #fca5a5; border: 1px solid #7f1d1d; }
  .rbadge.none { background: #11161f; color: #6b7280; border: 1px solid #1f2937; }
  .rbadge a { color: inherit; text-decoration: underline; }
  .rbadge button { background: #7f1d1d; color: #fecaca; border: none; border-radius: 4px; padding: 1px 6px;
                   font-size: 10px; cursor: pointer; font-family: inherit; }
  .rbadge button:hover { background: #991b1b; }
  .manual-row { display: flex; gap: 8px; margin-bottom: 12px; }
  .manual-row input { flex: 1; background: #0b0e14; border: 1px solid #1f2937; border-radius: 6px;
                      color: #e6e8eb; padding: 8px 10px; font-size: 13px; }
  .manual-row button { background: #1d4ed8; color: #fff; border: none; border-radius: 6px; padding: 8px 16px;
                       font-size: 13px; cursor: pointer; }
  .manual-row button:hover { background: #2563eb; }
  .manual-row button:disabled { background: #374151; cursor: not-allowed; }
  .render-row { display: grid; grid-template-columns: auto 1fr auto; gap: 10px; padding: 8px 0;
                border-bottom: 1px solid #1f2937; align-items: center; font-size: 12px; }
  .render-row:last-child { border-bottom: none; }
  .render-row img { width: 36px; height: 48px; object-fit: cover; border-radius: 3px; background: #0b0e14; }
  .render-row .ph { width: 36px; height: 48px; border-radius: 3px; background: #0b0e14; border: 1px solid #1f2937; }
  .render-row .rmeta { color: #9ca3af; }
  .render-row .rmeta .h { color: #6ee7b7; font-weight: 600; }
</style>
</head>
<body>
${adminNavHtml('ops')}
<main>

<div class="kpi-row" id="kpis" data-testid="ops-kpis-row">
  <div class="kpi" data-testid="ops-kpi-hot"><div class="label">🔥 hot (7d)</div><div class="value" id="kpi-hot">—</div><div class="hint">items.is_hot=1</div></div>
  <div class="kpi" data-testid="ops-kpi-baopui"><div class="label">爆推 (24h)</div><div class="value" id="kpi-baopui">—</div><div class="hint">score &gt; P99</div></div>
  <div class="kpi" data-testid="ops-kpi-trend"><div class="label">趋势推 (24h)</div><div class="value" id="kpi-trend">—</div><div class="hint">增速 &gt; P95</div></div>
  <div class="kpi" data-testid="ops-kpi-discover"><div class="label">发现博主 (14d)</div><div class="value" id="kpi-discover">—</div><div class="hint">distinct ≥ 5</div></div>
  <div class="kpi" data-testid="ops-kpi-pushed"><div class="label">已推送 (24h)</div><div class="value" id="kpi-pushed">—</div><div class="hint">PushDeer 触发</div></div>
</div>

<div class="section" data-testid="ops-section-render">
  <h2>🖼️ X 卡片渲染</h2>
  <p class="hint">爆推/趋势入池自动渲染（下方各卡片显示状态）；这里可手动填 X 推文地址或 aifeeds /t/ 抽屉地址加渲</p>
  <div class="manual-row">
    <input id="manual-url" type="text" placeholder="https://x.com/.../status/123  或  https://ai-feeds.com/t/123" />
    <button id="manual-btn" onclick="submitManual()">渲染</button>
  </div>
  <div id="manual-msg" style="font-size:12px;margin-bottom:10px;color:#6b7280;"></div>
  <div id="render-list"><div class="loading">loading…</div></div>
</div>

<div class="section" data-testid="ops-section-baopui">
  <h2>🔥 爆推（24h 内 score &gt; P99 + likes ≥ 300）</h2>
  <p class="hint">基线 P99 / 阈值 / 当前互动数详见 hover；点击 handle 跳详情页</p>
  <div id="baopui-list" class="baopui-grid"><div class="loading">loading…</div></div>
</div>

<div class="section" data-testid="ops-section-trend">
  <h2>📈 趋势推（24h 内增速 &gt; P95 + likes_total ≥ 50）</h2>
  <p class="hint">右侧 sparkline 显示最近 12 个 snapshot 的 likes 序列（粒度 30min）</p>
  <div id="trend-list"><div class="loading">loading…</div></div>
</div>

<div class="section" data-testid="ops-section-discover">
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
      // weighted = score / (age_hours+2)^1.5 (HN 时间衰减)，raw_score = 累积值
      const scoreLabel = p.weighted != null
        ? 'w ' + fmt(p.weighted) + ' (≥' + fmt(p.threshold) + ') · raw ' + fmt(p.raw_score)
        : 'score ' + fmt(p.score) + ' / 阈值 ' + fmt(p.threshold);
      return '<div class="card-item">'
        + '<div class="head">'
        + '  <a class="handle" href="' + esc(url) + '" target="_blank">@' + esc(r.handle) + '</a>'
        + '  <span class="score">' + scoreLabel + '</span>'
        + '</div>'
        + '<div class="metrics">likes ' + fmt(p.likes) + ' / rt ' + fmt(p.retweets) + ' / rp ' + fmt(p.replies) + ' / bm ' + fmt(p.bookmarks) + '</div>'
        + '<div class="snippet">' + snippet + '</div>'
        + renderBadge(r)
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
        + '  ' + renderBadge(r)
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

// X 卡片渲染状态徽章(爆推/趋势卡片用)
function renderBadge(r) {
  var st = r.render_status;
  var iid = String(r.item_id || '');
  if (!st) return '<div class="rbadge none">未渲染</div>';
  if (st === 'ok') return '<div class="rbadge ok">✓ 已渲染 · <a href="' + esc(r.render_image) + '" target="_blank">看图</a></div>';
  if (st === 'failed') return '<div class="rbadge failed">✗ ' + esc(r.render_error || '失败') + ' <button onclick="repush(\\'' + esc(iid) + '\\')">重推</button></div>';
  return '<div class="rbadge pending">⏳ 渲染中…</div>';
}

async function repush(itemId) {
  try {
    await fetch('/api/admin/x-card-render-repush', { method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ item_id: itemId }) });
    await Promise.all([loadBaopui(), loadTrend(), loadRenders()]);
  } catch (e) { alert('重推失败: ' + e.message); }
}

async function submitManual() {
  var inp = document.getElementById('manual-url');
  var btn = document.getElementById('manual-btn');
  var msg = document.getElementById('manual-msg');
  var u = inp.value.trim();
  if (!u) return;
  btn.disabled = true; msg.textContent = '提交中…'; msg.style.color = '#6b7280';
  try {
    var r = await fetch('/api/admin/x-card-manual', { method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: u }) });
    var d = await r.json();
    if (d.ok) { msg.textContent = '已入队' + (d.ingested ? '（新抓取入库，渲染需等翻译完成）' : ''); msg.style.color = '#6ee7b7'; inp.value = ''; await loadRenders(); }
    else { msg.textContent = '失败: ' + (d.error || 'unknown'); msg.style.color = '#fca5a5'; }
  } catch (e) { msg.textContent = '失败: ' + e.message; msg.style.color = '#fca5a5'; }
  btn.disabled = false;
}

async function loadRenders() {
  var root = document.getElementById('render-list');
  try {
    var d = await getJson('/api/admin/ops?metric=renders');
    if (!d.items.length) { root.innerHTML = '<div class="empty">暂无渲染记录</div>'; return; }
    root.innerHTML = d.items.map(function(r) {
      var snippet = esc((r.content_translated || r.content || '').slice(0, 60));
      var thumb = (r.status === 'ok' && r.image_url)
        ? '<a href="' + esc(r.image_url) + '" target="_blank"><img src="' + esc(r.image_url) + '"/></a>'
        : '<div class="ph"></div>';
      var stTxt = r.status === 'ok' ? '<span style="color:#6ee7b7">✓ ' + esc(r.rendered_bjt || '') + '</span>'
        : r.status === 'failed' ? '<span style="color:#fca5a5">✗ ' + esc(r.error || '失败') + '</span> <button class="rbadge failed" onclick="repush(\\'' + esc(String(r.item_id)) + '\\')">重推</button>'
        : '<span style="color:#fcd34d">⏳ ' + esc(r.status) + '</span>';
      return '<div class="render-row">' + thumb
        + '<div class="rmeta"><span class="h">@' + esc(r.handle || '?') + '</span> · ' + esc(r.source) + ' · ' + esc(r.created_bjt) + '<div>' + snippet + '</div></div>'
        + '<div>' + stTxt + '</div></div>';
    }).join('');
  } catch (e) { root.innerHTML = '<div class="err">' + esc(e.message) + '</div>'; }
}

Promise.all([loadOverview(), loadBaopui(), loadTrend(), loadDiscover(), loadRenders()]);
</script>
</body>
</html>`;
