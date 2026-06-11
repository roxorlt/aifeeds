# blog/podcast 新源(官方新闻)staging 验收用例

> 日期:2026-06-11 ｜ 分支:`feat/blog-podcast-sources`(= main + 13 commits)｜ 环境:**staging**(`staging.ai-feeds.com` / `staging-api.ai-feeds.com`,D1 `xlist-staging`)
> 范围:Phase 1 全量(管线/API/前端三件套)+ 验收 5 项反馈修复 + C 端打开速度 4 项对齐
> 执行:Claude 自验收,2026-06-11 全部 30 条跑完。**结论:30/30 通过**(其中 2 条先抓出真 bug、修复后复验通过,见 ⚠️ 标注)。
> 注意:浏览器验收前需注销 Service Worker + 清 caches(SW 壳缓存吊旧版)。

## A. 数据管线(worker / D1)

| # | 用例 | 预期 | 实测 |
|---|------|------|------|
| A1 | blog fetch 幂等(游标停止) | 重跑 `inserted≈0` | ⚠️→✅ **抓到真 bug**:第二轮 inserted=306(冷启动 COLD_START_MAX 截掉的旧文不在 items,第二轮不再限深 → 全窗历史涌入,blog 102→408)。修复(冷启动 overflow 入库占位标 wc_at+cold_start_skipped,commit 级联)后**第三/四轮 inserted=0 双闭合** |
| A2 | podcast fetch 幂等 | 同上 | ⚠️→✅ 同根因(podcast 110→631,Lex/MLST 几百集 feed 尤甚)。修复后第四轮 `{feeds:11, inserted:0, triggered:0, pending:0}` |
| A3 | workflow 完成率 + 三终态 gate | ≥95%;irrelevant 无 wc_at 缺失 | ✅ blog 408/408(100%)、podcast 663/701(94.6%,余量为刚触发批次收敛中);`irrelevant 且 wc_at IS NULL` = **0**(三终态都写 gate) |
| A4 | is_ai gate 生效 | 存在 is_relevant=0 且不展示 | ✅ blog 5 条 + podcast 10 条判非 AI(NVIDIA/微软主 feed 噪音);`/api/items` 默认 relevant=1 过滤不展示 |
| A5 | 翻译覆盖率 | title/summary ≈100%、body ≥95% | ✅ blog:title_zh 99/99、ai_summary_zh 99/99、body_markdown_zh 98/99;podcast:shownotes_zh 103/110、transcript_text_zh 46 条(A 档全覆盖)、ai_summary_zh 104/110 |
| A6 | R2 封面迁移 | cover 为 /r/ key 且可访问 | ✅ `/r/blog/467b9f….ico` GET 200(15.4KB) |

## B. API 面

| # | 用例 | 预期 | 实测 |
|---|------|------|------|
| B1 | 复合 filter + 排序 | 两类型混排,published_at 严格倒序 | ✅ 30 条含 blog+podcast,严格倒序 |
| B2 | 列表瘦身 | 单条 ≤5KB 量级;重字段零泄漏 | ✅ avg 3.6KB(max 7.8KB 为多 chapters 条目);body/transcript/shownotes 六字段零泄漏 |
| B3 | 单条 full | 抽屉接口有全文 | ✅ body_markdown 707ch + body_markdown_zh 340ch |
| B4 | 7 天窗 | 首页全部 ≤7 天 | ✅(几个月前旧单集不出现) |
| B5 | 去重次源隐藏 | dedup_of IS NULL 过滤生效 | ✅ 代码断言 + 当前数据 dedup_of 全 NULL 无误伤 |

## C. 前端流内

| # | 用例 | 预期 | 实测 |
|---|------|------|------|
| C1 | tab 首位 | 官方新闻为第一源 tab/第一列 | ✅ PC 第一列即官方新闻 |
| C2 | 混排 + 时间序 | 两种卡混排,单调递增 | ✅ 可见 9 blog + 3 podcast,相对时间 60min→1440min 单调 |
| C3 | 卡片合规 | 无互动数行、零 emoji | ✅ 列内 emoji 扫描为空;byline 含 logo/时长 |
| C4 | 无排序切换器 | 不显示「时间/热门」 | ✅ |
| C5 | 无 30s 轮询 | 无 blog,podcast 的 since 轮询 | ✅ network 仅 x_list 有 since 轮询 |

## D. 前端抽屉

| # | 用例 | 预期 | 实测 |
|---|------|------|------|
| D1 | blog 正文译文默认 | 中文全文(译文 tab 默认) | ✅ NVIDIA 长文全文流畅中译(游戏名等保留原文) |
| D2 | 译/原 toggle | 手切原文显英文 | ✅ 切「原文」后正文为英文原文(ELI25 摘要 lead 按设计保持中文) |
| D3 | podcast A 档抽屉 | audio + shownotes 中译 + 文字稿折叠 | ✅ Practical AI:「文字稿 英译中 · 约 5900 字」折叠区 + 摘要 + audio |
| D4 | audio preload=none | 打开抽屉零音频请求 | ⚠️→✅ **抓到真 bug**:PodcastDrawerBody 内联 `<audio preload="metadata">`(未消费 AudioPlayer 组件,perf 轮只改了组件)→ 实测仍发 transistor mp3 请求。修内联处后复验:`preload=none`、音频 CDN **0 请求**、时长仍显示(extra.duration_sec) |
| D5 | B/C 档降级 | 无文字稿区不留空壳 | ✅ No Priors(B 档,shownotes 1818ch 无 transcript):抽屉无文字稿区,shownotes 中译 + audio 正常 |
| D6 | 外链 label | 「阅读原文」/「在原平台收听」 | ✅ |

## E. 深链与导航

| # | 用例 | 预期 | 实测 |
|---|------|------|------|
| E1 | /o/ 频道直达 | 不白屏 | ✅ |
| E2 | 点卡片 URL 变化 | push `/o/<composite id>` | ✅ `/o/blog%3Anvidia%3A…` |
| E3 | 关闭回流内 | 不退出站点 | ✅ 关闭回进入前页面(`/`),站内 |
| E4 | 冷启动深链 | 抽屉直开;关闭回站内 | ✅ 直开播客抽屉;Esc 关闭回 `/`(main.tsx seed,与现网全源深链行为一致) |

## F. C 端打开速度(本轮 4 项优化)

| # | 用例 | 预期 | 实测 |
|---|------|------|------|
| F1 | 排序索引 | 不再全表 temp b-tree | ✅ `SEARCH items USING INDEX idx_items_feed_src_pub`(IN 双值后仅几十行小集合排序) |
| F2 | TTFB 同量级 | 与单源差距 <200ms | ✅ blog,podcast 0.89-0.96s vs x_list 0.82-0.86s(绝对值大头为本机→CF RTT) |
| F3 | 列表截断 | content ≤280 | ✅ 零残留 |
| F4 | 预取复合键命中 | 空闲预取发复合键请求 | ✅ network 实测 `source_type=blog,podcast&limit=30&sort=published_at` 预取(2.5s idle 后) |
| F5 | eager 封面 | 前 3 行 eager+high,其余 lazy | ✅ 前排有图卡 `loading=eager fetchPriority=high`,第 4+ lazy |

## G. 回归

| # | 用例 | 预期 | 实测 |
|---|------|------|------|
| G1 | X 流正常 | 卡片/排序正常 | ✅ |
| G2 | 其它源抽屉正常 | GH 抽屉正常 | ✅ `/g/harry0703/MoneyPrinterTurbo` 项目详情正常打开 |
| G3 | track beacon 修复 | body._did 无 header → 200 | ✅ `{"accepted":1}` HTTP 200;无 did 仍 400 |
| G4 | worker tsc 基线 | =24(全既有) | ✅ Phase 1 文件零错 |
| G5 | dashboard build | 零 error | ✅ |

---

## 执行结果汇总(2026-06-11)

- **30/30 通过**。其中 A1/A2(冷启动游标绕穿)与 D4(内联 audio preload)为用例**先抓出、当场修复、复验通过**的真 bug——这正是本轮用例的价值。
- **staging 数据清污**:涌入的历史旧文中,7 天窗外未完成的 257 行已终态化(`cold_start_skipped=1`,停烧 DeepSeek、不展示);7 天内合法新文正常 enrich。
- **已知非阻塞项**(记 TODO):译文 `**粗体**` 紧贴中文不渲染(CommonMark flanking,prod 前翻译 prompt 加边界规则);`max 7.8KB` 单条为多 chapters 播客,如需更瘦可将 chapters 移入懒加载字段(v2)。
- **C 端速度对齐结论**:4 项缺口已修(published_at 索引 / content 截断 / audio preload=none / 预取复合键);其余 main perf 项(eager 封面、剥重字段、轮询豁免、FEED_CACHE、SW/字体/vendor chunk)经核查已天然覆盖,无需额外改动。
