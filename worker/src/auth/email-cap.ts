// PR-EmailAuth：email daily + monthly cap + 80%/95% 告警
// 设计参考：docs/plans/2026-05-06-email-auth-design.md § 5.4

import type { Env } from '../index';
import { pushDeerAlert } from '../notifier';

const DEFAULT_DAILY_CAP = 100;
const DEFAULT_MONTHLY_CAP = 3000;

function todayKey(): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `email_count_${yyyy}${mm}${dd}`;
}

function monthKey(): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `email_count_${yyyy}${mm}`;
}

/** 日度 cap 检查 + 自增（best-effort，KV 无原子 INCR；并发可能漏 1-2，可接受） */
export async function checkAndIncrEmailDailyCap(
  env: Env,
): Promise<{ ok: boolean; sent: number; cap: number }> {
  const cap = parseInt(env.EMAIL_DAILY_CAP || String(DEFAULT_DAILY_CAP), 10);
  if (cap <= 0) return { ok: false, sent: 0, cap };  // kill switch
  const key = todayKey();
  const cur = await env.AUTH_KV.get(key);
  const sent = cur ? parseInt(cur, 10) : 0;
  if (sent >= cap) return { ok: false, sent, cap };
  await env.AUTH_KV.put(key, String(sent + 1), { expirationTtl: 36 * 3600 });
  return { ok: true, sent: sent + 1, cap };
}

/** 月度 cap 检查 + 自增 */
export async function checkAndIncrEmailMonthlyCap(
  env: Env,
): Promise<{ ok: boolean; sent: number; cap: number }> {
  const cap = parseInt(env.EMAIL_MONTHLY_CAP || String(DEFAULT_MONTHLY_CAP), 10);
  if (cap <= 0) return { ok: false, sent: 0, cap };
  const key = monthKey();
  const cur = await env.AUTH_KV.get(key);
  const sent = cur ? parseInt(cur, 10) : 0;
  if (sent >= cap) return { ok: false, sent, cap };
  await env.AUTH_KV.put(key, String(sent + 1), { expirationTtl: 35 * 24 * 3600 });
  return { ok: true, sent: sent + 1, cap };
}

/** 跨 80% / 95% 阈值告警（去重：同阈值同日只发一次） */
export async function checkEmailDailyCapAlerts(env: Env, sent: number, cap: number): Promise<void> {
  const pct = sent / cap;
  const dateStr = todayKey().slice(-8);  // YYYYMMDD
  if (pct >= 0.95) {
    const dedupKey = `email_alert_daily_95_${dateStr}`;
    if (!(await env.AUTH_KV.get(dedupKey))) {
      await env.AUTH_KV.put(dedupKey, '1', { expirationTtl: 36 * 3600 });
      await pushDeerAlert(env, 'Email 95% 紧急', `今日 email 已发 ${sent}/${cap}，建议升级 Resend 或临时把 EMAIL_DAILY_CAP 调到 0 切流`);
    }
  } else if (pct >= 0.80) {
    const dedupKey = `email_alert_daily_80_${dateStr}`;
    if (!(await env.AUTH_KV.get(dedupKey))) {
      await env.AUTH_KV.put(dedupKey, '1', { expirationTtl: 36 * 3600 });
      await pushDeerAlert(env, 'Email 80% 警告', `今日 email 已发 ${sent}/${cap}，关注异常 IP/email 分布`);
    }
  }
}

export async function checkEmailMonthlyCapAlerts(env: Env, sent: number, cap: number): Promise<void> {
  const pct = sent / cap;
  const monthStr = monthKey().slice(-6);  // YYYYMM
  if (pct >= 0.95) {
    const dedupKey = `email_alert_monthly_95_${monthStr}`;
    if (!(await env.AUTH_KV.get(dedupKey))) {
      await env.AUTH_KV.put(dedupKey, '1', { expirationTtl: 35 * 24 * 3600 });
      await pushDeerAlert(env, 'Email 月度 95% 紧急', `本月 email 已发 ${sent}/${cap}，需要立即升级 Resend 付费档`);
    }
  } else if (pct >= 0.80) {
    const dedupKey = `email_alert_monthly_80_${monthStr}`;
    if (!(await env.AUTH_KV.get(dedupKey))) {
      await env.AUTH_KV.put(dedupKey, '1', { expirationTtl: 35 * 24 * 3600 });
      await pushDeerAlert(env, 'Email 月度 80% 警告', `本月 email 已发 ${sent}/${cap}，预算关注`);
    }
  }
}
