// 订阅推送共享工具:BJT 时间换算、slot_key、next_send_at、退订/回流 token。
// 设计文档:roxor-main-design-20260528-090625.md

import { nanoid } from 'nanoid';
import type { Env } from '../index';

const BJT_OFFSET_MS = 8 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

// 给定 UTC ms 的 BJT 墙钟日期 'YYYY-MM-DD'(把时间轴前移 8h 后取 UTC 日期部分)。
export function bjtDateStr(ts: number = Date.now()): string {
  return new Date(ts + BJT_OFFSET_MS).toISOString().slice(0, 10);
}

// slot_key = 'YYYY-MM-DD-HH'(BJT 日期 + 节点小时)。digest_pool / digest_send_log 的维度键。
export function slotKey(slotHourBjt: number, ts: number = Date.now()): string {
  return `${bjtDateStr(ts)}-${String(slotHourBjt).padStart(2, '0')}`;
}

// 给定 BJT 节点小时,算"下一次该节点"的 UTC ms(用于 next_send_at)。
// 今天该节点已过 → 取明天该节点。
export function nextSendAt(slotHourBjt: number, from: number = Date.now()): number {
  const utcHour = (slotHourBjt - 8 + 24) % 24;
  const d = new Date(from);
  const candidate = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), utcHour, 0, 0, 0);
  return candidate > from ? candidate : candidate + DAY_MS;
}

// 退订 token:随机串,存 subscriptions.unsubscribe_token,退订链接靠它定位(无需 HMAC)。
export function genUnsubscribeToken(): string {
  return nanoid(32);
}

// ── 邮件回流 HMAC token ──
// token = base64url(`email:subId:nonce`) + '.' + hmac16hex
// 点邮件 link 即证明邮箱所有权 → 隐式注册登录。secret = DIGEST_EMAIL_HMAC。

function b64urlEncode(s: string): string {
  return btoa(unescape(encodeURIComponent(s)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad)));
}

async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function genEmailToken(env: Env, email: string, subId: number): Promise<string | null> {
  if (!env.DIGEST_EMAIL_HMAC) return null;
  const payload = `${email}:${subId}:${nanoid(8)}`;
  const sig = (await hmacHex(env.DIGEST_EMAIL_HMAC, payload)).slice(0, 32); // 16 bytes
  return `${b64urlEncode(payload)}.${sig}`;
}

export async function verifyEmailToken(
  env: Env,
  token: string,
): Promise<{ email: string; subId: number } | null> {
  if (!env.DIGEST_EMAIL_HMAC) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  let payload: string;
  try {
    payload = b64urlDecode(token.slice(0, dot));
  } catch {
    return null;
  }
  const sig = token.slice(dot + 1);
  const expected = (await hmacHex(env.DIGEST_EMAIL_HMAC, payload)).slice(0, 32);
  // 常数时间比较
  if (sig.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return null;
  const parts = payload.split(':');
  if (parts.length !== 3) return null;
  const subId = parseInt(parts[1], 10);
  if (!Number.isFinite(subId)) return null;
  return { email: parts[0], subId };
}
