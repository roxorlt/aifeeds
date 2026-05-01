// PR2 Turnstile 校验
// CF 自家 captcha 服务，token 来自前端 widget，server 端 siteverify 拿 success
// 设计参考：docs/plans/2026-05-01-auth-system-design.md § 7.2

import type { Env } from '../index';

const SITEVERIFY_ENDPOINT = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

interface SiteverifyResponse {
  success: boolean;
  challenge_ts?: string;
  hostname?: string;
  'error-codes'?: string[];
  action?: string;
  cdata?: string;
}

/**
 * 校验前端传来的 Turnstile token。
 * 失败原因不暴露给客户端（避免给攻击者 hint），仅 console.warn。
 *
 * dev 环境 secret 缺失时返回 true（不挡 dev），生产环境 deploy 前必须 secret put。
 */
export async function verifyTurnstile(
  env: Env,
  token: string | null,
  remoteIp: string,
): Promise<boolean> {
  if (!env.TURNSTILE_SECRET_KEY) {
    console.warn('[turnstile] TURNSTILE_SECRET_KEY not set, bypass (dev only)');
    return true;
  }

  if (!token) return false;

  try {
    const r = await fetch(SITEVERIFY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret: env.TURNSTILE_SECRET_KEY,
        response: token,
        remoteip: remoteIp,
      }),
    });
    if (!r.ok) {
      console.warn(`[turnstile] siteverify ${r.status}`);
      return false;
    }
    const data = (await r.json()) as SiteverifyResponse;
    if (!data.success) {
      console.warn('[turnstile] verify failed', data['error-codes']);
    }
    return data.success === true;
  } catch (e) {
    console.error('[turnstile] exception', e);
    return false;
  }
}
