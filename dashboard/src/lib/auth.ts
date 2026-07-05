// PR3 auth client SDK
// 设计参考：docs/plans/2026-05-01-auth-system-design.md § 9.3

import { getDeviceId } from './device';
// API_BASE 用唯一事实源 lib/apiBase.ts。历史上本文件自己抄了一份镜像却漏了
// staging 分支,导致 staging 域名下 auth 打 prod、业务打 staging → 登录死循环
// (2026-07-05 事故)。镜像已删除,只准从 apiBase import。
import { API_BASE } from './apiBase';

export interface User {
  id: string;
  display_name: string | null;
  avatar_url: string | null;
  created_at?: number;
  // 新字段（推荐使用）
  identity_masked?: string | null;
  identity_provider?: string | null;
  // 老字段保留兼容
  phone_masked?: string | null;
  /** 跨设备同步设置；schema 形如 {"video": {"autoplay": bool, "muted": bool}}。
   *  未登录用户 undefined / null（走 localStorage） */
  preferences?: Record<string, unknown> | null;
}

export interface LoginResponse {
  user: User & { is_new: boolean };
  session: { id: string; expires_at: number };
}

interface ErrorResponse {
  error: string;
  reason?: string;
  attempts_remaining?: number;
  errCode?: string;
}

export class AuthError extends Error {
  status: number;
  reason?: string;
  attemptsRemaining?: number;
  errCode?: string;

  constructor(status: number, data: ErrorResponse) {
    super(data.error || `auth error ${status}`);
    this.status = status;
    this.reason = data.reason;
    this.attemptsRemaining = data.attempts_remaining;
    this.errCode = data.errCode;
  }
}

interface AuthFetchInit extends Omit<RequestInit, 'body'> {
  body?: unknown;
}

// 幂等 GET（如 /api/auth/me）允许一次重试，应对 CF 冷启动 / WeChat WebView
// 偶发网络抖动；其他方法（POST 登录/登出等）不重试避免重复副作用。
async function authFetch(path: string, init: AuthFetchInit = {}): Promise<Response> {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  const { body, headers: rawHeaders, ...rest } = init;
  const headers = new Headers(rawHeaders as HeadersInit | undefined);
  headers.set('X-Device-Id', getDeviceId());
  let fetchBody: BodyInit | undefined;
  if (body !== undefined) {
    headers.set('Content-Type', 'application/json');
    fetchBody = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const method = (rest.method as string | undefined)?.toUpperCase() || 'GET';
  const idempotent = method === 'GET' || method === 'HEAD';
  const doFetch = () => fetch(url, { ...rest, headers, body: fetchBody, credentials: 'include' });
  try {
    const r = await doFetch();
    // 5xx + 幂等 → 重试一次（500ms 退避）
    if (idempotent && r.status >= 500 && r.status < 600) {
      await new Promise((res) => setTimeout(res, 500));
      try { return await doFetch(); } catch { return r; }
    }
    return r;
  } catch (e) {
    if (idempotent) {
      await new Promise((res) => setTimeout(res, 500));
      return doFetch();
    }
    throw e;
  }
}

async function parseOrThrow<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T;
  let data: ErrorResponse;
  try {
    data = (await res.json()) as ErrorResponse;
  } catch {
    data = { error: `HTTP ${res.status}` };
  }
  throw new AuthError(res.status, data);
}

export async function sendSmsCode(
  phone: string,
  turnstileToken: string,
): Promise<{ ok: true; ttl: number }> {
  const res = await authFetch('/api/auth/sms/send', {
    method: 'POST',
    body: { phone, turnstile_token: turnstileToken },
  });
  return parseOrThrow(res);
}

export async function sendEmailCode(
  email: string,
  turnstileToken: string,
): Promise<{ ok: true; ttl: number }> {
  const res = await authFetch('/api/auth/email/send', {
    method: 'POST',
    body: { email, turnstile_token: turnstileToken },
  });
  return parseOrThrow(res);
}

/**
 * 登录入口：identifier 同时接受 phone 或 email
 * worker handler 按格式自动路由到对应 verify path
 */
export async function login(identifier: string, code: string): Promise<LoginResponse> {
  const res = await authFetch('/api/auth/login', {
    method: 'POST',
    body: { identifier, code },
  });
  return parseOrThrow(res);
}

export async function fetchMe(): Promise<{ user: User }> {
  const res = await authFetch('/api/auth/me');
  return parseOrThrow(res);
}

export async function logout(): Promise<{ ok: true }> {
  const res = await authFetch('/api/auth/logout', { method: 'POST' });
  return parseOrThrow(res);
}

export async function deleteAccount(phoneConfirm: string): Promise<{ ok: true }> {
  const res = await authFetch('/api/auth/delete', {
    method: 'POST',
    body: { phone_confirm: phoneConfirm },
  });
  return parseOrThrow(res);
}
