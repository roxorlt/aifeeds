# 微博科技热搜接入交付（handoff to Codex）

> 日期：2026-06-25
> 服务：复用 2026-06-22 已上线的自托管 RSSHub（HK VPS），为 aifeeds 新增「微博科技热搜」作为**热度信号源**
> 入口：`https://rss.ai-feeds.com`（token-gated，`X-RSSHub-Token`）
> 前序：[`2026-06-22-rsshub-hk-vps-deploy-handoff.md`](2026-06-22-rsshub-hk-vps-deploy-handoff.md)（实例已就绪）/ [`2026-06-24-rsshub-domestic-ai-media-handoff.md`](2026-06-24-rsshub-domestic-ai-media-handoff.md)（国内 3 家 AI 媒体接入，同一套模式）
> **本次开发（含 worker / CF 侧）整体交给 Codex；cc 只负责本 plan 撰写。**

---

## 0. 一句话目标

把**微博科技热搜榜**（`https://weibo.com/hot/tech`）接成 aifeeds 的一个新数据源，定位是「**热度雷达**」——补我们官方媒体源「慢半拍、覆盖窄」的短板（如 Seedance 2.5 / 腾讯 Agently / Meta AI 眼镜这类当天爆点）。

这个源有一条**专属规则**：**跳过我们自己的「涉华敏感过滤」（`cn_sensitive`）**，因为微博内容本身已经过微博平台的合规审查（详见 §4）。其它所有老源的敏感过滤**保持不变**。

---

## 1. 背景：为什么接 + 它能补什么、不能补什么

「新闻&播客」频道现在的国内源是量子位 / 机器之心 / 新智元（偏深度研究 / 产品发布），对**当天突发热点**反应慢。微博热搜是国内 AI 圈热度的实时晴雨表，能第一时间冒出爆点话题。

**但必须认清它的边界（这条写给 user，避免预期错位）：**

- ✅ **能补**：非敏感的热点快讯（国产模型发布、大厂新产品、AI 圈八卦/融资/出圈事件）——这些会上微博科技榜，接进来就能抓到。
- ❌ **补不了**：政治敏感类（如「Anthropic 指控阿里蒸馏」这种中美对抗 / 制裁叙事）。原因有两层：① **微博平台自己**就会把这类话题从热搜里压掉；② 即便漏进来，对这一个源我们虽跳过 `cn_sensitive`，但这类内容微博端本就稀缺。所以**这条故事接了微博热搜也不会出现**——它的本质是合规取舍，不是信源问题（见 2026-06-25 调研结论）。

---

## 2. 三个待定问题的结论（直接回 user 的提问）

### 2.1 更新间隔

- 微博平台端热搜刷新较快；**但我们这边的抓取频率由自己的 cron 决定，不追平台实时**。
- 2026-06-25 调整为微博源专用 30 分钟抓取（`cadence_hours: 0.5`）。理由：该源定位是热度雷达，2 小时容易错过短生命周期热点；30 分钟在时效、微博反爬、RSSHub 负载、后续 AI 判别/翻译成本之间更均衡。
- RSSHub 侧有缓存，连续请求不会真的每次都去爬微博。

### 2.2 反爬策略

- 微博四大热搜榜（实时 / 名人 / 热点 / 潮流）**游客可访问**，但频繁抓会弹验证码；登录态（cookie）能显著降验证码率、拿到更全内容。
- **已实测我们的 RSSHub 实例当前跑不动微博路由**：`GET /weibo/search/hot` 返回 `HTTP 503`，报错 `browserType.launch: Executable doesn't exist at .../chrome-headless-shell`——微博路由想拉无头浏览器去拿游客 cookie，但 HK VPS 上没装这个浏览器。对照组：我们在用的小宇宙路由 `/xiaoyuzhou/podcast/...` 返回 `200`、243KB 正常内容，**实例和 token 本身健康**，只是微博路由缺前置条件。
- **解法**：用登录态 cookie 直接喂给微博 API，绕开无头浏览器。cookie 怎么管见 §5。

### 2.3 内容深度 / 微博智搜

- **好消息**：RSSHub 微博路由有 `fulltext` 变体（`/weibo/search/hot/fulltext`），**每条热搜底下的内容摘要会随榜单一起返回**，不用 worker 逐条点进去再聚合。抓回来后照常过我们的 AI 判别 + DeepSeek 翻译/归纳。
- **微博智搜（`s.weibo.com/aisearch`）不建议直接抓**，三点：① 要登录态；② 结果是网页 JS 流式吐出（非一次性返回的静态页），普通 HTTP 抓不到；③ RSSHub 无现成路由，得自写带登录的浏览器脚本解析流式输出，脆且维护重。
- 真要按关键词深挖，更可控的是 RSSHub `/weibo/keyword/<词>` 把原帖捞回来、**用我们自己的 DeepSeek 做聚类整合**——质量和格式都攥在自己手里。本次先不做，留作后续增强。

---

## 3. 架构决策

### 3.1 推荐方案：RSSHub（香港出口）抓取 + cookie 走请求头注入 + worker 侧告警

```
.secrets/aifeeds-prod.env (WEIBO_COOKIES 唯一源, user 维护)
        │  wrangler secret put → worker
        ▼
CF Worker ──HTTPS(X-RSSHub-Token + X-Weibo-Cookie 头)──► RSSHub@HK VPS ──► weibo.com API
        │                                                  (香港出口, 风控低; cookie 仅内存用, 不落 VPS 盘)
        ▼
blog 工作流(is_ai gate 保留; 仅此源 force cn_sensitive=0) → items → 「新闻&播客」频道
        │
        └─ cookie 失效时: RSSHub 返回可识别的失效信号 → worker notifier.ts 推 PushDeer 给 user
```

**为什么这么定（逐条对齐 user 的约束）：**

| user 约束 | 本方案如何满足 |
|---|---|
| cookie 放 prod.env | cookie 唯一源就是 `prod.env`，经 worker secret 注入、再由 worker 以请求头 `X-Weibo-Cookie` 传给 RSSHub。**VPS 上不存任何 cookie**（比存 VPS env 更安全、且单一可信源）|
| cookie 过期要告警 | 复用 X cookie 失效告警的**同款现成机制**（`admin.ts:425` + `notifier.ts` PushDeer）。worker 抓取时识别失效信号 → PushDeer 推 user |
| 跳过敏感过滤（仅此源）| registry 加 `skip_cn_sensitive: true`，工作流仅对此源 force `cn_sensitive=0`，**is_ai gate 与其它源敏感过滤全不动**（§4）|
| 完整开发交 Codex | RSSHub 自定义路由 + worker 改动（registry / 工作流 / secret / 告警 / cron）全由 Codex 实施 |

**为什么不选「worker 直连微博」**：CF Worker 出口 IP 在美区，直连微博易被地域风控 / 限流（同 06-24 doc §2 对国内站的判断）。香港出口的 RSSHub 更稳。

**为什么不选「cookie 存 VPS env（标准 RSSHub 做法）」**：那样 cookie 落在 Codex 的 VPS（与「只放 prod.env」冲突，且变两处），每次过期要跨人同步、重启实例，几周一次的摩擦。请求头注入让 cookie 只活在我们这一侧，刷新只需 `wrangler secret put` 一步。

> Codex 若实测「请求头注入」在 RSSHub 自定义路由里不好落地，可退回「VPS env 存 `WEIBO_COOKIES`」的标准做法——**但前提仍是 prod.env 为唯一可信源**，并在交付里写清刷新时的同步步骤。HOW 由 Codex 定，只要满足上表四条约束。

---

## 4. 合规：跳过 `cn_sensitive` 的精确机制（仅微博源）

> ⚠️ 这是本次唯一碰合规闸的改动，必须精确、可审计、不波及其它源。

**现状**（`worker/src/workflows/blog-pipeline.ts`）：
- Step 4 fan-out 里有一步 `classify-cn-sensitive`（L135-137，调 `classifySensitivityForFeeds`，每条必经的 LLM 涉华敏感判定）。
- 完整性 gate（L147）：`const ok = !enrich.enrichFailed && sens.cn_sensitive !== null;`——`cn_sensitive` 判不出（null）就不放行。
- 下发过滤（`worker/src/index.ts:2541`）：`COALESCE(json_extract(extra,'$.cn_sensitive'),0) != 1`——`cn_sensitive=1` 一律不下发。

**改法（仅当 feed 带 `skip_cn_sensitive: true`）：**
1. registry 新增字段 `skip_cn_sensitive?: boolean`（`worker/src/feeds/types.ts` 的 `FeedDef`），微博源置 `true`。
2. `BlogPipelineParams` 透传该 flag（`runBlogFetch` create 工作流时带上）。
3. 工作流 Step 4：若 `skipCnSensitive`，把 `classify-cn-sensitive` 这步**替换为一步直接写 `extra.cn_sensitive = 0`**（不调 LLM，省成本），其余步骤不变；gate 的 `sens.cn_sensitive !== null` 因被 force 成 `0` 自然满足。

**必须保留、不能跳的：**
- ✅ **is_ai gate 全程保留**（Step 1 `quick-classify` + Step 3 `reclassify-fulltext`）。微博科技榜仍混大量非 AI 内容，靠这道闸滤掉。**只跳「涉华敏感」判定，不跳「是否 AI 相关」判定。**
- ✅ 去重、翻译、媒体迁移等其它步骤不变。

**为什么这个跳过是合理的（写给 user 的依据）**：我们的 `cn_sensitive` 闸专打「涉华敏感」，而微博平台的审查恰恰在这一类上是国内最严的——重叠度极高。微博能挂上热搜的内容，涉华敏感维度上等于已被预筛。**残留风险**：极偶发的、微博漏掉的涉华敏感 AI 话题会直接下发（user 已接受此取舍）。若将来要收紧，把该源 `skip_cn_sensitive` 改回 `false` 即可一键恢复。

---

## 5. Cookie 管理与过期告警

### 5.1 存储（唯一源）

- `WEIBO_COOKIES` 写入 `/Users/roxor/brain/30-projects/aifeeds/.secrets/aifeeds-prod.env`（**user 维护，本文档不展开值**），经 `wrangler secret put WEIBO_COOKIES` 注入 worker。
- 同 `.secrets` 强制约定：不新建散落 .env，不把 cookie 值写进任何 doc / 代码 / 注释。

### 5.2 过期告警（复用 X cookie 的现成模式）

代码库已有同款先例——X 抓正文的登录 cookie 失效时（401/403）「自动标失败 + PushDeer 推送 + admin 页粘贴更新」（见 `worker/src/admin.ts:425`、`worker/src/notifier.ts`）。微博 cookie 照搬这套：

1. **失效信号**：Codex 的 RSSHub 微博路由在 cookie 被微博拒绝时，返回一个**可区分的失效信号**（建议明确的 `401/403` 或带特定标记的错误体，**别用泛化的 503**——否则 worker 没法把「cookie 过期」和「实例临时抽风」区分开）。
2. **worker 识别 + 告警**：worker 抓取时若收到该信号 → 调 `notifier.ts` 推 PushDeer 给 user（标题写清「微博 cookie 失效，请更新 prod.env 的 `WEIBO_COOKIES`」）。
3. **去抖**：一次失效周期内只推一次（参考 `notifier.ts` 已有的 `WARNING_BUFFER` 缓冲），别每 30 分钟 cron 都炸一遍。
4. **更新动作**（user 侧，文档化）：浏览器登录微博 → F12 取 cookie → 覆盖 prod.env 的 `WEIBO_COOKIES` → `wrangler secret put` → 重新部署 worker。**单侧操作，不碰 VPS。**

> PushDeer key 用既有的 `PUSHDEER_ADMIN_KEYS`（已在 prod env），无新增告警基建。

---

## 6. Codex 交付物

### 6.1 RSSHub 侧（HK VPS）

- 在锁定 commit 的 RSSHub 上**确认/新增**一条**微博科技热搜**路由，要求：
  - 取的是**科技榜**（对应 `weibo.com/hot/tech`）而非泛热搜大杂烩；若科技垂直榜无现成 API、只能取通用榜，**明确说明**——退而求其次取通用榜也行（worker 的 is_ai gate 会滤非 AI），但要在交付里标注。
  - 每条 item **带内容摘要**（`fulltext` 形态，`description`/`content:encoded` 非空），不能只给一句话标题。
  - **cookie 经请求头注入**（推荐 `X-Weibo-Cookie`）；或退回 VPS env `WEIBO_COOKIES`（见 §3.1 注）。
  - cookie 被拒时返回**可区分的失效信号**（§5.2）。
- 鉴权 / 限流 / 资源保护沿用 06-22 配置，无需动 nginx / systemd。

### 6.2 Worker / CF 侧（本次也归 Codex）

| 改动 | 位置（锚点）|
|---|---|
| `FeedDef` 加字段 `skip_cn_sensitive?` + cookie 头标记（如 `needs_weibo_cookie?`）| `worker/src/feeds/types.ts` |
| `FEED_REGISTRY` 加微博源条目（§7）| `worker/src/feeds/registry.ts` |
| `fetchFeedXml` 对带 cookie 标记的 feed 附加 `X-Weibo-Cookie` 头 | `worker/src/feeds/parse.ts`（现加 `X-RSSHub-Token` 处，约 L50）|
| `BlogPipelineParams` 透传 `skipCnSensitive`；工作流据此 force `cn_sensitive=0`（§4）| `worker/src/feeds/types.ts` + `worker/src/workflows/blog-pipeline.ts`（Step 4，L122-147）|
| cookie 失效 → PushDeer 告警 | `worker/src/notifier.ts`（复用）+ 抓取处识别信号 |
| cron 派发微博抓取（挂进 blog fetch 节奏）| `worker/src/index.ts` scheduled handler（约 L1528-1591 的 slot 派发）|
| `WEIBO_COOKIES` secret 注入 + 部署 | `wrangler secret put`，值取自 prod.env |
| 文档同步：`docs/operations.md` registry 段 + 源总数（38 → 39）| `docs/operations.md` |

> 开发流程走项目 CLAUDE.md「开发流程（强制）」：feature branch → staging 验证 → 合 main → prod；worker 改动先 `wrangler deploy --env staging` 验证；tsc 基线（当前 24 个既有 error，不得新增）；deploy 用 `set -a; . .secrets/aifeeds-{staging,prod}.env; set +a` source 整个 env 再跑。

### 6.3 registry 条目形状（参考）

```ts
{
  id: "blog:weibo-hot-tech",
  key: "weibo-hot-tech",               // 只含 [a-z0-9-]，进 item id / workflow instance-id
  kind: "blog",                        // 走 blog 工作流（is_ai gate + 翻译）
  format: "rss",                       // RSSHub 输出 RSS 2.0
  source_company: "微博",
  name: "微博科技热搜",
  region: "domestic",                  // 自动 lang='zh'
  via: "rsshub",                       // fetchFeedXml 拼 RSSHUB_BASE + X-RSSHub-Token
  feed_url: "<Codex 确认的科技热搜 route>",   // 待定
  cadence_hours: 0.5,
  fetch_strategy: "native",            // RSSHub 产出当普通 feed 解析
  skip_cn_sensitive: true,             // ← 仅此源跳过涉华敏感判定（§4）
  needs_weibo_cookie: true,            // ← fetchFeedXml 据此加 X-Weibo-Cookie 头
  notes: "微博科技热搜 via RSSHub(HK出口);热度雷达;平台已合规过滤→跳过cn_sensitive;保留is_ai gate;cookie走请求头",
}
```

---

## 7. 验收标准

### 7.0 Codex 实施结果（2026-06-25 更新）

| 项 | 结果 |
|---|---|
| RSSHub route path | `/weibo/hot/tech` |
| 公网入口 | `https://rss.ai-feeds.com/weibo/hot/tech` |
| HK VPS release | `/opt/rsshub/releases/9807609-aiera-jiqizhixin-weibo-desktop-20260625`（`/opt/rsshub/current` 已切换，`rsshub` service active） |
| cookie 注入方式 | Worker 读取 `WEIBO_COOKIES`，请求 RSSHub 时加 `X-Weibo-Cookie`；VPS 不保存微博 cookie。注意 cookie 值含分号，`.env` 中必须写成 `WEIBO_COOKIES='...'`，否则 `source` 会截断 |
| secret 文件 / 变量名 | `/Users/roxor/brain/30-projects/aifeeds/.secrets/aifeeds-prod.env` / `WEIBO_COOKIES` |
| Worker registry | `blog:weibo-hot-tech` / `key: "weibo-hot-tech"` / `feed_url: "/weibo/hot/tech"` / `needs_weibo_cookie: true` / `skip_cn_sensitive: true` |
| 敏感过滤 | 仅此源在 Blog workflow Step 4 走 `force-cn-sensitive-safe`，写 `extra.cn_sensitive=0`；`is_ai` gate、去重、翻译、媒体迁移保留 |
| cookie 失效告警 | `fetchFeedXml` 抛 `WeiboCookieMissingError` / `WeiboCookieInvalidError`，`runBlogFetch` 调 `notifyWeiboCookieInvalid`，PushDeer 标题「微博 Cookie 失效」，KV key `WEIBO_COOKIE_INVALID_ALERTED` 25h 去重 |
| Worker prod deploy | 已从干净临时 worktree 部署，只包含 `HEAD 742b3f9 + 微博 Worker patch`；Cloudflare Worker version `fce694ec-9a44-46b8-9048-18ed6d0ae491` |
| Cloudflare secret | `WEIBO_COOKIES` 已 `wrangler secret put` 到 prod worker `xlist-api` |
| 当前状态 | 已上线并手动触发 prod `blog-fetch`；微博源已 upsert，D1 已入库 51 条，1 条 AI 相关放行，43 条非 AI 被 gate 过滤 |

已完成 smoke：

```text
无 X-RSSHub-Token:
GET https://rss.ai-feeds.com/weibo/hot/tech -> 403 text/html (nginx)

有 X-RSSHub-Token、无 X-Weibo-Cookie:
GET https://rss.ai-feeds.com/weibo/hot/tech -> 401 application/json
body: {"code":"WEIBO_COOKIE_MISSING","message":"Missing X-Weibo-Cookie header"}

有 X-RSSHub-Token、伪造 X-Weibo-Cookie:
GET https://rss.ai-feeds.com/weibo/hot/tech -> 403 application/json
body: {"code":"WEIBO_COOKIE_INVALID","message":"Weibo cookie invalid"}

有 X-RSSHub-Token、有效 X-Weibo-Cookie:
GET https://rss.ai-feeds.com/weibo/hot/tech -> 200 application/xml; charset=utf-8
RSS size: 35514 bytes
item_count: 51
first_title: 高考数学唯一满分
first_description_bytes: 243

prod Worker 手动 `blog-fetch` 后 D1:
total=51, relevant=1, irrelevant=43, completed=44, cn_safe=1, pending=0
relevant sample: 谷歌前CEO批中国AI开源, cn_sensitive=0, completed_at=2026-06-25T09:46:53.256Z
```

已完成本地验证：

```text
RSSHub:
pnpm exec tsx scripts/weibo-hot-tech-route.test.ts -> pass
pnpm run build -> pass（仅 RSSHub 既有 namespace/eval warnings）

Worker:
npx tsx worker/src/feeds/parse-weibo-cookie.test.ts -> pass
./node_modules/.bin/tsc --noEmit -p worker/tsconfig.json -> 当前 repo 既有 HF/digest/x-card 类型错误阻塞；本次改动文件未出现在 error 列表
```

### 7.1 RSSHub 侧（Codex 自测 + 交付 smoke）

```text
正确 X-RSSHub-Token + 有效 cookie  → GET <route>  → 200，item 数 ≥ 10，每条 description 非空（带摘要），最新条近 24h
无 token                          → 403
失效/缺 cookie                    → 可区分的失效信号（401/403 或特定错误体，非泛化 503）
```

交付表（Codex 填）：

| 项 | 结果 |
|---|---|
| 确认的 route path | `/weibo/hot/tech` |
| 是否科技垂直榜（否则通用榜+说明）| 2026-06-26 修正为真实科技榜接口：微博 PC 前端 `RANK_TAB_GROUP_MAP.tech` 对应 `https://weibo.com/ajax/statuses/technology`。旧版曾误用 `https://weibo.com/ajax/statuses/hot_band`，实际是综合热搜，导致娱乐/体育/社会噪音过多。已重建并部署 HK RSSHub `dist`，公网 smoke 前 15 条包含豆包、苹果、IBM、李飞飞、百度、存储芯片等科技话题；RSS 30 items / 30 pubDate。 |
| item 数 / 首条 description 字节数 | 51 条 / 243 bytes |
| 最新条标题 / pubDate | 首条：高考数学唯一满分；该桌面 hot band API 不提供稳定 pubDate，RSSHub 用抓取时间作为 feed 时间语义 |
| cookie 注入方式（请求头 / VPS env）| 请求头 `X-Weibo-Cookie`；VPS 不落 cookie |
| cookie 失效信号形态 | 缺 cookie：`401 {"code":"WEIBO_COOKIE_MISSING"}`；微博拒绝 cookie：RSSHub route 设计为 `403 {"code":"WEIBO_COOKIE_INVALID"}` |

### 7.2 Worker 侧（staging 验证）

- staging 拉取微博源 → 有 item 入库、`is_relevant` 判别生效（非 AI 被滤）、中文正文/标题正常。
- **敏感过滤验证**：微博源 item 的 `extra.cn_sensitive` 全为 `0`（被 force），且**其它源**随机抽查 `cn_sensitive` 判定逻辑未受影响（仍会判出 0/1）。
- **告警验证**：手动用一个失效 cookie 跑一次 → 确认 PushDeer 收到「微博 cookie 失效」推送，且只推一次。
- C 端 staging 频道能看到微博来源的 AI 热点卡片。

---

## 8. 分工边界 + 开放确认点

| 谁 | 做什么 |
|---|---|
| **Codex** | RSSHub 微博路由（科技榜 + fulltext + cookie 头 + 失效信号）；**全部 worker/CF 改动**（registry / 类型 / parse 头 / 工作流 skip 逻辑 / 告警 / cron / secret / staging+prod 部署 / operations.md）；自测 + 交付 smoke |
| **user** | 把 `WEIBO_COOKIES` 写进 `.secrets/aifeeds-prod.env`；过期后按 §5.2 更新 |
| **cc** | 仅本 plan 撰写（按 user 指示）|

**开放确认点（请 user / Codex 落定）：**

1. **呈现定位**：微博热点是**直接当内容卡片进「新闻&播客」频道**（默认，本 plan 按此设计），还是**仅作选题雷达**（后台看、不进 C 端）？前者要处理「话题+摘要」这类碎片内容怎么渲染成卡片（标题=话题、正文=fulltext 摘要、链接=微博话题搜索页）。
2. **科技垂直榜可得性**：若微博科技榜无独立 API、只能取通用热搜，是否接受「通用榜 + is_ai gate 过滤」的形态（会多耗算力处理非 AI 噪音）？
3. **cookie 注入方式**：请求头注入（推荐，cookie 只在我方）vs VPS env（标准但 cookie 落 VPS）——由 Codex 实测后定，满足 §3.1 四约束即可。

---

## 9. 沿用既有基础设施（不重复搭）

- RSSHub 实例 / nginx / TLS / systemd / token 鉴权全沿用 06-22；本次只加路由 + 微博 cookie 机制。
- `RSSHUB_BASE` / `RSSHUB_TOKEN` 复用既有（prod.env），无新增；**新增 secret 仅 `WEIBO_COOKIES`**（`PUSHDEER_ADMIN_KEYS` 已存在）。
- 告警走既有 `notifier.ts` PushDeer，无新增告警基建。
