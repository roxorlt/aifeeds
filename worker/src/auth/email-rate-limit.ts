// PR-EmailAuth：email 6 维度限流
// 设计参考：docs/plans/2026-05-06-email-auth-design.md § 5.3
// 与 sms.ts checkRateLimits 同结构，identifier 字段从 phone 改为 email

import type { Env } from '../index';
import type { EmailRateLimitResult } from './types';

const LOCK_DURATION_MS = 30 * 60 * 1000;
const MAX_ATTEMPTS_BEFORE_LOCK = 5;

export async function checkEmailRateLimits(
  env: Env,
  email: string,
  ip: string,
  deviceId: string | null,
): Promise<EmailRateLimitResult> {
  const now = Date.now();
  const ago = (ms: number) => now - ms;

  // email 60s
  const r1 = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM email_send_log WHERE email = ? AND result = 'success' AND sent_at > ?`,
  ).bind(email, ago(60_000)).first<{ n: number }>();
  if ((r1?.n ?? 0) >= 1) return { ok: false, reason: 'email_60s_limit' };

  // email 5min
  const r2 = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM email_send_log WHERE email = ? AND result = 'success' AND sent_at > ?`,
  ).bind(email, ago(5 * 60_000)).first<{ n: number }>();
  if ((r2?.n ?? 0) >= 3) return { ok: false, reason: 'email_5min_limit' };

  // email 24h
  const r3 = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM email_send_log WHERE email = ? AND result = 'success' AND sent_at > ?`,
  ).bind(email, ago(24 * 3600_000)).first<{ n: number }>();
  if ((r3?.n ?? 0) >= 10) return { ok: false, reason: 'email_24h_limit' };

  // ip 1h unique emails
  const r4 = await env.DB.prepare(
    `SELECT COUNT(DISTINCT email) as n FROM email_send_log WHERE ip = ? AND result = 'success' AND sent_at > ?`,
  ).bind(ip, ago(3600_000)).first<{ n: number }>();
  if ((r4?.n ?? 0) >= 10) return { ok: false, reason: 'ip_1h_unique_emails_limit' };

  // ip 24h total
  const r5 = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM email_send_log WHERE ip = ? AND result = 'success' AND sent_at > ?`,
  ).bind(ip, ago(24 * 3600_000)).first<{ n: number }>();
  if ((r5?.n ?? 0) >= 30) return { ok: false, reason: 'ip_24h_total_limit' };

  // device 24h unique emails
  if (deviceId) {
    const r6 = await env.DB.prepare(
      `SELECT COUNT(DISTINCT email) as n FROM email_send_log WHERE device_id = ? AND result = 'success' AND sent_at > ?`,
    ).bind(deviceId, ago(24 * 3600_000)).first<{ n: number }>();
    if ((r6?.n ?? 0) >= 5) return { ok: false, reason: 'device_24h_unique_emails_limit' };
  }

  // 验证码失败锁
  const r7 = await env.DB.prepare(
    `SELECT code_attempts, sent_at FROM email_send_log
     WHERE email = ? AND result = 'success'
     ORDER BY sent_at DESC LIMIT 1`,
  ).bind(email).first<{ code_attempts: number; sent_at: number }>();
  if (r7 && r7.code_attempts >= MAX_ATTEMPTS_BEFORE_LOCK && r7.sent_at > ago(LOCK_DURATION_MS)) {
    return { ok: false, reason: 'email_locked_30min' };
  }

  return { ok: true };
}
