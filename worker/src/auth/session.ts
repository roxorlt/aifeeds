// PR2 session 创建/校验/撤销 + cookie 工具
// 设计参考：docs/plans/2026-05-01-auth-system-design.md § 4

import { nanoid } from 'nanoid';
import type { Env } from '../index';
import type { AuthContext, SessionRow, UserRow } from './types';

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;  // 30 天
const COOKIE_NAME = 'xlist_sid';

export async function createSession(
  env: Env,
  userId: string,
  deviceId: string | null,
  ip: string,
  ua: string,
): Promise<{ id: string; expiresAt: number }> {
  const sid = nanoid(32);
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, device_id, ip, ua, created_at, last_used_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(sid, userId, deviceId, ip, ua, now, now, expiresAt).run();
  return { id: sid, expiresAt };
}

/** 查活跃 session（未过期 + 未撤销 + user.status='active'）+ 滑动续期 last_used_at */
export async function findActiveSession(env: Env, sid: string): Promise<SessionRow | null> {
  const row = await env.DB.prepare(
    `SELECT s.* FROM sessions s
     JOIN users u ON s.user_id = u.id
     WHERE s.id = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND u.status = 'active'`,
  ).bind(sid, Date.now()).first<SessionRow>();
  if (!row) return null;
  // 滑动续期（异步不阻塞响应；调用方用 ctx.waitUntil 包装）
  return row;
}

export async function touchSessionLastUsed(env: Env, sid: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE sessions SET last_used_at = ? WHERE id = ?`,
  ).bind(Date.now(), sid).run();
}

export async function revokeSession(env: Env, sid: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`,
  ).bind(Date.now(), sid).run();
}

export async function revokeAllSessionsOfUser(env: Env, userId: string): Promise<number> {
  const r = await env.DB.prepare(
    `UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`,
  ).bind(Date.now(), userId).run();
  return r.meta.changes ?? 0;
}

/** 从请求拿 session_id（优先 Authorization Bearer，再 Cookie） */
export function getSidFromRequest(req: Request): string | null {
  const auth = req.headers.get('Authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  const cookie = req.headers.get('Cookie') || '';
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

/** 生成 Set-Cookie header 值。生产用 .ai-feeds.com 顶域（共享子域），dev 用 host-only */
export function buildSessionCookie(sid: string, isDev: boolean): string {
  const maxAge = SESSION_TTL_MS / 1000;
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(sid)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (!isDev) {
    parts.push('Secure', 'Domain=.ai-feeds.com');
  }
  return parts.join('; ');
}

export function buildClearCookie(isDev: boolean): string {
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (!isDev) {
    parts.push('Secure', 'Domain=.ai-feeds.com');
  }
  return parts.join('; ');
}

/** 鉴权中间件：拿 session_id → 查表 → 异步续期 */
export async function authenticate(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<AuthContext> {
  const sid = getSidFromRequest(req);
  if (!sid) return { kind: 'anonymous' };
  const session = await findActiveSession(env, sid);
  if (!session) return { kind: 'anonymous' };
  // 滑动续期（fire-and-forget）
  ctx.waitUntil(touchSessionLastUsed(env, sid));
  return { kind: 'authenticated', userId: session.user_id, sessionId: sid };
}

/** 取当前 user 行（含 status） */
export async function getUserById(env: Env, userId: string): Promise<UserRow | null> {
  return await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(userId).first<UserRow>();
}
