// 邮件回流隐式注册登录(/api/digest/return)+ Resend webhook(/api/webhook/resend)。
// 设计文档:roxor-main-design-20260528-090625.md

import { nanoid } from 'nanoid';
import type { Env } from '../index';
import { verifyEmailToken, nextSendAt } from './lib';
import { createSession, buildSessionCookie } from '../auth/session';
import { deriveDisplayName, deriveAvatarUrl, isDevHost } from '../auth/handlers';
import { pushDeerAlert } from '../notifier';

const SITE = 'https://ai-feeds.com';

function clientIp(req: Request): string {
  return req.headers.get('CF-Connecting-IP') || req.headers.get('X-Forwarded-For') || '0.0.0.0';
}

// 查/建 email user,返回 userId。复用登录端同款 derive 逻辑(头像/显示名风格一致)。
async function findOrCreateEmailUser(env: Env, email: string, now: number): Promise<string> {
  const ident = await env.DB.prepare(
    `SELECT user_id FROM identities WHERE provider = 'email' AND identity_value = ? AND unbound_at IS NULL LIMIT 1`,
  )
    .bind(email)
    .first<{ user_id: string }>();
  if (ident) {
    await env.DB.prepare(`UPDATE users SET last_active_at = ? WHERE id = ?`).bind(now, ident.user_id).run();
    return ident.user_id;
  }
  const userId = nanoid(14);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, display_name, avatar_url, created_at, last_active_at, status)
       VALUES (?, ?, ?, ?, ?, 'active')`,
    ).bind(userId, deriveDisplayName('email', email), deriveAvatarUrl(userId), now, now),
    env.DB.prepare(
      `INSERT INTO identities (user_id, provider, identity_value, verified_at) VALUES (?, 'email', ?, ?)`,
    ).bind(userId, email, now),
  ]);
  return userId;
}

// ── GET /api/digest/return?u=<email_token>&action=<resubscribe?> ──
// 点邮件 link 即证明邮箱所有权 → 隐式注册登录 + 302 落地首页。
export async function handleDigestReturn(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get('u');
  const action = url.searchParams.get('action');
  const dest = `${SITE}/`;

  const verified = token ? await verifyEmailToken(env, token) : null;
  if (!verified) {
    // 校验失败也落地(不报错、不泄露 token 有效性)
    return new Response(null, { status: 302, headers: { Location: dest } });
  }
  const { email, subId } = verified;
  const now = Date.now();

  // resubscribe:确认邮件回流 → 激活订阅
  if (action === 'resubscribe') {
    const sub = await env.DB.prepare(
      `SELECT send_slot FROM subscriptions WHERE id = ? AND email = ?`,
    )
      .bind(subId, email)
      .first<{ send_slot: number }>();
    if (sub) {
      await env.DB.prepare(
        `UPDATE subscriptions
         SET status = 'active', next_send_at = ?, bounce_count = 0, worker_send_failures = 0, updated_at = ?
         WHERE id = ? AND email = ?`,
      )
        .bind(nextSendAt(sub.send_slot, now), now, subId, email)
        .run();
    }
  }

  // 隐式注册登录
  const userId = await findOrCreateEmailUser(env, email, now);
  ctx.waitUntil(
    env.DB.prepare(
      `UPDATE subscriptions SET user_id = COALESCE(user_id, ?) WHERE email = ? AND channel = 'email'`,
    )
      .bind(userId, email)
      .run(),
  );

  const session = await createSession(env, userId, null, clientIp(request), request.headers.get('User-Agent') || '');
  const cookie = buildSessionCookie(session.id, isDevHost(request));
  return new Response(null, { status: 302, headers: { Location: dest, 'Set-Cookie': cookie } });
}

// ── Svix(Resend)webhook 签名校验 ──

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function verifySvixSignature(env: Env, request: Request, body: string): Promise<boolean> {
  const secret = env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('[resend-webhook] no RESEND_WEBHOOK_SECRET, bypass (dev only)');
    return true;
  }
  const svixId = request.headers.get('svix-id');
  const svixTs = request.headers.get('svix-timestamp');
  const svixSig = request.headers.get('svix-signature');
  if (!svixId || !svixTs || !svixSig) return false;

  // 时间戳防重放(±5min)
  const ts = parseInt(svixTs, 10);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;

  const signedContent = `${svixId}.${svixTs}.${body}`;
  const keyBytes = base64ToBytes(secret.startsWith('whsec_') ? secret.slice(6) : secret);
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedContent));
  const expected = bytesToBase64(new Uint8Array(sigBuf));

  // svix-signature: 空格分隔多个 "v1,<base64sig>"
  const provided = svixSig.split(' ').map((s) => (s.includes(',') ? s.split(',')[1] : s));
  return provided.some((s) => timingSafeEqual(s, expected));
}

// ── POST /api/webhook/resend ──
interface ResendWebhookEvent {
  type?: string;
  data?: { to?: string[]; email?: string };
}

export async function handleResendWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = await request.text();
  if (!(await verifySvixSignature(env, request, body))) {
    return new Response('invalid signature', { status: 401 });
  }
  let evt: ResendWebhookEvent;
  try {
    evt = JSON.parse(body) as ResendWebhookEvent;
  } catch {
    return new Response('bad json', { status: 400 });
  }
  const email = evt.data?.to?.[0] || evt.data?.email;
  if (!email || !evt.type) return new Response('ok', { status: 200 });
  const now = Date.now();

  if (evt.type === 'email.bounced' || evt.type === 'email.complained') {
    await env.DB.prepare(
      `UPDATE subscriptions
       SET bounce_count = bounce_count + 1,
           status = CASE WHEN bounce_count + 1 >= 2 AND status != 'unsubscribed' THEN 'kicked' ELSE status END,
           updated_at = ?
       WHERE email = ? AND channel = 'email'`,
    )
      .bind(now, email)
      .run();
    const row = await env.DB.prepare(
      `SELECT status, bounce_count FROM subscriptions WHERE email = ? AND channel = 'email'`,
    )
      .bind(email)
      .first<{ status: string; bounce_count: number }>();
    if (row?.status === 'kicked') {
      ctx.waitUntil(
        pushDeerAlert(env, '订阅自动踢出', `email=${email} 投递 ${evt.type}(bounce_count=${row.bounce_count})已踢出订阅。`),
      );
    }
  } else if (evt.type === 'email.delivered') {
    await env.DB.prepare(
      `UPDATE subscriptions SET bounce_count = 0 WHERE email = ? AND channel = 'email' AND bounce_count > 0`,
    )
      .bind(email)
      .run();
  }
  return new Response('ok', { status: 200 });
}
