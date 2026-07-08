# 全量内容静态页（SSR item pages）— 设计文档

- 日期：2026-07-08
- 分支：`feat/item-ssr-pages`（从 origin/main）
- 执行约定：Fable 规划/审查/管理，Opus/Sonnet subagent 编码测试
- 背景审计报告：`seo-audit-{crawlability,pipeline,strategy}.md`、`ssr-item-page-feasibility.md`、`seo-full-static-capacity.md`（均在 job tmp）

## 1. 背景与目标

**问题**（SEO 审计实证）：当前全站可索引面只有 ~39 个 URL（首页 + 归档 + 每日聚合页）。库里数千条内容的详情是 SPA 抽屉（`/t/ /g/ /o/ /ph/ /h/`），对爬虫返回同一个 SPA 空壳（`<div id="root">`），既无内容也无 JSON-LD——日报页里每条内链都指向这些空壳，是爬虫死胡同。

**目标**：给日报五源且相关（`is_relevant=1` 的 news/ph/gh/hf/x，约 3.2 万条）每条一个可被搜索引擎 + AI 引擎收录的独立 SSR 页，把可索引面从 39 扩到 ~3.2 万，并让日报静态页的内链指向这些实体页。

**非目标**：clawhub / huodongxing（不在五源）；活动行页；深链 SPA 的 SSR 化（保留 SPA 抽屉现状）；国内 .cc 镜像（暂缓）。

## 2. 已拍板决策（2026-07-08 用户确认）

| # | 决策 | 结论 |
|---|------|------|
| 目标读者 | GEO + 传统 SEO | 均衡对待（页面既 AI 友好结构化、又满足 Google/Bing 收录） |
| 渲染路线 | 三选一 | 路线 2：新命名空间 SSR 页，worker 伺服，**前端零改动** |
| 生成策略 | 预生成 vs 按需 | 预生成全部到 R2 |
| 规模 | 三档 | 五源且相关 ≈ 3.2 万页 |
| 日报**静态页**内链 | 指哪 | 改指 `/i/` SSR 实体页 |
| 订阅日报**邮件**内链 | 指哪 | **保持不变**，仍跳 aifeeds 主站 SPA 抽屉（`/t/` 等） |
| 下架策略 | 过时/低质 | `is_relevant=0` 不生成；已生成的转 410 + noindex + 移出 sitemap |

## 3. URL 结构

新命名空间 `/i/`，每源可读路径，映射到 D1 的 composite id 取单条：

| 路径 | composite id | 去重 |
|------|-------------|------|
| `/i/x/:statusId` | `x_list:<statusId>` | tweet_id 唯一 |
| `/i/gh/:owner/:repo` | `github:<owner>/<repo>` | repo 唯一 |
| `/i/ph/:slug` | `product_hunt:<slug>:<最新date>` | **一产品一页**（73 个跨日期重复项合并；slug→最新 date 行） |
| `/i/paper/:arxivId` | `hf_paper:<arxivId>` | arxiv 唯一 |
| `/i/news/:hash` | `blog:...` / `podcast:...` | url_hash 唯一 |

- PH 去重：路由用 slug（不带 date），D1 按 slug 取该产品最新一条，避免 73 个重复 URL
- 非法/未知 id → 404 简洁页；`is_relevant=0` 或已删除 → 410 + `<meta robots noindex>`

## 4. 组件详设

### 4.1 单页渲染器 `worker/src/seo/item-page.ts`（新文件）

- 输入：`env` + composite id
- 取数：复用现有 `GET /api/items/:id` 的 handler 逻辑（`handleItemById`，`index.ts:3727`，按 composite id `SELECT * FROM items`）→ 抽成可复用的 `fetchItemRow(env, id)`
- 渲染：复用 `render.ts` 的 `renderItem()`（已产出 title/summary/summary_full/cover/deep_link/media/author 等）+ 日报页骨架（`daily-page.ts` 的 head/canonical/OG/内联 CSS/零 script 组装，抽公共骨架 `renderSeoPageShell()` 供日报页与单页共用）
- 需补：`source_type → DigestSource` 反向映射（`selection.ts:19-26` 取反）；huodongxing 无 renderItem 分支——本设计不含活动行，不受影响
- 输出：完整 SSR HTML（规格见 §5）
- 幂等：同 id 重渲覆盖同一 R2 key

### 4.2 存储

- R2：`items/<source>/<id-safe>.html`（`<id-safe>` = composite id 的 URL-safe 编码，与 `/r/` 反代同 bucket，前缀隔离）
- D1 新表 `item_pages`（migration，先 staging 后 prod）：

```sql
CREATE TABLE item_pages (
  item_id      TEXT PRIMARY KEY,   -- composite id
  source       TEXT NOT NULL,      -- news|ph|gh|hf-paper|x
  url_path     TEXT NOT NULL,      -- /i/x/123（用于 sitemap）
  generated_at TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'live'  -- live | gone（410）
);
CREATE INDEX idx_item_pages_source ON item_pages(source, status);
```

sitemap 分片、下架判定均从此表读，不做 R2 list。

### 4.3 生成时机与回填

- **新入库**：生成挂在**各源 enrichment 完成**之后（翻译 + 封面齐了再生成，避免半成品页）——每源 enrich pipeline 的收尾 step 加「若 is_relevant=1 则 generateItemPage」。各源 enrich 收尾点在实施计划里逐源定位
- **存量回填**：admin mode `mode=item-page-backfill&source=<x|gh|ph|hf-paper|news>&limit=N[&dry=1]`——按源分批（每批 ~300-500），**workflow/scheduled 触发绕开香港 60s 提断**（复用日报 backfill 分批经验，见 daily-page-run.ts）；游标单调 `item_page_generated_at`（写 items.extra 或用 item_pages 表存在性判定）
- **内容变更刷新**：metrics 刷新/重新翻译后内容会漂移。轻量定期刷新（如每源每周重生成一批最近 N 天的页），避免「已收录页天天大改」信号——不做实时重生成
- **下架**：is_relevant 被改判 0 或 item 删除 → 对应 mode 或 enrich 收尾把 item_pages.status 置 `gone`（伺服转 410），从 sitemap 排除

### 4.4 伺服路由 `worker/src/seo/item-routes.ts`（新文件）+ index.ts wiring

| 路由 | 行为 | 缓存头 |
|------|------|--------|
| `GET /i/:source/*` | 校验源+id → 查 item_pages.status；live 且 R2 有 → 200 `text/html`；R2 miss 但 item 存在且 relevant → 实时生成兜底后返回；status=gone → 410 + noindex 页；未知/非 relevant → 404 | `public, max-age=3600` |
| `GET /sitemap.xml` | 改为 sitemap-index（§4.6） | `max-age=3600` |
| `GET /sitemap-<source>.xml` | 该源 item_pages（status=live）分片，每片 ≤5 万 | `max-age=3600` |

- bot gate 豁免：`/i/*`、`/sitemap-*.xml` 加入 isSeoPath（爬虫可达）
- 绝对 URL 一律 `SITE_BASE`（禁 request host，HK 中转教训）

### 4.5 日报静态页内链改指（关键 SEO 增益，仅静态页，**不动邮件**）

- `daily-page.ts` 渲染每条 item 的链接：从现在的 SPA 深链（`/t/ /g/ /o/` 等）改为 `/i/` SSR 页
- **邮件 `deliver.ts` / `templates.ts` 保持不变**——订阅邮件仍跳主站 SPA 抽屉（用户明确要求）。两者是独立渲染器（deliver.ts 用私有 toDigestItem，不经 render.ts），天然隔离，改 daily-page 不影响邮件
- codex-push / daily-api 的 deep_link 也不动（那是给 Codex 渲染机/外部 API 的，非本次范围）

### 4.6 sitemap 分片

- `/sitemap.xml` → sitemap-index，列各源分片 + 首页 + 归档 + 日报页分片
- 每源 `/sitemap-<source>.xml`：该源 status=live 的 item_pages，≤5 万/片（超则 `-1 -2` 再分）
- 日报页仍单独一片（或并入 index）
- lastmod 用 item_pages.generated_at 日期部分

### 4.7 页面 HTML 规格（§5 见下）

## 5. 单页 HTML 规格（GEO + 传统 SEO 均衡）

- `<html lang="zh-CN">`；title：`{中文标题} | AI Feeds`
- head：meta description（summary_full 前 ~150 字）、self-canonical `${SITE_BASE}/i/...`、og:title/description/type=article/url/image（cover，兜底站点默认图）、twitter card
- **JSON-LD @graph**（AI 引擎友好，单数据岛、JSON.parse 通过、`<` 转义）：
  - `Article`（headline/description/image/datePublished/author/inLanguage=zh-CN/mainEntityOfPage）
  - `BreadcrumbList`（首页 → 源频道 → 本条）
  - `Organization`（AI Feeds）
- body：
  - `<h1>` 中文标题（唯一 h1）
  - 封面（`loading=lazy`，绝对 R2 URL）
  - 完整中文摘要（summary_full）+ 译文正文摘录（intro/excerpt_zh 等，clamp ~800，按句截）
  - 元信息行：来源标签 + 作者 + 发布时间
  - 原文外链（`target=_blank rel="noopener nofollow"`）
  - **「打开互动版」CTA** → SPA 深链（`${SITE_BASE}/t/:id` 等，真人进 App 交互）
  - 相关内容内链（同源近期 3-5 条 `/i/` 页，增内链密度）
  - footer：订阅入口 + 首页 + 归档
- 样式：内联 CSS，复用日报页视觉；移动优先；零 `<script>`（JSON-LD 岛除外）
- 目标单页 ≤80KB（图片外链不计）

## 6. 错误处理

| 场景 | 行为 |
|------|------|
| 生成异常（enrich 收尾） | 记日志 + 告警（复用 §SEO 打磨批次的 notifier），不阻断 enrich 主流程 |
| R2 miss 但 item relevant | 实时生成兜底 |
| status=gone / is_relevant=0 | 410 + noindex，移出 sitemap |
| 未知 id | 404 简洁页 |
| 回填经香港 60s 提断 | 分批 + 游标可重入（同日报 backfill 教训） |

## 7. 容量（CF $5，已评估）

3.2 万页 × ~40KB ≈ 1.3GB（R2 免费 10GB 内）；3.2 万 PUT = Class A 月免费额 3%；worker 请求零头；D1 item_pages 3.2 万行零头。**唯一工程点**：回填的 worker 时限（分批解决）+ sitemap 立即需分片（§4.6）。年增五源 5-7 万页，超单 sitemap 5 万 → 分片已覆盖。

## 8. 测试计划

- 单页渲染器：各源 fixture → 断言 h1 唯一/canonical/JSON-LD(@graph Article+BreadcrumbList) 可解析/CTA 指 SPA 深链/内链指 /i/·相关条数/零 script/HTML 转义
- PH 去重：同 slug 多 date → 一个 /i/ph/:slug 页（取最新）
- 路由：live 200、gone 410+noindex、未知 404、R2 miss 兜底生成
- sitemap-index：结构合法、各源分片条数 = item_pages(live) 计数、>5 万自动再分
- 日报静态页内链改指 /i/（回归锁：邮件/codex/daily-api 内链**不变**）
- 回填 mode：分源、游标单调、dry 零写
- 下架：is_relevant=0 不生成、已生成转 gone
- 隔离：不碰 deliver.ts/codex-push/daily-api 输出

## 9. 实施分期（writing-plans 细化）

1. 公共骨架抽取（renderSeoPageShell）+ 单页渲染器 + item_pages migration + 反向映射
2. 单页伺服路由（含 410/404/兜底）+ bot gate 豁免 + nginx location
3. 各源 enrich 收尾挂生成 + 存量回填 mode（分源）
4. sitemap 改 index 分片 + 日报静态页内链改指 /i/
5. 下架逻辑（is_relevant=0 / 删除 → gone）
6. staging 全链路（分源回填 dry→真跑 + 抽验各源页 + sitemap 分片 + 日报内链）→ PR

## 10. 风险与备注

- **两 URL 并存**：`/i/:id`（收录页 self-canonical）+ SPA `/t/:id`（空壳，不参与内容竞争）。SPA 空壳无实质内容，不构成重复；如需更稳可给 SPA 深链加 canonical 指向 /i/（可选，实施时评估）
- **薄内容风险**：3.2 万聚合派生页，Google 可能对低质页降权——靠中文翻译+摘要+结构化+相关内链增原创信号；`is_relevant=1` 门槛 + 410 下架控制质量下限
- **生成时机依赖各源 enrich 收尾**：需逐源定位收尾 step，实施计划里明确
- **部署卫生**：本分支从 main 开，部署前 rebase 最新 main（多 session 并行，c-search 等勿覆盖）
