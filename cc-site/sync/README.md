# ai-feeds.cc 静态内容同步器

零运行时依赖的 Node.js 18+ 同步器。它通过独立 HMAC API 从 `.com` 的审核权威增量拉取
已经允许在大陆发布的页面，校验 SHA-256 后写入 `.cc` 的 `/i/`，再在 state 目录构建
归档页与 sitemap generation，并原子切换 `public/current`。

## 文件与所有权边界

| 路径 | 所有者与用途 |
|---|---|
| `/opt/aifeeds-cc-sync` | 指向 `/opt/aifeeds-cc-sync-releases/<manifest-sha256>/cc-site/sync` 的原子切换 symlink |
| `/opt/aifeeds-cc-sync-releases` | `root:root` 的不可变 release；成功后保留当前与最近两个安全旧版本 |
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
for file in cc-site/sync/*.mjs; do node --check "$file"; done
node --test cc-site/sync/test/*.test.mjs
```

部署脚本还会在远端确认 `/usr/bin/node` major version 至少为 18，并在启动 service 前以
`aifeeds-sync` 用户重新运行全部测试。本地若不是 Node 18，只能说明当前本机 Node 版本的
结果；Node 18 是远端部署的硬门。

## 生产部署

远端脚本只接受 `prod`；staging 验证只允许在本机临时目录构建 payload 和执行测试，
不会连接或修改生产服务器。secret 的唯一来源是仓库根的
`.secrets/aifeeds-prod.env`，其中单独设置：

```dotenv
CC_SYNC_SECRET=<openssl rand -hex 32 的结果>
```

脚本不 `source` env 文件，只解析一次 `CC_SYNC_SECRET`；重复声明、未知 `CC_SYNC_*`
键、非 64–128 位十六进制值都会在建立 SSH 连接前失败。secret 通过权限 0600 的本地
临时文件和唯一 `/tmp/aifeeds-cc-sync.*` 远端 staging 传输，不进入 argv、正常输出或
systemd unit；本地和远端都有退出清理 trap。

```bash
./cc-site/sync/deploy-to-cc.sh prod
```

本地构建器只复制 `payload-files.txt` 的精确 allowlist，并保持仓库内的
`cc-site/...` 相对路径。payload 不含 `cc-site/server`、`.env*`、`.secrets`
或其他未声明文件；环境文件单独位于 `deploy/cc-sync.env`。路径排序的
`MANIFEST.sha256` 同时约束文件集合和内容，额外文件、symlink、hardlink 或摘要不符
都会拒绝部署。

远端顺序固定为：

1. 将 installer 和所有事务 helper 固定到唯一、root-owned 的
   `/var/tmp/aifeeds-cc-bootstrap.*`，逐个核对 SHA-256 后才执行；
2. 获取非阻塞部署锁，把 staging 复制成 root-owned snapshot，并在改动 live state 前
   两次验证 manifest、文件类型和 link count；
3. 验证系统账号、所有 managed path 的 owner/mode/目录链和现有 `/i` inode tree，
   检查 Node 18+，再以 `aifeeds-sync` 用户运行 payload 内的真实完整测试；
4. 记录旧 symlink、env、unit 及 timer/service 的 enabled/active 状态，停止旧任务；
5. 创建以 manifest digest 命名的不可变 release，原子切换
   `/opt/aifeeds-cc-sync`，并用同目录临时文件、fsync、rename 安装 env 与 unit；
6. 手动启动一次 oneshot service，从 `nginx -T` 检测真实 worker user（必须精确为
   `www`），验证它可读 current、AI 新闻首页及根 sitemap 引用的 generation shard；
7. 通过 compare-and-swap 事务安装 marker-managed include 和 snippet；若宝塔在准备、
   提交或回滚期间改写 vhost，部署 fail closed，绝不覆盖并发面板内容；
8. `nginx -t` 成功后 reload，并通过
   `--resolve ai-feeds.cc:443:127.0.0.1` 直接命中本机 HTTPS：根 sitemap、
   generation shard、`/ai-news/` 都必须精确返回 HTTP 200，且响应字节必须与刚发布
   的文件完全一致；
9. 最后才 `enable --now` timer；部署提交后仅清理经过 owner/mode/type/link
   验证的旧 release，保留当前与最近两个安全版本，异常目录只跳过、不跟随。

vhost editor 只修改唯一的 `listen 443` + `server_name ai-feeds.cc` server block，并保留
HTTP 神马验证例外、`/auth/wechat/` 和其他业务 location。HTTPS block 必须有且只有一个
顶层 `#REWRITE-END`，managed include 必须位于所有顶层 regex location 之前。若 server
不唯一、marker 不完整/错序或已有 unmanaged include，部署会 fail closed。测试、service、
Nginx 配置、reload、精确内容探针或 timer 激活失败时，脚本事务恢复旧 release symlink、
env、unit、service/timer 状态和未发生并发冲突的 vhost/snippet；任何回滚步骤失败时明确
返回 70。

## 运维与回滚

```bash
sudo systemctl status aifeeds-cc-sync.timer
sudo systemctl start aifeeds-cc-sync.service
sudo journalctl -u aifeeds-cc-sync.service -n 100
```

首次 bootstrap 可能需要处理三万多个页面。service 的 `TimeoutStartSec=2h`；同步器在
state 目录持久化冻结 watermark、item cursor、固定 request limit 和已校验 pending page，
每批提交后都可续跑。若网络、进程退出或两小时超时中断，不要删除
`/var/lib/aifeeds-cc-sync`，直接再次执行：

```bash
sudo systemctl start aifeeds-cc-sync.service
sudo journalctl -fu aifeeds-cc-sync.service
```

后续 timer 也会从持久化 cursor 继续。只有明确要从零重建且已经制定数据恢复方案时，才
考虑清理 state；普通失败不需要重新传三万页，也不应手工改写 `public/current`。

紧急停更：

```bash
sudo systemctl disable --now aifeeds-cc-sync.timer
```

这只停止后续同步，不删除当前 generation，也不会触碰人工维护页面。要撤掉公开路由，
删除 vhost 中 `AIFEEDS-CC-CONTENT-MIRROR-BEGIN/END` marker 块及对应 snippet 后，先执行
`nginx -t`，成功才 reload。
