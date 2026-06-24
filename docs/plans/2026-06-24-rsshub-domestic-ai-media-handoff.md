# RSSHub 国内 AI 媒体接入交付（handoff to Codex）

> 日期：2026-06-24
> 服务：复用 2026-06-22 已上线的自托管 RSSHub（HK VPS），为 aifeeds Worker 新增 3 家国内 AI 新闻媒体的 feed 入口
> 入口：`https://rss.ai-feeds.com`（token-gated，`X-RSSHub-Token`）
> 前序交付：[`docs/plans/2026-06-22-rsshub-hk-vps-deploy-handoff.md`](2026-06-22-rsshub-hk-vps-deploy-handoff.md)（实例 / nginx / systemd / TLS / 鉴权已就绪，本次只加路由）

本次新增的是 **新闻媒体（`kind='blog'`）**，不是播客。与 06-22 接入的 4 家小宇宙播客（`kind='podcast'`）走同一台 RSSHub 实例、同一套 `X-RSSHub-Token` 鉴权、同一份 secret。

---

## 1. 背景与目标

「新闻&播客」频道目前只接了国外大模型厂商官方博客（OpenAI / Anthropic / NVIDIA 等），问题是官博都是 PR 软文、覆盖窄。本次补一层国内第三方 AI 媒体报道：

| 源 | 平台名 | 网站 | WeChat 公众号 |
|---|---|---|---|
| 量子位 | QbitAI | `qbitai.com` | 量子位 |
| 机器之心 | jiqizhixin / Synced | `jiqizhixin.com` | 机器之心 |
| 新智元 | AI Era | `aiera.com.cn` | 新智元 |

**为什么走 RSSHub（而不是 Worker 直连）**：

1. **多数没有可靠的直连 RSS**（见 §2 实测）：机器之心 / 新智元 的网站没有可用 RSS 端点；量子位虽有 `qbitai.com/feed` 但只给摘要级、且仍是国内站。
2. **CF Worker 出口 IP 在全球/美区**，直连国内站易被限流 / 风控 / 偶发不可达；**HK VPS 出口在香港**，对国内站更稳。
3. **复用已上线实例**：06-22 已把 RSSHub + nginx + token 鉴权在 HK VPS 跑通，加路由零额外基建成本。

目标产出：Codex 在 HK VPS 的 RSSHub 上为这 3 家**确认/启用可用路由**，交付「能用的 route URL + 样例输出」；worker 侧（我）据此往 `FEED_REGISTRY` 加 3 条 `via='rsshub'` `kind='blog'` 条目。

---

## 2. 现状调研（2026-06-24 我已 curl 实测）

> 以下是 worker 侧用 `curl` 静态实测的结论，供 Codex 选路由时参考。**直连 RSS 列「可用」也不代表 worker 会直连**——除量子位外都不可用；可用的也建议过 RSSHub 拿 HK 出口。

| 源 | 直连 RSS 实测 | RSSHub 内置命名空间 | 结论 |
|---|---|---|---|
| **量子位** | ✅ `qbitai.com/feed` → HTTP 200、RSS、10 条、最新 2026-06-24（摘要级，无 `content:encoded`） | ✅ `lib/routes/qbitai`（`category` + `tag` 路由） | 最易；RSSHub 有现成路由，native feed 可兜底 |
| **机器之心** | ❌ `jiqizhixin.com/rss`、`/feed` 返 HTML（0 条）、`/rss/all` 404 | ❌ 无（`lib/routes/jiqizhixin` 404） | 需 WeChat 公众号 relay 或自建路由 |
| **新智元** | ❌ `aiera.com.cn/feed`、`/rss` → HTTP 500 | ❌ 无（`lib/routes/aiera`、`xinzhiyuan` 均 404） | 需 WeChat 公众号 relay 或自建路由 |

RSSHub 自带 `lib/routes/wechat` 命名空间（第三方 WeChat relay：`ce` / `feeddd` / `ershcimi` / `data258` 等），机器之心 / 新智元 的现实路径多半落在这里，但**这些 relay 依赖外部服务可用性，必须由 Codex 在 HK VPS 实例上实测确认**。

---

## 3. Codex 需要交付的

对每个源，在 HK VPS 的 RSSHub（commit 锁定见 06-22 doc §4）上确认/启用一条可用路由，并回交：

- **可用的 route path**（不含 base，形如 `/qbitai/category/资讯`）
- **样例输出**：`curl` 带正确 `X-RSSHub-Token` 打 `https://rss.ai-feeds.com/<route>` → HTTP 200、item 数、最新一条的标题 + pubDate（证明是活的、时序新鲜）
- 若某家在锁定的 RSSHub commit 上**没有现成路由**（机器之心 / 新智元大概率如此）：说明走了哪条 WeChat relay / 是否需要补依赖或外部 relay key / 还是判定「当前不可得」。**不可得也是有效交付**——worker 侧据此决定先上能上的、缓上不能上的。

### 候选 route（线索，**待 Codex 确认实际可用 path**）

| 源 | 候选 RSSHub route（线索） | 备注（Codex 确认） |
|---|---|---|
| 量子位 | `/qbitai/category/资讯` | RSSHub 内置 `qbitai` 命名空间，内部抓 `qbitai.com/category/<cat>/feed`；路径含中文 `资讯`，注意 URL 编码（见 §4 备注）。其它分类见 `qbitai.com` 导航 |
| 机器之心 | `/wechat/<relay>/<机器之心 biz/id>`（无内置命名空间） | RSSHub 无 `jiqizhixin` 路由；走 WeChat relay 或自建抓 `jiqizhixin.com` 列表页 |
| 新智元 | `/wechat/<relay>/<新智元 biz/id>`（无内置命名空间） | 同上；`aiera.com.cn` 站点在但无 RSS |

> 三条路由都挂在已上线实例上，鉴权 / 限流 / 资源保护沿用 06-22 配置，无需新增 nginx / systemd 改动。若某路由让 RSSHub 内存吃紧（`MemoryMax=350M`），按 06-22 §5 的「可牺牲服务」原则处理。

---

## 4. 接入契约（worker 侧）

**结论：worker 端无需改代码，只在 `FEED_REGISTRY` 加 3 条条目即可**（已核对 `worker/src/blog.ts`：`via='rsshub'` 复用共享 `fetchFeedXml`，`region==='domestic'` 自动 `lang='zh'`）。

### 4.1 复用已上线的鉴权 / secret

- `RSSHUB_BASE` = `https://rss.ai-feeds.com`、`RSSHUB_TOKEN` 已在 prod env，**沿用 06-22 那一份，无新增 secret**。
- secret 唯一源：`/Users/roxor/brain/30-projects/aifeeds/.secrets/aifeeds-prod.env`（**仅引用文件路径 + secret 名 `RSSHUB_BASE` / `RSSHUB_TOKEN`，不在本文档展开任何值**）。
- 取数路径：`worker/src/feeds/parse.ts` 的 `fetchFeedXml` 对 `via==='rsshub'` 自动 `RSSHUB_BASE` + route path 拼 URL，并带 `X-RSSHub-Token` 头；香港 host-rewrite 铁律不变（基址只走 `env.RSSHUB_BASE`，不靠 request host）。

### 4.2 registry 条目形状（worker 侧据 Codex 确认的 route 填 `feed_url`）

照搬 `registry.ts` 里 `DOMESTIC_PODCASTS` 的 `via='rsshub'` 形状，把 `kind` 改成 `blog`：

```ts
{
  id: "blog:qbitai",
  key: "qbitai",                       // 只含 [a-z0-9-]，进 item id / workflow instance-id
  kind: "blog",                        // ← 新闻媒体，不是 podcast
  format: "rss",                       // RSSHub 输出 RSS 2.0，走 parseRss 分支
  source_company: "量子位",
  name: "量子位 QbitAI",
  region: "domestic",                  // ← 自动 lang='zh'（blog.ts）
  via: "rsshub",                       // ← fetchFeedXml 拼 RSSHUB_BASE + X-RSSHub-Token
  feed_url: "/qbitai/category/资讯",    // ← Codex 确认的 route path（不含 base），待定
  cadence_hours: 2,                    // blog 档
  fetch_strategy: "native",            // RSSHub 产出当普通 feed 解析，不走 page-scrape
  notes: "国内 AI 媒体 via RSSHub(rss.ai-feeds.com);<route> 由 Codex 确认;is_ai gate 滤非 AI",
}
```

机器之心 → `id: "blog:jiqizhixin"` / `key: "jiqizhixin"`；新智元 → `id: "blog:xinzhiyuan"` / `key: "xinzhiyuan"`（或 `aiera`，worker 侧定）。

**备注（中文 route path 编码）**：`/qbitai/category/资讯` 含非 ASCII。`fetchFeedXml` 用 `fetch(url)`，URL 里的中文由 runtime 编码，但建议 Codex 在样例里直接给**已确认可打通的形态**（必要时给 percent-encoded 版本，如 `/qbitai/category/%E8%B5%84%E8%AE%AF`），worker 侧照抄进 `feed_url` 避免歧义。

---

## 5. 分工边界

| 谁 | 做什么 |
|---|---|
| **Codex（HK VPS / RSSHub 运维）** | ① 在锁定 commit 的 RSSHub 上为 3 家确认/启用路由；② 回交「可用 route path + 样例输出（item 数 + 最新标题/日期）」；③ 不可得的源明确说明原因（无内置路由 / relay 不可用等）；④ 路由的鉴权 / 资源保护沿用 06-22，无需动 nginx |
| **worker 侧（我）** | ① 据 Codex 给的 route path 往 `FEED_REGISTRY` 加 `via='rsshub'` `kind='blog'` 条目；② staging 验证拉取 + is_ai gate + 冷启动 30 天窗；③ 更新 `operations.md` registry 段 + 源总数；④ 不需要 Codex 碰 worker 代码 |

---

## 6. 验收标准（Codex 自测 + 交付 smoke test）

对每条确认的路由（参照 06-22 doc §3 的鉴权 smoke）：

```text
正确 X-RSSHub-Token  → GET https://rss.ai-feeds.com/<route>  → 200，item 数 ≥ 5，最新条 pubDate 近 7 天
无 token             → 403
错 token             → 403
```

交付表（Codex 填）：

| 源 | 确认的 route | HTTPS 状态 | item 数 | 最新条标题 / pubDate |
|---|---|---:|---:|---|
| 量子位 | `…` | 200 | | |
| 机器之心 | `…` 或「当前不可得」 | | | |
| 新智元 | `…` 或「当前不可得」 | | | |

---

## 7. 沿用 06-22 已上线基础设施（不重复搭）

实例 / 机器 / systemd / TLS / DNS / 资源保护 / 更新策略全部沿用 [`2026-06-22-rsshub-hk-vps-deploy-handoff.md`](2026-06-22-rsshub-hk-vps-deploy-handoff.md)：

- 实例：`rss.ai-feeds.com` → HK VPS（`127.0.0.1:1200`，nginx token-gated 反代）
- RSSHub commit 锁定，不自动更新；本次只加路由，不升级 RSSHub 本体
- 鉴权 / 限流 / `MemoryMax` / OOM 优先级保护现有 nginx 中转——均不变
- secret：`RSSHUB_BASE` / `RSSHUB_TOKEN` 复用同一份（`.secrets/aifeeds-prod.env`），**本次无新增 secret**

---

## 8. Codex 实施结果（2026-06-24）

已在 HK VPS 现有 RSSHub 实例上线并验证 3 条国内 AI 媒体 route。入口仍为 `https://rss.ai-feeds.com`，鉴权头仍为 `X-RSSHub-Token`，token / base 复用既有配置：`/Users/roxor/brain/30-projects/aifeeds/.secrets/aifeeds-prod.env` 中的 `RSSHUB_BASE` / `RSSHUB_TOKEN`（本文档不展开 secret 值）。

本次对 RSSHub 做了一个小补丁：新增 `新智元` 自定义首页 route `/aiera`，解析 `https://aiera.com.cn` 首页文章卡片；RSSHub 本体仍基于 06-22 锁定版本，本次 release 标识为 `9807609-aiera-20260624`。nginx / TLS / token gate / systemd 资源保护均未改变。

交付表：

| 源 | 确认的 route | HTTPS 状态 | item 数 | 最新条标题 / pubDate |
|---|---|---:|---:|---|
| 量子位 | `/qbitai/category/%E8%B5%84%E8%AE%AF`（等价 `/qbitai/category/资讯`） | 200 | 10 | 百度智能云发布百度千帆Token Plan企业版，提供GLM-5.2等模型 / Wed, 24 Jun 2026 11:09:51 GMT |
| 机器之心 | `/wechat/sogou/jiqizhixin` | 200 | 10 | PPT之外,AI之内\|2026WAIC机器之心特别企划栏目 / Thu, 18 Jun 2026 09:10:51 GMT |
| 新智元 | `/aiera` | 200 | 10 | 360发布“中国版Mythos”图龙锋 周鸿祎：漏洞发现能力正成为新的战略能力 / Wed, 24 Jun 2026 09:26:46 GMT |

鉴权 smoke：

| 检查 | 结果 |
|---|---:|
| 正确 `X-RSSHub-Token` 拉取上述 3 条 route | 200 |
| 无 token 拉 `/aiera` | 403 |
| 错 token 拉 `/aiera` | 403 |

worker 侧建议 registry `feed_url` 直接使用上表 route。量子位建议用 percent-encoded 形态 `/qbitai/category/%E8%B5%84%E8%AE%AF`，避免运行时/配置文件对中文路径编码行为产生歧义。

---

## 9. Worker 侧接入结果（2026-06-24，cc/worker）

按 Codex 交付的 route 接入 + staging 实测：

| 源 | 最终接入 | staging 结果 |
|---|---|---|
| **量子位** | **走 native**（`qbitai.com/feed`，非 RSSHub route）| ✅ 10 条 9 AI、含 `content:encoded` 全文 |
| **新智元** | rsshub `/aiera` | ✅ 10 条 9 AI、有正文、标题质量高 |
| **机器之心** | ❌ **暂未接入**，从 registry 摘除 | ⚠️ 见下 |

**量子位为何走 native**：worker 实测能直抓 `qbitai.com/feed`（CF Worker IP 未被拦），native 无 HK 中转依赖、且带 `content:encoded` 全文，优于 RSSHub route。Codex 的 `/qbitai/category/资讯` 路由保留作 native 失效时的备份。

**⚠️ 机器之心需换 route（请 Codex 跟进）**：`/wechat/sogou/jiqizhixin` 验证时虽 200/10 条，但每条 item **只有标题 + 一个 Sogou 搜索跳转链**（`url` 形如 `https://weixin.sogou.com/link?...`），**RSS 里无文章正文**（`<description>`/`content:encoded` 为空）。worker 的 blog 管线用普通 `fetch` 抓取（不渲染 JS、无 Sogou 会话），跟不动 Sogou 跳转 → 这些 item 正文为空、`is_relevant` 上不去、被频道 `is_relevant=1` 过滤掉，等于无效源。
**期望**：换一个**正文内嵌在 RSS 里**的机器之心 route —— 如 `wechat2rss` 那类把公众号全文打进 `content:encoded` 的方案，或 `jiqizhixin.com` 站点直连路由。新智元 `/aiera` 即是「正文内嵌」的正面例子，可参照。Codex 交付带全文的 route 后，worker 侧加一个 registry 条目即可（`via='rsshub'` `kind='blog'`）。
