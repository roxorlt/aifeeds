# xList Scraper TODO

项目长期改进事项跟踪。完成的条目打 `[x]` 但保留，用于回溯决策。

---

## 改进 3：enrich daemon（已全量迁到 CF Worker）

**状态**（2026-04-18 更新）：✅ 全部迁完。三个模式（backfill-quotes / refresh-metrics / fill-translations）均 deploy 到 CF Worker，`*/5` cron 内部按分钟分流。本地 `enrich_from_syndication.py` 只保留给 reclassify_affected 等特殊流程。

**最新方案**：
- 调度：CF Worker `scheduled()` + `crons = ["*/5 * * * *"]`，每 5 分钟触发一次
- 运行：`runBackfillQuotes(env, limit=20)` 默认每轮处理 20 条候选，subrequest 预算 ~43/50（Free 计划限 50，留 retry buffer）
- 候选 SQL：`source_type='x_list' AND is_relevant=1 AND (extra IS NULL OR (extra NOT LIKE '%"quote_of"%' AND extra NOT LIKE '%"link_card"%'))`
- 状态管理：D1 `enrich_state` 表（新增），替代原 `data/enrich_state/*.json`
- 手动触发：`POST /api/enrich/run` endpoint（Bearer `INGEST_TOKEN`）用于 smoke / ad-hoc backfill
- 监控：`wrangler tail` 看日志；后续可接 cc2im observability 模板

**已完成**：
- [x] 迁移方案设计 + TS 实现（`worker/src/enrich.ts`）
- [x] schema.sql 新增 `enrich_state` 表
- [x] `worker/src/index.ts` 加 `scheduled` handler + `POST /api/enrich/run`
- [x] `worker/wrangler.toml` 加 cron trigger
- [x] 本地 `wrangler dev` smoke：auth ✅、empty-state ✅、真 tweet_id 端到端 fetch + patch ✅、idempotency ✅、state 持久化 ✅
- [x] D1 remote `npm run db:init` 已跑（新增 enrich_state 表）
- [x] **deploy worker 成功**（2026-04-17）—— URL `https://xlist-api.ltsms86.workers.dev`、cron `*/5 * * * *` 已激活；prod `/api/stats` 返回 27927 items、`/api/enrich/run` 鉴权生效
- [x] kill 本地 `enrich_from_syndication.py --mode backfill-quotes` 进程（PID 88400）

**待做**：
- [ ] 观察三模式 cron 运行 24-48 小时后核对积压清理速度（backfill 3840/day、refresh 960/day、fill-translations 720/day）
- [ ] 通过 `wrangler tail` 抽查 cron 日志，确认无异常（subrequest 限额、超时、DeepSeek 错误、D1 错误）
- [x] **扩展模式 refresh-metrics**（2026-04-17 上线，分钟 :00 :30 触发，默认 limit=20，lookback_days=14）
- [x] **扩展模式 fill-translations**（2026-04-18 上线，分钟 :15 :45 触发，默认 limit=15，batch_size=5；DEEPSEEK_API_KEY 已注入 Worker secret，本地 key 复用）
- [x] **本地 `enrich_from_syndication.py` deprecate**（2026-04-20 头部注释标 DEPRECATED，三模式均已由 Worker 全量接管；脚本保留仅供 `reclassify_affected.py` 复用）
- [x] **cron 异常排查 + 修复**（2026-04-20）—— backfill-quotes 观察到 `processed=0 remaining_hint=0` 但 DB 14221 pending。根因：syndication 返回空的 item（既无 quote 也无 link_card）被记到 `state.processed_ids` 内存集合永久，但 `extra` 里没落标记，SQL 下一轮又会捞起来。修复：`applyPatch` 每次对 extra 写 `enriched_at: <ISO>`，`selectBackfillCandidates` SQL 加 `extra NOT LIKE '%"enriched_at"%'` 过滤。旧 716 条 processed_ids 会在一次被重新过一遍后拿到 enriched_at 标记，从此永久排除。

**前置依赖**（历史保留）：
- [x] 改进 1（WAL mode）
- [x] 改进 2（thread_root_id 校准）
- [x] 改进 4（cron 抓取后自动补 quote + card + 翻译）

---

## 改进 5：Thread 双向展开抓取（2026-04-17 已实现，运行中）

**状态**：✅ 已实现并在 prod 运行。cron 日志已观察到效果。

**实现位置**：`list_scraper.py`
- `_detect_thread_candidates()` L596：从主抓取结果里识别 thread 候选
- `_expand_thread(handle, tweet_id, list_id)` L641：打开 status 页 + 抓同作者 reply 链

**候选识别信号（3 路）**：
1. **Self-reply**：`reply_to_id` 存在且目标作者是本人 → 回复目标可能是 thread root
2. **DOM indicator**：DOM 有 "Show this thread" / 显示此话题 / thread 连接线
3. **quote_of_id**：引用其他作者的推文时，被引用的可能是某个 thread 成员

**展开流程**：
1. 打开 `x.com/{handle}/status/{tweet_id}` 页面（复用 browser-use session 和 cookie）
2. `time.sleep(8)` 等页面加载
3. JS 提取页面所有 tweet article
4. 过滤同作者的 tweet（`author_handle == author`），少于 2 条视为非 thread
5. 按 `int(tweet_id)`（snowflake 单调）排序，取首条为 `thread_root_id`
6. 所有 thread 成员打上 `thread_root_id`，返回加入 `all_tweets`

**实测运行日志（2026-04-17 19:22 cron）**：
```
Detected 22 thread candidates, expanding...
Thread expanded: @AndrewCurran_ thread with 7 tweets
Thread expanded: @claudeai thread with 5 tweets
Thread expanded: @dotey thread with 2 tweets
Thread expanded: @GergelyOrosz thread with 7 tweets
Thread expanded: @theo: only 1 tweet, not a self-thread（正确拒绝）
```

**Pipeline 集成**（thread 成员走完整路径）：
- `scrape_list` 返回含 thread 成员的 `all_tweets`
- `save_to_db` 入库（主键 `tweet_id` 去重）
- `process_tweets` classify + translate
- `save_processed` 更新 `is_ai`
- `_enrich_new_relevant`（改进 4）补齐 quote_of + link_card + 翻译

**待补充的小问题**：
1. [x] **`max_thread_len` 上限未设** —— 2026-04-17 已加 `THREAD_MAX_LEN=30` 截断保险。
2. [x] **向下翻页滚动缺失** —— 2026-04-17 已补。`_expand_thread` 现在改为 scroll-and-accumulate 循环：每轮 `_bu_eval_js()` 拿当前 DOM tweets → 合并进 `seen` dict（X 虚拟滚动会把视窗外的 article 从 DOM 里 drop，必须跨轮累积）→ `window.scrollTo(0, document.body.scrollHeight)` + `sleep 3` → 下一轮。停止条件：hit `THREAD_MAX_LEN=30`、`THREAD_STABLE_ROUNDS=2` 连续无新、或 `THREAD_MAX_SCROLLS=12`。日志多输出 `scroll_rounds=N` 字段便于观察。下次 cron 跑出来看日志验证。
3. [x] **去重未显式 SELECT**（2026-04-20 加防御层）—— scraper 侧 `all_tweets` dict 已按 `tweet_id` 天然去重，但 downstream pipeline 加两层防御：
   - `tweet_processor.process_tweets` 入口按 `tweet_id` dedup 再交给 filter/translate
   - `main.py` 在 `existing_ids` 过滤后加显式 `{tweet_id: t}` dedup
   - 日志在检测到重复时打印 `Deduped N duplicate tweet_ids`
   - list_scraper.py L920-925 的 thread 合并逻辑已经是 "main-feed 优先，只补 thread_root_id"，无需改动

第 3 条已收尾。

---

## 改进 6：媒体存储架构（R2 + 分层 TTL）

**状态**：设计阶段。

**目标**：
解决 `pbs.twimg.com` 图片在国内被墙的问题（前端讨论第 4 点），同时把 X 原生视频也纳入自建 CDN。

**架构**：
- **存储**：Cloudflare R2（$0.015/GB·月，**出站流量免费**，是 R2 最大优势）
- **预算**：$10/月 → 约 500GB 可用容量
- **访问**：Cloudflare Worker 做 URL 重写：`pbs.twimg.com/media/X.jpg` → `{r2-domain}/media/X.jpg`
- **回源策略**：首次请求时 Worker 回源 X CDN 抓取 + 写 R2 + 返回给用户；后续请求直出 R2

**容量估算（X 推文媒体）**：
- 图片平均 400KB/张，X 原生视频平均 8MB/条（最长 10min ≤50MB）
- AI 相关推文 ~30% 带图、~5% 带视频
- 日均 200 条 AI 相关 → 日媒体量 ~150MB → **月 4.5GB**
- 500GB 够用 **~100 个月（8 年）**，长期视角下不紧张

**分层 TTL（R2 Lifecycle 规则自动执行）**：
| 类型 | 保留期 | 理由 |
|------|-------|------|
| 图片 | 365 天 | 成本低，浏览价值长 |
| X 原生视频 | 90 天 | 视频吃存储大头，冷数据接受回源失败 |
| 文本/metadata | 永久 | 几乎零成本 |

**价值保留白名单（不受 TTL 影响）**：
- likes > 1000 的推文媒体永久保留
- 被其他关注用户 quote 过的推文媒体永久保留
- 用户手动标记"重要"的推文（如果未来加此功能）

**归档后行为**：
- 删 R2 对象 + DB 把 `media` JSON 里的 URL 改回 `pbs.twimg.com` 原链
- 国内用户访问 90 天外冷数据图/视频会失败（可接受，属于"旧内容 degrade"）
- 日志记录归档动作，可事后反查

**不纳入 R2 的媒体**：
- YouTube 视频本体 —— 不下载，前端嵌 YouTube iframe
- 播客音频 —— 不托管，前端直接播源 URL
- 详见改进 7

**与 Cloudflare Images 对比**：
- CF Images：$5/月含 10 万张图 + 自动优化/resize，图片场景更省心
- 缺点：不支持视频
- 决策：**统一用 R2 + Worker 做 resize**，避免图/视频两套存储逻辑

---

## 改进 7：多源聚合看板数据源规划（2026-04-17 讨论）

**状态**：产品架构备忘。不属于 xlist-scraper 内部改造，但需同步规划，避免后续数据模型冲突。

**定位**：AI 信息聚合看板（类 techurls.com）由 **N 个独立平行的数据源**拼出。每个数据源有自己的订阅载体、自己的 scraper、自己的 cron、自己的展示栏位 —— 数据源之间**不互为上下游**。

| # | 数据源 | 订阅载体 | 抓取方式 | 媒体存储 |
|---|--------|---------|---------|---------|
| 1 | **X / Twitter List** | X 用户 List | xlist-scraper（当前项目，V1） | R2（图 + X 原生视频） |
| 2 | **YouTube AI 访谈/视频播客** | YouTube 频道 / 播放列表 | 独立 youtube-scraper（待建） | 不存视频本体；存 transcript + thumbnail + metadata |
| 3 | **小宇宙播客** | 小宇宙订阅 / 节目列表 | 独立 podcast-scraper（待建） | 不托管音频，前端直接播源 URL |
| 4 | **snipd highlight** | snipd 收藏列表 | snipd API / RSS（待建） | 同上，只存 metadata |
| 5 | **GitHub 热门 AI 项目** | GitHub Trending / Star 榜单 | 独立 github-scraper（待建） | 存 README + stars 变化曲线 |
| 6 | **Product Hunt AI 产品** | PH AI 类目每日榜 | PH API（待建） | 存产品 metadata + 截图缩略图 |
| 7 | **arXiv AI 论文** | arXiv 分类订阅 | 复用 brain 的 read-arxiv-paper | 存 PDF + 解析结果 |
| 8 | **公众号 / 博客 / 新闻** | 订阅源列表 | 复用 brain 的 baoyu-url-to-markdown | 存 markdown 正文 |

**路线图**：
- **V1（当前阶段）**：先把 xlist 这一条通路跑完整 —— 抓取、分类、翻译、存储、前端看板、媒体 CDN、归档 TTL —— 形成可复用的架构范式
- **V2 之后**：按上表逐个接入独立数据源，每个源复用 V1 建立的通用能力（DeepSeek 分类 / 翻译、R2 存储、看板栏位、归档 TTL 等）

**关键原则**：
- **不互为下游**：xlist 里 AI 大 V 转发的 YouTube 视频 / GitHub 项目 / PH 产品，只存 link_card metadata，**不**做二次深度抓取。深度内容由对应的独立 scraper 订阅它自己的 list 去抓，避免重复工作和数据归属混乱
- **独立隔离**：每个源独立 cron、独立 DB 表（或同库分 schema / 分区），任一源故障不影响其他源
- **看板按源分栏**：前端每个源独立栏位，用户可按源筛选 / 折叠

**音频 / 长视频不托管的理由**（适用源 2、3、4）：
- YouTube 长访谈（Dwarkesh Patel、Latent Space、No Priors 等，1-2h 常见，AI 深度访谈尤其长）：视频体积大（几百 MB-GB），iframe 嵌入即可，YouTube 自己的 CDN 够用；国内遇墙时做 iframe 代理或跳原站，**不**做内容缓存
- 播客音频（单集 30-70MB）：小宇宙 feed URL 国内可直连；海外源（Lex Fridman 等）遇墙再单独处理 proxy

**存储压力分布**：
- R2 500GB 预算主要由 xlist 消耗（月增 ~4.5GB，可撑 8 年）
- 其他源（transcript、metadata、markdown 正文）加起来不足 xlist 的 10%
- 长期视角下存储压力集中在 X 原生媒体，其他源几乎零存储压力

改进 6 的 TTL + 白名单随 xlist 上线一并实现，形成卫生习惯；即便其他源后续接入也能直接复用同一归档策略。

---

## 改进 8：翻译质量门控（2026-04-17 发现）

**状态**：prompt 已修复，存量清洗已完成（2026-04-17），后处理黑词表已上线（2026-04-17）。

**背景**：
用户反馈 `x.com/doodlestein/status/2009060649071239677` 的译文把 "fork codex" 翻成"分叉 codex"。`fork` 作为技术动词应保留英文。检查 `tweet_processor.py:translate_batch` 的 prompt 只说"保留专有名词"，没明确技术动词（fork / merge / fine-tune / deploy / rebase 等）不要翻译，导致 DeepSeek 硬翻。

**已做（prompt 扩展 + 黑词表校准）**：
- 规则 2：列出保留英文的技术术语（fork / branch / merge / rebase / commit / PR / repo / clone / push / pull / deploy / pretrain / RLHF / prompt / embedding / RAG / LLM / API / SDK / CLI / IDE / CI/CD / OSS / MCP）
- 规则 3：中文 AI 圈约定（基于 DB 样本实际观察校准）：
  - `fine-tune` → **"微调"**（业界通用译法，**不算错翻**）
  - `agent` → **"智能体"**（NOT "代理"，"代理"在中文里是 proxy/中介的意思）
  - `token` → 保留 `token` / `Token`（NEVER "令牌"，"令牌"是 OAuth 的 Token 概念）
  - `fork` 作动词 → 保留 `fork`（NOT "分叉"）
  - `PR` → 保留 `PR`（NOT "拉取请求" / "合并请求"）
- 规则 4：保留代码 / 命令 / 路径 / URL / @handle 原样
- 规则 5：保留常见英文缩写（UI / UX / MVP / SaaS / B2B / OSS）
- 规则 6：口语化译文

**存量清洗目标（DB 实测命中数，2026-04-17）**：
| 黑词 | 命中数 | 定性 | 处理 |
|------|-------|------|------|
| 分叉 | 14 | 确定错翻（fork） | 重翻 |
| 拉取请求 | 20 | 确定错翻（PR） | 重翻 |
| 合并请求 | 2 | 确定错翻（PR / merge） | 重翻 |
| 令牌 | 121 | AI 语境下基本全错翻（token） | 重翻 |
| 代理 | 375 | 需语境筛选（AI agent 应为"智能体"，其他语境如 HTTP proxy 保留） | 过滤后重翻 |
| 微调 | 64 | **非错翻**，业界通用译法 | 跳过 |
| 克隆仓库 | 0 | —— | —— |
| 分支化 | 0 | —— | —— |
| 嵌入向量 | 0 | —— | —— |

估算清洗量：**~500 条**（分叉+拉取请求+合并请求+令牌 = 157 必清洗；代理 375 里筛 AI 语境约 50-70%，~200 条；上限 ~357 条，算上筛查漏检留 buffer ~500）

**待做**：

1. [x] **存量清洗脚本**（2026-04-17 已完成）：
   - 脚本：`cleanup_translations.py`（带 `--dry-run` / `--limit` / `--skip-agent` flags）
   - 命中语境关键词：`agent` / `agents` / `ai` / `llm` / `mcp` / `autonomous` / `claude` / `gpt` / `openai` / `anthropic` / `gemini` / `codex` / `cursor` / `tool use` / `browser use` / `workflow` / `agentic`
   - 连接加 `timeout=60.0` + `PRAGMA busy_timeout=60000`，和 backfill daemon 并发安全
   - 本次实际清洗：**517 条**（156 simple + 361 agent-context），**100% 成功更新**
   - 清洗前后黑词命中数（DB 抽样）：
     | 黑词 | 清洗前 | 清洗后 | 降幅 | 残留定性 |
     |------|-------|-------|------|---------|
     | 分叉 | 14 | 0 | 100% | —— |
     | 拉取请求 | 20 | 0 | 100% | —— |
     | 合并请求 | 2 | 0 | 100% | —— |
     | 令牌 | 121 | 1 | 99% | 残留为 OAuth access token 合法用法 |
     | 代理 | 375 | 11 | 97% | 残留为 代理商/proxy server/user agent/3D 纹理代理 等合法用法，少量 AI agent 漏网 |
   - 实际成本：DeepSeek chat ~¥0.1（估算与预算一致）

2. [x] **后处理黑词表**（2026-04-17 已完成）：
   - `tweet_processor.py` 加 `_blacklist_hit(original, translated)`：简单黑词（分叉/拉取请求/合并请求）即命即判；上下文黑词（代理/令牌）需原文含 AI 语境且不含 benign 关键词（OAuth/JWT/HTTP proxy/User-Agent 等）
   - 核心循环抽到 `_run_translation_batch`，`translate_batch` 包装：主翻译 → post-check 命中 → 清空译文重试 1 次（最多 1 次，避免死循环）
   - 日志输出命中统计（`blacklist post-check: N/M hit (分叉:X, 令牌(AI):Y) — retrying once`）及重试后仍 suspect 的条目
   - smoke test 覆盖 10 个 case（命中/正确/benign），100% 预期行为
   - 不改 DB schema，暂不持久化 `translation_quality`，等质量 sanity check / review 队列一起上时再统一扩 schema

3. [x] **质量 sanity check**（2026-04-20 上线）：
   - 阈值基于 prod D1 500-sample 校准（p5 length_ratio=0.08, p25=0.31, p50=0.38; CJK p50=0.71）
   - **长度比 < 0.15 或 > 2.0** → 标记 suspect（原方案 0.3 会误伤 20.6% 正常翻译，中文本来就比英文紧凑）
   - **CJK 占比 < 20% 或 >= 99.9%** → 可能漏翻或丢失技术术语
   - 两端一致实现：`tweet_processor.py` 的 `_sanity_hit` + `_post_check` 统一 blacklist + sanity，Worker `enrich.ts` 的 `sanityHit` 在 `runFillTranslations` 里跑相同逻辑
   - 命中 → 清空译文重试一次（不死循环）；重试后仍 suspect → 保留现有译文 + 写 `translation_quality='suspect'`
   - 命中统计通过 `TranslateResult.sanity_suspect / sanity_retried / items_marked_{ok,suspect}` 暴露到 `/api/enrich/run` 返回值

4. **抽样 review 队列**：每批随机 5% 写入 `translation_review` 表，供人工 / LLM-as-judge 定期抽查，反馈到 prompt 迭代

5. [x] **DB schema 扩展**（2026-04-20 上线）：`items` 表新增 `translation_quality TEXT`（null / ok / suspect）和 `translation_attempts INTEGER DEFAULT 0`，remote + local D1 已 ALTER，`schema.sql` 同步。Worker `fill-translations` 每次 translate 都写这两个列。

**触发条件**：
- [x] 存量清洗：2026-04-17 已完成
- [x] 后处理黑词表：2026-04-17 已上线
- [x] 质量 sanity check + schema 扩展：2026-04-20 上线
- 抽样 review 队列：翻译模块稳定一段时间后再做

**前置**：
- [x] prompt 扩展已落地（2026-04-17）
- [x] 黑词表基于 DB 样本校准（2026-04-17，"微调"被证实非错翻，"令牌"/"代理"被证实为错翻新入表）
- [x] 存量清洗脚本 `cleanup_translations.py` 落地（2026-04-17）
- [x] `translate_batch` 后处理黑词 + 自动重译（2026-04-17，双保险：新翻译即时校验 + cleanup 脚本走同一通路）
- [x] sanity check 阈值基于历史数据校准（2026-04-20，长度比 0.3 证实过于激进已改 0.15；CJK 20% / 99.9% 证实合理）

---

## 前端讨论项（2026-04-17 沟通记录）

1. [x] **右上角"8 小时前"位置的复用** —— ✅ 2026-04-17 已删。`Feed.tsx` 移除 header 右上 `timeAgo(lastUpdated)`，只在加载中且无数据时显示"加载中"。
2. [x] **流内孤立 thread 碎片** —— 2026-04-17 双侧修复：
   - scraper 根因修复见**改进 5** 待补问题 1/2（加 `THREAD_MAX_LEN=30` 截断 + 补 `scroll-and-accumulate` 循环，解决长 thread 被截断）。下一轮 cron 起生效。
   - 前端加一层保险：`Feed.tsx` 对 `row.kind === "single"` 一律传 `hideThreadBanner`，避免孤立 thread 碎片仍亮 🧵。
3. [x] **卡片点击跳出到 x.com** —— 2026-04-17 V1 抽屉已实现。新增 `src/lib/drawer.tsx` (Context + Provider)、`src/components/TweetDrawer.tsx`（右侧滑入面板 + ESC/外部点击/×关闭）。点击卡片 → 抽屉展示完整 TweetCard + 若为 thread 则顺序展示所有 siblings。抽屉头部保留 `↗` 链接跳 x.com，兼容老习惯。未使用 `react-tweet` 依赖（我们自己的数据已等同 syndication API 输出）。V2 待办：thread siblings 远程拉取（当前只用当前 feed 中的 siblings）、quote tweet 点击再开子抽屉、嵌入 syndication fallback。
4. **图片 URL 直连 pbs.twimg.com** —— 方案见**改进 6**（R2 + Worker 重写 + 分层 TTL）。
5. [x] **非 thread 推文误展示 thread icon** —— 与第 2 点同源，已一起修复。
6. [x] **数据源 icon 应使用各平台官方 logo** —— ✅ 2026-04-17 已换。`icons.tsx` 新增 `BrandX / BrandYouTube / BrandGitHub / BrandProductHunt / BrandArxiv / BrandPodcast` 和 `SourceIcon` 分发组件，路径全部来自 Simple Icons（CC0）。`App.tsx` 移除 emoji 字段，Feed header 通过 `SourceIcon source_type={...}` 渲染。GitHub = Octocat，PH = 带胡须的猫 P，arXiv = 官方 χ glyph（初版曾拼错几何，已用 Simple Icons 原始 path 覆盖），Podcast = Apple Podcasts（紫色底+麦克风，作为跨平台公认代表）。
