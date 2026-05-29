// 订阅推送 HTTP 接口:匿名订阅 / 登录态管理(读改退)/ RFC8058 一键退订。
// 回流隐式注册(/api/digest/return)+ Resend webhook 见 return-webhook.ts。
// 契约:设计文档「API 契约(FE ↔ BE 对齐)」节。

import type { Env } from '../index';
import { verifyTurnstile } from '../auth/turnstile';
import { EMAIL_REGEX, normalizeEmail } from '../auth/email-validation';
import { authenticate } from '../auth/session';
import { sendEmail } from '../auth/resend';
import {
  isValidSlot,
  isValidDensity,
  isValidSources,
  normalizeSources,
  type DigestSource,
  type Density,
} from './config';
import { genUnsubscribeToken, nextSendAt, genEmailToken, genEditToken, verifyEditToken } from './lib';
import { buildWelcomeEmail } from './templates';

const JSON_H = { 'Content-Type': 'application/json' };
const SITE = 'https://ai-feeds.com';
const REPLY_TO = 'support@mail.ai-feeds.com';

function jsonResp(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_H });
}
function jok(data: Record<string, unknown> = {}): Response {
  return jsonResp({ ok: true, ...data });
}
function jerr(code: string, status = 400): Response {
  return jsonResp({ ok: false, code }, status);
}
function clientIp(req: Request): string {
  return req.headers.get('CF-Connecting-IP') || req.headers.get('X-Forwarded-For') || '0.0.0.0';
}

// 该 user 绑定的 email(用于登录态关联订阅;订阅表以 email 为稳定键,user_id 后填)
async function getUserEmail(env: Env, userId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT identity_value FROM identities
     WHERE user_id = ? AND provider = 'email' AND unbound_at IS NULL LIMIT 1`,
  )
    .bind(userId)
    .first<{ identity_value: string }>();
  return row?.identity_value ?? null;
}

// 防刷二道防线(Turnstile 之后):同 IP 1h ≤ 10 次订阅请求。
async function checkSubscribeRateLimit(env: Env, ip: string): Promise<boolean> {
  const key = `sub_rl:${ip}`;
  const cur = parseInt((await env.AUTH_KV.get(key)) || '0', 10);
  if (cur >= 10) return false;
  await env.AUTH_KV.put(key, String(cur + 1), { expirationTtl: 3600 });
  return true;
}

function unsubscribeUrl(token: string): string {
  return `${SITE}/unsubscribe?token=${encodeURIComponent(token)}`;
}
function listUnsubHeaders(token: string): Record<string, string> {
  return {
    'List-Unsubscribe': `<${unsubscribeUrl(token)}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

async function sendWelcome(
  env: Env,
  email: string,
  subId: number,
  unsubToken: string,
  sources: DigestSource[],
  slotBjt: number,
  density: Density,
): Promise<void> {
  const token = await genEmailToken(env, email, subId);
  const confirmUrl = token ? `${SITE}/api/digest/return?u=${encodeURIComponent(token)}` : null;
  const mail = buildWelcomeEmail({
    sources,
    slotBjt,
    density,
    confirmUrl,
    unsubscribeUrl: unsubscribeUrl(unsubToken),
  });
  const res = await sendEmail(env, {
    to: email,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    headers: listUnsubHeaders(unsubToken),
    replyTo: REPLY_TO,
  });
  await env.DB.prepare(
    `INSERT INTO digest_send_log (subscription_id, slot_key, sent_at, items_count, status, resend_message_id, error_message)
     VALUES (?, 'welcome', ?, 0, 'welcome', ?, ?)`,
  )
    .bind(subId, Date.now(), res.ok ? res.id || null : null, res.ok ? null : res.errMsg || res.errCode || 'send_fail')
    .run();
}

async function sendReSubscribeConfirm(env: Env, email: string, subId: number): Promise<void> {
  const token = await genEmailToken(env, email, subId);
  const confirmUrl = token
    ? `${SITE}/api/digest/return?u=${encodeURIComponent(token)}&action=resubscribe`
    : SITE;
  const text = [
    '你正在重新订阅 AI Feeds 每日精选。',
    '',
    `点击确认订阅:${confirmUrl}`,
    '',
    '如果不是你本人操作,忽略此邮件即可,我们不会向你推送。',
    '',
    'AI Feeds · https://ai-feeds.com',
  ].join('\n');
  await sendEmail(env, { to: email, subject: '确认重新订阅 AI Feeds', text, replyTo: REPLY_TO });
}

// ── POST /api/subscribe(匿名 + Turnstile)──
interface SubscribeBody {
  email?: unknown;
  sources?: unknown;
  send_slot?: unknown;
  density?: unknown;
  turnstile_token?: unknown;
}

export async function handleSubscribe(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  let body: SubscribeBody;
  try {
    body = (await request.json()) as SubscribeBody;
  } catch {
    return jerr('invalid_email');
  }

  if (typeof body.email !== 'string') return jerr('invalid_email');
  const email = normalizeEmail(body.email);
  if (!EMAIL_REGEX.test(email)) return jerr('invalid_email');
  if (!isValidSources(body.sources)) return jerr('invalid_sources');
  if (!isValidSlot(body.send_slot)) return jerr('invalid_slot');

  const ip = clientIp(request);
  const tsOk = await verifyTurnstile(env, typeof body.turnstile_token === 'string' ? body.turnstile_token : null, ip);
  if (!tsOk) return jerr('turnstile_failed', 403);

  if (!(await checkSubscribeRateLimit(env, ip))) return jerr('rate_limited', 429);

  const sources = normalizeSources(body.sources);
  const density: Density = isValidDensity(body.density) ? body.density : 'normal';
  const slot = body.send_slot;
  const now = Date.now();

  const existing = await env.DB.prepare(
    `SELECT id, status FROM subscriptions WHERE email = ? AND channel = 'email'`,
  )
    .bind(email)
    .first<{ id: number; status: string }>();

  try {
    if (existing) {
      if (existing.status === 'unsubscribed') {
        // 重订阅:预存偏好但不激活,发确认邮件(点击回流 → 激活 + 隐式登录)
        await env.DB.prepare(
          `UPDATE subscriptions SET sources = ?, send_slot = ?, density = ?, updated_at = ? WHERE id = ?`,
        )
          .bind(JSON.stringify(sources), slot, density, now, existing.id)
          .run();
        ctx.waitUntil(sendReSubscribeConfirm(env, email, existing.id));
        return jok({ status: 'pending_confirm' });
      }
      // active / kicked / paused → 改偏好 / 恢复,清零计数,不重发 welcome
      await env.DB.prepare(
        `UPDATE subscriptions
         SET sources = ?, send_slot = ?, density = ?, status = 'active',
             next_send_at = ?, bounce_count = 0, worker_send_failures = 0, updated_at = ?
         WHERE id = ?`,
      )
        .bind(JSON.stringify(sources), slot, density, nextSendAt(slot, now), now, existing.id)
        .run();
      const editToken = await genEditToken(env, existing.id);
      return jok({ status: 'active', edit_token: editToken || undefined });
    }

    // 全新订阅
    const unsubToken = genUnsubscribeToken();
    const r = await env.DB.prepare(
      `INSERT INTO subscriptions
         (email, channel, sources, send_slot, density, status, next_send_at,
          bounce_count, worker_send_failures, unsubscribe_token, created_at, updated_at)
       VALUES (?, 'email', ?, ?, ?, 'active', ?, 0, 0, ?, ?, ?)`,
    )
      .bind(email, JSON.stringify(sources), slot, density, nextSendAt(slot, now), unsubToken, now, now)
      .run();
    const subId = Number(r.meta.last_row_id);
    ctx.waitUntil(sendWelcome(env, email, subId, unsubToken, sources, slot, density));
    const editToken = await genEditToken(env, subId);
    return jok({ status: 'active', edit_token: editToken || undefined });
  } catch (e) {
    console.error('[digest/subscribe] error', e);
    return jerr('server_error', 500);
  }
}

// ── GET /api/auth/me/subscription ──
export async function handleGetMySubscription(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const auth = await authenticate(request, env, ctx);
  if (auth.kind !== 'authenticated') return jsonResp({ error: 'unauthorized' }, 401);
  const email = await getUserEmail(env, auth.userId);
  if (!email) return jsonResp({ subscription: null });

  const sub = await env.DB.prepare(
    `SELECT email, sources, send_slot, density, status
     FROM subscriptions WHERE email = ? AND channel = 'email' LIMIT 1`,
  )
    .bind(email)
    .first<{ email: string; sources: string; send_slot: number; density: string; status: string }>();
  if (!sub) return jsonResp({ subscription: null });

  // 关联回填 user_id(异步,不阻塞)
  ctx.waitUntil(
    env.DB.prepare(
      `UPDATE subscriptions SET user_id = COALESCE(user_id, ?) WHERE email = ? AND channel = 'email'`,
    )
      .bind(auth.userId, email)
      .run(),
  );

  return jsonResp({
    subscription: {
      email: sub.email,
      sources: JSON.parse(sub.sources),
      send_slot: sub.send_slot,
      density: sub.density,
      status: sub.status === 'paused' ? 'active' : sub.status, // paused 对外归一
    },
  });
}

// ── PUT /api/auth/me/subscription ──
export async function handlePutMySubscription(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const auth = await authenticate(request, env, ctx);
  if (auth.kind !== 'authenticated') return jerr('unauthorized', 401);
  const email = await getUserEmail(env, auth.userId);
  if (!email) return jerr('not_subscribed', 404);

  let body: SubscribeBody;
  try {
    body = (await request.json()) as SubscribeBody;
  } catch {
    return jerr('invalid_sources');
  }
  if (!isValidSources(body.sources)) return jerr('invalid_sources');
  if (!isValidSlot(body.send_slot)) return jerr('invalid_slot');
  const sources = normalizeSources(body.sources);
  const density: Density = isValidDensity(body.density) ? body.density : 'normal';
  const slot = body.send_slot;

  const r = await env.DB.prepare(
    `UPDATE subscriptions
     SET sources = ?, send_slot = ?, density = ?, next_send_at = ?, updated_at = ?,
         user_id = COALESCE(user_id, ?)
     WHERE email = ? AND channel = 'email'`,
  )
    .bind(JSON.stringify(sources), slot, density, nextSendAt(slot), Date.now(), auth.userId, email)
    .run();
  if ((r.meta.changes ?? 0) === 0) return jerr('not_subscribed', 404);
  return jok();
}

// ── POST /api/auth/me/subscription/unsubscribe(站内退订)──
export async function handleUnsubMySubscription(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const auth = await authenticate(request, env, ctx);
  if (auth.kind !== 'authenticated') return jerr('unauthorized', 401);
  const email = await getUserEmail(env, auth.userId);
  if (!email) return jerr('not_subscribed', 404);
  await env.DB.prepare(
    `UPDATE subscriptions SET status = 'unsubscribed', updated_at = ? WHERE email = ? AND channel = 'email'`,
  )
    .bind(Date.now(), email)
    .run();
  return jok();
}

// ── GET/POST /unsubscribe?token=（RFC 8058 一键退订；GET=用户点链接，POST=邮件客户端 One-Click）──
export async function handleUnsubscribeByToken(request: Request, env: Env): Promise<Response> {
  const token = new URL(request.url).searchParams.get('token');
  if (token) {
    // 幂等:找不到 token 也不报错(不暴露 token 有效性)
    await env.DB.prepare(
      `UPDATE subscriptions SET status = 'unsubscribed', updated_at = ?
       WHERE unsubscribe_token = ? AND status != 'unsubscribed'`,
    )
      .bind(Date.now(), token)
      .run();
  }
  if (request.method === 'POST') {
    return jsonResp({ ok: true });
  }
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>已退订</title></head>
<body style="font-family:-apple-system,sans-serif;background:#f6f7f9;margin:0;padding:48px 16px;text-align:center;color:#1a1a1a;">
<div style="max-width:420px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:32px 24px;">
<div style="font-size:20px;font-weight:700;">已退订</div>
<p style="font-size:14px;color:#6b7280;line-height:1.7;margin:14px 0 0;">你将不再收到 AI Feeds 的邮件推送。改主意了？随时可以重新订阅。</p>
<a href="${SITE}" style="display:inline-block;margin-top:18px;color:#2563eb;text-decoration:none;font-size:14px;">回到 AI Feeds →</a>
</div></body></html>`;
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ── POST /api/subscribe/configure(两步订阅第二页;无 turnstile/session,凭 edit_token)──
export async function handleConfigure(request: Request, env: Env): Promise<Response> {
  let body: SubscribeBody & { edit_token?: unknown };
  try {
    body = (await request.json()) as SubscribeBody & { edit_token?: unknown };
  } catch {
    return jerr('invalid_token', 401);
  }
  if (typeof body.edit_token !== 'string') return jerr('invalid_token', 401);
  const v = await verifyEditToken(env, body.edit_token);
  if (v === null) return jerr('invalid_token', 401);
  if (v === 'expired') return jerr('expired_token', 401);

  if (!isValidSources(body.sources)) return jerr('invalid_sources');
  if (!isValidSlot(body.send_slot)) return jerr('invalid_slot');
  const sources = normalizeSources(body.sources);
  const density: Density = isValidDensity(body.density) ? body.density : 'normal';

  const r = await env.DB.prepare(
    `UPDATE subscriptions SET sources = ?, send_slot = ?, density = ?, next_send_at = ?, updated_at = ?
     WHERE id = ? AND status IN ('active','paused')`,
  )
    .bind(JSON.stringify(sources), body.send_slot, density, nextSendAt(body.send_slot), Date.now(), v.subId)
    .run();
  if ((r.meta.changes ?? 0) === 0) return jerr('invalid_token', 404);
  return jok();
}
