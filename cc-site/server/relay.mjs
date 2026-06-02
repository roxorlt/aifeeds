// ai-feeds.cc 微信扫码登录中转服务（零依赖 Node 18+）。
// 架构：docs/wechat/architecture.md。无状态 OAuth 代理，不写 DB / 不存 session。
//
// 两个路由（nginx 反代 /auth/wechat/* → 本进程 127.0.0.1:PORT）：
//   GET /auth/wechat/start    生成飞行态 cookie + 302 到微信扫码页
//   GET /auth/wechat/callback 验 state + 换 openid + 调 worker exchange + 302 回 .com
//   GET /auth/wechat/health   健康检查（PM2 / 监控用）
//
// state 处理：微信 state 有长度限制，故只放短 nonce；return_to / device_id 放
// 签名 cookie（.cc 域，SameSite=Lax，5min）。回调时 cookie.nonce === state 做 CSRF。

import http from 'node:http';
import { config, isAllowedReturnTo } from './lib/config.mjs';
import {
  randomNonce,
  signFlightState,
  verifyFlightState,
  buildBridgeHeaders,
} from './lib/crypto.mjs';
import { buildQrConnectUrl, exchangeCodeForToken, fetchUserInfo } from './lib/wechat.mjs';

const COOKIE_NAME = 'wx_oauth';

// ─── code 去重（防 code 重放）。内存 Map + TTL，单实例足够；微信本身也保证 code 一次性 ───
const seenCodes = new Map(); // code -> expiryMs
function isCodeReplay(code) {
  const now = Date.now();
  // 顺手清理过期项（量小，O(n) 可接受）
  if (seenCodes.size > 500) {
    for (const [k, exp] of seenCodes) if (exp < now) seenCodes.delete(k);
  }
  if (seenCodes.has(code) && seenCodes.get(code) > now) return true;
  seenCodes.set(code, now + config.stateWindowSec * 1000);
  return false;
}

// ─── 工具 ───
function getClientIp(req) {
  // .cc nginx 反代时注入 X-Real-IP / X-Forwarded-For；进程本身只看到 127.0.0.1
  const xri = req.headers['x-real-ip'];
  if (typeof xri === 'string' && xri.trim()) return xri.trim();
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress || '0.0.0.0';
}

function redirect(res, location, extraHeaders = {}) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', ...extraHeaders });
  res.end();
}

function errorRedirect(res, code, clearCookie = false) {
  const headers = {};
  if (clearCookie) headers['Set-Cookie'] = buildClearCookie();
  redirect(res, `${config.comLoginUrl}?error=${encodeURIComponent(code)}`, headers);
}

function buildSetCookie(value) {
  return [
    `${COOKIE_NAME}=${value}`,
    `Domain=${config.cookieDomain}`,
    'Path=/auth/wechat',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${config.cookieMaxAgeSec}`,
  ].join('; ');
}

function buildClearCookie() {
  return [
    `${COOKIE_NAME}=`,
    `Domain=${config.cookieDomain}`,
    'Path=/auth/wechat',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Max-Age=0',
  ].join('; ');
}

function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  const m = raw.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}

// ─── GET /auth/wechat/start ───
function handleStart(req, res, url) {
  const returnTo = url.searchParams.get('return_to') || '';
  const deviceId = url.searchParams.get('device_id') || '';

  if (!isAllowedReturnTo(returnTo)) {
    return errorRedirect(res, 'bad_return');
  }

  const nonce = randomNonce(16);
  const flight = {
    return_to: returnTo,
    device_id: deviceId.slice(0, 64), // 防超长
    nonce,
    ts: Math.floor(Date.now() / 1000),
  };
  const token = signFlightState(flight, config.stateSecret);

  redirect(res, buildQrConnectUrl(nonce), { 'Set-Cookie': buildSetCookie(token) });
}

// ─── GET /auth/wechat/callback ───
async function handleCallback(req, res, url) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  // 用户在微信里取消授权 → 微信不带 code
  if (!code) {
    return errorRedirect(res, 'wechat_denied', true);
  }

  // 读飞行态 cookie + 验签
  const cookieVal = getCookie(req, COOKIE_NAME);
  const flight = cookieVal ? verifyFlightState(cookieVal, config.stateSecret) : null;
  if (!flight) {
    return errorRedirect(res, 'state_invalid', true);
  }

  // 时间窗
  const nowSec = Math.floor(Date.now() / 1000);
  if (!flight.ts || nowSec - flight.ts > config.stateWindowSec) {
    return errorRedirect(res, 'state_expired', true);
  }

  // CSRF：cookie 里的 nonce 必须等于微信带回的 state
  if (!state || state !== flight.nonce) {
    return errorRedirect(res, 'state_mismatch', true);
  }

  // 二次校验 return_to（纵深防御）
  if (!isAllowedReturnTo(flight.return_to)) {
    return errorRedirect(res, 'bad_return', true);
  }

  // code 去重
  if (isCodeReplay(code)) {
    return errorRedirect(res, 'code_replay', true);
  }

  // 1. code → openid
  let token;
  try {
    token = await exchangeCodeForToken(code);
  } catch (e) {
    console.error('exchangeCodeForToken failed:', e.message);
    return errorRedirect(res, 'wechat_api', true);
  }
  if (!token.openid) {
    return errorRedirect(res, 'wechat_api', true);
  }

  // 2. 拉昵称/头像（失败不阻塞）
  const info = await fetchUserInfo(token.accessToken, token.openid);

  // 3. 调 worker exchange（bridge HMAC）
  const body = JSON.stringify({
    openid: token.openid,
    unionid: token.unionid || info?.unionid || undefined,
    nickname: info?.nickname || undefined,
    avatar_url: info?.avatarUrl || undefined,
    device_id: flight.device_id || undefined,
    ip: getClientIp(req),
    ua: req.headers['user-agent'] || '',
  });

  let workerResp;
  try {
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': config.relayUserAgent,
      ...buildBridgeHeaders(body, config.bridgeSecret, Math.floor(Date.now() / 1000)),
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), config.fetchTimeoutMs);
    try {
      const r = await fetch(config.workerExchangeUrl, {
        method: 'POST',
        headers,
        body,
        signal: ctrl.signal,
      });
      const text = await r.text();
      if (r.status !== 200) {
        console.error('worker exchange non-200:', r.status, text.slice(0, 200));
        return errorRedirect(res, 'exchange_failed', true);
      }
      workerResp = JSON.parse(text);
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    console.error('worker exchange call failed:', e.message);
    return errorRedirect(res, 'exchange_failed', true);
  }

  if (!workerResp?.session_token) {
    return errorRedirect(res, 'exchange_failed', true);
  }

  // 4. 成功 → 清 cookie + 302 回 .com 落地路由
  const params = new URLSearchParams({
    session: workerResp.session_token,
    return_to: flight.return_to,
  });
  redirect(res, `${config.comCallbackUrl}?${params.toString()}`, {
    'Set-Cookie': buildClearCookie(),
  });
}

// ─── server ───
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      return res.end('method not allowed');
    }
    if (url.pathname === '/auth/wechat/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }
    if (url.pathname === '/auth/wechat/start') {
      return handleStart(req, res, url);
    }
    if (url.pathname === '/auth/wechat/callback') {
      return await handleCallback(req, res, url);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  } catch (e) {
    console.error('unhandled error:', e);
    // 兜底：别把堆栈暴露给用户，跳登录页报通用错
    try {
      errorRedirect(res, 'internal', true);
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('internal error');
      }
    }
  }
});

server.listen(config.port, '127.0.0.1', () => {
  console.log(`[relay] aifeeds-cc-relay listening on 127.0.0.1:${config.port}`);
  console.log(`[relay] worker exchange → ${config.workerExchangeUrl}`);
  console.log(`[relay] return_to allowlist → ${config.returnToAllowlist.join(', ')}`);
});
