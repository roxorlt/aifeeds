// 配置加载 + 启动时校验。所有 secret / URL 走 env，绝不硬编码。
// 部署时 secret 来自 /etc/aifeeds/relay.env（chmod 600），由下方 loadEnvFile 读入。

import { readFileSync, existsSync } from 'node:fs';

// 零依赖 env 文件加载：prod 从 /etc/aifeeds/relay.env 读 secret（不进 web root / git）。
// 已显式设置的 process.env 优先（本地测试 spawn env / CI 注入用），文件只补缺失项。
// 文件不存在则跳过（本地开发 / 测试无需该文件）。
function loadEnvFile() {
  const path = process.env.RELAY_ENV_FILE || '/etc/aifeeds/relay.env';
  if (!existsSync(path)) return;
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 0) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch (e) {
    console.error('[config] 读 env 文件失败:', e.message);
  }
}
loadEnvFile();

function required(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`[config] 缺少必需环境变量 ${name}`);
  }
  return v.trim();
}

function optional(name, fallback) {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

export const config = {
  port: Number(optional('PORT', '3001')),

  // 微信开放平台「网站应用」凭据
  wechatAppId: required('WECHAT_OPEN_APP_ID'),
  wechatAppSecret: required('WECHAT_OPEN_APP_SECRET'),

  // 与 worker 互信的 bridge HMAC 密钥（每环境独立，跟 worker secret 一致）
  bridgeSecret: required('BRIDGE_SECRET'),

  // 给 OAuth 飞行态 cookie 签名的密钥（仅 .cc 自己用，不与 worker 共享）
  stateSecret: required('STATE_SECRET'),

  // 微信回调地址：必须与开放平台「授权回调域名」一致（裸域 ai-feeds.cc）
  // 完整 URL 含 path，code 会回调到这里
  wechatRedirectUri: optional('WECHAT_REDIRECT_URI', 'https://ai-feeds.cc/auth/wechat/callback'),

  // worker exchange endpoint（prod 走 api.ai-feeds.com 经香港中转，自动过回源 gate）
  workerExchangeUrl: optional('WORKER_EXCHANGE_URL', 'https://api.ai-feeds.com/api/auth/wechat/exchange'),

  // .com 前端接收 session 的落地路由
  comCallbackUrl: optional('COM_CALLBACK_URL', 'https://ai-feeds.com/auth/callback'),

  // 登录失败时跳回 .com 的登录页（带 ?error=）
  comLoginUrl: optional('COM_LOGIN_URL', 'https://ai-feeds.com/login'),

  // return_to 白名单前缀（防 open redirect）。逗号分隔，必须 https
  returnToAllowlist: optional('RETURN_TO_ALLOWLIST', 'https://ai-feeds.com/')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // 飞行态 cookie 所在域 + 有效期（秒）
  cookieDomain: optional('COOKIE_DOMAIN', 'ai-feeds.cc'),
  cookieMaxAgeSec: Number(optional('COOKIE_MAX_AGE_SEC', '300')),

  // state nonce / cookie 有效期窗（秒）— 用户停在扫码页超过此值则失效
  stateWindowSec: Number(optional('STATE_WINDOW_SEC', '300')),

  // 调用 worker / 微信 API 的超时（毫秒）
  fetchTimeoutMs: Number(optional('FETCH_TIMEOUT_MS', '8000')),

  // 调 worker 时带的 UA（避开 bot UA gate 拦截名单，且日志可读）
  relayUserAgent: optional('RELAY_USER_AGENT', 'aifeeds-cc-relay/1.0'),
};

// 启动即校验白名单都是 https（防配置错误导致 open redirect）
for (const prefix of config.returnToAllowlist) {
  if (!prefix.startsWith('https://')) {
    throw new Error(`[config] RETURN_TO_ALLOWLIST 项必须是 https：${prefix}`);
  }
}

export function isAllowedReturnTo(url) {
  if (typeof url !== 'string' || !url) return false;
  return config.returnToAllowlist.some((prefix) => url.startsWith(prefix));
}
