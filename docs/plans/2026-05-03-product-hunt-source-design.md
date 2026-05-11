# Product Hunt 源接入设计

> ⚠️ **此设计已被 [2026-05-11-ph-graphql-cf-cron-design.md](2026-05-11-ph-graphql-cf-cron-design.md) 替代**。
> 本文档保留作历史参考——本地 browser-use 抓取方案已退役（M8 安全期 PR 后将删 scrapers/ph/），PH 全量改走 GraphQL API + CF Worker cron。
>
> 日期：2026-05-03
> 状态：~~设计稿~~ 已实施 + 2026-05-11 退役
> 对应 SOP：[docs/source-integration-sop.md](../source-integration-sop.md)
> Mockup：[_mockups/2026-05-03-ph-drawer-mockup.html](_mockups/2026-05-03-ph-drawer-mockup.html)

---

## 1. 决策矩阵（已 brainstorming 确认）

| 维度 | 决策 |
|------|------|
| 抓取深度 | **A**：daily 榜单全榜深抓（30+ 产品/天），LLM 打 `is_ai` flag，feed 默认只显示 is_ai=1，未来可放开 |
| 评论深度 | **C**：抓 maker post + 主页 top 10 评论（含 maker reply 1 级嵌套）；`/p/{slug}` 论坛页二期再做 |
| feed 卡片 | **B**：左侧 logo + 右侧 name/tagline/metrics，daily rank badge 前置 |
| 抓取节奏 | **A**：每天 PT 0:30（`TZ=America/Los_Angeles`，自动跟 PST/PDT 切换）跑一次 cron，新榜抓取 + 14 天回抓 metrics 一次完成 |
| 翻译范围 | tagline / AI 解读 / Maker post / Top 10 评论（含 maker reply）/ Top 5 Reviews body **翻**；reviews positive/negative notes / categories 名称 **不翻** |
| R2 资源 | **A**：复用 GH 的 `xlist-readme-assets` bucket，key 加 `ph/` 前缀；logo / gallery 图 / gallery 视频 / makers + hunter + 评论者 + reviewer 头像**全量迁** |
| Scraper 实现 | **B**：CF Browser Rendering（`@cloudflare/puppeteer` + `env.BROWSER`），先做 POC 验证 turnstile 通过率；POC 失败则 fallback 到 A（本地 Python + browser-use）|
| Drawer 结构 | 9 段：头部 / KPI / Gallery / AI 解读 / Maker post / 团队 / Top Reviews / Top 评论 / 论坛+类似产品+Pricing |
| Pricing chip | 6 状态：Free / Freemium / 订阅 / Paid / 开源（独立 chip 可叠加）/ Free trial |
| 14 天 metrics | `metrics_snapshots_ph` 表持续记录前 14 天，14 天后停止 append 但**保留所有历史 snapshot** |

---

## 2. Schema 增量

### 2.1 `items` 表（共享字段映射）

| 列 | PH 值 |
|----|------|
| `id` | `<source_type>:<source_id>` 复合 |
| `source_type` | `'product_hunt'` |
| `source_id` | `<product_slug>:<launch_date_pt>` 例：`zed:2026-05-02`（防同一产品多次 launch 重复入库）|
| `title` | `<product_name>` 例 `"Zed"` |
| `content` | `<tagline>` 例 `"The Fastest AI Code Editor"` |
| `author` | `<first_maker_name>` |
| `handle` | `<first_maker_handle>`（不带 @） |
| `created_at` | `<launch_at_pt>` ISO timestamp，PT 时间 launch 日的 0:00 |
| `metrics` | JSON：`{votes, comments, reviews_count, reviews_avg, followers}` |
| `media` | JSON：gallery 图片 / 视频 URL list（迁 R2 后是 `/r/ph/<sha>` 路径）|
| `lang` | `'en'`（默认；PH 内容大多英文）|
| `is_relevant` | 0/1（LLM 判定 AI 相关，决定 feed 默认是否显示）|
| `translated` | 0/1（翻译完成 flag）|
| `extra` | JSON 大杂烩，见下表 |

### 2.2 `items.extra` JSON 字段

```jsonc
{
  "daily_rank": 1,                          // PH 当日排名 1-30
  "launch_date_pt": "2026-05-02",          // PT 时区日期 string
  "product_slug": "zed",                    // PH /products/<slug>
  "ph_url": "https://www.producthunt.com/products/zed",
  "website_url": "https://zed.dev",         // 产品官网
  "description": "...",                     // PH 短 description（schema.org）
  "pricing_type": "free",                   // free | free_options | paid | subscription
  "is_open_source": true,                   // 独立 flag
  "price": null,                            // schema.org offers.price，可能 null
  "categories": [
    { "name": "Vibe Coding Tools", "slug": "vibe-coding",
      "parent_name": "Engineering & Development", "parent_slug": "engineering-development" }
  ],
  "makers": [
    { "name": "Thorsten Ball", "handle": "thorstenball", "avatar_url": "/r/ph/<sha>" }
  ],
  "hunter": { "name": "...", "handle": "...", "avatar_url": "/r/ph/<sha>" },
  "ai_summary": "Zed 1.0 是…",              // LLM 生成 100-200 字中文
  "ai_category": "ai_code_editor",          // LLM 分类（标准化 slug）
  "maker_post_text": "Hi everyone…",        // 原文
  "maker_post_translated": "大家好…",       // 中文
  "top_comments": [
    {
      "author_name": "Marie Curie",
      "author_handle": "mariec",
      "author_avatar_url": "/r/ph/<sha>",
      "text": "...", "translated": "...",
      "upvotes": 24,
      "posted_at": "2026-05-02T17:30:00Z",
      "maker_replies": [
        {
          "author_name": "Thorsten Ball",
          "author_handle": "thorstenball",
          "is_maker": true,
          "text": "...", "translated": "...",
          "posted_at": "2026-05-02T18:15:00Z"
        }
      ]
    }
    // ... 最多 10 条
  ],
  "top_reviews": [
    {
      "author_name": "...",
      "author_avatar_url": "/r/ph/<sha>",
      "rating": 5,
      "body": "...", "body_translated": "...",
      "positive_notes": ["fast performance", "lightweight"],  // 不翻
      "negative_notes": ["limited extensions"]
    }
    // ... 最多 5 条
  ],
  "r2_migrated_at": "2026-05-03T08:30:00Z"
}
```

### 2.3 新表 `metrics_snapshots_ph`

```sql
CREATE TABLE IF NOT EXISTS metrics_snapshots_ph (
  item_id        TEXT NOT NULL,
  captured_at    INTEGER NOT NULL,    -- ms since epoch
  votes          INTEGER,
  comments_count INTEGER,
  reviews_count  INTEGER,
  reviews_avg    REAL,
  followers      INTEGER,
  daily_rank     INTEGER,
  PRIMARY KEY (item_id, captured_at),
  FOREIGN KEY (item_id) REFERENCES items(id)
);
CREATE INDEX IF NOT EXISTS idx_ms_ph_item_time ON metrics_snapshots_ph(item_id, captured_at);
```

每天 cron append 一行，14 天后停止 append（不删旧数据），让 dashboard 能画 launch 后 14 天的增长曲线（未来 v2 再加可视化）。

### 2.4 telemetry 事件（无新增）

复用现有：`item_open_drawer / item_close_drawer / external_link_click / share_click / image_lightbox_open / feed_load_error / api_error`。

---

## 3. Scraper 设计

### 3.1 总体流水线

```
[CF Browser Rendering env.BROWSER]
  ↓ fetch /leaderboard/daily/<Y>/<M>/<D> PT
  ↓ parse 30 个产品 entry → product slugs + daily ranks
  ↓ for each slug:
      ↓ fetch /products/{slug}
      ↓ extract via JSON-LD + RSC + DOM:
          - schema.org: name / tagline / image / screenshot[] / makers / aggregateRating
          - GraphQL state: votesCount / commentsCount / reviewsCount / followersCount / categories / pricingType
          - DOM: maker post (top of comment thread) / top 10 comments / top 5 reviews
  ↓ LLM judge (DeepSeek V4 Flash):
      - input: name / tagline / description / maker post / categories / top 1-3 comment snippets
      - output: { is_ai, ai_category, ai_summary } JSON
  ↓ if is_ai: 触发翻译 (DeepSeek):
      - tagline / maker post / top 10 comments + maker replies / top 5 review bodies
  ↓ R2 migrate:
      - logo / gallery / video / 头像（makers + hunter + commenters + reviewers）→ ph/<sha>
  ↓ INSERT into items + INSERT first row into metrics_snapshots_ph
  ↓ done
```

14 天回抓 mode（同 cron 内）：

```
SELECT id, source_id, extra FROM items
WHERE source_type='product_hunt'
  AND extra->>'launch_date_pt' > today_pt - 14 days

for each item:
  fetch /products/{slug} (轻量，不重新 deep parse)
  extract just GraphQL state metrics (votes / comments / reviews_count / reviews_avg / followers)
  INSERT into metrics_snapshots_ph
  也更新 items.metrics（覆盖最新值）
```

### 3.2 抓取实现位置

**首选 B：CF Browser Rendering**

- Worker scheduled() 内 `import puppeteer from "@cloudflare/puppeteer"`
- 用 `env.BROWSER` binding（`wrangler.toml` 加 `[browser] binding = "BROWSER"`）
- 单实例 puppeteer 串行抓 30 个产品 + 420 个 metrics-only 页
- 月度预算 ≈ 5h × 30 天 = 150min/天，远低于 Workers Paid 月含 10h

**Fallback A：本地 Python + browser-use**

- 复用 `scrapers/_shared/` 的 LLM client / DB client / Chrome 焦点处理 / kill-by-data-dir
- launchd cron `TZ=America/Los_Angeles` 触发
- 风险：MacBook 不开机就不跑

### 3.3 POC 验证项（Phase 1 第一步）

写一个 60 行 worker 脚本：

1. 用 `@cloudflare/puppeteer` connect `env.BROWSER`
2. 访问 `https://www.producthunt.com/products/zed`
3. wait until page title 包含 "Zed"
4. 拿 HTML，grep `application/ld+json`
5. 输出 JSON-LD blocks 数量 + 第一段 `og:description`

**通过标准**：

- [ ] 不被 turnstile 卡死（HTML 不是 challenge 页）
- [ ] JSON-LD 至少 4 个 blocks
- [ ] 单页耗时 < 8s
- [ ] worker 内存占用 < 128MB

POC 通过 → Phase 2 全量实施。POC 卡 turnstile → 切回 fallback A（本地 Python）。

### 3.4 抓取频率与停止条件

- 每天 PT 0:30 跑一次（`TZ=America/Los_Angeles`，`30 0 * * *`）
- 不再增量（PH 榜单当天 PT 截止后 1h 已稳定）
- 14 天回抓在同一 cron 一次跑完
- 单次 cron 总时长 < 15 分钟

---

## 4. LLM Prompt 设计

### 4.1 Judge Prompt（每产品 1 次）

```
[输入]
- name: <product_name>
- tagline: <tagline>
- description: <ph_description>
- categories: <category_list_with_parents>
- maker_post: <maker_post_text> (前 500 字)
- top_comments_sample: 前 3 条评论 + maker_replies (各前 200 字)

[任务]
判断这个产品是否与 AI 强相关。AI 相关定义：
- 产品核心功能依赖 AI/LLM/ML/CV/NLP 模型
- 或 AI 是产品主打卖点
- 排除：仅集成 AI 作为附加功能（如仅有 AI 自动补全的非 AI 编辑器）

如果是 AI 相关：
- 输出 ai_category（slug 形式）：ai_code_editor, ai_chatbot, ai_agent, ai_image_gen, ai_video_gen,
  ai_audio, ai_writing, ai_search, ai_dev_tool, ai_workflow, ai_voice_agent,
  ai_data_analysis, ai_design_tool, ai_other
- 输出 ai_summary（100-200 字中文）：包含
  · 一句话定位
  · 1-2 个独特卖点
  · 适用人群（开发者 / 设计师 / 内容创作者 / 商业用户 / 学术研究 / 其他）
  · 与 1-2 个同类产品的差异点（如有 categories 命中近似产品）

[输出]
{
  "is_ai": true/false,
  "ai_category": "<slug>" | null,
  "ai_summary": "<100-200 字中文>" | null
}
```

成本估算：30 产品 × ~600 tokens input × $0.10/M + ~300 tokens output × $0.40/M ≈ $0.005/产品 = **$0.15/天**。

### 4.2 翻译 Prompt（per 字段）

```
[任务] 把以下 PH 文本翻译为简体中文。
- 保留产品名 / 公司名 / 技术术语原文（不翻 "Cursor" / "TypeScript" / "LSP" 等）
- 保留 @username
- 保留 markdown 格式（**bold**, [link](url) 等）
- 翻译风格：自然口语化（评论） / 正式 product copy（maker post / tagline）

[原文]
<text>

[输出] 只输出译文。
```

每天总翻译字数估算：
- tagline: 30 × 30 字 = 900 字
- maker post: 30 × 300 字 = 9000 字
- 评论: 30 × 10 × 100 字 = 30000 字
- maker reply: 30 × 5 × 50 字 = 7500 字
- review body: 30 × 5 × 200 字 = 30000 字
- **合计 ≈ 80K 字 = 120K tokens 输入 + 60K tokens 输出**
- 成本 ≈ $0.012 + $0.024 = **$0.036/天**

LLM 总成本约 **$0.20/天 = $73/年**。

---

## 5. R2 资源策略

### 5.1 迁移范围

| 资源 | per 产品 | 平均大小 | 月度增量 |
|------|---------|---------|---------|
| Logo | 1 | 30KB | ~30KB × 900/月 ≈ 27MB |
| Gallery 图 | 4 | 100KB | ~120MB |
| Gallery 视频 | 0.3 | 3MB | ~30MB |
| 头像（makers + hunter + commenters + reviewers）| ~25 | 15KB | ~280MB |
| **合计** | | | **~460MB/月 ≈ 5.5GB/年** |

CF R2 免费额度 10GB 存储（够 18 个月不爆），出站到 worker 0 流量费。

### 5.2 R2 keys 与上限

```
xlist-readme-assets/ (复用 GH bucket)
├── gh/<sha256>.<ext>   (existing)
└── ph/<sha256>.<ext>   (new)
```

每 item 资产 cap：
- max_logos: 1 × ≤ 5MB
- max_gallery_images: 5 × ≤ 5MB
- max_videos: 2 × ≤ 10MB
- max_avatars: 30 × ≤ 1MB
- 总 cap: 38 资产 / 50MB

迁移幂等：
- key = `ph/<sha256(原 URL).bin[:16]>.<ext>`
- 已存在则跳过
- 已是 `/r/ph/` 路径跳过（防重 migrate）

worker 的 `/r/<key>` route 已存在，不用动。

### 5.3 R2 cron mode

复用 GH 的 cron 抢占轮转，PH 加进去：

```
preempt rotation:
  enrich(gh) → r2-migrate(gh) → translate(gh) →
  ingest(ph) → r2-migrate(ph) →
  X scraper
```

---

## 6. Dashboard UI

### 6.1 Card 组件

`dashboard/src/components/PhCard.tsx`（仿 GithubCard.tsx）

布局参见 mockup `2026-05-03-ph-drawer-mockup.html` 顶部 Card region（Q3 锁定的 B variant）。

字段：
- 左侧 64×64 logo（rounded-2xl）
- 右侧上方：`#<rank> · <date> PT · <category badge>`
- name (bold) + tagline (1 行)
- 底部 metrics row：`▲ <votes> · 💬 <comments> · by @<maker>`

### 6.2 Drawer 组件

`dashboard/src/components/PhDrawerBody.tsx`（仿 GithubDrawerBody.tsx）

9 段结构（mockup 已锁）：

1. 产品头部（logo + name + tagline + rank/date + categories chips + 官网弱链接）
2. KPI 行（votes / comments / reviews / followers 四象）
3. Gallery（横滑 + Lightbox 复用）
4. AI 解读（无标题，直接铺正文，bg-neutral-50/40 强调）
5. Maker post（avatar + handle + MAKER chip + 翻译 toggle）
6. 团队（makers + hunter）
7. Top Reviews 5 条（含 positive/negative notes 标签）
8. Top 10 评论（含 maker reply 嵌套 + 翻译 toggle）
9. 更多（论坛/类似产品出链 + pricing chips）

复用：
- `Lightbox` 组件
- `TweetDrawer` 的双击回顶 / 动态 title / swipe-to-close
- `data-drawer-title-anchor` 用于 title 切换（Q4 已在 GH drawer 实现）

### 6.3 SourceIcon

加 `IconProductHunt`（PH 官方猫 icon，简化 SVG，橙色 #DA552F）。

### 6.4 App.tsx 注册

```ts
const SOURCE_COLUMNS: SourceConfig[] = [
  { source_type: "x_list", title: "X List" },
  { source_type: "youtube", title: "YouTube" },
  { source_type: "github", title: "GitHub" },
  { source_type: "podcast", title: "Podcast" },
  { source_type: "product_hunt", title: "Product Hunt" },  // 已存在，去 placeholder
  { source_type: "arxiv", title: "arXiv" },
];

const FILTER_CHIPS: { key: FilterKey; label: string }[] = [
  // ...
  { key: "product_hunt", label: "PH" },
];
```

`product_hunt` 在 `dashboard/src/types.ts` SourceType union 已存在（占位中），改 `placeholder` 逻辑让有数据时自动激活。

---

## 7. Phase 拆分（实施计划）

### Phase 0：设计 + Mockup（已完成）✓
- design doc（本文档）
- HTML mockup（drawer 已 approved）
- Q1-Q10 决策矩阵已锁

### Phase 1：Schema + POC（0.5 天）

- [ ] 加 `metrics_snapshots_ph` 表 SQL → `worker/src/schema.sql`
- [ ] 不需要新增 telemetry event（复用现有）
- [ ] D1 migrate（`wrangler d1 execute xlist --remote --file=...`）
- [ ] **POC：CF Browser Rendering 抓 PH 单页**（验证 turnstile）
  - 写 `worker/src/scrapers/ph_poc.ts` ~60 行
  - 加 `wrangler.toml` 的 `[browser]` binding
  - `wrangler deploy` + 手动触发
  - 通过/失败决策点

### Phase 2：Scraper 主体（2-3 天）

- [ ] `worker/src/scrapers/ph/leaderboard.ts` — 拉 daily 榜单 → product slugs
- [ ] `worker/src/scrapers/ph/product.ts` — 拉单个 /products/<slug> → canonical Item shape
  - JSON-LD 解析（WebApplication + Review blocks）
  - GraphQL state 解析（regex 抓 votesCount / categories / etc.）
  - DOM 解析（maker post + top 10 comments + top 5 reviews）
- [ ] `worker/src/scrapers/ph/judge.ts` — DeepSeek judge
- [ ] `worker/src/scrapers/ph/translate.ts` — DeepSeek 翻译批量
- [ ] `worker/src/scrapers/ph/r2_migrate.ts` — 资产迁移
- [ ] `worker/src/scrapers/ph/index.ts` — 串联 + INSERT 到 D1
- [ ] 本地 `wrangler dev` 单 product slug 端到端测

### Phase 3：Cron + 14 天回抓（1 天）

- [ ] `worker/src/index.ts` 的 `scheduled()` 加 ingest 抢占
- [ ] cron 写 `30 0 * * *` `TZ=America/Los_Angeles`
- [ ] 14 天回抓逻辑（轻量 metrics fetch）
- [ ] subrequest 预算估算 + 拆分多次 invocation 如超
- [ ] `wrangler deploy` + `wrangler tail` 观察 cron 日志

### Phase 4：Dashboard UI（2 天）

- [ ] `PhCard.tsx`（B variant，参考 mockup）
- [ ] `PhDrawerBody.tsx`（9 段，参考 mockup）
- [ ] `IconProductHunt` SVG
- [ ] App.tsx 把 PH 从 placeholder 升级
- [ ] Feed.tsx 路由 `source_type === 'product_hunt'` → `<PhCard>`
- [ ] TweetDrawer.tsx 路由 `isPh` → `<PhDrawerBody>`
- [ ] 移动 + PC smoke test

### Phase 5：R2 全量迁移（已含在 Phase 2）

不单独成 Phase。Scraper 跑完直接迁。复用 GH 的 r2-migrate worker mode。

### Phase 6：真机验收（0.5 天）

- [ ] iOS Safari + 微信 WebView（preview URL）
- [ ] 安卓 Chrome + 微信（必须走 ai-feeds.com main 自定义域）
- [ ] golden path：
  - [ ] feed 显示 PH 列
  - [ ] 点开 PH 卡片 drawer
  - [ ] gallery 横滑 + 点开 lightbox
  - [ ] 翻译 toggle（maker post / 评论 / reviews body）
  - [ ] 双击 header 回顶
  - [ ] 右上角"在 PH 打开 ↗"跳出
- [ ] telemetry 检查：item_open_drawer / external_link_click 命中

### Phase 7：operations.md 更新（0.5 天）

- [ ] 加 worker scheduled mode `ingest_ph`
- [ ] 加 D1 表 `metrics_snapshots_ph`
- [ ] 加 R2 key 前缀 `ph/`
- [ ] 加 LLM 成本估算
- [ ] 更新 cron schedule + TZ 处理
- [ ] secrets 无变化（DeepSeek API key 已有）

---

## 8. 风险登记

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| CF Browser Rendering 过不了 PH turnstile | 中 | 高 | Phase 1 POC 先验证；fallback 到本地 Python |
| Worker scheduled subrequest 预算不够（30 product × 多页 fetch + 420 回抓）| 中 | 中 | 用 cron 抢占轮转 + 多次 invocation 拼凑；必要时拆成 ingest cron + refresh cron 两个时间段 |
| PH 单页 CF Browser 时间过长（> 30s）触发超时 | 中 | 中 | per-page timeout 8s，单产品多次 retry 1 次；超时 skip 不阻塞队列 |
| LLM judge 误判：把非 AI 产品标 is_ai=1 / 漏判 AI 产品 | 中 | 低 | LLM prompt 给精确 AI 定义；UI 加用户反馈"标错"按钮（v2）；定期 review 边界 case 调 prompt |
| 翻译质量参差（口语 / 行话 / 颜文字）| 中 | 低 | 翻译 prompt 强调保留专有名词 + 风格约束；用户可切回原文 |
| PH 改版导致 JSON-LD / GraphQL state 结构变 | 中 | 高 | scraper 加 fail-safe（缺字段不 throw，记日志 + 保留可用字段）；用 alarm 在解析失败率 > 20% 时告警 |
| 14 天回抓时 PH 隐藏旧产品页 | 低 | 中 | 旧产品页通常仍可访问；如果失败 just skip，metrics 缺一天数据点不影响 |
| R2 资源迁移失败（图被 PH 删除 / 跨域）| 低 | 低 | 迁移失败保留原 URL，frontend `<img onError>` 已有兜底 |

---

## 9. 决议落地（待 Phase 1 开始）

1. ✅ 设计 doc 完成
2. ✅ Mockup approved
3. ⏳ 用户 sign-off → 进 Phase 1
4. ⏳ POC 通过 → 进 Phase 2 全量

预估总工时：**6-7 天**（POC 顺利的话）。POC 失败回退本地 Python ≈ +1 天。

---

## 附：Mockup 文件

`docs/plans/_mockups/2026-05-03-ph-drawer-mockup.html`

3 屏：

1. drawer 全貌（420px 移动端模拟）
2. sticky header 接管 title 示意（"项目详情" → "Zed · #1"）
3. pricing chip 6 状态参考 + 3 个组合举例（Cursor / VS Code / Sublime）
