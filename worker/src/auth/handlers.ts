// PR2 auth endpoint handlers
// 设计参考：docs/plans/2026-05-01-auth-system-design.md § 9 + § 6

import type { Env } from '../index';
import { verifyTurnstile } from './turnstile';
import {
  checkRateLimits,
  checkAndIncrDailyCap,
  checkDailyCapAlerts,
  generateCode,
  hashCode,
  sendSmsViaTencent,
} from './sms';
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
