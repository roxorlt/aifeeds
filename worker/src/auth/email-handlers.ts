// PR-EmailAuth：/api/auth/email/send handler
// 设计参考：docs/plans/2026-05-06-email-auth-design.md § 4.2

import type { Env } from '../index';
import { getClientIp } from '../client-ip';
import { verifyTurnstile } from './turnstile';
import {
  EMAIL_REGEX,
  normalizeEmail,
  emailDomain,
  isDisposableDomain,
  checkMxRecord,
} from './email-validation';
import { checkEmailRateLimits } from './email-rate-limit';
import {
  checkAndIncrEmailDailyCap,
  checkAndIncrEmailMonthlyCap,
  checkEmailDailyCapAlerts,
  checkEmailMonthlyCapAlerts,
} from './email-cap';
import { sendEmailViaResend } from './resend';
import { generateCode, hashCode } from './sms';  // 复用 SMS 端的纯函数
import { pushDeerAlert } from '../notifier';

const CODE_HASH_SALT = 'xlist-email-v1';

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

interface EmailSendBody {
  email: string;
  turnstile_token: string;
}

const RL_SEVERE = ['email_24h_limit', 'email_locked_30min', 'ip_24h_total_limit'];

export async function handleEmailSend(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // 0. 全局 flag
  if (env.ENABLE_EMAIL_LOGIN === 'false') {
    return jsonErr('email login disabled', 503);
  }

  // 1. device_id + email 字段校验
  const deviceId = request.headers.get('X-Device-Id');
  if (!deviceId || deviceId.length < 8 || deviceId.length > 64) {
    return jsonErr('missing or invalid X-Device-Id', 400);
  }

  let body: EmailSendBody;
  try {
    body = (await request.json()) as EmailSendBody;
  } catch {
    return jsonErr('invalid json', 400);
  }

  if (typeof body.email !== 'string') return jsonErr('invalid email', 400);
  const email = normalizeEmail(body.email);
  if (!EMAIL_REGEX.test(email)) return jsonErr('invalid email', 400);

  const ip = getClientIp(request, env);
  const ua = request.headers.get('User-Agent') || '';
  const now = Date.now();

  // 2. Turnstile
  const tsOk = await verifyTurnstile(env, body.turnstile_token || null, ip);
  if (!tsOk) {
    await env.DB.prepare(
      `INSERT INTO email_send_log (email, ip, device_id, ua, sent_at, result)
       VALUES (?, ?, ?, ?, ?, 'turnstile_failed')`,
    ).bind(email, ip, deviceId, ua, now).run();
    return jsonErr('captcha failed', 403);
  }

  // 3. disposable
  const domain = emailDomain(email);
  if (isDisposableDomain(domain)) {
    await env.DB.prepare(
      `INSERT INTO email_send_log (email, ip, device_id, ua, sent_at, result)
       VALUES (?, ?, ?, ?, ?, 'disposable_blocked')`,
    ).bind(email, ip, deviceId, ua, now).run();
    return jsonErr('please use a real email', 400, { reason: 'disposable_blocked' });
  }

  // 4. MX 预校验
  const mxOk = await checkMxRecord(env, domain);
  if (!mxOk) {
    await env.DB.prepare(
      `INSERT INTO email_send_log (email, ip, device_id, ua, sent_at, result)
       VALUES (?, ?, ?, ?, ?, 'mx_failed')`,
    ).bind(email, ip, deviceId, ua, now).run();
    return jsonErr('email domain has no mx record', 400, { reason: 'mx_failed' });
  }

  // 5. 6 维度限流
  const rl = await checkEmailRateLimits(env, email, ip, deviceId);
  if (!rl.ok) {
    await env.DB.prepare(
      `INSERT INTO email_send_log (email, ip, device_id, ua, sent_at, result, metadata)
       VALUES (?, ?, ?, ?, ?, 'rate_limited', ?)`,
    ).bind(email, ip, deviceId, ua, now, JSON.stringify({ reason: rl.reason })).run();
    if (rl.reason && RL_SEVERE.includes(rl.reason)) {
      ctx.waitUntil(
        pushDeerAlert(env, '风控命中(email)', `email=${email} ip=${ip} reason=${rl.reason}`),
      );
    }
    return jsonErr('rate limited', 429, { reason: rl.reason });
  }

  // 6. 日度 cap（先做，阈值更紧）
  const dayCap = await checkAndIncrEmailDailyCap(env);
  if (!dayCap.ok) {
    await env.DB.prepare(
      `INSERT INTO email_send_log (email, ip, device_id, ua, sent_at, result, metadata)
       VALUES (?, ?, ?, ?, ?, 'budget_capped', ?)`,
    ).bind(email, ip, deviceId, ua, now, JSON.stringify({ scope: 'daily', sent: dayCap.sent, cap: dayCap.cap })).run();
    ctx.waitUntil(
      pushDeerAlert(env, 'Email 当日额度耗尽', `今日发送 ${dayCap.sent}/${dayCap.cap}（cap=0 = kill switch）。后续请求 503 直到明日 0 点 UTC 重置。`),
    );
    return jsonErr('service unavailable', 503);
  }

  // 7. 月度 cap
  const monthCap = await checkAndIncrEmailMonthlyCap(env);
  if (!monthCap.ok) {
    await env.DB.prepare(
      `INSERT INTO email_send_log (email, ip, device_id, ua, sent_at, result, metadata)
       VALUES (?, ?, ?, ?, ?, 'budget_capped', ?)`,
    ).bind(email, ip, deviceId, ua, now, JSON.stringify({ scope: 'monthly', sent: monthCap.sent, cap: monthCap.cap })).run();
    ctx.waitUntil(
      pushDeerAlert(env, 'Email 当月额度耗尽', `本月发送 ${monthCap.sent}/${monthCap.cap}。需立即升级 Resend 付费档或调整 cap。`),
    );
    return jsonErr('service unavailable', 503);
  }

  // 8. 跨阈值告警
  ctx.waitUntil(checkEmailDailyCapAlerts(env, dayCap.sent, dayCap.cap));
  ctx.waitUntil(checkEmailMonthlyCapAlerts(env, monthCap.sent, monthCap.cap));

  // 9. 生成 + hash + 发邮件
  const code = generateCode();
  const codeHash = await hashCode(code, CODE_HASH_SALT);
  const expiresAt = now + 5 * 60_000;

  const sendResult = await sendEmailViaResend(env, email, code);
  if (!sendResult.ok) {
    await env.DB.prepare(
      `INSERT INTO email_send_log (email, ip, device_id, ua, sent_at, result, metadata)
       VALUES (?, ?, ?, ?, ?, 'resend_api_error', ?)`,
    ).bind(email, ip, deviceId, ua, now, JSON.stringify({ errCode: sendResult.errCode, errMsg: sendResult.errMsg })).run();
    return jsonErr('email send failed', 502, { errCode: sendResult.errCode });
  }

  // 10. 落 success row
  await env.DB.prepare(
    `INSERT INTO email_send_log (email, ip, device_id, ua, sent_at, result, code_hash, code_expires_at, metadata)
     VALUES (?, ?, ?, ?, ?, 'success', ?, ?, ?)`,
  ).bind(
    email, ip, deviceId, ua, now, codeHash, expiresAt,
    JSON.stringify({ resendId: sendResult.id }),
  ).run();

  return jsonOk({ ok: true, ttl: 300 });
}
