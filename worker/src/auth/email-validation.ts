// PR-EmailAuth：email validation + disposable + MX 预校验
// 设计参考：docs/plans/2026-05-06-email-auth-design.md § 5.1 + § 5.2

import disposableDomains from 'disposable-email-domains';
import type { Env } from '../index';

// RFC 5322 简化版（不追求完美，过滤明显错误足够）
export const EMAIL_REGEX = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;

/** 归一化：trim + lowercase（数据库唯一键比较前必须做） */
export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

/** 提取 domain 部分；输入必须已 normalize 过 */
export function emailDomain(email: string): string {
  const at = email.lastIndexOf('@');
  return at < 0 ? '' : email.slice(at + 1);
}

// 一次性邮箱黑名单（启动时构建 Set，O(1) 查询）
const DISPOSABLE_SET = new Set(
  (disposableDomains as string[]).map((d: string) => d.toLowerCase()),
);

export function isDisposableDomain(domain: string): boolean {
  return DISPOSABLE_SET.has(domain.toLowerCase());
}

// MX 预校验 — 用 cloudflare-dns.com DoH，KV 缓存 24h
const MX_CACHE_TTL_SEC = 24 * 3600;

interface DoHAnswer {
  Status: number;
  Answer?: Array<{ name: string; type: number; data: string }>;
}

export async function checkMxRecord(env: Env, domain: string): Promise<boolean> {
  const cacheKey = `mx_cache_${domain}`;
  const cached = await env.AUTH_KV.get(cacheKey);
  if (cached === 'ok') return true;
  if (cached === 'fail') return false;

  // 没缓存 → 查 DoH
  let result: 'ok' | 'fail';
  try {
    const r = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`,
      { headers: { 'Accept': 'application/dns-json' } },
    );
    if (!r.ok) {
      // DoH 抖动 → 默认放行（不因 DNS 失败拦正常用户）
      return true;
    }
    const data = (await r.json()) as DoHAnswer;
    // type=15 是 MX 记录；Status=0 表示成功响应
    const hasMx = data.Status === 0 && (data.Answer?.some((a) => a.type === 15) ?? false);
    result = hasMx ? 'ok' : 'fail';
  } catch {
    // 网络错误 → 默认放行
    return true;
  }

  // 缓存 24h（含 fail，避免对同一假域名反复查）
  await env.AUTH_KV.put(cacheKey, result, { expirationTtl: MX_CACHE_TTL_SEC });
  return result === 'ok';
}
