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
| 微信网站应用创建 + 提审 | ⏳ 审核中 | 2026-05-14 提交 |
| worker `POST /api/auth/wechat/exchange`（PR1） | ✅ 合入 main #97 + staging e2e 4/4 | 2026-05-20 |
| `.cc` 零依赖 Node OAuth 中转服务（PR2） | ✅ 代码 + 本地冒烟 21/21 + relay↔worker 交叉验证 | 2026-06-02 |
| dashboard 登录入口 + `/auth/callback` 路由（PR3） | ⏳ | — |
| `.cc` 服务器部署中转服务 | ⏳ 需正式 AppID + 微信审核过 | — |

> **⚠️ 2026-06-02 香港中转加速上线后复核**：`api.ai-feeds.com` 现在走香港 VPS 反代 + 回源密钥 gate（详见 [`../operations.md`](../operations.md) §6b）。已确认本登录方案**整体仍成立、无需改动 gate**，详见下方 [§5b](#5b-与香港中转加速架构的交互2026-06-02-后)。

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

`.cc` 不需要 Redis / 数据库存 state。但有个**实现约束**：微信 qrconnect 的 `state`
参数有长度限制（~128 字节），塞不下完整 `return_to`。所以 PR2 实现采用**签名 cookie**
方案——bulky 数据放 cookie，发给微信的 state 只放短 nonce：

```
/start：
  nonce = random(16 bytes)
  飞行态 = signFlightState({return_to, device_id, nonce, ts}, STATE_SECRET)
         = base64url(payload) + "." + HMAC_SHA256(STATE_SECRET, payload)
  Set-Cookie: wx_oauth=<飞行态>  (Domain=ai-feeds.cc, HttpOnly, Secure, SameSite=Lax,
                                  Path=/auth/wechat, Max-Age=300)
  302 → 微信 qrconnect?...&state=<nonce>     ← state 只放短 nonce

/callback：
  读 wx_oauth cookie → verifyFlightState（验签）→ 拿回 {return_to, device_id, nonce, ts}
  校验：
    1. cookie 验签通过（防伪造）
    2. Date.now()/1000 - ts < 300（5 分钟窗）
    3. cookie.nonce === 微信带回的 state（CSRF 防护）
    4. return_to 以 https://ai-feeds.com/ 开头（防 open redirect）
  任一失败 → 302 → ai-feeds.com/login?error=<code>
```

**为什么 cookie 能撑过微信往返**：`wx_oauth` 设在 `ai-feeds.cc` 域、`/start` 时种下；
微信扫码后 302 回 `ai-feeds.cc/auth/wechat/callback`（同域顶级 GET 导航），SameSite=Lax
允许跨站顶级 GET 携带 cookie，所以回调能读到。服务端**仍无状态**（不存 session / 不写 DB），
重启不丢正在进行的登录以外的任何东西（飞行中的那个登录失败用户重试即可）。

**单实例约束**：code 去重用进程内存 Map（systemd 单实例运行）。飞行态本身在
cookie 里（无状态），但 code 去重表在内存；多实例需换共享存储，当前单实例够用。

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

- worker：`wrangler secret put BRIDGE_SECRET`（prod / staging 各一个独立值，已落 `.secrets/aifeeds-{prod,staging}.env`）
- `.cc`：宝塔环境变量或 `/etc/aifeeds/bridge.env`（chmod 600）

不要进仓库，不要写入 `.secrets/` 之外。

## 5b. 与香港中转加速架构的交互（2026-06-02 后）

> 2026-06-02 上线香港 VPS 中转：`ai-feeds.com` / `www` / `api` / `fonts` 改走香港 VPS（`154.12.188.231`）反代回 CF（详见 [`../operations.md`](../operations.md) §6b）。这给登录链路加了两道关卡，本节复核**本方案整体仍成立，无需改 gate**。

### 新增的两道 gate（worker 入口，在所有路由之前）

1. **回源密钥 gate**：prod worker 校验 `X-Origin-Secret`（香港 nginx 注入）。无密钥且非豁免的请求一律 403。豁免名单：`admin.ai-feeds.com` / `/api/webhook/resend` / `/api/digest/return` / `X-Dev-Token`。**staging 不设密钥 = gate 关闭**。
2. **Bot UA gate**：拦 `curl/` `wget/` `python-requests` `okhttp` `go-http-client` 等 UA。

### 登录链路如何穿过这两道 gate（关键结论）

```
.cc 中转服务（腾讯云 82.156.0.68，境内）
  → POST https://api.ai-feeds.com/api/auth/wechat/exchange
  → DNS 解析 api.ai-feeds.com = 154.12.188.231（香港 VPS）
  → 香港 nginx 注入 X-Origin-Secret + 反代到 xlist-api.ltsms86.workers.dev
  → worker 回源密钥 gate：X-Origin-Secret 命中 → ✅ 放行（无需加豁免）
  → worker bot UA gate：.cc 用 Node fetch（undici/axios UA，不在拦截名单）→ ✅ 放行
  → handleWechatExchange 跑 bridge HMAC 校验 → 建/找 user → 签 session
```

- **回源 gate**：`.cc` 调 `api.ai-feeds.com`（而非直连 `*.workers.dev`），香港 nginx 自动注入密钥，gate 天然放行。**不需要**把 `/api/auth/wechat/exchange` 加进豁免名单——加了反而会让它能被直连 workers.dev 白嫖。bridge HMAC 是这个 endpoint 真正的身份校验，回源 gate 只是额外一层。
- **Bot UA gate**：`.cc` 中转服务必须用 Node `fetch`（undici）或 axios（UA 不在拦截名单），**不要用 curl / python-requests 风格 UA**。PR2 实现时给中转服务设显式 UA `aifeeds-cc-relay/1.0`，既可读又确保不撞名单。
- **真实用户 IP**：worker exchange handler 的 IP 从 `body.ip` 取（`.cc` 捕获的真实用户 IP），**不用** `client-ip.ts` 的 `getClientIp`——因为这个 endpoint 的「请求方」是 `.cc` 服务器不是终端用户（handler 内有注释防误改）。

### `.cc` 中转服务仍部署在腾讯云，不迁香港

香港 VPS 虽然也是我控制的公网服务器，但**微信 OAuth 回调域名必须是 ICP 备案域名 `ai-feeds.cc`**（京ICP备2025123594号-2），而备案要求境内主机 = 腾讯云 `82.156.0.68`。香港对 ICP 而言算境外，承载的是未备案的 `.com`。所以 `.cc/auth/wechat/*` 这套中转**只能跑在腾讯云**，香港 VPS 不参与登录链路。

### 部署期注意

- **prod 部署顺序**（同 operations.md §6b 硬要求）：本 PR 系列上 prod 时，回源 gate 已在 prod 生效，`.cc` 必须调 `api.ai-feeds.com`（带密钥）才能过 gate。staging 阶段 gate 关闭，`.cc` 调 `staging-api.ai-feeds.com` 直连验证即可。
- **session cookie 不受香港 cookie-domain 隐患影响**：worker exchange **不发 Set-Cookie**，session_token 走 JSON 返回，由 `.com` 前端 `/auth/callback` 自己写 cookie（见 §3 时序图 step 7）。operations.md §6b 提到的「api 反代用 workers.dev Host 导致 cookie domain 受影响」对登录链路无影响。

## 6. 用户感知与跳转次数

| 场景 | 用户能察觉的页面变化 | 类似产品体验 |
|------|---------------------|-------------|
| PC 浏览器扫码登录（同窗口跳转） | 2 次（去微信扫码页 + 回主站） | 用 GitHub 登 Vercel |
| PC 浏览器扫码登录（popup 进阶） | 0 次主页面跳转，弹窗自开自关 | 用 GitHub 登 Linear |
| 微信内置浏览器（H5 自动授权） | 1 次（一闪而过的授权弹窗） | 用微信登小红书 H5 |
| 退出登录 | 0 次额外跳转（前端调 .com worker 删 session cookie） | 普通退出 |

⚠️ **popup 模式不阻塞 MVP**：先做同窗口跳转跑通整条链路，popup 是后续 UX 优化项，多 50 行 postMessage 代码。

## 7. 错误处理

relay 失败时一律 `302 → ai-feeds.com/login?error=<code>` + 清 `wx_oauth` cookie。
下表 `code` 为 relay 实际发出的值（`relay.mjs errorRedirect`），PR3 的 `/login` 页据此显示中文提示：

| error code | 何时发生 | 用户感知建议文案 |
|------------|---------|----------------|
| `bad_return` | return_to 不在白名单（open redirect 防护） | 登录链接异常，请重试 |
| `wechat_denied` | 用户在微信里取消授权（无 code） | 已取消微信授权 |
| `state_invalid` | wx_oauth cookie 缺失 / 验签失败（伪造 / 跨设备） | 登录链接异常，请重新发起 |
| `state_expired` | 停在扫码页 > 5 分钟 | 登录超时，请重新发起 |
| `state_mismatch` | cookie.nonce ≠ 微信带回 state（CSRF） | 登录链接异常，请重试 |
| `code_replay` | 同一 code 5 分钟内重复回调 | 请勿重复操作，请重新登录 |
| `wechat_api` | 微信 code 换 token 失败（code 失效 / 微信侧问题） | 微信授权异常，请重试 |
| `exchange_failed` | 调 worker 失败 / worker 非 200（含 bridge HMAC 不匹配 401） | 服务暂时不可用，请稍后重试或用邮箱登录 |
| `internal` | relay 未捕获异常兜底 | 系统错误，请稍后重试 |

`.com/login` 页面识别 `?error=` query 参数，显示对应中文提示 + 提供 email auth fallback 入口。

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

### 9.1 worker 端（`api.ai-feeds.com`）— PR1 ✅ 已合入 main（#97）

- [x] `wrangler secret put BRIDGE_SECRET`（staging 已配；prod 待 PR2 上线前配）
- [x] 新增 `POST /api/auth/wechat/exchange`（30s replay 窗 + HMAC 校验 + 建 user/identity + 签 session_token）
- [x] `identities` 表 `provider='wechat'` 支持（schema 已预留，无需 migration）
- [x] staging e2e 4/4 通过 + relay crypto 交叉验证通过
- [ ] prod 部署 + `wrangler secret put WECHAT_OPEN_APP_ID/SECRET/BRIDGE_SECRET`（PR2/PR3 一起上 prod 时）
- 注：exchange 不做 IP 限流（请求方是 .cc 单 IP，限流无意义；bridge HMAC 是真正防护）

### 9.2 `.cc` 端（腾讯云宝塔 + Node 进程）— PR2 ✅ 代码完成

- [x] `cc-site/server/`：**零依赖 Node**（非 Express）+ 2 路由 + 签名 cookie 飞行态 + bridge HMAC + code 去重
- [x] state 用签名 cookie（避微信 state 长度限制）+ bridge HMAC（与 worker 交叉验证通过）
- [x] `aifeeds-cc-relay.service`（systemd，非 pm2）+ `nginx-auth-wechat.conf`（反代 + 限流）+ `fail2ban-aifeeds-relay.conf`
- [x] `deploy-to-cc.sh`：Mac 一键部署（装 Node 18 + 专用用户 + 代码到 /opt + secret + systemd + 健康检查）
- [x] 本地冒烟 21/21 通过
- [x] **2026-06-02 部署到 .cc 服务器 + 真实微信扫码端到端通过**（昵称「刘彤」+ 头像落库，staging 库建用户，session 有效）
- [ ] 服务器加固落地（nginx 限流 + fail2ban，链路验通后补，见 README §🛡️）

### 9.3 dashboard（`ai-feeds.com`）— PR3 待开

**登录方式路由矩阵**（2026-06-02 PM 定，PR3 核心）：

| 环境 | 检测 | 登录方式 | turnstile |
|------|------|---------|-----------|
| 微信内置浏览器 | UA 含 `MicroMessenger` | 微信登录（⚠️ 需公众号网页授权，见下注，PR4） | ❌ 去掉 |
| PC + 大陆 IP | 桌面 UA + 大陆 IP | **微信扫码登录**（本方案，PR1+2 已通） | ❌ 微信登录不需要 |
| PC + 非大陆 IP | 桌面 UA + 非大陆 IP | 邮箱验证码 | ✅ |
| 移动端 + 非微信浏览器 | 移动 UA + 非 MicroMessenger | 邮箱验证码 | ✅ |

> ⚠️ **微信内置浏览器那一支（5.1）≠ 本方案**：网站应用 qrconnect（PC 扫码 snsapi_login）在微信内浏览器用不了。微信内登录需「公众号网页授权」（`oauth2/authorize` + `snsapi_userinfo`），是另一套流程 + 需要**服务号**（网页授权域名 = ai-feeds.cc）。两者同开放平台账号下共享 unionid → 同一用户（`identity_value=unionid` 已兼容）。**PR3 先做 PC + 移动端路由 + PC 扫码；微信内浏览器这支等服务号到位再补（PR4），当前保留「请用 Safari 打开」提示兜底。**
>
> IP 归属判定：大陆 vs 非大陆，可用 CF `request.cf.country === 'CN'`（worker 透传给前端）或前端 IP 库。香港中转后真实 IP 取法见 [`../operations.md`](../operations.md) §6b。

PR3 实施项：
- [ ] 环境检测工具：`isWechatBrowser()` / `isMobile()` / `isMainlandIP()`（country 从 worker 透传）
- [ ] 登录弹窗按矩阵路由：微信登录按钮（绿 #07C160 + lucide）vs 邮箱验证码（带 turnstile）
- [ ] 微信按钮点击 → `https://ai-feeds.cc/auth/wechat/start?return_to=<当前页>&device_id=<did>`
- [ ] 新增路由 `/auth/callback?session=...&return_to=...`：解 session_token → 写 cookie（与现有 email auth 同机制）→ `location.replace(return_to)`
- [ ] `/login?error=...`：解 error code 显示中文提示（错误码见 §7 + relay errorRedirect）

### 9.4 可观测性

- [ ] worker 端打点：`wechat_exchange_success/failure_total{reason}`（CF Analytics Engine）
- [ ] `.cc` 端 access log + journald（`journalctl -u aifeeds-cc-relay`）
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
