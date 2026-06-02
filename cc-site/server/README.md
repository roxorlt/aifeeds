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
| `deploy-to-cc.sh` | **一键部署**（Mac 上跑，SSH 完成全部安装/配置） |
| `aifeeds-cc-relay.service` | systemd 单元（守护 + 开机自启 + 加固） |
| `nginx-auth-wechat.conf` | nginx 反代 + 限流片段 |
| `fail2ban-aifeeds-relay.conf` | fail2ban jail（与香港 VPS 对齐） |
| `.env.example` | 环境变量样例 |

> 进程管理用 **systemd**（非 pm2）：零依赖服务更轻，systemd 原生开机自启 + 沙箱加固。
> 代码部署在 `/opt/aifeeds-cc-relay`（web 根目录外，nginx 不会吐源码）。

## 状态处理（为什么用 cookie 不用 state）

微信 qrconnect 的 `state` 参数有长度限制（~128B），塞不下完整 `return_to`。
所以：发给微信的 `state` 只放**短 nonce**；`return_to` / `device_id` 放**签名 cookie**
（`wx_oauth`，`.cc` 域，HttpOnly + Secure + SameSite=Lax，5min）。回调时校验
`cookie.nonce === state` 做 CSRF。服务端**无状态**（不存 session / 不写 DB）。

---

## 部署步骤（腾讯云 .cc 服务器）

### 1. 一键部署（在 Mac 上跑）

```bash
# 自动 SSH 到 .cc：装 Node 18 + 建专用用户 + 传代码到 /opt + 写 secret + systemd + 健康检查
./cc-site/server/deploy-to-cc.sh staging   # 先指向 staging worker 试链路
# 验通后切 prod：
./cc-site/server/deploy-to-cc.sh prod
```

脚本从本地 `.secrets/aifeeds-{prod,staging}.env` 读 secret（加密传输、不打印），
`STATE_SECRET` 自动随机生成。无需手动 ssh / 填 env。

实际落点（脚本自动完成）：
- 代码 → `/opt/aifeeds-cc-relay/`（web 根目录外）
- secret → `/etc/aifeeds/relay.env`（600 root，systemd EnvironmentFile 注入）
- 守护 → systemd `aifeeds-cc-relay.service`（开机自启 + 沙箱加固）
- 运行用户 → `aifeeds-relay`（非 root 专用系统用户）

### 2. 配 nginx 反代（`/auth/wechat/*` → 127.0.0.1:3001）

把下面这段加进 ai-feeds.cc 的 server 块（宝塔站点配置 `html_ai-feeds.cc.conf` 的
`#REWRITE-END` 之后，或宝塔「网站→设置→配置文件」里）：

```nginx
location ^~ /auth/wechat/ {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 15s;
    add_header Cache-Control "no-store" always;
}
```

`nginx -t && nginx -s reload`。限流（limit_req）+ fail2ban 是加固项，链路验通后补（见 §🛡️ + `nginx-auth-wechat.conf`）。

### 3. 确认微信开放平台「授权回调域名」= `ai-feeds.cc`

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
# 1. 进程健康（本地）
curl -s http://127.0.0.1:3001/auth/wechat/health      # ok

# 2. /start 重定向（经 nginx 公网，应 302 到 open.weixin.qq.com + Set-Cookie wx_oauth）
curl -sI "https://ai-feeds.cc/auth/wechat/start?return_to=https%3A%2F%2Fai-feeds.com%2Ffeed" | grep -iE "location|set-cookie"

# 3. 本地冒烟（crypto + 路由，21 项）
cd /opt/aifeeds-cc-relay && node test/smoke.mjs

# 4. 真实扫码：浏览器开上面的 start URL → 微信扫码 → 看是否跳回 ai-feeds.com/auth/callback?session=...
```

## 运维

```bash
journalctl -u aifeeds-cc-relay -f         # 看日志（实时）
journalctl -u aifeeds-cc-relay -n 50      # 最近 50 行
sudo systemctl restart aifeeds-cc-relay   # 重启（改代码 / 改 secret 后）
sudo systemctl status aifeeds-cc-relay    # 状态
fail2ban-client status nginx-limit-req-cc # 看封了谁（加固后）
fail2ban-client set nginx-limit-req-cc unbanip <IP>  # 解封误伤
```

**回滚（关掉微信登录）**：worker 侧 `wrangler secret put ENABLE_WECHAT_LOGIN`（设 `false`）让 exchange 返 503；或 `sudo systemctl stop aifeeds-cc-relay` 让 `/start` 502（前端 fallback email 登录）。

**改 secret / 切 staging↔prod worker**：编辑 `/etc/aifeeds/relay.env`（`WORKER_EXCHANGE_URL` + 对应 `BRIDGE_SECRET`）→ `sudo systemctl restart aifeeds-cc-relay`。或直接重跑 `deploy-to-cc.sh staging|prod`（注意会重生成 STATE_SECRET，使飞行中的登录失效，无害）。
