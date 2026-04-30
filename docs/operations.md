# xList Scraper 运维手册

> 维护目标：跨 session、跨设备、跨人都能快速搞清楚「谁在哪里跑什么」。
> 每次新增/下线服务都要同步改这个文档。

最后更新：2026-04-29（M4 enricher daemon 全量上线 + M5 配套：`REFRESH_MODE=tiered` + `REFRESH_TIER_MAX=4` cron 走 `runRefreshTiered`；新增每天 03:35 UTC 的 `runCleanup` 清 30 天前 snapshots/refresh_log；M5 阈值校准脚本 `analyze_tier_perf.py` 已就位）

---

## 架构总览

```
┌─────────────────── 本地 MacBook ──────────────────┐     ┌───────────── Cloudflare ─────────────┐
│                                                   │     │                                      │
│  launchd.cron  (5min tick + C2 hybrid gate)       │     │  Worker: xlist-api                   │
│  launchd.tune  (周一 04:00 重算 params.json)      │     │                                      │
│    └→ cron.sh                                     │     │    - POST /api/ingest   (接收本地)  │
│         ├→ list_scraper.py  (browser-use 抓 X)   │     │    - GET  /api/items    (dashboard) │
│         ├→ tweet_processor.py (DeepSeek 分类+翻译)│─push│    - GET  /api/sources  (dashboard) │
│         └→ output.py push_to_cloud ───────────────┼────→│    - GET  /api/stats    (dashboard) │
│                                                   │     │    - POST /api/enrich/run (手动)    │
│  本地 SQLite: data/xlist.db (staging)             │     │    - scheduled() + cron */5 * * * * │
│                                                   │     │      ├→ runBackfillQuotes           │
│                                                   │     │      ├→ runRefreshMetrics           │
│                                                   │     │      └→ runFillTranslations         │
└───────────────────────────────────────────────────┘     │                                      │
                                                          │  D1: xlist                           │
                                                          │    items / sources / run_stats /     │
                                                          │    enrich_state / metrics_snapshots  │
                                                          │    refresh_log                       │
                                                          │  Pages: xlist-dashboard              │
                                                          │    (React + Vite, 读 Worker API)     │
                                                          └──────────────────────────────────────┘
```

数据唯一真相源：**远端 D1**。本地 SQLite 只是抓取暂存，push_to_cloud 成功后可随时丢。

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
| `/api/items` | GET | Dashboard 列表（支持分页、filter、`sort=hot`） | 无（只读） |
| `/api/items/:id` | GET | 单条详情 + thread siblings（`:id` 是 composite，如 `x_list:123…`） | 无（只读） |
| `/api/sources` | GET | Dashboard 左栏 source list | 无 |
| `/api/stats` | GET | Dashboard 顶部总览（总数、今日、分源） | 无 |
| `/api/enrich/run` | POST | 手动触发 enrich（支持多模式） | Bearer `INGEST_TOKEN` |
| `/api/longform/pending` | GET | 长推 fetch 队列（`?limit=20`，最多 50；`attempts < 3`） | Bearer `INGEST_TOKEN` |
| `/api/longform/submit` | POST | 提交本地浏览器抓回的完整长推正文 | Bearer `INGEST_TOKEN` |
| `/img` | GET | twimg 图片反代（绕 GFW，CF 边缘缓存 7 天） | 无（host 白名单限 pbs/abs/video.twimg.com） |

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
- `mode=backfill-quotes`（默认）/ `refresh-metrics` / `refresh-tiered` / `fill-translations` / `detect-longform` / `cleanup`（手动跑：`?mode=cleanup&retention_days=30`）
- `limit`：默认 20（backfill / refresh / tiered，1-100）；fill-translations 默认 15（1-50）；detect-longform 默认 30（1-80）
- `rate_sleep_ms=400`（backfill / refresh / tiered / detect-longform）
- `lookback_days=14`（仅 refresh-metrics，1-90）
- `max_tier=4`（仅 refresh-tiered，0-4；灰度时设 1 = 只刷 L0+L1）
- `batch_size=5`（仅 fill-translations，1-20；一次 DeepSeek 调用包多少条文本）

**定时任务**（单一 cron 内部模式轮转）：

| cron | 触发 | 调度逻辑 |
|------|------|---------|
| `*/5 * * * *` | `scheduled()` | 按触发分钟数分流：`:00` `:30` → `runRefreshMetrics`/`runRefreshTiered`；`:15` `:45` → `runFillTranslations`；`:10` `:50` → `runDetectLongform`（标记长推候选）；`03:35 UTC` 每天一次 → `runCleanup`（清 30 天前的 snapshots/refresh_log）；其他 → `runBackfillQuotes` |

**调度节奏**（2026-04-29 加入 detect-longform）：每小时 2 次 refresh-metrics（`:00` `:30`）+ 2 次 fill-translations（`:15` `:45`）+ 2 次 detect-longform（`:10` `:50`）+ 6 次 backfill-quotes（`:05 :20 :25 :35 :40 :55`）。每天 03:35 UTC（11:35 北京时间）抢用 1 个 backfill 槽跑 cleanup。

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

**翻译质量 sanity check**（2026-04-20 上线，两端一致）：
- 阈值：`length_ratio < 0.15 or > 2.0`，`CJK_ratio < 20% or >= 99.9%`
- 命中即重试 1 次；重试后仍 suspect 则保留译文 + 标 `translation_quality='suspect'`
- Worker 返回值含 `sanity_suspect / sanity_retried / items_marked_{ok,suspect}` 便于观察

### 2. D1: `xlist`

- **database_id**：`2973d54b-ca13-48e4-8d20-1430c57f5260`
- **表结构**：见 `worker/schema.sql`
- **6 个表**：
  - `items` — 所有内容的统一表（JSON extra 列装 X 专属字段：quote_of/link_card/hashtags/`enriched_at` 等；`translation_quality` TEXT + `translation_attempts` INTEGER 列标记翻译质量；2026-04-23 M3 新增 `tier` INTEGER + `next_refresh_at` INTEGER + `last_velocity` REAL + `deleted_at` INTEGER 四列，含 `idx_items_next_refresh` / `idx_items_deleted` 两个索引）
  - `sources` — 抓取源列表（list_id、cursor、last_success_at）
  - `run_stats` — 每次抓取的统计
  - `enrich_state` — cron enrich 的进度（processed_ids / failed_ids / not_found_ids）
  - `metrics_snapshots`（2026-04-23 M1.5 新增）— 每次 `runRefreshMetrics` 覆盖 `items.metrics` 时 append 一行 (item_id, captured_at, likes, retweets, replies, bookmarks, views)，append-only 时间序列。为 M4/M5 的 tiered 刷新策略提供真 Δlikes 数据。保留 30 天（清理机制 M5 时加）
  - `refresh_log`（2026-04-23 M3 新增）— 每次 `runRefreshTiered` 执行时 append 一行 (refreshed_at, tier, items_count, subrequests_used, duration_ms, errors)，观测 CF subrequest 配额在各 tier 的分配。保留 30 天（清理机制 M5 时加）

**关键字段语义**：
- `items.extra.enriched_at`（2026-04-20 新增）：ISO timestamp，标记该 item 已被 backfill-quotes 处理过一次（含空结果）。`selectBackfillCandidates` SQL 过滤此字段，防止已处理的 item 被反复捞起
- `items.translation_quality`（2026-04-20 新增）：null / `"ok"` / `"suspect"`。Worker `fill-translations` 每次翻译后写入，基于 length_ratio + CJK ratio sanity check
- `items.translation_attempts`（2026-04-20 新增）：翻译尝试次数，1 = 一次过，2 = sanity check 触发重试

**推 schema**：`cd worker && npm run db:init`（推远程）/ `npm run db:init:local`（本地）。

### 3. Pages: `xlist-dashboard`

- **公网地址**：
  - 自定义域：`https://ai-feeds.com` / `https://www.ai-feeds.com`（主入口）
  - 默认域：`https://xlist-dashboard.pages.dev`（仍可用）
- **源码**：`dashboard/`
- **API base**：`dashboard/src/api.ts` 默认指向 `https://api.ai-feeds.com`（可用 `VITE_API_BASE` 覆盖）
- **部署命令**：`cd dashboard && npm run build && npx wrangler pages deploy dist --project-name=xlist-dashboard`

### 4. 自定义域名与 DNS

域名：`ai-feeds.com`（CF 注册 + 托管）

| 记录类型 | Name | Target | Proxy | 作用 |
|----------|------|--------|-------|------|
| CNAME | `ai-feeds.com`（@） | `xlist-dashboard.pages.dev` | ✅ Proxied | 主站 |
| CNAME | `www` | `xlist-dashboard.pages.dev` | ✅ Proxied | www 别名 |
| Worker Route | `api.ai-feeds.com` | Worker `xlist-api` | ✅ Proxied | API 子域 |

**DNS proxy 必须全开橙云**（CF WAF / 缓存 / DDoS 保护依赖此）。

### 5. CF 安全配置

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

### 6. CF 账户其他项目（非本项目）

- Pages: `yt-dubbing-privacy` — 另一个项目，别误删

---

## 本地服务（MacBook）

### 1. launchd: `com.xlist-scraper.cron`

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

### 2. 手动脚本（不在 cron 里）

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
| `DEEPSEEK_API_KEY` | 本地 `~/.claude/skills/xlist-scraper/scripts/.env` + CF Worker secret（两端同一把 key） | 本地：分类 + 翻译；Worker：fill-translations 翻译 |
| x.com cookies | Chrome Default profile → cookie_manager.py 解密 | 抓取登录态 |

**设置 Worker secret**：`cd worker && npx wrangler secret put INGEST_TOKEN`

**安全注入 key 到 Worker**（避免 key 出现在终端历史/AI context）：
```bash
cd worker
grep -m1 '^DEEPSEEK_API_KEY=' ~/.claude/skills/xlist-scraper/scripts/.env | cut -d= -f2- | npx wrangler secret put DEEPSEEK_API_KEY
```

**本地开发 Worker**：`worker/.dev.vars`（gitignored），格式 `KEY=value`，每行一对。需要包含 `INGEST_TOKEN` + `DEEPSEEK_API_KEY`（后者可用同样的 pipe 注入：`echo "DEEPSEEK_API_KEY=$(grep -m1 '^DEEPSEEK_API_KEY=' ~/.claude/skills/xlist-scraper/scripts/.env | cut -d= -f2-)" >> .dev.vars`）。

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
