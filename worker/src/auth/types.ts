// PR2 auth 共享类型
// 设计参考：docs/plans/2026-05-01-auth-system-design.md § 3 + § 9

export interface UserRow {
  id: string;
  display_name: string | null;
  avatar_url: string | null;
  created_at: number;
  last_active_at: number;
  status: 'active' | 'banned' | 'self_deleted';
  banned_reason: string | null;
  metadata: string | null;
}

export interface IdentityRow {
  id: number;
  user_id: string;
  provider: 'phone' | 'wechat' | 'email';
  identity_value: string;
  verified_at: number;
  unbound_at: number | null;
  metadata: string | null;
}

export interface SessionRow {
  id: string;
  user_id: string;
  device_id: string | null;
  ip: string | null;
  ua: string | null;
  created_at: number;
  last_used_at: number;
  expires_at: number;
  revoked_at: number | null;
}

export interface SmsLogRow {
  id: number;
  phone: string;
  ip: string;
  device_id: string | null;
  ua: string | null;
  sent_at: number;
  result: 'success' | 'rate_limited' | 'turnstile_failed' | 'sms_api_error' | 'budget_capped';
  code_hash: string | null;
  code_expires_at: number | null;
  code_used_at: number | null;
  code_attempts: number;
  metadata: string | null;
}

/** 鉴权中间件返回的 context */
export type AuthContext =
  | { kind: 'anonymous' }
  | { kind: 'authenticated'; userId: string; sessionId: string };

/** 限流检查结果 */
export interface RateLimitResult {
  ok: boolean;
  reason?:
    | 'phone_60s_limit'
    | 'phone_5min_limit'
    | 'phone_24h_limit'
    | 'ip_1h_unique_phones_limit'
    | 'ip_24h_total_limit'
    | 'device_24h_unique_phones_limit'
    | 'phone_locked_30min';
}

export interface EmailLogRow {
  id: number;
  email: string;
  ip: string;
  device_id: string | null;
  ua: string | null;
  sent_at: number;
  result:
    | 'success'
    | 'turnstile_failed'
    | 'rate_limited'
    | 'disposable_blocked'
    | 'mx_failed'
    | 'budget_capped'
    | 'resend_api_error';
  code_hash: string | null;
  code_expires_at: number | null;
  code_used_at: number | null;
  code_attempts: number;
  metadata: string | null;
}

export interface EmailRateLimitResult {
  ok: boolean;
  reason?:
    | 'email_60s_limit'
    | 'email_5min_limit'
    | 'email_24h_limit'
    | 'ip_1h_unique_emails_limit'
    | 'ip_24h_total_limit'
    | 'device_24h_unique_emails_limit'
    | 'email_locked_30min';
}
