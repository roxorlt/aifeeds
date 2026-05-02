// PR3 auth client SDK
// 设计参考：docs/plans/2026-05-01-auth-system-design.md § 9.3

import { getDeviceId } from './device';

const API_BASE = (() => {
  if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_BASE) {
    return import.meta.env.VITE_API_BASE;
  }
  if (typeof window !== 'undefined') {
    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') {
      return 'http://localhost:8788';
    }
  }
  return 'https://api.ai-feeds.com';
})();

export interface User {
  id: string;
  display_name: string | null;
  avatar_url: string | null;
  created_at?: number;
  phone_masked?: string | null;
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
  return fetch(url, {
    ...rest,
    headers,
    body: fetchBody,
    credentials: 'include',
  });
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

export async function login(phone: string, code: string): Promise<LoginResponse> {
  const res = await authFetch('/api/auth/login', {
    method: 'POST',
    body: { phone, code },
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

export async function logoutAll(): Promise<{ ok: true; revoked: number }> {
  const res = await authFetch('/api/auth/logout-all', { method: 'POST' });
  return parseOrThrow(res);
}

export async function deleteAccount(phoneConfirm: string): Promise<{ ok: true }> {
  const res = await authFetch('/api/auth/delete', {
    method: 'POST',
    body: { phone_confirm: phoneConfirm },
  });
  return parseOrThrow(res);
}
