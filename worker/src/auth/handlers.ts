// PR2 auth endpoint handlers
// 设计参考：docs/plans/2026-05-01-auth-system-design.md § 9 + § 6

import type { Env } from '../index';
import { nanoid } from 'nanoid';
import { verifyTurnstile } from './turnstile';
import {
  checkRateLimits,
  checkAndIncrDailyCap,
  checkDailyCapAlerts,
  generateCode,
  hashCode,
  sendSmsViaTencent,
} from './sms';
import {
  createSession,
  buildSessionCookie,
  buildClearCookie,
  authenticate,
  revokeSession,
  revokeAllSessionsOfUser,
  getUserById,
} from './session';
import { pushDeerAlert } from '../notifier';

// ─── 工具 ─────────────────────────────────────────────────

function jsonOk(data: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function jsonErr(message: string, status: number, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ error: message, ...extra }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function getClientIp(req: Request): string {
  return req.headers.get('CF-Connecting-IP') || req.headers.get('X-Forwarded-For') || '0.0.0.0';
}

const PHONE_REGEX = /^1[3-9]\d{9}$/;  // 大陆 11 位手机号

// ─── POST /api/auth/sms/send ──────────────────────────────

interface SmsSendBody {
  phone: string;
  turnstile_token: string;
}

const CODE_HASH_SALT = 'xlist-sms-v1';   // hash 加盐（不变更不需要 secret）

export async function handleSmsSend(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // 1. 解析 + 字段校验
  const deviceId = request.headers.get('X-Device-Id');
  if (!deviceId || deviceId.length < 8 || deviceId.length > 64) {
    return jsonErr('missing or invalid X-Device-Id', 400);
  }

  let body: SmsSendBody;
  try {
    body = (await request.json()) as SmsSendBody;
  } catch {
    return jsonErr('invalid json', 400);
  }

  if (typeof body.phone !== 'string' || !PHONE_REGEX.test(body.phone)) {
    return jsonErr('invalid phone', 400);
  }

  const ip = getClientIp(request);
  const ua = request.headers.get('User-Agent') || '';

  // 2. Turnstile 校验（dev secret 缺失时 bypass）
  const tsOk = await verifyTurnstile(env, body.turnstile_token || null, ip);
  if (!tsOk) {
    await env.DB.prepare(
      `INSERT INTO sms_send_log (phone, ip, device_id, ua, sent_at, result)
       VALUES (?, ?, ?, ?, ?, 'turnstile_failed')`,
    ).bind(body.phone, ip, deviceId, ua, Date.now()).run();
    return jsonErr('captcha failed', 403);
  }

  // 3. 三维度限流
  const rl = await checkRateLimits(env, body.phone, ip, deviceId);
  if (!rl.ok) {
    await env.DB.prepare(
      `INSERT INTO sms_send_log (phone, ip, device_id, ua, sent_at, result, metadata)
       VALUES (?, ?, ?, ?, ?, 'rate_limited', ?)`,
    ).bind(body.phone, ip, deviceId, ua, Date.now(), JSON.stringify({ reason: rl.reason })).run();
    // 严重命中（24h / lock）触发告警
    if (rl.reason === 'phone_24h_limit' || rl.reason === 'phone_locked_30min' || rl.reason === 'ip_24h_total_limit') {
      ctx.waitUntil(
        pushDeerAlert(env, '风控命中', `phone=${body.phone.slice(0, 3)}***${body.phone.slice(-4)} ip=${ip} reason=${rl.reason}`),
      );
    }
    return jsonErr('rate limited', 429, { reason: rl.reason });
  }

  // 4. 每日 cap
  const cap = await checkAndIncrDailyCap(env);
  if (!cap.ok) {
    await env.DB.prepare(
      `INSERT INTO sms_send_log (phone, ip, device_id, ua, sent_at, result, metadata)
       VALUES (?, ?, ?, ?, ?, 'budget_capped', ?)`,
    ).bind(body.phone, ip, deviceId, ua, Date.now(), JSON.stringify({ sent: cap.sent, cap: cap.cap })).run();
    ctx.waitUntil(
      pushDeerAlert(env, 'SMS 当日额度耗尽', `今日发送 ${cap.sent}/${cap.cap}（cap=0 = kill switch）。后续请求 503 直到明日 0 点重置。`),
    );
    return jsonErr('service unavailable', 503);
  }

  // 5. 跨 80% / 95% 阈值告警
  ctx.waitUntil(checkDailyCapAlerts(env, cap.sent, cap.cap));

  // 6. 生成 + hash
  const code = generateCode();
  const codeHash = await hashCode(code, CODE_HASH_SALT);
  const now = Date.now();
  const expiresAt = now + 5 * 60_000;

  // 7. 调腾讯云发送
  const sendResult = await sendSmsViaTencent(env, body.phone, code);
  if (!sendResult.ok) {
    await env.DB.prepare(
      `INSERT INTO sms_send_log (phone, ip, device_id, ua, sent_at, result, metadata)
       VALUES (?, ?, ?, ?, ?, 'sms_api_error', ?)`,
    ).bind(body.phone, ip, deviceId, ua, now, JSON.stringify({ errCode: sendResult.errCode, errMsg: sendResult.errMsg })).run();
    return jsonErr('sms send failed', 502, { errCode: sendResult.errCode });
  }

  // 8. 落 success 行（含 hash + 过期时间）
  await env.DB.prepare(
    `INSERT INTO sms_send_log (phone, ip, device_id, ua, sent_at, result, code_hash, code_expires_at, metadata)
     VALUES (?, ?, ?, ?, ?, 'success', ?, ?, ?)`,
  ).bind(
    body.phone,
    ip,
    deviceId,
    ua,
    now,
    codeHash,
    expiresAt,
    JSON.stringify({ requestId: sendResult.requestId }),
  ).run();

  return jsonOk({ ok: true, ttl: 300 });
}

// ─── POST /api/auth/login ────────────────────────────────

interface LoginBody {
  identifier?: string;  // 新字段：phone 或 email（推荐）
  phone?: string;       // 老字段 fallback：仅 phone（hedge dashboard 缓存场景）
  code: string;
}

const SESSION_COOKIE_DEV_MARKER = 'localhost';  // 区分 dev/prod 环境

function isDevHost(req: Request): boolean {
  const h = req.headers.get('Host') || '';
  return h.includes(SESSION_COOKIE_DEV_MARKER) || h.includes('127.0.0.1');
}

const PHONE_REGEX_LOGIN = /^1[3-9]\d{9}$/;
const EMAIL_REGEX_LOGIN = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;
const SMS_HASH_SALT = 'xlist-sms-v1';
const EMAIL_HASH_SALT = 'xlist-email-v1';

export async function handleLogin(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const deviceId = request.headers.get('X-Device-Id');
  if (!deviceId || deviceId.length < 8 || deviceId.length > 64) {
    return jsonErr('missing or invalid X-Device-Id', 400);
  }

  let body: LoginBody;
  try {
    body = (await request.json()) as LoginBody;
  } catch {
    return jsonErr('invalid json', 400);
  }

  // identifier 兼容：优先 identifier，fallback 老 phone 字段
  const rawId = (body.identifier ?? body.phone ?? '').trim();
  if (!rawId) return jsonErr('missing identifier', 400);

  let provider: 'phone' | 'email';
  let identifier: string;
  if (PHONE_REGEX_LOGIN.test(rawId)) {
    provider = 'phone';
    identifier = rawId;
  } else if (EMAIL_REGEX_LOGIN.test(rawId.toLowerCase())) {
    provider = 'email';
    identifier = rawId.toLowerCase();
  } else {
    return jsonErr('invalid identifier', 400);
  }

  // Feature flag：备案前 phone 通道关闭
  if (provider === 'phone' && env.ENABLE_SMS_LOGIN !== 'true') {
    return jsonErr('sms login disabled', 403, { reason: 'sms_disabled' });
  }
  if (provider === 'email' && env.ENABLE_EMAIL_LOGIN === 'false') {
    return jsonErr('email login disabled', 403, { reason: 'email_disabled' });
  }

  if (typeof body.code !== 'string' || !/^\d{6}$/.test(body.code)) {
    return jsonErr('invalid code format', 400);
  }

  const ip = getClientIp(request);
  const ua = request.headers.get('User-Agent') || '';
  const now = Date.now();

  // 表名 + 列名 + salt 按 provider 切换
  // 注：logTable / idCol 均为常量字面量，非用户输入，无 SQL 注入风险
  const logTable = provider === 'phone' ? 'sms_send_log' : 'email_send_log';
  const idCol = provider === 'phone' ? 'phone' : 'email';
  const hashSalt = provider === 'phone' ? SMS_HASH_SALT : EMAIL_HASH_SALT;

  // 1. 找最新一条未消费的 success row
  const row = await env.DB.prepare(
    `SELECT id, code_hash, code_expires_at, code_attempts, sent_at
     FROM ${logTable}
     WHERE ${idCol} = ? AND result = 'success' AND code_used_at IS NULL
     ORDER BY sent_at DESC LIMIT 1`,
  ).bind(identifier).first<{
    id: number;
    code_hash: string;
    code_expires_at: number;
    code_attempts: number;
    sent_at: number;
  }>();

  if (!row) return jsonErr('no pending code', 401);
  if (row.code_expires_at < now) return jsonErr('code expired', 401);
  if (row.code_attempts >= 5) return jsonErr('too many attempts, locked', 429);

  // 2. 校验 code
  const inputHash = await hashCode(body.code, hashSalt);
  if (inputHash !== row.code_hash) {
    await env.DB.prepare(
      `UPDATE ${logTable} SET code_attempts = code_attempts + 1 WHERE id = ?`,
    ).bind(row.id).run();
    const remaining = 5 - (row.code_attempts + 1);
    return jsonErr('invalid code', 401, { attempts_remaining: Math.max(remaining, 0) });
  }

  // 3. mark used
  await env.DB.prepare(
    `UPDATE ${logTable} SET code_used_at = ? WHERE id = ?`,
  ).bind(now, row.id).run();

  // 4. 找/建 user（按 provider 查 identities）
  const ident = await env.DB.prepare(
    `SELECT user_id FROM identities
     WHERE provider = ? AND identity_value = ? AND unbound_at IS NULL`,
  ).bind(provider, identifier).first<{ user_id: string }>();

  let userId: string;
  let isNewUser = false;
  if (ident) {
    userId = ident.user_id;
    await env.DB.prepare(`UPDATE users SET last_active_at = ? WHERE id = ?`).bind(now, userId).run();
  } else {
    userId = nanoid(14);
    isNewUser = true;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (id, created_at, last_active_at, status) VALUES (?, ?, ?, 'active')`,
      ).bind(userId, now, now),
      env.DB.prepare(
        `INSERT INTO identities (user_id, provider, identity_value, verified_at) VALUES (?, ?, ?, ?)`,
      ).bind(userId, provider, identifier, now),
    ]);
  }

  // 5. 关联 device → 历史 events 行的 user_id
  ctx.waitUntil(
    env.DB.prepare(
      `UPDATE events SET user_id = ?
       WHERE device_id = ? AND user_id IS NULL AND occurred_at > ?`,
    ).bind(userId, deviceId, now - 30 * 24 * 3600_000).run(),
  );

  // 6. PR5 landing 回流
  ctx.waitUntil(
    env.DB.prepare(
      `UPDATE share_relations SET to_uid = ?, registered_at = ?
       WHERE to_did = ? AND to_uid IS NULL`,
    ).bind(userId, now, deviceId).run(),
  );

  // 7. 创建 session
  const session = await createSession(env, userId, deviceId, ip, ua);
  const cookie = buildSessionCookie(session.id, isDevHost(request));

  return jsonOk(
    {
      user: {
        id: userId,
        display_name: null,
        avatar_url: null,
        is_new: isNewUser,
      },
      session: {
        id: session.id,
        expires_at: session.expiresAt,
      },
    },
    { 'Set-Cookie': cookie },
  );
}

// ─── POST /api/auth/logout ───────────────────────────────

export async function handleLogout(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const auth = await authenticate(request, env, ctx);
  if (auth.kind !== 'authenticated') {
    return jsonErr('not authenticated', 401);
  }
  await revokeSession(env, auth.sessionId);
  return jsonOk({ ok: true }, { 'Set-Cookie': buildClearCookie(isDevHost(request)) });
}

// ─── POST /api/auth/logout-all ───────────────────────────

export async function handleLogoutAll(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const auth = await authenticate(request, env, ctx);
  if (auth.kind !== 'authenticated') {
    return jsonErr('not authenticated', 401);
  }
  const count = await revokeAllSessionsOfUser(env, auth.userId);
  return jsonOk({ ok: true, revoked: count }, { 'Set-Cookie': buildClearCookie(isDevHost(request)) });
}

// ─── GET /api/auth/me ────────────────────────────────────

export async function handleMe(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const auth = await authenticate(request, env, ctx);
  if (auth.kind !== 'authenticated') {
    return jsonErr('not authenticated', 401);
  }
  const user = await getUserById(env, auth.userId);
  if (!user) {
    return jsonErr('user not found', 404);
  }
  // 找当前主 identity（脱敏；优先按 verified_at DESC 取最近，跨 provider）
  const ident = await env.DB.prepare(
    `SELECT provider, identity_value FROM identities
     WHERE user_id = ? AND unbound_at IS NULL
     ORDER BY verified_at DESC LIMIT 1`,
  ).bind(auth.userId).first<{ provider: string; identity_value: string }>();

  let identityMasked: string | null = null;
  let identityProvider: string | null = null;
  if (ident) {
    identityProvider = ident.provider;
    if (ident.provider === 'phone') {
      identityMasked = `${ident.identity_value.slice(0, 3)}****${ident.identity_value.slice(-4)}`;
    } else if (ident.provider === 'email') {
      // 脱敏：abc@xx.com → a***@xx.com
      const [local, domain] = ident.identity_value.split('@');
      identityMasked = `${local[0]}***@${domain}`;
    }
  }

  return jsonOk({
    user: {
      id: user.id,
      display_name: user.display_name,
      avatar_url: user.avatar_url,
      created_at: user.created_at,
      identity_masked: identityMasked,
      identity_provider: identityProvider,
      // 老字段保留兼容（dashboard 全量切到 identity_masked 后下线）
      phone_masked: ident?.provider === 'phone' ? identityMasked : null,
    },
  });
}

// ─── POST /api/auth/delete ───────────────────────────────

interface DeleteBody {
  phone_confirm?: string;
  confirm?: string;
}

const DELETE_HASH_SALT = 'xlist-deleted-v1';

export async function handleDelete(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const auth = await authenticate(request, env, ctx);
  if (auth.kind !== 'authenticated') {
    return jsonErr('not authenticated', 401);
  }

  let body: DeleteBody;
  try {
    body = (await request.json()) as DeleteBody;
  } catch {
    return jsonErr('invalid json', 400);
  }

  // 找当前主 identity（任意 provider，按最近验证）
  const ident = await env.DB.prepare(
    `SELECT id, provider, identity_value FROM identities
     WHERE user_id = ? AND unbound_at IS NULL
     ORDER BY verified_at DESC LIMIT 1`,
  ).bind(auth.userId).first<{ id: number; provider: string; identity_value: string }>();

  if (!ident) {
    return jsonErr('no identity found', 404);
  }

  // body 字段历史叫 phone_confirm，扩展为通用 confirm（保留 phone_confirm fallback）
  const confirm = body.confirm ?? body.phone_confirm;
  if (typeof confirm !== 'string' || confirm !== ident.identity_value) {
    return jsonErr('identity confirm mismatch', 400);
  }

  const now = Date.now();
  const hashedPhone = await hashCode(ident.identity_value, DELETE_HASH_SALT);

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE users SET display_name = NULL, avatar_url = NULL, status = 'self_deleted' WHERE id = ?`,
    ).bind(auth.userId),
    env.DB.prepare(
      `UPDATE identities SET identity_value = ?, unbound_at = ? WHERE id = ?`,
    ).bind(hashedPhone, now, ident.id),
    env.DB.prepare(
      `UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`,
    ).bind(now, auth.userId),
  ]);

  return jsonOk(
    { ok: true },
    { 'Set-Cookie': buildClearCookie(isDevHost(request)) },
  );
}
