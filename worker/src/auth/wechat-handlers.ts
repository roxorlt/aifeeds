// PR-WechatAuth(worker)：/api/auth/wechat/exchange handler
// 接 docs/wechat/architecture.md §4-5 设计 — .cc 中转服务（无状态 OAuth 代理）
// 已经从微信 API 拿到 openid + unionid 后，调本端拿业务 session_token。
//
// 流程：
//   1. 校验 X-Bridge-Timestamp（30s replay 窗）
//   2. 校验 X-Bridge-Signature = HMAC_SHA256(BRIDGE_SECRET, ts + "." + sha256_hex(body))
//   3. find identity (provider='wechat', identity_value=unionid 优先 / openid fallback)
//   4. 找/建 user + identity（找到时 nickname/avatar 同步更新）
//   5. 关联 device events + share_relations 回流（如 .cc 透传了 device_id）
//   6. createSession 签 session_token 返回
//
// .cc 端 server-to-server 调用，response 不发 Set-Cookie；
// 由 .com 前端在 /auth/callback 时根据 session_token 自己写 cookie。
//
// 错误码：
//   400 invalid_body / invalid_openid / invalid_json
//   401 bridge_auth_failed（headers 缺失 / ts 过期 / 签名不匹配）
//   500 internal（BRIDGE_SECRET 未配）
//   503 wechat_login_disabled（ENABLE_WECHAT_LOGIN='false' 时紧急关停）

import { nanoid } from 'nanoid';
import type { Env } from '../index';
import {
  createSession,
  getSidFromRequest,
  findActiveSession,
  touchSessionLastUsed,
  buildSessionCookie,
} from './session';
import { isDevHost } from './handlers';

const BRIDGE_REPLAY_WINDOW_SEC = 30;
const OPENID_LEN_MIN = 4;
const OPENID_LEN_MAX = 128;

interface ExchangeBody {
  openid: string;
  unionid?: string;
  nickname?: string;
  avatar_url?: string;
  // 以下 3 个由 .cc 透传：用户从 .com 跳到 .cc 时把 device_id 拼在 return_to query 里
  // .cc 拿到 callback 时连同 openid 一起 POST 过来。缺失时 worker 用默认值。
  device_id?: string;
  ip?: string;
  ua?: string;
}

function jsonOk(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function jsonErr(message: string, status: number, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ error: message, ...extra }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function sha256Hex(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const h = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256Hex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 常数时间字符串比较（避免 timing attack）
function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function handleWechatExchange(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // 0. feature flag（紧急关停用）
  if (env.ENABLE_WECHAT_LOGIN === 'false') {
    return jsonErr('wechat login disabled', 503, { reason: 'wechat_disabled' });
  }

  // 1. bridge headers
  const tsHeader = request.headers.get('X-Bridge-Timestamp');
  const sigHeader = request.headers.get('X-Bridge-Signature');
  if (!tsHeader || !sigHeader) {
    return jsonErr('bridge_auth_failed', 401, { reason: 'missing_headers' });
  }

  const ts = Number(tsHeader);
  if (!Number.isFinite(ts) || ts <= 0) {
    return jsonErr('bridge_auth_failed', 401, { reason: 'invalid_timestamp' });
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > BRIDGE_REPLAY_WINDOW_SEC) {
    return jsonErr('bridge_auth_failed', 401, { reason: 'timestamp_out_of_window' });
  }

  // 2. 读 body 原文（用于签名计算）
  const bodyText = await request.text();
  if (!bodyText) return jsonErr('invalid_body', 400, { reason: 'empty' });

  // 3. 校验签名
  const secret = env.BRIDGE_SECRET;
  if (!secret) {
    return jsonErr('internal', 500, { reason: 'bridge_secret_not_configured' });
  }
  const bodyHash = await sha256Hex(bodyText);
  const expected = await hmacSha256Hex(secret, `${ts}.${bodyHash}`);
  if (!timingSafeEq(expected, sigHeader.toLowerCase())) {
    return jsonErr('bridge_auth_failed', 401, { reason: 'signature_mismatch' });
  }

  // 4. parse body
  let body: ExchangeBody;
  try {
    body = JSON.parse(bodyText) as ExchangeBody;
  } catch {
    return jsonErr('invalid_json', 400);
  }

  if (
    typeof body.openid !== 'string' ||
    body.openid.length < OPENID_LEN_MIN ||
    body.openid.length > OPENID_LEN_MAX
  ) {
    return jsonErr('invalid_openid', 400);
  }
  if (
    body.unionid !== undefined &&
    (typeof body.unionid !== 'string' || body.unionid.length > OPENID_LEN_MAX)
  ) {
    return jsonErr('invalid_unionid', 400);
  }

  // 5. 选 identity_value：unionid 优先（跨应用统一），否则 openid（应用内唯一）
  const hasUnionId = typeof body.unionid === 'string' && body.unionid.length > 0;
  const identityValue = hasUnionId ? (body.unionid as string) : body.openid;
  const identityProvider = 'wechat';

  // ⚠️ IP 故意从 body 取，不用 client-ip.ts 的 getClientIp(req, env)。
  // 本 endpoint 的「请求方」是 .cc 中转服务器（server-to-server），不是终端用户。
  // getClientIp 取的会是 .cc / 香港 VPS 的 IP，不是真实用户。真实用户 IP 由 .cc 在
  // 用户访问 .cc/auth/wechat/callback 时捕获，拼进 body.ip 透传过来。
  // （2026-06-02 香港中转后 getClientIp 重构成 relay-aware，但只对终端用户直连的
  //  endpoint 有意义；本 endpoint 不要改用它。）
  const ip = typeof body.ip === 'string' && body.ip.length > 0 ? body.ip : '0.0.0.0';
  const ua = typeof body.ua === 'string' ? body.ua : '';
  const deviceId =
    typeof body.device_id === 'string' && body.device_id.length > 0 ? body.device_id : null;

  // 6. find existing identity → user
  const now = Date.now();
  const ident = await env.DB.prepare(
    `SELECT user_id FROM identities
     WHERE provider = ? AND identity_value = ? AND unbound_at IS NULL`,
  )
    .bind(identityProvider, identityValue)
    .first<{ user_id: string }>();

  let userId: string;
  let isNewUser = false;
  if (ident) {
    userId = ident.user_id;
    // last_active_at 续期 + 同步可能变化的 nickname / avatar（COALESCE：value 为 null 时保留旧值）
    const newNickname = typeof body.nickname === 'string' && body.nickname.length > 0
      ? body.nickname
      : null;
    const newAvatar = typeof body.avatar_url === 'string' && body.avatar_url.length > 0
      ? body.avatar_url
      : null;
    ctx.waitUntil(
      env.DB.prepare(
        `UPDATE users SET last_active_at = ?,
           display_name = COALESCE(?, display_name),
           avatar_url   = COALESCE(?, avatar_url)
         WHERE id = ?`,
      ).bind(now, newNickname, newAvatar, userId).run(),
    );
  } else {
    userId = nanoid(14);
    isNewUser = true;
    // 当 identity_value = unionid 时，把 openid 存到 identities.metadata，便于以后排查
    const identMeta = hasUnionId
      ? JSON.stringify({ openid: body.openid, source: 'wechat-open-platform' })
      : JSON.stringify({ source: 'wechat-open-platform' });
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO users (id, display_name, avatar_url, created_at, last_active_at, status)
           VALUES (?, ?, ?, ?, ?, 'active')`,
        )
        .bind(userId, body.nickname || null, body.avatar_url || null, now, now),
      env.DB
        .prepare(
          `INSERT INTO identities (user_id, provider, identity_value, verified_at, metadata)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(userId, identityProvider, identityValue, now, identMeta),
    ]);
  }

  // 7. 关联 device → 历史 events 行的 user_id（如 .cc 透传了 device_id）
  if (deviceId) {
    ctx.waitUntil(
      env.DB
        .prepare(
          `UPDATE events SET user_id = ?
           WHERE device_id = ? AND user_id IS NULL AND occurred_at > ?`,
        )
        .bind(userId, deviceId, now - 30 * 24 * 3600_000)
        .run(),
    );

    // PR5 landing 回流
    ctx.waitUntil(
      env.DB
        .prepare(
          `UPDATE share_relations SET to_uid = ?, registered_at = ?
           WHERE to_did = ? AND to_uid IS NULL`,
        )
        .bind(userId, now, deviceId)
        .run(),
    );
  }

  // 8. 创建 session（不 Set-Cookie，由 .com 前端 /auth/callback 调 adopt 换 HttpOnly cookie）
  const session = await createSession(env, userId, deviceId, ip, ua);

  return jsonOk({
    user_id: userId,
    session_token: session.id,
    expires_at: session.expiresAt,
    is_new: isNewUser,
  });
}

// ─── POST /api/auth/session/adopt ───────────────────────────
// 把已存在的 session_token（微信 exchange 创建、经 relay 带到 .com/auth/callback 的）
// 换成 HttpOnly cookie。dashboard /auth/callback 拿 URL 里的 session 调本端点（Bearer），
// worker 校验是真实活跃 session 后下发 Set-Cookie —— 微信登录由此与邮箱/SMS 共用同一套
// HttpOnly cookie 会话，前端无需 JS 写 cookie（更安全）。
//
// 只对【已存在且活跃】的 session 重发 cookie，不创建 session；token 不可猜（nanoid32）。
export async function handleSessionAdopt(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const sid = getSidFromRequest(request); // 优先 Authorization: Bearer，再 Cookie
  if (!sid) return jsonErr('missing session token', 401, { reason: 'no_token' });

  const session = await findActiveSession(env, sid);
  if (!session) return jsonErr('invalid or expired session', 401, { reason: 'invalid_session' });

  ctx.waitUntil(touchSessionLastUsed(env, sid));
  const cookie = buildSessionCookie(sid, isDevHost(request));
  return new Response(JSON.stringify({ ok: true, user_id: session.user_id }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': cookie },
  });
}
