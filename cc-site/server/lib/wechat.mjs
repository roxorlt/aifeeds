// 微信开放平台「网站应用」OAuth API 封装。零依赖，用 Node 18+ 全局 fetch。
// 文档：https://developers.weixin.qq.com/doc/oplatform/Website_App/WeChat_Login/Wechat_Login.html

import { config } from './config.mjs';

async function fetchJson(url, label) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.fetchTimeoutMs);
  try {
    const resp = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': config.relayUserAgent } });
    const text = await resp.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`[wechat] ${label} 返回非 JSON：${text.slice(0, 200)}`);
    }
    // 微信错误：{errcode, errmsg}（errcode 非 0 即失败）
    if (data.errcode) {
      throw new Error(`[wechat] ${label} errcode=${data.errcode} errmsg=${data.errmsg}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// 构造扫码登录二维码页 URL（302 到这里，用户扫码）
export function buildQrConnectUrl(state) {
  const params = new URLSearchParams({
    appid: config.wechatAppId,
    redirect_uri: config.wechatRedirectUri,
    response_type: 'code',
    scope: 'snsapi_login',
    state,
  });
  // #wechat_redirect 是微信要求的锚点
  return `https://open.weixin.qq.com/connect/qrconnect?${params.toString()}#wechat_redirect`;
}

// code → access_token + openid (+ unionid，如应用已绑开放平台)
export async function exchangeCodeForToken(code) {
  const params = new URLSearchParams({
    appid: config.wechatAppId,
    secret: config.wechatAppSecret,
    code,
    grant_type: 'authorization_code',
  });
  const data = await fetchJson(
    `https://api.weixin.qq.com/sns/oauth2/access_token?${params.toString()}`,
    'oauth2/access_token',
  );
  return {
    accessToken: data.access_token,
    openid: data.openid,
    unionid: data.unionid, // 可能 undefined
  };
}

// 拉用户昵称 + 头像（snsapi_login 的 access_token 可调）。失败不阻塞登录，返 null。
export async function fetchUserInfo(accessToken, openid) {
  try {
    const params = new URLSearchParams({ access_token: accessToken, openid, lang: 'zh_CN' });
    const data = await fetchJson(
      `https://api.weixin.qq.com/sns/userinfo?${params.toString()}`,
      'sns/userinfo',
    );
    return {
      nickname: typeof data.nickname === 'string' ? data.nickname : null,
      avatarUrl: typeof data.headimgurl === 'string' ? data.headimgurl : null,
      unionid: data.unionid, // userinfo 也会带 unionid，作 access_token 那步的兜底
    };
  } catch {
    // 昵称/头像拿不到不影响登录，用 openid 建号即可
    return null;
  }
}
