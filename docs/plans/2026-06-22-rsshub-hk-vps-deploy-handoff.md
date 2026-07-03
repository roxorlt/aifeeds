# RSSHub HK VPS 部署交付

> 日期：2026-06-22
> 服务：自托管 RSSHub，为 aifeeds Cloudflare Worker 提供小宇宙播客 RSS 入口
> 入口：`https://rss.ai-feeds.com`

## 1. Worker 侧配置

prod 环境变量已写入：

- 文件：`/Users/roxor/brain/30-projects/aifeeds/.secrets/aifeeds-prod.env`
- `RSSHUB_BASE=https://rss.ai-feeds.com`
- `RSSHUB_TOKEN=<已写入 env，不在文档明文展开>`

服务端原始 token 位置：

- HK VPS：`/etc/rsshub/rsshub_token`
- 权限：`600`

Worker 请求需要带：

```http
X-RSSHub-Token: <RSSHUB_TOKEN>
```

## 2. 已上线端点

Base URL：

```text
https://rss.ai-feeds.com
```

nginx 行为：

- 正确 `X-RSSHub-Token`：反代到 `127.0.0.1:1200`
- 无 token：`403`
- 错 token：`403`
- `/healthz` 也需要 token，正确 token 返回 `200`

## 3. 已验证路由

| 播客 | RSSHub route | HTTPS 状态 | item 数 |
|---|---|---:|---:|
| 硅谷101 | `/xiaoyuzhou/podcast/5e5c52c9418a84a04625e6cc` | 200 | 15 |
| OnBoard! | `/xiaoyuzhou/podcast/61cbaac48bb4cd867fcabe22` | 200 | 15 |
| AI 前线 | `/xiaoyuzhou/podcast/679d8c5ded7799e793bb7936` | 200 | 15 |
| 张小珺Jùn｜商业访谈录 | `/xiaoyuzhou/podcast/626b46ea9cbbf0451cf5a962` | 200 | 15 |

鉴权 smoke test：

- 无 token：403
- 错 token：403
- 正确 token `/healthz`：200

## 4. 机器与服务

HK VPS：`154.12.188.231`

当前配置：

- 1 vCPU
- 960MiB RAM
- 1GiB swap
- 20G disk

RSSHub：

- systemd service：`rsshub.service`
- 状态：enabled / active
- 监听：`127.0.0.1:1200`
- 不直接暴露公网
- Node：`v22.22.2`
- RSSHub commit：`9807609`
- package version：`1.0.0`

TLS：

- 证书：Let’s Encrypt
- 域名：`rss.ai-feeds.com`
- 到期：`2026-09-20`
- certbot 自动续期已启用

DNS：

- Cloudflare A：`rss.ai-feeds.com -> 154.12.188.231`
- 灰云 / DNS only

## 5. 资源保护

RSSHub 被配置成可牺牲服务，优先保护现有 nginx 中转：

- `MemoryHigh=300M`
- `MemoryMax=350M`
- Node `--max-old-space-size=256`
- RSSHub `OOMScoreAdjust=500`
- nginx `OOMScoreAdjust=-900`
- nginx 限流：`limit_req zone=perip_req burst=20 nodelay`
- nginx 连接限制：`limit_conn perip_conn 20`

## 6. 更新策略

当前锁定 commit `9807609`，不自动更新。小宇宙路由后续若因上游页面变化失效，再手动拉新 RSSHub commit、本机构建、上传产物、滚动切换 `/opt/rsshub/current`。
