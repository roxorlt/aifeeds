# 全量内容静态页（SSR item pages）— 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. Steps use `- [ ]` checkboxes.
>
> **执行约定（用户指定）**：Fable 规划/委派/审查/管理；编码测试修复由 Opus 4.8 subagent 执行（机械/单文件任务可用 sonnet）。本计划锁**契约**（文件路径、接口签名、行为规格、测试断言、验收标准）；实现体由执行者读「必读文件」现场编写。
>
> **设计文档（必读）**：`docs/plans/2026-07-08-item-ssr-pages-design.md`

**Goal:** 给日报五源且相关（is_relevant=1 的 news/ph/gh/hf/x，≈3.2 万条）每条一个可被搜索引擎+AI 收录的独立 SSR 页（`/i/...`），预生成到 R2，并把日报静态页内链改指这些实体页。

**Architecture:** 新命名空间 `/i/:source/...`，worker 伺服 SSR HTML（前端 SPA 零改动），复用现有 `handleItemById` 取数 + `render.ts renderItem` + daily-page 骨架。预生成到 R2 `items/` 前缀 + D1 `item_pages` 索引表；生成挂各源 enrich 收尾 + 分源回填 mode。sitemap 改 index 分片。

**Tech Stack:** CF Workers（TS，模板字符串 SSR，零框架）、D1、R2（binding `READMES`）、vitest。

## Global Constraints

- 分支 `feat/item-ssr-pages`（从 origin/main，工作区 `.worktrees/feat-item-ssr-pages`）；部署前 rebase 最新 main（多 session 并行，勿覆盖 c-search 等）
- 绝对 URL 一律 `env.SITE_BASE`（禁 request host — HK 中转改写 Host，2026-06-08 事故）
- SSR 页零 `<script>`（JSON-LD `application/ld+json` 数据岛除外）；外部文本一律 `escapeHtml`
- **邮件 `deliver.ts` / `templates.ts`、codex-push、daily-api 的内链/输出一律不动**（只改日报**静态页** daily-page.ts 内链）；render.ts 改动需隔离锁保证这三者逐字节不变
- migration 编号从 **027** 起（026 已被 search-fts 占用）
- 范围仅五源 relevant：clawhub / huodongxing 不生成页
- TDD；commit 中文 + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`；每 Task 完成即 commit

---

### Task 1：URL 映射 + 反向源映射 + 取数抽取 + migration

**Files:**
- Modify: `worker/src/digest/render.ts`（新增 `itemPagePath` + `sourceTypeToUrlSource`；不动 `deepLinkPath`）
- Modify: `worker/src/index.ts`（把 `handleItemById` 的取数体抽成可复用 `fetchItemRow(env, id)`，`handleItemById` 改为调它）
- Create: `worker/migrations/027-item-pages.sql`
- Create: `worker/src/digest/item-url.test.ts`

**必读**：render.ts:64 `deepLinkPath`、selection.ts:15-26 `SOURCE_TYPE`、index.ts:3731 `handleItemById`、migrations/025-daily-pages.sql（格式参照）

**Interfaces（Produces）:**
```ts
// render.ts —— composite id → /i/ 页路径（PH 去 date）
export function itemPagePath(itemId: string): string | null;
//  x_list:123           -> /i/x/123
//  github:o/r           -> /i/gh/o/r
//  product_hunt:slug:D  -> /i/ph/slug        (丢弃 :date)
//  hf_paper:2501.1      -> /i/paper/2501.1
//  blog:...|podcast:... -> /i/news/<url-safe(整 composite id)>
//  clawhub/huodongxing/未知 -> null（不出页）
export const ITEM_URL_SOURCES = ['x','gh','ph','paper','news'] as const;
// index.ts
export async function fetchItemRow(env: Env, id: string): Promise<RenderRow | null>;
```
migration（与设计 §4.2 一字不差）：
```sql
CREATE TABLE IF NOT EXISTS item_pages (
  item_id TEXT PRIMARY KEY, source TEXT NOT NULL, url_path TEXT NOT NULL,
  generated_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'live'
);
CREATE INDEX IF NOT EXISTS idx_item_pages_source ON item_pages(source, status);
```

**Steps:**
- [ ] 写 item-url.test.ts：itemPagePath 五源正例（含 PH 丢 date、gh 双段 owner/repo、news 编码）+ clawhub/huodongxing/乱码 → null
- [ ] `npm test` RED → 实现 itemPagePath + 反向映射 → GREEN
- [ ] fetchItemRow 抽取：断言 handleItemById 行为不变（原 endpoint 回归——若有既有测试跑通即可，无则加最小断言 fetchItemRow 命中/未命中返回）
- [ ] migration 本地验证：`sqlite3 :memory: < worker/migrations/027-item-pages.sql` 无报错
- [ ] Commit：`feat(seo): item 页 URL 映射 + 取数抽取 + item_pages migration`

**验收**：itemPagePath 五源正确 + PH 去重形态；fetchItemRow 抽取无回归；migration 可执行。

---

### Task 2：SSR 骨架抽取 + 单页渲染器

**Files:**
- Modify: `worker/src/digest/daily-page.ts`（把 head/canonical/OG/内联 CSS/`<html>` 外壳抽成公共 `renderSeoPageShell(opts)`，daily 页改用它——输出对既有日报页**逐字节不变**，纯重构）
- Create: `worker/src/seo/item-page.ts`
- Create: `worker/src/seo/item-page.test.ts`

**必读**：daily-page.ts 全文（骨架、jsonLdSafe、escapeHtml、clampSentences 用法）、render.ts renderItem/RenderedItem、设计 §5

**Interfaces（Produces）:**
```ts
// daily-page.ts
export function renderSeoPageShell(opts: {
  lang: 'zh-CN'; title: string; description: string; canonical: string;
  ogImage?: string; ogType: 'website'|'article'; jsonLd: object; bodyHtml: string;
}): string;   // 完整 <html>…，单 JSON-LD 数据岛，零可执行 script
// item-page.ts
export function renderItemPageHtml(row: RenderRow, env: Env): string;  // 纯函数
```

**行为规格（renderItemPageHtml，对应设计 §5）**：source_type→DigestSource 反映射后 `renderItem()`；title=`{中文标题} | AI Feeds`；self-canonical `${SITE_BASE}${itemPagePath(id)}`；og:type=article；JSON-LD `@graph`=[Article, BreadcrumbList(首页→源频道→本条), Organization]；body：唯一 `<h1>` 标题、封面(lazy)、完整摘要(summary_full)+译文摘录(intro clamp 800)、来源/作者/时间行、原文外链(`rel="noopener nofollow"`)、**「打开互动版」CTA→`${SITE_BASE}${deepLinkPath(id)}`**、同源相关内链占位（Task 4 填真数据，本 task 接受传入 related 数组、空则不渲染）、footer。

**测试断言（fixture RenderRow，不依赖 DB）:**
- [ ] 唯一 h1；canonical=`/i/...` self；JSON-LD `JSON.parse` 成功且含 Article+BreadcrumbList+Organization
- [ ] CTA href = SPA 深链（`/t/` `/g/` 等，deepLinkPath）；正文无 `/i/` 之外的站内详情链接错配
- [ ] 输出不含 `<script`（剥 JSON-LD 岛后）；`<`/`&`/`"` 外部文本转义（XSS fixture）
- [ ] PH row（product_hunt:slug:date）→ canonical=`/i/ph/slug`（无 date）
- [ ] renderSeoPageShell 重构后：既有日报页快照测试逐字节不变（回归锁）
- [ ] Commit：`feat(seo): SSR 骨架抽取 + 单页渲染器`

---

### Task 3：单页伺服路由 + bot gate 豁免

**Files:**
- Create: `worker/src/seo/item-routes.ts`
- Create: `worker/src/seo/item-routes.test.ts`
- Modify: `worker/src/seo-routes.ts`（`isSeoPath` 增 `/i/` 前缀 + `/sitemap-*.xml` 放行）
- Modify: `worker/src/index.ts`（公开段 wiring，置 handleSeoRoute 附近；bot gate 豁免同 isSeoPath）

**必读**：seo-routes.ts（handleSeoRoute/isSeoPath 结构、Response 惯例）、Task 1 的 itemPagePath/fetchItemRow、Task 2 的 renderItemPageHtml、Task 4 的 generateItemPage（先按接口签名调用）

**Interfaces（Produces）:**
```ts
export async function handleItemRoute(request: Request, env: Env): Promise<Response | null>;
//  null = 非 /i/ 路径，index.ts 继续后续匹配
```

**路由行为（设计 §4.4）：** `/i/:source/*`：解析 source+id → 反查 composite id → 查 `item_pages.status`：
- live 且 R2 `items/<...>.html` 命中 → 200 `text/html; charset=utf-8` + `Cache-Control: public, max-age=3600`
- live 但 R2 miss 且 item 存在且 is_relevant=1 → 调 `generateItemPage`（Task 4）实时兜底生成后返回
- status=gone 或 item is_relevant=0 → 410 + `<meta name="robots" content="noindex">` + `no-store`
- 未知 source / id 无对应 item → 404 简洁页（含返回首页链接）
- PH：`/i/ph/:slug` → D1 查该 slug 最新 product_hunt item

**测试断言（R2/D1 mock）:**
- [ ] live+R2 命中 → 200 + 正确头；miss+relevant → 触发生成后 200；gone → 410+noindex+no-store；is_relevant=0 → 410；未知 id → 404
- [ ] `/i/ph/:slug` → 命中该 slug 最新行
- [ ] `isSeoPath('/i/x/1')===true`、`isSeoPath('/sitemap-x.xml')===true`、`isSeoPath('/api/x')===false`
- [ ] handleItemRoute 对非 `/i/` 返回 null（穿透既有路由）
- [ ] Commit：`feat(seo): /i 单页伺服路由 + bot gate 豁免`

---

### Task 4：生成编排 + 分源回填 mode

**Files:**
- Create: `worker/src/seo/item-page-run.ts`
- Create: `worker/src/seo/item-page-run.test.ts`
- Modify: `worker/src/index.ts`（`/api/enrich/run` 加 `mode=item-page-backfill`，参照既有 mode 分发）

**必读**：设计 §4.3/§4.4；daily-page-run.ts（R2 put + D1 upsert + 分批/游标/dry 范式，直接照搬结构）、Task 1-2 接口

**Interfaces（Produces）:**
```ts
export interface ItemPageRunResult { itemId: string; skipped: boolean; reason?: string }
export async function generateItemPage(env: Env, id: string,
  opts?: { dry?: boolean }): Promise<ItemPageRunResult>;
//  is_relevant!=1 或源不在五源 → skipped；否则 render→R2 put items/<source>/<safe>.html→item_pages upsert(status=live)
export async function markItemPageGone(env: Env, id: string): Promise<void>;
//  item_pages.status='gone'（供下架）
export async function backfillItemPages(env: Env,
  source: 'x'|'gh'|'ph'|'hf-paper'|'news', opts?: { limit?: number; dry?: boolean }): Promise<{scanned:number;generated:number;remaining:number}>;
//  按 source 扫 is_relevant=1 且未在 item_pages(或游标) 的 item → generateItemPage；分批、游标单调、dry 零写
```

**行为规格：** generateItemPage 复用 fetchItemRow + renderItemPageHtml；R2 key = `items/<source>/<url-safe id>.html`；相关内链（同源近期 3-5 条，`SELECT ... 同 source_type ORDER BY published_at DESC LIMIT` 排除自身，取各自 itemPagePath）在此层查好传给渲染器。backfill 分批（默认 limit 300）、`item_pages` 存在性即游标（生成即入表退出谓词）、dry 零写、经香港 60s 提断按行数核对（同 daily backfill 教训）。

**测试断言（R2/D1 mock）:**
- [ ] is_relevant=1 → R2 put + item_pages upsert(live)；is_relevant=0/clawhub → skipped 零写
- [ ] 同 id 二次生成不新增 item_pages 行（幂等 upsert）；dry 零写
- [ ] markItemPageGone → status=gone
- [ ] backfill 分源谓词正确（只选该 source 的 relevant 未生成）、游标单调、remaining 递减
- [ ] Commit：`feat(seo): item 页生成编排 + 分源回填 mode`

---

### Task 5：各源 enrich 收尾挂生成 + 下架

**Files:**
- Modify: 各源 pipeline enrich 收尾 —— `worker/src/blog-pipeline.ts`、`podcast-pipeline.ts`、`github-pipeline.ts`、`ph-pipeline.ts`、`hf-paper-pipeline.ts`、`x-tweet-pipeline.ts`（读各文件定位「enrich 完成、is_relevant 已定、翻译+封面齐」的收尾点）
- Test: 至少 2 个代表源（如 ph-pipeline、github-pipeline）加挂载测试

**必读**：各 pipeline 文件的收尾 step 结构（找 markCompleted / 最后一步）、Task 4 generateItemPage/markItemPageGone

**行为规格：** 每源 enrich 收尾（内容最终态）后：`is_relevant===1` → `await generateItemPage(env, id)`（非阻塞容错：try/catch 只记日志/告警，不阻断 enrich 主流程）；`is_relevant===0` 且该 item 已有 item_pages 行 → `markItemPageGone`。news 走 blog+podcast 两 pipeline。挂载必须最小侵入（收尾追加一步），不改各源既有逻辑。

**测试断言：**
- [ ] 代表源 pipeline 收尾：relevant→调 generateItemPage（mock 断言被调 + id 正确）；not relevant→不调（或调 markGone 若已有页）
- [ ] 生成异常不冒泡（enrich 主流程仍完成）
- [ ] 全量 `npm test` 绿
- [ ] Commit：`feat(seo): 各源 enrich 收尾挂 item 页生成 + 下架`

---

### Task 6：sitemap 改 index 分片

**Files:**
- Modify: `worker/src/seo-routes.ts`（`/sitemap.xml` 改 sitemap-index；新增 `/sitemap-<source>.xml` 分片；日报页并入 index）
- Test: `worker/src/seo-routes.test.ts`（既有文件加断言）

**必读**：seo-routes.ts 现有 sitemap 生成（约 :225）、设计 §4.6

**行为规格：** `/sitemap.xml` → `<sitemapindex>` 列：日报页片 + 五源各 `/sitemap-<source>.xml`（+ 首页/归档）。`/sitemap-<source>.xml` → 该源 `item_pages WHERE status='live'` 的 url_path，`<lastmod>`=generated_at 日期；单片 ≤5 万，超则 `/sitemap-<source>-2.xml` 续片（实现分页参数）。绝对 URL 用 SITE_BASE。

**测试断言：**
- [ ] `/sitemap.xml` 是合法 `<sitemapindex>`，含各源分片 URL
- [ ] `/sitemap-x.xml` 条目数 = mock item_pages(live, source=x) 计数；gone 不入
- [ ] >5 万自动续片（mock 大计数）
- [ ] robots.txt 的 Sitemap 行仍指 `/sitemap.xml`（index，无需改）
- [ ] Commit：`feat(seo): sitemap 改 index 分片`

---

### Task 7：日报静态页内链改指 /i/（不动邮件）

**Files:**
- Modify: `worker/src/digest/daily-page.ts`（`:197` `deepUrl` 与 `:251` JSON-LD `url` 从 `deep_link` 改用 `itemPagePath(id)`；itemPagePath 返回 null 的源回退原 deep_link）
- Test: `worker/src/digest/daily-page.test.ts`（既有文件加断言）

**必读**：daily-page.ts:195-255（内链与 JSON-LD 生成）、Task 1 itemPagePath

**行为规格：** 日报**静态页**每条 item 的可见链接 + JSON-LD ItemList 的 `url` 改为 `${SITE_BASE}${itemPagePath(id)}`（指 SSR 实体页）；itemPagePath 返回 null（理论上五源不会，但 clawhub 若混入）回退 `deep_link`。**deliver.ts/templates.ts/codex-push/daily-api 一律不动**。

**测试断言：**
- [ ] 日报静态页 item 链接 = `/i/...`（非 `/t/` `/g/`）；JSON-LD url 同步
- [ ] **回归锁**：邮件 templates.ts / codex-push / daily-api 输出的深链**仍是 `/t/` 等不变**（若无既有测试则加断言）
- [ ] Commit：`feat(seo): 日报静态页内链改指 /i/ 实体页`

---

### Task 8：nginx location 扩展（部署项）

**Files:**
- Modify: `deploy/nginx/aifeeds-seo-location.conf`（SEO 打磨批次已建此文件；本 task 在正则里加 `/i/` 与 `/sitemap-...xml`）
- Modify: `docs/operations.md` §6b（路由表补 `/i/*` `/sitemap-*.xml`）

**行为规格：** location 正则从 `^/(daily(/.*)?|robots\.txt|sitemap\.xml|llms\.txt|<key>\.txt)$` 扩为含 `i/.*` 与 `sitemap-[a-z0-9-]+\.xml`。文件是 repo 权威副本；实际 VPS 同步在部署步（Task 9/上线）SSH 执行。**注意与 SEO 打磨批次（fix/seo-polish-ops）同改此文件——本分支基于 main，若那批已 merge 则以 merge 后为准 rebase；未 merge 则本 task 直接在设计基础上写完整正则并在 PR 注明与那批的合并顺序**。

- [ ] Commit：`chore(seo): nginx location 扩 /i 与 sitemap 分片`

---

### Task 9：staging 全链路 + PR（用户 review 门）

**必读**：operations.md（staging 资源、deploy 模板 source 整个 env）、CLAUDE.md 发布前 checklist

- [ ] rebase 检查：`git fetch origin && git log --oneline origin/main..HEAD`；落后则 rebase + 重跑 `npm test`
- [ ] migration staging：`set -a; . ../.secrets/aifeeds-staging.env; set +a; npx wrangler d1 execute xlist-staging --env staging --remote --file=migrations/027-item-pages.sql`
- [ ] deploy staging（`wrangler deploy --env staging`，先 source 整个 env）
- [ ] 分源回填各跑一小批：`mode=item-page-backfill&source=gh&limit=20&dry=1` → 真跑 → 抽验；五源各抽一条 `curl staging-api /i/<source>/<id>` 断言 200 + h1 + canonical + JSON-LD @graph + CTA 指 SPA 深链
- [ ] PH 去重：抽一个有跨日期重复的 slug，确认 `/i/ph/:slug` 一页取最新
- [ ] 410：手动 markGone 一条 → curl 410+noindex
- [ ] sitemap：`/sitemap.xml` 是 index、`/sitemap-gh.xml` 含刚回填的
- [ ] 日报静态页内链：重生成一页 → curl 确认 item 链接是 `/i/`；**邮件链路零回归**（notify 或既有测试确认邮件仍 `/t/`）
- [ ] `npm test` 全绿
- [ ] push + `gh pr create`：body 含设计+计划链接、staging 证据、**merge 后 runbook**（migration prod → 部署 → nginx 同步 SSH + 清缓存 → 分源回填 dry→真跑至 remaining=0 → 抽验各源页 + sitemap + 日报内链 + Google Rich Results 测一条 /i/ 页）、CI baseline 红叉说明、结尾 🤖 Generated with [Claude Code](https://claude.com/claude-code)
- [ ] 暂停等用户 review/merge

---

## Self-Review 结果

- 规格覆盖：设计 §3 URL→Task1；§4.1 渲染器→Task2；§4.2 存储→Task1(migration)+Task4(R2)；§4.3 生成时机→Task4+Task5；§4.4 伺服→Task3；§4.5 日报内链→Task7；§4.6 sitemap→Task6；§5 HTML→Task2；下架→Task4(markGone)+Task5；nginx→Task8；§8 测试散入各 task；§9 分期↔Task 顺序。无缺口
- 类型一致性：`itemPagePath`/`fetchItemRow`/`renderItemPageHtml`/`renderSeoPageShell`/`generateItemPage`/`markItemPageGone`/`backfillItemPages`/`handleItemRoute`/`isSeoPath` 各 task 引用一致；R2 binding `READMES`；migration 027；源枚举 `x|gh|ph|hf-paper|news`（URL 段 `paper`，backfill 参数 `hf-paper`——Task1 ITEM_URL_SOURCES 用 URL 段 `paper`，Task4 backfill source 参数用 `hf-paper` 对齐 DigestSource，实现者注意两处命名映射，item-url.test 锁 paper URL 段）
- 口径说明：实现体由 Opus 执行者按「必读文件」编写，锁契约+断言，非占位
