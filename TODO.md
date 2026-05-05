# xList TODO

## 进行中
- [ ] enricher daemon: L0-L5 分层 metrics 刷新，按热度衰减调度
- [ ] **PR-B 对话上下文数据修复**（2026-05-01 启动）：branch `fix/conversation-context-data`，worker 已部署。
  - 本地 loop 跑全表 36k 的 `backfill-replies`（cron `:05 :35` 兜底增量）
  - 完成后跑 `reclassify-threads dry_run=0` 清错分（dry-run 显示 5398/6442 待清）
  - 验证 case：t1=2048759762414674337 / t2=2048753722432360677 / Eric Cursor 3 root
  - 触发 reclassify 真执行前要 `wrangler d1 export` 备份
- [ ] **PR-C 对话上下文 UI**：detail 页祖先链 + 强插 dedup（无 banner）+ on-demand 拉缺失祖先

## 待做

> **下一阶段 Roadmap（2026-05-03 调整）**
>
> 1. ~~**PR4 强制登录拦截**~~ ✅ 2026-05-03 上线
> 2. ~~**staging 环境落地**~~ ✅ 2026-05-03 上线（[操作记录](docs/operations.md#staging-环境-2026-05-03-上线)）
> 3. ~~**PR5 分享功能**~~ ✅ 2026-05-05 上线 — 5 endpoint + share_relations 表 + Noto SC 字体子集 + resvg-wasm + R2 海报缓存 + dashboard 抽屉分享按钮 + 三变体（X/GH/PH）SVG 模板 + 媒体图质量门控（aspect/density 双闸）+ 移动端 navigator.share 直存相册。**未完成 P2**：landing 回流（点过来的人 to_did/to_uid 回填）；三态分发 UI（PC 已有，移动端微信内提示待完善）。已 ship MVP，迭代留 PR6
> 4. **PR6 上线加固 + dashboard / 海报数据增强** — landing 回流（PR5 P2）+ `feat/lazy-enrich-on-drawer`（抽屉打开主动 enrich + 落库）+ **PR5 分享海报试用反馈跟进**（GH commit 数据落库 + 抽屉展示 / GH feed 卡片正文 4 行 / PH 卡片改造 4.1-4.4 / PH 抽屉 5.1-5.2 / 视频封面预抓帧落库下方详）+ 限流参数调优 / admin 看板增强 / 数据备份 launchd / 异常告警分级
> 5. **PR7 收藏 + newsletter** — `favorites` 表 + UI；newsletter = **邮件订阅**（每日/每周摘要发用户邮箱），需新增：user.email 字段 / 模板系统 / Resend 或 Cloudflare Email Workers 发送 / 退订 link / 反垃圾合规
> 6. 之后：`/admin/analytics` 数据看板、dark mode、enricher daemon 调度优化

- [x] 前置 1: Dashboard URL routing — 已合 main（PR-A + PR-B），待部署 dashboard：
  - Worker `GET /api/items/:id`（单条 + thread siblings）已上线
  - 前端 `/t/:id` 路由 + drawer URL 同步 + seed-history（冷启动深链后退键回首页）
  - `/thread/:id` 砍掉，YAGNI（thread 由 /t/:id 自然展开）
  - 设计文档：`docs/plans/2026-04-30-dashboard-url-routing-design.md`
- [ ] **前置 2 + 3 合并：账号系统 + telemetry SDK**（共拆 6 个 PR，按依赖串联）
  - 完整设计：[`docs/plans/2026-05-01-auth-system-design.md`](docs/plans/2026-05-01-auth-system-design.md)
  - 决策要点：手机号短信登录（个人主体起步，企业主体后置）+ Session 不走 JWT + LocalStorage device_id（合规优先）+ Turnstile + 4 层 SMS 防刷 + 200 条/天 hard cap + PushDeer 告警
  - 实施路线：PR1 telemetry SDK ✅ → PR2 auth backend ✅ → PR3 登录 UI ✅ → PR4 强制登录拦截 → staging 环境 → PR5 分享功能 → PR6 上线后加固 → PR7 收藏订阅 / newsletter
  - **顺序调整（2026-05-03）**：staging 提前到 PR4 之后（替代原"PR6 一次性"），PR5/PR7 内容互换（分享功能优先于收藏订阅，因为分享不依赖写表）
  - 微信 OAuth / 一键登录 SDK / 第三方登录：等切企业主体后再做（identities 表 schema 已预留）
- [ ] 前置 4: 数据看板 — 简单分析页 `/admin/analytics`（仅登录用户可见），基于 events 表做漏斗 / 留存 / 来源分析，按 tweet / author / referer 维度下钻
- [ ] Dashboard P1: dark mode、keyword 噪音审核面板、smart text truncation
- [ ] 引用 + 被引用 feed 去重策略（同一条被 quote 又独立出现）
- [ ] 前端 on-demand metrics 刷新（Worker /api/refresh/:id + 前端曝光触发）
- [ ] **`feat/lazy-enrich-on-drawer`：抽屉打开时主动 enrich + 落库**（PR5 试用反馈，2026-05-05 排）
  - 现状：dashboard 抽屉打开仅 `GET /api/items/:id`（纯读 D1），缺数据字段（X 互动数、PH reviews_avg 等）显示「—」；分享后海报上同样缺
  - 期望：抽屉打开 → worker 主动拉新值 → 写回 items 表 → 抽屉/feed 卡片/海报全部用新值
  - 各源策略：
    - **X**：用 syndication API（`cdn.syndication.twimg.com/tweet-result`，免费，反爬轻）补 metrics + quote_of + link_card；现有 `enrich_from_syndication.py` / worker `runRefreshMetrics` 可复用，关键是触发时机改为 on-demand
    - **GH**：worker 加 fresh-fetch endpoint，调 GitHub REST `/repos/:owner/:repo` 拿 stars/forks/watchers/contributors_count；issue/PR 计数走 search API
    - **PH**：PH 没有公开 API；worker 用 CF browser binding（`env.BROWSER`）实时打开 PH 页面解析（POC 已有 `worker/src/scrapers/ph_poc.ts`）；成本：browser 时间月 10h 含
  - 频率 + 缓存（待跟用户深入聊）：
    - 单 item KV throttle，比如 5min 内只刷一次
    - 命中近期 fetch（< 1h）跳过
    - syndication 全局并发限速（X 反爬触发后惩罚）
    - PH browser fetch 慢（5-10s），抽屉打开时立即返回旧数据 + 后台 enrich，下次抽屉打开看到新值（hybrid lazy）
  - dashboard 侧：拿到 enrich 结果后通过 zustand store 把新 metrics 同步给 feed 卡片（GithubDrawerBody 已有 `setLatestMetrics` 模式可参考）
- [ ] **PR5 海报试用反馈跟进**（2026-05-05 排，PR6 一起做）
  - **GH commit 数据落库 + 抽屉展示**：scraper / worker / D1 schema / GithubDrawerBody
  - **GH feed 卡片正文加高到 4 行**：GithubCard 单文件
  - **PH feed 卡片改造**（4 项）：
    - 4.1 第二行排版：日期（去掉 "PT" 前缀）、#排名、分类标签 顺序固定
    - 4.2 分类标签恢复颜色（PhCard 之前有色现在没了）
    - 4.3 卡片正文加高到 4 行
    - 4.4 右下角去掉重复"名次"，把"团队 & Hunter" makers 信息右对齐（`by @张三 等 3 人`，能放头像就放最多 N 个）
  - **PH 抽屉**（5.1 顺序、5.2 标签颜色）：PhDrawerBody 单文件
  - **海报视频封面预抓帧（D 方案，跟分享海报相关但要 scraper 改动）**：
    - 现状：GH `<video>` / X video.twimg / PH 上传视频，海报上没封面只是黑底 + play
    - 改：scraper 端用 ffmpeg / headless browser 抽视频首帧（避开纯色帧）落 R2 + extra.video_thumbnail
    - 海报渲染时直接用 `extra.video_thumbnail`（已实现 isVideo+image overlay 流程，差数据源）
    - 各源策略：
      - X：`scrapers/_lib` 加 video_thumbnail 抓取（fetch video first 100KB → ffmpeg pipe → JPEG）
      - GH：`scrapers/github/` 解 readme `<video src>`，按相同方式抽帧
      - PH：`scrapers/ph/` 已经有 video.poster 字段（YouTube embed thumbnail），上传视频补抽帧
    - YouTube video 直接用 `https://img.youtube.com/vi/<id>/maxres.jpg` URL（PH 部分已可用）
- [ ] **metrics 数据完整性**：当前 likes/retweets/replies/views 在全表覆盖率 64-77%，导致部分卡片显示 metric 数 < 4。前端兜底已用「null → "—"」处理（见 frontend-responsive-iteration spec），后端层面要让 enrich daemon 主动回扫缺失字段（特别是 retweets 64% 最低），目标全表 ≥ 95% 覆盖。可在 enricher L0/L1 高频层增一道"补全空字段"扫描
- [ ] 关键词自学习优化: LEARNED_MIN_HITS 3→8、mid-sentence capitalization only、seed 共现

## 已完成
- [x] **视频支持**（2026-05-05）：A 部分 X 视频前端渲染——`TweetCard` 用 `<video preload=metadata muted>` 代替"▶ 视频"角标拿首帧封面，点击进 `Lightbox` 用 `<video controls autoPlay>` 全屏播；`MediaItem` type 加 `poster?` + `role?` 字段。240 条已有 X video 立即可见可播。B 部分 PH 视频抓取——`scrapers/ph/parser.py` 加 `extract_videos`，正则抠 RSC stream 里 `__typename:Media + mediaType:video` 块（YouTube/Vimeo embed 居多），输出 url/platform/video_id/poster_url；`sync.py` media 加 video 块；`worker/src/ph.ts` R2 迁移按 platform 跳过 embed（不能下成二进制）；`PhDrawerBody` gallery 按 platform 选 `<iframe youtube-nocookie>` 或 `<video>`。`scripts/push_ph_from_html.py` 应对 turnstile 卡 live scrape 时复用 saved snapshot 直接 push。完整设计在 `docs/plans/2026-05-05-video-support-design.md`
- [x] **Product Hunt 数据源接入**（2026-05-04）：`scrapers/ph/` 完整 pipeline（leaderboard + 单产品页 + DOM 抓 top-level 评论 / reviews / maker post + DeepSeek judge + 翻译）+ `worker/src/ph.ts` R2 资源迁移（logo / screenshot / video / avatar → SHA-256 R2 key + `/r/<key>` 反代）+ `dashboard/src/components/PhCard.tsx` + `PhDrawerBody.tsx`（9 段 detail）+ `/ph/:slug/:date` 路由 + launchd `com.aifeeds.ph-scraper`（PT 0:30 daily）+ `scripts/rescrape_ph_slugs.py` 单 slug 补抓脚本。架构走"抓在本地、迁在云上"——CF Browser Rendering 过不了 PH turnstile，用 browser-use Profile 1 + 持久 PHSession 解决。坑：PH 把每条评论都包在 `[data-test^="thread-"]` 里（包括 reply 嵌套 thread），review 用星标 icon 没 rating 文本，老 walk-up 拿到公共父级 → 同人重复显示；新逻辑分别按"祖先里没别的 thread"/"最深的单 handle 祖先"修齐。完整设计 + 8 步实施记录在 `docs/plans/2026-05-03-product-hunt-source-design.md` + `docs/source-integration-sop.md` + `docs/dev-log.md`
- [x] 长推（X Premium note_tweet）抓全（2026-04-29）：CF Worker 端加 detect-longform 模式（heuristic SQL + syndication API 标 note_id）、`/api/longform/{pending,submit}` 端点、cron 接管 `:10 :50` 两个槽自动检测；本地 `enrich_longform.py` 用 browser-use 抓详情页完整正文 → POST 回 Worker，更新 D1 后置 content_translated=NULL 触发既有 fill-translations cron 重译。验证：sundarpichai 那条原内容 278→1480 字符。历史候选 ~5894 条等待 cron 慢慢扫
- [x] ingest UPSERT 保留 Worker enrich（2026-04-29）：上一条上线后发现 Pichai 又退回 278 字符 — 根因是 `handleIngest` 的 `ON CONFLICT DO UPDATE` 无条件用 excluded 覆盖 content/extra，本地 scraper 重推同 id 时把长文 + longform 标记一起清空。修复：CASE 表达式只在新内容更长时才覆盖 content/translation，extra 通过 `json_patch` 保留 `$.longform` / `$.enriched_at`（本地永远不会设这俩字段）。
- [x] 长推翻译流水线兜底（2026-04-29）："抓全长文却没翻译"的两个工作流漏洞一起修：(1) translateBatch 解析按 `\n` 切行，多段落原文只剩第一段（Pichai 1480 字 → "你好。你好吗？谢谢..." 16 字），改为：输入用 `⟪NL⟫` 哨兵替换 `\n`，输出用累积式解析+反替换；(2) submitLongformText 写完 `content_translated=NULL` 后只能等随机抽样的 fill-translations cron 命中（~780 候选 / 150 抽样），改为 submit 后立即调 DeepSeek 同步翻译入库，失败兜底回 cron。同时 sweep 38 条历史被旧 parser 截断的 longform，把 `content_translated` 清成 NULL 等 cron 重译。验证：新跑 1 批 20 条全部一次成功翻译，比例 ~40-46% 中：英字符比正常
- [x] 周度自动调参（2026-04-22）：`scripts/tune_schedule.py` + 独立 launchd `com.xlist-scraper.tune`（周一 04:00 BJT）。schedule.py 解耦成读 `data/schedule_params.json`，无文件时回退 DEFAULT_PARAMS。三道护栏：最小数据 500 条、hot_interval 变化 ±30% clamp、dry-run sim 任一指标差 >20% 拒绝。审计落 `data/schedule_params_log.md`。回滚 = 删 json 文件
- [x] 动态抓取频率切换到 C2 hybrid（2026-04-22）：回溯模拟（`scripts/simulate_schedules.py`, 14d train + 14d sim, 1892 tweets）对比 A/B/C 多个变体后选定 C2：prior≥0.15 → hot 固定 20min（比线上 30m 更新鲜），否则 target_new=10 动态（上限 60m）。模拟结果：490 runs vs 线上 672 (-27%)，zero 20.7% → 11.8%，hot 段 p50 延迟 15m → ≤10m
- [x] 分类引入引用/thread 上下文（2026-04-22）：tweet_processor._build_judge_content 把 quote_of + reply_to 父文喂给 LLM，显式标注 [QUOTED by @x] / [REPLY TO @x]；prompt 加明确规则：父文在主题且当前是合理回应就放行，父文跑题或只是闲聊就 N
- [x] 动态抓取频率 v1（2026-04-22）：schedule.py 按 (BJT 星期, 小时) prior + 最近 3 轮 recent 融合预测下次间隔 [10-90min]，launchd 改 5min tick + cron.sh 读 .next-scrape-at 做 gate，适配 10:1 峰谷比（当天下午切到 C2 hybrid）
- [x] Dashboard "新内容" 提示条（2026-04-22）：点击后滚动到顶部 + 预加载；热门模式下也会轮询，点击时触发完整 re-fetch 以保留正确排序；加脉冲小圆点吸引注意力
- [x] 关键词污染修复（2026-04-22）：扩展 _STOPWORDS + _is_acceptable_term 门控，单词抽取（禁多词短语），1382/1697 demoted，sync 到 D1，已验证目标政治推文从 feed 移除
- [x] cron 自动补全: 抓取后在 push_to_cloud 前自动补 quote + card + 翻译（main.py run()）
- [x] 抓取停止条件：sort-agnostic（known_ratio_high + feed_exhausted + 5min timeout），commit 9f5f003

## 已完成
- [x] Dashboard P0: 骨架屏、error retry、hashtag/URL 高亮、image lightbox、mobile 优化、thread 聚合
- [x] 卡片 X 样式对齐: 头像 40px、15px 字号、SVG verified 徽章、metrics 图标 + hover
- [x] Infinite scroll（IntersectionObserver + cursor 分页）
- [x] Thread 排序修复（snowflake tiebreaker）
- [x] 引用推文嵌套卡片（QuotedTweet 组件 + 图片去重）
- [x] Link card 组件（LinkCard 缩略图+标题+描述）
- [x] enrich_from_syndication.py: 6063 quote + 1989 card + 5430 翻译
- [x] WAL mode + thread 检测校准
