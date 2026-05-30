// /admin/subscriptions 订阅看板(B 方案,独立页):
//   - 顶部聚合卡片:总订阅 + 状态分布 + 各时段 active + 默认/精选 + 各源勾选 + 7d 投递 + 14d 新增
//   - 下方可筛选明细表:按时段/状态筛选 + 分页
// 数据源:subscriptions + digest_send_log。设计:FE docs/plans/2026-05-29-admin-subscriptions-view-spec.md

import type { Env } from './index';
import { ADMIN_SHARED_CSS, adminNavHtml, requireAuth, jsonRes } from './admin';

// ─── /api/admin/subscriptions?metric=<name>&... ───────────────────
export async function handleAdminSubscriptions(request: Request, env: Env): Promise<Response> {
  const guard = await requireAuth(request, env);
  if (guard) return guard;

  const url = new URL(request.url);
  const metric = url.searchParams.get('metric') || 'overview';

  try {
    switch (metric) {
      case 'overview':
        return jsonRes(await getOverview(env));
      case 'by-slot':
        return jsonRes(await getBySlot(env));
      case 'by-density':
        return jsonRes(await getByDensity(env));
      case 'by-source':
        return jsonRes(await getBySource(env));
      case 'delivery-7d':
        return jsonRes(await getDelivery7d(env));
      case 'growth-14d':
        return jsonRes(await getGrowth14d(env));
      case 'list':
        return jsonRes(await getList(env, url));
      default:
        return jsonRes(
          {
            error: `unknown metric: ${metric}`,
            available: ['overview', 'by-slot', 'by-density', 'by-source', 'delivery-7d', 'growth-14d', 'list'],
          },
          400,
        );
    }
  } catch (e) {
    console.error('[admin-subscriptions] error:', e);
    return jsonRes({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}

// ── 聚合 ──

interface OverviewRow {
  status: string;
  n: number;
  registered: number;
}
async function getOverview(env: Env) {
  const rows = await env.DB.prepare(
    `SELECT status, COUNT(*) AS n, SUM(CASE WHEN user_id IS NOT NULL THEN 1 ELSE 0 END) AS registered
     FROM subscriptions GROUP BY status`,
  ).all<OverviewRow>();
  const list = rows.results || [];
  const total = list.reduce((s, r) => s + r.n, 0);
  const totalRegistered = list.reduce((s, r) => s + (r.registered || 0), 0);
  return { total, total_registered: totalRegistered, by_status: list };
}

async function getBySlot(env: Env) {
  const rows = await env.DB.prepare(
    `SELECT send_slot, COUNT(*) AS n FROM subscriptions
     WHERE status='active' GROUP BY send_slot ORDER BY send_slot`,
  ).all<{ send_slot: number; n: number }>();
  return { rows: rows.results || [] };
}

async function getByDensity(env: Env) {
  const rows = await env.DB.prepare(
    `SELECT density, COUNT(*) AS n FROM subscriptions WHERE status='active' GROUP BY density`,
  ).all<{ density: string; n: number }>();
  return { rows: rows.results || [] };
}

async function getBySource(env: Env) {
  const rows = await env.DB.prepare(
    `SELECT j.value AS src, COUNT(*) AS n
     FROM subscriptions s, json_each(s.sources) j
     WHERE s.status='active' GROUP BY j.value ORDER BY n DESC`,
  ).all<{ src: string; n: number }>();
  return { rows: rows.results || [] };
}

async function getDelivery7d(env: Env) {
  const since = Date.now() - 7 * 86400_000;
  const rows = await env.DB.prepare(
    `SELECT status, COUNT(*) AS n FROM digest_send_log WHERE sent_at > ? GROUP BY status`,
  )
    .bind(since)
    .all<{ status: string; n: number }>();
  const list = rows.results || [];
  const sent = list.find((r) => r.status === 'sent')?.n || 0;
  const failed = list.find((r) => r.status === 'failed_resend')?.n || 0;
  const noItems = list.find((r) => r.status === 'no_items')?.n || 0;
  const welcome = list.find((r) => r.status === 'welcome')?.n || 0;
  const digestTotal = sent + failed; // 真实 digest 投递分母(排除 no_items 和 welcome)
  const successRate = digestTotal > 0 ? +((sent * 100) / digestTotal).toFixed(2) : null;
  return { sent, failed_resend: failed, no_items: noItems, welcome, success_rate_pct: successRate };
}

async function getGrowth14d(env: Env) {
  const since = Date.now() - 14 * 86400_000;
  const rows = await env.DB.prepare(
    `SELECT date(created_at/1000,'unixepoch','+8 hours') AS d, COUNT(*) AS n
     FROM subscriptions WHERE created_at > ? GROUP BY d ORDER BY d`,
  )
    .bind(since)
    .all<{ d: string; n: number }>();
  return { rows: rows.results || [] };
}

// ── 明细列表(分页 + 筛选) ──

interface ListRow {
  email: string;
  sources: string;
  send_slot: number;
  density: string;
  status: string;
  bounce_count: number;
  worker_send_failures: number;
  last_sent_at: number | null;
  created_at: number;
  user_id: string | null;
}
async function getList(env: Env, url: URL) {
  const slot = url.searchParams.get('slot') || 'all';
  const status = url.searchParams.get('status') || 'all';
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 200);
  const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0);

  const where: string[] = [];
  const params: unknown[] = [];
  if (slot !== 'all') {
    where.push('send_slot = ?');
    params.push(parseInt(slot, 10));
  }
  if (status !== 'all') {
    where.push('status = ?');
    params.push(status);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM subscriptions ${whereSql}`)
    .bind(...params)
    .first<{ n: number }>();

  params.push(limit, offset);
  const rows = await env.DB.prepare(
    `SELECT email, sources, send_slot, density, status, bounce_count, worker_send_failures,
            last_sent_at, created_at, user_id
     FROM subscriptions ${whereSql}
     ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(...params)
    .all<ListRow>();

  return {
    total: total?.n || 0,
    limit,
    offset,
    rows: rows.results || [],
  };
}

// ─── /admin/subscriptions HTML ───
export async function serveAdminSubscriptionsHtml(request: Request, env: Env): Promise<Response> {
  const guard = await requireAuth(request, env);
  if (guard) return guard;
  return new Response(SUBS_HTML, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

const SUBS_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ai-feeds admin · 订阅看板</title>
<style>
${ADMIN_SHARED_CSS}
  .page-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
  .page-head h1 { margin: 0; }

  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-bottom: 18px; }
  .card { background: #11161f; border: 1px solid #1f2937; border-radius: 8px; padding: 14px 16px; }
  .card .label { font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: .5px; }
  .card .value { font-size: 28px; font-weight: 700; color: #e6e8eb; margin-top: 4px; }
  .card .sub { font-size: 12px; color: #9ca3af; margin-top: 2px; }
  .card.wide { grid-column: span 2; }
  .card .breakdown { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 10px; }
  .card .breakdown .item { font-size: 12px; color: #9ca3af; }
  .card .breakdown .item b { color: #e6e8eb; font-weight: 600; margin-right: 3px; }

  .section { background: #11161f; border: 1px solid #1f2937; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  .section h2 { margin: 0 0 12px; font-size: 14px; font-weight: 600; color: #d1d5db; }

  .filters { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 12px; }
  .filters .label { color: #6b7280; font-size: 11px; }
  .filters select { background: #0b0e14; border: 1px solid #374151; color: #e6e8eb;
                    font-size: 12px; padding: 4px 8px; border-radius: 4px; font-family: inherit; }
  .filters .count { color: #9ca3af; font-size: 12px; margin-left: auto; }

  table.detail { width: 100%; border-collapse: collapse; font-size: 12px; }
  table.detail th { text-align: left; color: #9ca3af; font-weight: 600; padding: 8px 8px;
                    border-bottom: 1px solid #1f2937; font-size: 11px; text-transform: uppercase; letter-spacing: .3px; }
  table.detail td { padding: 8px 8px; border-bottom: 1px solid #1a1f2e; color: #e6e8eb; vertical-align: top; }
  table.detail tr:hover td { background: #161c27; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
  .pill.active { background: #064e3b; color: #6ee7b7; }
  .pill.unsubscribed { background: #1f2937; color: #9ca3af; }
  .pill.kicked { background: #7f1d1d; color: #fca5a5; }
  .pill.paused { background: #78350f; color: #fcd34d; }
  .src-tag { display: inline-block; padding: 1px 6px; border-radius: 4px; background: #1e3a8a; color: #bfdbfe;
             font-size: 11px; margin-right: 4px; margin-bottom: 2px; }

  .pager { display: flex; gap: 6px; align-items: center; margin-top: 12px; font-size: 12px; color: #9ca3af; }
  .pager button { background: #1f2937; border: 1px solid #374151; color: #e6e8eb;
                  font-size: 12px; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-family: inherit; }
  .pager button:disabled { opacity: .35; cursor: not-allowed; }

  .growth-bars { display: flex; align-items: flex-end; gap: 4px; height: 70px; margin-top: 8px; }
  .growth-bars .b { flex: 1; background: #1d4ed8; border-radius: 2px 2px 0 0; min-height: 1px; position: relative; }
  .growth-bars .b:hover { background: #2563eb; }
  .growth-bars .b .tip { position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%);
                         background: #0b0e14; color: #e6e8eb; padding: 2px 6px; border-radius: 3px;
                         font-size: 10px; white-space: nowrap; display: none; }
  .growth-bars .b:hover .tip { display: block; }

  .empty { color: #6b7280; font-size: 12px; padding: 12px 0; }
</style>
</head>
<body>
${adminNavHtml('subscriptions')}
<main class="container">
  <div class="page-head">
    <h1>订阅看板</h1>
    <span class="meta" id="metaText"></span>
  </div>

  <div class="cards" id="cards">
    <div class="card"><div class="label">总订阅</div><div class="value" id="cTotal">-</div><div class="sub" id="cTotalSub">-</div></div>
    <div class="card wide">
      <div class="label">按推送时段(active)</div>
      <div class="breakdown" id="cBySlot"></div>
    </div>
    <div class="card">
      <div class="label">默认 / 精选(active)</div>
      <div class="breakdown" id="cByDensity"></div>
    </div>
    <div class="card wide">
      <div class="label">各源被勾选数(active)</div>
      <div class="breakdown" id="cBySource"></div>
    </div>
    <div class="card">
      <div class="label">近 7 天投递</div>
      <div class="value" id="cSuccess">-</div>
      <div class="sub" id="cSuccessSub">-</div>
    </div>
    <div class="card wide">
      <div class="label">近 14 天每日新增</div>
      <div class="growth-bars" id="cGrowth"></div>
    </div>
  </div>

  <div class="section">
    <h2>订阅明细</h2>
    <div class="filters">
      <span class="label">时段</span>
      <select id="fSlot">
        <option value="all">全部</option>
        <option value="8">早 8:00</option>
        <option value="12">午 12:00</option>
        <option value="17">下午 17:00</option>
      </select>
      <span class="label">状态</span>
      <select id="fStatus">
        <option value="all">全部</option>
        <option value="active">active</option>
        <option value="unsubscribed">unsubscribed</option>
        <option value="kicked">kicked</option>
        <option value="paused">paused</option>
      </select>
      <span class="count" id="listCount"></span>
    </div>
    <table class="detail" id="listTable">
      <thead>
        <tr>
          <th>邮箱</th><th>源</th><th>时段</th><th>档位</th><th>状态</th>
          <th>bounce</th><th>失败</th><th>上次推送</th><th>订阅时间</th><th>注册</th>
        </tr>
      </thead>
      <tbody id="listBody"></tbody>
    </table>
    <div class="pager">
      <button id="prevBtn">上一页</button>
      <span id="pageInfo">-</span>
      <button id="nextBtn">下一页</button>
    </div>
  </div>
</main>
<script>
const SRC_NAME = { ph: '热门产品', gh: '开源项目', 'hf-paper': '论文', clawhub: '龙虾技能', x: '动态' };
const SLOT_NAME = { 8: '早 8:00', 12: '午 12:00', 17: '下午 17:00' };
const DENSITY_NAME = { normal: '默认', curated: '精选' };

async function getJson(url) {
  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) throw new Error(url + ' → ' + r.status);
  return r.json();
}

function fmtTs(ms) {
  if (!ms) return '-';
  const d = new Date(ms + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

async function loadCards() {
  try {
    const [ov, slot, den, src, deliv, growth] = await Promise.all([
      getJson('/api/admin/subscriptions?metric=overview'),
      getJson('/api/admin/subscriptions?metric=by-slot'),
      getJson('/api/admin/subscriptions?metric=by-density'),
      getJson('/api/admin/subscriptions?metric=by-source'),
      getJson('/api/admin/subscriptions?metric=delivery-7d'),
      getJson('/api/admin/subscriptions?metric=growth-14d'),
    ]);

    document.getElementById('cTotal').textContent = ov.total;
    const breakdownStatus = (ov.by_status || []).map(r => '<span class="item"><b>' + r.n + '</b>' + r.status + '</span>').join('');
    document.getElementById('cTotalSub').innerHTML = '已注册 <b>' + (ov.total_registered || 0) + '</b> · ' + breakdownStatus;

    const slotMap = {};
    (slot.rows || []).forEach(r => { slotMap[r.send_slot] = r.n; });
    document.getElementById('cBySlot').innerHTML = [8, 12, 17].map(s =>
      '<span class="item"><b>' + (slotMap[s] || 0) + '</b>' + SLOT_NAME[s] + '</span>'
    ).join('');

    document.getElementById('cByDensity').innerHTML = (den.rows || []).map(r =>
      '<span class="item"><b>' + r.n + '</b>' + (DENSITY_NAME[r.density] || r.density) + '</span>'
    ).join('') || '<span class="empty">无数据</span>';

    document.getElementById('cBySource').innerHTML = (src.rows || []).map(r =>
      '<span class="item"><b>' + r.n + '</b>' + (SRC_NAME[r.src] || r.src) + '</span>'
    ).join('') || '<span class="empty">无数据</span>';

    document.getElementById('cSuccess').textContent = deliv.success_rate_pct != null ? deliv.success_rate_pct + '%' : '-';
    document.getElementById('cSuccessSub').innerHTML =
      'sent <b>' + deliv.sent + '</b> · failed <b>' + deliv.failed_resend + '</b> · no_items <b>' + deliv.no_items + '</b> · welcome <b>' + deliv.welcome + '</b>';

    const rows = growth.rows || [];
    const max = rows.reduce((m, r) => Math.max(m, r.n), 0) || 1;
    document.getElementById('cGrowth').innerHTML = rows.map(r =>
      '<div class="b" style="height:' + Math.max(2, (r.n / max) * 100) + '%"><span class="tip">' + r.d + ': ' + r.n + '</span></div>'
    ).join('') || '<span class="empty">无数据</span>';
  } catch (e) {
    console.error('loadCards', e);
  }
}

let pageOffset = 0;
const PAGE_SIZE = 50;

async function loadList() {
  const slot = document.getElementById('fSlot').value;
  const status = document.getElementById('fStatus').value;
  const data = await getJson('/api/admin/subscriptions?metric=list&slot=' + slot + '&status=' + status + '&limit=' + PAGE_SIZE + '&offset=' + pageOffset);

  const body = document.getElementById('listBody');
  body.innerHTML = (data.rows || []).map(r => {
    let sources = [];
    try { sources = JSON.parse(r.sources); } catch (e) {}
    const srcHtml = sources.map(s => '<span class="src-tag">' + (SRC_NAME[s] || s) + '</span>').join('');
    const statusCls = r.status;
    return '<tr>' +
      '<td>' + (r.email || '') + '</td>' +
      '<td>' + srcHtml + '</td>' +
      '<td>' + (SLOT_NAME[r.send_slot] || r.send_slot) + '</td>' +
      '<td>' + (DENSITY_NAME[r.density] || r.density) + '</td>' +
      '<td><span class="pill ' + statusCls + '">' + r.status + '</span></td>' +
      '<td>' + r.bounce_count + '</td>' +
      '<td>' + r.worker_send_failures + '</td>' +
      '<td>' + fmtTs(r.last_sent_at) + '</td>' +
      '<td>' + fmtTs(r.created_at) + '</td>' +
      '<td>' + (r.user_id ? '✓' : '匿名') + '</td>' +
      '</tr>';
  }).join('') || '<tr><td colspan="10" class="empty">无数据</td></tr>';

  document.getElementById('listCount').textContent = '共 ' + data.total + ' 条';
  const start = data.total === 0 ? 0 : pageOffset + 1;
  const end = Math.min(pageOffset + PAGE_SIZE, data.total);
  document.getElementById('pageInfo').textContent = start + '-' + end + ' / ' + data.total;
  document.getElementById('prevBtn').disabled = pageOffset === 0;
  document.getElementById('nextBtn').disabled = end >= data.total;
}

document.getElementById('fSlot').addEventListener('change', () => { pageOffset = 0; loadList(); });
document.getElementById('fStatus').addEventListener('change', () => { pageOffset = 0; loadList(); });
document.getElementById('prevBtn').addEventListener('click', () => { pageOffset = Math.max(0, pageOffset - PAGE_SIZE); loadList(); });
document.getElementById('nextBtn').addEventListener('click', () => { pageOffset += PAGE_SIZE; loadList(); });

loadCards();
loadList();
document.getElementById('metaText').textContent = new Date().toLocaleString('zh-CN');
</script>
</body>
</html>`;
