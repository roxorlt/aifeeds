# blog/podcast 新源(官方新闻)staging 验收用例

> 日期:2026-06-11 ｜ 分支:`feat/blog-podcast-sources`(= main + 11 commits)｜ 环境:**staging**(`staging.ai-feeds.com` / `staging-api.ai-feeds.com`,D1 `xlist-staging`)
> 范围:Phase 1 全量(管线/API/前端三件套)+ 验收 5 项反馈修复 + C 端打开速度 4 项对齐(`idx_items_feed_src_pub` / content 截断 / audio preload=none / 预取复合键)
> 执行人:Claude 自验收(交付用户前全过)。每条用例:**预期** → **实测**(✅/❌ + 证据)。
> 注意:浏览器用例需先注销 Service Worker + 清 caches(SW 壳缓存会吊旧版,见 TODO 已知项)。

## A. 数据管线(worker / D1)

| # | 用例 | 步骤 | 预期 | 实测 |
|---|------|------|------|------|
| A1 | fetch 幂等(游标停止) | 重触发 `POST /api/enrich/run?mode=blog-fetch` | 第二轮 `inserted` 远小于首轮 102(seen-set 命中即跳,只收新文),不重复入库 | 待跑 |
| A2 | podcast fetch 幂等 | 同上 `mode=podcast-fetch` | 同 A1(首轮 110) | 待跑 |
| A3 | workflow 完成率收敛 | D1 查 `workflow_completed_at NOT NULL` 占比 | ≥95%,且**无 is_relevant=0 而 wc_at IS NULL 的行**(三终态都写 gate) | 待跑 |
| A4 | is_ai gate 生效 | D1 查 is_relevant 分布 | blog 存在 is_relevant=0 的行(NVIDIA/微软主 feed 噪音被滤);该类行不出现在 /api/items | 待跑 |
| A5 | 翻译覆盖率 | D1 查 _zh 字段长度 | blog:title_zh+ai_summary_zh ≈100%、body_markdown_zh ≥95%;podcast:shownotes_zh ≥90%、A 档 transcript_text_zh >0 条 | 待跑 |
| A6 | R2 封面迁移 | D1 抽查 `extra.cover_image` | 以 `/r/blog/` 或 `/r/podcast/` 开头(SHA-256 key),GET 该路径 200 | 待跑 |

## B. API 面(staging-api)

| # | 用例 | 步骤 | 预期 | 实测 |
|---|------|------|------|------|
| B1 | 复合 filter | `GET /api/items?source_type=blog,podcast&sort=published_at&limit=30` | 200,items 含两种 source_type,严格 published_at 倒序 | 待跑 |
| B2 | 列表瘦身(剥+截) | 检查 B1 响应单条 | 单条 ≤5KB;extra 无 body_markdown(_zh)/transcript(_zh)/shownotes(_zh);content/content_translated ≤280 字符 | 待跑 |
| B3 | 单条 full | `GET /api/items/<blog id>`(带浏览器 UA) | 200,extra 含完整 body_markdown + body_markdown_zh | 待跑 |
| B4 | 7 天窗 | B1 首页所有 published_at | 均 ≥ now-7d(几个月前的旧单集不出现在首页) | 待跑 |
| B5 | 去重次源隐藏 | `/api/items` SQL 含 `dedup_of IS NULL` 过滤(代码断言)+ 当前数据 dedup_of 全 NULL → 不减条数 | 列表条数 = relevant 且 wc_at 非空条数(7 天窗内) | 待跑 |

## C. 前端流内(staging.ai-feeds.com)

| # | 用例 | 步骤 | 预期 | 实测 |
|---|------|------|------|------|
| C1 | tab 首位 | 打开 `/`,看 chip/列顺序 | 「官方新闻」紧跟「全部」,为第一个源 tab;PC 多列第一列 | 待跑 |
| C2 | 混排 | 官方新闻列滚动 | blog 卡(右侧缩略图 news-card 式)与 podcast 卡(72×72 封面+play SVG)混排,时间倒序(相对时间单调递增) | 待跑 |
| C3 | 卡片合规 | 检查两种卡 | 无互动数行;byline = logo+名称+时间+(blog)阅读时长/(podcast)IconClock 时长;A 档显示「有文字稿」chip;**零 emoji icon** | 待跑 |
| C4 | 无排序切换器 | 官方新闻列头 | 不显示「时间/热门」SortSelector | 待跑 |
| C5 | 无 30s 轮询 | 停留 >35s 观察网络 | 不发 `since=` 轮询请求(白名单只 x_list);不弹「N 条新推文」banner | 待跑 |

## D. 前端抽屉

| # | 用例 | 步骤 | 预期 | 实测 |
|---|------|------|------|------|
| D1 | blog 正文译文 | 点开外文 blog 卡 | 抽屉 mount 自拉 full item;正文显示**中文译文**(toggle 默认「译文」);标题中译+英文原题 | 待跑 |
| D2 | 译/原 toggle | 点「原文」再点「译文」 | 切英文原文/中文译文;用户手切后不被自动覆盖 | 待跑 |
| D3 | podcast 抽屉 | 点开 A 档播客(如 Practical AI) | audio 播放器 + ELI25 摘要 + shownotes 中译 + 「文字稿 英译中」折叠区(展开有全文) | 待跑 |
| D4 | audio preload=none | 打开 podcast 抽屉观察网络 | **零**对音频 CDN(megaphone/acast/transistor 等)的请求;点播放才加载;时长仍显示(extra.duration_sec) | 待跑 |
| D5 | B/C 档降级 | 点开无文字稿播客(如 Gradient Dissent) | 无文字稿区或显式「暂无」;不显示空壳;摘要仍有 | 待跑 |
| D6 | 外链 label | 两种抽屉底部 | blog「阅读原文」/ podcast「在原平台收听」,SVG 图标非 emoji | 待跑 |

## E. 深链与导航

| # | 用例 | 步骤 | 预期 | 实测 |
|---|------|------|------|------|
| E1 | /o/ 频道直达 | 冷打开 `/o/` | 不白屏,落官方新闻 tab | 待跑 |
| E2 | 点卡片 URL 变化 | 流内点开任一卡 | URL 变 `/o/blog%3A...` 或 `/o/podcast%3A...`(push 历史) | 待跑 |
| E3 | 关闭回流内 | 抽屉点关闭/返回 | 回 `/o/` 流内,**不退出站点** | 待跑 |
| E4 | 冷启动深链 | 新开页直进 `/o/<id>` | 抽屉直接打开该条;关闭后回 `/o/` 频道(main.tsx seed 垫底) | 待跑 |

## F. C 端打开速度(本轮 4 项优化验证)

| # | 用例 | 步骤 | 预期 | 实测 |
|---|------|------|------|------|
| F1 | 排序索引 | D1 `EXPLAIN QUERY PLAN`(官方新闻查询) | `SEARCH items USING INDEX idx_items_feed_src_pub`(非全表 SCAN;IN 双值后小集合排序可接受) | 待跑 |
| F2 | TTFB 同量级 | curl 官方新闻 vs x_list 各 3 次 | 官方新闻 TTFB 与单源基线差距 <200ms | 待跑 |
| F3 | 列表截断生效 | B1 响应 content 长度 | blog/podcast 所有 content/content_translated ≤280 | 待跑 |
| F4 | 预取复合键命中 | 打开 `/` 等 ~5s(空闲预取),切官方新闻 tab | 不显示 skeleton(FEED_CACHE 命中复合键 "blog,podcast"),无重复首页请求或仅 silent refetch | 待跑 |
| F5 | eager 封面 | 官方新闻列前 3 卡封面 img | `loading=eager` + `fetchPriority=high`;第 4+ 卡 lazy | 待跑 |

## G. 回归(不伤现有)

| # | 用例 | 步骤 | 预期 | 实测 |
|---|------|------|------|------|
| G1 | X 流正常 | 切「动态」tab | 卡片正常、排序正常(content 截断只对 clawhub/blog/podcast) | 待跑 |
| G2 | 其它源抽屉正常 | 点开 GH/HF 各一条 | 渲染正常(TweetDrawer 路由链未破坏) | 待跑 |
| G3 | track beacon 修复 | POST /api/track 无 header、body 带 `_did` | 200(原 400);无 _did 且无 header 仍 400 | 待跑 |
| G4 | worker tsc 基线 | `npx tsc --noEmit` | 错误数 = 24(全为既有,Phase 1 文件零错) | 待跑 |
| G5 | dashboard build | `npm run build:staging` | 零 error | 待跑 |

---

## 执行结果汇总

(自验收完成后回填)
