# 微信登录架构设计（aifeeds）

> **决策日期**：2026-05-14
> **背景**：`ai-feeds.com` 在 Cloudflare（境外）无法备案，微信开放平台要求 OAuth 回调域名必须备案。结论是用 `ai-feeds.cc`（境内已备案）做无状态 OAuth 中转代理。
> **预设阅读**：已读 [`docs/beian/README.md`](../beian/README.md) + [`docs/memo/2026-05-04-icp-备案讨论备忘录.md`](../memo/2026-05-04-icp-备案讨论备忘录.md)。

## 当前状态

| 节点 | 状态 | 日期 |
|------|------|------|
| `.cc` 备案下证 + footer 双备案 | ✅ | 2026-05-13 |
| `.cc` SSL/HTTPS + HSTS | ✅ | 2026-05-13 |
| `www.ai-feeds.cc` → apex 301（宝塔重定向） | ✅ | 2026-05-14 |
| 微信开放平台企业认证 | ✅ | 2026-05-14 |
| 微信网站应用创建 + 提审 | ⏳ 审核中 | 2026-05-14 提交，约 7 工作日 |
| worker `POST /api/auth/wechat/exchange` | ⏳ | — |
| `.cc` Node + Express OAuth 中转服务 | ⏳ | — |
| dashboard 登录入口 + `/auth/callback` 路由 | ⏳ | — |

## 1. TL;DR

| 关键判断 | 结论 |
|---------|------|
| 跨域问题？ | **不存在**。整套流程是浏览器 navigation（HTTP 302 + location.href），不是 ajax，CORS 不适用。 |
| `.cc` 上有 UI 吗？ | **没有**。两个 endpoint 都是后端纯 302 重定向，浏览器不渲染任何 HTML，地址栏闪过 100-300ms。 |
| `.cc` 需要维护 session 状态吗？ | **不需要**。`.cc` 是无状态中转代理，不写 DB、不存 session、不发 cookie 给用户。 |
| 用户感受到几次跳转？ | **2 次**（去微信扫码 + 回主站），等同于 GitHub OAuth / Google OAuth 标准体验。 |
| 这套架构靠谱吗？ | **靠谱**。知乎、即刻等都跑这个结构多年。微信官方文档明确支持 redirect_uri 跨域。 |

## 2. 角色分工

| 域 | 部署位置 | 角色 | 持久状态 |
|----|---------|------|---------|
| `ai-feeds.com` | Cloudflare Pages + Workers | 主站 + 业务 API + session 签发与校验 | D1 (users / sessions / identities) |
| `ai-feeds.cc` | 腾讯云轻量服务器（82.156.0.68，宝塔 nginx） | **OAuth 中转代理**（2 个 endpoint，纯 302） | **无**（HMAC stateless） |
| `open.weixin.qq.com` | 腾讯 | 微信扫码 / 授权 UI + 颁发 code | 微信自己的 |
| `api.weixin.qq.com` | 腾讯 | code → access_token + openid + unionid | 微信自己的 |

## 3. 完整时序图（PC 扫码登录）

```
用户                .com 前端              .cc 后端              微信
 │                   │                      │                    │
 │  点「微信登录」 │                      │                    │
 │ ──────────────► │                      │                    │
 │                   │                      │                    │
 │                   │ window.location.href = .cc/auth/wechat/start?return_to=...
 │                   │ ───────────────────► │                    │
 │                   │                      │ 1. 生成 state =    │
 │                   │                      │    HMAC(return_to+ts+nonce)
 │                   │                      │ 2. 302 → 微信      │
 │                   │ ◄──── 302 ──────────│                    │
 │                   │                      │                    │
 │                   │ open.weixin.qq.com/connect/qrconnect?appid=...&redirect_uri=.cc/callback&state=...
 │                   │ ───────────────────────────────────────► │
 │                   │                      │                    │
 │  ◄── 看到扫码页 ──────────────────────────────────────────── │
 │                                                                │
 │  用手机微信扫码 + 在 App 内确认                                 │
 │ ──────────────────────────────────────────────────────────► │
 │                                                                │
 │                                          ◄── 302 携带 code ── │
 │                   │                      │                    │
 │                   │ .cc/auth/wechat/callback?code=xxx&state=yyy
 │                   │ ──── 浏览器跳 ──────► │                    │
 │                   │                      │ 3. 校验 state HMAC + 时间窗
 │                   │                      │ 4. POST api.weixin.qq.com/sns/oauth2/access_token
 │                   │                      │ ─────────────────► │
 │                   │                      │ ◄── openid+unionid │
 │                   │                      │                    │
 │                   │                      │ 5. POST api.ai-feeds.com/api/auth/wechat/exchange
 │                   │                      │    body: {openid, unionid, bridge_hmac}
 │                   │                      │    → worker 找/建 user + 签 session_token
 │                   │                      │                    │
 │                   │                      │ 6. 302 →           │
 │                   │ ◄────── 302 ─────────│                    │
 │                   │                      │                    │
 │                   │ .com/auth/callback?session=<token>&return_to=<原页面>
 │                   │                                            │
 │                   │ 7. 前端拿 session → 写 cookie → 跳回原页面 │
 │  ◄── 已登录态 ──│                                            │
```

地址栏在用户视角：

```
ai-feeds.com  →  open.weixin.qq.com  →  ai-feeds.cc (闪过 100ms)  →  ai-feeds.com
                  [显著跳转 1]            [用户察觉不到]              [显著跳转 2]
```

## 4. State HMAC 设计（stateless CSRF token）

`.cc` 不需要 Redis / 数据库存 state，因为 state 自带签名：

```
state = base64url(payload) + "." + base64url(HMAC_SHA256(secret, payload))
payload = JSON.stringify({
  return_to: "https://ai-feeds.com/feed",  // .com 上的原始页面
  ts: 1715680000,                            // Unix 时间戳（秒）
  nonce: "8f3a..."                           // 16 字节随机
})
```

回调时 `.cc` 校验：

1. `payload` + 签名 → 重新计算 HMAC → 对比签名（防伪造）
2. `Date.now()/1000 - payload.ts < 300` （5 分钟过期窗）
3. `payload.return_to` 必须以 `https://ai-feeds.com/` 开头（防 open redirect）

如果三条任一失败 → 302 跳回 `ai-feeds.com/login?error=state_expired`。

**关键好处**：`.cc` 重启 / 升级 / 多实例都不丢 state，因为 state 自身就是携带验证信息的。

## 5. 互信 HMAC 设计（`.cc` ↔ worker）

`.cc` 调 worker 的 `/api/auth/wechat/exchange` 时，必须证明自己是 `.cc` 而不是攻击者随便伪造 openid。

```
POST https://api.ai-feeds.com/api/auth/wechat/exchange
Headers:
  X-Bridge-Timestamp: 1715680000
  X-Bridge-Signature: HMAC_SHA256(BRIDGE_SECRET, timestamp + "." + body_sha256)
Body:
  {"openid": "o6_xxx", "unionid": "u_xxx", "nickname": "...", "avatar_url": "..."}
```

worker 端校验：

1. `Math.abs(Date.now()/1000 - X-Bridge-Timestamp) < 30`（30 秒窗，防 replay）
2. HMAC 签名匹配（用 `worker secret BRIDGE_SECRET` 校验）
3. 通过 → 建 user / 找 user → 签 session_token 返回

`BRIDGE_SECRET` 在：

- worker：`wrangler secret put BRIDGE_SECRET`
- `.cc`：宝塔环境变量或 `/etc/aifeeds/bridge.env`（chmod 600）

不要进仓库，不要写入 `.secrets/` 之外。

## 6. 用户感知与跳转次数

| 场景 | 用户能察觉的页面变化 | 类似产品体验 |
|------|---------------------|-------------|
| PC 浏览器扫码登录（同窗口跳转） | 2 次（去微信扫码页 + 回主站） | 用 GitHub 登 Vercel |
| PC 浏览器扫码登录（popup 进阶） | 0 次主页面跳转，弹窗自开自关 | 用 GitHub 登 Linear |
| 微信内置浏览器（H5 自动授权） | 1 次（一闪而过的授权弹窗） | 用微信登小红书 H5 |
| 退出登录 | 0 次额外跳转（前端调 .com worker 删 session cookie） | 普通退出 |

⚠️ **popup 模式不阻塞 MVP**：先做同窗口跳转跑通整条链路，popup 是后续 UX 优化项，多 50 行 postMessage 代码。

## 7. 错误处理

| 错误 | 何时发生 | 处理 | 用户感知 |
|------|---------|------|---------|
| state HMAC 校验失败 | 攻击 / 篡改 | 302 → .com/login?error=invalid_state | 提示「登录链接异常，请重试」 |
| state 时间窗过期 | 用户停在扫码页 > 5 分钟 | 同上，error=state_expired | 提示「登录超时，请重新发起」 |
| return_to 不在白名单 | open redirect 攻击 | 同上，error=bad_return | 提示「登录链接异常」 |
| 微信 code 换 token 失败 | 微信侧问题 / code 重用 | 302 → .com/login?error=wechat_api | 提示「微信授权异常，请重试」 |
| `.cc` 调 worker 失败（network/5xx） | worker 挂 / 网络不通 | 同上，error=exchange_failed | 提示「服务暂时不可用」+ fallback 入口 |
| bridge HMAC 校验失败 | secret 不匹配 / replay | worker 返回 401，`.cc` 302 → .com/login?error=internal | 提示「系统错误」 |

`.com/login` 页面识别 `?error=` query 参数，根据 code 显示中文提示 + 提供 email auth fallback 入口。

## 8. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| `.cc` 中转服务宕机 | 新用户无法用微信登录 | (a) PushDeer 监控 .cc 进程 + Lighthouse 自带「网站监控」；(b) 登录入口同时挂 email auth fallback |
| `BRIDGE_SECRET` 泄露 | 攻击者可伪造任意 openid 换 session | (a) secret 走 worker + 宝塔环境变量隔离；(b) 季度轮换；(c) 加 IP allowlist（worker 只接受 `.cc` 公网 IP） |
| 微信 `AppSecret` 泄露 | 影响所有调用 `sns/oauth2/access_token` | 同上隔离；微信开放平台后台支持重置 |
| 微信审核要求 `.cc` 有可见内容 | 备案抽查或微信开放平台抽查时找不到登录入口 | `.cc` 5 个静态合规页保持上线（已 ✅）+ `.cc` 不限制爬虫抓取 |
| 用户重复扫码（race condition） | code 被微信判一次性 → 第二次回调失败 | `.cc` 端用 `code` 做 5 分钟去重（内存 LRU 即可） |
| `.cc` 单机故障 | 同上「中转服务宕机」 | 单机够用（QPS 低；若需 HA 再加 SLB+2 节点，state HMAC 天然支持多实例无状态） |

**关键非风险**：跨域、双向 cookie 同步、SSO 同步登出——这些都不存在，因为 `.cc` 完全不接触用户 session。

## 9. 实施清单

### 9.1 worker 端（`api.ai-feeds.com`）

- [ ] `wrangler secret put WECHAT_OPEN_APP_ID`
- [ ] `wrangler secret put WECHAT_OPEN_APP_SECRET`
- [ ] `wrangler secret put BRIDGE_SECRET`（与 `.cc` 共享）
- [ ] 新增 `POST /api/auth/wechat/exchange`（30s replay 窗 + HMAC 校验 + 建 user/identity + 签 session_token）
- [ ] `identities` 表添加 `provider='wechat'` 支持（schema 已预留）
- [ ] `/api/auth/wechat/exchange` 限流（每 IP 每分钟 10 次）

### 9.2 `.cc` 端（腾讯云宝塔 + Node 进程）

- [ ] 宝塔后台软件商店装 Node.js 18 + PM2
- [ ] `cc-site/server/` 新目录：Express + 2 个 handler + state HMAC + bridge HMAC + code 去重 LRU
- [ ] 环境变量：`BRIDGE_SECRET` + `STATE_SECRET` + `WECHAT_OPEN_APP_ID` + `WECHAT_OPEN_APP_SECRET`
- [ ] nginx 反代：`location /auth/wechat/ → proxy_pass http://127.0.0.1:3001`
- [ ] PM2 守护 + 启动脚本 + 监控（`pm2 logs` / `pm2 monit`）
- [ ] `cc-site/deploy.sh` 扩展支持 server/ 部署 + PM2 reload

### 9.3 dashboard（`ai-feeds.com`）

- [ ] 登录弹窗加「微信登录」按钮（lucide icon + 微信品牌色 #07C160）
- [ ] 点击 → `window.location.href = 'https://ai-feeds.cc/auth/wechat/start?return_to=' + encodeURIComponent(location.href)`
- [ ] 新增路由 `/auth/callback?session=...&return_to=...`：解 session_token → 写 cookie（与现有 email auth 同机制） → `location.replace(return_to)`
- [ ] 新增路由 `/login?error=...`：解 error code 显示中文提示

### 9.4 可观测性

- [ ] worker 端打点：`wechat_exchange_success/failure_total{reason}`（CF Analytics Engine）
- [ ] `.cc` 端 access log + PM2 logs 滚动
- [ ] 监控告警：`.cc` 进程 down / nginx 5xx 飙升 → PushDeer

## 10. FAQ（澄清常见误解）

### Q1：为什么不直接让 `.com` 自己接微信登录？

`.com` 在 Cloudflare（境外），无法通过 ICP 备案。微信开放平台**强制要求**「授权回调域名」必须已备案（[官方文档](https://developers.weixin.qq.com/doc/oplatform/Website_App/WeChat_Login/Wechat_Login.html)），所以 redirect_uri 只能配 `.cc`。

### Q2：为什么不把整个主站迁到境内？

成本：Cloudflare 全球 CDN + R2 + Workers 这套架构换境内会损失全球访问体验、增加运维复杂度（多云）；境内 SaaS 用户群尚未到必须本地化的体量。

### Q3：`.cc` 中转会不会被微信判定「诱导跳转」风控？

不会。诱导跳转风控针对的是「**用户主动行为之外的隐式跳转 + 落地页跟用户意图不符**」。我们的流程：

- 用户**主动点击**「微信登录」按钮
- 跳转链路对应「**OAuth 授权流程**」是微信官方支持的标准操作
- redirect_uri 在审核时就已经登记在白名单里
- 落地页（`.com`）的内容和用户意图一致

⚠️ 真要小心诱导跳转的是**分享场景**：从 `.cc/s/<token>` 跳到 `.com/t/<id>` 不能用 JS / meta refresh 立即跳转，必须「预览页 + 用户主动点击」——但这是另一条链路，跟登录无关。

### Q4：state HMAC 如果 secret 泄露怎么办？

`STATE_SECRET` 只用于 state token 签名，泄露后**攻击者可伪造 state 但不能伪造 openid**（openid 来自微信 API + bridge HMAC 二次校验）。最坏后果是「攻击者可发起以任意 return_to 为目的的登录链接」——但 return_to 我们已限制白名单到 `https://ai-feeds.com/`，所以最坏只能引导用户登录到我们自己的页面，无危害。

`BRIDGE_SECRET` 泄露才是严重事故（攻击者可伪造任意 openid 拿到任意 user session），所以两个 secret 必须分开存储、分开轮换。

### Q5：用户用了微信扫码登录后，能不能再绑手机号 / email？

可以。`identities` 表设计是 `(user_id, provider, provider_user_id)` 一对多，同一 user 可挂多个 identity。微信登录后，用户进「账号设置」可绑定手机号 / email 作为找回手段。具体 UX 实施清单后置，不阻塞登录 MVP。

### Q6：未来要不要把 `.cc` 升级成完整 SSR 站点？

是。`docs/memo/2026-05-07-seo-geo-discussion-memo.md` 已规划 `.cc` 作为国内 SEO/GEO 镜像站（A 方案：从 `.com` 抓取 + 翻译生成静态页）。届时 `.cc` 上会同时跑：

- 静态合规页（现状）
- OAuth 中转服务（本文档）
- 国内 SEO 静态镜像（未来）

三者用 nginx location 隔离，互不冲突。

### Q7：授权回调域名为什么填根域 `ai-feeds.cc` 而不是 `www.ai-feeds.cc`？

微信网站应用的「授权回调域名」是**精确匹配**——填什么，redirect_uri 的域名部分就必须完全一致。架构里我们的回调地址定为 `https://ai-feeds.cc/auth/wechat/callback`，所以填**根域**。

同时为了避免用户从 `www` 子域访问后因为「域名不匹配」无法登录，2026-05-14 在宝塔后台加了 `www.ai-feeds.cc` → `https://ai-feeds.cc` 301（域名重定向，保留路径），并已 curl 验证。

## 11. 参考资料

- 微信网站应用登录开发指南：https://developers.weixin.qq.com/doc/oplatform/Website_App/WeChat_Login/Wechat_Login.html
- RFC 6749 OAuth 2.0 Authorization Code Flow：https://datatracker.ietf.org/doc/html/rfc6749#section-4.1
- ICP 备案讨论备忘录：[`../memo/2026-05-04-icp-备案讨论备忘录.md`](../memo/2026-05-04-icp-备案讨论备忘录.md)
- 备案号 + footer 资料：[`../beian/README.md`](../beian/README.md)
- `.cc` 站点源码：[`../../cc-site/`](../../cc-site/)
