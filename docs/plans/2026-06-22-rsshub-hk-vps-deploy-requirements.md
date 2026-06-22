# RSSHub 部署需求（HK VPS）— 给 Codex 的交接文案

> 发起方：aifeeds（`ai-feeds.com`）｜ 执行方：Codex（熟悉 HK VPS 配置与部署）
> 日期：2026-06-22 ｜ 目的：在 HK VPS 上自托管 RSSHub，为 aifeeds worker 提供 token 鉴权的 RSS API
> 背景设计：`docs/plans/2026-06-09-ai-vendor-feeds-source-design.md` §3.2 / §6

---

## 1. 一句话需求

aifeeds 要把 **4 个小宇宙（xiaoyuzhou）中文播客**接进「行业要闻&播客」板块。这些源没有公开 RSS，需要自托管一个 **RSSHub**（开源，`https://github.com/DIYgod/RSSHub`）把它们转成 RSS。请在 **HK VPS（`154.12.188.231`，当前在跑 aifeeds prod 的 nginx 中转）** 上部署 RSSHub，并通过 nginx 暴露一个**带 token 鉴权**的 HTTP 端点，供 aifeeds 的 Cloudflare Worker 调用拉取 RSS。

worker 侧的对接代码**已经写好**（`fetchFeedXml` 已支持 `via=rsshub`，读 `RSSHUB_BASE` + `X-RSSHub-Token`），**只等你这边把服务起好、把 base URL 和 token 给我**，我就能接通。

---

## 2. 要部署什么

- **RSSHub**（Node.js 应用）。只需要内置的 **小宇宙 `/xiaoyuzhou` 路由**，该路由是 SSR 内嵌解析，**不需要 puppeteer / 无头浏览器**。
- 建议**关闭 / 不启用 puppeteer 相关路由与依赖**（设 `PUPPETEER_WS_ENDPOINT` 留空、或用精简镜像），避免误触把内存打到 +200~400MB。
- 部署形态由你定（bare-node + systemd，或 docker，看你对这台机器的习惯）。

---

## 3. ⚠️ 机器容量要求（最重要，请先确认）

这台 HK VPS **同时在跑 aifeeds prod 的 nginx 中转**（大陆用户访问 `ai-feeds.com` / `api.ai-feeds.com` 全靠它）。设计文档 2026-06-09 实测当时是 **1 核 1G**（nginx 占用约 315MB，空闲内存约 645MB）。

RSSHub 内存预期：**idle ~150-250MB，并发解析大 HTML 瞬时冲 300-400MB**。在 1 核 1G 上，**RSSHub 的并发 spike 一旦撞上中转流量高峰，可能进 swap → nginx 回源/缓冲抖动 → 全站大陆用户感知变慢**。这是同机部署的主要风险。

**请你确认 / 处理：**

1. **先确认这台机器当前实配**（核数 / 内存 / swap）——可能已扩容，若已是 2C2G+ 风险大幅下降。把现配回我。
2. 给 RSSHub 的服务**加内存上限**，确保它 spike 时**先杀自己、保住 nginx 中转**：
   - systemd：`MemoryMax=350M`（或 docker `--memory=350m`）+ `MemoryHigh=300M`；
   - RSSHub 进程 `OOMScoreAdjust` 设正值（更易被 OOM-killer 选中）；
   - **nginx 进程 `OOMScoreAdjust=-900`**（最后才被杀），保证内核回收内存时不会先杀中转。
3. 给 RSSHub 的并发**设上限**（如 RSSHub 自身的 `requestTimeout` + nginx 侧 `limit_req`），别让一波请求把单核 CPU 抢光、饿死 nginx。

> 如果你评估同机风险仍偏高，设计文档里的备选是「另起一台最小小鸡（Oracle Always Free = $0，或并入你那台腾讯云渲染机 `82.156.0.68`）」。**最终用什么机器你拍板**，我这边只关心拿到一个稳定的 token 鉴权 RSS 端点。用户当前倾向就用 HK VPS。

---

## 4. 网络 + 安全契约（精确，请照此实现）

这是 worker 能直接对接的契约，照 aifeeds 现有「回源密钥」镜像模式（反方向 token gate）：

### 4.1 RSSHub 只监听 localhost

RSSHub 绑 `127.0.0.1:1200`，**不要暴露公网**（不开防火墙端口、不直接 listen 0.0.0.0）。

### 4.2 nginx 加 token 鉴权 location，走子域 `rss.ai-feeds.com`

- 新增子域 `rss.ai-feeds.com`（DNS 指向这台 VPS + certbot 出 TLS 证书）。
- nginx 校验请求头 `X-RSSHub-Token`，匹配约定 token 才放行，否则 403；通过则反代到本地 RSSHub。

nginx 配置样例（照设计文档 §6.5）：

```nginx
# token 值你生成后填这里（注意别提交进任何 git 仓库 / 文档）
map $http_x_rsshub_token $rsshub_ok { default 0; "<你生成的 RSSHUB_TOKEN>" 1; }

server {
    listen 443 ssl;
    server_name rss.ai-feeds.com;
    # ... certbot 证书 ...

    location / {
        if ($rsshub_ok = 0) { return 403; }
        proxy_pass http://127.0.0.1:1200/;
        proxy_set_header Host $host;
        proxy_read_timeout 30s;
        limit_req zone=aifeeds_rate burst=20 nodelay;   # 复用现有限流 zone 或新建
    }
}
```

### 4.3 worker 实际会发的请求（已写死在代码里，供你自测对齐）

```
GET https://rss.ai-feeds.com/<route>
Headers:
  X-RSSHub-Token: <约定 token>
  User-Agent: <浏览器 UA>
  Accept: application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5
  Accept-Language: en-US,en;q=0.9,zh-CN;q=0.8
  Cache-Control: no-cache
```

- worker 侧 fetch 超时 **20s**（所以 nginx `proxy_read_timeout 30s` 要留余量，RSSHub 自身别让单条路由跑超过 ~15s）。
- 期望响应：**HTTP 200 + 合法 RSS/Atom XML**（worker 会直接 `text()` 后解析）。

---

## 5. 要支持的 4 条路由（请逐条 curl 自测能返回有效 RSS）

| 播客 | RSSHub 路由 |
|------|------------|
| 硅谷101 | `/xiaoyuzhou/podcast/5e5c52c9418a84a04625e6cc` |
| OnBoard! | `/xiaoyuzhou/podcast/61cbaac48bb4cd867fcabe22` |
| AI 前线 | `/xiaoyuzhou/podcast/679d8c5ded7799e793bb7936` |
| 张小珺·商业访谈录 | `/xiaoyuzhou/podcast/<待确认 ID>` ⚠️ 设计文档没记这个播客的小宇宙 ID，麻烦你在小宇宙 App/网页找一下它的 podcast id 补全；若 RSSHub 实测抓不到，备选第三方桥 `https://feed.xyzfm.space/dk4yh3pkpjp3`（已验活但是单点） |

> 公共 `rsshub.app` 实测对小宇宙路由返回 403，所以必须自建——这正是本次部署的原因。

---

## 6. 落地顺序（硬要求，防自锁 + 防公网暴露）

⚠️ **顺序不能颠倒**，否则要么 worker 全 403、要么 RSSHub 裸暴露公网：

1. 装 RSSHub，绑 `127.0.0.1:1200`，起 systemd（带 `MemoryMax`），关 puppeteer。
2. 配 `rss.ai-feeds.com` DNS + certbot 证书 + nginx token-gate location（§4.2）。
3. **本机 curl 自测**：
   - 带正确 `X-RSSHub-Token` → 200 + XML；
   - 不带 / 错 token → 403；
   - 上面 4 条路由都能返回有效 RSS（至少几条 item）。
4. 把 **base URL + token + 自测结果** 给我（见 §7），我再填进 worker 的 `RSSHUB_BASE` / `RSSHUB_TOKEN` 并部署（先 staging 后 prod）。

---

## 7. 请回我的交付物

1. **base URL**：确认是 `https://rss.ai-feeds.com`，还是你用了别的域名 / 路径前缀。
2. **`X-RSSHub-Token` 的值**：⚠️ **走安全渠道私发给我**（私聊 / 密码管理器），**不要写进任何 git 仓库或文档**。我会存进 aifeeds 的 `.secrets/aifeeds-{prod,staging}.env` + `wrangler secret put`。
3. **4 条路由的 curl 自测结果**（HTTP 状态 + 大致 item 条数），含张小珺补全后的 ID。
4. **机器现配**（核数/内存/swap）+ **你给 RSSHub 设的内存上限值**——便于我评估长期稳定性。
5. **RSSHub 版本** + 是否锁版本 / 自动更新策略（小宇宙路由偶尔会随上游失效，便于日后排查）。
6.（可选）一个 **`/healthz` 或任意固定路由**，便于我在 worker 侧加 cron 探活 + PushDeer 告警。

---

## 8. 我这边拿到后做什么（你不用管，仅供同步）

- 往 `worker/src/feeds/registry.ts` 加 4 条 `via:'rsshub'` 的 FeedDef（route 填上面的路径）。
- 填 `RSSHUB_BASE`（wrangler.toml vars）+ `RSSHUB_TOKEN`（wrangler secret），先 staging 验证 4 条都能拉到、enrich 出中文标题/摘要，再上 prod。
- 加 cron 探活 + 失败 PushDeer 告警。

有任何契约要改（比如 header 名、子域、限流），先跟我说，我改 worker 侧对齐，别两边各改各的。
