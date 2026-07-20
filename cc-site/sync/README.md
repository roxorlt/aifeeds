# ai-feeds.cc 静态内容同步器

零运行时依赖的 Node.js 18+ 同步器。它通过独立 HMAC API 从 `.com` 的审核权威增量拉取
已经允许在大陆发布的页面，校验 SHA-256 后写入 `.cc` 的 `/i/`，再在 state 目录构建
归档页与 sitemap generation，并原子切换 `public/current`。

## 文件与所有权边界

| 路径 | 所有者与用途 |
|---|---|
| `/opt/aifeeds-cc-sync` | `root:root`，同步器代码与远端测试，只读 |
| `/etc/aifeeds/cc-sync.env` | `root:root 0600`，systemd 环境文件 |
| `/var/lib/aifeeds-cc-sync` | `aifeeds-sync:www 0750`，state、锁与生成的归档/sitemap |
| `/www/wwwroot/ai-feeds.cc/i` | `aifeeds-sync:www 0750`，唯一写入站点根的生成目录 |

systemd service 使用 `UMask=0027`，生成目录/文件保持 Nginx 用户 `www` 可遍历、可读，
但 group/other 不可写。`ProtectSystem=strict` 下唯一 `ReadWritePaths` 是 state 目录与
`/i`。同步用户不能写站点首页、隐私条款、提示词库、四个搜索验证文件、微信 relay、
`/auth/wechat/`、旧 `/ai-news` 或 `/etc/aifeeds`。

归档和 sitemap 不写进 web root：

- `/var/lib/aifeeds-cc-sync/public/current/ai-news/`
- `/var/lib/aifeeds-cc-sync/public/current/sitemap.xml`
- `/var/lib/aifeeds-cc-sync/public/generations/<uuid>/sitemaps/`

Nginx 的 generation 路由只接受小写 v4 UUID 与 `archive.xml` 或
`(news|x|gh|ph|hf-paper)-<正整数>.xml`。紧随其后的大小写敏感 regex catch-all 对
其余 `/sitemaps/` 请求返回 404，不能借 alias 读取任意文件。

## 本地运行

复制 `.env.example` 所列变量后执行：

```bash
CC_SYNC_SECRET=... \
CC_SYNC_BASE_URL=https://api.ai-feeds.com \
CC_SITE_ROOT=/tmp/aifeeds-cc-site \
CC_SYNC_STATE_DIR=/tmp/aifeeds-cc-state \
node cc-site/sync/sync.mjs --full
```

同步器还支持 `--dry-run`。生产 service 不使用 dry-run；timer 每 10 分钟执行真实增量
同步，并增加最多 30 秒抖动。

## 测试

```bash
bash -n cc-site/sync/deploy-to-cc.sh
bash -n cc-site/sync/install-remote.sh
node --check cc-site/sync/sync.mjs
node --check cc-site/sync/nginx-vhost-editor.mjs
node --test cc-site/sync/test/*.test.mjs
```

部署脚本还会在远端确认 `/usr/bin/node` major version 至少为 18，并在启动 service 前以
`aifeeds-sync` 用户重新运行全部测试。本地若不是 Node 18，只能说明当前本机 Node 版本的
结果；Node 18 是远端部署的硬门。

## 部署

secret 的唯一来源仍是仓库根的 `.secrets/aifeeds-prod.env` 或
`.secrets/aifeeds-staging.env`，其中单独设置：

```dotenv
CC_SYNC_SECRET=<openssl rand -hex 32 的结果>
```

脚本不 `source` env 文件，只解析一次 `CC_SYNC_SECRET`；重复声明、未知 `CC_SYNC_*`
键、非 64–128 位十六进制值都会在建立 SSH 连接前失败。secret 通过权限 0600 的本地
临时文件和唯一 `/tmp/aifeeds-cc-sync.*` 远端 staging 传输，不进入 argv、正常输出或
systemd unit；本地和远端都有退出清理 trap。

```bash
./cc-site/sync/deploy-to-cc.sh staging
./cc-site/sync/deploy-to-cc.sh prod
```

远端顺序固定为：

1. 停止并禁用旧 timer，创建专用 system user 和权限目录；
2. 安装 root-owned 代码、unit 与 `0600` 环境文件；
3. 检查 Node 18+，以同步用户运行 Node 测试；
4. 手动启动一次 oneshot service；
5. 从 `nginx -T` 检测真实 worker user（当前必须精确为 `www`），验证它可读 current、
   current archive sitemap 和根 sitemap 实际引用的 generation 文件；
6. 对现有宝塔 vhost 做 marker-managed include，不覆盖整个 vhost；
7. `nginx -t` 成功后 reload，再对公开归档和 sitemap 做 HTTPS smoke；
8. 最后才 `enable --now` timer。

vhost editor 只修改唯一的 `listen 443` + `server_name ai-feeds.cc` server block，并保留
HTTP 神马验证例外、`/auth/wechat/` 和其他业务 location。若 HTTPS server 不唯一、marker
不完整或已有 unmanaged include，部署会 fail closed。Nginx 配置测试、reload、公开 smoke
或 timer 激活失败时，脚本恢复部署前的 vhost/snippet，并再次加载旧配置。

## 运维与回滚

```bash
sudo systemctl status aifeeds-cc-sync.timer
sudo systemctl start aifeeds-cc-sync.service
sudo journalctl -u aifeeds-cc-sync.service -n 100
```

紧急停更：

```bash
sudo systemctl disable --now aifeeds-cc-sync.timer
```

这只停止后续同步，不删除当前 generation，也不会触碰人工维护页面。要撤掉公开路由，
删除 vhost 中 `AIFEEDS-CC-CONTENT-MIRROR-BEGIN/END` marker 块及对应 snippet 后，先执行
`nginx -t`，成功才 reload。
