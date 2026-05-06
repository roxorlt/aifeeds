# 信息源接入 SOP

> 验证于 X List + GitHub + Product Hunt + ClawHub 四个源接入。接下来 YouTube / Podcast / arXiv 走这套路径，目标 80% 复用 + 20% 源特异性。

## 0. TL;DR Checklist（每个新源照做）

```
□ Phase 0  设计文档 + HTML mockup：feed 卡片 + drawer + 分享海报三件套（用户确认后再写代码）
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
   - UI 决策：**feed 卡片 + drawer 详情 + 分享海报**（三件套都要画，缺一不可）
   - 与已有源的差异点
3. 生成 HTML mockup（PC + 移动两版，多 variant 让用户挑）放 `docs/plans/_mockups/`，**必须包含**：
   - feed 卡片样式
   - drawer 详情区段
   - **分享海报（1080×1350）排版**（哪些字段进海报、视觉重心、是否带媒体图、CTA 块、品牌区）
4. 用户确认后再开 Phase 1。**不要跳过这一步**，越往后改越贵

> **为什么分享海报要进 Phase 0**：PR5 之后每个新源都得加 SVG 模板变体到 `worker/src/share/svg-template.ts`，海报跟 feed/drawer 的字段要预先对齐（比如 GH 的 commit 数 / PH 的票数 / Skill marketplace 的 install 命令），不然 Phase 4/5 才发现海报缺字段就要倒回去改 schema + scraper。
> 沿用约束：1080×1350 PNG · resvg-wasm 渲染 · Noto Sans SC 字体子集 · R2 缓存 · navigator.share 直存相册（移动）/ a[download]（PC）。

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

## 4.5 接入新源前后的横向规则（2026-05-06 加，从 ClawHub 接入抽象）

> 这一节是**通用规则**，不放具体源的字段映射。具体源的细节进各自的设计文档。

### A. Reconnaissance 阶段（动手做 mockup 之前必跑）

1. **检查页面是不是 SPA**：curl 拿首页 HTML，grep `__NEXT_DATA__ / __NUXT__ / self.__next_f / $tsr / window.__INITIAL_STATE__` 等水印识别框架。SPA 直接 curl 拿不到数据，但 80% 情况能从 JS bundle 抠到后端 endpoint。
2. **从 footer / `runtimeEnv` chunk 找 backend**：现代 SPA 一般会暴露 `VITE_*_URL`、`NEXT_PUBLIC_*_API` 这种常量。Convex / Supabase / Pocketbase 类后端常见且**默认对外开放只读 API，无鉴权**。
3. **优先尝试官方 REST V1**（如有），其次直接打后端 query 接口（Convex `/api/query`），最后才考虑 HTML 解析。能拿 JSON 不抓 HTML。
4. **审计源站 UI 元素清单**：fetch 一个 detail 页 HTML + 一张 listing 页 HTML，把 sidebar / sort options / category filter / KPI 字段都列全。新源 mockup **必须复刻源站自己强调的字段**，少一个 user 都会指出来。
5. **抓源站实际 icon 库**（grep `lucide-[a-z-]+` / `heroicons-[a-z-]+` / `phosphor-[a-z-]+`），用同款 SVG。**严禁用 emoji 替代真实 icon**（详见 § F）。

### B. Schema 设计

1. **`items` 表共通字段不再加列**：每个新源的特有字段全进 `extra` JSON。schema 不应该出现 `<src>_<field>_count` 这种列。
2. **`metrics_snapshots_<src>` 表只放真正需要追时间序列的指标**，单值类 meta（license / version 文本 / comments 计数）放 `items.metrics` 或 `extra` 顶层。30 天 retention 默认。
3. **新源接入第一周不强求 trends 模块**：给 dashboard drawer 留 "30 天趋势" 折叠区段，但 v1 默认隐藏 — **数据点 ≥ 7 + variance > 5%** 才出。冷启动期空线条比没有更差。

### C. LLM judge / 翻译策略分类（按源决定）

| 源类型 | LLM relevance judge | summary 翻译时机 | 主体内容翻译 |
|--------|---------------------|----------------|------------|
| 流式新闻（X / 微博 / Twitter）| ★ 必做（噪音多） | eager（cron 时） | eager |
| 优选 marketplace（PH / Skill marketplace 等）| ☆ 跳过（默认 is_relevant=1） | eager | eager（区分代码块）|
| 长尾发现（GH trending / arXiv）| ★ 必做（trending 含杂）| eager | excerpt eager + 全文 lazy |
| 视频 / 播客 | ★ 必做（转录贵）| eager | excerpt eager + 时间戳 lazy |

**翻译规则统一**：
- 代码块原文不译（fenced ``` / inline `code`）
- 翻译 prompt 显式 "preserve all fenced code blocks verbatim, including bash / yaml / json"
- 非用户面向的"指令文档"（如给 LLM 读的 SKILL.md / system prompt）**不翻**，只展示原文
- terminologies 翻译要专业：用对应领域的标准译法，避免直译

### D. UI / Mockup 阶段的横向规则

1. **不要发明 hero image 槽位**：除非源站本身把 hero image 当主体（PH 的 product gallery 是；GH / X / Skill marketplace 类都不是）。文字密集的内容直接 text + avatar。
2. **server-side risk tags vs client-side category filter 不要混**：很多 marketplace 同时有「安全风险标签」（server 算）和「内容分类」（前端关键词匹配）。前者放 drawer Safety section，后者放 feed 顶部下拉。
3. **stat label 必须中文化**：drawer 里 "stars / downloads / installs" 改 "星标数 / 下载量 / 安装量"。保留英文标签等于偷懒。
4. **顶部筛选默认 dropdown 优于 chip 排**：分类 ≥ 5 项时 chip 行会折断 / 横滚。两个 native select 是 baseline。空间紧时压缩到 title 同行右侧。
5. **稀有但严重的安全告警才上颜色**：默认安全标签用纯文字行 + amber 文字色；只有高 severity finding 才上 rose ring。**整块 amber 背景是设计 antipattern**。
6. **Files manifest 用代码块的目录树渲染**：等宽字体 + ASCII 树字符（├─ └─ │）。比表格紧凑、扫读快、避免移动端横滚。
7. **drawer 区段顺序按"用户决策"路径而非按 schema 顺序**：先看是什么（README / 正文）→ 安不安全（Safety）→ 怎么装/用（Install / Action）→ 走势如何（Trends）→ 还有啥（Files / 原文）→ 走出去（Footer）。

### E. CF Workers Paid 后的算账模板

参见 `operations.md` § CF 计划与配额。新源接入算账时按 1000 subreq/invocation 心智，不再为"省 subreq"做拆 cron 槽优化。

### F. ⚠️ 强制规则：mockup + 真实代码都不准用 emoji 做 icon

**错的写法**：

```html
<span>★ 3,479</span>          <!-- 用 emoji ★ 当星标 icon -->
<span>↓ 422k</span>            <!-- 用 ↓ 当下载 icon -->
<span>📦 active</span>         <!-- 用 📦 当 install icon -->
<option>★ 星标</option>        <!-- dropdown option 前缀 emoji -->
<span>⚠️ 风险</span>           <!-- ⚠️ 当 warning icon -->
```

**对的写法**：

```html
<span><svg><use href="#ico-star"/></svg> 3,479</span>
<span><svg><use href="#ico-download"/></svg> 422k</span>
<option>星标</option>
```

**理由**：
- emoji 跨平台 / 跨字体渲染差异极大（macOS / Windows / 安卓 / iOS / 微信 webview / 不同 system font 下 emoji 字形不一样）
- 中文系统下部分 emoji 走 fallback 字体，跟 UI 主字体大小、对齐错位
- 信息可访问性差（screen reader 念出 emoji 名字 vs SVG 用 aria-label 可控）
- design token 不可控（emoji 颜色 / 大小 / 描边粗细全由 OS 决定）

**例外白名单**（emoji 唯一可用的场景）：
- skill 自身 frontmatter 的 emoji 字段（如 ClawHub `clawdis.emoji: "🎮"`），按数据原样渲染不动
- 用户输入内容（推文 / 评论 / README 正文里的 emoji），按原文渲染
- **任何 UI chrome（导航 / 按钮 / 标签 / 状态指示）必须 SVG，没有 emoji**

**实操**：
- 项目里的 SVG icon 集统一在 `dashboard/src/components/icons.tsx`（lucide-react 同款）
- mockup 写 `<svg><symbol id="ico-xxx">` 全文件 reuse；不写 `★ ↓ ↑ 📦 ⚠️ 🆕 🕐 ✨` 之类
- code review 见到 emoji 当 icon 用直接打回

### G. 分享海报结构（PR5 之后每个新源都要加变体的固化骨架）

**实现位置**：`worker/src/share/svg-template.ts`（共享）+ 每个源新写一个 `renderXxxContent` 函数

**真实海报由顶层 `renderShareSvg` 拼出 3 个区域**（不是 1 个大白卡）：

```
┌─────────────────────────────────────┐
│ Hero 区（0..360 高，全宽 1080）     │
│  · 深色径向渐变 #050505 → #0c0c10   │
│  · 右上紫色 glow rgba(111,99,255,.34)│
│  · 底部贝塞尔弧线（resvg 不支持      │
│     clipPath 时直接画 path 闭合）    │
│  ┌────────┐                ┌──────┐ │
│  │ logo + │                │ 来源 │ │
│  │ 名称 + │                │ chip │ │
│  │ slogan │                │ pill │ │
│  └────────┘                └──────┘ │
│                                      │
│        （hero 弧线在这附近凹下去）   │
├─────────────────────────────────────┤  ← cardY = 360 - cardOverlap(130) = 230
│ ┌─────────────────────────────────┐ │
│ │ Content 卡（独立 rounded rect）   │ │
│ │   inset 56px / cardW = 968       │ │
│ │   rx = 48, 白底, soft shadow      │ │
│ │   高度 = contentH（按内容变）     │ │
│ │  ┌──────┐ Title 大字 + tag pill   │ │
│ │  │avatar│                         │ │
│ │  │ 128  │ ────────────────────    │ │
│ │  └──────┘ Metrics 3 列            │ │
│ │  ────────────────────             │ │
│ │  Meta 行（左 / 右）               │ │
│ │  Body（5 行 × 36px wrap 24 字）    │ │
│ │  [可选媒体图]                      │ │
│ └─────────────────────────────────┘ │
│                                      │
│        ↑ footerMargin = 48           │
│ ┌─────────────────────────────────┐ │
│ │ Footer 卡（独立 rounded rect）    │ │
│ │   inset 56px / 同 cardW          │ │
│ │   rx = 48, 白底, soft shadow      │ │
│ │   固定高 264                     │ │
│ │ ┌──┐ 分享自        ┌─────┐ QR    │ │
│ │ │ 头│ <nickname>    │ QR  │       │ │
│ │ │像│                │ 168 │ 微信  │ │
│ │ │120│               └─────┘ 扫码  │ │
│ │ └──┘                              │ │
│ └─────────────────────────────────┘ │
│                                      │
│        ↑ totalH = footerY + 264 + 96 │
└─────────────────────────────────────┘
        全图底色 #f6f7fa（浅灰）
```

**新源加变体的硬性规则**：

1. **永远只写 content 区**（即新增 `renderXxxContent` 函数 + `pickSourceMeta` 加分支），hero / footer 不动
2. content 函数签名抄 `renderGithubContent` 或 `renderPhContent`（取决于源更像哪个），改字段不改结构
3. 必须给该源选一个**chipColor**（hero 右上角"来源 xxx"的强调色），跟现有变体不撞色：
   - X = `#ffffff` (白)
   - GitHub = `#c1f0d8` (mint)
   - Product Hunt = `#ffd1c1` (peach)
   - ClawHub = `#d8c8f5` (lavender)
   - 新源建议从 cyan / yellow / rose 等冷暖系剩余色挑，登记到 `pickSourceMeta`
4. content 区 Body 必须从该源的"primary text"摘段：tweet 全文 / README 首段 / summary / 摘要描述等。**不要拼太多字段进 body** — 那是 drawer 的活，海报只要一段
5. content 区是否带媒体图（renderMediaBlock）由源决定。文字密集型（X/GH/skill marketplace）默认无；视觉密集型（PH product / arXiv 论文图）建议有
6. **mockup 必须画三件套**（hero + content + footer）等比缩放预览，不要只画 content。1:2.5 缩放是 baseline（432 宽预览对应 1080 实际）

**复用清单**（不要重写）：
- `renderHero(sourceLabel, sourceChipColor)` — 整个 hero 区
- `renderFooter(ctx, x, y, w, h)` — 整个 footer 区
- `renderCardBg(x, y, w, h, rx)` — 卡片底（白底 + shadow filter）
- `renderMediaBlock(...)` — 媒体图块（含 video play overlay）
- `wrapText(text, maxCharsPerLine, maxLines)` — body 文字 wrap
- `formatStat(n)` — 数字千分位 / k/m/b 后缀
- `estimateTextWidth(text, size, weight)` — 自适应字号宽度估算

**字段映射小抄**（不同源 content 区字段对照）：

| 区段 | X | GitHub | Product Hunt | ClawHub |
|------|---|--------|--------------|---------|
| 头像 | 圆 112 | owner 圆 128 | 圆角方 128 | owner 圆 128 |
| 主标题 | display_name (52px) | owner/repo (54-70px 自适应) | product (92px) | displayName (54-70px 自适应) |
| tag pill | — | language (purpleSoft) | category (orangeSoft) | category (按 8 类色) |
| metrics 列 | 4 | 3 | 3 | 3 |
| meta 行 | — | trophy + rank + contribs | — | version+license / N versions · 更新 |
| body | tweet 全文（8 行）| readme excerpt (5 行) | summary (5 行) | README 前 N 行去 frontmatter+H1 |
| 媒体 | tweet 配图 | readme 第一张非 SVG | gallery 第一张 | 通常无 |

## 5. 反模式（不要做的事）

- ❌ 直接把 source-specific 字段塞 items 顶层列（应进 extra JSON）
- ❌ 每个源独立的 schema 表（重复 80% 字段，难做 cross-source feed）
- ❌ 跳过 mockup 直接写组件（最贵的返工是确定 layout）
- ❌ scraper 一上来就 worker 内跑（subrequest 预算很紧，先 worker 外验通再迁）
- ❌ 用浏览器 Chrome devtools 模拟 iOS 测移动端（很多手势 / WebKit 行为模拟器没有）
- ❌ 让用户验收 preview 不告诉他「安卓走 main」
- ❌ 增加新 telemetry event 只改 dashboard 不改 worker 白名单
