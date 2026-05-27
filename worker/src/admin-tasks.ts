// /admin/tasks 抓取任务看板:
//   - 横向时间轴鱼骨图(0-24h)按信源 swim lane 展示各 cron 任务调度
//   - 点击节点显示该任务执行明细; "查看全部"切换全局明细 + 多维筛选
//   - 数据源: 鱼骨图来自 CRON_SCHEDULE 静态配置; 明细来自 cron_runs 表
// 设计: docs/plans/2026-05-27-cron-tasks-dashboard-design.md

import type { Env } from './index';
import { ADMIN_SHARED_CSS, adminNavHtml, requireAuth, jsonRes } from './admin';
import { CRON_SCHEDULE, getTaskDef } from './ops/cron-schedule';

// ─── /api/admin/tasks?metric=<name>&... ───────────────────────────
export async function handleAdminTasks(request: Request, env: Env): Promise<Response> {
  const guard = await requireAuth(request, env);
  if (guard) return guard;

  const url = new URL(request.url);
  const metric = url.searchParams.get('metric') || 'schedule';

  try {
    switch (metric) {
      case 'schedule':
        return jsonRes(await getSchedule(env));
      case 'runs':
        return jsonRes(await getRuns(env, url));
      case 'runs-all':
        return jsonRes(await getRunsAll(env, url));
      case 'run-detail':
        return jsonRes(await getRunDetail(env, url));
      default:
        return jsonRes({ error: `unknown metric: ${metric}`, available: ['schedule', 'runs', 'runs-all', 'run-detail'] }, 400);
    }
  } catch (e) {
    console.error('[admin-tasks] error:', e);
    return jsonRes({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}

// 鱼骨图配置 + 每个任务最近 24h 统计
async function getSchedule(env: Env) {
  const stats = await env.DB.prepare(`
    SELECT
      task_name,
      COUNT(*) AS runs_24h,
      SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) AS ok_24h,
      SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS error_24h,
      AVG(duration_ms) AS avg_ms,
      MAX(started_at) AS last_started_at,
      (SELECT status FROM cron_runs c2
        WHERE c2.task_name = cron_runs.task_name
        ORDER BY started_at DESC LIMIT 1) AS last_status
    FROM cron_runs
    WHERE started_at > (strftime('%s','now') - 86400) * 1000
    GROUP BY task_name
  `).all<{
    task_name: string;
    runs_24h: number;
    ok_24h: number;
    error_24h: number;
    avg_ms: number | null;
    last_started_at: number;
    last_status: string;
  }>();

  const statMap = new Map(stats.results.map((r) => [r.task_name, r]));

  return {
    tasks: CRON_SCHEDULE.map((def) => {
      const s = statMap.get(def.name);
      return {
        ...def,
        runs_24h: s?.runs_24h ?? 0,
        ok_24h: s?.ok_24h ?? 0,
        error_24h: s?.error_24h ?? 0,
        avg_ms: s?.avg_ms != null ? Math.round(s.avg_ms) : null,
        last_started_at: s?.last_started_at ?? null,
        last_status: s?.last_status ?? null,
      };
    }),
  };
}

// 某任务的执行明细
async function getRuns(env: Env, url: URL) {
  const task = url.searchParams.get('task');
  if (!task) return { error: 'missing task param' };
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 200);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10) || 0;

  const def = getTaskDef(task);
  const rs = await env.DB.prepare(`
    SELECT id, task_name, source, category, started_at, finished_at, status,
           duration_ms, subrequests, items_count, error
    FROM cron_runs
    WHERE task_name = ?
    ORDER BY started_at DESC
    LIMIT ? OFFSET ?
  `).bind(task, limit, offset).all();

  const total = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM cron_runs WHERE task_name = ?`,
  ).bind(task).first<{ n: number }>();

  return {
    task: { name: task, label: def?.label ?? task, description: def?.description ?? '' },
    items: rs.results,
    total: total?.n ?? 0,
    limit,
    offset,
  };
}

// 全部明细(带筛选)
async function getRunsAll(env: Env, url: URL) {
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 500);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10) || 0;
  const status = url.searchParams.get('status') || '';
  const source = url.searchParams.get('source') || '';
  const category = url.searchParams.get('category') || '';

  const where: string[] = [];
  const binds: unknown[] = [];
  if (status) { where.push('status = ?'); binds.push(status); }
  if (source) { where.push('source = ?'); binds.push(source); }
  if (category) { where.push('category = ?'); binds.push(category); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rs = await env.DB.prepare(`
    SELECT id, task_name, source, category, started_at, finished_at, status,
           duration_ms, subrequests, items_count, error
    FROM cron_runs
    ${whereSql}
    ORDER BY started_at DESC
    LIMIT ? OFFSET ?
  `).bind(...binds, limit, offset).all();

  const totalRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM cron_runs ${whereSql}`,
  ).bind(...binds).first<{ n: number }>();

  return {
    items: rs.results,
    total: totalRow?.n ?? 0,
    limit,
    offset,
    filter: { status, source, category },
  };
}

// 单条详情(含 result_json)
async function getRunDetail(env: Env, url: URL) {
  const id = parseInt(url.searchParams.get('id') || '0', 10);
  if (!id) return { error: 'missing id param' };
  const row = await env.DB.prepare(
    `SELECT * FROM cron_runs WHERE id = ?`,
  ).bind(id).first();
  if (!row) return { error: `not found: id=${id}` };
  return { run: row };
}

// ─── /admin/tasks → HTML 页面 ──────────────────────────────────
export async function serveAdminTasksHtml(request: Request, env: Env): Promise<Response> {
  const guard = await requireAuth(request, env);
  if (guard) return guard;
  return new Response(TASKS_HTML, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

const TASKS_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ai-feeds admin · 抓取任务看板</title>
<style>
${ADMIN_SHARED_CSS}
  .page-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
  .page-head h1 { margin: 0; }
  .btn { background: #1f2937; border: 1px solid #374151; color: #e6e8eb; font-size: 13px;
         padding: 6px 14px; border-radius: 6px; cursor: pointer; font-family: inherit; }
  .btn:hover { background: #374151; }
  .btn.active { background: #1d4ed8; border-color: #2563eb; }

  .section { background: #11161f; border: 1px solid #1f2937; border-radius: 8px;
             padding: 16px; margin-bottom: 16px; }
  .section h2 { margin: 0 0 8px; font-size: 14px; font-weight: 600; color: #d1d5db;
                display: flex; align-items: center; justify-content: space-between; }
  .section h2 .hint { font-size: 11px; color: #6b7280; font-weight: 400; }

  /* 鱼骨图 */
  #fishbone-wrap { overflow-x: auto; }
  #fishbone { display: block; min-width: 960px; }
  .lane-label { fill: #9ca3af; font-size: 11px; font-family: ui-monospace, monospace; }
  .axis-tick { fill: #6b7280; font-size: 10px; font-family: ui-monospace, monospace; }
  .lane-line { stroke: #1f2937; stroke-width: 1; }
  .axis-line { stroke: #374151; stroke-width: 1; }
  .axis-grid { stroke: #1a1f2e; stroke-width: 1; stroke-dasharray: 2,3; }
  .node { cursor: pointer; transition: r .12s, opacity .12s; }
  .node:hover { opacity: .8; }
  .node.selected { stroke: #fff; stroke-width: 2; }

  /* 明细表 */
  .detail-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 10px; flex-wrap: wrap; }
  .detail-head .title { font-size: 13px; color: #e6e8eb; font-weight: 600; }
  .detail-head .desc { font-size: 11px; color: #6b7280; }
  .filters { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
  .filters select { background: #0b0e14; border: 1px solid #374151; color: #e6e8eb;
                    font-size: 12px; padding: 4px 8px; border-radius: 4px; font-family: inherit; }
  .filters .label { color: #6b7280; font-size: 11px; align-self: center; margin-right: 4px; }

  table.runs { width: 100%; border-collapse: collapse; font-size: 12px; font-family: ui-monospace, monospace; }
  table.runs th { text-align: left; color: #6b7280; font-weight: 500; padding: 6px 8px;
                  border-bottom: 1px solid #1f2937; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  table.runs th.num { text-align: right; }
  table.runs td { padding: 6px 8px; border-bottom: 1px solid #1f2937; color: #d1d5db; }
  table.runs td.num { text-align: right; }
  table.runs tr.row { cursor: pointer; }
  table.runs tr.row:hover td { background: #1a1f2e; }
  table.runs tr.detail td { padding: 0; }
  table.runs tr.detail .panel { background: #0b0e14; padding: 12px; border-top: 1px solid #1f2937;
                                font-family: ui-monospace, monospace; font-size: 11px;
                                white-space: pre-wrap; max-height: 400px; overflow: auto; }

  .status-ok { color: #6ee7b7; }
  .status-error { color: #fca5a5; }
  .status-running { color: #fcd34d; }
  .status-skipped { color: #6b7280; }

  .loading { color: #6b7280; font-size: 12px; text-align: center; padding: 24px; }
  .empty { color: #6b7280; font-size: 12px; padding: 24px; text-align: center; }
  .err { color: #fca5a5; font-size: 12px; padding: 12px; background: #1f1212;
         border: 1px solid #7f1d1d; border-radius: 6px; }

  .pager { display: flex; gap: 8px; align-items: center; margin-top: 12px;
           font-size: 12px; color: #6b7280; }
  .pager button { background: #1f2937; border: 1px solid #374151; color: #e6e8eb;
                  font-size: 12px; padding: 4px 10px; border-radius: 4px; cursor: pointer; }
  .pager button:disabled { opacity: .4; cursor: not-allowed; }
</style>
</head>
<body>
${adminNavHtml('tasks')}
<main>

<div class="page-head">
  <h1>⏰ <b>抓取任务看板</b> <span style="font-size: 12px; color: #6b7280; margin-left: 8px;">24 小时总览 (BJT)</span></h1>
  <button id="view-toggle" class="btn">查看全部明细 →</button>
</div>

<div class="section" data-testid="tasks-fishbone">
  <h2>🐟 调度时间轴 <span class="hint">点击节点查看明细 · 颜色按 category(fetch蓝 / enrich紫 / backfill橙 / refresh绿 / cleanup灰 / system黄)</span></h2>
  <div id="fishbone-wrap"><div class="loading">loading…</div></div>
</div>

<div class="section" data-testid="tasks-detail">
  <div class="detail-head" id="detail-head">
    <span class="title" id="detail-title">📋 执行明细</span>
    <span class="desc" id="detail-desc">从上方鱼骨图选一个任务,或点右上"查看全部明细"</span>
  </div>
  <div class="filters" id="filters" style="display:none;">
    <span class="label">状态</span>
    <select id="filter-status"><option value="">全部</option><option value="ok">ok</option><option value="error">error</option><option value="running">running</option><option value="skipped">skipped</option></select>
    <span class="label">信源</span>
    <select id="filter-source"><option value="">全部</option><option value="x">x</option><option value="github">github</option><option value="ph">ph</option><option value="hf">hf</option><option value="clawhub">clawhub</option><option value="hdx">hdx</option><option value="common">common</option></select>
    <span class="label">类型</span>
    <select id="filter-category"><option value="">全部</option><option value="fetch">fetch</option><option value="enrich">enrich</option><option value="backfill">backfill</option><option value="refresh">refresh</option><option value="cleanup">cleanup</option><option value="system">system</option></select>
  </div>
  <div id="runs-root"><div class="empty">未选中任务</div></div>
  <div class="pager" id="pager" style="display:none;">
    <button id="prev" disabled>← 上一页</button>
    <span id="pager-info">—</span>
    <button id="next" disabled>下一页 →</button>
  </div>
</div>

</main>

<script>
const CAT_COLORS = {
  fetch: '#3b82f6', enrich: '#a78bfa', backfill: '#fb923c',
  refresh: '#34d399', cleanup: '#9ca3af', system: '#facc15',
};
const SOURCE_LABEL = {
  x: 'X', github: 'GH', ph: 'PH', hf: 'HF',
  clawhub: 'CH', hdx: 'HDX', common: '通用',
};
const SOURCE_ORDER = ['x', 'github', 'ph', 'hf', 'clawhub', 'hdx', 'common'];

let viewMode = 'task';      // 'task' | 'all'
let currentTask = null;
let pageOffset = 0;
const pageLimit = 50;

async function getJson(url) {
  const r = await fetch(url, { credentials: 'include' });
  if (r.redirected && !r.url.startsWith(location.origin)) {
    throw new Error('CF Access 会话过期,刷新整页重新登录');
  }
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

function esc(s) {
  return String(s == null ? '' : s)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function fmt(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString('en-US');
}

function fmtMs(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  return (ms / 60000).toFixed(1) + 'm';
}

function fmtBjt(unixMs) {
  if (!unixMs) return '—';
  const d = new Date(unixMs);
  const pad = function(n) { return String(n).padStart(2, '0'); };
  return pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ' '
    + pad((d.getUTCHours() + 8) % 24) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds());
}

// 把 ['08:00'] / ['01:00','13:00'] / ['*:00','*:30'] / ['*:05'] / ['*:35-05','*:35-17']
// 解析成 BJT 小时数组(0-24, 可含小数, 如 '08:30'→8.5)
function parseBjtTimes(times) {
  const slots = [];
  times.forEach(function(t) {
    if (t.startsWith('*:')) {
      // 每小时同一分钟
      const rest = t.slice(2);
      // 形如 '35-05' = 凌晨 04:35 接力链(到 05:05 截止),特殊处理
      if (rest.includes('-')) {
        // 用户视觉上把 04:35-05:05 这种当一个块,展开为多个 tick
        // 简单处理: 起始 tick 一个点表示
        const parts = rest.split('-');
        const minute = parseInt(parts[0], 10) || 0;
        const hour = parseInt(parts[1], 10) || 0;
        slots.push(hour + minute / 60);
      } else {
        const minute = parseInt(rest, 10) || 0;
        for (var h = 0; h < 24; h++) slots.push(h + minute / 60);
      }
    } else {
      // 'HH:MM'
      const parts = t.split(':');
      const hour = parseInt(parts[0], 10) || 0;
      const minute = parseInt(parts[1], 10) || 0;
      slots.push(hour + minute / 60);
    }
  });
  return slots;
}

function isHourly(freq) {
  return freq === 'hourly-2x' || freq === 'hourly-1x' || freq === 'multi-tick';
}

function renderFishbone(tasks) {
  const W = 1100;
  const PAD_LEFT = 60;
  const PAD_RIGHT = 30;
  const PAD_TOP = 30;
  const PAD_BOTTOM = 20;
  const LANE_H = 56;
  const H = PAD_TOP + LANE_H * SOURCE_ORDER.length + PAD_BOTTOM;
  const innerW = W - PAD_LEFT - PAD_RIGHT;
  function hourToX(h) { return PAD_LEFT + (h / 24) * innerW; }

  // 按 source 分组
  const grouped = {};
  SOURCE_ORDER.forEach(function(s) { grouped[s] = []; });
  tasks.forEach(function(t) { (grouped[t.source] || (grouped[t.source] = [])).push(t); });

  let svg = '<svg id="fishbone" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">';

  // 顶轴 + 网格 (每 2h 1 grid + 4h 一个 tick label)
  svg += '<line class="axis-line" x1="' + PAD_LEFT + '" y1="' + PAD_TOP + '" x2="' + (W - PAD_RIGHT) + '" y2="' + PAD_TOP + '"/>';
  for (var h = 0; h <= 24; h += 2) {
    var x = hourToX(h);
    svg += '<line class="axis-grid" x1="' + x.toFixed(1) + '" y1="' + PAD_TOP + '" x2="' + x.toFixed(1) + '" y2="' + (H - PAD_BOTTOM) + '"/>';
    if (h % 4 === 0) {
      svg += '<text class="axis-tick" x="' + x.toFixed(1) + '" y="' + (PAD_TOP - 8) + '" text-anchor="middle">' + String(h).padStart(2,'0') + '</text>';
    }
  }

  SOURCE_ORDER.forEach(function(src, i) {
    var laneY = PAD_TOP + (i + 0.5) * LANE_H;
    // lane label
    svg += '<text class="lane-label" x="' + (PAD_LEFT - 8) + '" y="' + (laneY + 4) + '" text-anchor="end">' + SOURCE_LABEL[src] + '</text>';
    // lane base line
    svg += '<line class="lane-line" x1="' + PAD_LEFT + '" y1="' + laneY + '" x2="' + (W - PAD_RIGHT) + '" y2="' + laneY + '"/>';

    (grouped[src] || []).forEach(function(t) {
      var color = CAT_COLORS[t.category] || '#888';
      var slots = parseBjtTimes(t.bjt_times);
      var hourly = isHourly(t.frequency);
      slots.forEach(function(h) {
        var cx = hourToX(h);
        var hasError = t.error_24h > 0;
        var hasRun = t.runs_24h > 0;
        var nodeAttrs = 'class="node" data-task="' + esc(t.name) + '" data-x="' + cx.toFixed(1) + '" data-y="' + laneY + '"';
        if (hourly) {
          // 三角形(高频)
          var s = 4;
          var pts = (cx - s) + ',' + (laneY + s) + ' '
                  + (cx + s) + ',' + (laneY + s) + ' '
                  + cx + ',' + (laneY - s);
          svg += '<polygon ' + nodeAttrs + ' points="' + pts + '" fill="' + color + '" '
              + (hasError ? 'stroke="#dc2626" stroke-width="1.5"' : (hasRun ? '' : 'opacity="0.4"')) + '>'
              + '<title>' + esc(t.label) + ' @ ' + t.bjt_times.join(', ') + '\n'
              + esc(t.description) + '\n'
              + '24h: ' + (t.runs_24h || 0) + ' runs / ' + (t.error_24h || 0) + ' err / avg ' + fmtMs(t.avg_ms) + '</title>'
              + '</polygon>';
        } else {
          // 圆点(每日)
          svg += '<circle ' + nodeAttrs + ' cx="' + cx.toFixed(1) + '" cy="' + laneY + '" r="5" fill="' + color + '" '
              + (hasError ? 'stroke="#dc2626" stroke-width="1.5"' : (hasRun ? '' : 'opacity="0.4"')) + '>'
              + '<title>' + esc(t.label) + ' @ ' + t.bjt_times.join(', ') + '\n'
              + esc(t.description) + '\n'
              + '24h: ' + (t.runs_24h || 0) + ' runs / ' + (t.error_24h || 0) + ' err / avg ' + fmtMs(t.avg_ms) + '</title>'
              + '</circle>';
        }
      });
    });
  });

  svg += '</svg>';
  return svg;
}

async function loadSchedule() {
  const wrap = document.getElementById('fishbone-wrap');
  try {
    const d = await getJson('/api/admin/tasks?metric=schedule');
    wrap.innerHTML = renderFishbone(d.tasks);
    wrap.querySelectorAll('.node').forEach(function(el) {
      el.addEventListener('click', function() {
        var task = el.getAttribute('data-task');
        selectTask(task);
        wrap.querySelectorAll('.node.selected').forEach(function(n) { n.classList.remove('selected'); });
        el.classList.add('selected');
      });
    });
  } catch (e) {
    wrap.innerHTML = '<div class="err">' + esc(e.message) + '</div>';
  }
}

function statusCell(s) {
  return '<span class="status-' + esc(s || 'unknown') + '">' + esc(s || '—') + '</span>';
}

function renderRunsTable(items) {
  if (!items.length) return '<div class="empty">无数据</div>';
  var rows = items.map(function(r) {
    return '<tr class="row" data-id="' + r.id + '">'
      + '<td>' + fmtBjt(r.started_at) + '</td>'
      + (viewMode === 'all' ? '<td>' + esc(r.task_name) + '</td>' : '')
      + '<td>' + statusCell(r.status) + '</td>'
      + '<td class="num">' + fmtMs(r.duration_ms) + '</td>'
      + '<td class="num">' + fmt(r.items_count) + '</td>'
      + '<td class="num">' + fmt(r.subrequests) + '</td>'
      + '<td>' + (r.error ? '<span class="status-error">' + esc(r.error.slice(0, 80)) + '</span>' : '—') + '</td>'
      + '</tr>'
      + '<tr class="detail" id="d-' + r.id + '" style="display:none;"><td colspan="' + (viewMode === 'all' ? 7 : 6) + '"><div class="panel" id="p-' + r.id + '">loading…</div></td></tr>';
  }).join('');
  return '<table class="runs"><thead><tr>'
    + '<th>时间</th>'
    + (viewMode === 'all' ? '<th>任务</th>' : '')
    + '<th>状态</th><th class="num">耗时</th><th class="num">items</th><th class="num">subreq</th><th>error</th>'
    + '</tr></thead><tbody>' + rows + '</tbody></table>';
}

function bindRows(items) {
  items.forEach(function(r) {
    var row = document.querySelector('tr.row[data-id="' + r.id + '"]');
    if (!row) return;
    row.addEventListener('click', async function() {
      var det = document.getElementById('d-' + r.id);
      var panel = document.getElementById('p-' + r.id);
      if (det.style.display === 'none') {
        det.style.display = '';
        try {
          var d = await getJson('/api/admin/tasks?metric=run-detail&id=' + r.id);
          var full = d.run || {};
          var parsed = null;
          try { parsed = JSON.parse(full.result_json || 'null'); } catch (e) {}
          panel.textContent = (full.error ? '✗ error: ' + full.error + '\\n\\n' : '')
            + 'result_json:\\n' + (parsed ? JSON.stringify(parsed, null, 2) : '(empty)');
        } catch (e) {
          panel.textContent = 'load failed: ' + e.message;
        }
      } else {
        det.style.display = 'none';
      }
    });
  });
}

async function selectTask(taskName) {
  viewMode = 'task';
  currentTask = taskName;
  pageOffset = 0;
  document.getElementById('filters').style.display = 'none';
  document.getElementById('view-toggle').classList.remove('active');
  document.getElementById('view-toggle').textContent = '查看全部明细 →';
  await loadDetail();
}

async function loadDetail() {
  const root = document.getElementById('runs-root');
  root.innerHTML = '<div class="loading">loading…</div>';
  try {
    var d;
    if (viewMode === 'task' && currentTask) {
      d = await getJson('/api/admin/tasks?metric=runs&task=' + encodeURIComponent(currentTask) + '&limit=' + pageLimit + '&offset=' + pageOffset);
      document.getElementById('detail-title').textContent = '📋 ' + (d.task.label || currentTask);
      document.getElementById('detail-desc').textContent = (d.task.description || '') + ' · 共 ' + d.total + ' 次执行';
    } else if (viewMode === 'all') {
      var qs = 'limit=' + pageLimit + '&offset=' + pageOffset;
      var fs = document.getElementById('filter-status').value;
      var fsrc = document.getElementById('filter-source').value;
      var fcat = document.getElementById('filter-category').value;
      if (fs) qs += '&status=' + encodeURIComponent(fs);
      if (fsrc) qs += '&source=' + encodeURIComponent(fsrc);
      if (fcat) qs += '&category=' + encodeURIComponent(fcat);
      d = await getJson('/api/admin/tasks?metric=runs-all&' + qs);
      document.getElementById('detail-title').textContent = '📋 全部明细';
      document.getElementById('detail-desc').textContent = '共 ' + d.total + ' 条';
    } else {
      root.innerHTML = '<div class="empty">未选中任务</div>';
      return;
    }
    root.innerHTML = renderRunsTable(d.items);
    bindRows(d.items);
    var pager = document.getElementById('pager');
    pager.style.display = '';
    document.getElementById('pager-info').textContent = (pageOffset + 1) + '-' + Math.min(pageOffset + pageLimit, d.total) + ' / ' + d.total;
    document.getElementById('prev').disabled = pageOffset === 0;
    document.getElementById('next').disabled = pageOffset + pageLimit >= d.total;
  } catch (e) {
    root.innerHTML = '<div class="err">' + esc(e.message) + '</div>';
  }
}

document.getElementById('view-toggle').addEventListener('click', function() {
  if (viewMode === 'all') {
    viewMode = 'task';
    currentTask = null;
    document.getElementById('filters').style.display = 'none';
    document.getElementById('view-toggle').classList.remove('active');
    document.getElementById('view-toggle').textContent = '查看全部明细 →';
    document.getElementById('runs-root').innerHTML = '<div class="empty">未选中任务</div>';
    document.getElementById('pager').style.display = 'none';
    document.getElementById('detail-title').textContent = '📋 执行明细';
    document.getElementById('detail-desc').textContent = '从上方鱼骨图选一个任务,或点右上"查看全部明细"';
    document.querySelectorAll('.node.selected').forEach(function(n) { n.classList.remove('selected'); });
  } else {
    viewMode = 'all';
    pageOffset = 0;
    document.getElementById('filters').style.display = '';
    document.getElementById('view-toggle').classList.add('active');
    document.getElementById('view-toggle').textContent = '回到鱼骨视图 ←';
    loadDetail();
  }
});

['filter-status', 'filter-source', 'filter-category'].forEach(function(id) {
  document.getElementById(id).addEventListener('change', function() {
    if (viewMode === 'all') { pageOffset = 0; loadDetail(); }
  });
});

document.getElementById('prev').addEventListener('click', function() {
  if (pageOffset >= pageLimit) { pageOffset -= pageLimit; loadDetail(); }
});
document.getElementById('next').addEventListener('click', function() {
  pageOffset += pageLimit; loadDetail();
});

loadSchedule();
</script>
</body>
</html>`;
