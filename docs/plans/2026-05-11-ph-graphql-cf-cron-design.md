# Product Hunt 抓取迁移：本地 browser-use → Cloudflare Worker + PH GraphQL API

> 日期：2026-05-11
> 状态：设计稿（brainstorming 已确认 → 待用户审稿 → 进入 writing-plans）
> 替代：[2026-05-03-product-hunt-source-design.md](2026-05-03-product-hunt-source-design.md)（旧本地 browser-use 方案）
> 关联：[docs/source-integration-sop.md](../source-integration-sop.md)、[docs/operations.md](../operations.md)
> PH API 文档：https://api.producthunt.com/v2/docs

---

## 1. 背景与动机

**旧方案**（已上线、待退役）：

- 本地 `scrapers/ph/scraper.py`（browser-use + 已登录 Chrome profile）抓 PH leaderboard + 逐 product 页面 → DOM extract → DeepSeek 判别+翻译 → POST `/api/ingest` → D1
- 依赖：本机 Chrome session、launchd/手动触发、browser-use Python 环境、turnstile 通过率不稳

**痛点**：

- 跨机不可移植，本机不在线就停摆
- browser-use + Chrome 维护成本高（profile 漂移、turnstile、版本升级），dev-log 多次踩坑
- DOM 选择器易随 PH 改版失效
- 资源消耗：每天单独起 Chrome 跑半小时

**新方案**：

- PH 官方 GraphQL API v2 + client_credentials OAuth → CF Worker cron 一站完成
- 沿用现有 worker dispatcher（`*/5 * * * *` + 抢占调度）+ 现有 ingest/r2/翻译/分类基础设施
- 旧 scraper 退役归档

**为什么现在做**：API 路径覆盖 ~85% 现有展示字段（详见 § 4），缺失部分用户已确认走优雅降级（前端隐藏对应区段）。

---

## 2. 目标 / 非目标

### 目标

1. CF Worker 每日定时抓 PH 昨日（PT 时区）leaderboard top 30 product
2. 沿用现有 D1 schema（items 表 + extra JSON + metrics_snapshots_ph 时序快照）
3. 现有前端无破坏性变更（缺失字段优雅降级，不动数据契约）
4. 旧 scraper 完整退役（代码归档、launchd 卸载、依赖清理）
5. 文档同步：CLAUDE.md 身份卡、operations.md、TODO.md

### 非目标

- 不抓 PH reviews 详情（Review 节点 GraphQL 不暴露，只能拿汇总数字）
- 不抓 pricing_type / is_open_source（GraphQL 不暴露）
- 不接 lazy-enrich-on-drawer 的 PH refresh（enrich.ts:242 那条 stub 留下个 PR）
- 不改 metrics_snapshots_ph 14 天回抓策略（沿用现状）
- 不重构 worker 现有 cron 调度模式（沿用 `*/5` + 抢占）

---

## 3. 决策矩阵（brainstorming 已确认）

| 维度 | 决策 | 备注 |
|------|------|------|
| MVP 字段范围 | 满足现有前端 PhCard + PhDrawerBody 展示即可 | § 4 字段覆盖矩阵 |
| 缺失字段处理 | **优雅降级**：reviews 段隐藏 / pricing+open_source chip 隐藏 / followers KPI 显 "—" | 不接 fallback scraper |
| Cron 节奏 | **每日 1 次，UTC 20:10（北京 04:10）抓 PT 前一天** | 此时 PT yesterday 的 daily_rank 已 14h+ 冻结稳定 |
| Cron 实现 | **沿用单一 `*/5` cron + dispatcher 时间窗判断 + KV 哨兵防重** | 与 GH/X/CH 一致 |
| API 凭证 | client_credentials flow，token 30 天 TTL，缓存到 KV | scope=public 足够 |
| 翻译/AI pipeline | **按 GitHub 模式新增 `ph-enrich` cron**（一次性产 is_ai + ai_category + ai_summary）→ fill-translations 扩展支持 PH 字段 → ph-r2-migrate 已就绪 | 不复用 X 流程的 classify-pending |
| 翻译过滤 | **仅翻译 is_relevant=1 的 PH item**（非 AI 相关跳过翻译） | 省 DeepSeek 额度 |
| Worker 内调用 ingest | **内部函数调用** `ingestItems()`，不走 HTTP self-fetch | 减 subrequest |
| Logo 识别 | `Post.thumbnail` → role='logo'，`Post.media[]` → gallery | 替代旧 DOM 识别 |
| Maker post 提取 | `Post.comments(order: VOTES_COUNT, first: 20)` → client-side 过滤 user.id ∈ makers，取首条 | 等价旧方案 |
| 文件组织 | 新建 `worker/src/scrapers/ph.ts`（fetch），现有 `worker/src/ph.ts` 改名 `worker/src/ph-r2.ts`（R2 迁移） | 区分 fetch vs r2 责任 |
| PR 粒度 | **主 PR**（M1-M7 + M9 + M10）staging 验收 → prod；**M8 旧 scraper 退役拆为安全期 PR**，prod 稳定运行 ≥7 天后再合 | 平衡"一步到位"与"留 rollback 余地" |
| 旧 scraper 处理 | **退役并归档** 到 `docs/archive/ph-scraper-retired.md`，scrapers/ph/ 目录删（git 历史保留） | launchd 卸载 |
| DeepSeek 模型 | `deepseek-v4-flash`（按 CLAUDE.md 选型规范，分类+翻译都属轻量） | classify+translate 都用 flash |

---

## 4. PH GraphQL API 覆盖矩阵

### 4.1 API 基础

- **Endpoint**：`POST https://api.producthunt.com/v2/api/graphql`
- **OAuth token endpoint**：`POST https://api.producthunt.com/v2/oauth/token`（grant_type=client_credentials）
- **Auth header**：`Authorization: Bearer <token>`
- **Rate limit**：6250 complexity points / 15min（GraphQL 按 query 复杂度计费，不是 req 计数）
- **预估消耗**：每天 ~1500-2000 points（list query ~50 + 30 个 detail query × ~50 = ~1550），远低于 6250/15min
- **Token TTL**：约定 30 天（PH 文档未明示，按行业惯例 + 失败时主动重换 fallback），缓存在 `AUTH_KV`

### 4.2 前端字段 ↔ API 字段映射

| 前端字段 | API 来源 | 状态 |
|---|---|---|
| name | `Post.name` | ✅ |
| tagline / content_translated | `Post.tagline` + DeepSeek 翻译 | ✅ |
| ai_summary（feed 卡片正文 + 抽屉 ④） | `Post.tagline` + `Post.description` 喂 DeepSeek 产出 | ✅ |
| daily_rank | API list query 返回顺序（按 votes desc 自然排名） | ✅ |
| launch_date_pt | `Post.featuredAt` 转 PT date string | ✅ |
| ph_url | `Post.url` | ✅ |
| website_url | `Post.website` | ✅ |
| ai_category | DeepSeek 分类（喂 name+tagline+description+topics） | ✅ |
| votes / comments | `Post.votesCount / commentsCount` | ✅ |
| **reviews_count / reviews_avg**（KPI 数字） | `Post.reviewsCount / reviewsRating` | ✅ |
| logo（role='logo'） | `Post.thumbnail` | ✅ |
| gallery（image/video） | `Post.media[]` | ✅ |
| makers (name/username/photoUrl) | `Post.makers[]` | ✅ |
| hunter | `Post.user`（PH 上 `user` 是 "User who created the Post" = hunter） | ✅ |
| top_comments[]（含 upvotes） | `Post.comments(order: VOTES_COUNT, first: 10)` | ✅ |
| maker_post（首条 maker 评论） | comments 里 client-side 过滤 user.id ∈ makers 取首条 | ✅ |
| topics（仅作 ai_category 判别输入） | `Post.topics(first: 5)` | ✅ |
| **followers** | ❓ Post 不暴露 followersCount | ⚠️ KPI 第 4 列显 "—" |
| **top_reviews[]**（body / rating / 作者） | ❌ Review 节点 GraphQL 不暴露 | ❌ 抽屉 ⑦ 段隐藏 |
| **pricing_type** | ❌ schema 不暴露 | ❌ ⑨ chip 隐藏 |
| **is_open_source** | ❌ schema 不暴露 | ❌ ⑨ chip 隐藏 |

### 4.3 GraphQL Query 草稿

**List query**（轻量，~50 points）：

```graphql
query PhDailyList($featuredAfter: DateTime!, $featuredBefore: DateTime!) {
  posts(
    featuredAfter: $featuredAfter,
    featuredBefore: $featuredBefore,
    order: VOTES,
    first: 30
  ) {
    edges {
      node { id slug name votesCount featuredAt }
    }
  }
}
```

**Per-post detail query**（~50 points × 30）：

```graphql
query PhPostDetail($id: ID!) {
  post(id: $id) {
    id slug name tagline description url website
    featuredAt createdAt
    votesCount commentsCount reviewsCount reviewsRating
    thumbnail { url type videoUrl }
    media { url type videoUrl }
    user { id name username headline profileImage(size: 96) }
    makers { id name username headline profileImage(size: 96) }
    topics(first: 5) { edges { node { name slug } } }
    comments(order: VOTES_COUNT, first: 10) {
      edges {
        node {
          id body votesCount createdAt
          user { id name username profileImage(size: 96) }
          parentId
        }
      }
    }
    productLinks { type url }
  }
}
```

> 字段名以实施 PR 中实测 introspection 为准（schema 文档某些字段名可能略有出入；context7 拿到的是社区抄录版）。PR 第一步先用 curl 跑一次拿到准确 schema 然后定型。

---

## 5. 架构

### 5.1 数据流

```
┌─ CF Worker cron (*/5 * * * *) ─────────────────────────────────────────┐
│                                                                        │
│  dispatcher (worker/src/index.ts scheduled handler)                    │
│    │                                                                   │
│    ├─ if (UTC hour=20 && min∈[10,14] && !KV[ph:fetched:YYYY-MM-DD])    │
│    │    └─→ runPhDailyFetch(env)                                       │
│    │         1. getPhAccessToken(env) — KV 缓存 30 天                  │
│    │         2. List query: posts(featuredAfter/Before=PT yesterday)   │
│    │         3. forEach post → detail query (sequential, 30 个)        │
│    │         4. transformPostToIngestItem(post) → IngestItem[]         │
│    │         5. ingestItems(env, items) — 内部函数调用                 │
│    │              · INSERT items (source_id=<slug>:<launch_date_pt>)   │
│    │              · ON CONFLICT bump votes/comments/daily_rank         │
│    │              · is_relevant=NULL, content_translated=NULL          │
│    │              · extra.r2_migrated_at=NULL                          │
│    │         6. INSERT metrics_snapshots_ph (今日快照)                 │
│    │         7. KV.put('ph:fetched:YYYY-MM-DD', '1', ttl=2d)           │
│    │                                                                   │
│    ├─ 后续 */5 tick 抢占接力（按优先级；与 GH/X 共享 budget）：        │
│    │                                                                   │
│    │  Pri 1: ph-enrich (新增, 参考 github-enrich 模式)                 │
│    │    SELECT items WHERE source_type='product_hunt'                  │
│    │                   AND is_relevant IS NULL                         │
│    │    → DeepSeek 一次出 {is_ai, ai_category, ai_summary}             │
│    │    → UPDATE items SET is_relevant=?,                              │
│    │       extra=json_set(extra, '$.ai_category', ?, '$.ai_summary',?) │
│    │                                                                   │
│    │  Pri 2: fill-translations (扩展, 加 PH 分支)                      │
│    │    SELECT items WHERE source_type='product_hunt'                  │
│    │                   AND is_relevant=1                               │
│    │                   AND (content_translated IS NULL OR ...)         │
│    │    → DeepSeek 翻 tagline/maker_post.text/top_comments[*].text     │
│    │                                                                   │
│    │  Pri 3: ph-r2-migrate (已存在 worker/src/ph.ts → 改名 ph-r2.ts)   │
│    │    SELECT items WHERE source_type='product_hunt'                  │
│    │                   AND extra.r2_migrated_at IS NULL                │
│    │    → fetch logo/gallery/avatars → R2 → 改写 URL                   │
│    │                                                                   │
└────────────────────────────────────────────────────────────────────────┘
```

**为什么 ph-enrich 而不是复用 classify-pending**：

- classify-pending 当前 SELECT `WHERE source_type='x_list'` + 用 X 推文 prompt + 输出仅 `{is_ai, ai_summary}`
- 不输出 `ai_category`（X 没这个概念）
- PH 跟 GitHub 同样需要 `is_ai + ai_category + ai_summary` 一起出 → 仿 github-enrich 写一份 ph-enrich 更直接、prompt 也更贴 PH 产品语境

**为什么先 enrich 后 translate**：

- enrich 出 is_relevant=0/1
- translate WHERE is_relevant=1 → 非 AI 产品**不消耗翻译 token**
- 已经是 X 流程现状（fill-translations:2210 SELECT 强制 `is_relevant = 1`），PH 沿用同一 pattern

### 5.2 worker 文件改动

```
worker/src/
├─ index.ts                — dispatcher 加 PH 时间窗触发 + ph-enrich/ph-r2-migrate 抢占 slot
├─ scrapers/
│  └─ ph.ts                — 新文件：OAuth、List query、Detail query、transform、runPhDailyFetch
├─ ph-r2.ts                — 现有 ph.ts 改名（仅迁移 R2，名字反映职责）
├─ enrich.ts               — 加 runPhEnrich() 函数；扩展 fill-translations SELECT 支持 PH;
│                            扩展 extractTasks 支持 PH 字段（tagline/maker_post/top_comments）
└─ wrangler.toml           — 加 PH_CLIENT_ID / PH_CLIENT_SECRET secrets 占位说明（值不入文件）
```

### 5.3 时区与 cron 时间精确定义

- **PH 一天**：以 PT (Pacific Time, UTC-7 PDT 夏令时 / UTC-8 PST 冬令时) 自然日界定
- **cron 触发**：UTC 20:10（北京 04:10），单 `*/5` 内 dispatcher 判断
- **抓的是哪一天的榜**：当前 PT date 的"昨天"。例：
  - UTC 2026-05-11 20:10 = PT 2026-05-11 13:10（PDT）→ "PT yesterday" = 2026-05-10
  - 抓 `featuredAfter=2026-05-10T00:00:00-07:00` & `featuredBefore=2026-05-11T00:00:00-07:00`
  - 此时 PT 5/10 已结束 13h+，daily_rank 已稳

> 跨夏/冬令时切换时（PDT ↔ PST），cron 仍是 UTC 20:10 不动；PT 偏移自动按 IANA tz `America/Los_Angeles` 算（worker 内用 `Intl.DateTimeFormat` 配 `timeZone: 'America/Los_Angeles'` 推 PT date string）。

### 5.4 KV 哨兵防重

```ts
const SENTINEL_KEY = `ph:fetched:${ptDateStr}`; // 例: "ph:fetched:2026-05-10"
const exists = await env.AUTH_KV.get(SENTINEL_KEY);
if (exists) return { skipped: 'already_fetched_today' };
// ... runPhDailyFetch ...
await env.AUTH_KV.put(SENTINEL_KEY, '1', { expirationTtl: 60 * 60 * 24 * 2 }); // 2 天
```

> 2 天 TTL 是为了：万一 worker 抢占当天该 slot 失败、24h 后重试不会被哨兵挡住。

---

## 6. 实施工作量分解（单一 PR 内的模块）

### M1：worker fetch 主流程（核心）

- 新建 `worker/src/scrapers/ph.ts`：
  - `getPhAccessToken(env)` — KV 缓存 + 失败时主动换新
  - `listPhDailyPosts(token, ptDate)` — GraphQL list query
  - `fetchPhPostDetail(token, postId)` — GraphQL detail query
  - `transformPostToIngestItem(post)` — API response → IngestItem
  - `runPhDailyFetch(env)` — 编排器，含 KV 哨兵
- `worker/src/index.ts` dispatcher 加 PH 时间窗判断 + 调用

### M2：ingestItems 暴露为函数

- 现状：`/api/ingest` HTTP handler 直接处理 IngestPayload
- PR 内：抽出 `ingestItems(env, items: IngestItem[])` 内部函数，HTTP handler 包一层校验调用它
- 不改 HTTP 契约，仅 refactor

### M3：ph-enrich 实现（参考 github-enrich）

- 新建 `worker/src/enrich.ts` 内的 `runPhEnrich(env, limit)`
- DeepSeek prompt：针对 PH 产品（含 name/tagline/description/topics），输出 `{is_ai, ai_category, ai_summary}`
- ai_category 枚举：与前端 `PH_CATEGORY_STYLE` 对齐 — `ai_agent / ai_code_editor / ai_image_gen / ai_audio / ai_voice_agent / ai_data_analysis / ai_other`
- dispatcher 加 ph-enrich 抢占 slot（pending 检查同 github-enrich 模式）

### M4：fill-translations 扩展支持 PH

- `selectTranslationCandidates` 加 PH 分支：`source_type='product_hunt' AND is_relevant=1 AND ...`
- `extractTasks` 加 PH 字段：tagline → content / maker_post.text / top_comments[*].text
- 翻译 UPDATE 写回路径：content_translated / extra.maker_post_translated / extra.top_comments[i].translated

### M5：ph-r2-migrate 改名 + dispatcher 接

- `worker/src/ph.ts` → `worker/src/ph-r2.ts`（仅文件名变更，导入路径 follow）
- 已经在 dispatcher 抢占 slot，无需新增

### M6：前端优雅降级

- `dashboard/src/components/PhDrawerBody.tsx`：
  - ⑦ Top Reviews 段：`{topReviews.length > 0 && ...}` 已有条件，无 reviews 数据时自然不渲染（可能不需要改）
  - ⑨ Pricing chip / 开源 chip：`{(pricingLabel || isOpenSource) && ...}` 已有条件（同上）
  - KPI followers：value `formatCompact(metrics.followers)` → 改成 `metrics.followers ? ... : "—"`（已经类似处理，确认即可）
- 不删 type 定义（保持向后兼容，万一未来 API 暴露这些字段直接用）

> 因为前端组件全部已用 `&&` 条件渲染缺失字段，**M6 实际只需轻微 polish + 视觉确认**。可能 0 行变更。

### M7：PH OAuth app 申请 + secret 注入

详见 § 7（这是用户手动操作 + 我帮注入 secret）。

### M8：旧 scraper 退役（**安全期 PR**，主 PR 之后 ≥7 天）

> 主 PR 内 **不动** scrapers/ph/ 与 launchd PH agent，留作 prod 翻车时的人工 fallback。prod 稳定 1 周后单独发 PR 执行：

- `scrapers/ph/` 目录**整个删除**（git 历史保留代码，可随时 checkout）
- 检查 `~/Library/LaunchAgents/com.aifeeds.ph*.plist` 是否存在，存在则 `launchctl unload` + 删 plist
- `docs/archive/ph-scraper-retired.md` 写一份归档说明：退役原因、旧实现概要、git 历史 SHA 范围

### M9：文档同步

- `CLAUDE.md` 项目身份卡：`Product Hunt 走 Convex` → `Product Hunt 走 PH GraphQL API + worker cron`
- `CLAUDE.md` 数据源现状段：刷新一致
- `docs/operations.md`：
  - 新增 PH cron 段（cron 表达式、什么时候跑、查日志命令）
  - 新增 PH secrets 段（PH_CLIENT_ID / PH_CLIENT_SECRET 怎么再生）
  - 删除/标记废弃旧 launchd PH agent 段（如有）
- `TODO.md`：勾掉 PH 相关旧任务，新增的小尾巴（如 lazy-enrich-on-drawer PH 留下次 PR）记上
- `docs/source-integration-sop.md`：PH 现在是 API-based 的样板，可以引用本文档作为 case study

### M10：wrangler.toml 收尾（可选）

- 检查除 PH 外是否有其他源用 `[browser]` binding（CF Browser Rendering）
- 若全无，删 `[browser] binding = "BROWSER"` 节省 paid plan 浏览器时长配额
- 若还有用（POC 残留 / 其他源），先留着，加注释说明

---

## 7. PH OAuth App 申请 onboarding（用户手动操作）

### 7.1 步骤

1. 浏览器打开 https://www.producthunt.com/v2/oauth/applications
2. 用 PH 账号登录（如无账号先注册一个，免费）
3. 右上角点 **"+ Add Application"**（或类似 New Application 按钮）
4. 填表：
   - **Name**：`AI Feeds`（任意可识别名）
   - **Redirect URI**：`https://ai-feeds.com/`（**必填字段，但 client_credentials flow 不会真的回调**——填首页 URL 占位即可，PH 不会真往这里发请求）
5. 提交
6. 进入 application 详情页，**复制 `API Key`（= client_id）和 `API Secret`（= client_secret）**
7. ⚠️ **API Secret 仅显示一次**，立即复制存好（如丢失需 regenerate）
8. 把 `client_id` 和 `client_secret` 给我（私聊或本地 .secrets/ 文件路径），我用 wrangler 注入两个环境

### 7.2 secret 注入命令（我执行）

```bash
# Staging
echo "<CLIENT_ID>"     | npx wrangler secret put PH_CLIENT_ID --env staging --config worker/wrangler.toml
echo "<CLIENT_SECRET>" | npx wrangler secret put PH_CLIENT_SECRET --env staging --config worker/wrangler.toml

# Prod (--env 省略 = prod)
echo "<CLIENT_ID>"     | npx wrangler secret put PH_CLIENT_ID --config worker/wrangler.toml
echo "<CLIENT_SECRET>" | npx wrangler secret put PH_CLIENT_SECRET --config worker/wrangler.toml
```

> 操作完后 `wrangler secret list` 验证。Secret 值不会再回显，文档/git 里只引用 key 名称，**不写值**。

---

## 8. 验证与测试计划

### 8.1 本地（worker dev）

- `wrangler dev --env staging` 起本地 worker（连 staging D1）
- 加临时 admin endpoint `POST /admin/ph-fetch-now`（带 admin token），手动触发 `runPhDailyFetch` 一次
- 检查：
  - PH OAuth token 拿到、KV 缓存写入
  - List + 30 detail query 全跑通，无 GraphQL 报错
  - items 表新增 30 条 PH item，字段完整
  - metrics_snapshots_ph 新增 30 条快照

### 8.2 Staging（end-to-end）

- 把 staging 的 `[env.staging.triggers] crons` 临时打开（已有 dispatcher 时间窗判断，但 staging 平时关 cron）
- 触发一次 daily fetch，等几分钟看：
  - ph-enrich 自动跑：is_relevant 写入、ai_category 合理
  - fill-translations 自动跑：tagline_translated / maker_post_translated 写入
  - ph-r2-migrate 自动跑：media URL 改写为 `/r/ph/<sha>`
- staging dashboard 打开（`https://staging.ai-feeds.com`）肉眼看 feed + 抽屉
  - 缺失字段（reviews/pricing/open_source/followers）优雅降级，无破图
  - 翻译质量 OK
  - logo / gallery / 头像加载正常（R2 路径）
- 跑 1-2 天，确认 cron 自动触发、KV 哨兵防重生效

### 8.3 Prod 上线

- 合 PR 到 main → CICD 自动 deploy worker + dashboard（或手动 wrangler deploy）
- prod 等到次日 UTC 20:10（北京次日 04:10）首次自动跑
- 观察 worker logs（`wrangler tail`）确认走通
- 第一日勤盯：next-day prod feed 新增 PH 内容、抽屉数据完整

### 8.4 Rollback 预案

如主 PR 上 prod 后翻车：

- 临时关停 PH：把 dispatcher 时间窗判断改成 `if (false && ...)` 单行禁用，redeploy
- 旧 scraper 还在（M8 安全期 PR 未合），可手动跑一次补当日数据：
  ```bash
  ~/.browser-use-env/bin/python3 -m scrapers.ph.scraper --leaderboard=YYYY-MM-DD
  ```
- 复盘后修主 PR 引入的 bug，二次 deploy

---

## 9. 文档同步清单（落 PR 时一并改）

| 文件 | 改动 |
|---|---|
| `CLAUDE.md` | 项目身份卡 "PH 走 Convex" → "PH 走 PH GraphQL API + worker cron"；数据源现状段同步 |
| `docs/operations.md` | 新增 PH cron 段（时间表、查日志、手动触发）；新增 PH secrets 段（再生流程） |
| `TODO.md` | 勾掉 PH browser-use 相关旧任务；新增 PH lazy-enrich-on-drawer 留下次 PR |
| `docs/archive/ph-scraper-retired.md`（新文件） | 退役说明 + 旧实现摘要 + git history pointer（M8 时建） |
| `docs/source-integration-sop.md` | 新增"API-based 源接入参考：PH（本文档）"段 |
| `docs/plans/2026-05-03-product-hunt-source-design.md` | 顶部加横幅："此设计已被 2026-05-11 替代" |

---

## 10. 风险与应对

| 风险 | 概率 | 影响 | 应对 |
|---|---|---|---|
| PH GraphQL schema 字段名跟 context7 文档对不上 | 中 | 中 | PR 第一步用 curl introspection 实测 schema 定型，再写 query |
| PH API rate limit 算复杂度比预估高 | 低 | 低 | 6250 / 15min vs 预估 ~2000 / day，仍有 90%+ buffer；超限有 X-Rate-Limit-* header 兜底 |
| client_credentials token 实际 TTL 短于 30 天 | 低 | 低 | 每次 fetch 前先 GET KV，401 时主动换新 + 写 KV（KV TTL 设保守的 25 天） |
| PH 改 schema 删字段（如 reviewsCount） | 低 | 中 | 单字段 nullable 处理，前端已优雅降级；schema 大改 PR 单独应对 |
| ph-enrich DeepSeek 分类不准 | 中 | 低 | 复用 github-enrich 同模式，PR 后看实际数据 → 调 prompt + 重跑 |
| fill-translations 加 PH 分支引入对 X 流程的回归 | 中 | 中 | SELECT 用 OR 分组明确隔离；staging 跑 1-2 天看 X 翻译有无掉队 |
| KV 哨兵跨日写入抖动（cron 在 UTC 边界附近） | 低 | 低 | sentinel key 用 PT date string（不是 UTC date），自然贴合 PH 业务日 |
| staging 验收时漏掉前端缺失字段视觉问题 | 中 | 低 | M6 视觉确认列入 staging checklist；@chat 截图对比 |
| 旧 scraper 退役后 PH API 突然挂掉 | 极低 | 高 | M8 拆出后续 PR，prod 稳定 1 周后才退役；旧 scraper 死前可手动跑 |

---

## 11. 待 PR 中决定的细节（非 blocker）

- GraphQL query 字段名实测后是否需要拆 list+detail（如果 list query 直接给 detail 字段也够，可省一半 query）
- ai_category 枚举 7 类够不够；M3 prompt 第一版按现有 7 类写，跑后看是否需要扩
- ph-enrich batch 大小（github-enrich 默认 1 个/tick，PH 可参照；30 个/天即 30 tick 内全 enrich 完，约 2.5h）
- maker_post 和 top_comments 翻译要不要合到一个 DeepSeek call（节约 token）vs 分开（更解耦）
- featuredAt 的"yesterday" 边界处理：PH list 是否真的 strict featuredAt within range，还是含跨日 hybrid

---

## 12. 决策日志

> [!important] 决策记录 2026-05-11
> **决策**：PH 抓取从本地 browser-use 迁到 CF Worker + PH GraphQL API + 单 cron 抢占调度
> **依据**：API 覆盖前端 ~85% 字段；缺失部分用户已确认可优雅降级；现有 worker 调度 pattern 完美贴合（GH/X/CH 三源已同套路），运维大幅简化
> **替代方案**：保留 scraper 做 reviews/pricing 补丁（被否：维护负担 vs 收益不成正比）；探索 PH 网页 JSON-LD 抽缺失字段（被否：风险高且 PoC 成本高，留作未来探索）
> **预期结果**：旧 scraper 退役、本地无 launchd 依赖、CF 月度浏览器时长配额释放、PH feed 跨机可用、抓取稳定性大幅提升

---

> 设计文档结束。下一步：用户审稿 → invoke writing-plans 出实施计划。
