// Admin panel handlers + 嵌入式 HTML。
// 鉴权（优先级从高到低）：
//   1. Cloudflare Access JWT（推荐）：边缘节点 Access 拦截 + worker 校验 Cf-Access-Jwt-Assertion
//      启用条件：env.CF_ACCESS_AUD + env.CF_ACCESS_TEAM_DOMAIN 都已设置
//   2. HTTP Basic Auth（fallback）：env.ADMIN_USER / ADMIN_PASS（仅在 CF Access 未配置时启用）
//
// 路径：
//   GET  /admin                   → 302 → /admin/dashboard
//   GET  /admin/dashboard         → 仪表盘（见 admin-dashboard.ts）
//   GET  /admin/tools             → 运维工具 HTML（本文件 TOOLS_HTML）
//   GET  /api/admin/sms-status    ?phone=...
//   POST /api/admin/unlock-sms    {phone}
//   GET  /api/admin/user          ?phone=...
//   POST /api/admin/cleanup-account {phone}
//   GET  /api/admin/daily-cap

import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Env } from './index';

const REALM = 'ai-feeds admin';

// Shared CSS + top nav reused by both /admin/dashboard and /admin/tools so the
// visual style stays in sync. Dashboard adds its own KPI/chart CSS on top.
export const ADMIN_SHARED_CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; padding: 0; font-family: -apple-system, system-ui, "PingFang SC", sans-serif;
         background: #0b0e14; color: #e6e8eb; line-height: 1.5; }
  .topnav { display: flex; align-items: center; gap: 4px; padding: 12px 24px;
            background: #11161f; border-bottom: 1px solid #1f2937; position: sticky; top: 0; z-index: 10; }
  .topnav .brand { font-size: 14px; font-weight: 600; color: #e6e8eb; margin-right: 16px; }
  .topnav .brand span { color: #6b7280; font-weight: 400; }
  .topnav a { padding: 6px 12px; border-radius: 6px; color: #9ca3af; text-decoration: none;
              font-size: 13px; font-weight: 500; transition: background .15s, color .15s; }
  .topnav a:hover { background: #1f2937; color: #e6e8eb; }
  .topnav a.active { background: #1f2937; color: #e6e8eb; }
  .topnav .meta { margin-left: auto; font-size: 12px; color: #6b7280; font-family: ui-monospace, monospace; }
  main { padding: 24px; }
  h1 { font-size: 18px; margin: 0 0 24px; color: #9ca3af; font-weight: 500; }
  h1 b { color: #e6e8eb; font-weight: 600; }
`;

export function adminNavHtml(active: 'dashboard' | 'tools' | 'ops'): string {
  const cls = (k: string) => (k === active ? 'active' : '');
  return `<nav class="topnav">
    <span class="brand">ai-feeds <span>admin</span></span>
    <a class="${cls('dashboard')}" href="/admin/dashboard">📊 仪表盘</a>
    <a class="${cls('ops')}" href="/admin/ops">📦 运营</a>
    <a class="${cls('tools')}" href="/admin/tools">🔧 运维工具</a>
    <span class="meta" id="metaText"></span>
  </nav>`;
}

// 模块级缓存 JWKS（公钥集），避免每次请求都拉一次 CF certs endpoint。
// jose 的 createRemoteJWKSet 内部已有 5min cache + key rotation 处理。
let jwksCache: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksCachedFor: string | null = null;
function getJWKS(teamDomain: string) {
  if (jwksCache && jwksCachedFor === teamDomain) return jwksCache;
  jwksCache = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
  jwksCachedFor = teamDomain;
  return jwksCache;
}

function unauthorized(env: Env): Response {
  // CF Access 模式下不返回 WWW-Authenticate（避免浏览器弹原生 Basic Auth 框 —— CF
  // 边缘理论上已经拦下来不该到这里；万一到了，返回纯 401 让用户知道是 token 问题）
  if (env.CF_ACCESS_AUD && env.CF_ACCESS_TEAM_DOMAIN) {
    return new Response('Unauthorized: missing or invalid Cf-Access JWT', {
      status: 401,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
  return new Response('Authentication required', {
    status: 401,
    headers: {
      'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}

export async function checkAdminAuth(request: Request, env: Env): Promise<boolean> {
  // 优先：CF Access JWT 校验。配齐 CF_ACCESS_AUD + CF_ACCESS_TEAM_DOMAIN 即启用，
  // 启用后严格模式：JWT 校验失败直接拒绝，不回落到 Basic Auth。
  if (env.CF_ACCESS_AUD && env.CF_ACCESS_TEAM_DOMAIN) {
    const token = request.headers.get('Cf-Access-Jwt-Assertion');
    if (!token) return false;
    try {
      await jwtVerify(token, getJWKS(env.CF_ACCESS_TEAM_DOMAIN), {
        issuer: env.CF_ACCESS_TEAM_DOMAIN,
        audience: env.CF_ACCESS_AUD,
      });
      return true; // jose 自动校验 exp / 签名 / issuer / audience
    } catch {
      return false;
    }
  }
  // Fallback：Basic Auth。仅在 CF Access 未配置时使用（迁移期 / 应急通道）。
  if (!env.ADMIN_USER || !env.ADMIN_PASS) return false;
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Basic ')) return false;
  try {
    const decoded = atob(header.slice(6));
    const idx = decoded.indexOf(':');
    if (idx < 0) return false;
    return decoded.slice(0, idx) === env.ADMIN_USER && decoded.slice(idx + 1) === env.ADMIN_PASS;
  } catch {
    return false;
  }
}

export async function requireAuth(request: Request, env: Env): Promise<Response | null> {
  if (!(await checkAdminAuth(request, env))) return unauthorized(env);
  return null;
}

export function jsonRes(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// ─── /api/admin/sms-status?phone=... ───
export async function adminSmsStatus(request: Request, env: Env): Promise<Response> {
  const guard = await requireAuth(request, env);
  if (guard) return guard;
  const phone = new URL(request.url).searchParams.get('phone');
  if (!phone) return jsonRes({ error: 'phone required' }, 400);

  const now = Date.now();
  const c60 = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM sms_send_log WHERE phone=? AND result='success' AND sent_at > ?`,
  ).bind(phone, now - 60_000).first<{ n: number }>();
  const c5m = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM sms_send_log WHERE phone=? AND result='success' AND sent_at > ?`,
  ).bind(phone, now - 5 * 60_000).first<{ n: number }>();
  const c24h = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM sms_send_log WHERE phone=? AND result='success' AND sent_at > ?`,
  ).bind(phone, now - 24 * 3600_000).first<{ n: number }>();
  const lastSuccess = await env.DB.prepare(
    `SELECT code_attempts, sent_at FROM sms_send_log WHERE phone=? AND result='success' ORDER BY sent_at DESC LIMIT 1`,
  ).bind(phone).first<{ code_attempts: number; sent_at: number }>();
  const recent = await env.DB.prepare(
    `SELECT id, datetime(sent_at/1000, 'unixepoch', '+8 hours') as bjt, ip, device_id, result, code_attempts
     FROM sms_send_log WHERE phone=? ORDER BY sent_at DESC LIMIT 20`,
  ).bind(phone).all();

  const n60 = c60?.n ?? 0;
  const n5m = c5m?.n ?? 0;
  const n24 = c24h?.n ?? 0;
  const lockedByAttempts =
    !!lastSuccess && lastSuccess.code_attempts >= 5 && lastSuccess.sent_at > now - 30 * 60_000;

  return jsonRes({
    phone,
    counts: { last_60s: n60, last_5min: n5m, last_24h: n24 },
    locks: {
      phone_60s: n60 >= 1,
      phone_5min: n5m >= 3,
      phone_24h: n24 >= 10,
      phone_locked_30min_by_failed_attempts: lockedByAttempts,
    },
    recent: recent.results,
  });
}

// ─── POST /api/admin/unlock-sms ───
export async function adminUnlockSms(request: Request, env: Env): Promise<Response> {
  const guard = await requireAuth(request, env);
  if (guard) return guard;
  let body: { phone?: string };
  try {
    body = await request.json();
  } catch {
    return jsonRes({ error: 'invalid json' }, 400);
  }
  if (!body.phone) return jsonRes({ error: 'phone required' }, 400);

  // 将 success → cleared（保留行作审计），重置 code_attempts
  const upd = await env.DB.prepare(
    `UPDATE sms_send_log SET result='cleared', code_attempts=0 WHERE phone=? AND result='success'`,
  ).bind(body.phone).run();

  return jsonRes({
    ok: true,
    phone: body.phone,
    cleared_rows: upd.meta.changes ?? 0,
  });
}

// ─── /api/admin/user?phone=... ───
export async function adminUser(request: Request, env: Env): Promise<Response> {
  const guard = await requireAuth(request, env);
  if (guard) return guard;
  const phone = new URL(request.url).searchParams.get('phone');
  if (!phone) return jsonRes({ error: 'phone required' }, 400);

  const ident = await env.DB.prepare(
    `SELECT user_id, verified_at FROM identities WHERE provider='phone' AND identity_value=? AND unbound_at IS NULL`,
  ).bind(phone).first<{ user_id: string; verified_at: number }>();
  if (!ident) return jsonRes({ error: 'no user with this phone' }, 404);

  const user = await env.DB.prepare(
    `SELECT id, display_name, avatar_url, status, datetime(created_at/1000, 'unixepoch', '+8 hours') as created_bjt FROM users WHERE id=?`,
  ).bind(ident.user_id).first();
  const sessions = await env.DB.prepare(
    `SELECT id, device_id, ip,
            datetime(created_at/1000, 'unixepoch', '+8 hours') as created_bjt,
            datetime(expires_at/1000, 'unixepoch', '+8 hours') as expires_bjt,
            revoked_at
     FROM sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 10`,
  ).bind(ident.user_id).all();
  const eventCount = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM events WHERE user_id=?`,
  ).bind(ident.user_id).first<{ n: number }>();

  return jsonRes({
    user,
    phone_verified_bjt: new Date(ident.verified_at).toISOString(),
    sessions: sessions.results,
    event_count: eventCount?.n ?? 0,
  });
}

// ─── POST /api/admin/cleanup-account ───
export async function adminCleanupAccount(request: Request, env: Env): Promise<Response> {
  const guard = await requireAuth(request, env);
  if (guard) return guard;
  let body: { phone?: string };
  try {
    body = await request.json();
  } catch {
    return jsonRes({ error: 'invalid json' }, 400);
  }
  if (!body.phone) return jsonRes({ error: 'phone required' }, 400);

  const ident = await env.DB.prepare(
    `SELECT user_id FROM identities WHERE provider='phone' AND identity_value=?`,
  ).bind(body.phone).first<{ user_id: string }>();
  if (!ident) return jsonRes({ error: 'no user with this phone' }, 404);
  const userId = ident.user_id;

  // 顺序：sessions → identities → events.user_id 置空 → users
  const r = await env.DB.batch([
    env.DB.prepare(`DELETE FROM sessions WHERE user_id=?`).bind(userId),
    env.DB.prepare(`DELETE FROM identities WHERE user_id=?`).bind(userId),
    env.DB.prepare(`UPDATE events SET user_id=NULL WHERE user_id=?`).bind(userId),
    env.DB.prepare(`DELETE FROM users WHERE id=?`).bind(userId),
    env.DB.prepare(`UPDATE sms_send_log SET result='cleared' WHERE phone=? AND result='success'`).bind(body.phone),
  ]);

  return jsonRes({
    ok: true,
    user_id: userId,
    sessions_deleted: r[0].meta.changes ?? 0,
    identities_deleted: r[1].meta.changes ?? 0,
    events_unlinked: r[2].meta.changes ?? 0,
    user_deleted: r[3].meta.changes ?? 0,
    sms_log_cleared: r[4].meta.changes ?? 0,
  });
}

// ─── /api/admin/daily-cap ───
export async function adminDailyCap(request: Request, env: Env): Promise<Response> {
  const guard = await requireAuth(request, env);
  if (guard) return guard;

  const cap = parseInt(env.SMS_DAILY_CAP || '200', 10);
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const key = `sms_count_${yyyy}${mm}${dd}`;
  const cur = await env.AUTH_KV.get(key);
  const sent = cur ? parseInt(cur, 10) : 0;

  return jsonRes({
    cap,
    sent,
    remaining: cap - sent,
    pct: cap > 0 ? Math.round((sent / cap) * 100) : 0,
    utc_date: `${yyyy}-${mm}-${dd}`,
    sms_provider: env.SMS_PROVIDER || 'tencent',
    kill_switch: cap <= 0,
  });
}

// ─── POST /api/admin/share/poster-cleanup ───
// PR2 v2 (2026-05-22): 清掉 R2 里所有历史海报 PNG cache。
// 当前 worker 已不再读写 share/poster/* (改成 worker per-request 渲染 +
// Cache-Control 1 小时), 但之前 1 年 immutable 写入的 PNG 仍占 R2 空间。
// 部署后调一次清空; 此后 R2 海报目录始终空。
//
// curl -u admin:pass -X POST https://staging-api.ai-feeds.com/api/admin/share/poster-cleanup
export async function adminClearPosterCache(request: Request, env: Env): Promise<Response> {
  const guard = await requireAuth(request, env);
  if (guard) return guard;
  if (!env.READMES) return jsonRes({ error: 'no R2 bucket bound' }, 500);

  let deleted = 0;
  let cursor: string | undefined;
  // 分页 list + 批量 delete (R2 list 单页 limit 1000)
  for (let i = 0; i < 100; i++) {  // 防爆: 最多 100 页 = 100k objects
    const list = await env.READMES.list({ prefix: 'share/poster/', limit: 1000, cursor });
    if (list.objects.length === 0) break;
    const keys = list.objects.map(o => o.key);
    await env.READMES.delete(keys);
    deleted += keys.length;
    if (!list.truncated) break;
    cursor = list.truncated ? (list as { cursor?: string }).cursor : undefined;
    if (!cursor) break;
  }
  return jsonRes({ deleted, prefix: 'share/poster/' });
}

// ─── /admin/tools → 运维工具 HTML ───
export async function serveAdminToolsHtml(request: Request, env: Env): Promise<Response> {
  const guard = await requireAuth(request, env);
  if (guard) return guard;
  return new Response(TOOLS_HTML, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

const TOOLS_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ai-feeds admin · 运维工具</title>
<style>
${ADMIN_SHARED_CSS}
  .grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); }
  .card { background: #11161f; border: 1px solid #1f2937; border-radius: 8px; padding: 16px; }
  .card h2 { margin: 0 0 12px; font-size: 14px; font-weight: 600; color: #d1d5db; }
  .card p.hint { margin: 0 0 12px; font-size: 12px; color: #6b7280; }
  input[type=text], input[type=tel], textarea {
    width: 100%; background: #0b0e14; border: 1px solid #374151; color: #e6e8eb;
    padding: 8px 10px; border-radius: 6px; font-family: ui-monospace, monospace; font-size: 13px;
    box-sizing: border-box;
  }
  textarea { min-height: 90px; resize: vertical; line-height: 1.4; }
  input:focus, textarea:focus { outline: none; border-color: #6b7280; }
  .row { display: flex; gap: 8px; margin-top: 8px; }
  button {
    flex: 0 0 auto; padding: 8px 14px; border-radius: 6px; border: 1px solid #374151;
    background: #1f2937; color: #e6e8eb; font-size: 13px; font-weight: 500; cursor: pointer;
  }
  button:hover { background: #374151; }
  button.danger { background: #7f1d1d; border-color: #991b1b; }
  button.danger:hover { background: #991b1b; }
  pre { background: #0b0e14; border: 1px solid #1f2937; border-radius: 6px; padding: 12px;
        margin: 12px 0 0; font-size: 12px; max-height: 360px; overflow: auto; color: #d1d5db; }
  pre.error { border-color: #7f1d1d; color: #fca5a5; }
  .badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 500; }
  .badge.ok { background: #064e3b; color: #6ee7b7; }
  .badge.warn { background: #7c2d12; color: #fdba74; }
  .badge.err { background: #7f1d1d; color: #fca5a5; }
</style>
</head>
<body>
${adminNavHtml('tools')}
<main>
<div class="grid" data-testid="admin-tools-grid">

  <div class="card" data-testid="card-sms-status">
    <h2>📊 SMS 状态查询</h2>
    <p class="hint">查看某手机号的当前限流 count + 锁定状态 + 最近 20 条 log</p>
    <input type="tel" id="smsStatusPhone" placeholder="11 位手机号" />
    <div class="row"><button onclick="run('GET','/api/admin/sms-status?phone=' + encodeURIComponent(val('smsStatusPhone')), null, 'smsStatusOut')">查询</button></div>
    <pre id="smsStatusOut">—</pre>
  </div>

  <div class="card" data-testid="card-unlock-sms">
    <h2>🔓 解锁 SMS 限流</h2>
    <p class="hint">将该手机号所有 success 记录改成 cleared，限流 count 立即归零</p>
    <input type="tel" id="unlockPhone" placeholder="11 位手机号" />
    <div class="row"><button class="danger" onclick="confirmRun('确认解锁该手机号？', 'POST', '/api/admin/unlock-sms', {phone: val('unlockPhone')}, 'unlockOut')">解锁</button></div>
    <pre id="unlockOut">—</pre>
  </div>

  <div class="card" data-testid="card-user-detail">
    <h2>👤 User 详情</h2>
    <p class="hint">按手机号查 user / sessions / 关联 events 数</p>
    <input type="tel" id="userPhone" placeholder="11 位手机号" />
    <div class="row"><button onclick="run('GET','/api/admin/user?phone=' + encodeURIComponent(val('userPhone')), null, 'userOut')">查询</button></div>
    <pre id="userOut">—</pre>
  </div>

  <div class="card" data-testid="card-cleanup-account">
    <h2>🗑 清除测试账号</h2>
    <p class="hint">删除 user / identities / sessions，events 的 user_id 置 NULL，sms_send_log 标 cleared。<b style="color:#fca5a5">不可逆</b>。</p>
    <input type="tel" id="cleanupPhone" placeholder="11 位手机号" />
    <div class="row"><button class="danger" onclick="confirmRun('永久删除该测试账号 + 所有数据？', 'POST', '/api/admin/cleanup-account', {phone: val('cleanupPhone')}, 'cleanupOut')">删除账号</button></div>
    <pre id="cleanupOut">—</pre>
  </div>

  <div class="card" data-testid="card-daily-cap">
    <h2>📈 今日 SMS 用量</h2>
    <p class="hint">SMS_DAILY_CAP 每日总量上限 + KV 当前 count + provider 切换状态</p>
    <div class="row"><button onclick="run('GET','/api/admin/daily-cap', null, 'capOut')">刷新</button></div>
    <pre id="capOut">—</pre>
  </div>

  <div class="card" data-testid="card-x-cookie">
    <h2>🍪 X Cookie 更新</h2>
    <p class="hint">X article body 抓取走 GraphQL <code>TweetResultByRestId</code> 需登录 cookie。失效时(401/403)workflow 自动标失败 + PushDeer 推送,需在此页面更新。<br>步骤:浏览器登录 X 小号 → F12 → Application → Cookies → x.com → 全选复制 → 粘贴 Submit。</p>
    <div class="row" style="margin-bottom: 8px;"><button onclick="loadXCookieStatus()">查当前状态</button></div>
    <pre id="xCookieStatusOut" style="margin: 0 0 12px;">—</pre>
    <textarea id="xCookieInput" placeholder="auth_token=...; ct0=...; twid=...; (整个 Cookie header 粘进来,分号分割)"></textarea>
    <div class="row"><button class="danger" onclick="submitXCookie()">提交新 Cookie</button></div>
    <pre id="xCookieOut">—</pre>
  </div>

</div>
</main>

<script>
function val(id) { return document.getElementById(id).value.trim(); }
function setMeta() {
  document.getElementById('metaText').textContent =
    location.host + ' · ' + new Date().toLocaleString('zh-CN', {hour12:false});
}
async function run(method, url, body, outId) {
  const out = document.getElementById(outId);
  out.classList.remove('error');
  out.textContent = 'loading...';
  try {
    const opts = { method, headers: {} };
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const r = await fetch(url, opts);
    const text = await r.text();
    let formatted = text;
    try { formatted = JSON.stringify(JSON.parse(text), null, 2); } catch {}
    out.textContent = '[' + r.status + '] ' + formatted;
    if (!r.ok) out.classList.add('error');
  } catch (e) {
    out.classList.add('error');
    out.textContent = 'fetch error: ' + (e.message || e);
  }
}
async function confirmRun(msg, method, url, body, outId) {
  if (!confirm(msg)) return;
  await run(method, url, body, outId);
}
async function loadXCookieStatus() {
  await run('GET', '/api/admin/x-cookie', null, 'xCookieStatusOut');
}
async function submitXCookie() {
  const cs = document.getElementById('xCookieInput').value.trim();
  if (!cs) { alert('请粘贴 cookie 字符串'); return; }
  if (!cs.includes('auth_token=') || !cs.includes('ct0=')) {
    alert('Cookie 必须含 auth_token + ct0 字段(其他可选)');
    return;
  }
  if (!confirm('确认提交新 Cookie? 旧的会被覆盖')) return;
  await run('POST', '/api/admin/x-cookie', { cookie_string: cs }, 'xCookieOut');
  // 提交完顺手刷新状态
  await loadXCookieStatus();
  // 安全:textarea 清掉防 cookie 残留在 DOM
  document.getElementById('xCookieInput').value = '';
}
setMeta();
setInterval(setMeta, 30000);
loadXCookieStatus();
</script>
</body>
</html>`;
