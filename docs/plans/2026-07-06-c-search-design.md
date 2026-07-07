# C 端站内搜索 — 设计文档

> 状态：**已实施**（2026-07-06，staging 验收通过，待用户验收 → prod）。方向性决策已获用户批准，本文档为实施依据；与最终实现的差异见文末「§14 实施偏差记录」。
> 配套实施计划：`docs/plans/2026-07-06-c-search-plan.md`
> 分支：`feat/c-search`（与「SEO 每日静态页」计划并行开发，协调事项见 §12）

## 0. 用户已拍板的关键决策

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | 结果页组织 | **按源分组从上到下**：每组露 top 3 + 「更多 →」下钻单源完整流；组序按组内最高相关性分降序；空组不渲染 |
| 2 | 入口形态 | **独立 `/search` 路由页**：移动端全屏、PC 居中面板；起始页放历史/热搜/源入口 |
| 3 | 检索引擎 | **D1 FTS5 影子表 + 中文 bigram 预分词**（索引侧/查询侧共用同一分词函数） |
| 4 | 实施节奏 | **与 SEO 每日静态页并行**（不同分支，migration 编号与 index.ts 接线协调见 §12） |

## 1. 背景与目标

aifeeds C 端目前没有任何站内搜索。items 表 ~5.5 万行 / 76MB+，10 种 source_type，中文译文分散在 `content_translated` 与 `extra` JSON 多个字段。目标：

- 匿名可用的站内搜索：入口（放大镜）→ 起始页（历史/热搜/源入口）→ suggestion → 分组结果页 → 单源下钻 → 抽屉详情，返回键逐级回退
- 服务端 FTS5 全文检索，p90 延迟 ≤ 500ms，内容入库到可搜到 ≤ 5 分钟
- 搜索服务与主服务解耦：索引维护不侵入现有写入管线，搜索故障不影响 feed
- admin dashboard 新增搜索监控区块（使用/性能/异常）

**非目标（V1 明确不做）**：关键词高亮、拼音/纠错、podcast 转写全文与 GH README 全文检索、个性化排序、搜索结果 SEO 收录（搜索页 noindex）。

## 2. 架构总览

```
写入侧（全部挂在现有 */5 cron 上，新增独立步骤，与主管线解耦）：
  items 表（现状不动）
    └→ syncSearchIndex()   每 5 分钟增量同步 → items_fts（FTS5 影子表）
    └→ rebuildSearchTerms() 每小时物化      → search_terms（suggestion 词表）
    └→ 每日 03:35 UTC cleanup 档：全量 reconcile（对账补漏）

读取侧（全部匿名可用）：
  GET /api/search?q=                    → 分组模式（每源 top3 + total）
  GET /api/search?q=&source=&cursor=    → 单源 list 模式（cursor 分页）
  GET /api/search/suggest?prefix=       → 前缀联想；prefix 为空 → 热搜 top 10

前端：
  /search 路由（lazy）：?q= / &source= 驱动三态（起始页 / 分组页 / 单源流）
  卡片渲染复用 Feed 的按源分派（抽公共函数），点击复用现有抽屉深链体系

监控：
  search_* 埋点（7 个事件）→ events 表 → admin dashboard「搜索」区块
```

核心取舍：**索引与词表全靠 cron 增量维护**（幂等 upsert，失败下轮自动补齐），主管线零改动 —— 这是「搜索不影响主服务」的结构性保证，而不是靠 try/catch。

## 3. 数据层（migration，编号实施时取 `migrations/` 目录 max+1，预计 026）

### 3.1 items_fts（FTS5 影子表）

```sql
CREATE VIRTUAL TABLE items_fts USING fts5(
  title_tok,          -- 标题类 token 流（权重高）
  body_tok,           -- 正文/摘要类 token 流（权重中）
  author_tok,         -- 作者/handle token 流（权重低）
  item_id UNINDEXED,
  source_type UNINDEXED,
  published_at UNINDEXED,
  tokenize = 'unicode61'
);
```

- 列内容是 **预分词后的空格分隔 token 流**（见 §4），FTS5 自身只用默认 unicode61 —— 不依赖 D1 的 trigram/ICU 编译选项，migration 里先 `CREATE VIRTUAL TABLE` 冒烟验证 D1 FTS5 可用性（staging 先行）。
- **rowid 对齐**：`INSERT INTO items_fts(rowid, ...) SELECT items.rowid, ...`，删除/更新用 `DELETE FROM items_fts WHERE rowid = (SELECT rowid FROM items WHERE id = ?)` 后重插，避免 UNINDEXED 列全表扫。
- **入索引门槛（写入侧过滤，查询侧复检双保险）**：`workflow_completed_at IS NOT NULL` 且 `deleted_at IS NULL` 且 `is_relevant = 1` 且 `dedup_of IS NULL` 且 `cn_sensitive != 1`。不满足的行不进索引；后天变化（如事后标记 cn_sensitive / 软删）靠每日全量 reconcile 清出。

### 3.2 各源字段映射（索引什么）

| source_type | title_tok | body_tok | author_tok |
|---|---|---|---|
| x_list | —（推文无标题） | content + content_translated | author + handle |
| github | title（owner/repo） | extra.ai_summary + extra.readme_translated(截 500 字) + extra.ai_category | owner（title 拆分） |
| product_hunt | title | content(tagline) + extra.ai_summary + extra.maker_post_text_translated | extra.makers 名 |
| clawhub | title | extra.summary_translated + extra.category | author |
| hf_paper | title + extra.title_zh | extra.deep_analysis.tldr + extra.ai_keywords | author(提交者) |
| blog | title + extra.title_zh | extra.excerpt_zh + extra.ai_summary_zh | author(媒体名) |
| podcast | title + extra.title_zh | extra.shownotes_zh(截 1000 字) + extra.timeline 章节名 | author(节目) + extra.guests |
| huodongxing | title | content + extra 城市/主办方 | author(主办方) |
| 其余源 | title | content_translated ?? content（截 1000 字） | author + handle |

超长字段一律截断（readme 500 字 / shownotes、正文 1000 字），**不索引** podcast 转写全文、README 全文、hf 深度分析全文。

### 3.3 search_terms（suggestion 词表）

```sql
CREATE TABLE search_terms (
  term       TEXT NOT NULL,           -- 展示原文（保留大小写）
  term_norm  TEXT NOT NULL,           -- 小写归一，前缀匹配键
  term_type  TEXT NOT NULL,           -- 'entity' | 'hot_query'
  source_type TEXT,                   -- entity 词来源（可空）
  weight     REAL NOT NULL DEFAULT 0, -- 排序权重（频次/热度归一）
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (term_norm, term_type)
);
CREATE INDEX idx_search_terms_norm ON search_terms(term_norm, weight DESC);
```

- **entity 词**（每小时重算，`INSERT OR REPLACE`，一轮后删除 updated_at 过期行）：GH 仓库名（owner 与 repo 拆开各一条）、PH 产品名、ClawHub skill 名、hf_paper ai_keywords、blog 媒体名、高频作者/handle（出现 ≥3 条内容）、GH/ClawHub 的 ai_category。全部来自库内真实存在的内容 → 搜必有果。
- **hot_query 词**（同一 cron 内从 events 聚合）：近 7 天 `search_submit` 事件、出现 ≥3 次、且末次搜索非空结果的 query，取 top 100。冷启动期该类为空，suggestion 与热搜自动只用 entity 词。
- 前缀查询用范围扫描（`term_norm >= ? AND term_norm < ? || X'EFBFBF'`），不用 LIKE，保证走索引。

### 3.4 search_sync_state（同步水位）

```sql
CREATE TABLE search_sync_state (k TEXT PRIMARY KEY, v TEXT NOT NULL);
```

**按实现最终的 key 集**：`fts_wm_scraped_epoch`（增量同步的 `scraped_at` 水位，存 **epoch 秒**，规避 `scraped_at` 混合格式的字典序越行）、`fts_wm_translated`（`translated_at` 水位）、`fts_backfill_rowid`（首次 backfill 的 rowid 游标）、`fts_backfill_done`、`last_reconcile`（每日对账结果 JSON：itemsEligible/ftsRows/drift/purged/at）。词表 `rebuildSearchTerms` 每整点全量重算，不再单独存 `terms_last_run`。

## 4. 分词（tokenizeForSearch，索引侧/查询侧共用）

纯 TS 实现，无依赖，放 `worker/src/search/tokenize.ts`：

1. NFKC 归一 + 小写；
2. 按字符类切段：CJK 连续段 / 拉丁字母数字段（含 `- _ .` 连接的词按分隔符再拆，如 `claude-code` → `claude` `code` 及原词）/ 其余丢弃；
3. 拉丁段：整词保留（≤32 字符截断）；
4. CJK 段：相邻两字滑窗 bigram（「大模型」→ `大模 模型`）；段长为 1 保留单字；
5. 输出空格拼接（不去重，保留词频给 BM25）。

**查询构造（防 FTS 语法注入的唯一入口）**：query 过同一函数得 token 数组 → 每个 token 用双引号包裹（内部双引号剔除）→ 隐式 AND 连接；前缀星（`*`）规则**按实现最终定为**：**CJK 单字 token 在任意位置一律加 `*` 前缀匹配**（单字过窄，前缀扩召回）；**拉丁 token 仅当它是唯一 token 且长度 ≥3 时加星**（多 token 时拉丁词已由隐式 AND 收敛，无需再放宽）。**禁止任何用户输入直接拼进 MATCH 表达式**。token 数上限 12（超出截断）。

不同匹配目标不做不同分词策略 —— 差异全部放在字段权重（bm25 列权重）与排序衰减上，复杂度低一个量级。

## 5. 召回与排序

### 5.1 召回

```sql
SELECT item_id, source_type, published_at,
       bm25(items_fts, 5.0, 1.0, 3.0) AS score   -- title/body/author 权重
FROM items_fts WHERE items_fts MATCH ?1
ORDER BY score LIMIT 200;
```

全时段召回、不设硬时间窗（数据量级不需要，砍窗反而丢 GH/PH 长尾价值）。召回后按 item_id `IN` 回查 items 表取完整行，**查询侧复检**合规过滤（workflow_completed_at / dedup_of / cn_sensitive / deleted_at / is_relevant，与 `handleItems` 同一套条件，双保险）。

### 5.2 排序

`final = (-bm25) × 0.5^(age_days / half_life)`，半衰期按源分组：

| 组 | 源 | half_life |
|---|---|---|
| 时效敏感 | x_list、blog、weibo（未来源同类） | 7 天 |
| 中性 | podcast、hf_paper、huodongxing、youtube、arxiv | 30 天 |
| 长效 | github、product_hunt、clawhub | 180 天 |

- **分组模式**：召回集按 source_type 分组，组内按 final 降序取 top 3；组序按组内 max(final) 降序；每组 total = 该源在召回集中的命中数（上限展示为「200+」当召回触顶）。
- **单源 list 模式**：MATCH + `source_type = ?` 过滤，final 排序，cursor 分页，每页 20。**cursor 按实现最终定为「召回集内 offset」**（base64 编码的偏移量，非设计初稿的 `final|rowid`）：单 query 单源在 `RECALL_LIMIT`=200 条召回集内翻页，offset 到顶即 `has_more=false`。简化理由与召回集封顶一致——超 200 条命中的长尾单源极罕见，offset 分页实现更简、无 tiebreaker 抖动。
- 权重与半衰期写成 `worker/src/search/ranking.ts` 顶部常量表，上线后按监控调参。

## 6. API 设计（`worker/src/search/handlers.ts`，index.ts 只加路由 if 行）

### 6.1 GET /api/search

参数：`q`（必填，trim 后 1-100 字符，超限 400）、`source`（可选，合法 source_type，非法 400）、`cursor`（仅 list 模式）、`limit`（list 模式默认 20 上限 50）。

- 无 `source` → 分组模式：`{ mode:"grouped", groups:[{source_type,total,items:[≤3 Item]}], query_time_ms }`
- 有 `source` → list 模式：`{ mode:"list", items, next_cursor, has_more, query_time_ms }`
- Item 结构与 `/api/items` 完全一致（前端卡片零适配）。
- 空 q / 纯空白 / 纯符号（分词后 token 为空）→ 400 `{error:"empty_query"}`。
- 边缘缓存：Cache API，key 为归一化 `q+source+cursor+limit`，`max-age=60`（匿名无个性化，安全）。HK 中转使全部请求落同一 colo，命中率反而高。

### 6.2 GET /api/search/suggest

参数：`prefix`（0-50 字符）。空 prefix → 热搜 top 10（hot_query 优先、不足补 entity 高权重词）；非空 → term_norm 前缀范围查询 top 8。响应 `{ terms:[{term,term_type}] }`。Cache API `max-age=300`。任何内部错误返回 200 + 空数组（suggestion 永不阻塞搜索主流程）。

### 6.3 限流与安全

- **worker 层限流**：KV 计数，key `search:rl:{device_id 或 clientIp}:{分钟桶}`，TTL 120s；`/api/search` 每分钟 12 次、`/suggest` 每分钟 40 次，超限 429 `{error:"rate_limited"}`。身份优先 `X-Device-Id`，缺失时用 `getClientIp()`（**必须**用 `worker/src/client-ip.ts`，HK 中转塌 IP 坑）。
- CF 既有 `/api/*` 10s/30req 规则兜底。
- **bot gate 不豁免**搜索接口（与 `/api/items` 不同，搜索无 SEO 诉求）；前端 /search 页 meta noindex。
- SQL 全参数绑定；MATCH 表达式仅经 §4 查询构造器生成。
- CORS 沿用 `withCors()` 现状。

### 6.4 鲁棒性

- 搜索 handler 独立 try/catch，异常返回 500 `{error:"search_unavailable"}`，不波及其他 endpoint。
- 单请求 D1 查询数固定（FTS 召回 1 + items 回查 1 + 限流 KV 1），LIMIT 硬编码，无放大查询。
- 索引同步失败只记 log + `cron_runs`，下轮自动补；同步与查询互不阻塞。

## 7. 索引同步（`worker/src/search/sync.ts`，挂现有 cron）

- **增量（每 5 分钟）**：取 `scraped_at > watermark - 10min` 或 `translated_at > watermark_epoch - 600` 的行（buffer 防时钟偏差），过入索引门槛后 delete+insert upsert，单轮上限 2000 行，更新水位。幂等。
- **首次 backfill**：`fts_backfill_done` 为空时，增量轮自动从头分批（每轮 2000 行，5.5 万行 ≈ 2.5 小时追平）；另提供 `POST /api/admin/search/reindex`（admin auth）手动触发循环批次，staging 验证用。
- **每日 reconcile（cleanup 档）**：对账 items 与 items_fts 行数差；清出事后不合规行（软删/cn_sensitive 追标）；行数差进 admin 面板与告警。

## 8. 前端（dashboard）

### 8.1 路由与状态

- `App.tsx` 路由表新增 `/search`（lazy，如 Settings 模式）；`main.tsx` 冷启动 history seed 列表加 `/search` 前缀。
- 三态由 URL 驱动：`/search`（起始）→ `/search?q=xxx`（分组结果）→ `/search?q=xxx&source=github`（单源流）。状态迁移用 `navigate` push，**返回键天然逐级回退**：抽屉 → 单源流/分组页（列表位置保留）→ 起始页 → feed。条目点击复用 `drawer.openItem`（深链/返回行为零新增代码）。
- 入口：顶栏 `<UserMenu />` 之前加放大镜 icon button（`icons.tsx` 新增 `IconSearch`，lucide 风格手写 SVG，禁止引入图标库/emoji）。

### 8.2 起始页（自动聚焦输入框）

从上到下：① 搜索历史（localStorage `aifeeds_search_history`，20 条 LRU，单条删除 ✕、整体「清空」带 confirm）；② 热门搜索 chips（suggest 空 prefix 的 top 10）；③ 源快捷入口（各源 icon chips，点击 = 空 q 聚焦输入框 + 预选该源过滤，提交后直进该源 list 模式）。历史纯设备本地，不上传。

### 8.3 输入态

防抖 250ms 请求 suggest；AbortController 取消在途旧请求防乱序；输入框 `maxLength=50`、移动端 `text-base`（≥16px 防 iOS 缩放）；suggestion 下拉遵循 `rounded-lg + shadow-lg + border` 规范；回车/点建议提交 → `navigate(/search?q=)` 并写入历史。

### 8.4 结果页

- **分组页**：每组 = 组头（源 icon + 源名 + total + 「更多 →」）+ ≤3 张卡片。卡片渲染抽公共函数 `renderItemCard(item)`（从 `Feed.tsx` 的 source_type 分派 switch 提取，Feed 同步改为调用公共函数 —— 顺手消除一处重复）。骨架屏复用 `SkeletonCard`。
- **单源流**：复用 IntersectionObserver 无限滚动模式（rootMargin 200px + 连败冷却）。
- **空态**：全空 → 「没有找到与『xx』相关的内容」+ 热搜词 chips + 换词提示；单源空 → 同文案 + 「搜全部」按钮。文案沉静 neutral，无彩色。
- **异常态**：429 → toast「搜索太频繁，稍后再试」；500/超时 → 行内错误 + 重试按钮（`apiFetch` 已有 5s 超时与退避重试）。
- 视觉全部遵循 `docs/frontend-ux-guidelines.md`：neutral 灰阶、无彩色主按钮、`rounded-md`/`rounded-lg`、`transition-colors`、错误紧挨输入框下方。
- 三端：单列流（PC 居中 `max-w-2xl`）；微信浏览器同移动端（站点既有适配）；断点用 `useIsNarrow()`。

### 8.5 API client

`api.ts` 新增 `searchItems(q, {source, cursor})` 与 `searchSuggest(prefix)`，走 `apiFetch`（自动 X-Device-Id / 重试 / 超时），base 从 `apiBase.ts` import（唯一事实源，勿抄）。`/api/search` 不入 `protectedPaths`（匿名可搜，401 不弹登录）。

## 9. 埋点与监控

### 9.1 事件（前端 `EVENTS` + worker `EVENT_TYPE_WHITELIST` 同步新增）

| 事件 | payload 要点 |
|---|---|
| search_open | 入口来源（appbar/deeplink） |
| search_submit | q（明文，用于热搜聚合）、q_len、来源（typed/history/hot/suggest）、mode |
| search_suggest_click | prefix_len、位置 |
| search_result_click | item_id、source_type、组内位置、组序/流内位置 |
| search_empty | q、mode |
| search_error | 错误类型（429/500/timeout） |
| search_perf | 服务端 query_time_ms + 前端端到端耗时 |

q 明文入 events 用于热搜词聚合与坏 case 分析（行业常规；events 表已有同级数据）。

### 9.2 admin dashboard「搜索」区块（`admin-dashboard.ts` 新增 metric 函数）

- **使用（3.1）**：搜索 PV/UV、人均次数、热门 query top 20、无结果率、结果 CTR 与点击位置分布、suggestion 采纳率
- **性能（3.2）**：query_time_ms 与端到端耗时的 p50/p90/p99（复用 `pctl()`）
- **异常（3.3）**：搜索错误率趋势、429 次数、**索引滞后量**（items 合规行数 − items_fts 行数，reconcile 时写入，>500 触发既有 notifier 告警）

## 10. 测试计划（全部通过才交付验收）

1. **单测（node:test，仓内既有模式）**：tokenize（中英混排/单字/emoji/全角/超长/空）、MATCH 构造器（注入字符 `" * ( ) NEAR AND` 等全部中和）、ranking decay、分组与组序、cursor 编解码、suggest 归一。
2. **staging 集成（curl 断言脚本）**：migration 上 staging → reindex → 断言：中文 2 字词/4 字词、英文词、中英混合、source 过滤、cursor 翻页稳定性、**合规复检**（插入 cn_sensitive/dedup/软删测试行，断言不出现在结果）、400（空 q/超长/非法 source）、429（连打 13 次）、缓存命中（第二次响应 header）、suggest 前缀与空 prefix。
3. **前端 E2E（staging，Playwright，移动端 + PC 视口）**：入口点击 → 起始页三块 → 输入 suggestion → 提交 → 分组页 → 更多下钻 → 无限滚动 → 点卡片开抽屉 → 返回键逐级回退全链 → 历史增删清空 → 空态 → 429 提示 → 微信 UA smoke。
4. **回归**：feed 首屏/无限滚动/抽屉深链不受影响（renderItemCard 抽取后 Feed 行为不变）；`npm run build` + `tsc -b` + lint 零错。

## 11. 验收标准（交付给用户时逐条对照）

- [ ] staging.ai-feeds.com：未登录状态完成「放大镜 → 起始页（历史/热搜/源入口）→ 输入出 suggestion（≤400ms 体感）→ 分组结果 → 更多下钻 → 抽屉 → 返回键逐级回退到 feed」全链
- [ ] 中文/英文/中英混合 query 均有合理结果；时效类源近期内容靠前，GH/PH 老内容不被埋没
- [ ] 搜索历史单删/清空生效且仅存本地；query 超 50 字不可输入
- [ ] 全空结果与单源空结果空态正确；连续快速搜索触发 429 提示且 60s 后恢复
- [ ] cn_sensitive / 未完成 / 已删除内容在任何搜索结果中不可见（我会给出验证方法与截图）
- [ ] 新内容入库后 ≤5 分钟可搜到（staging 手动触发验证）
- [ ] admin dashboard 出现搜索区块且有数据
- [ ] feed / 抽屉 / 分享等既有功能回归无异常
- [ ] prod 上线后同样断言 + operations.md / TODO.md 已同步更新

## 12. 与「SEO 每日静态页」并行的协调条款

- migration 编号：SEO 占 `025-daily-pages`；搜索让位取 `026-search-fts`（2026-07-06 rebase onto main 时最终定编，原暂用 025 已重命名为 026）。
- `worker/src/index.ts`：搜索只加 3-4 行路由 if（逻辑全在 `src/search/`），冲突面最小化；deploy 前执行 CLAUDE.md 的 rebase 检查强制条款（fetch + 对账 origin/main）。
- cron `scheduled()` 分流表：搜索新增两档（5 分钟增量、每小时词表），与 SEO 的 Phase 4 互不重叠。
- `wrangler.toml` 无需新增 binding（复用 DB / AUTH_KV）。
- 两分支各自 staging 验证后合 main；后合者负责 rebase 与回归。

## 13. 风险与备忘

| 风险 | 缓解 |
|---|---|
| D1 FTS5 可用性/行为差异 | Task 0 在 staging 先冒烟 CREATE VIRTUAL TABLE + MATCH，失败则降级方案（LIKE + 时间窗）再议 |
| FTS 索引使 D1 体积增长 | 只索引截断后的 token 流（估 +20-30MB）；reconcile 报行数；D1 限额 10GB 富余 |
| bigram 召回噪声（跨词边界组合） | BM25 词频天然压噪 + title 权重高；上线后按无结果率/CTR 调 |
| KV 限流计数写放大 | 搜索 QPS 低；如超预期改 D1 计数（feedback 先例） |
| worker/src/digest/node-run.ts 有未提交改动（他 session） | 搜索不触碰 digest 目录；分支只改 search/ 前端与少量接线点 |

## 14. 实施偏差记录

> 实现整体与本设计一致（§3-§9 逐条落地、§10 测试计划全过、§11 验收清单 staging 全绿）。以下为与设计初稿的可记录差异，正文相关段落已就地同步。

| # | 设计初稿 | 最终实现 | 原因 |
|---|---------|---------|------|
| 1 | migration 预计 025 | **026-search-fts.sql** | 与并行的「SEO 每日静态页」rebase 时让位，SEO 占 025、搜索取 026（见 §12） |
| 2 | 前缀星「末位 token 拉丁 ≥3 或 CJK 单字」（§4） | **CJK 单字任意位置加星；拉丁仅唯一 token 且 ≥3 加星** | 单字过窄需前缀扩召回；多 token 时拉丁已由隐式 AND 收敛，无需再放宽（正文 §4 已改） |
| 3 | list 模式 cursor = `final\|rowid`（§5.2） | **召回集内 offset cursor（base64）**，单 query 单源上限 200 条 | 与召回集封顶（RECALL_LIMIT=200）一致，offset 实现更简、无 tiebreaker 抖动（正文 §5.2 已改） |
| 4 | 水位 key `fts_watermark` / `terms_last_run`（§3.4） | **`fts_wm_scraped_epoch`（epoch 秒）+ `fts_wm_translated` + `fts_backfill_rowid` + `last_reconcile`**；词表每整点全量重算不存 last_run | `scraped_at` 混合格式字典序会越行，改存 epoch 秒规避（正文 §3.4 已改） |
| 5 | 分组模式 total = 该源在召回集中的命中数（§5.2） | 同设计，但**明确语义**：total 取自召回集内命中数，与「更多」下钻 list 模式的实际可翻页数**可能不完全一致**（列入 V2 文案优化） | 召回封顶 + 分组/list 两条查询路径的固有差异；不影响正确性，仅文案 |
| 6 | §3.3 hot_query「末次搜索非空结果」过滤 | **未实现**（依赖尚不存在的 payload） | 列入 TODO V2 backlog（join `search_empty` 事件补齐） |

其余（三表 schema、bigram 分词、召回排序衰减、限流缓存、埋点、前端三态与返回链）均与设计一致。
