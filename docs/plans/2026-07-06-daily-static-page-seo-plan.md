# AI 日报每日静态页 + SEO P0 整包 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **执行约定（用户指定）**：Fable 5 负责本计划的制定、任务委派、逐任务 review 与验收；所有编码/测试/修复由 **Opus 4.8 subagent** 执行。每个 Task 的实现代码由执行者在阅读「必读文件」后编写——本计划锁定的是**契约**（文件路径、接口签名、行为规格、测试断言、验收标准），不预写实现体。
>
> **设计文档（必读）**：`docs/plans/2026-07-06-daily-static-page-seo-design.md`（含全部组件规格 §4、页面 HTML 规格 §5、错误处理 §6、测试与验收 §7、上线步骤 §8）

**Goal:** 每天 8 点邮件推送时同步生成 SEO 友好的纯静态日报页 `ai-feeds.com/daily/YYYY-MM-DD`（每源上限 20 条，链接指向抽屉深链），并一次性补齐 robots.txt / sitemap.xml / llms.txt / index.html head / IndexNow。

**Architecture:** 生成侧挂在 `DigestNodeRunWorkflow` 8 点档新增的非阻塞 Phase 4：同款评分选品 top20/源 → 纯 HTML 渲染 → R2（`READMES` binding，`daily/` 前缀）→ D1 `daily_pages` 索引表 → IndexNow ping。伺服侧 worker 新增公开路由，香港 nginx 把主域相关路径转发给 worker，其余仍走 Pages。

**Tech Stack:** CF Workers（TS，模板字符串渲染，零框架）、D1、R2、vitest（本次引入）、React SPA 侧仅 3 处小改。

## Global Constraints

- 分支：`feat/daily-static-page`，工作区：`.worktrees/feat-daily-static-page`（已 gitignore；避开主工作区另一 session 在 `worker/src/digest/node-run.ts` 的未提交改动）
- 绝对 URL 一律 `env.SITE_BASE` / `env.API_BASE` 拼接，**禁止取 request host**（HK 中转改写 Host，2026-06-08 事故）
- 日报页零 `<script>`；UI 不得用 emoji 当 icon（SVG only，源数据原文除外）
- 不写任何 secret 到代码/文档；新 secret（`INDEXNOW_KEY`、`DAILY_PAGE_ENABLED`）只进 `.secrets/aifeeds-{prod,staging}.env` + wrangler secret
- Phase 4 全部代码必须容错自闭：任何异常只 `console.error`，不得影响邮件分发
- commit 频繁、消息中文、结尾 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- 每个 Task 完成即 commit；测试先行（TDD）：先写失败测试 → 实现 → 通过 → commit

---

### Task 0：工作区准备（由主控执行，非 subagent）

- [ ] `git fetch origin && git worktree add .worktrees/feat-daily-static-page -b feat/daily-static-page origin/main`
- [ ] 确认 worktree 内 `git log --oneline -1` 与 `git ls-remote origin main` 一致

---

### Task 1：vitest 基建 + config 常量 + D1 migration

**Files:**
- Modify: `worker/package.json`（devDependencies 加 `vitest`；scripts 加 `"test": "vitest run"`）
- Create: `worker/vitest.config.ts`（最小配置：include `src/**/*.test.ts`，environment `node`）
- Modify: `worker/src/digest/config.ts`（新增 `export const DAILY_PAGE_PER_SOURCE_LIMIT = 20`）
- Create: `worker/migrations/025-daily-pages.sql`

**必读文件：** `worker/src/digest/config.ts`、`worker/migrations/024-user-feedback.sql`（格式参照）

**Interfaces（Produces）:**
- `DAILY_PAGE_PER_SOURCE_LIMIT: number`（config.ts 导出，Task 2/3 消费）
- 表 `daily_pages`，与设计 §4.2 一字不差：

```sql
CREATE TABLE IF NOT EXISTS daily_pages (
  date TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  item_count INTEGER NOT NULL,
  generated_at TEXT NOT NULL
);
```

**Steps:**
- [ ] 安装 vitest，写一个冒烟测试 `worker/src/digest/config.test.ts`：断言 `DAILY_PAGE_PER_SOURCE_LIMIT === 20`
- [ ] `cd worker && npm test` → 先 FAIL（常量未定义）→ 加常量 → PASS
- [ ] migration 文件落盘；本地验证：`npx wrangler d1 execute xlist --local --file=migrations/025-daily-pages.sql` 无报错
- [ ] Commit：`feat(seo): vitest 基建 + daily_pages migration + 每源 20 条常量`

**验收：** `npm test` 通过；migration 本地可执行。

---

### Task 2：日报页数据构建 + HTML 渲染器（纯函数）+ 单测

**Files:**
- Create: `worker/src/digest/daily-page.ts`
- Create: `worker/src/digest/daily-page.test.ts`

**必读文件：** 设计文档 §4.1/§5；`worker/src/digest/selection.ts`（Phase 1 normal 档选品函数的真实签名）、`worker/src/digest/render.ts`（`renderItem` / `RenderedItem`）、`worker/src/digest/node-run.ts:104-153`（`_subject` 读取方式）、`worker/src/digest/config.ts`（`DIGEST_SOURCE_ORDER`、source labels）、`docs/design-handoff.md`（品牌色 token）

**Interfaces（Produces，Task 3/4 消费）:**

```ts
export interface DailyPageSection { source: string; label: string; items: RenderedItem[] }
export interface DailyPageData {
  date: string                  // YYYY-MM-DD（BJT）
  subject: string               // 当日 LLM 主题，缺失时 fallback 文案
  sections: DailyPageSection[]  // 按 news→ph→gh→hf-paper→x 顺序，空源已剔除
  prevDate: string | null       // daily_pages 中相邻已生成日期
  nextDate: string | null       // null → 「后一日」渲染为指向 /daily/ 归档
}
export async function buildDailyPageData(env: Env, date: string): Promise<DailyPageData | null>
  // null = 当日五源全空（调用方跳过生成）。内部：每源调用 selection.ts 同款评分选品
  // （limit=DAILY_PAGE_PER_SOURCE_LIMIT；如现有函数不支持自定义 limit/日期锚点，
  //  加可选参数并保持默认行为不变，Phase 1 邮件路径零改动）→ renderItem()
export function renderDailyPageHtml(data: DailyPageData, env: Env): string
```

**行为规格（renderDailyPageHtml，逐条对应设计 §5）：** `lang="zh-CN"`；title `AI 日报 {date} · {subject} | AI Feeds`；meta description=subject；canonical=`${SITE_BASE}/daily/${date}`；og:title/description/type=article/url/image（首条有 cover 的 item，兜底 `${SITE_BASE}/og-default.png`）；JSON-LD `CollectionPage`+`ItemList`（item: name=标题, url=深链绝对 URL）；header 前后日导航；每源 `<section>`+`<h2>`，item 为 `<article>`：标题链深链、摘要（summary_full 优先，clamp 同 deliver.ts 逻辑）、来源/作者行、原文外链 `target="_blank" rel="noopener"`、封面 `loading="lazy"`；footer 含 `/subscribe`、`/`、`/daily/`；单 `<style>` 内联、系统字体栈、移动优先单列。

**测试断言（fixture 自造 RenderedItem 数组，不依赖 DB）：**
- [ ] title/canonical/og:url 含正确日期与 SITE_BASE
- [ ] JSON-LD 可 `JSON.parse`，ItemList 条数 = fixture 总条数
- [ ] 五源 section 按序齐全；空源 section 不渲染
- [ ] 每源传入 25 条时只渲染 20 条（截断在 buildDailyPageData 层，渲染层按传入渲染——断言放 build 层用 mock 选品，或渲染层加保护，二选一由实现者定并写明）
- [ ] 深链为绝对 URL（`https://ai-feeds.com/t/...` 形态）
- [ ] 输出不含 `<script`
- [ ] `nextDate=null` 时「后一日」href=`/daily/`；有值时 href=`/daily/{nextDate}`
- [ ] Commit：`feat(seo): 日报页数据构建与 HTML 渲染器 + 单测`

---

### Task 3：生成编排 + workflow Phase 4 挂载 + admin 回填入口

**Files:**
- Create: `worker/src/digest/daily-page-run.ts`
- Create: `worker/src/digest/daily-page-run.test.ts`
- Modify: `worker/src/digest/node-run.ts`（Phase 3 之后加 Phase 4，仅 `slotHourBjt===8` 且 `env.DAILY_PAGE_ENABLED==='1'`）
- Modify: `worker/src/index.ts`（`/api/enrich/run` 新增 `mode=daily-page`，参照 `mode=daily-codex-push` 的写法，`index.ts:4493-4506` 附近）

**必读文件：** `worker/src/digest/node-run.ts`（Phase 3 容错模式原样照抄）、`worker/src/digest/codex-push.ts`（幂等与 prod-gate 写法）、`worker/wrangler.toml`（R2 binding `READMES`）

**Interfaces（Produces）:**

```ts
export interface DailyPageRunResult { date: string; itemCount: number; skipped: boolean; reason?: string }
export async function generateDailyPage(env: Env, date: string,
  opts?: { dry?: boolean; skipIndexNow?: boolean; skipPrevRerender?: boolean }): Promise<DailyPageRunResult>
export async function backfillDailyPages(env: Env, opts?: { dry?: boolean }): Promise<DailyPageRunResult[]>
export async function pingIndexNow(env: Env, urls: string[]): Promise<void>  // 非 2xx 只 console.error
```

**行为规格：** `generateDailyPage` = buildDailyPageData（null→skipped）→ renderDailyPageHtml → R2 `READMES.put('daily/'+date+'.html', html)` → D1 UPSERT daily_pages →（skipPrevRerender 为假时）若存在前一已生成日期则重渲染该日页面令其 nextDate=本日 → pingIndexNow([`${SITE_BASE}/daily/${date}`, `${SITE_BASE}/daily/`, `${SITE_BASE}/sitemap.xml`])。`backfillDailyPages` = 取 `digest_pool` distinct 日期升序逐日 `generateDailyPage(..., {skipIndexNow:true})`，结束后一次性批量 ping 全部 URL。IndexNow：POST `https://api.indexnow.org/indexnow`，body `{host, key: env.INDEXNOW_KEY, urlList}`；`INDEXNOW_KEY` 未配置时静默跳过。Phase 4 整体 try/catch 包裹 + 独立 workflow step，异常仅 console.error。

**测试断言（R2/D1 用内存 mock）：**
- [ ] 选品为空 → `{skipped:true}`，R2/D1 零调用
- [ ] 正常路径 → R2 key 正确、daily_pages UPSERT（同日期二次调用不新增行）
- [ ] 存在前日 → 前日页面被重渲染且其 HTML 含指向本日的链接
- [ ] `dry:true` → 不落盘，返回 itemCount
- [ ] pingIndexNow 抛错不冒泡到 generateDailyPage 返回值
- [ ] Commit：`feat(seo): 日报页生成编排 + Phase 4 挂载 + admin daily-page 模式`

**注意：** `node-run.ts` 在主工作区有另一 session 未提交改动；worktree 基于 origin/main，PR 前若对方已合并需 rebase 解决（Phase 4 是追加块，冲突面小）。

---

### Task 4：worker 公开 SEO 路由 + bot gate 豁免

**Files:**
- Create: `worker/src/seo-routes.ts`
- Create: `worker/src/seo-routes.test.ts`
- Modify: `worker/src/index.ts`（路由 wiring，置于 admin/API 路由之前的公开段；bot gate 豁免参照 `/s/<token>` 的既有豁免，`index.ts:5238-5251` 附近）

**必读文件：** 设计文档 §4.5-§4.9；`worker/src/index.ts` 现有路由段与 bot gate 实现；`worker/src/share/handlers.ts:983-1018`（Response 构造惯例）

**Interfaces（Produces）:**

```ts
export function isSeoPath(pathname: string): boolean   // bot gate 豁免判定
export async function handleSeoRoute(request: Request, env: Env): Promise<Response | null>
  // null = 非本模块路径，index.ts 继续后续匹配
```

**路由行为（与设计 §4.5 表一致）：** `/daily/:date`（正则 `^/daily/(\d{4}-\d{2}-\d{2})$`）→ R2 get，200 `text/html; charset=utf-8` + `Cache-Control: public, max-age=3600`，miss→404 简洁 HTML（含返回 `/daily/` 链接）；`/daily` 与 `/daily/` → 从 daily_pages 渲染归档索引（按月分组倒序，同 Cache-Control）；`/daily/<非法>` → 302 `/daily/`；`/robots.txt`（内容照抄设计 §4.6，含 Sitemap 行）与 `/llms.txt` → `max-age=86400`；`/sitemap.xml` → daily_pages 全量 + `/` + `/daily/`，lastmod 取 generated_at 日期部分，`max-age=3600`；`/{INDEXNOW_KEY}.txt` → key 纯文本（未配置 secret 时 404）。

**测试断言：**
- [ ] 合法日期 R2 命中 → 200 + 正确 Content-Type/Cache-Control；miss → 404
- [ ] `/daily/2026-13-99` 与 `/daily/abc` → 302 Location `/daily/`
- [ ] robots.txt 含 `Sitemap: https://ai-feeds.com/sitemap.xml` 与 5 条 Disallow（/api/ /admin /settings /me/ /unsubscribe）
- [ ] sitemap 条目数 = mock 行数 + 2 且 XML 前缀合法
- [ ] llms.txt 含最近 7 天链接（mock 10 行 → 只出 7 条）
- [ ] `isSeoPath('/daily/2026-07-06')===true`、`isSeoPath('/api/items')===false`
- [ ] Commit：`feat(seo): /daily 路由 + robots/sitemap/llms/indexnow-key + bot gate 豁免`

---

### Task 5：dashboard 三处小改 + og 默认图

**Files:**
- Modify: `dashboard/public/sw.js`（`shellFirst` 排除 `pathname.startsWith('/daily')` → 直接 fetch 透传；`VERSION` bump `v1`→`v2`）
- Modify: `dashboard/src/App.tsx`（footer 加「AI 日报」普通 `<a href="/daily/">`，样式对齐现有 footer 链接，参照 `App.tsx:1137` 附近 blog 链接写法）
- Modify: `dashboard/index.html`（`lang="zh-CN"`；补 og:title/og:description/og:type=website/og:url/og:image 与 twitter:card；title 改 `AI Feeds — 一站式 AI 信息聚合看板`）
- Create: `dashboard/public/og-default.png`（1200×630，从 `public/favicon.svg` 品牌元素衍生，深底 + logo + 站名，工具自选：resvg/sips/node canvas 均可）

**必读文件：** `dashboard/public/sw.js`（`:5-6` 注释与 `:47-95` 策略）、`docs/frontend-ux-guidelines.md`（footer 规范）、`docs/design-handoff.md`（品牌色）

**验收步骤：**
- [ ] `cd dashboard && npm run build` 零 error
- [ ] dist/sw.js 含 `/daily` 排除逻辑与新 VERSION；dist/index.html 含全部 og 标签与 `lang="zh-CN"`
- [ ] og-default.png 尺寸恰为 1200×630（`sips -g pixelWidth -g pixelHeight` 验证）
- [ ] Commit：`feat(seo): SW 放行 /daily + footer 日报入口 + index.html head 修复 + og 默认图`

---

### Task 6：staging 全链路验证（对应设计 §7.2）

**必读文件：** `docs/operations.md`（staging 资源对照、deploy 命令模板节）、`CLAUDE.md` 发布前 checklist

- [ ] migration：`cd worker && set -a; . ../.secrets/aifeeds-staging.env; set +a; npx wrangler d1 execute xlist-staging --env staging --remote --file=migrations/025-daily-pages.sql`
- [ ] staging secrets：`INDEXNOW_KEY`（新随机值）写入 wrangler secret + `.secrets/aifeeds-staging.env`；`DAILY_PAGE_ENABLED` staging 不设（验证静默关闭态）
- [ ] deploy：`npx wrangler deploy --env staging`（先 source 整个 env 文件——9106 事故模板）
- [ ] 手动生成：`curl -X POST 'https://staging-api.ai-feeds.com/api/enrich/run?mode=daily-page&date=<staging 有数据日期>'`（admin 鉴权头照 operations.md）→ 返回 itemCount>0
- [ ] 断言：`curl -s https://staging-api.ai-feeds.com/daily/<该日期>` 含 title/canonical/JSON-LD/`lang="zh-CN"`；`/daily/`、`/robots.txt`、`/sitemap.xml`（含该页）、`/llms.txt` 全 200
- [ ] 邮件零回归：staging 触发 `notify-digest-now`，确认分发正常且日志无 Phase 4 报错（关闭态应完全静默）
- [ ] 回归全量单测：`cd worker && npm test` 全绿
- [ ] 记录验证结果（每条断言的实际输出），供 PR 描述引用

---

### Task 7：PR（用户 review 门）

- [ ] worktree 内 rebase 检查：`git fetch origin && git log --oneline origin/main..HEAD`；若 main 已收另一 session 的 node-run 改动则 rebase 并重跑 `npm test`
- [ ] review diff 确认无 secret 后 push：`git push -u origin feat/daily-static-page`
- [ ] `gh pr create`：标题 `feat(seo): 每日静态日报页 /daily/ + SEO P0 整包`，body 含设计文档链接、staging 验证证据、prod 上线清单（Task 8 摘要）、结尾 🤖 Generated with [Claude Code](https://claude.com/claude-code)
- [ ] **暂停，等用户 review/merge**（prod 上线在合并后进行）

---

### Task 8：prod 上线 + 回填 + 验收（合并后执行，对应设计 §7.3/§8）

- [ ] migration prod：`npx wrangler d1 execute xlist --remote --file=migrations/025-daily-pages.sql`（source prod env）
- [ ] prod secrets：`INDEXNOW_KEY`（prod 独立随机值）、`DAILY_PAGE_ENABLED=1` → wrangler secret + `.secrets/aifeeds-prod.env` 同步（+`gh secret set` 如 CI 需要）
- [ ] main 上 deploy：worker + dashboard 同步部署（fetch 对账 origin/main 权威 HEAD 后再 deploy——整包替换教训）
- [ ] HK nginx：`ai-feeds.com` server block 加设计 §4.10 location 块（key 文件名代入真实 `INDEXNOW_KEY`）→ `nginx -t` → reload → `rm -rf /var/cache/nginx/aifeeds/*`（SSH 方式照 operations.md §6b）
- [ ] backfill：`curl -X POST '...mode=daily-page&backfill=1&dry=1'` 先看日期清单 → 去 dry 执行 → 校验 daily_pages 行数 = 清单数
- [ ] prod 验收 curl（主域，经 HK nginx）：`/daily/<最新>`、`/daily/`、`/robots.txt`、`/sitemap.xml`、`/llms.txt` 全 200 且内容正确
- [ ] 人工 smoke：日报页任一深链点开抽屉正常；微信内打开日报页无异常
- [ ] Google Rich Results Test 通过（无致命错误）
- [ ] 次日 8 点后回看：新页自然生成 + IndexNow 日志成功（观察一个周期后本项才勾）

---

### Task 9：文档收尾

- [ ] `docs/operations.md`：worker 路由表补 `/daily/*` 等 5 条 + `/api/enrich/run mode=daily-page`；§6b nginx 段补 location 与回滚说明；secrets 清单补 `INDEXNOW_KEY`/`DAILY_PAGE_ENABLED`；D1 表清单补 `daily_pages`
- [ ] `TODO.md` §12：P0 勾选完成项（daily 静态页/robots/sitemap/llms/JSON-LD/head 修复），P1 站长平台标注「待用户手动」
- [ ] Create `docs/seo-webmaster-guide.md`：GSC + Bing 验证与 sitemap 提交 step-by-step（含 IndexNow key 说明）
- [ ] Commit（文档可直接进 main）

---

## Self-Review 结果

- 规格覆盖：设计 §4.1-4.11 → Task 2/3/4/5/8；§5 → Task 2；§7.1/7.2/7.3 → Task 2-4 单测/Task 6/Task 8；§8 九步 → Task 6-9。无缺口
- 类型一致性：`DailyPageData`/`RenderedItem`/`DailyPageRunResult`/`isSeoPath` 各任务引用一致；R2 binding 统一 `READMES`；migration 编号 025 已核实
- 有意的口径说明：实现体由 Opus 执行者按「必读文件」现场编写（用户指定分工），本计划锁契约与断言，不含"TBD"类占位
