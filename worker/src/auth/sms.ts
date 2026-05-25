// PR2 腾讯云 SMS V3 API + 多层防刷
// 设计参考：docs/plans/2026-05-01-auth-system-design.md § 7
// 腾讯云 V3 签名：https://cloud.tencent.com/document/api/382/52071

import type { Env } from '../index';
import type { RateLimitResult } from './types';
import { pushDeerAlert, pushDeerWarning } from '../notifier';

const SMS_HOST = 'sms.tencentcloudapi.com';
const SMS_SERVICE = 'sms';
const SMS_ACTION = 'SendSms';
const SMS_VERSION = '2021-01-11';
const CODE_TTL_MS = 5 * 60 * 1000;       // 验证码 5 分钟
const LOCK_DURATION_MS = 30 * 60 * 1000; // 失败锁 30 分钟
const MAX_ATTEMPTS_BEFORE_LOCK = 5;
const DEFAULT_DAILY_CAP = 200;

// ─── 1. 三维度限流 ─────────────────────────────────────────

export async function checkRateLimits(
  env: Env,
  phone: string,
  ip: string,
  deviceId: string | null,
): Promise<RateLimitResult> {
  const now = Date.now();
  const ago = (ms: number) => now - ms;

  // phone 60s
  const r1 = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM sms_send_log WHERE phone = ? AND result = 'success' AND sent_at > ?`,
  ).bind(phone, ago(60_000)).first<{ n: number }>();
  if ((r1?.n ?? 0) >= 1) return { ok: false, reason: 'phone_60s_limit' };

  // phone 5min
  const r2 = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM sms_send_log WHERE phone = ? AND result = 'success' AND sent_at > ?`,
  ).bind(phone, ago(5 * 60_000)).first<{ n: number }>();
  if ((r2?.n ?? 0) >= 3) return { ok: false, reason: 'phone_5min_limit' };

  // phone 24h
  const r3 = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM sms_send_log WHERE phone = ? AND result = 'success' AND sent_at > ?`,
  ).bind(phone, ago(24 * 3600_000)).first<{ n: number }>();
  if ((r3?.n ?? 0) >= 10) return { ok: false, reason: 'phone_24h_limit' };

  // ip 1h unique phones
  const r4 = await env.DB.prepare(
    `SELECT COUNT(DISTINCT phone) as n FROM sms_send_log WHERE ip = ? AND result = 'success' AND sent_at > ?`,
  ).bind(ip, ago(3600_000)).first<{ n: number }>();
  if ((r4?.n ?? 0) >= 10) return { ok: false, reason: 'ip_1h_unique_phones_limit' };

  // ip 24h total
  const r5 = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM sms_send_log WHERE ip = ? AND result = 'success' AND sent_at > ?`,
  ).bind(ip, ago(24 * 3600_000)).first<{ n: number }>();
  if ((r5?.n ?? 0) >= 30) return { ok: false, reason: 'ip_24h_total_limit' };

  // device 24h unique phones
  if (deviceId) {
    const r6 = await env.DB.prepare(
      `SELECT COUNT(DISTINCT phone) as n FROM sms_send_log WHERE device_id = ? AND result = 'success' AND sent_at > ?`,
    ).bind(deviceId, ago(24 * 3600_000)).first<{ n: number }>();
    if ((r6?.n ?? 0) >= 5) return { ok: false, reason: 'device_24h_unique_phones_limit' };
  }

  // 验证码失败锁：phone 最近一条 success 记录的 attempts >= 5 + sent_at < 30min ago
  const r7 = await env.DB.prepare(
    `SELECT code_attempts, sent_at FROM sms_send_log
     WHERE phone = ? AND result = 'success'
     ORDER BY sent_at DESC LIMIT 1`,
  ).bind(phone).first<{ code_attempts: number; sent_at: number }>();
  if (r7 && r7.code_attempts >= MAX_ATTEMPTS_BEFORE_LOCK && r7.sent_at > ago(LOCK_DURATION_MS)) {
    return { ok: false, reason: 'phone_locked_30min' };
  }

  return { ok: true };
}

// ─── 2. 每日 cap (KV) ────────────────────────────────────────

function todayKey(): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `sms_count_${yyyy}${mm}${dd}`;
}

export async function checkAndIncrDailyCap(
  env: Env,
): Promise<{ ok: boolean; sent: number; cap: number }> {
  const cap = parseInt(env.SMS_DAILY_CAP || String(DEFAULT_DAILY_CAP), 10);
  if (cap <= 0) return { ok: false, sent: 0, cap };  // kill switch
  const key = todayKey();
  const cur = await env.AUTH_KV.get(key);
  const sent = cur ? parseInt(cur, 10) : 0;
  if (sent >= cap) return { ok: false, sent, cap };
  // INCR (best-effort，CF KV 没原子 INCR；并发可能漏 1-2 但对 200 cap 影响小)
  await env.AUTH_KV.put(key, String(sent + 1), { expirationTtl: 36 * 3600 });
  return { ok: true, sent: sent + 1, cap };
}

export async function checkDailyCapAlerts(env: Env, sent: number, cap: number): Promise<void> {
  // 80% / 95% 阈值
  const pct = sent / cap;
  if (pct >= 0.95) {
    await pushDeerAlert(env, 'SMS 95% 紧急', `今日发送 ${sent}/${cap}，建议立即检查异常 IP/phone 并临时把 SMS_DAILY_CAP 调到 0 切流`);
  } else if (pct >= 0.80 && (sent === Math.floor(cap * 0.80) || sent === Math.floor(cap * 0.80) + 1)) {
    // 仅在跨过 80% 阈值的瞬间触发一次（避免每条都告警）
    // 80% warning 级:日报推,95% 才立即(critical)
    await pushDeerWarning(env, 'SMS 80% 警告', `今日发送 ${sent}/${cap}，请关注 events 表 sms_send_attempt 分布`);
  }
}

// ─── 3. 验证码生成 + hash ────────────────────────────────────

/** 生成 6 位数字验证码 */
export function generateCode(): string {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  // 转 32-bit unsigned，模 1000000，padStart 6 位
  const n = ((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) >>> 0;
  return String(n % 1_000_000).padStart(6, '0');
}

/** SHA-256 hex 用于存到 D1 */
export async function hashCode(code: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}|${code}`);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ─── 4. 腾讯云 SMS V3 API ──────────────────────────────────

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return bytesToHex(new Uint8Array(buf));
}

async function hmacSha256(key: ArrayBuffer | string, msg: string): Promise<Uint8Array> {
  const keyBuf = typeof key === 'string' ? new TextEncoder().encode(key) : key;
  const ck = await crypto.subtle.importKey(
    'raw',
    keyBuf,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', ck, new TextEncoder().encode(msg));
  return new Uint8Array(sig);
}

/**
 * 腾讯云 V3 签名 (TC3-HMAC-SHA256)
 * 文档：https://cloud.tencent.com/document/api/382/52071
 *
 * 关键点：
 * - SignedHeaders 最小集 'content-type;host'，content-type 在签名内必须小写
 * - 实际请求 header 大小写不敏感但官方示例 Content-Type
 * - timestamp 容忍 ±5 分钟
 * - date 部分用 UTC YYYY-MM-DD
 */
async function tc3SignAuthHeader(
  service: string,
  host: string,
  payload: string,
  timestamp: number,
  secretId: string,
  secretKey: string,
): Promise<string> {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10); // YYYY-MM-DD UTC
  // Step 1: canonical request
  const httpRequestMethod = 'POST';
  const canonicalUri = '/';
  const canonicalQueryString = '';
  const canonicalHeaders =
    `content-type:application/json; charset=utf-8\n` +
    `host:${host}\n`;
  const signedHeaders = 'content-type;host';
  const hashedRequestPayload = await sha256Hex(payload);
  const canonicalRequest =
    `${httpRequestMethod}\n${canonicalUri}\n${canonicalQueryString}\n` +
    `${canonicalHeaders}\n${signedHeaders}\n${hashedRequestPayload}`;

  // Step 2: string to sign
  const algorithm = 'TC3-HMAC-SHA256';
  const credentialScope = `${date}/${service}/tc3_request`;
  const hashedCanonicalRequest = await sha256Hex(canonicalRequest);
  const stringToSign = `${algorithm}\n${timestamp}\n${credentialScope}\n${hashedCanonicalRequest}`;

  // Step 3: derived key chain
  const secretDate = await hmacSha256(`TC3${secretKey}`, date);
  const secretService = await hmacSha256(secretDate.buffer as ArrayBuffer, service);
  const secretSigning = await hmacSha256(secretService.buffer as ArrayBuffer, 'tc3_request');

  // Step 4: signature
  const signatureBytes = await hmacSha256(secretSigning.buffer as ArrayBuffer, stringToSign);
  const signature = bytesToHex(signatureBytes);

  // Step 5: Authorization
  return `${algorithm} Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

interface SendSmsResult {
  ok: boolean;
  requestId?: string;
  errCode?: string;
  errMsg?: string;
}

/**
 * 通过 PushDeer 推验证码到 admin（dev / staging / 冷启动期手动通道）
 * — 真实"短信"渠道不通时（腾讯云审核中、或临时停服），任何 phone
 *   的验证码都推到 admin 配置的 PushDeer 设备（用户自己手机 + Mac）。
 * 适用：本地 dev、staging 阶段、朋友熟人冷启动期手动验证。
 * 限制：单人 dev tool，不能给真实多用户产品用。
 */
async function sendSmsViaPushDeer(
  env: Env,
  phone: string,
  code: string,
): Promise<SendSmsResult> {
  if (!env.PUSHDEER_ADMIN_KEYS) {
    console.warn('[sms] SMS_PROVIDER=pushdeer 但 PUSHDEER_ADMIN_KEYS 未配置');
    return { ok: false, errCode: 'NO_PUSHDEER_KEY', errMsg: 'PUSHDEER_ADMIN_KEYS missing' };
  }
  await pushDeerAlert(
    env,
    'xList 验证码',
    `phone：${phone.slice(0, 3)}***${phone.slice(-4)}\n\n**${code}**\n\n5 分钟有效。如非本人请求请忽略。`,
  );
  return { ok: true, requestId: `pushdeer-${Date.now()}` };
}

/**
 * 发送短信验证码（路由器）— 按 SMS_PROVIDER 切换 provider：
 * - 'pushdeer'  → sendSmsViaPushDeer（推到 admin PushDeer，dev/staging）
 * - 'tencent'（默认） → 真实腾讯云 V3
 * - secret 缺失时 fallback 到 dev simulate（console.log 明文 code）
 *
 * 函数名保留 sendSmsViaTencent 是历史包袱，实际职责已是 router。
 */
export async function sendSmsViaTencent(
  env: Env,
  phone: string,
  code: string,
): Promise<SendSmsResult> {
  // Provider 路由
  const provider = (env.SMS_PROVIDER || 'tencent').toLowerCase();
  if (provider === 'pushdeer') {
    return sendSmsViaPushDeer(env, phone, code);
  }

  // 默认 tencent — secret 缺失走 dev simulate
  if (
    !env.TENCENT_SMS_SECRET_ID ||
    !env.TENCENT_SMS_SECRET_KEY ||
    !env.TENCENT_SMS_SDK_APP_ID ||
    !env.TENCENT_SMS_SIGN_NAME ||
    !env.TENCENT_SMS_TEMPLATE_ID
  ) {
    console.warn(`[sms] TENCENT_SMS_* not fully configured, dev simulate. phone=${phone} code=${code}`);
    return { ok: true, requestId: 'dev-simulated' };
  }

  const region = env.TENCENT_SMS_REGION || 'ap-guangzhou';
  const timestamp = Math.floor(Date.now() / 1000);

  // 业务 body
  const body = {
    PhoneNumberSet: [`+86${phone}`],
    SmsSdkAppId: env.TENCENT_SMS_SDK_APP_ID,
    SignName: env.TENCENT_SMS_SIGN_NAME,
    TemplateId: env.TENCENT_SMS_TEMPLATE_ID,
    TemplateParamSet: [code],
  };
  const payload = JSON.stringify(body);

  // V3 签名
  const authHeader = await tc3SignAuthHeader(
    SMS_SERVICE,
    SMS_HOST,
    payload,
    timestamp,
    env.TENCENT_SMS_SECRET_ID,
    env.TENCENT_SMS_SECRET_KEY,
  );

  // 发请求
  let r: Response;
  try {
    r = await fetch(`https://${SMS_HOST}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Host': SMS_HOST,
        'X-TC-Action': SMS_ACTION,
        'X-TC-Version': SMS_VERSION,
        'X-TC-Region': region,
        'X-TC-Timestamp': String(timestamp),
        'Authorization': authHeader,
      },
      body: payload,
    });
  } catch (e) {
    return { ok: false, errCode: 'NETWORK', errMsg: String(e) };
  }

  // 腾讯云返回包格式：{"Response":{"Error":{Code,Message}|absent, RequestId, SendStatusSet:[{Code,Message,SerialNo,PhoneNumber}]}}
  const data = (await r.json()) as {
    Response?: {
      Error?: { Code: string; Message: string };
      RequestId?: string;
      SendStatusSet?: Array<{ SerialNo: string; PhoneNumber: string; Code: string; Message: string }>;
    };
  };

  if (data.Response?.Error) {
    return { ok: false, errCode: data.Response.Error.Code, errMsg: data.Response.Error.Message };
  }
  // 单条 PhoneNumberSet 应返回 SendStatusSet 长度 1，Code='Ok' 表示成功
  const status = data.Response?.SendStatusSet?.[0];
  if (!status) {
    return { ok: false, errCode: 'NO_SEND_STATUS', errMsg: JSON.stringify(data) };
  }
  if (status.Code !== 'Ok') {
    return { ok: false, errCode: status.Code, errMsg: status.Message };
  }
  return { ok: true, requestId: data.Response?.RequestId };
}
