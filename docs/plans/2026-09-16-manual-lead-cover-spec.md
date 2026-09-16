# 补录线索封面图：从提交的链接取图并写入条目（2026-09-16）

## 背景（已取证，勿重复排查）
- 补录线索入池后写成 `items` 行：`id = 'blog:manual:<leadId>'`、`source_type='blog'`、`source_ref='manual_lead'`（`digest/manual-news-leads-store.ts` ~3893）。三种准入（`owner_asserted_v1` / `owner_vouched_v1` / `source_support_v1`）都不写 `media`，`extra` 里没有 `cover_image`，所以日报视频、Codex 推送、静态日报页对补录条目一律无图。
- 日报渲染 `digest/render.ts` news 分支：daily-api / codex-push 取 `extra.cover_image`（任意 URL）→ `media[0]` → `body.assets`；静态日报页（`daily-page.ts` 开 `newsCoverQualityGate`）要求 `extra.cover_image` 是站内 `/r/` 形态并过尺寸门。出片机在大陆，外链多半下不来，所以**只写站内 `/r/` 形态**。
- 推文：网关 `POST /v1/tweet`（Worker 客户端 `security/safe-url-fetch.ts fetchTweetEvidence`）已返回 `images: string[]`（pbs.twimg.com），目前在 `digest/manual-news-leads-runtime.ts` ~501-516 整形时被丢掉。
- 网页：`feeds/extract.ts extractPageMeta`（~342-435）已能解析 `og:image` / `twitter:image`；`feeds/media-r2.ts migrateFeedCover`（~296）把外链图迁进 R2（5MB、质量门、`/r/blog/<sha256>.<ext>`），`feeds/cover-heuristics.ts` 有 `COVER_BLACKLIST` 与 `passesCoverSizeGate`。
- 近 45 天线索链接来源（105 条）：mp.weixin.qq.com 19、x.com 13、techcrunch.com 13、openai.com 11、anthropic.com 9、blog.google 2、ithome / 36kr / jiqizhixin / deepseek 文档 各 1-2、scmp 1。
- **签名约束**：`title/content/content_translated/author/url/published_at` 与 `extra.event_fingerprint`、`extra.manual_lead`（及 `manual_source_support`）被 HMAC 投影覆盖，一个字都不能改；正式新闻门 `news-source-policy.ts formalNewsFinalGuardCtes` 在授权→写库同一请求内逐字比较 `extra`，所以对 extra 的补写只能是「入池完成之后」的独立请求/异步任务，且只 `json_set` 新键。

## 目标
补录条目尽可能带封面：推文取推文图，网页取 og/twitter 图，微信文章取其封面；图迁进 R2 后写 `extra.cover_image`。取不到不报错、可重试、不影响入池与审核。

## 改动

### B1 新模块 `worker/src/digest/manual-lead-cover.ts`
- `resolveManualLeadCover(env, { url }, deps?)` → `{ cover: string | null; source: 'tweet' | 'og' | 'twitter' | 'wechat' | 'body' | null; reason?: string }`，永不抛异常。
  - `deps`：`fetcher`（默认全局 fetch）、`fetchTweet`（默认封装 `fetchTweetEvidence`，返回 `images[]`）、`migrate`（默认 `migrateFeedCover`）。全部可注入以便测试。
  - **推文**（`parseTwitterStatusUrl` 命中）：`fetchTweet(url).images` 按顺序尝试，pbs.twimg.com 链接若无 `format`/`name` 参数则补 `?format=jpg&name=large`；`migrate` 成功即返回 `source:'tweet'`。
  - **网页**：直接从 Worker `fetch` 页面（浏览器 UA 常量复用 `feeds/media-r2.ts` ~60；超时 12s；HTML 上限 2MB；跟随跳转；只接受 `text/html`）。候选顺序：`og:image` → `og:image:secure_url` → `twitter:image`（复用 `extractPageMeta`）→ 微信专属：`<meta property="og:image">` 已在前面覆盖，另外解析 `var msg_cdn_url = "…"`（微信文章封面变量）与正文 `<img data-src="…">`（微信正文图用 data-src 不用 src）→ 通用兜底：正文第一张声明 `width`/`height` 均 ≥ 300 的 `<img src|data-src>`。
  - 过滤：`data:`、`.svg`、`COVER_BLACKLIST`、相对路径按最终页面 URL 解析、只接受 http(s)。最多尝试 3 个候选，`migrate` 通过（含质量门）即止。
  - `reason` 给短码：`tweet_no_images` / `fetch_failed:<status|timeout>` / `not_html` / `no_candidates` / `all_candidates_rejected`。
- `ensureManualLeadCover(env, itemId, deps?)` → `{ status: 'set' | 'skipped' | 'failed'; reason?: string }`：
  - 读 `items` 的 `url`、`extra`；`extra.cover_image` 已是 `/r/` 开头 → `skipped:already`；`url` 空 → `skipped:no_url`；非 force 时 `extra.cover_attempts >= 3` 且 `cover_last_attempt_at` 在 24h 内 → `skipped:attempts`。
  - 成功：`UPDATE items SET extra = json_set(coalesce(extra,'{}'), '$.cover_image', ?, '$.cover_image_source', ?, '$.cover_resolved_at', ?) WHERE id = ? AND (json_extract(extra,'$.cover_image') IS NULL OR json_extract(extra,'$.cover_image') NOT LIKE '/r/%')`（幂等）。
  - 失败：`json_set` `$.cover_attempts`（+1）、`$.cover_last_error`、`$.cover_last_attempt_at`。
  - 绝不写 `media`、绝不碰签名覆盖的列/键。

### B2 触发点
1. `owner_asserted_v1`：`digest/manual-lead-content-workflow.ts` 在 `pool` 步之后追加 durable step `cover`（描述符加到 `manual-lead-content.ts` 的 step name 联合类型；单步超时 20s；永不抛；`pool` 失败则跳过）。
2. `vouch-candidate` / `confirm-candidate` / `source_support_v1` 自动入池：在 `digest/manual-news-leads-api.ts` 对应处理成功返回后 `ctx.waitUntil(ensureManualLeadCover(...))`，写法照 `scheduleLeadEnrichment`（~216-238）。source_support 的入池发生在 workflow 内，若在 API 层拿不到入池时机，就依赖第 3 条兜底，不要硬塞进取证 workflow。
3. 兜底扫描 `backfillManualLeadCover(env, { date, days, limit, force })`：扫 `id LIKE 'blog:manual:%'` 且 `cover_image` 非 `/r/` 且 `published_at` 落在范围内的行，并发 3、总预算 60s，写法照 `manual-lead-enrichment.ts backfillManualLeadEnrichment`（~284-355）。
   - 管理模式 `mode=manual-lead-cover-backfill`（`handleEnrichRun`，Bearer INGEST_TOKEN）：`date`（默认今天 BJT）、`days`（1–14，默认 1）、`limit`（默认 20，≤50）、`dry=1`、`force=1`；返回 `{ scanned, set, skipped, failed, remaining, items: [{id, status, reason, cover}] }`。
   - 自动：在现有调用 `backfillManualLeadEnrichment` 的同一位置紧接着调用 `backfillManualLeadCover`（同一触发、同一日期参数），不新增 cron。

### B3 渲染层
- 不改 `render.ts`：`extra.cover_image` 为 `/r/` 形态后 daily-api / codex-push / 静态日报页三条路自然出封面。
- 不改出片面板。

### B4 测试
- `manual-lead-cover.test.ts`：og 页面；微信页面（`msg_cdn_url` + `data-src`，无 og 时）；推文（假 `fetchTweet` 回 2 张，第一张 migrate 失败第二张成功）；相对路径解析；svg/data:/黑名单跳过；`fetch` 非 HTML → `not_html`；`ensureManualLeadCover` 的幂等（已有 `/r/` 不覆盖）、次数上限、失败计数写入（假 D1 记录 SQL 与参数）。
- `manual-lead-content-workflow.test.ts`：新 step 存在、`pool` 失败时不跑、step 抛错不影响结果。
- `manual-lead-enrichment.test.ts` 风格的 `backfillManualLeadCover` 测试：并发上限与预算。

## 不改
- 取证/审计契约、签名投影、`news-source-policy.ts`、网关代码（面板机）。
- 邮件 `deliver.ts`。

## 验证
- `cd worker && npx tsc --noEmit && npm test` 全绿。
- 主 agent 之后在 prod 用 `mode=manual-lead-cover-backfill&days=14&dry=1` 看命中，再真跑，用 digest snapshot 接口核对 `raw.extra.cover_image`。

## 裁决记录
- 页面取图在 Worker 直抓（境外站可达、微信/国内站公网可达），不经大陆网关；失败只记原因，后续按失败分布再决定是否加香港路线。
- 只写 `extra.cover_image`，不写 `media`。
- 推文只用第一张能迁成功的图，不取视频封面（网关契约无视频字段）。
