# 信息源接入 SOP

> 验证于 X List + GitHub 两个源接入。接下来 YouTube / Podcast / Product Hunt / arXiv 走这套路径，目标 80% 复用 + 20% 源特异性。

## 0. TL;DR Checklist（每个新源照做）

```
□ Phase 0  设计文档 + HTML mockup（用户确认后再写代码）
□ Phase 1  Schema 增量（item.source_type 枚举、metrics_snapshots_<src>、event 白名单）
□ Phase 2  Scraper（fetch → parse → LLM judge → translate → DB）
□ Phase 3  Worker pipeline（cron 抢占 + /api/items 复用 + R2 endpoint 复用）
□ Phase 4  Dashboard：<Src>Card + <Src>DrawerBody + SourceIcon + App.tsx 注册
□ Phase 5  R2 资源（如有图/视频）— 复用 r2-migrate 模式
□ Phase 6  iOS + Android 真机验收（PC + 移动）
□ Phase 7  operations.md 同步更新（cron / endpoint / D1 schema 增量）
```

## 1. 已搭好的复用资产（不要重建）

### 1.1 Schema（worker/src/schema.sql）

- **`items` 大一统**：所有源共用一张表。共通字段 `id / source_type / source_id / title / content / author / handle / created_at / metrics(JSON) / media(JSON) / scraped_at / extra(JSON) / lang / is_relevant / translated`
- **源特异字段进 `extra` JSON**：例如 GH 用 `daily_rank / readme_excerpt / readme_translated / contributors_inline / license_spdx / default_branch / r2_migrated_at` 等
- **时间序列指标分表**：`metrics_snapshots_<src>`（gh 已建）。每个源若需要追踪历史指标（star / view / listen 数等）就建一个，schema：`item_id / captured_at + source-specific 数值列`

### 1.2 Worker（worker/src/）

- `scheduled()` cron `*/5` 抢占轮转：`enrich → r2-migrate → translate → X scraper`，subrequest budget 50/invocation
- `/api/items` 通用，按 `source_type` 过滤，cursor 分页，sort=hot|time
- `/api/items/:id` drawer 详情（包含 metrics_history）
- `/r/<key>` R2 资源代理（GET / HEAD），`Cache-Control: public, max-age=31536000, immutable`
- `/api/track` 埋点（白名单见 `worker/src/track.ts`）

### 1.3 Pipeline 三步式（每个源沿用）

```
[Source]
  ↓ fetch (HTML / API / RSS / syndication)
  ↓ parse to canonical Item shape
  ↓ pre-filter（关键词 / 域名 / 类型粗筛）
  ↓ LLM judge（DeepSeek V4 Flash，AI 相关性 + category + 中文 summary）
  ↓ translate（非中文内容，DeepSeek）
  ↓ asset migrate to R2（如有 inline 图/视频/封面）
  ↓ INSERT items + metrics_snapshots_<src>
  ↓ push to D1
```

LLM client / DB client / 翻译 / R2 上传都已有 helper，复用即可。

### 1.4 Dashboard 复用

- **Feed.tsx**：通用列容器。PC 多列 + 移动单列（chip 切换）。**已经支持任意 source_type**，不用改。
- **TweetDrawer.tsx**：通用抽屉。已包含 swipe-to-close、双击回顶、动态 title、移动手势分区、scroll-trap 修复。**新源加 DrawerBody 即可，header 自动复用**
- **Lightbox.tsx**：图片浏览组件，新源直接复用
- **GithubDrawerBody.tsx**：参考实现 — markdown 渲染 + R2 资源 resolve + lightbox 集成
- **GithubCard.tsx**：参考实现 — feed 单条卡片
- **SourceIcon.tsx**：每个源加一个 SVG icon

### 1.5 移动端兼容性已踩过的坑（不要再撞）

- iOS Safari `touch-action: pan-x/pan-y` **不可靠**（WebKit 133112），用 JS imperative + `[data-no-page-scroll]` 兜底
- iOS WeChat WebView 的 fetch **抖动严重**：apiFetch 已加 5s AbortController × 3 attempts + 200/600ms backoff
- Tailwind v4 / Vite 8 默认目标 Chrome 111+，安卓 WeChat WebView (TBS) 通常 Chrome 86-90 —— **国内用户走 main 自定义域**（ai-feeds.com），preview *.pages.dev 在国内被卡，**只能 iOS 验收**
- README 图片包链接（`[![img](src)](url)`）渲染成 `<a><img/></a>`，img onClick 必须 `e.preventDefault()` 阻止 universal link 跳出
- IntersectionObserver 触发的 loadMore 失败要加 cooldown 阈值（已在 Feed.tsx 加，连续 3 次进 cooldown 显示重试）

### 1.6 Telemetry

新增 event 类型必须 **三处同步**，否则 worker 丢弃：

1. `dashboard/src/lib/telemetry/event-types.ts`（EVENTS 常量 + 类型 union）
2. `dashboard/src/lib/telemetry/types.ts`（EventTypeName union）
3. `worker/src/track.ts`（`EVENT_TYPE_WHITELIST` Set）

已有事件复用：`item_open_drawer / item_close_drawer / external_link_click / share_click / feed_load_error / api_error / image_load_error / item_impression`

## 2. 每个新源的决策矩阵（先填这张表再动手）

| 维度 | 问题 | 例：GH |
|------|------|--------|
| 数据来源 | API / HTML / RSS / 第三方？需要 cookie / token / IP？ | trending HTML + REST API |
| 拉取频率 | 多久跑一次？高峰段单独提频？ | 每天 1:00 / 13:00（CST） |
| Item 映射 | source_id / title / content / created_at / author 都来自哪？ | repo full_name / repo full_name / readme / first push? / owner |
| extra 字段 | 哪些源特异字段必存？ | readme / category / daily_rank / license / contributors |
| 指标 | 哪些值得追时间序列？ | total_stars / today_stars / forks / watchers / open_issues / open_prs |
| 预筛 | 怎么把 100 → 30 candidate 减小 LLM 成本？ | language / topics 关键词 |
| LLM judge | 「AI 相关」对该源怎么定义？输出哪些字段？ | is_ai + category + ai_summary |
| 翻译 | 中文源就跳过；其他要翻什么字段？ | readme excerpt + summary |
| 媒体资源 | 有 inline 图/视频/封面吗？是否迁 R2？ | readme 内 raw.githubusercontent.com 图迁 R2 |
| Card 布局 | feed 卡片横向布局？需要 hero image？metadata 用什么 icon？ | 见 `docs/plans/_mockups/2026-05-01-github-card-mockup.html` 的 B variant |
| Drawer 内容 | 抽屉里要展示什么？iframe / markdown / 自定义？ | repo header + summary + readme |
| 排序 | 默认热度 vs 时间？hot 算法？ | time desc + daily_rank asc |

## 3. 七个 Phase 详解

### Phase 0：设计 + Mockup（1 天）

1. 用 brainstorming skill 跟用户对齐决策矩阵
2. 写 `docs/plans/YYYY-MM-DD-<src>-source-design.md`，内容必含：
   - 数据源、抓取策略、停止条件
   - schema 增量（items.source_type 新值、是否新建 metrics 表、extra 字段表）
   - LLM prompt 设计（关键句直接抄进文档便于回看）
   - UI 决策（card / drawer / hero / icon / sort）
   - 与已有源的差异点
3. 生成 HTML mockup（PC + 移动两版，多 variant 让用户挑）放 `docs/plans/_mockups/`
4. 用户确认后再开 Phase 1。**不要跳过这一步**，越往后改越贵

### Phase 1：Schema（0.5 天）

```bash
# 1. 加新 SourceType
# 修：worker/src/schema.sql + dashboard/src/types.ts

# 2. 如需 metrics 表，加新建语句，并 D1 migrate
npx wrangler d1 execute xlist --remote --file=worker/src/schema.sql

# 3. 如有新 telemetry event，三处同步（见 §1.6）

# 4. App.tsx 把新源加进 SOURCE_COLUMNS + FILTER_CHIPS
```

### Phase 2：Scraper（2-5 天，源决定时长）

- 新建 `scrapers/<src>/`（或 worker-side TS，看抓取场景）
- 复用：LLM client、DB client、翻译 helper（已有，scrapers/_shared/ 或 worker/src/lib/）
- 分层验证：
  ```
  --dry-run → 看 candidate 列表
  --limit 5 → 跑 5 条端到端，看 DB 落盘是否对
  正常跑 → 看 N 条
  ```
- 不要从一开始就追求大批量。**先把单条 happy path 跑通**

### Phase 3：Worker 接入（1-2 天）

- 决定是 worker scheduled() 内跑还是 worker 外推（看 subrequest 预算）
- 如在 worker 内：加进 `scheduled()` 抢占轮转，注意 50/invocation 上限
- 如 worker 外：本机 launchd / GH actions cron，scrape 完 push to D1 via `/api/ingest`（如尚未有就新建）
- 部署后 `wrangler tail` 观察 cron 日志，确认有跑、有写入

### Phase 4：Dashboard UI（2-3 天）

```
src/components/
  <Src>Card.tsx       ← 抄 GithubCard.tsx 改字段
  <Src>DrawerBody.tsx ← 抄 GithubDrawerBody.tsx 改渲染
src/components/icons.tsx
  IconSrc             ← SVG，加进 SourceIcon 的 switch
src/components/Feed.tsx
  渲染条件             ← `row.item.source_type === "<src>"` 路由到 <Src>Card
src/components/TweetDrawer.tsx
  渲染条件             ← `isSrc` 路由到 <Src>DrawerBody
```

UI 验收用 mockup 做对照，PC + 移动都要测。

### Phase 5：R2 资源迁移（如有，1 天）

- 复用 worker `runR2Migrate` 模式：
  - 解析 item 内 inline media URL（白名单 mime + 5MB cap + 20 资产/item）
  - 算 SHA-256 key，PUT 到 R2 bucket
  - 更新 item 的 readme_excerpt / extra 里把原 URL 替换成 `/r/<key>`
  - 标记 `r2_migrated_at`
- 一定 **跳过 `/r/` 已迁路径**（避免 self-corrupting re-migrate，已踩过）
- 加进 cron 抢占轮转

### Phase 6：真机验收（1 天）

- iOS 真机（preview URL OK）
- 安卓 **必须走 main 自定义域**（preview pages.dev 国内不通）
- mobile golden path：
  - 首屏加载 < 2s
  - chip 切换源
  - 卡片点开 drawer
  - drawer 内 swipe back 关
  - drawer 内长内容滚动 + 双击回顶
  - 顶 bar 横划只滚 chips 不滚 feed
- telemetry 检查：`feed_load_error` / `api_error` / `item_open_drawer` 都有写入

### Phase 7：operations.md（0.5 天）

强制项（漏掉跨 session 维护就断档）：
- 新增 cron / endpoint / 跑频率写进运维表
- 新增 D1 表 + 字段
- 新增 R2 bucket / KV namespace（如有）
- 新增 secrets

## 4. 各源建议优先级 + 估时

| 顺序 | 源 | 预估工时 | 主要难点 | 是否需 R2 |
|------|----|---------|---------|----------|
| 1 | YouTube | 4-6 天 | 转录字幕 + LLM 摘要 + 防爬 | 否（YouTube 嵌入即可） |
| 2 | Product Hunt | 3-4 天 | API key 申请，sort 算法 | 是（产品图） |
| 3 | arXiv | 3-5 天 | PDF parse / abstract 抓 + 中译 | 否 |
| 4 | Podcast | 5-7 天 | 转录最贵，可选 Snipd 集成 | 否（音频用原始链接） |

YouTube 优先因为最高频内容、用户场景刚需。

## 5. 反模式（不要做的事）

- ❌ 直接把 source-specific 字段塞 items 顶层列（应进 extra JSON）
- ❌ 每个源独立的 schema 表（重复 80% 字段，难做 cross-source feed）
- ❌ 跳过 mockup 直接写组件（最贵的返工是确定 layout）
- ❌ scraper 一上来就 worker 内跑（subrequest 预算很紧，先 worker 外验通再迁）
- ❌ 用浏览器 Chrome devtools 模拟 iOS 测移动端（很多手势 / WebKit 行为模拟器没有）
- ❌ 让用户验收 preview 不告诉他「安卓走 main」
- ❌ 增加新 telemetry event 只改 dashboard 不改 worker 白名单
