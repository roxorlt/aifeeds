# ai-feeds.cc 微信登录中转服务

无状态 OAuth 中转代理，跑在腾讯云 `.cc` 服务器（`82.156.0.68`，宝塔）。
微信扫码登录的「中间一跳」：用户在 `ai-feeds.com` 发起 → 经本服务（备案域名 `ai-feeds.cc`）中转到微信 → 换 openid → 调 worker 签 session → 跳回 `.com`。

> **完整架构**：[`../../docs/wechat/architecture.md`](../../docs/wechat/architecture.md)
> **为什么必须跑在腾讯云不迁香港**：微信 OAuth 回调域名必须 ICP 备案 = 境内主机（architecture.md §5b）

## 零依赖

只用 Node 内置 `http` / `crypto` / 全局 `fetch`，**无任何 npm 运行时依赖**——登录这种安全敏感组件不引供应链风险。要求 **Node ≥ 18**（推荐 20+）。

## 文件清单

| 文件 | 作用 |
|------|------|
| `relay.mjs` | 主服务：`/auth/wechat/start` + `/callback` + `/health` |
| `lib/config.mjs` | env 加载（从 `/etc/aifeeds/relay.env`）+ 启动校验 |
| `lib/crypto.mjs` | 飞行态 cookie 签名/验签 + bridge HMAC + sha256 |
| `lib/wechat.mjs` | 微信 API：qrconnect URL / code→openid / userinfo |
| `test/smoke.mjs` | 本地冒烟（crypto + 路由 + 错误路径，21 项） |
| `ecosystem.config.cjs` | PM2 守护配置 |
| `nginx-auth-wechat.conf` | nginx 反代 + 限流片段 |
| `fail2ban-aifeeds-relay.conf` | fail2ban jail（与香港 VPS 对齐） |
| `.env.example` | 环境变量样例 |

## 状态处理（为什么用 cookie 不用 state）

微信 qrconnect 的 `state` 参数有长度限制（~128B），塞不下完整 `return_to`。
所以：发给微信的 `state` 只放**短 nonce**；`return_to` / `device_id` 放**签名 cookie**
（`wx_oauth`，`.cc` 域，HttpOnly + Secure + SameSite=Lax，5min）。回调时校验
`cookie.nonce === state` 做 CSRF。服务端**无状态**（不存 session / 不写 DB）。

---

## 部署步骤（腾讯云 .cc 服务器）

### 1. 装 Node（宝塔软件商店 或 nvm）

```bash
node -v   # 确认 ≥ 18，没有就装
npm i -g pm2
```

### 2. 上传代码

```bash
# 本地（仓库根）：把 server/ 传到站点目录
cd cc-site && ./deploy.sh     # deploy.sh 已含 server/ 同步 + pm2 reload（见下方「自动部署」）
# 或手动 scp 整个 cc-site/server → /www/wwwroot/ai-feeds.cc/server
```

### 3. 配 secret（不进 git / web root）

```bash
sudo mkdir -p /etc/aifeeds
sudo cp /www/wwwroot/ai-feeds.cc/server/.env.example /etc/aifeeds/relay.env
sudo vim /etc/aifeeds/relay.env      # 填 WECHAT_OPEN_APP_ID / SECRET / BRIDGE_SECRET / STATE_SECRET
sudo chmod 600 /etc/aifeeds/relay.env
sudo chown root:root /etc/aifeeds/relay.env
```

- `WECHAT_OPEN_APP_ID` / `WECHAT_OPEN_APP_SECRET`：微信开放平台网站应用凭据
- `BRIDGE_SECRET`：**必须与 worker 的 `BRIDGE_SECRET` 一致**（prod 用 prod 值，见 `.secrets/aifeeds-prod.env`）
- `STATE_SECRET`：随机 `openssl rand -hex 32`（仅 .cc 自用）

### 4. 起进程

```bash
sudo mkdir -p /var/log/aifeeds-cc-relay
cd /www/wwwroot/ai-feeds.cc/server
pm2 start ecosystem.config.cjs
pm2 save                              # 存进程列表
pm2 startup                           # 生成开机自启（按提示跑它输出的命令）
curl -s http://127.0.0.1:3001/auth/wechat/health    # → ok
```

### 5. 配 nginx（见 `nginx-auth-wechat.conf` 内注释）

- **A 段** limit_req_zone → `/www/server/nginx/conf/conf.d/aifeeds-relay.conf`
- **B 段** location → 宝塔「网站 → ai-feeds.cc → 设置 → 配置文件」的 `server{}` 内
- `nginx -t && systemctl reload nginx`

### 6. 确认微信开放平台「授权回调域名」= `ai-feeds.cc`

（裸域，不带 https://、不带路径——见 architecture.md §Q7）

---

## 🛡️ 服务器加固清单（与香港 VPS 拉齐）

本服务公网暴露登录端点，安全等级要与香港 VPS 一致：

- [ ] **secret 存储**：`/etc/aifeeds/relay.env` chmod 600 + root 属主，不在 web root（`/www/wwwroot/ai-feeds.cc/` 下不能有）、不进 git
- [ ] **nginx 限流**：`nginx-auth-wechat.conf` 的 limit_req（每 IP 10r/s burst 20）已生效——`curl` 压一下看 429
- [ ] **fail2ban**：`fail2ban-aifeeds-relay.conf` → `/etc/fail2ban/jail.d/`，`systemctl restart fail2ban`，`fail2ban-client status nginx-limit-req-cc`
- [ ] **防火墙**：`ufw status`（或宝塔安全）确认只放行 22/80/443，8888 已关（2026-05-13 已关）
- [ ] **SSH**：禁密码登录、仅密钥（宝塔默认或手动）
- [ ] **进程隔离**：relay 监听 `127.0.0.1:3001`（已硬编码 bind 127.0.0.1，不对公网暴露端口）
- [ ] **HTTPS**：`/auth/wechat/*` 走 443（已有 Let's Encrypt 证书，2026-05-13 配）

> 调用链（.cc → worker）本身已用 bridge HMAC（每请求签名 + 30s 重放窗），比香港 VPS↔CF 的静态回源密钥更强，无需额外加固。详见 architecture.md §5b。

---

## 验证

```bash
# 1. 进程健康
curl -s http://127.0.0.1:3001/auth/wechat/health      # ok

# 2. /start 重定向（应 302 到 open.weixin.qq.com，且 Set-Cookie wx_oauth）
curl -sI "https://ai-feeds.cc/auth/wechat/start?return_to=https%3A%2F%2Fai-feeds.com%2Ffeed" | grep -iE "location|set-cookie"

# 3. 本地冒烟（crypto + 路由，21 项）
cd /www/wwwroot/ai-feeds.cc/server && node test/smoke.mjs

# 4. 真实扫码：浏览器开上面的 start URL → 微信扫码 → 看是否跳回 ai-feeds.com/auth/callback?session=...
```

## 运维

```bash
pm2 logs aifeeds-cc-relay            # 看日志
pm2 restart aifeeds-cc-relay         # 重启
pm2 reload aifeeds-cc-relay          # 0 停机重载（改 secret 后）
fail2ban-client status nginx-limit-req-cc          # 看封了谁
fail2ban-client set nginx-limit-req-cc unbanip <IP>  # 解封误伤
```

**回滚（关掉微信登录）**：worker 侧 `wrangler secret put ENABLE_WECHAT_LOGIN`（设 `false`）即可让 exchange 返 503；或 `pm2 stop aifeeds-cc-relay` 让 `/start` 502（前端 fallback email 登录）。

## staging 联调

`/etc/aifeeds/relay.env` 里把 `WORKER_EXCHANGE_URL` 改成 `https://staging-api.ai-feeds.com/api/auth/wechat/exchange`（staging 回源 gate 关闭，可直连），`BRIDGE_SECRET` 用 staging 值。联调完改回 prod。
