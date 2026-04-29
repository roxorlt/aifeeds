# xList TODO

## 进行中
- [ ] enricher daemon: L0-L5 分层 metrics 刷新，按热度衰减调度

## 待做
- [ ] **分享功能**（依赖下面 4 个前置全部完成）：PC（复制链接）/ 移动端（系统 share sheet）/ 移动端微信内（引导打开菜单）三态分流；分享 link 带 `?from=<uid>&ref=share`，落地后上报到 Worker 做回流统计
- [ ] 前置 1: Dashboard URL routing — 当前是纯 SPA 全站 `/`，要补 tweet 详情页 `/t/:id` 和 thread 页 `/thread/:id` 两条路由，用 react-router + drawer overlay 共存（desktop 用 drawer，mobile 深链直达页面）
- [ ] 前置 2: 账号 + 登录系统 — 轻量 OAuth（Google / GitHub 起步），D1 新增 `users` 表，Worker 签发 JWT，dashboard 全站状态感知
- [ ] 前置 3: 数据上报 SDK — 前端统一 `track(event, payload)` 方法，Worker `/api/track` 落到新增 `events` 表（事件类型、user_id、ts、referer、payload JSON），要考虑去重和批量
- [ ] 前置 4: 数据看板 — 简单分析页 `/admin/analytics`（仅登录用户可见），看分享外链点击 → 回访 → 留存漏斗，按 tweet / author / referer 维度下钻
- [ ] Dashboard P1: dark mode、keyword 噪音审核面板、smart text truncation
- [ ] 引用 + 被引用 feed 去重策略（同一条被 quote 又独立出现）
- [ ] 前端 on-demand metrics 刷新（Worker /api/refresh/:id + 前端曝光触发）
- [ ] 关键词自学习优化: LEARNED_MIN_HITS 3→8、mid-sentence capitalization only、seed 共现

## 已完成
- [x] 长推（X Premium note_tweet）抓全（2026-04-29）：CF Worker 端加 detect-longform 模式（heuristic SQL + syndication API 标 note_id）、`/api/longform/{pending,submit}` 端点、cron 接管 `:10 :50` 两个槽自动检测；本地 `enrich_longform.py` 用 browser-use 抓详情页完整正文 → POST 回 Worker，更新 D1 后置 content_translated=NULL 触发既有 fill-translations cron 重译。验证：sundarpichai 那条原内容 278→1480 字符。历史候选 ~5894 条等待 cron 慢慢扫
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
