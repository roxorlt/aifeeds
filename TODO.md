# aifeeds TODO

> Session 开始建议：先扫一眼"进行中"看当前要推什么，"待做"是积压队列，"已完成"按时间倒序保留方便回溯。
>
> 本文档与 [docs/operations.md](docs/operations.md) 双更：远端服务变更、新增 cron / endpoint / 表都同步两边。

---

## 进行中

### A. AI 厂商博客 + 播客新源接入（2026-06-09，Phase 0 设计完成）

> 新增两个内容形态:`blog`(国内外 AI 厂商官方/技术博客长文)+ `podcast`(国内外 AI 播客单集)。完全复用现有「items 大一统表 + 每源一条 CF Workflow + 完整性 gate + 三件套前端」架构。
> 设计文档:[docs/plans/2026-06-09-ai-vendor-feeds-source-design.md](docs/plans/2026-06-09-ai-vendor-feeds-source-design.md)(已过对抗式 critic + 必修项修正)
> 数据源参考:`/Users/roxor/cola/outputs/AI-Feeds-数据源汇总文档/`(2026-06-09 实测 45 候选源)
> 关键实测结论:45 个候选里 34 个零 VPS 基建可拿(24 原生 feed + 10 页面抓取),只 4 个中文播客必须 RSSHub、8 个 SPA 必须无头。
> ⚠️ 香港中转 VPS(1 核 961MB,prod 全站单点)**绝不跑无头/RSSHub**——无头走 CF Browser Rendering、RSSHub 另起独立小鸡。

- [x] **D1/D3/D4/D7 已定**(2026-06-09 用户拍板,见设计文档 §13 顶部小结):基建复用 Codex 腾讯云机 82.156.0.68(跨方依赖,Phase 1 不用它)/ 公众号 v1 不接标 v2 / 前端合并单频道「官方新闻」。余 D2 上限 / D5 中文播客 ASR / D6 SPA 硬骨头 / D8 去重范围 / D9 publisher logo / D10 冷启动深度 维持推荐默认,可读后再调
- [x] **Phase 0 mockup 三件套已出**(2026-06-09):[索引](docs/plans/_mockups/2026-06-09-feeds-index.html) + kit + feed/卡片变体/blog抽屉/podcast抽屉/海报 5 页。审查通过(emoji 零违规、token 对齐 TweetCard 基线、合并频道/卡片家族/chipColor 全落实)
- [x] **2 个视觉取舍已定**(2026-06-09 看 mockup 后):① blog 流内卡 = **右侧小缩略图(news-card 式,文字为主,非满宽 hero)** ② publisher logo = **真实 logo(BE 迁 R2)**。已记设计文档 §10.1/§10.2/§13 + 决策矩阵。→ **Phase 0(设计 + mockup)彻底完成**
  - 注:`feeds-feed-mockup.html` 里 blog 卡画的是旧的满宽 hero,**最终以 `feeds-card-variants.html` 的 ② 右侧小缩略图为准**(设计文档已是权威);Phase 1 建卡照 §10.2,需要的话可再刷一版 feed-mockup
- [ ] **mockup 实现注记**(非阻塞,FE 落地时):blog 抽屉头图标 ico-close 统一为 ico-back(对齐 podcast 抽屉/kit 外壳);logo 描边 #FF9A1A 改回规范 #FF8A00
- [x] **Phase 1 代码 + staging 验收完成**(2026-06-11,branch `feat/blog-podcast-sources` = main + 4 commits,**未合 main / prod 未动**):
  - 代码:migration **021**(因 main 020 撞号改名)+ feeds/ 共享库(registry 24 源/解析/抽取/is_ai gate+ELI25/L1去重/R2)+ Blog/PodcastPipelineWorkflow + cron :20/:50 + 前端三件套「官方新闻」频道
  - staging 实测:blog 13 feeds 102 条 + podcast 11 feeds 110 条,workflow 完成率 ~96%+ 收敛,三终态 wc_at ✅,is_ai gate 滤掉 3 条非 AI ✅,ELI25 翻译抽查过关 ✅,R2 封面迁移 ✅,列表剥重字段(单条 ~4KB)✅,抽屉全文+audio player 真机渲染 ✅
  - staging 期间修掉 3 个问题:`/o` 裸路径路由缺失(白屏)/ 官方新闻排序传 `sort=published_at`(默认 scraped_at 同秒入库乱序)/ `.env.staging` 重建(被 7ef229c 移出跟踪后 checkout 删失)
  - ⚠️ 遗留注意:**staging 浏览器有 SW 壳缓存**,部署后旧版可能吊 24h,验收前注销 SW / 硬刷新
- [ ] **prod 上线**(待用户发话):PR review → 合 main → migration 021 跑 prod D1 → worker+dashboard 同步部署 prod → 触发首拉 → PushDeer 通知验证(Phase 8)
- [ ] **Phase 2/3**:RSSHub 中文播客 / 页面抓取 + 无头(按 D1-D10 结果排)
- [ ] **明确不接**(需求 4.8):不往 digest(订阅日报)/ codex daily 推送加 blog/podcast

### 0. PH GraphQL + worker cron 主 PR 收尾（2026-05-11）

> 主 PR 已合 staging 验收完毕（设计 [docs/plans/2026-05-11-ph-graphql-cf-cron-design.md](docs/plans/2026-05-11-ph-graphql-cf-cron-design.md)、计划 [docs/plans/2026-05-11-ph-graphql-cf-cron-implementation-plan.md](docs/plans/2026-05-11-ph-graphql-cf-cron-implementation-plan.md)）。剩下：

- [ ] **prod 上线前去 PH dashboard regenerate API Secret**：旧 secret 在 chat 暴露过；regenerate 后告诉我新值，我重注入 prod + staging
- [ ] **prod secret 注入**：拿到新 secret 后 `wrangler secret put PH_CLIENT_ID` + `PH_CLIENT_SECRET` 入 prod
- [ ] **主 PR merge → CICD 自动 deploy → 监控首日 cron**（次日 北京 04:10 = UTC 20:10 自动触发）
- [x] ~~**删 staging 临时 INGEST_TOKEN 兜底鉴权**：三个 ph-*-now endpoint 已统一只保 Basic Auth (commit `d0b930d`)~~
- [ ] **staging 旧 row 残留 `[REDACTED]` author/handle 修复**：现有 9 条 PH item 的 items.author/handle 是 force re-fetch 前的 [REDACTED] 值（ingestItems UPDATE SET 不刷 author/handle 字段）。一次性 SQL UPDATE 刷新即可；prod 是 fresh 不会重现。或考虑给 ingestItems UPDATE SET 加 author/handle（影响 X/GH/CH，需评估回归）

### 0.1 PH 安全期 PR ✅ 全部完成（2026-05-13，提前于原计划 5/18）

> 用户判断 prod 稳定 2 天足以提前清理（风险可控：launchd 早已 unload + git 历史保留代码可随时回滚）。

- [x] ~~删除 `scrapers/ph/` 整个目录~~ — `git rm` 10 个文件（commit `246eab4`，git 历史保留）
- [x] ~~`launchctl unload` + 删 plist~~ — 本地 LaunchAgents 实际从未安装过 PH plist；仓库内 `launchd/com.aifeeds.ph-scraper.plist` 同步 `git rm`
- [x] ~~写 `docs/archive/ph-scraper-retired.md`~~ — 含旧实现摘要 + 退役原因表 + 短期救火 + 长期回滚步骤（commit hash 指针）
- [x] ~~CLAUDE.md 数据源现状段确认无残留旧 launchd 引用~~ — L8 已正确写成 "PH GraphQL API + worker cron"，无需改
- [x] **额外**：`docs/operations.md` 三处同步清理（架构图 / L218 引用 / §1d 整段改为退役声明）

### 0.2 PH 后续 polish（不阻塞主 PR）

- ⛔ ~~**comments 作者 mask 替代方案**~~ — 2026-05-14 OAuth user-token probe 验证（staging probe endpoint）：user-token 拿到的 makers / comments[].user 也是 `[REDACTED]` / `id=0`，**跟 client_credentials 完全一致**。PH 对 makers / comments 用户身份的 mask 是**全局隐私策略**，跟 token 类型无关。只有 hunter 字段是 public attribution 不被 mask。**OAuth 方案彻底废弃**。如未来要拿真名只剩 DOM scrape PH 网页一条路（CF Browser binding 月费 + 跟 §0.1 决策矛盾，不建议）
- [x] ~~**lazy-enrich-on-drawer for PH**~~ — PR #12 已 merged (2026-05-14)，PH 抽屉打开主动调 PH GraphQL by-slug 拿最新 votes/comments/makers/comments，写回 D1 + append snapshot。staging 验证 votes 77→84 / comments 6→9 OK
- [ ] **PH 评论保留富文本格式**：当前 transform 时 `stripHtml` 把 `<p><br>` 转纯文本 + 段落换行。如果未来要保留富文本（链接 / 图片），改前端 sanitize 渲染（DOMPurify + dangerouslySetInnerHTML）
- ⛔ ~~**PH reviews 列表补全**~~ — 2026-05-14 验证：PH GraphQL Post 类型**不暴露 reviews 字段**（只有 `reviewsCount` / `reviewsRating` 数字摘要），实测报 `Field 'reviews' doesn't exist on type 'Post' (Did you mean reviewsCount?)`。老 scraper 的 `extra.top_reviews` 是 DOM 抠 PH 网页的，GraphQL 没对应 endpoint。**决议接受现状**：前端 ReviewItem 仍能渲染，没数据时空白；如未来要补需要 CF Browser binding (月费) 或重启本地 scraper (跟 §0.1 决策矛盾)，ROI 低不做

---

### 1. PR6 上线运维加固（4 项纯运维收尾）

> PR5 海报反馈、抽屉刷新、PR-B/C 对话上下文等都已合 main（详见已完成段）。当前 PR6 一揽子里只剩下面 4 件**纯运维**项：

- **限流参数调优** — SMS 200/天 hard cap、telemetry 限流、分享接口限流的真实流量观测后调整
  - DeepSeek 调用限流：等 CF 阶段 1 启用 AI Gateway 后会被吸收，**这一条延后**
  - SMS / telemetry / 分享限流：仍要在 worker 里手写
- [x] ~~**admin 看板增强（业务指标部分）**~~ — 2026-05-17 PR #52 完成。`/admin` 默认进 `/admin/dashboard`（仪表盘）+ `/admin/tools` 拆出原 SMS 工具。仪表盘含：DAU/WAU/MAU、30 天 DAU 趋势、4 步行为漏斗（启动→看到内容→点击→深度互动）、7 天会话时长直方图、cohort × N+1 日留存矩阵、事件类型分布（中文标签）、错误明细分桶、Top 重度设备。SQL 走 events 表。详见 [`docs/operations.md` §1 端点清单](docs/operations.md)。**收藏 / 订阅活跃度** 等待 PR5/6 落地后补查询 metric。**cron 健康度 / 错误率** 仍按原计划走 Workers Logs，不在这看板做
- [x] ~~**数据备份**~~ — 2026-05-14 完成，用 **CF Workflows（不是 Container）** + R2 实现，更简单。新建独立 worker `aifeeds-d1-backup`，每天 BJT 12:30 跑 D1 REST export → 写 R2 `aifeeds-d1-backups/daily/<BJT-date>.sql`，30 天滚动（R2 lifecycle rule 自动清理）。月成本 $0（在 Workers Paid 含量内）。设计 `docs/plans/2026-05-14-d1-backup-workflows-design.md`，运维 `docs/operations.md` §9。Schema 改动无需修改备份代码（D1 export 是整库 dump 自动反映）
- **异常告警分级**
  - 现状：所有 cron 错误一锅端走 PushDeer，半夜被低优先级吵
  - 改：硬故障（cron 全挂）立报，软故障（单批次失败）攒批后报告
  - 业务级告警（"scrape 0 new 持续 3 轮" / "翻译失败率 > 5%" / "metrics 覆盖率跌破 90%"）仍要自己写，CF 给不了语义
  - 基础错误率告警等 CF 阶段 1 的 Workers Logs 接管

### 2. ~~ClawHub 30 天热度趋势 sparkline 收尾~~ ✅ 已完成

实现：`dashboard/src/components/ClawhubDrawerBody.tsx` 内 `StarsSparkline` 组件（line 247-310）— 手写 SVG `<polygon>` 渐变填充 + `<polyline>` 折线，无图表库依赖。`fetchItem(item.id)` 拉 `metrics_history`，count ≥ 14 才展示，首尾 stars 数字 + 涨跌幅 + 起止日期一目了然。挂在抽屉「30 天趋势」`<details>` 区段（line 628-641）。

### 3. 海报视频封面预抓帧（D 方案）

> X / GH / PH 三种来源的视频在分享海报上现在都是黑底加播放按钮，丑。

- scraper 端用 ffmpeg / headless 浏览器抽视频首帧（避开纯黑帧），传到 R2，落到 `extra.video_thumbnail`
- 海报渲染时直接用这个字段（已经实现 isVideo + image overlay 流程，差数据源）
- 三源策略：
  - **X**：`scrapers/_lib` 加 video_thumbnail 抓取（fetch video first 100KB → ffmpeg pipe → JPEG）
  - **GH**：`scrapers/github/` 解 readme `<video src>`，按相同方式抽帧
  - **PH**：`scrapers/ph/` 已有 `video.poster` 字段（YouTube embed thumbnail），上传视频补抽帧
- YouTube 视频特殊：直接用 `https://img.youtube.com/vi/<id>/maxres.jpg`（PH 部分已可用）

### 4. CF 服务端迁移 5 阶段

> 把目前散在各处的抓取流水线（本地 launchd cron / worker scheduled / 手动脚本）逐步搬到 CF 官方流水线工具上，减少本地依赖、加强可观测性。讨论文档：[`docs/plans/2026-05-06-cf-backend-migration-discussion.md`](docs/plans/2026-05-06-cf-backend-migration-discussion.md)（含真实流量 261/天 X、ScrapeBadger 计费、各产品月费估算、待决策项）

**做完会吸收 / 合并 / 砍掉的 TODO**（依赖收割表 · 2026-05-15 整理）：

| 阶段 | 砍 | 移交 | 合并 |
|------|-----|------|------|
| 阶段 1 | #1 DeepSeek 调用限流（AI Gateway 吸收） | #1 admin 看板 cron 健康度 / 错误率 → Workers Logs；#1 异常告警基础错误率部分 → Workers Logs；#7 来源分析（referer / 设备 / 国家） → Web Analytics | — |
| 阶段 4 | #5 失败死信队列（Workflow 自带重试 + 单步 retry） | — | #5 字段补全扫描 / 前端曝光触发 / 海报触发 三个口子并入 Workflow 一起写（避免 KV / Durable Object 临时方案） |
| 阶段 5 | #1 数据备份 launchd 本地临时方案（PR #16 已用 D1 → R2 Workflow 实现） | — | #3 视频抽帧跑在 Container 里 |

**阶段 1（这周内，3 小时）—— 纯启用观测，不动业务代码**
- [x] **AI Gateway** — OPS 2026-05-16 已建 `aifeeds-deepseek` gateway（详见 [operations.md §10](docs/operations.md)）；BE 待办：worker 把 DeepSeek 调用 base URL 切到 `https://gateway.ai.cloudflare.com/v1/0d13b65d05d5d29fe06998141f3b0f9a/aifeeds-deepseek/deepseek`，is_relevant 等可缓存请求加 `cf-aig-cache-ttl: 3600` header
- [x] **Web Analytics** — OPS 2026-05-16 已建 + zone auto-inject 接管（详见 [operations.md §11](docs/operations.md)）；**FE 不需要装 beacon snippet** — CF 边缘按 UA 判断浏览器时自动注 token `850b4048…`，prod + staging 两个域都已验证（curl 带 Chrome UA 能看到注入的 `<script>`）。早期 OPS 手动建的 2 个 standalone site 测出收不到数据已删，FE 也不需要按 build target 切 token
- [x] **Workers Logs** — BE 2026-05-16 已加（PR #34），`worker/wrangler.toml` 含 `[observability] enabled = true` + `head_sampling_rate = 1.0` + `[observability.logs] invocation_logs = true`；查日志走 CF Dashboard → Workers → xlist-api → Logs tab

**阶段 2（半天）—— 图片走边缘优化**
- [x] **OPS 2026-05-16** zone `image_resizing` toggle on
- [x] **BE 2026-05-16**（PR #49）worker `/img` 加 `cf.image` option（format=auto + ?w= resize + ?q= quality），video 分支保持原反代。prod 验证：avatar 28573B→2532B（w=80，省 91%）/ →18074B（w=400，省 37%）
- [x] **FE 2026-05-16**（PR #51）`proxyImg(url, width)` per-call-site：14 处 img 调用按场景传 80 / 400 / 不传，GH avatar 28KB → 1.5-3KB
- [x] **BE/FE 2026-05-16**（PR #54）format=auto 在 worker fetch 上下文不可靠（curl + chrome devtools 都验证 3 种 Accept 都返原 jpeg / 无 Vary）；worker 改成自己 parse Accept header 主动设 `cf.image.format = 'avif' | 'webp' | (omit)`，cacheKey 编入 format 防跨 client 污染。Prod 实测 ruvnet 头像：jpeg 4970B → avif 3188B（再省 36% on top of resize）

**~~阶段 3（1-2 周）—— GH 链试点 Workflow~~** ✅ 已完成
- PR #40 把 GH trending 抓取从 worker cron 切到 CF Workflow，验证下来重试 / 状态可视化 / 单步 retry 都比 cron 好用，决定继续推进后续源。

**~~阶段 4（2-3 周）—— X 主链双写迁移~~** ✅ 已完成
- PR #43 把 X 主流水线全迁到 Workflow，PR #65 顺便把分类 + 翻译合成一次 JSON Mode 调用、加完整性 gate。配套加固：#66（数据失效级联）/ #69（老数据回填 + 关联推 metrics）/ #74（media 字段缺失回填）/ #75（instance ID 加 hour-bucket 根治全源 stuck）/ #80 #81（uncaught exception 双层兜底）/ #106（五源统一 `workflow_completed_at` gate）。
- 翻译候选 SQL 重写、reply / retweet 父推 snapshot 翻译覆盖、翻译流水线 i18n 友好接口、C 端「已浏览英文时译文完成」的展示策略 —— 这几个原本挂在阶段 4 下的小尾巴**仍未做**，记到下面新增的「翻译流水线后续优化」段。

**~~阶段 5（hdx + PH + ClawHub 抓取链迁移）~~** ✅ 已完成
- PR #45 把活动行（hdx）抓取链迁到 Workflow。PR #47 把 PH + ClawHub 也迁完。设计文档分别在 `docs/plans/2026-05-* 阶段 5 / 6` 系列。
- BE 端 SOP 改造也跟上了（PR #78 重写信源接入 SOP 适配 Workflow 时代）。

**阶段 6（按需）—— 高级能力**
- Queue：消息总线（比如 enrich 任务排队）
- Logpush：日志推到 R2 / S3 长期存档
- Container：跑需要长任务 / 自定义环境的 job（D1 备份 / video 抽帧）

**翻译流水线后续优化**（原阶段 4 下挂的小尾巴，迁移完成后单独跟）：
- **翻译候选 SQL 重写按 task 类型分队列**：现在 `selectTranslationCandidates`（`worker/src/enrich.ts`）用 `RANDOM()` 抽样，命中 quote_of / link_card 边角的概率 ~1%。Workflow 时代应按 task 类型分独立队列（content / quote / link_card 各一），扁平消费。
- **reply / retweet 父推 snapshot 翻译覆盖**：当前候选选择不扫 `extra.reply_of.content` 和 `extra.retweet_of.content`，X 子推卡片上的「回复 @父推作者」/「转推 @某人」snapshot 还是英文。
- **翻译流水线 i18n 友好接口**（多语言铺路）：Task 加 `lang` 字段、队列命名带 lang 后缀、DeepSeek prompt 模板参数化 source/target lang。DB schema 和 API lang 参数都暂不改，等真正多语言 UI 时一起做。完整设计 `docs/plans/2026-05-16-i18n-design.md`。
- **C 端已浏览英文时译文完成的展示策略**：API 下发按「已翻译优先」排序、translated_at > last_user_fetch_at 标新、前端横条提示「N 条新译文可刷新」。drawer lazy enrich on open（PR6.6）保留，不做实时推送，不做严格服务端过滤。

---

## 待做

### 5. metrics 流水线统一改造

> enricher daemon L0-L5 已上线（refresh-tiered M4），抽屉打开主动 enrich 也上线了（PR6.6）。"什么时候刷新、谁触发、刷不到怎么办"原有 4 个口子，3 个已做，2 个待做。

**已就位**：
- refresh-tiered M4（L0-L5 + velocity 阈值 + active/inactive 双 interval）
- `/api/items/:id/refresh`（PR6.6 抽屉触发，X / GH / ClawHub 三源都接了）
- ~~**前端曝光触发**~~ ✅ 2026-05-27 PR #137：feed 卡进入视口 ≥ 5s 调 `/api/items/:id/refresh?trigger=impression`。FE 接 IntersectionObserver（threshold 0.7）+ sessionStorage 5min 客户端缓存 + worker KV throttle 5min 服务端兜底 + feature flag 全局开关（admin `/admin/tools` 可一键 toggle）。详见 `dashboard/src/lib/impressionRefresh.ts` + `worker/src/feature-flags.ts`。
- ~~**分享海报触发**~~ ✅ 2026-05-27 PR #128：share/create 时 `ctx.waitUntil(refreshSingleItem(...))`，海报渲染时数据已新鲜。

**还要做**：
- **字段补全扫描**：每天一遍专门补 NULL 字段，目标全表 ≥ 95% 覆盖。重点 retweets（当前 64%）/ views（70%）/ replies（73%）
- **失败死信队列**：3 次重试失败后入死信队列告警

### 6. PR7 收藏 + 邮件订阅

**收藏**：
- 加 `favorites` 表（user_id, item_id, created_at）
- feed 卡片右上角加收藏 icon，登录用户可点
- 个人中心加"我的收藏"页（列表 + 移除按钮）

**邮件订阅**：
- 个人中心选频次（每日 / 每周）+ 主题（X / GH / PH / ClawHub 任选）+ 送达时间（北京时间）
- worker scheduled job 按频次组装摘要：每源选 top N（按互动数 / 综合分排序）
- 邮件 HTML 模板和海报视觉一致，直接在邮件里看不用回站
- 复用现有 Resend 通道（mail.ai-feeds.com 已 verified）
- 退订 link：每封邮件底部，token 验证一键退订（不用登录）
- 反垃圾合规：from / reply-to / list-unsubscribe header 齐全，监控 spam 率

### 7. ~~数据看板 `/admin/analytics`~~ → **已落地为 `/admin/dashboard`**（2026-05-17 PR #52）

- [x] ~~路由~~ — 实现成 `/admin` → 302 → `/admin/dashboard`（默认页）+ `/admin/tools`（原 SMS 工具），HTTP Basic Auth，不挂 admin 用户体系（凭据走 `.secrets/aifeeds-prod.env` 的 `ADMIN_USER/PASS`）
- [x] ~~漏斗~~ — 4 步：启动（app_open/page_view）→ 看到内容（item_impression/item_open_drawer）→ 点击（item_click/external_link_click）→ 深度互动（share_click/favorite_toggle/login_success），每步算独立 device 数 + 上一步保留率
- [x] ~~留存~~ — cohort 矩阵（首次访问日期 × +1d / +3d / +7d 留存率，最近 30 天 cohort）
- [ ] **内容下钻**：按推文 / 作者 / repo / product 看互动深度（haven't done — 需要 join items 表，等真有流量后再加 metric）
- ⚠️ 来源分析（referer / 设备 / 国家）等 CF 阶段 1 后直接看 Web Analytics，不在 admin 看板做（CF Web Analytics OPS 已建，FE beacon 未装 — 见 line 94）

**已落地 8 个 `?metric=` endpoint**：overview / dau-trend / retention / event-distribution / funnel / session-duration / errors / top-devices（详见 [operations.md §1](docs/operations.md)）。SQL 实现在 `worker/src/admin-dashboard.ts`。

**PR #52 附带的两个 worker 层 bot 防御**（运维加固）：
- [x] worker 入口 bot UA gate：拦 AI 训练爬虫 + 脚本扫描器（GPTBot/python-requests/curl/nikto 等），搜索引擎和社交预览 bot 留白名单
- [x] `/r/<key>` referer 白名单：防 R2 图片视频被第三方站点热链

### 8. Dashboard P1 视觉 / 交互迭代

**A. dark mode**
- 全站 dark theme（CSS 变量切换 + 系统偏好检测 + 用户手动 toggle）
- 以 X 卡片黑底为基线，其他源对齐

**B. keyword 噪音审核面板**
- 现状：AI 关键词自学习（从已分类 AI 推文抽词），偶尔学到噪音（"年报""政府"之类）
- admin 面板：列出最近 30 天学到的新词 + 词频 + 命中样本推文 → 一键 demote / 加白名单
- 和下面 #9 关键词自学习优化一起做更顺

**~~C. 智能正文截断~~** ✅ 已完成
- `dashboard/src/lib/truncate.ts` `smartTruncate()` 已实现：5 级 fallback（句末符号 → 中等停顿 → 空格词边界 → 中英文分界 → markdown 链接保护 → 兜底硬截），lookback 60 字符。
- 接入 TweetCard / GithubCard / PhCard / ClawhubCard / HuodongxingCard 五张卡（HfPaperCard 走纯 CSS line-clamp 不用 smartTruncate，论文 abstract 结构化短，不会切到链接中间）。

### 9. 关键词自学习优化

> 现状：学习阈值 3 次（一个词在 AI 推文里出现 3 次就学进 AI 关键词库），太松。结果学到一堆通用词（"产品""推出"）和不该当 AI 词的中文专有名词（"政府""年报""券商"），反过来污染分类。

- 阈值 3 → 8（要在 8 条不同 AI 推文里都出现才学）
- 只学"句中大写"的英文词（Anthropic / Claude / OpenAI 这类专有名词通常句中大写；普通动词 "new" 句中小写不学）
- 种子词共现校验：候选词必须和已知 AI seed 词（GPT / LLM / Anthropic / DeepMind 等）在同一推文里共现过 3+ 次才学
- 配 #8.B 的审核面板手动清一遍历史污染词（2026-04-22 已 demote 1382 个但会再生）

### 10. 引用 + 被引用 feed 去重

> A 推文引用 B 推文，B 推文本身又作为独立条目出现在 feed 里。用户在 feed 里第一眼看到 A（嵌套着 B），滚两屏又看到 B（原始），同一信息看了两次。

- 简单方案：feed 查询时如果一条推文是另一条的 quote 目标，不独立显示（让 quote 那条代表它）
- 复杂方案：保留 B 独立显示但标记"已被 @xxx 引用"，点开看引用上下文
- 取舍：简单方案省事但会"消失"信息（用户找不到 B 了）；复杂方案保留信息但 UI 复杂
- 先看真实数据：feed 前 100 条有多少这种 case 再决定

### 11. ICP 备案推进 + 微信生态接入

> 详见：[`docs/memo/2026-05-04-icp-备案讨论备忘录.md`](docs/memo/2026-05-04-icp-备案讨论备忘录.md) / [`docs/beian/README.md`](docs/beian/README.md)（备案号 + footer 标准片段 + 部署 SOP）/ [`docs/wechat/architecture.md`](docs/wechat/architecture.md)（微信登录架构 + state HMAC + bridge HMAC + 实施清单）

ai-feeds.cc + 腾讯云轻量服务器（82.156.0.68）+ 5 个静态合规页已部署。2026-05-13 ICP 备案 + 公安备案号已下证（**京ICP备2025123594号-2** / **京公网安备11010802048455号**）。三套品牌名约定：网页「AI源信」 / 备案主体「科赞源信」 / 全球版「AI Feeds」。

**备案号下来后**（按顺序）：
- [x] **footer 贴上工信部 + 公安双备案 + 公安图标**（2026-05-13 完成，5 个静态页已纳入 [`cc-site/`](cc-site/)；`cc-site/deploy.sh` 一键部署）
- [x] 申请免费 SSL → HTTPS（2026-05-13 完成，Let's Encrypt 证书 2026-08-11 到期；HSTS 1 年；apex + www + HTTP→HTTPS 301 全部 OK；宝塔自动续签）
- [x] 关 8888 防火墙端口（2026-05-13 完成，腾讯云后台删除）
- [x] 公安备案下证（2026-05-13）
- [x] `www.ai-feeds.cc` → apex 301 重定向（2026-05-14 宝塔域名重定向，保留路径 + curl 验证）
- [x] 微信开放平台企业认证（2026-05-14）
- [x] 微信开放平台「网站应用」创建 + 提审（2026-05-14 提交，授权回调域名 `ai-feeds.cc`，等审核结果约 7 工作日）
- [ ] 拿到 AppID + AppSecret 后落盘到 `.secrets/wechat-open-platform.env` + worker secrets
- [ ] 腾讯云短信签名「科赞源信」+ 模板

**微信生态接入**（设计已拍板，等 AppID 下来开工）：
- 微信扫码登录（高优）— 设计见 [`docs/wechat/architecture.md`](docs/wechat/architecture.md) §9 实施清单
  - worker：`POST /api/auth/wechat/exchange`（30s replay 窗 + bridge HMAC + 建 user/identity + 签 session_token）
  - `.cc`：宝塔 + Node + Express + PM2 + nginx 反代，2 个 endpoint（start / callback），state HMAC 无状态
  - dashboard：登录弹窗加微信按钮 + `/auth/callback` 路由 + `/login?error=...` 错误提示
- 分享落地页（中优，后置）
  - `.cc` 增加 `/s/:token` / `/share/t/:token` — 用预览页 + 用户主动点击，不能立即重定向（避免诱导跳转风控）
  - `.cc` 增加 JS-SDK 签名接口（`/api/wx/jssdk-config`、`/api/wx/ticket`）
- 三路径分发：PC OpenSDK（PC 浏览器）/ 海报手动分享（移动浏览器）/ JS-SDK 自定义卡片（微信内浏览器）
- 三路径分发：PC OpenSDK（PC 浏览器）/ 海报手动分享（移动浏览器）/ JS-SDK 自定义卡片（微信内浏览器）

**清理**：临时 SSH 密钥 `~/.ssh/aifeeds_temp` 备案过审 + SSL 配好后撤销

### 12. 国内 SEO / GEO 镜像站

> 详见：[`docs/memo/2026-05-07-seo-geo-discussion-memo.md`](docs/memo/2026-05-07-seo-geo-discussion-memo.md)
>
> 配套文档：
> - [`docs/plans/_research/2026-05-07-search-engines-ai-bots-research.html`](docs/plans/_research/2026-05-07-search-engines-ai-bots-research.html) — 30+ 引擎规则 + AI bot 三类法 + ICP 备案专题
> - [`docs/plans/2026-05-08-cn-mirror-cc-domain-design.md`](docs/plans/2026-05-08-cn-mirror-cc-domain-design.md) — `.cc` 静态镜像方案、成本估算、合规加固、实施分阶段

阻塞依赖：#11 备案号下来 + `.cc` 站点改造完成。已选 A 方案（`.cc` 启用国内主站，由 `.com` 抓取 + 翻译后生成静态页），不动手实施前先把 5 个待决策点拍板。

**5 个待拍板的决策点**（开工前要定）：
1. 境内 OSS / CDN 厂商（七牛云 / 阿里云 / 腾讯云）
2. AI 训练 bot（GPTBot / ClaudeBot 等）在 `.cc` 上放还是禁
3. takedown 邮箱地址定名
4. 备案中是否已勾选「AI 服务」类目（2024 工信部新规）
5. 媒体存储策略（图片 / 视频缩略图是否复制到境内 OSS）

**P0-P5 优先级框架**（备案后展开，详见备忘录第 9 轮）：
- **P0** 修底：SSR / prerender + robots.txt 三类法 + sitemap.xml + schema.org JSON-LD（**阻塞所有其他动作的单点瓶颈**）
- **P1** 站长平台提交：Google / Bing / Yandex + IndexNow key + 国内五站长
- **P2** 中国战略：本任务（`.cc` 镜像站）
- **P3** GEO 强化：llms.txt + AI 友好结构 + AI referrer 追踪
- **P4** 内容矩阵：知乎 / CSDN / SegmentFault / 稀土掘金 / HN / Reddit
- **P5** 监测：GA4 / CF AI Crawl Control / crawl-to-referral 比率

**关键事实**（CF 24h 已抓数据，未做任何 GEO 优化）：AI Assistant 124 次 / AI Search 59 次 / AI Crawler 23 次 / Search Engine 仅 5 次 — AI bot 已主动来抓，但 SPA 没 SSR 抓到的是空壳，引用质量为零。

### 13. ~~HarmonyOS Sans SC 字体上线（R2 自托管 + cn-font-split 子集化）~~ ✅ 已完成

详见 [`docs/design-handoff.md`](docs/design-handoff.md) § 2。R2 bucket `ai-feeds-fonts` 绑 `fonts.ai-feeds.com`，cn-font-split 切的三档（hmos-regular / hmos-medium / hmos-bold）已上传，每页实际只下 ~200KB。`dashboard/index.html` line 10-13 加 preconnect + 3 个 `result.css` stylesheet link；`dashboard/src/index.css` :root font-family stack 以 "HarmonyOS Sans SC" 为主，后接 system + 中文 fallback。Medium 字重（weight=500）已在 R2 CSS 里 sed 修正成统一 family 名。

---

## 已完成

### 2026-05-10 — 项目重命名 + CICD + 微信浏览器提示
- [x] **项目重命名 xlist-scraper → aifeeds**：commit `b7e9afe` + `a33f317`，加身份卡 + 删 chrome skill 残留 + CLAUDE.md 同步
- [x] **CICD GH Actions auto-deploy worker + dashboard + secret-scan**：commit `077f9d7`，并清掉历史 admin 凭证泄漏；后续 `8e57766` 修 wrangler 4.x Node 22 + npm ci 装依赖
- [x] **WeChat 内置浏览器登录提示**：检测到微信浏览器时显示"请用 Safari 打开"提示，避免 X / Google OAuth 在微信内挂掉。commit `15174c0`（PR6.A 微信内分享提示尾巴完成）
- [x] **ch 列头按钮对齐 + Turnstile 移动端 300031 改善**：commit `f6fad24`
- [x] **运维手册同步 ClawHub v2 + prod 状态**：commit `963d9b4`

### 2026-05-08 — ClawHub v2
- [x] **ClawHub v2 抓 ClawHub 渲染的 README + suspicious 全套**：v1 用 ZIP 解压拿 README，v2 改用 ClawHub 的 getReadme action 拿渲染过的内容（含图片、链接预处理），翻译 + 列头对齐 + suspicious 标记一起完成。commit `4837328`
- [x] **translateMarkdown 截断 30k → 5k 防 DeepSeek throttle**：commit `e3da649`
- [x] **已是中文跳 DeepSeek + drawer markdown 显式样式**：commit `72a4ba3`

### 2026-05-07 — ClawHub v1 ZIP 流水线 + 3-dropdown
- [x] **ClawHub v1 ZIP 流水线**：从 ClawHub 下载接口（`/api/v1/download?slug=...`）拉 ZIP → 解压抠 SKILL.md / README.md / 截图 → frontmatter 头剥掉 → DeepSeek 翻译（参考 GH 中文风格 + 16 岁/母语者质量栏）→ 翻译落 `items.content_translated`，原文落 `extra.skill_md`，files manifest 落 `extra.files_manifest`。commit `0a0a01f` + `ee9818f`
- [x] **ClawHub 顶部 3-dropdown 筛选**：替代 SortSelector「热度|时间」toggle，改成排序 + 分类 + 隐藏可疑三件套。commit `ee47e74`

### 2026-05-06 — PH 4 列 KPI + GH 反馈批量 + enricher 分层 + email auth + ClawHub v0
- [x] **enricher daemon L0-L5 分层 metrics 刷新**（TODO 进行中第一项 ✅）：`worker/src/enrich.ts` `refresh-tiered mode (M4)` — 按内容 age + 互动 velocity 双因子分 6 档（L0-L5），active / inactive 双 interval 自适应。L0 极热 10 分钟刷一次；L5 死内容不再主动刷。接 ScrapeBadger 拿回 retweets / views。commit `ec38d86`
- [x] **ClawHub v0 接入第 4 个数据源**：commit `1aa1622`
- [x] **PH 4 列 KPI + 海报 4 列 + parser 修 multi-launch votes 抓错**：commit `1210ae8`
- [x] **GH/PH 卡片改 YouTube 风格**：标题块紧凑头部 + 正文 / footer 跨满。commit `5f2ac76`
- [x] **GH contributors fallback + PH KPI/poster votes-comments-followers + PhCard ai_summary**：commit `dd7f2f5`
- [x] **GH feed 简化 + PH drawer KPI 改 3 列对齐海报**：commit `c069b78`
- [x] **email 验证码登录上线（绕过 ICP 备案的主路径）**：Resend HTTPS API + disposable 黑名单 + MX DoH + email-rate-limit 6 维度 + email-cap（daily/monthly + 去重告警）+ ENABLE_SMS_LOGIN flag 隐藏 SMS 通道（备案后翻 flag 加回双通道）。完整设计 `docs/plans/2026-05-06-email-auth-design.md`，merge `34525f9`
- [x] **CF 后端服务整体迁移讨论文档**：commit `07187ad`，落地为本 TODO 的 #4 项

### 2026-05-05 — PR6.x 系列大批量 + 视频支持
- [x] **PR6.6 lazy-enrich-on-drawer / `/api/items/:id/refresh`**（TODO 进行中 lazy-enrich ✅）：抽屉打开时主动 enrich + 落库 + feed 卡片同步。X / GH / ClawHub 三源都接了。`worker/src/index.ts:1044 handleItemRefresh`。merge `03696fc` + `f84b922 fix(feed): 抽屉刷新后同步 feed 流卡片`
- [x] **PR6.2 GH 最近 5 条 commit 落库 + 抽屉展示**（TODO PR5 反馈 ✅）：commit `4b83de1`
- [x] **GH feed 卡片重排**（TODO PR5 反馈 GH 4 行 ✅）：rank 上提 + lang/cat 同行 + metrics 下移 + commit 文案 + 正文 line-clamp-4。commit `e192997`
- [x] **GH drawer 对齐 feed 卡片 + 海报 rank 行加日期/去 commit**：commit `a03b726`
- [x] **PR6 反馈 Batch A — feed/drawer/海报排版统一 + commit 折叠**：commit `4a5e197`
- [x] **PH 卡片 4.1-4.4 layout 修正**（TODO PR5 反馈 ✅）：日期/排名/分类顺序 + 标签颜色 + makers 排版（前 3 头像 + "by @first 等 N 人"）+ 正文 line-clamp-4。commit `0692c60` + `79cb04d`
- [x] **#6 #7 #8 三条反馈合并**：commit `cb17c36`
- [x] **视频支持**（A 部分 X 视频前端渲染 + B 部分 PH 视频抓取）：TweetCard 用 `<video preload=metadata muted>` 拿首帧封面，点击进 Lightbox 全屏播；PH parser 加 `extract_videos` 抠 RSC stream 里 YouTube/Vimeo embed；worker R2 迁移按 platform 跳过 embed；PhDrawerBody gallery 按 platform 选 `<iframe youtube-nocookie>` 或 `<video>`。完整设计 `docs/plans/2026-05-05-video-support-design.md`

### 2026-05-04 — Product Hunt 接入
- [x] **Product Hunt 数据源接入**：完整 pipeline（leaderboard + 单产品页 + DOM 抓 top-level 评论 / reviews / maker post + DeepSeek judge + 翻译）+ worker R2 资源迁移（logo / screenshot / video / avatar → SHA-256 R2 key + `/r/<key>` 反代）+ PhCard / PhDrawerBody（9 段 detail）+ `/ph/:slug/:date` 路由 + launchd `com.aifeeds.ph-scraper`（PT 0:30 daily）+ 单 slug 补抓脚本。架构走"抓在本地、迁在云上"——CF Browser Rendering 过不了 PH turnstile，用 browser-use Profile 1 + 持久 PHSession 解决。完整设计 `docs/plans/2026-05-03-product-hunt-source-design.md` + `docs/source-integration-sop.md`

### 2026-05-03 — staging 环境 + PR4 强制登录 + PR5 分享
- [x] **PR4 强制登录拦截**
- [x] **staging 环境落地**：staging.ai-feeds.com / staging-api.ai-feeds.com，独立 D1（xlist-staging）/ KV / R2。完整设计 `docs/plans/2026-05-03-staging-environment-design.md` + 操作记录在 [operations.md](docs/operations.md#staging-环境-2026-05-03-上线)
- [x] **PR5 分享功能上线**（5 endpoint + share_relations 表 + Noto SC 字体子集 + resvg-wasm + R2 海报缓存 + dashboard 抽屉分享按钮 + 三变体 X/GH/PH SVG 模板 + 媒体图质量门控 + 移动端 navigator.share 直存相册）
  - **遗留 P2**：landing 回流（点过来的人 to_did/to_uid 回填）— 后续作为 PR6.A 一部分
  - **遗留**：移动端微信内提示（已于 2026-05-10 commit `15174c0` 完成）

### 2026-05-01 — PR-B / PR-C 对话上下文
- [x] **PR-B 对话上下文数据修复**（TODO 进行中 PR-B ✅）：本地 loop 全表 36k backfill-replies + worker cron `:05 :35` 兜底增量 + reclassify-threads 真执行（dry-run 显示 5398/6442 错分被清）。commit `0c1321e feat(enrich): backfill-replies 模式` + `81c8787 cron 接 backfill-replies + reclassify-threads` + merge `af52ad9 fix/conversation-context-data — backfill-replies + reclassify-threads + apply patch null-guard`
- [x] **PR-C 对话上下文 UI**（TODO 进行中 PR-C ✅）：抽屉 + 卡片支持 reply 父层 inline 显示「回复 @handle」+ 大返回按钮 + swipe-to-close + reply layout reorder。commit `a3392f3 feat(card): render reply parent inline + show 回复 @handle` + `3d2654d feat(drawer/card): bigger back btn + swipe-to-close + reply layout reorder`

### 2026-04-29 — 长推抓全 + ingest UPSERT + 翻译流水线
- [x] **长推（X Premium note_tweet）抓全**：CF Worker 加 detect-longform 模式（heuristic SQL + syndication API 标 note_id）、`/api/longform/{pending,submit}` 端点、cron 接管 `:10 :50` 两个槽自动检测；本地 `enrich_longform.py` 用 browser-use 抓详情页完整正文 → POST 回 Worker，更新 D1 后置 `content_translated=NULL` 触发既有 fill-translations cron 重译。验证：sundarpichai 那条原内容 278→1480 字符
- [x] **ingest UPSERT 保留 Worker enrich**：`handleIngest` 的 `ON CONFLICT DO UPDATE` 改成 CASE 表达式只在新内容更长时才覆盖 content/translation，extra 通过 `json_patch` 保留 `$.longform` / `$.enriched_at`
- [x] **长推翻译流水线兜底**：(1) translateBatch 解析按 `\n` 切行多段落只剩第一段 → 用 `⟪NL⟫` 哨兵替换；(2) submitLongformText 改为同步翻译入库，失败兜底回 cron

### 2026-04-22 — 周度自动调参 + C2 hybrid 调度 + 关键词污染修复
- [x] **周度自动调参**：`scripts/tune_schedule.py` + 独立 launchd `com.xlist-scraper.tune`（周一 04:00 BJT）。三道护栏：最小数据 500 条、hot_interval 变化 ±30% clamp、dry-run sim 任一指标差 >20% 拒绝
- [x] **动态抓取频率切换到 C2 hybrid**：回溯模拟（14d train + 14d sim, 1892 tweets）选定 C2：prior≥0.15 → hot 固定 20min，否则 target_new=10 动态（上限 60m）。模拟结果：490 runs vs 线上 672 (-27%)，zero 20.7% → 11.8%
- [x] **分类引入引用/thread 上下文**：tweet_processor._build_judge_content 把 quote_of + reply_to 父文喂给 LLM，标注 `[QUOTED by @x]` / `[REPLY TO @x]`
- [x] **动态抓取频率 v1**：schedule.py 按 (BJT 星期, 小时) prior + 最近 3 轮 recent 融合预测下次间隔 [10-90min]，launchd 改 5min tick + cron.sh 读 `.next-scrape-at` 做 gate
- [x] **Dashboard "新内容" 提示条**：点击后滚动到顶部 + 预加载；热门模式下也会轮询；加脉冲小圆点
- [x] **关键词污染修复**：扩展 _STOPWORDS + _is_acceptable_term 门控，单词抽取（禁多词短语），1382/1697 demoted

### 早期里程碑
- [x] cron 自动补全：抓取后在 push_to_cloud 前自动补 quote + card + 翻译（main.py run()）
- [x] 抓取停止条件：sort-agnostic（known_ratio_high + feed_exhausted + 5min timeout），commit `9f5f003`
- [x] **Dashboard P0**：骨架屏、error retry、hashtag/URL 高亮、image lightbox、mobile 优化、thread 聚合
- [x] **卡片 X 样式对齐**：头像 40px、15px 字号、SVG verified 徽章、metrics 图标 + hover
- [x] **Infinite scroll**（IntersectionObserver + cursor 分页）
- [x] **Thread 排序修复**（snowflake tiebreaker）
- [x] **引用推文嵌套卡片**（QuotedTweet 组件 + 图片去重）
- [x] **Link card 组件**（LinkCard 缩略图 + 标题 + 描述）
- [x] **enrich_from_syndication.py**：6063 quote + 1989 card + 5430 翻译
- [x] **WAL mode + thread 检测校准**

### 前置 1: Dashboard URL routing
- [x] Worker `GET /api/items/:id`（单条 + thread siblings）+ 前端 `/t/:id` 路由 + drawer URL 同步 + seed-history（冷启动深链后退键回首页）。`/thread/:id` 砍掉，YAGNI（thread 由 /t/:id 自然展开）。设计文档：`docs/plans/2026-04-30-dashboard-url-routing-design.md`

### 前置 2 + 3: 账号系统 + telemetry SDK
- [x] PR1 telemetry SDK
- [x] PR2 auth backend
- [x] PR3 登录 UI
- [x] PR4 强制登录拦截（2026-05-03）
- [x] staging 环境（2026-05-03）
- [x] PR5 分享功能（2026-05-05）
- [x] email auth（2026-05-06，绕过 ICP 备案）
- 完整设计：[`docs/plans/2026-05-01-auth-system-design.md`](docs/plans/2026-05-01-auth-system-design.md) + [`docs/plans/2026-05-06-email-auth-design.md`](docs/plans/2026-05-06-email-auth-design.md)
- 决策要点：手机号短信登录（个人主体起步，企业主体后置）+ Session 不走 JWT + LocalStorage device_id（合规优先）+ Turnstile + 4 层 SMS 防刷 + 200 条/天 hard cap + PushDeer 告警
- 微信 OAuth / 一键登录 SDK / 第三方登录：等切企业主体后再做（identities 表 schema 已预留）
