# ClawHub 数据源接入设计文档

> 状态：Phase 0 设计完成（brainstorm 已对齐），待开 feature branch 进 Phase 1
> 日期：2026-05-06
> Mockup：[`_mockups/2026-05-06-clawhub-mockup.html`](_mockups/2026-05-06-clawhub-mockup.html)
> SOP：[`docs/source-integration-sop.md`](../source-integration-sop.md)

---

## 1. TL;DR

第 4 个数据源接入。ClawHub 是 Claude Code skills marketplace（https://clawhub.ai/skills），共 64,224 个 skill。

**最大特点**：跟 X / PH 不同，ClawHub 有**完全公开的 Convex API**，无鉴权 / 无 turnstile / 无 cookie 依赖。这是项目第一个**纯 worker-only**接入（无本地 launchd / 无 browser-use），跨设备 / 重装机零迁移成本。

**估时**：7-8 天（schema 0.5d + scraper 2d + worker 1d + dashboard 2d + R2 0.5d + 验收 1d + ops 0.5d）

---

## 2. 数据源 + 抓取策略

### 2.1 API endpoint

| 端点 | 用途 | 关键参数 |
|------|------|---------|
| `GET https://wry-manatee-359.convex.site/api/v1/skills` | 列表分页 | `sort` (newest/updated/downloads/installs/stars/name) · `dir` (asc/desc) · `nonSuspiciousOnly` (bool) · `numItems` (max 200) · `cursor` |
| `GET https://wry-manatee-359.convex.site/api/v1/skills/:slug` | 单 skill 元数据 | — |
| `GET https://wry-manatee-359.convex.site/api/v1/download?slug=:slug` | 全量 ZIP 包 | — |
| `POST https://wry-manatee-359.convex.cloud/api/query` (path: `skills:listPublicPageV4` / `skills:getBySlug`) | Convex 直接查询（更丰富，含 install 命令）| 同 V1 |

ZIP 包 ~25KB / skill，包含 `SKILL.md` (~20KB)、`README.md` (~0.4KB)、`scripts/`、`assets/`、`_meta.json` 等。

### 2.2 抓取策略

**纯云端**（worker 内跑），不需要本地 launchd / Python scraper。

**两阶段 cron**（参考 GH 的 phase 1/2 抢占模式）：

```
Phase 1（cron BJT 04:00 + 16:00 / UTC 20:00 + 08:00）
  ├→ 8 list calls：top 1000 by stars + top 500 by updated（dedup ~1200）
  └→ upsert items shells（is_relevant=1 + extra.ch_pending=true）
     + append 一行 metrics_snapshots_clawhub

Phase 2（每 */5 min cron tick 抢占式，仅在没 ch_pending 时让位给 X）
  └→ 取 1-2 条 ch_pending：
     1. fetch detail metadata（含 capabilityTags + llmAnalysis + install）
     2. fetch /api/v1/download?slug=... ZIP
     3. unzip + 抠 SKILL.md + README.md + 媒体图
     4. 翻译 summary + changelog + README.md（保留代码块原文）
     5. 媒体迁 R2（README inline 图 + owner avatar）
     6. UPDATE items + 清 ch_pending
```

**单次 phase 2 invocation 预算**：~5-10 subreq（1 detail + 1 zip + 2-3 DeepSeek + 1-3 R2 PUT + 1 batch UPDATE），远低于 Workers Paid 1000 上限。

**吞吐**：12 ticks/hr × 24 = 288 ticks/day × 1-2 items = 280-560 item/day enrich，足够消化 daily 1200 增量（实际多数是已有 skill，只触发 metrics refresh，不需要 phase 2）。

### 2.3 Lazy refresh on drawer open

复用 PR6.6 lazy-enrich-on-drawer 路径：drawer 打开 → dashboard 调 `POST /api/items/:id/refresh` → worker：

- **必刷**：metrics（stars/downloads/installsCurrent/installsAllTime/comments）→ 走 `GET /api/v1/skills/:slug`
- **条件刷**：如果 `latestVersionId` 变了 → 重抓 ZIP + 重译 README + 替换 SKILL.md
- **KV throttle**：`item-refresh-throttle:<id>` 60s

返回 `{refreshed, source_type, reason, metrics?}`，dashboard 拿到 `refreshed:true` 后通过 `itemUpdateBus` 同步 feed 卡片。

### 2.4 不需要"停止条件"

ClawHub 不是流式来源，是 marketplace 周期性同步 top N。不存在"翻到旧内容停止"的场景。

---

## 3. Schema 增量

### 3.1 `items` 表新 source_type 值

加 `'clawhub'` 到 `items.source_type` 枚举。配套 dashboard `src/types.ts` 已预订（占位 commit `3200a26`）。

### 3.2 字段映射

| `items` 列 | 来自 ClawHub | 备注 |
|-----------|-------------|------|
| `id` | `clawhub:<slug>` | composite |
| `source_type` | `'clawhub'` | |
| `source_id` | `<slug>` | 唯一稳定，不带 version |
| `title` | `displayName` | |
| `content` | README.md 原文 | 抠 ZIP 后落库；用于搜索 |
| `content_translated` | README.md 中文译文（保留代码块）| eager 翻译 |
| `author` | `owner.displayName` | |
| `handle` | `owner.handle` | GitHub handle |
| `created_at` | `skill.createdAt`（ms）| |
| `metrics` JSON | `{stars, downloads, installsCurrent, installsAllTime, comments, versions}` | |
| `media` JSON | README inline 图（迁 R2 后的 `/r/<key>` 列表）+ owner avatar | |
| `extra` JSON | 见 §3.3 | |
| `lang` | 自动检测（CJK 字符占比）| 从 summary 检测 |
| `is_relevant` | `1`（恒定）| **跳过 LLM judge**，所有 ClawHub skill 默认 AI 相关 |
| `translated` | `1`（enrich 完成后） | |

### 3.3 `extra` JSON 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `slug` | string | 拼前端 detail 链接 `https://clawhub.ai/skills/<slug>` |
| `latest_version` | string | "3.0.21" |
| `latest_version_id` | string | Convex 内部 id |
| `license` | string | "MIT-0" |
| `versions_count` | number | 31（drawer Stats 2×3 + 海报 meta 行用）|
| `updated_at` | number | ms timestamp（Stats + 海报 meta 行用）|
| `install` | array | `[{id:'brew', kind:'brew', formula:'pskoett/tap/...', label:'Install ... (brew)', bins:['gog']}]` |
| `capability_tags` | string[] | server-derived 风险标签（见下表）|
| `llm_analysis` | object | ClawHub 自带的 LLM 风险分析（drawer Safety section 用）|
| `owner_avatar_r2_key` | string | R2 SHA-256 key |
| `owner_github_url` | string | `https://github.com/<handle>` |
| `category` | string | **dashboard 端**关键词匹配算出（见 §5.3），8 类 |
| `is_highlighted` | bool | ClawHub featured |
| `is_suspicious` | bool | moderationFlags 含 flagged.suspicious（默认隐藏）|
| `fork_of` | object\|null | 如果是 fork，落上游引用 |
| `canonical_skill` | object\|null | dedupe 目标（如 ClawHub 标记重复）|
| `skill_md` | string | SKILL.md 原文（drawer collapsible 展示，**永不翻译**）|
| `readme_first_paragraph` | string | 缓存的 README 前段（去 frontmatter + H1，海报 body 用）|
| `summary_translated` | string | summary 中文译文（卡片显示用，cron 时翻好）|
| `changelog_translated` | string | changelog 中文译文 |
| `ch_pending` | bool | phase 1 设 true，phase 2 enrich 完后删除 |
| `r2_migrated_at` | number | R2 迁移完成时间戳（防重复迁移）|

### 3.4 capability_tags 中文翻译表（drawer Safety 用，dashboard 端做映射）

| English | 中文 |
|---------|------|
| `crypto` | 涉及加密资产 |
| `requires-wallet` | 需要加密钱包 |
| `can-make-purchases` | 可发起付款 |
| `can-sign-transactions` | 可签署链上交易 |
| `requires-oauth-token` | 需要 OAuth 令牌 |
| `requires-sensitive-credentials` | 需要敏感凭证 |
| `posts-externally` | 可对外发布 |

### 3.5 新建 metrics 表 `metrics_snapshots_clawhub`

```sql
CREATE TABLE IF NOT EXISTS metrics_snapshots_clawhub (
  item_id           TEXT NOT NULL,
  captured_at       INTEGER NOT NULL,
  stars             INTEGER,
  downloads         INTEGER,
  installs_current  INTEGER,
  installs_all_time INTEGER,
  PRIMARY KEY (item_id, captured_at)
);
CREATE INDEX IF NOT EXISTS idx_ms_ch_item_time ON metrics_snapshots_clawhub(item_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_ms_ch_captured  ON metrics_snapshots_clawhub(captured_at);
```

每次 phase 1 cron 跑完 append 一行（每 skill 每天最多 2 行）。30 天 retention，沿用现有 `runCleanup` cron 模式（每天 03:35 UTC 跑）。

migration 文件：`worker/migrations/0NN-clawhub.sql`

### 3.6 Telemetry events 复用

不新增 event 类型。复用：`item_open_drawer / item_close_drawer / external_link_click / share_click / image_load_error / item_impression`。

---

## 4. LLM Prompt 设计

### 4.1 Translation prompt — short text（summary / changelog）

```
You are translating product copy for a Chinese AI feed product. Translate the input English text to Chinese (zh-CN).

Rules:
- Keep technical terms in English where they are stable industry terms: OAuth, API, MCP, skill, plugin, agent, hook, prompt, workflow, LLM, RAG, etc.
- Preserve product/code names verbatim (e.g., "ClawHub", "Self-Improving Agent", "Claude").
- Output Chinese only, no preamble.

Input:
<text>

Output:
```

### 4.2 Translation prompt — long markdown（README.md）

```
You are translating Markdown documentation for a Chinese AI feed product. Translate the input Markdown to Chinese (zh-CN).

CRITICAL RULES — DO NOT BREAK:
1. PRESERVE all fenced code blocks (```lang ... ```) verbatim. Do not translate code, comments inside code, or shell commands.
2. PRESERVE all inline code (`...`) verbatim.
3. PRESERVE YAML frontmatter (between leading "---" lines) verbatim.
4. PRESERVE all Markdown structure: headings (#, ##, ...), lists (-, *, 1.), tables (| ... |), links ([](url)), images (![](url)), bold (**), italic (*).
5. Inside table cells: translate text, preserve code/links/structure.
6. KEEP these technical terms in English: OAuth, API, MCP, skill, plugin, agent, hook, prompt, workflow, LLM, RAG, claw, npm, brew, bash, yaml, json.
7. Preserve all proper nouns (product/library names, GitHub handles, file paths) verbatim.

Output Chinese Markdown only, no preamble.

Input:
<README.md content>

Output:
```

**Sanity check**：跟现有 fill-translations cron 同款 — `length_ratio < 0.15 or > 2.0` || `CJK_ratio < 20% or >= 99.9%` → 重试 1 次，仍 suspect 则保留译文 + 标 `translation_quality='suspect'`。

### 4.3 模型选型（沿用 CLAUDE.md § DeepSeek 模型选型）

- summary / changelog 翻译 → `deepseek-v4-flash`
- README.md 翻译 → `deepseek-v4-flash`（长文档但任务简单，不需要 pro）
- LLM judge → 跳过（不需要）

---

## 5. UI 决策（feed 卡片 + drawer + 分享海报）

详细视觉见 [`_mockups/2026-05-06-clawhub-mockup.html`](_mockups/2026-05-06-clawhub-mockup.html)。

### 5.1 Feed 卡片（`ClawhubCard.tsx`）

抄 `GithubCard.tsx`，text + avatar 风格，无 hero image。

- 头像 40px 圆形（owner GitHub avatar，已迁 R2）
- 第一行：title 15px bold
- 第二行（12px 灰）：`@handle · v 版本 · category chip`
- Body：summary 中文译文，**`line-clamp-4`**（最多 4 行）
- Metrics 一行：`<Star /> stars` · `<Download /> downloads` · `<Package /> active installs`
- 不展示 comments
- 不展示安全告警微标（drawer 才显示）

### 5.2 顶部筛选

- title "ClawHub" + 3 个紧凑控件同行右侧
- 排序 select：星标数 / 下载量 / 安装量 / 最新发布 / 最近更新 / 名称 A-Z
- 分类 select：全部 / MCP 工具 / Prompts / Workflows / Dev 工具 / 数据 & API / 安全 / 自动化 / 其他
- 隐藏可疑 toggle：默认 ✓ + 可见文字 label「隐藏可疑」（不只是盾牌 icon）

### 5.3 客户端 category 关键词映射

ClawHub server 没有"内容分类"字段（只有 risk capability tags），UI 上的 8 类是源站客户端关键词匹配。我们沿用同款逻辑：

```ts
const CH_CATEGORY_KEYWORDS = {
  'mcp-tools':  ['mcp', 'tool', 'server'],
  'prompts':    ['prompt', 'template', 'system'],
  'workflows':  ['workflow', 'pipeline', 'chain'],
  'dev-tools':  ['dev', 'debug', 'lint', 'test', 'build'],
  'data':       ['data', 'api', 'database', 'sql'],
  'security':   ['security', 'audit', 'vet', 'safety'],
  'automation': ['automate', 'cron', 'schedule', 'trigger'],
  'other':      [],
};

function deriveCategory(displayName: string, summary: string): string {
  const text = (displayName + ' ' + summary).toLowerCase();
  for (const [cat, kw] of Object.entries(CH_CATEGORY_KEYWORDS)) {
    if (kw.some(k => text.includes(k))) return cat;
  }
  return 'other';
}
```

phase 2 enrich 时算一次落到 `extra.category`，dashboard 直接读，不再客户端算。

### 5.4 Drawer（`ClawhubDrawerBody.tsx`）

抄 `GithubDrawerBody.tsx`，9 个区段：

| # | 区段 | 必要性 | 备注 |
|---|------|-------|------|
| ① | Header | 必须 | avatar 56 + title + by @handle · v · license / category chip 跟 title 左对齐 |
| ② | Stats 2×3 | 必须 | 星标数 / 下载量 / 版本数 / 当前安装 / 累计安装 / 最近更新 |
| ③ | README | 必须 | 中文译文 + 代码块原文，markdown 渲染（复用 GH 同款） |
| ④ | Safety | 条件 | 有 capability_tags 或 llm_analysis 才显示。视觉降噪：capability tag 用纯文字行 + amber 文字色（不是 chip 染色块）；severity 用 低度（灰）/ 中度（黄）/ 高度（rose ring）颜色编码 |
| ⑤ | Install | 必须 | 多个安装方式 code block，每个带「复制」按钮。`claw install ...` 排第一 |
| ⑥ | Trends 30d | v2 | 默认折叠；snapshots ≥ 7 + variance > 5% 才出 |
| ⑦ | Files | 默认折叠 | 等宽字体 + ASCII 树字符（├─ └─ │）渲染目录树代码块，完整列出全部文件 |
| ⑧ | SKILL.md 原文 | 默认折叠 | 永不翻译，给 power user 看 Claude 指令文档 |
| ⑨ | Footer | 必须 | 在 ClawHub 打开 / 查看作者 GitHub |

### 5.5 分享海报（B 风格，对齐 GH 真实代码）

加第 4 个变体到 `worker/src/share/svg-template.ts`：

```
[Hero 0-360, renderHero 共享]
  └ left: AI-Feeds logo + "AI-Feeds" 62px + "专注 AI 领域资讯聚合" 28px
  └ right: 来源 ClawHub chip pill（chipColor: #d8c8f5 lavender，跟 GitHub mint / PH peach 区分）

[Content card, cardX=56 cardY=230 cardW=968 / 独立 rounded rect / 白底 / 软阴影 / overlap -130 进 hero]
  ├ Header: avatar 128 圆形（owner GitHub）+ displayName 大字 + tag pill（按 8 category 上色）
  ├ Metrics row 3 cols：星标数 / 下载量 / 当前安装（含上下分隔线 + 列分隔线）
  ├ Meta row：v 版本 + license（左）/ N versions + 更新于 X 天前（右）+ 下分隔线
  └ Body：README 前 N 行（去 frontmatter + H1，5 行 wrap，36px）

[Footer card 264h, footerX=56 footerW=968 / 独立 rounded rect / 白底 / 软阴影 / 跟 content 同款 inset]
  └ renderFooter 共享：avatar 120 + 分享自 + nickname（左）/ QR 168 + 微信扫码查看（右）
```

**实施步骤**：

1. `pickSourceMeta()` 加 `'clawhub'` 分支：`{ kind:'clawhub', label:'ClawHub', chipColor:'#d8c8f5' }`
2. 新增 `renderClawhubContent()` 函数（抄 `renderGithubContent`，差异点见上）
3. 顶部 dispatch 加 `sourceMeta.kind === 'clawhub'` 分支
4. `poster.ts` / `handlers.ts` 注入字段：`extra.license / latest_version / versions_count / updated_at / readme_first_paragraph / category`
5. README 前 N 行抽取（worker 端 helper）：`stripFrontmatter()` 去 `^---\n...\n---` → `stripH1()` 去 `^# .+` → 取首段非空 prose
6. category chip 颜色按 8 类映射：workflow=violet · mcp=blue · prompts=violet · dev=neutral · data=teal · security=rose · automation=emerald · other=neutral
7. Avatar fallback：无 GitHub 头像时圆形 + skill 名首字母（参考 GH dot grid fallback 模式，用首字母代替 dots）
8. Hero + Footer 完全复用现有 `renderHero` + `renderFooter`，不需要改动

---

## 6. 与已有源差异点

| 维度 | X | GitHub | Product Hunt | **ClawHub** |
|------|---|--------|--------------|------------|
| 数据源 | List page (browser-use) | Trending HTML + REST | Leaderboard (browser-use) | **Convex 公开 API** |
| 跑哪 | 本地 launchd `.cron` | Worker phase 1+2 | 本地 launchd `.ph` | **Worker phase 1+2（全云端，无本地依赖）** |
| 鉴权 | x.com cookie | None | None | **None** |
| 反爬 | Cookie + fingerprint | None | Turnstile（browser binding 过不去）| **None** |
| 频率 | C2 hybrid 10-60 min | 2x/day（BJT 01:00 + 13:00）| 1x/day（BJT 16:30）| **2x/day（BJT 04:00 + 16:00）** |
| LLM judge | ★ 必做 | ★ 必做（trending 含杂）| ★ 必做 | **☆ 跳过（默认 is_relevant=1）** |
| 翻译范围 | tweet 全文 | README excerpt + summary | summary + maker post + comments | summary + changelog + **README.md（保留代码块）** |
| 主要 metric | likes/RT/replies/views | stars/forks/watchers | votes/reviews/followers | **stars/downloads/installs(current)** |
| 时序 metrics | metrics_snapshots | metrics_snapshots_gh | （无）| **metrics_snapshots_clawhub** |
| 媒体 R2 | tweet 图 | README inline 图 | logo/screenshot/video/avatar | **README inline 图 + owner avatar** |
| 卡片差异 | quote/card 嵌套 | language ball + ai_summary | hero gallery + 排名 | **category chip + 3 metrics（无 hero）** |
| 海报变体 | X | GitHub | Product Hunt | **ClawHub（GH 同款骨架，install 不入海报，README 前 N 行做 body）** |

---

## 7. Phase 1-7 实施计划

| Phase | 工作 | 工时 | 关键产出 |
|-------|------|------|---------|
| 1 | Schema | 0.5d | `worker/migrations/0NN-clawhub.sql` + `dashboard/src/types.ts` source_type 加 'clawhub' + `pickSourceMeta` 加 kind |
| 2 | Worker scraper（无本地 Python！）| 2d | `worker/src/clawhub.ts`：`runClawhubFetchList` + `runClawhubEnrichPending` + 翻译 + ZIP unzip helper |
| 3 | Worker pipeline | 1d | 接进 `scheduled()` cron 抢占轮转（BJT 04:00/16:00 跑 phase 1，其他 tick 跑 phase 2）+ R2 迁移逻辑 |
| 4 | Dashboard UI | 2d | `ClawhubCard.tsx` + `ClawhubDrawerBody.tsx` + `SourceIcon` 加 ClawHub SVG（lucide wrench？需斟酌）+ App.tsx 注册 + 顶部筛选 select 三件套 |
| 5 | R2 资源迁移 | 0.5d | `runClawhubR2Migrate` 沿用 `runR2Migrate` helper + skip `/r/` 已迁路径 |
| 6 | 真机验收 | 1d | iOS 真机（preview URL）+ 安卓走 main 自定义域；mobile golden path（首屏 / chip 切换 / drawer 滑动 / 顶 bar 横划）+ telemetry 写入检查 |
| 7 | operations.md 同步 | 0.5d | 加 cron 槽位 + endpoint 表 + D1 表结构 + R2 命名 |

**总：7.5 天**

**前置依赖**：无（CF Workers Paid 已开，DeepSeek key 已注入，share/svg-template.ts 已成熟，Lazy refresh 路径已上线）

**后续 v2 项**（已记 TODO）：
- drawer 30 天趋势模块（数据点 ≥ 7 + variance > 5% 才显示）
- 海报变体上线后 PR5 试用反馈跟进

---

## 8. 验收标准

- [ ] Phase 1 后 `wrangler d1 execute xlist --remote --command="SELECT name FROM sqlite_master WHERE name LIKE 'metrics_snapshots%';"` 看到 ch 表
- [ ] Phase 2 跑过一轮 phase 1 后 `SELECT count(*) FROM items WHERE source_type='clawhub'` ≥ 1000
- [ ] Phase 2 跑完 enrich 后随机 5 条 `content_translated IS NOT NULL` 抽查中文译文质量（含代码块原文保留）
- [ ] Phase 4 `https://staging.ai-feeds.com/?source=clawhub` 能看到 feed + drawer + 分享海报全部正常
- [ ] Phase 6 iOS / 安卓真机 golden path 全过
- [ ] Phase 7 `docs/operations.md` 加 ClawHub 节，"最后更新" 翻新

---

## 附录 A：reconnaissance 验证截图（API 真实输出）

(实施时附 `curl` 命令 + 响应片段做证据，避免后续误以为 API 已变 — 这里先留空。)

## 附录 B：本次 brainstorm 沉淀的 SOP 横向规则

详见 [`docs/source-integration-sop.md`](../source-integration-sop.md) § 4.5（接入新源前后的横向规则）+ § F（emoji 不准当 icon 强制规则）。
