// 纯 Node 内置 crypto，无第三方依赖。
// 三件事：①给 OAuth 飞行态 cookie 签名/验签 ②给 worker 调用算 bridge HMAC ③sha256。

import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function sha256Hex(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export function hmacSha256Hex(secret, msg) {
  return createHmac('sha256', secret).update(msg, 'utf8').digest('hex');
}

export function randomNonce(bytes = 16) {
  return randomBytes(bytes).toString('hex');
}

// 常数时间比较（防 timing attack）。长度不等直接 false。
export function timingSafeEqHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8');
}

// ─── OAuth 飞行态 cookie：把 {return_to, device_id, nonce, ts} 签名打包 ───
// 微信 state 有长度限制（~128B），所以 return_to 不放 state，放这个 cookie（.cc 域）。
// 发给微信的 state 只放短 nonce；回调时 cookie.nonce === state 做 CSRF 校验。

export function signFlightState(payloadObj, secret) {
  const payload = b64urlEncode(JSON.stringify(payloadObj));
  const sig = hmacSha256Hex(secret, payload);
  return `${payload}.${sig}`;
}

export function verifyFlightState(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = hmacSha256Hex(secret, payload);
  if (!timingSafeEqHex(expected, sig)) return null;
  try {
    return JSON.parse(b64urlDecode(payload));
  } catch {
    return null;
  }
}

// ─── bridge HMAC：调 worker exchange 用 ───
// 头：X-Bridge-Timestamp + X-Bridge-Signature = HMAC(secret, ts + "." + sha256(body))

export function buildBridgeHeaders(bodyText, secret, nowSec) {
  const ts = String(nowSec);
  const bodyHash = sha256Hex(bodyText);
  const sig = hmacSha256Hex(secret, `${ts}.${bodyHash}`);
  return {
    'X-Bridge-Timestamp': ts,
    'X-Bridge-Signature': sig,
  };
}
