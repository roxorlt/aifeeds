# xList Scraper 运维手册

> 维护目标：跨 session、跨设备、跨人都能快速搞清楚「谁在哪里跑什么」。
> 每次新增/下线服务都要同步改这个文档。

最后更新：2026-05-09（ClawHub v2：抽屉内容跟 ClawHub 网页对齐。抓取从「自己解 ZIP 挑文件」改成「调 ClawHub 自家的 `skills:getReadme` 接口」，拿到啥就翻啥，不再纠结 README.md 还是 SKILL.md。新增「可疑 skill」处理：ClawHub 自家 LLM 标记的可疑项也拉回来，存 `extra.is_suspicious`，前端默认隐藏，开关切换时加 `?include_suspicious=true`。删除 `extra.skill_md`（ZIP 流程废弃）。详见下方「ClawHub」段）

历史：2026-05-07（ClawHub v0 接入：第 4 个数据源，全云端无本地 launchd。Phase 1+2（fetchList / enrichPending）、`metrics_snapshots_clawhub` 表、`renderClawhubContent` SVG 模板、前端 `BrandClawhub` logo 都在这次落地）

历史：2026-05-06（email 验证码登录上线：Resend HTTPS API + disposable 黑名单 + MX DoH 预校验 + 100/天 + 3000/月 cap，备案前 email 是主登录路径；SMS 通道保留 + `ENABLE_SMS_LOGIN=false` flag 隐藏，备案后翻 flag 恢复双通道。详见下方「3.6. Resend Email 服务」节）

历史：2026-05-06（CF Workers Paid 升级到 $5/月：subrequest 50→1000、CPU 10ms→30s、解锁 DO/Queues。后续架构决策默认按 Paid 配额算账，详见下方「CF 计划与配额」节）

历史：2026-05-06（Turnstile widget 升级到 v3 `0x4AAAAAADJyUx6JD4IMD_1i`，prod + staging worker `TURNSTILE_SECRET_KEY` 同步换新；起因是诊断中误把 chrome-devtools-mcp 触发的 600010 当成 widget 配置 bug — **CF 600010 是 DevTools 检测机制**，普通用户访问不会触发，社区证据见 https://community.cloudflare.com/t/turnstile-errors-600010-when-devtools-is-open/733892）

历史：2026-05-06（ScrapeBadger 接入：refresh-tiered 用 batch endpoint 拿回 retweets/views，本地 chrome list-scraper 退役（launchd `.cron` + `.tune` unload，SB list-poll-ingest cron */30 接管），频率 / 成本表见 [`scrapebadger-cost-and-frequency.md`](scrapebadger-cost-and-frequency.md)）

历史：2026-05-05（PR6.6 lazy-enrich-on-drawer：新增 `POST /api/items/:id/refresh` endpoint，drawer 打开主动刷 X syndication / GitHub REST，dashboard 通过 itemUpdateBus 同步 feed 卡片）

历史：2026-05-02（PR2 auth backend：4 张表 + 5 个 endpoint + 4 层 SMS 防刷 + Turnstile + PushDeer 告警；M4 enricher daemon 全量上线 + M5 配套：`REFRESH_MODE=tiered` + `REFRESH_TIER_MAX=4` cron 走 `runRefreshTiered`；新增每天 03:35 UTC 的 `runCleanup` 清 30 天前 snapshots/refresh_log；M5 阈值校准脚本 `analyze_tier_perf.py` 已就位）

---

## 架构总览

```
┌─────────────────── 本地 MacBook ──────────────────┐     ┌───────────── Cloudflare ─────────────┐
│                                                   │     │                                      │
│  launchd.cron  (5min tick + C2 hybrid gate) — X   │     │  Worker: xlist-api                   │
│  launchd.tune  (周一 04:00 重算 params.json)      │     │                                      │
│  launchd.ph    (PT 0:30 daily) — Product Hunt     │     │    - POST /api/ingest   (接收本地)  │
│    └→ cron.sh                                     │     │    - GET  /api/items    (dashboard) │
│         ├→ list_scraper.py  (browser-use 抓 X)   │     │    - GET  /api/sources  (dashboard) │
│         ├→ tweet_processor.py (DeepSeek 分类+翻译)│─push│    - GET  /api/stats    (dashboard) │
│         └→ output.py push_to_cloud ───────────────┼────→│    - POST /api/enrich/run (手动)    │
│    └→ scrapers/ph/scraper.py (PH leaderboard)─────┼─push│    - GET  /r/<key>     (R2 反代)    │
│                                                   │     │    - scheduled() + cron */5 * * * * │
│  本地 SQLite: data/xlist.db (staging)             │     │      ├→ runBackfillQuotes           │
│  本地 R2 mirror: data/ph/pages/                   │     │      ├→ runRefreshMetrics           │
│                                                   │     │      └→ runFillTranslations         │
└───────────────────────────────────────────────────┘     │                                      │
                                                          │  D1: xlist                           │
                                                          │    items / sources / run_stats /     │
                                                          │    enrich_state / metrics_snapshots  │
                                                          │    refresh_log                       │
                                                          │  R2: xlist-readme-assets             │
                                                          │    GH README + PH logo/screenshot    │
                                                          │  Pages: xlist-dashboard              │
                                                          │    (React + Vite, 读 Worker API)     │
                                                          └──────────────────────────────────────┘
```

数据唯一真相源：**远端 D1**。本地 SQLite 只是抓取暂存，push_to_cloud 成功后可随时丢。

---

## CF 计划与配额（2026-05-06 升级 Workers Paid）

> 在评估「能不能在 worker 里多塞点活」「要不要拆 cron 槽」「能不能直接下 zip」时**默认按这套配额算账**，不要再用 Free tier 心智。

| 维度 | Workers Free（已退出） | **Workers Paid（当前，$5/月）** |
|---|---|---|
| Subrequests / invocation | 50 | **1000**（20×）|
| CPU time / invocation | 10ms | **30s**（3000×，wasm 渲染、ZIP 解压、PDF parse 等 CPU-heavy 操作不再担心 timeout）|
| Cron 频率 | 最高 1/min | 同 1/min（不变，但 invocation 限额 +∞）|
| 包含 requests | 100k/天 | 1000 万/月 |
| Durable Objects | ❌ | ✅（未来可解锁分布式协调）|
| Queues | ❌ | ✅（producer/consumer 模式拆任务） |

**架构选型默认假设**：
- `*/5` cron 单次跑可消耗 ~200-300 subreq 仍有大量余量，不需要再为「省 subreq」做拆 cron 槽这种纯配额优化（保留按业务语义拆槽，比如 backfill / refresh / translate 解耦）
- 接新源时算账模板：1 list fetch + N detail fetch + N zip/asset fetch + N×2 D1 write，N 一般 ≤ 50，安全
- batch D1 写入仍然推荐（`db.batch([...])` 一次 subreq），但目的是性能不是节流
- 新加 cron 模式不需要先精算 50 预算

**升级路径回顾**：CF Dashboard → 头像 → Plans → Workers & Pages 切到 Paid，绑卡即生效，无需重部署。

**反向降级判断**（什么时候考虑切回 Free）：流量持续 < 100k req/天 + 无 cron 业务 + 不依赖 DO/Queues。当前都不满足，长期保持 Paid。

---

## Staging 环境（2026-05-03 上线）

> 完整设计：[`docs/plans/2026-05-03-staging-environment-design.md`](plans/2026-05-03-staging-environment-design.md)
> vibe coder 教程：[`docs/dev-staging-prod-guide.html`](dev-staging-prod-guide.html)

| 资源 | Prod | Staging |
|---|---|---|
| Worker | `xlist-api` (`api.ai-feeds.com`) | `xlist-api-staging` (`staging-api.ai-feeds.com`) |
| D1 | `xlist` (`2973d54b-…`) | `xlist-staging` (`fc029d89-6871-4e5c-b653-7ed27e6fb649`) |
| KV | `AUTH_KV` (`07d666…`) | `AUTH_KV_STAGING` (`76f7a326a94c4b8685668e39a23b3fe9`, preview `f187810317a845eca4b20f6e7b357a79`) |
| R2 | `xlist-readme-assets` | `xlist-readme-assets-staging` |
| Pages | `xlist-dashboard` (`ai-feeds.com`) | `xlist-dashboard-staging` (`staging.ai-feeds.com`) |
| Cron | `*/5 * * * *` 全开 | 全关（手动触发） |
| SMS | tencent / pushdeer fallback | `pushdeer`（不发真短信） |
| Secrets | 真值 | 独立设：`INGEST_TOKEN` 新生成；`ADMIN_USER/PASS` 共用；`TURNSTILE/DEEPSEEK/GITHUB/PUSHDEER` 共用 |

**部署命令**：
```bash
# Worker
cd worker
npx wrangler deploy --env staging

# Dashboard
cd dashboard
npm run deploy:staging         # = build:staging + wrangler pages deploy
```

**手动触发 staging cron**：
```bash
curl https://staging-api.ai-feeds.com/cdn-cgi/handler/scheduled
```

**staging D1 schema 同步**（prod 改 schema 时）：
```bash
# 先在 staging 上执行 migration 文件验证
cd worker
npx wrangler d1 execute xlist-staging --env staging --remote --file=migrations/0NN-xxx.sql
# 验证后再 prod
npx wrangler d1 execute xlist --remote --file=migrations/0NN-xxx.sql
```

**Dev 默认连 staging**：`vite.config.ts` proxy 默认 target 已切到 `staging-api.ai-feeds.com`。临时连 prod：`VITE_API_PROXY=https://api.ai-feeds.com npm run dev`。

---

## 远端服务（Cloudflare）

### 1. Worker: `xlist-api`

- **源码**：`worker/src/` (index.ts + enrich.ts)
- **配置**：`worker/wrangler.toml`
- **公网地址**：
  - 自定义域：`https://api.ai-feeds.com`（dashboard 和前端用这个）
  - 默认域：`https://xlist-api.ltsms86.workers.dev`（仍可用，作为 fallback）
- **部署命令**：`cd worker && npm run deploy`

**端点清单**：

| 路径 | 方法 | 用途 | 鉴权 |
|------|------|------|------|
| `/api/ingest` | POST | 接收本地 push 的 tweets → 写 D1 items/sources | Bearer `INGEST_TOKEN` |
| `/api/items` | GET | Dashboard 列表（支持分页、filter、`sort=hot`、`source_type=github` 走 daily_rank 排序 + `pinned`） | 无（只读） |
| `/api/items/:id` | GET | 单条详情 + thread siblings（`:id` 是 composite，如 `x_list:123…` 或 `github:owner/repo`）；`source_type=github` 时附 `metrics_history`（最近 30 天 `metrics_snapshots_gh`） | 无（只读） |
| `/api/items/:id/refresh` | POST | Drawer 打开时 dashboard 主动调，触发 on-demand enrich：`x_list` 走 syndication API 拉 metrics + quote_of + link_card；`github` 走 GitHub REST 拉 stars/forks/watchers/issues/PRs/contributors。返回 `{refreshed,source_type,reason,metrics?}`，dashboard 拿到 `refreshed:true` 后重新 `fetchItem` 并 dispatch 到 feed。`product_hunt` 当前返回 `unsupported_source`（待 Browser binding）。KV `item-refresh-throttle:<id>` 60s throttle | 无（只读） |
| `/api/sources` | GET | Dashboard 左栏 source list | 无 |
| `/api/stats` | GET | Dashboard 顶部总览（总数、今日、分源） | 无 |
| `/api/enrich/run` | POST | 手动触发 enrich（支持多模式） | Bearer `INGEST_TOKEN` |
| `/api/longform/pending` | GET | 长推 fetch 队列（`?limit=20`，最多 50；`attempts < 3`） | Bearer `INGEST_TOKEN` |
| `/api/longform/submit` | POST | 提交本地浏览器抓回的完整长推正文 | Bearer `INGEST_TOKEN` |
| `/api/track` | POST | Dashboard telemetry 上报（dashboard SDK 用，必带 `X-Device-Id`） | 无（CORS 白名单 + did 必填） |
| `/api/auth/sms/send` | POST | 发送短信验证码（必带 `X-Device-Id` + Turnstile token） | 无 + 4 层防刷 |
| `/api/auth/login` | POST | 提交 phone+code 登录或自动注册（必带 `X-Device-Id`） | 无 |
| `/api/auth/logout` | POST | 撤销当前 session | session token |
| `/api/auth/logout-all` | POST | 撤销该 user 全部 session | session token |
| `/api/auth/me` | GET | 返回当前 user（含脱敏 phone） | session token |
| `/api/share/create` | POST | 生成 share token + 短链 + 海报 url（item_id 在 body） | session（cookie） |
| `/api/share/poster/:token` | GET | 海报 PNG（首次 SVG → resvg → R2 缓存；后续 R2 HIT 1.4s 内返回） | 无（CORS `*`） |
| `/s/:token` | GET | 扫码落地：写 to_did + landed_at，302 redirect 到详情页 | 无 |
| `/api/share/landing` | POST | 落地详情页前端调，补 to_did（redirect 时 cookie 可能缺 device_id） | 无（必带 X-Device-Id） |
| `/api/admin/share/:token` | GET | 看一个 token 的扫码 / 落地统计 | HTTP Basic Auth (`ADMIN_USER`/`PASS`) |
| `/img` | GET | twimg 图片反代（绕 GFW，CF 边缘缓存 7 天） | 无（host 白名单限 pbs/abs/video.twimg.com） |
| `/r/<key>` | GET | R2 资源反代（GitHub README 图 + PH logo/screenshot/video/avatar），`key` 是 SHA-256；24h 边缘缓存 | 无（R2 私有，仅 worker 暴露） |

**`/img` 图片代理**（2026-04-20 上线）：
- 前端 `dashboard/src/lib/utils.ts` 的 `proxyImg()` 统一路由 twimg 域名到此端点
- CDN 边缘缓存：`cacheTtl=86400` + `Cache-Control: max-age=604800, immutable`
- 白名单：`pbs.twimg.com` / `abs.twimg.com` / `video.twimg.com`（防被当开放代理滥用）
- 命中 GFW 封锁的 CN 用户借此恢复图片加载

**`/api/items` 热度排序**（2026-04-21 上线）：
- 加 `sort=hot` 参数时按 HN 风格重力衰减分数排序：
  `score = (likes + 2*retweets + 3*replies) / (age_hours + 2)^1.5`
  覆盖 30 天 `published_at` 窗口，老病毒推文可与新推文混排
- 返回项额外带 `hot_score` 浮点字段（仅 hot 模式）
- 游标格式 `score|id`（score 为浮点）；前端 `dashboard/src/components/Feed.tsx` 配合 localStorage 曝光过滤（500 条 LRU + 3 天 TTL）

**`/api/enrich/run` 查询参数**：
- `mode=backfill-quotes`（默认）/ `backfill-replies` / `reclassify-threads` / `refresh-metrics` / `refresh-tiered` / `fill-translations` / `detect-longform` / `cleanup`（手动跑：`?mode=cleanup&retention_days=30`）/ `clawhub-fetch` / `clawhub-enrich`（ClawHub phase 1/2 手动触发）
- `mode=backfill-replies`：回填 reply_to_id + reply_of 父推快照（用 syndication `parent` 字段，与 quote 平行）。cron 占 :05 :35 槽（2/h），历史回补主要靠本地 loop。
- `mode=reclassify-threads`：清理错分的 thread_root_id（默认 `dry_run=1` 只统计；`dry_run=0` 真执行）。一次性，等 backfill-replies 跑完再触发。
- `limit`：默认 20（backfill / refresh / tiered，1-100）；fill-translations 默认 15（1-50）；detect-longform 默认 30（1-80）
- `rate_sleep_ms=400`（backfill / refresh / tiered / detect-longform）
- `lookback_days=14`（仅 refresh-metrics，1-90）
- `max_tier=4`（仅 refresh-tiered，0-4；灰度时设 1 = 只刷 L0+L1）
- `batch_size=5`（仅 fill-translations，1-20；一次 DeepSeek 调用包多少条文本）

**定时任务**（单一 cron 内部模式轮转）：

| cron | 触发 | 调度逻辑 |
|------|------|---------|
| `*/5 * * * *` | `scheduled()` | 按触发时分分流：UTC `17:00` `05:00` → `runGithubFetchTrending`（GH phase 1）；UTC `08:00` `20:00` → `runClawhubFetchList`（ClawHub phase 1）；`:00` `:30` → `runRefreshMetrics`/`runRefreshTiered`；`:15` `:45` → `runFillTranslations`；`:10` `:50` → `runDetectLongform`（标记长推候选）；`03:35 UTC` 每天一次 → `runCleanup`（清 30 天前的 snapshots/refresh_log）；其他 → `runBackfillQuotes`。**抢占路径**（任意 tick 在分发前先查 pending 队列）：GH enrich / GH r2-migrate / GH readme-translate / PH r2-migrate / **ClawHub enrich** / X classify-pending / X fill-translations，pending 非零就走 preempt 不走 X 模式 |

**调度节奏**（2026-05-01 加入 backfill-replies）：每小时 2 次 refresh-metrics（`:00` `:30`）+ 2 次 fill-translations（`:15` `:45`）+ 2 次 detect-longform（`:10` `:50`）+ 2 次 backfill-replies（`:05` `:35`）+ 4 次 backfill-quotes（`:20 :25 :40 :55`）。每天 03:35 UTC（11:35 北京时间）抢用 1 个 backfill-replies 槽跑 cleanup。

**Product Hunt（2026-05-04 上线）**：
- **抓取在本地**：CF Browser Rendering 过不了 PH 的 turnstile（POC 实测 25s wait + 鼠标 + scroll 模拟都失败）；用 browser-use Profile 1 + 持久 session（PHSession）+ 5s pacing，10s/产品稳定通过。详见 `docs/dev-log.md`
- **Worker 端**：仅 `/api/ingest` 接收本地 push（`source_type=product_hunt`，source_id 复合键 `<slug>:<launch_date_pt>`）+ `worker/src/ph.ts` 做 R2 资源迁移（logo/screenshot/video/avatar 二进制 → SHA-256 key 写 R2，extra.media URL 改写到 `/r/<key>`）+ `/r/<key>` 反代
- **PH 数据落 D1**：items 表统一 schema，PH 专属字段全在 `items.extra` JSON：`product_slug` / `launch_date_pt` / `daily_rank` / `categories` / `pricing_type` / `is_open_source` / `makers` / `hunter` / `maker_post` / `maker_post_text` / `maker_post_translated` / `top_comments[]` / `top_reviews[]` / `ai_summary` / `ai_category` / `ph_url` / `website_url`
- **R2 迁移幂等**：`extra.r2_migrated_at` 标记已迁移；ingest 走二次 worker 内部 fetch 触发迁移，避免 push 阻塞
- **手动重抓**：见下方"本地服务 → PH leaderboard scraper"

**GitHub trending（2026-05-02 上线，迁自本地 launchd）**：
- **Phase 1 — `runGithubFetchTrending`**：每天 UTC `17:00` + `05:00`（= BJT 01:00 + 13:00），fetch trending HTML → 正则解析 ~25 条 → INSERT items 表（`is_relevant=NULL` + `extra.gh_pending=true`）+ 一行 `metrics_snapshots_gh`。**~2 subrequests/run**
- **Phase 2 — `runGithubEnrichPending`**：在每个 `*/5min` cron tick 上**抢占式**运行：先查 `extra.gh_pending=1` 的待 enrich 行，有则取 1 条做 GitHub API（license/watchers/PRs/contributors）+ raw README + DeepSeek LLM 判别 → UPDATE items（`is_relevant=0/1` + `extra.ai_category/ai_summary` 等），最后 batch 重算当日 `daily_rank`。**~9 subrequests/run**，远低于 50 限额。X 模式仅在没 pending 时走。
- **手动触发**：`POST /api/enrich/run?mode=github-fetch` / `POST /api/enrich/run?mode=github-enrich&limit=5`，都需 Bearer `INGEST_TOKEN`

**ClawHub（2026-05-09 v2，全云端 — 无本地依赖）**：
- **数据源**：`https://wry-manatee-359.convex.cloud/api/query` Convex 公开接口（无鉴权 / 无 cookie / 无 turnstile）。调用三个：
  - `skills:listPublicPageV4`：列表（query 接口）
  - `skills:getBySlug`：单个 skill 详情（query 接口）
  - `skills:getReadme`：拿 ClawHub 网页 README 标签页的内容（**action 接口**，URL 走 `/api/action`，不是 `/api/query`）。返回 `{path, text}`，path 告诉是 README.md 还是 SKILL.md
- **Phase 1 — `runClawhubFetchList`**：每天 UTC `08:00` + `20:00`（= BJT 16:00 + 04:00）。8 次 list 调用（top 1000 按 stars + top 500 按更新时间 dedup），**不再过滤可疑项**（`nonSuspiciousOnly=false`）→ upsert items（`is_relevant=1` + `extra.ch_pending=true` + `published_at=skill.updatedAt`）+ append 一行 `metrics_snapshots_clawhub`。**~10 调用/次**
- **Phase 2 — `runClawhubEnrichPending`**：每个 `*/5min` cron tick **抢占式**运行：取 `extra.ch_pending=1` 的行（按 `metrics.stars DESC` 优先），每 tick 处理 2 条。每条三件并行：
  1. **summary 翻译**（DeepSeek，跳过已是中文的）
  2. **LLM finding 翻译**（DeepSeek，跳过已 `lang=zh` 的）
  3. **`skills:getReadme`** 拿 ClawHub 渲染的 README 内容（`{path, text}`）
  - 然后 `translateMarkdown` 翻译 README 文本（**截断 5000 字符**防 DeepSeek 排队 throttle，超长部分加「完整版见 https://clawhub.ai」提示）
  - UPDATE items：`content_translated` 写翻译后 README，`extra` 写 `{license, install, capability_tags, is_suspicious, llm_verdict, llm_status, llm_analysis, readme_file, files_manifest, enriched_at, ...}`
- **可疑 skill 处理**（v2 新增）：
  - ClawHub 自家 LLM 给每个 skill 打 `verdict`（benign / suspicious / 等）和 `status`（clean / flagged 等）
  - enrichPending 把这俩字段读出来，`verdict !== 'benign' || status !== 'clean'` 视为可疑，写 `extra.is_suspicious=true`
  - `/api/items?source_type=clawhub` 默认过滤 `extra.is_suspicious=1`，前端「隐藏可疑」开关关闭时加 `?include_suspicious=true` 解除过滤
- **不接入 LLM judge**：所有 ClawHub skill 默认 `is_relevant=1`（marketplace 已是优选，跳过 X/GH/PH 那道 AI 相关性判别）
- **`/api/items?source_type=clawhub`** 走专用 `handleClawhubFeed`：按 `metrics.stars DESC` 排序 + cursor 分页（cursor 格式 `stars|id`），跟 X/PH 默认时间排序不同。支持的 query 参数：
  - `sort=stars|downloads|installs|updated|name`
  - `category=mcp-tools|prompts|workflows|dev-tools|data|security|automation|other|all`
  - `include_suspicious=true`（默认 false）
- **`/api/items/:id/refresh`** 加 clawhub 分支：drawer 打开主动调，refresh metrics 通过 `getBySlug`（KV throttle 60s）
- **手动触发**：`POST /api/enrich/run?mode=clawhub-fetch` / `POST /api/enrich/run?mode=clawhub-enrich&limit=10`，都需 Bearer `INGEST_TOKEN`
- **海报变体**：`worker/src/share/svg-template.ts` 加 `renderClawhubContent`（GH 同款骨架 + lavender 来源 chip `#d8c8f5`）+ `pickSourceMeta` 加 clawhub 分支
- **prod 数据规模**（2026-05-09）：2765 条 items，2676 条有真 README 翻译（97%），784 条标 suspicious（28%）。staging → prod 数据通过 D1 dump + INSERT OR REPLACE 复制（避免重复 DeepSeek 调用）

**ClawHub item 的 `extra` 字段速查**：

| 字段 | 类型 | 来源 | 说明 |
|------|------|------|------|
| `slug` | string | API | skill 的 url slug，跟 `source_id` 一致 |
| `latest_version` | string | API | 当前最新版本号 |
| `versions_count` | number | API | 历史版本总数 |
| `category` | string | 关键词派生 | feed 分类标签（mcp-tools / prompts 等 8 类） |
| `owner_image` | string | API | 作者头像 URL |
| `summary_en` | string | API | 英文短描述（< 200 字） |
| `summary_translated` | string | DeepSeek | summary 中文译文，feed 卡片正文用 |
| `ch_pending` | boolean | enrichPending | 是否待 enrich，false=已处理 |
| `enriched_at` | unix sec | enrichPending | 上次 enrich 时间 |
| `license` | string | API | 许可证（MIT / Apache 等） |
| `install` | array | API | 安装方式列表（claw / brew / npm 等） |
| `capability_tags` | array | API | skill 能力标签 |
| `is_suspicious` | boolean | enrichPending | ClawHub LLM 判可疑（v2 新增） |
| `llm_verdict` | string | API | ClawHub LLM 判定（benign / suspicious 等，v2 新增） |
| `llm_status` | string | API | ClawHub LLM 状态（clean / flagged 等，v2 新增） |
| `llm_analysis` | object | enrichPending | `{findings: [...], lang: 'zh'}` 翻译后的安全审查项 |
| `readme_file` | string | enrichPending | ClawHub 选了哪个文件渲染 README（README.md / SKILL.md，v2 新增） |
| `files_manifest` | array | API | skill 包含的文件列表（path + size） |
| `updated_at` | number | refresh | skill 上次更新时间（ms） |

**M4 refresh-metrics 模式切换**（2026-04-29 上线）：
- `REFRESH_MODE` env var：`legacy`（默认，runRefreshMetrics round-robin）/ `tiered`（runRefreshTiered 按 tier+velocity）/ `off`（跳过 refresh 模式槽）
- `REFRESH_TIER_MAX` env var：tiered 模式下只刷 `tier <= N` 的 item（默认 1 = 灰度只刷 L0+L1；调到 4 = 全量 L0-L4）
- 设置：`cd worker && npx wrangler secret put REFRESH_MODE`（输入 `tiered` 即开启灰度）
- 回滚：`npx wrangler secret put REFRESH_MODE` → 输入 `legacy`，无需重部署

> 2026-04-21 曾短暂调成 fill-heavy（8x/hr）清积压，实测 722 条 quote_pending 中仅 **0.3%**（1 条）是非中文，qual_ok 到 20 后彻底停滞。Backfill 才是真正的瓶颈（syndication API hydration）。

**每模式容量**：
- backfill-quotes：20 条/次 × 6 次/小时 × 24 = 2880 条/天（日增 ~100 条，绰绰有余；syndication API 才是真瓶颈）
- refresh-metrics：20 条/次 × 2 次/小时 × 24 = 960 条/天（最近 14 天的 item 轮转刷新）
- fill-translations：30 条/次 × 2 次/小时 × 24 = 1440 条/天（每条最多补 4 个字段：content + quote_of + link_card title/desc；实际翻译候选极少，多数 run 命中 tasks:0）
- detect-longform：25 条/次 × 2 次/小时 × 24 = 1200 条/天（候选 SQL 限 length 270-290 mid-word；命中 ~75% 写 `extra.longform.note_id`，等本地浏览器拉取）

**子请求预算**（CF Free 限 50/invocation）：
- backfill-quotes：~43-48（20 fetch + 20 UPDATE + overhead）
- refresh-metrics：~43-48（同上，metrics UPDATE）
- fill-translations：~30-48（1 SELECT + 3-12 DeepSeek 初翻 + 最多 3 DeepSeek 重试 + 15 UPDATE；sanity check 触发重试时吃上限）
- detect-longform：~43-48（1 SELECT + 25 syndication GET + ~17 UPDATE，命中率 ~70% 时贴上限）

**PR5 分享海报**（2026-05-05 上线）：
- **5 个 endpoint**：`/api/share/create` (POST + cookie auth)、`/api/share/poster/:token` (GET + R2 cache)、`/s/:token` (302 redirect)、`/api/share/landing` (POST + did)、`/api/admin/share/:token` (Basic Auth)
- **数据表**：`share_relations`（migration `009-share-relations.sql`，prod + staging 都已 apply）
  - 字段：token / from_uid / item_id / shared_at / to_did / to_uid / landed_at / registered_at / scan_count / last_scanned_at
  - 4 个索引：token unique / from_uid+time / item+time / to_did
- **海报渲染管线**：worker SVG 模板 (`worker/src/share/svg-template.ts`，~530 行) → resvg-wasm → PNG → R2 缓存（key: `share/poster/<token>.png` in `xlist-readme-assets` bucket）
  - 首次 cold render ~3-4s（wasm init + 渲染 + R2 put），HIT 1.4s 内返回，CDN cache `immutable`
  - 字体：Noto Sans SC Medium 子集（`worker/src/share/assets/noto-sc-medium.woff2`，1MB，覆盖 GB2312 6700+ 字 + ASCII + 标点）
  - 三变体：X / GitHub / Product Hunt，按 `source_type` 自动分发
  - 头像：worker 查 users 表拿 display_name + avatar_url，按 dashboard `defaultProfile.ts` 同款 djb2 hash 推 `/avatars/avatar-NN.png` 默认；fetch + base64 嵌入 SVG
  - 媒体图：GH = readme_excerpt 第一张非 SVG（`/r/*` 永远拉 prod，hash immutable 跨环境安全）；PH = media JSON 第一张 gallery；X = item.media 第一张 image
  - 质量门控：宽高比 > 4 || < 0.25 弃；字节密度 < 0.05 弃（避免 wordmark hero / shields / 大画布小 icon）
- **dashboard 接入**：抽屉头部右上角「分享」按钮 + ShareDialog 模态框；未登录 → openLoginModal('manual', retry=setShareOpen(true))；同 itemId 用 drawer 级 shareCache 不重复换 token；移动端调 `navigator.share({files})` 直接保存到相册，PC 走 `<a download>` 下载
- **CORS**：dashboard fetch poster_url 拿 blob 需要，已加 `Access-Control-Allow-Origin: *`
- **三环境支持**：handlers `originsFor(request)` 根据 host 推 site/api origin；staging-api → staging.ai-feeds.com / api → ai-feeds.com；不再写死 prod 域名

**翻译质量 sanity check**（2026-04-20 上线，两端一致）：
- 阈值：`length_ratio < 0.15 or > 2.0`，`CJK_ratio < 20% or >= 99.9%`
- 命中即重试 1 次；重试后仍 suspect 则保留译文 + 标 `translation_quality='suspect'`
- Worker 返回值含 `sanity_suspect / sanity_retried / items_marked_{ok,suspect}` 便于观察

### 2. D1: `xlist`

- **database_id**：`2973d54b-ca13-48e4-8d20-1430c57f5260`
- **表结构**：见 `worker/schema.sql`
- **13 个表**：
  - `items` — 所有内容的统一表（JSON extra 列装 X 专属字段：quote_of/link_card/hashtags/`enriched_at` 等；`translation_quality` TEXT + `translation_attempts` INTEGER 列标记翻译质量；2026-04-23 M3 新增 `tier` INTEGER + `next_refresh_at` INTEGER + `last_velocity` REAL + `deleted_at` INTEGER 四列，含 `idx_items_next_refresh` / `idx_items_deleted` 两个索引）
  - `sources` — 抓取源列表（list_id、cursor、last_success_at）
  - `run_stats` — 每次抓取的统计
  - `enrich_state` — cron enrich 的进度（processed_ids / failed_ids / not_found_ids）
  - `metrics_snapshots_gh` — GitHub 源专属 metrics 历史（item_id / captured_at / trending_date_str / total_stars / today_stars / forks / watchers / open_issues / open_prs；2026-05-01 加入，跟 `metrics_snapshots`（X 用，likes/retweets/replies/bookmarks/views）独立避免字段维度污染。migration: `worker/migrations/004-metrics-snapshots-gh.sql`）
  - `metrics_snapshots`（2026-04-23 M1.5 新增）— 每次 `runRefreshMetrics` 覆盖 `items.metrics` 时 append 一行 (item_id, captured_at, likes, retweets, replies, bookmarks, views)，append-only 时间序列。为 M4/M5 的 tiered 刷新策略提供真 Δlikes 数据。保留 30 天（清理机制 M5 时加）
  - `refresh_log`（2026-04-23 M3 新增）— 每次 `runRefreshTiered` 执行时 append 一行 (refreshed_at, tier, items_count, subrequests_used, duration_ms, errors)，观测 CF subrequest 配额在各 tier 的分配。保留 30 天（清理机制 M5 时加）
  - `events`（2026-05-01 PR1 新增）— Dashboard telemetry 落地点。完整产品行为上报：导航 / 内容 / 筛选 / 分享 / 登录 / 性能 / 错误。写入：`POST /api/track`（前端 SDK）。索引：`idx_events_did_time` / `idx_events_user_time` / `idx_events_type_time` / `idx_events_path_time` / `idx_events_ingested`。事件白名单：`worker/src/track.ts` `EVENT_TYPE_WHITELIST` 与 `dashboard/src/lib/telemetry/event-types.ts` 镜像（任一端新增需两边都改）。30 天 retention cron 待加（PR 后置 TODO）。完整 schema 见 `migrations/004-events-table.sql` + 设计 `docs/plans/2026-05-01-auth-system-design.md` § 3.5
  - `users`（2026-05-02 PR2 新增）— 永久身份主键。`status` 枚举 active/banned/self_deleted；nanoid 14 字符 id。详见 `docs/plans/2026-05-01-auth-system-design.md` § 3.1
  - `identities`（2026-05-02 PR2 新增）— 登录凭证多对一关联 user。`provider` 枚举 phone/wechat/email；UNIQUE(provider, identity_value, unbound_at) 保证同一凭证同时只能绑定一个 user。详见 § 3.2
  - `sessions`（2026-05-02 PR2 新增）— cookie/bearer 双兼容 token，nanoid 32 字符 id，30 天滑动过期。详见 § 3.3
  - `sms_send_log`（2026-05-02 PR2 新增）— 短信发送日志 + 防刷计数 + 验证码 hash。`result` 枚举 success/rate_limited/turnstile_failed/sms_api_error/budget_capped。30 天 retention cron 待加。详见 § 3.4
  - `share_relations`（2026-05-04 PR5 新增）— 分享关系图。`token` (nanoid 8) UNIQUE / `from_uid` 分享人 / `item_id` 复合 id / `to_did` 落地浏览器 device_id（首次扫码补） / `to_uid` 落地用户后续注册的 user.id / `landed_at` / `registered_at` / `scan_count` / `last_scanned_at`。4 索引：token / from_uid+time / item+time / to_did。社交关系图基础数据。migration `009-share-relations.sql`
  - `metrics_snapshots_clawhub`（2026-05-07 ClawHub 接入新增）— ClawHub skill metrics 历史。每次 phase 1 cron append 一行 (item_id, captured_at, stars, downloads, installs_current, installs_all_time)。30 天 retention（沿用 `runCleanup` 03:35 UTC 每天清理）。两个索引：`idx_msch_item_time` / `idx_msch_captured`。migration: `worker/migrations/011-metrics-snapshots-clawhub.sql`，prod + staging 都已 apply（prod 2026-05-08 跟 ClawHub v2 一起上线）

**关键字段语义**：
- `items.extra.enriched_at`（2026-04-20 新增）：ISO timestamp，标记该 item 已被 backfill-quotes 处理过一次（含空结果）。`selectBackfillCandidates` SQL 过滤此字段，防止已处理的 item 被反复捞起
- `items.translation_quality`（2026-04-20 新增）：null / `"ok"` / `"suspect"`。Worker `fill-translations` 每次翻译后写入，基于 length_ratio + CJK ratio sanity check
- `items.translation_attempts`（2026-04-20 新增）：翻译尝试次数，1 = 一次过，2 = sanity check 触发重试

**推 schema**：`cd worker && npm run db:init`（推远程）/ `npm run db:init:local`（本地）。

### 3. Secrets（PR2 上线必备）

```bash
cd worker

# Turnstile（CF Dashboard - Turnstile - Add widget 后给）
npx wrangler secret put TURNSTILE_SECRET_KEY

# 腾讯云 SMS V3（API V3 凭证 + 应用/签名/模板 ID）
npx wrangler secret put TENCENT_SMS_SECRET_ID         # AKID 开头 36 字符
npx wrangler secret put TENCENT_SMS_SECRET_KEY        # 32 字符
npx wrangler secret put TENCENT_SMS_SDK_APP_ID        # 短信应用 ID，1400 开头 7 位
npx wrangler secret put TENCENT_SMS_SIGN_NAME         # 已审签名，例：xList
npx wrangler secret put TENCENT_SMS_TEMPLATE_ID       # 已审模板 ID，例：1234567

# PushDeer 风控告警（xueqiuFollow admin 组：iPhone + Mac）
npx wrangler secret put PUSHDEER_ADMIN_KEYS  # 输入：PDU394...,PDU394...
```

**Kill switch**：`SMS_DAILY_CAP=0` 立刻停发短信（不动代码）。
**回滚 secret**：`wrangler secret put X` 输入新值即覆盖；删除用 `wrangler secret delete X`。

### 3.4. SMS Provider 切换（dev / staging / 冷启动期手动通道）

`worker/src/auth/sms.ts` 的 `sendSmsViaTencent` 实际是 router，按 `SMS_PROVIDER` env 切换：

| SMS_PROVIDER 值 | 行为 | 适用场景 |
|---|---|---|
| 未设置 / `tencent` | 真实腾讯云 V3 API；secret 缺失时 fallback 到 dev simulate（console.warn 明文 code） | 生产正常态 |
| `pushdeer` | 任何 phone 的验证码都推到 `PUSHDEER_ADMIN_KEYS` 的所有设备（admin 自己手机 + Mac），body 含 phone 脱敏 + 6 位 code | 腾讯云审核中、staging 阶段、朋友熟人冷启动期手动验证 |

**切到 PushDeer 通道**（腾讯云未到位时上线）：

```bash
cd worker
npx wrangler secret put SMS_PROVIDER          # 输入 pushdeer
npx wrangler secret put PUSHDEER_ADMIN_KEYS   # 输入 PDU394...,PDU394... 逗号分隔
npx wrangler secret put TURNSTILE_SECRET_KEY  # （独立的，PushDeer 模式仍走 Turnstile 防刷）
npm run deploy
```

**切回腾讯云**（审核通过后）：

```bash
cd worker
# 1. 先把 5 个 TENCENT_SMS_* secret put 进去
npx wrangler secret put TENCENT_SMS_SECRET_ID
# ... (同上其他 4 个)
# 2. 切 provider
npx wrangler secret put SMS_PROVIDER          # 输入 tencent
# 或者直接删（默认就是 tencent）
npx wrangler secret delete SMS_PROVIDER
npm run deploy
```

⚠️ **限制**：`SMS_PROVIDER=pushdeer` 是**单人 dev tool**，不能给真多用户产品用（验证码不发给用户而是发给 admin）。仅适合：
- 本地 dev / staging 测试 PR3 前端登录 UI
- 朋友熟人冷启动期手动转发（admin 收到后微信 / 截图给试用者）

### 3.5. SMS 防刷阈值（PR2 设计参考）

| Layer | 维度 | 阈值 | 修改位置 |
|-------|------|------|---------|
| L1 | CF Turnstile | managed 模式 | CF dashboard |
| L1 | CF Rate Limiting (per IP) | `/api/auth/sms/send` 5/min/IP | CF dashboard rules |
| L2 | phone 60s | ≥ 1 拒 | `worker/src/auth/sms.ts` |
| L2 | phone 5min | ≥ 3 拒 | 同上 |
| L2 | phone 24h | ≥ 10 拒 | 同上 |
| L2 | ip 1h unique phones | ≥ 10 拒 | 同上 |
| L2 | ip 24h total | ≥ 30 拒 | 同上 |
| L2 | device 24h unique phones | ≥ 5 拒 | 同上 |
| L3 | 全局每日 cap | 200 条 | `SMS_DAILY_CAP` env |
| L4 | 验证码错码锁 | 5 次错 → 30 min 锁 | `worker/src/auth/sms.ts` MAX_ATTEMPTS_BEFORE_LOCK / LOCK_DURATION_MS |

### 3.6. Resend Email 服务（2026-05-06 上线，备案前主登录路径）

**用途**：登录验证码邮件发送。绕过 ICP 备案（SMS / 一键登录 / 微信 connect 都依赖备案，Resend 不依赖），国内外通吃。

**API key**：通过 `wrangler secret put` 配置，名 `RESEND_API_KEY`，prod + staging 各一份。
- **永远不要**写到 git tracked 文件
- 旋转：Resend Dashboard → API Keys → Revoke 旧 key → Create new → `cd worker && npx wrangler secret put RESEND_API_KEY`（staging 加 `--env staging`）

**免费档限额**：100 封/天 + 3000 封/月（双重限制，超限服务直接 503）。

**告警阈值（PushDeer，复用现有 admin 通道）**：

| 阈值 | 级别 | 触发动作 |
|---|---|---|
| 当日 ≥ 80 / 95 | warn / urgent | 「今日 email 已发 N/100」 |
| 当日 ≥ 100 | critical | 服务返 503 + 告警 |
| 当月 ≥ 2400 / 2850 | warn / urgent | 「本月 email 已发 N/3000」 |
| 当月 ≥ 3000 | critical | 服务返 503 + 告警 |
| 风控严重命中（24h / locked / ip_24h_total） | info | `worker/src/auth/email-handlers.ts` |
| 一次性邮箱 / MX 失败 | 仅落 `email_send_log`，不告警（噪音太大） | — |

告警去重：同阈值同日 / 同月只发一次（KV `email_alert_<scope>_<level>_<date>`）。

**发件域**：`mail.ai-feeds.com`（子域，独立 reputation；marketing 邮件未来在主域不会拖累 transactional 信誉）。

**DNS 记录（CF DNS 加 4 条 TXT/MX；Resend 后台 Domains 页面给出具体值）**：
- `mail.ai-feeds.com` TXT — SPF
- `resend._domainkey.mail.ai-feeds.com` TXT — DKIM
- `_dmarc.mail.ai-feeds.com` TXT — DMARC
- `feedback.mail.ai-feeds.com` MX — return-path

**配置 secret**：

```bash
cd worker

# Resend HTTPS API key（在 Resend Dashboard - API Keys 创建）
npx wrangler secret put RESEND_API_KEY                # prod
npx wrangler secret put RESEND_API_KEY --env staging  # staging（可与 prod 同 key 或独立）

# Turnstile + PushDeer 已存在（沿用 SMS 时的同一组）
```

**Kill switch**：
- `EMAIL_DAILY_CAP=0` 立刻停发（不动代码）
- `ENABLE_EMAIL_LOGIN=false` 紧急关闭整个 email 通道（503）

**Email auth 多维度防刷**（PR-EmailAuth 设计参考）：

| Layer | 维度 | 阈值 | 修改位置 |
|---|---|---|---|
| L0 | Turnstile | managed 模式（与 SMS 共用 widget） | CF dashboard |
| L1 | 一次性邮箱黑名单 | npm `disposable-email-domains` 包 ~12 万域名 | `worker/src/auth/email-validation.ts` |
| L1 | MX 预校验 | CF DoH 查询，KV 缓存 24h | 同上 |
| L2 | email 60s | ≥ 1 拒 | `worker/src/auth/email-rate-limit.ts` |
| L2 | email 5min | ≥ 3 拒 | 同上 |
| L2 | email 24h | ≥ 10 拒 | 同上 |
| L2 | ip 1h unique emails | ≥ 10 拒 | 同上 |
| L2 | ip 24h total | ≥ 30 拒 | 同上 |
| L2 | device 24h unique emails | ≥ 5 拒 | 同上 |
| L3 | 全局每日 cap | 100 条（Resend free） | `EMAIL_DAILY_CAP` env |
| L3 | 全局每月 cap | 3000 条（Resend free） | `EMAIL_MONTHLY_CAP` env |
| L4 | 验证码错码锁 | 5 次错 → 30 min 锁 | `worker/src/auth/email-rate-limit.ts` |

**Feature flags**（备案完成后翻）：
- `ENABLE_SMS_LOGIN`（worker env）：备案前 = `false`（关闭 SMS 通道，前端 LoginModal 走 email-only）；备案后 = `true` → 重做双 tab UI（届时另起 PR）
- `ENABLE_EMAIL_LOGIN`（worker env）：默认 `true`，紧急关闭设 `false`
- `VITE_AUTH_CHANNEL`（dashboard env）：备案前 = `email`，备案后 = `sms+email` → 触发新 LoginModal UI

**完整设计文档**：[`docs/plans/2026-05-06-email-auth-design.md`](plans/2026-05-06-email-auth-design.md)

### 5. Pages: `xlist-dashboard`

- **公网地址**：
  - 自定义域：`https://ai-feeds.com` / `https://www.ai-feeds.com`（主入口）
  - 默认域：`https://xlist-dashboard.pages.dev`（仍可用）
- **源码**：`dashboard/`
- **API base**：`dashboard/src/api.ts` 默认指向 `https://api.ai-feeds.com`（可用 `VITE_API_BASE` 覆盖）
- **部署命令**：`cd dashboard && npm run build && npx wrangler pages deploy dist --project-name=xlist-dashboard`

### 6. 自定义域名与 DNS

域名：`ai-feeds.com`（CF 注册 + 托管）

| 记录类型 | Name | Target | Proxy | 作用 |
|----------|------|--------|-------|------|
| CNAME | `ai-feeds.com`（@） | `xlist-dashboard.pages.dev` | ✅ Proxied | 主站 |
| CNAME | `www` | `xlist-dashboard.pages.dev` | ✅ Proxied | www 别名 |
| Worker Route | `api.ai-feeds.com` | Worker `xlist-api` | ✅ Proxied | API 子域 |

**DNS proxy 必须全开橙云**（CF WAF / 缓存 / DDoS 保护依赖此）。

### 7. CF 安全配置

**已开启项**：
- **SSL/TLS** 模式：Full (strict)
- **Bot Fight Mode**：On（Free tier 自带，拦截简单爬虫）
- **Security Level**：Medium
- **HTTP DDoS Managed Ruleset**：默认开启（L7 DDoS 防护）
- **L3/L4 DDoS 防护**：CF 默认开启（不可关）

**Rate Limiting**（Free tier 限 1 条）：
- 路径 `/api/*`（或 `api.ai-feeds.com/api/*`），10 秒内 30 请求触发 Block
- 原 limit=10 太紧，dashboard 初次加载并发 3 个接口容易误伤，已调至 30

**Custom Rules**（Free tier 限 5 条）：
- **Block bad bots**：UA 含 `MJ12bot|AhrefsBot|SemrushBot|DotBot`（SEO 分析爬虫，不是搜索引擎）→ Block
- 已验证不影响 SEO：Googlebot / Bingbot / Baiduspider / YandexBot 不在此名单

**可选加固**（未配置，见本项目 TODO）：
- 第一优先级加一条 Skip 规则：`cf.verified_bot_category in {"Search Engine Crawler"}` → Skip all rules，保证搜索引擎 100% 不被误杀

### 8. CF 账户其他项目（非本项目）

- Pages: `yt-dubbing-privacy` — 另一个项目，别误删

---

## 本地服务（MacBook）

### 1. launchd: `com.xlist-scraper.cron`（**已停用 2026-05-06**）

> **状态**：`launchctl unload` 已执行，被 worker 端 ScrapeBadger list-poll-ingest cron 取代。
> plist 文件保留作 fallback；如 SB 服务出问题可 `launchctl load` 临时恢复。
> ScrapeBadger 频率 / 月成本对照见 [`docs/scrapebadger-cost-and-frequency.md`](scrapebadger-cost-and-frequency.md)。
> 关联 `.tune`（schedule 自动调参）也已 unload，没了 `.cron` 它没意义。
>
> 还在跑的：`.longform`（处理 D1 里既存的截断推文 backlog；SB 接管后新推文直返 full_text 不需要它，但旧 item 还得它兜底）。

- **plist**：`~/Library/LaunchAgents/com.xlist-scraper.cron.plist`
- **脚本**：`~/.claude/skills/xlist-scraper/scripts/cron.sh`
- **频率**：每 5 分钟 tick（`StartInterval=300`），实际是否抓由 `schedule.py` 动态决定（见下方）
- **日志**：
  - `data/launchd-stdout.log` / `data/launchd-stderr.log`（launchd 原始输出）
  - `data/cron.log`（cron.sh 自己记的结构化日志）
- **行为**：
  1. cookie 过期检查（< 30 天弹窗提醒）
  2. 前置检查：网络（curl x.com）、电量（<20% 且未充电跳过）
  3. **动态调度 gate**：读 `data/.next-scrape-at`，未到时间则 `[SKIP:SCHED]` 退出
  4. 锁文件防重入（`data/scraper.lock`）
  5. 跑 `main.py <list_id>` → list_scraper + tweet_processor + output.push_to_cloud → `schedule.schedule_next` 写下次时间

### 1a. 动态抓取频率（`schedule.py`）

- **源码**：`~/.claude/skills/xlist-scraper/scripts/schedule.py`
- **策略**：C2 hybrid（按 prior 阈值切分热/冷）
  - **hot zone**（prior ≥ 0.15 tweets/min，约对应 BJT 20-02 + 中午的美国峰）：固定 **20min**，保证新鲜度
  - **cold zone**（prior < 0.15，约对应 BJT 13-18 的亚洲白天）：`target_new=10` 动态，blend prior + recent，上限 60min
- **回溯模拟结果**（14d train + 14d sim, 1892 tweets，参见 `scripts/simulate_schedules.py`）：
  - 之前 Fixed 30min：672 runs, 20.7% zero-yield, p95 发现延迟 29min
  - 切到 C2 hybrid：490 runs (**-27%**), 11.8% zero-yield, p95 发现延迟 56min
  - hot 时段 p50 延迟 15m → ≤10m；cold 时段被拉长到 20-60m 换成本节省
- **算法**：
  - prior：过去 30 天同 (BJT 星期, 小时) 的 tweets/分钟
  - recent（仅 cold zone 用）：最近 3 个 run_stats 区间的 new_count/分钟
  - cold zone: blended = 0.5 × prior + 0.5 × recent；interval = target_new / blended，clamp 到 [min, max]
  - hot zone: 跳过 recent，直接固定 hot_interval_sec
- **输出**：写 Unix 时间戳到 `data/.next-scrape-at`
- **触发**：每次 `main.py` 成功跑完在 `finally` 后调 `schedule_next(list_id)`
- **参数来源**：`data/schedule_params.json`（由 `tune_schedule.py` 每周覆写，见 1b）。文件不存在或损坏时回退到 `schedule.py` 顶部 `DEFAULT_PARAMS`（threshold=0.15 / hot=1200s / target=10 / min=600 / max=3600）
- **手动预览**：`XLIST_DATA_DIR=/Users/roxor/brain/30-projects/xlist-scraper python3 ~/.claude/skills/xlist-scraper/scripts/schedule.py <list_id>`

### 1b. 周度自动调参（`tune_schedule.py`）

- **源码**：`~/.claude/skills/xlist-scraper/scripts/tune_schedule.py`
- **plist**：`~/Library/LaunchAgents/com.xlist-scraper.tune.plist`
- **频率**：每周一 04:00 BJT（冷时段，避开 scrape）
- **目标**：根据最近 14 天的 tweets 重新计算 `hot_prior_threshold` / `hot_interval_sec` / `target_new`
- **算法**：
  - `hot_prior_threshold` = 过去 14 天 (weekday, hour) prior 分布的 60 分位（只算非零格）
  - `hot_interval_sec` = target_new / hot 格 prior 中位数 × 60s，clamp 到 [10min, 30min]
  - `target_new` 固定 10（后续可改 cost-aware）
- **三道护栏**：
  1. **最小数据量**：最近 14 天 tweets < 500 → 整体 skip，用 `DEFAULT_PARAMS` / 继承上次
  2. **变化率限制**：新 `hot_interval_sec` 相对当前不能变化超过 ±30%，超出按 30% 硬 clamp
  3. **Dry-run 拒绝**：对最近 7 天做 `simulate_schedules.py` 同款回溯，若新参数在 `runs` / `zero_rate` / `p95_delay_min` 任一项比当前参数差 >20% → 拒绝更新（保留旧参数）
- **审计日志**：每次运行（ACCEPT / REJECT / SKIP）追加一条到 `data/schedule_params_log.md`
- **日志**：`data/launchd-tune-stdout.log` / `data/launchd-tune-stderr.log`
- **手动触发**：
  - `launchctl start com.xlist-scraper.tune`（按线上路径跑，落盘）
  - `XLIST_DATA_DIR=... python3 scripts/tune_schedule.py --dry-run`（只预览不写盘）
- **回滚**：删除 `data/schedule_params.json` 即可回到硬编码 defaults。不改代码、不重启 launchd

### 1d. launchd: `com.aifeeds.ph-scraper`（PH leaderboard，2026-05-04 上线）

- **plist**：`launchd/com.aifeeds.ph-scraper.plist`（项目内，部署时 symlink 到 `~/Library/LaunchAgents/`）
- **wrapper**：`scrapers/ph/cron.sh`（PRE/POST PID diff 兜底 kill-by-data-dir，跟 X scraper 同一套防 Chrome 孤儿 pattern）
- **频率**：BJT 16:30 起跑（plist `Hour=16 Minute=30`）。⚠️ launchd 不支持时区，用 BJT 时间硬编码——PDT 期间对应 PT 00:30 / UTC 07:30，PST（冬令时）期间会比 PT 0:30 早一个钟，要手动把 plist Hour 改成 17 重 load
- **抓什么**：PT 前一天的 leaderboard URL `/leaderboard/daily/Y/M/D` → 全榜 ~21 条产品（默认排序，PH bot UA 给的是 LLM-friendly markdown 格式，scraper 双格式兼容）
- **pipeline 单产品**：navigate → JSON-LD parse → DOM extract（top-level threads only / single-handle review root）→ DeepSeek judge（is_ai + ai_category + ai_summary）→ DeepSeek translate（仅 is_ai=1）→ `sync.push_to_d1`
- **限速**：单 PHSession 跑全榜，5s/产品 pace；rank 14+ 偶有 turnstile 失败（"Starting agent..."），用下面的补抓脚本兜底
- **日志**：`data/logs/ph-cron-YYYYMMDD.log`（cron.sh，按天分文件）+ stdout/stderr → launchd 默认 std 输出（plist 没显式定向，看 `~/Library/Logs/com.aifeeds.ph-scraper.*` 或追溯到 cron.sh 自记日志）
- **手动触发**：
  - 整天：`~/.browser-use-env/bin/python3 -m scrapers.ph.scraper --leaderboard YYYY-MM-DD --push --log-level INFO`
  - 特定 slug（应对 turnstile 漏抓）：`~/.browser-use-env/bin/python3 -m scripts.rescrape_ph_slugs --date YYYY-MM-DD --slugs slug1,slug2,slug3 --pace-sec 15`
- **退役**：`launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.aifeeds.ph-scraper.plist`

### 1c. ~~launchd: `com.aifeeds.github-scraper`~~（已退役，迁移到 CF 端）

> **已迁移到 CF Worker**（2026-05-02）。本地 launchd plist 已 unload；
> 项目里 `launchd/com.aifeeds.github-scraper.plist`、`scrapers/github/*.py`、
> `scrapers/_lib/*.py` 保留作历史参考但不再调度。新的远端实现见
> "CF Worker → 1.1 GitHub trending phase 1/2 cron" 章节。

- **退役命令**（用户已执行）：
  ```bash
  launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.aifeeds.github-scraper.plist
  rm ~/Library/LaunchAgents/com.aifeeds.github-scraper.plist  # 可选
  ```



| 脚本 | 用途 | 现状 |
|------|------|------|
| `list_scraper.py` | 抓 X List（browser-use + cookies） | cron 每 30 min 自动调 |
| `tweet_processor.py` | DeepSeek 分类 + 翻译 | cron 自动调 |
| `output.py` | 导出 markdown + push_to_cloud | cron 自动调 |
| `enrich_from_syndication.py` | 补 quote_of / link_card / metrics / 翻译 | **正在被迁到 Worker cron，本地版 deprecate 中** |
| `reclassify_affected.py` | 改完 prompt 后重新跑分类 | 按需手动 |
| `cleanup_translations.py` | 修复历史翻译（黑名单扫全库） | 按需手动 |
| `sync_reclassified_to_cloud.py` | 本地 reclassify 后补推到 D1 | 按需手动 |
| `balance_check.py` | 查 DeepSeek 余额 | 按需手动 |
| `enrich_longform.py` | 长推 fetch（browser-use 抓完整正文 → POST Worker /api/longform/submit） | 按需手动；推荐每周/有积压时跑 `--limit 50` 排空 pending |
| `backfill_cloud.py` / `backfill_quote_of.py` / `backfill.py` | 历史遗留 backfill | 已基本弃用 |

### 3. 本地数据目录

```
/Users/roxor/brain/30-projects/xlist-scraper/data/
├── xlist.db                本地 SQLite（staging）
├── pages/                  分页抓取临时缓存（崩溃恢复）
├── ph/pages/               PH 抓取的产品页 HTML 快照（每个 product 一个，崩溃时复跑解析；定期人工清理）
├── logs/ph-cron-*.log      PH scraper cron.sh 按天结构化日志
├── ph-rescrape-*.log       手动整榜 / 单 slug 重抓的日志
├── enrich_state/*.json     本地 enrich 进度（Worker 化后将废弃）
├── scraper.lock            cron 锁文件
├── cookie-warn-stamp       cookie 过期警告节流
├── cron.log / launchd-*    日志
├── .next-scrape-at         下一次抓取 Unix 时间戳（schedule.py 写，cron.sh 读）
├── schedule_params.json    tune_schedule.py 每周覆写的动态参数（不存在则用 DEFAULT_PARAMS）
├── schedule_params_log.md  调参审计日志（每次 ACCEPT/REJECT/SKIP 追加一行）
└── exports/YYYY-MM-DD-*.md 每次抓取导出的 markdown
```

---

## Secrets 和配置

| Secret | 存在哪里 | 用途 |
|--------|----------|------|
| `INGEST_TOKEN` | CF Worker secret（`wrangler secret list` 可查） | 保护 /api/ingest 和 /api/enrich/run |
| `DEEPSEEK_API_KEY` | 本地 `~/.claude/skills/xlist-scraper/scripts/.env` + CF Worker secret（两端同一把 key） | 本地：分类 + 翻译；Worker：fill-translations 翻译。**模型选型**见 [`CLAUDE.md` § DeepSeek 模型选型](../CLAUDE.md)：默认 `deepseek-v4-flash`，复杂推理用 `deepseek-v4-pro`，文档 https://api-docs.deepseek.com/zh-cn/ |
| x.com cookies | Chrome Default profile → cookie_manager.py 解密 | 抓取登录态 |

**设置 Worker secret**：`cd worker && npx wrangler secret put INGEST_TOKEN`

**安全注入 key 到 Worker**（避免 key 出现在终端历史/AI context）：
```bash
cd worker
grep -m1 '^DEEPSEEK_API_KEY=' ~/.claude/skills/xlist-scraper/scripts/.env | cut -d= -f2- | npx wrangler secret put DEEPSEEK_API_KEY
```

**本地开发 Worker**：`worker/.dev.vars`（gitignored），格式 `KEY=value`，每行一对。需要包含 `INGEST_TOKEN` + `DEEPSEEK_API_KEY`（后者可用同样的 pipe 注入：`echo "DEEPSEEK_API_KEY=$(grep -m1 '^DEEPSEEK_API_KEY=' ~/.claude/skills/xlist-scraper/scripts/.env | cut -d= -f2-)" >> .dev.vars`）。

### Cloudflare 运维 token（跨 session 共享）

**位置**：项目根 `.secrets/cf-ops.env`（已 gitignored，路径见 `.gitignore` `.secrets/` 一行）

**内容**：
- `CF_OPS_API_TOKEN` — account-owned master token，权限是「创建 account-owned 子 token」（**自身不带任何资源 Read / Write 权限**，连 list zones 都返回空）
- `CF_ACCOUNT_ID` — CF account ID
- `CF_ZONE_ID` — 默认 zone（当前指向 `ai-feeds.com`，zone ID `e7982a660d8def7a2ce5ec60f28282fc`）；如新增 zone 再补 `CF_ZONE_<NAME>` 变量
- `CF_ZONE_AIFEEDS_COM` — `ai-feeds.com` 的具体 zone ID（覆盖所有子域 staging-api / api / www / staging / blog / mail）

**用途**：让 Claude Code session 跨对话延续 CF 运维能力。session 用 master token 现场创建一个「最小权限 + 短 TTL」的子 token 去做实际操作（看 zone settings、列 WAF rules、查 Turnstile widgets、推 secret、改 DNS 等），避免长期暴露高权限 token。

**典型用法**（Bash）：

```bash
source .secrets/cf-ops.env

# Step 1: 查 permission group ID（一次性，可缓存到下方表里）
curl -sS "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/tokens/permission_groups" \
  -H "Authorization: Bearer $CF_OPS_API_TOKEN" | jq '.result[] | select(.name | test("(?i)bot|zone|waf"))'

# Step 2: 写 policy JSON 文件（注意 resource 写法见下方规则）
EXPIRES=$(date -u -v+24H +"%Y-%m-%dT%H:%M:%SZ")
cat > /tmp/cf-subtoken.json <<EOF
{
  "name": "ops-readonly-$(date +%s)",
  "policies": [
    {
      "effect": "allow",
      "permission_groups": [
        {"id": "c8fed203ed3043cba015a93ad1616f1f"},
        {"id": "517b21aee92c4d89936c976ba6e4be55"}
      ],
      "resources": {"com.cloudflare.api.account.zone.${CF_ZONE_ID}": "*"}
    }
  ],
  "expires_on": "${EXPIRES}"
}
EOF

# Step 3: 创建子 token
SUB_TOKEN=$(curl -sS -X POST "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/tokens" \
  -H "Authorization: Bearer $CF_OPS_API_TOKEN" -H "Content-Type: application/json" \
  --data @/tmp/cf-subtoken.json | jq -r '.result.value')
echo "$SUB_TOKEN" > /tmp/cf-sub.token && chmod 600 /tmp/cf-sub.token

# Step 4: 用子 token 干活（示例：查 zone settings）
curl -sS "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/bot_management" \
  -H "Authorization: Bearer $SUB_TOKEN" | jq
```

**⚠️ 创建子 token 的 resource 写法（踩坑笔记，2026-05-07）**：

account-owned token 创建子 token 时，resource 字段对每种 scope 有不同写法。**写错就报 1001 error**：

| scope | 错误写法 ❌ | 正确写法 ✅ |
|---|---|---|
| Account-scoped permission group（如 `Account Analytics Read`） | — | `"com.cloudflare.api.account.${CF_ACCOUNT_ID}": "*"` |
| Zone-scoped permission group（如 `Zone Read`、`Bot Management Read`） | `"com.cloudflare.api.account.zone.*": "*"`（报 "must specify a zone for account owned tokens"）<br/>`"com.cloudflare.api.account.${CF_ACCOUNT_ID}.zone.*": "*"`（报 "is not a supported resource type"） | `"com.cloudflare.api.account.zone.${ZONE_ID}": "*"`（必须 nest 到具体 zone ID，不能通配） |
| 同一个 policy 混合不同 scope | — | 不行。混合 scope 需写**两个独立 policies**，每个 policies 只放 scope 一致的 permission_groups |

完整多 scope 模板见上面 Step 2 JSON 里的 `policies` 数组结构。

**已知 permission group ID**（用过的，免去重新查）：

| 名称 | ID | scope |
|---|---|---|
| Account Analytics Read | `b89a480218d04ceb98b4fe57ca29dc1f` | account |
| Zone Read | `c8fed203ed3043cba015a93ad1616f1f` | zone |
| Zone Settings Read | `517b21aee92c4d89936c976ba6e4be55` | zone |
| Zone WAF Read | `dbc512b354774852af2b5a5f4ba3d470` | zone |
| Zone Settings Write | `3030687196b94b638145a3953da2b699` | zone |
| Zone WAF Write | `fb6778dc191143babbfaa57993f1d275` | zone |
| Bot Management Read | `07bea2220b2343fa9fae15656c0d8e88` | zone |
| Bot Management Write | `3b94c49258ec4573b06d51d99b6416c0` | zone |
| Analytics Read | `9c88f9c5bce24ce7af9a958ba9c504db` | zone |
| Firewall Services Read | `4ec32dfcb35641c5bb32d5ef1ab963b4` | zone |
| Firewall Services Write | `43137f8d07884d3198dc0ee77ca6e79b` | zone |
| Turnstile Sites Read | `5d78fd7895974fd0bdbbbb079482721b` | account |
| Turnstile Sites Write | `755c05aa014b4f9ab263aa80b8167bd8` | account |

**常用 endpoint 速查**（用 Step 4 的子 token）：

```bash
# 看 3 个 SEO/GEO 关键开关一次性
curl -sS "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/settings/security_level" -H "Authorization: Bearer $SUB_TOKEN" | jq '.result.value'      # under_attack 模式开关
curl -sS "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/bot_management" -H "Authorization: Bearer $SUB_TOKEN" | jq '.result'                    # fight_mode + ai_bots_protection
curl -sS "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/rulesets/phases/http_request_firewall_custom/entrypoint" -H "Authorization: Bearer $SUB_TOKEN" | jq '.result.rules[] | {description, action, enabled}'  # WAF custom rules

# Analytics 流量数据（GraphQL）
SINCE=$(date -u -v-23H +"%Y-%m-%dT%H:%M:%SZ")  # ⚠️ 免费版 zone Adaptive 时间窗严格 < 24h，安全用 23h
curl -sS https://api.cloudflare.com/client/v4/graphql -H "Authorization: Bearer $SUB_TOKEN" -H "Content-Type: application/json" \
  --data "{\"query\":\"query { viewer { zones(filter: {zoneTag: \\\"$CF_ZONE_ID\\\"}) { httpRequestsAdaptiveGroups(limit: 30, orderBy: [count_DESC], filter: {datetime_geq: \\\"$SINCE\\\", verifiedBotCategory_neq: \\\"\\\"}) { count dimensions { clientRequestHTTPHost verifiedBotCategory } } } } }\"}" | jq

# 1d Groups（最长 30 天）— 看每日总请求 / 缓存 / 威胁
curl -sS https://api.cloudflare.com/client/v4/graphql -H "Authorization: Bearer $SUB_TOKEN" -H "Content-Type: application/json" \
  --data "{\"query\":\"query { viewer { zones(filter: {zoneTag: \\\"$CF_ZONE_ID\\\"}) { httpRequests1dGroups(limit: 30, orderBy: [date_DESC]) { dimensions { date } sum { requests cachedRequests threats pageViews } uniq { uniques } } } } }\"}" | jq
```

**免费版 Plan 已知限制**（计入查询时考虑）：
- `httpRequestsAdaptiveGroups` 单次查询时间窗严格小于 24h（用 23h 安全）
- `botScore`、`botScoreSrc` 等高级字段无访问权限（authz 错误）
- Page Rules endpoint **不接受 account-owned token**（报 1011），只能用 user-owned token 看
- Bot Fight Mode（基础版）不能被 WAF custom rule `skip` action bypass（这是 BFM 自身限制，与 token 权限无关）

**轮换 / 撤销**：
- 怀疑泄露：CF Dashboard → 头像 → My Profile → API Tokens → 找到 token → Roll（生成新值）或 Delete
- Roll 后把新值覆盖写回 `.secrets/cf-ops.env`
- master token 本身权限低（只能创建子 token），泄露风险有限，但**仍建议每 6-12 个月主动 roll 一次**

**安全约定**：
- ❌ 不要在对话中明文重复贴 token（log 里会留痕）
- ❌ 不要写到 `wrangler.toml` / 任何 git-tracked 文件
- ❌ 子 token 一律带 `expires_on`，不要做永久 token
- ✅ 操作完成后子 token 自动过期，不需要手动撤

---

## 健康检查

### 远端状态

```bash
# 看 D1 总数 + 今日入库量
curl -s https://api.ai-feeds.com/api/stats | jq

# 抽查翻译质量（随机 20 条）
npx wrangler d1 execute xlist --remote --command="SELECT source_id, SUBSTR(content, 1, 80) AS content, SUBSTR(content_translated, 1, 80) AS translated, translation_quality FROM items WHERE is_relevant=1 AND content_translated IS NOT NULL ORDER BY RANDOM() LIMIT 20;"

# 看最近的 enrich 进度
cd worker && npx wrangler d1 execute xlist --remote \
  --command="SELECT mode, length(state), updated_at FROM enrich_state;"

# 实时看 Worker 日志（cron 触发、错误）
cd worker && npx wrangler tail
```

### 本地 launchd 状态

```bash
# 是否在跑
launchctl list | grep xlist-scraper

# 看最近的 cron 日志（最后 30 行）
tail -30 /Users/roxor/brain/30-projects/xlist-scraper/data/cron.log

# 看原始 stdout/stderr
tail -50 /Users/roxor/brain/30-projects/xlist-scraper/data/launchd-stderr.log
```

---

## 常见运维操作

### 部署更新

```bash
# Worker
cd worker && npm run deploy

# Dashboard（前端）
cd dashboard && npm run build && npx wrangler pages deploy dist --project-name=xlist-dashboard

# D1 schema 变更
cd worker && npm run db:init        # 推远程
cd worker && npm run db:init:local  # 推本地（wrangler dev 用）
```

### 停启本地 cron

```bash
# 暂停（不再触发，但不删除 plist）
launchctl unload ~/Library/LaunchAgents/com.xlist-scraper.cron.plist

# 恢复
launchctl load ~/Library/LaunchAgents/com.xlist-scraper.cron.plist

# 立刻手动跑一次（绕过 launchd）
bash ~/.claude/skills/xlist-scraper/scripts/cron.sh
```

### 手动触发 enrich

```bash
# 远端 Worker 跑 1 批（默认 limit=20）
curl -s -X POST "https://api.ai-feeds.com/api/enrich/run?limit=20" \
  -H "Authorization: Bearer $INGEST_TOKEN" | jq
```

### 查进程 / kill 挂在后台的脚本

```bash
# 所有 xlist 相关 python 进程
ps auxww | grep -iE '(list_scraper|tweet_processor|enrich_from_syndication)' | grep -v grep

# kill
kill <PID>
```

---

## 跨 session 维护指引

**每次新增/下线服务必须改这个文档**，至少更新：

1. 「架构总览」里的 ASCII 图
2. 对应章节（远端 / 本地 / Secrets）的清单
3. 「最后更新」日期

**每次 session 开始检查**：

1. 读本文档了解当前 stack
2. 读 `docs/TODO.md` 了解待办
3. 跑一下「健康检查」命令确认 stack 健在

**变更分类**：

- **新增 Worker / cron / secret** → 必改本文档
- **改 endpoint 逻辑** → 可以不改（代码里有）
- **改部署频率 / limit** → 建议改（容易遗忘）
- **添加新的本地 python 脚本** → 如果是 cron 调的，必改；按需手动的，看心情
