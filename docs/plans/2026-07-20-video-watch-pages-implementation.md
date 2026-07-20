# Video Watch Pages Implementation Plan

> **For Codex:** 按 `executing-plans` 工作流逐项实施，并在每个红绿循环后保存验证证据。

**Goal:** 为每期 AI 日报视频增加专用观看页，并把视频 sitemap、普通 sitemap 和抓取路径统一迁移到该页面。

**Architecture:** Worker 用现有 `daily_videos` D1 行动态渲染 `/video/daily/:date`，复用日报 SEO HTML 骨架与媒体 URL 生成逻辑。日报页继续保留播放器并新增普通内链；视频 sitemap 以观看页为 landing page，日报 sitemap 也枚举观看页。

**Tech Stack:** Cloudflare Workers、D1、R2、TypeScript、Vitest、原生 HTML5 Video、schema.org JSON-LD。

---

### Task 1: 观看页路由与结构化数据

**Files:**
- Modify: `worker/src/seo-routes.test.ts`
- Modify: `worker/src/seo-routes.ts`
- Modify: `worker/src/digest/daily-page.ts`

**Step 1: Write the failing tests**

覆盖：

- `isSeoPath('/video/daily/2026-07-14')`。
- 有视频返回 200、self canonical、唯一 H1、首屏播放器、字幕、日报返回链接。
- JSON-LD 的 `VideoObject.@id`、`contentUrl`、`thumbnailUrl` 和 `uploadDate`。
- 无视频、非法日期返回 404 + `noindex`。

**Step 2: Run test to verify it fails**

Run: `cd worker && npm test -- src/seo-routes.test.ts`

Expected: FAIL，因为 `/video/daily/:date` 尚未被识别和渲染。

**Step 3: Write minimal implementation**

- 增加严格 watch path 正则和 D1 单行读取。
- 复用 `renderSeoPageShell`，渲染单视频页面。
- 让 `dailyVideoObject` 支持观看页 canonical。

**Step 4: Run test to verify it passes**

Run: `cd worker && npm test -- src/seo-routes.test.ts`

Expected: PASS。

### Task 2: 日报页可抓取入口

**Files:**
- Modify: `worker/src/digest/daily-page.test.ts`
- Modify: `worker/src/digest/daily-page.ts`
- Modify: `worker/src/seo-routes.test.ts`
- Modify: `worker/src/seo-routes.ts`

**Step 1: Write the failing tests**

断言新生成页面含观看页链接；旧 R2 快照在响应时补入同一链接且重复调用不重复。

**Step 2: Run test to verify it fails**

Run: `cd worker && npm test -- src/digest/daily-page.test.ts src/seo-routes.test.ts`

Expected: FAIL，缺少 watch link。

**Step 3: Write minimal implementation**

在视频 marker 内加入链接，并为旧快照提供仅字符串级的幂等补链，不增加每次请求的 D1 查询。

**Step 4: Run test to verify it passes**

Run: `cd worker && npm test -- src/digest/daily-page.test.ts src/seo-routes.test.ts`

Expected: PASS。

### Task 3: Sitemap 与 IndexNow

**Files:**
- Modify: `worker/src/seo-routes.test.ts`
- Modify: `worker/src/seo-routes.ts`
- Modify: `worker/src/digest/daily-video.test.ts`
- Modify: `worker/src/digest/daily-video.ts`

**Step 1: Write the failing tests**

断言：

- video sitemap `<loc>` 使用 `/video/daily/:date`，不再使用 `/daily/:date`。
- daily sitemap 包含观看页并用 `updated_at` 作为 `lastmod`。
- IndexNow URL 集合包含观看页。

**Step 2: Run tests to verify they fail**

Run: `cd worker && npm test -- src/seo-routes.test.ts src/digest/daily-video.test.ts`

Expected: FAIL，当前输出仍指向日报页。

**Step 3: Write minimal implementation**

只调整 URL 生成和 sitemap 枚举，不修改 D1 schema 或媒体资源。

**Step 4: Run tests to verify they pass**

Run: `cd worker && npm test -- src/seo-routes.test.ts src/digest/daily-video.test.ts`

Expected: PASS。

### Task 4: 三层路径与文档

**Files:**
- Modify: `dashboard/public/sw.js`
- Modify: `dashboard/src/archiveLinks.contract.test.mjs`
- Modify: `deploy/nginx/aifeeds-seo-location.conf`
- Modify: `docs/operations.md`
- Modify: `TODO.md`

**Step 1: Write or extend the failing path contract**

断言 Worker、SW 和 nginx 都包含 `/video/daily/*`。

**Step 2: Run contract to verify it fails**

Run: `cd dashboard && node --test src/archiveLinks.contract.test.mjs`

Expected: FAIL，SW/nginx 尚未放行观看页。

**Step 3: Update path mirrors and documentation**

更新三层路径口径、端点表、sitemap/IndexNow 说明与 TODO 状态。

**Step 4: Run focused and full verification**

Run:

- `cd worker && npm test -- src/seo-routes.test.ts src/digest/daily-page.test.ts src/digest/daily-video.test.ts`
- `cd worker && npm test`
- `cd worker && npx tsc --noEmit`
- `cd dashboard && node --test src/archiveLinks.contract.test.mjs`

Expected: 所有命令退出码 0。
