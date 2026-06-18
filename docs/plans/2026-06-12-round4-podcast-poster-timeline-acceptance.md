# Round 4 验收:播客海报/抽屉信息升级 + 话题脉络时间轴

> 2026-06-12 | 分支 `feat/blog-podcast-sources` | 环境 staging
> 触发:PM 对真实分享海报截图的 5 条反馈 + 「节目简介应在话题脉络上方」追问。
> 执行约定:所有用例由 Claude 在 staging 实测,问题修完后才交 PM 验收。

## 一、本轮改动清单

### Worker

| # | 改动 | 文件 |
|---|------|------|
| 1 | 新增 `summarizeTimelineForPodcast`:拉 transcript_url 的 VTT 逐字稿 → 解析 cue → 压缩成带时间戳 digest → `deepseek-v4-flash` 按奥卡姆剃刀提炼 6-12 个主题节点(`{ts, topic, speaker?, point}`)→ 写 `extra.timeline` | `feeds/classify-translate.ts` |
| 2 | digest 锚点窗口自适应全集时长(≈40 窗均摊 10500 字预算,每窗截断),保证时间轴覆盖**整集**而非开头(测试中发现的覆盖率 bug,见 §四-1) | 同上 |
| 3 | 模型选型:timeline 用 flash 而非 pro —— pro 实测单条 120s+ 触发双超时(curl 120s + LLM 60s),flash 27s/条且抽取质量足够 | 同上 |
| 4 | podcast workflow fan-out 增加 `timeline-summary` 步(fan[3]);完成门仍只看 enrich + cn_sensitive,timeline 失败不阻塞入库 | `workflows/podcast-pipeline.ts` |
| 5 | 新增 `mode=podcast-timeline-backfill` 存量补齐(默认 limit 5);B/C 档(无真字幕)写 `timeline=[]` 收敛,不会反复扫描 | `index.ts` |
| 6 | guests 抽取修复:**始终**把与 hosts 重名的剔除 + 覆盖写(旧版"已有值就跳过"导致错误数据永不修正) | `feeds/classify-translate.ts` |
| 7 | 存量数据手术:已入库的 `guests` 含主持人名的条目,批量剔除(见 §四-2) | D1 SQL |

### Dashboard

| # | 改动 | 文件 |
|---|------|------|
| 8 | 新增图标:IconMic(主持)/ IconUser(嘉宾)/ IconAudioLines(音频波形) | `components/icons.tsx` |
| 9 | PodcastCard 海报态:徽标「收听播客 · 时长」加 `whitespace-nowrap` 不再换行;图标从播放三角换成**波形**(不与封面播放按钮重复);主持/嘉宾分行带图标;新增「本期话题脉络」前 5 条 | `components/PodcastCard.tsx` |
| 10 | PodcastDrawerBody:meta 行下新增主持/嘉宾行(带图标,嘉宾对主持去重);新增「本期话题脉络」竖向时间轴(时间点·主题·观点·说话人);「概览」只认 LLM 摘要(不再兜底 shownotes,消除与「节目简介」重复);区块顺序调整为 概览 → 节目简介 → 话题脉络 → 文字稿 | `components/PodcastDrawerBody.tsx` |
| 11 | 海报源 chip 补中文:blog →「官方新闻」/ podcast →「官方新闻 · 播客」(此前回退英文 source_type,全站唯一英文离群值) | `components/PosterCanvas.tsx` |
| 12 | types:`extra.timeline` 字段(worker `feeds/types.ts` + dashboard `types.ts` 同步) | 两侧 types |

### 抽屉三个内容区块的语义(PM 追问的澄清)

| 区块 | 来源 | 内容 |
|------|------|------|
| 概览 | **LLM 生成**(deepseek) | 整集压成两三句的 ELI25 摘要,含模型自己的判断 |
| 节目简介 | **抓取原文**(RSS,外文翻译) | 播客作者写的官方单集描述 |
| 本期话题脉络 | **LLM 生成**(读逐字稿) | 时间点 · 主题 · 核心观点 · 说话人的时间轴 |

排序逻辑:由浅入深 —— 最短摘要 → 官方描述 → 话题地图 → 完整文字稿;话题脉络紧贴文字稿,因为它是逐字稿的「索引版」。

## 二、W 组:Worker / 数据用例

| # | 用例 | 验证方式 | 预期 | 结果 |
|---|------|---------|------|------|
| W1 | 时间轴节点质量 | 全量扫描已生成 timeline:节点数、ts 格式、ts 升序、topic/point 非空 | 节点 4-14;ts 形如 M:SS / H:MM:SS 且升序;字段齐 | ✅ 111 条非空(可显示的多节点 110 条,节点 6-14);ts 格式错 0、乱序 0、字段缺 0 |
| W2 | 时间轴覆盖整集 | 末节点 ts ÷ duration_sec,全量统计 | 中位数 ≥70%,无成批"只有开头"现象 | ✅ 修复后全量:**中位数 91%、P10 80%、<50% 的 0 条**(修复前中位数 21%、93% 条目不过半) |
| W3 | 幂等 | 对已有 timeline 的条目重跑 backfill | 不重复生成(found 不含已生成条目) | ✅ 全量跑完后再调 found=0,elapsed 37ms |
| W4 | B/C 档收敛 | 候选只取 `is_relevant=1 且 tier='A'`;A 档烂源跑过一次后 | 写 `timeline=[]`,不再进候选 | ✅ 3 条 A 档烂源写 `[]` 收敛;B/C 档被候选条件排除,从不进队 |
| W5 | 存量补齐清零 | backfill 循环跑完后查候选数 | 待补=0;有字幕条目全部非空 | ✅ 30 轮跑干(drained);剩余 10 条 `is_relevant=NULL`(冷启动占位,不进 feed 展示)按设计排除 |
| W6 | guests 不再含主持人 | 全量扫描 hosts ∩ guests | 交集为空(存量手术 + 增量过滤双保险) | ✅ 手术 5 条(全是 Practical AI 双主持集,guests 清成 [])后全量扫描交集=0 |
| W7 | 新条目 pipeline E2E | 手术清掉 1 条(Don Beyer 集)的完成标记,重触发 workflow | 重新走完:enrich 重写(guests 已去重)、timeline 生成、cn_sensitive 非空、workflow_completed_at 写回 | ✅ 完成标记重写;cn_sensitive=0;hosts=[Chris Benson] guests=[Don Beyer](管道内去重生效);timeline 12 节点末 36:02。**额外收获:顺手把 23 条历史卡住的不完整条目全部重跑治愈,未完成数归零** |
| W8 | 列表 API 含 timeline | `/api/items?source_type=blog,podcast` 取该条 | `extra.timeline` 在列表负载里(海报从流内 item 渲染,必须带);重字段(transcript/shownotes/body)仍剥离 | ✅ 列表含 timeline;transcript/shownotes/body_markdown 均剥离 |
| W9 | 合规过滤回归 | 取一条 `cn_sensitive=1` 的 item 走单条 API | 404,列表也不出现 | ✅ 带浏览器 UA 请求返回 404,列表 30 条无泄漏。(注:无 UA 的 curl 会被 WAF 拦成 403,与业务逻辑无关) |
| W10 | 官方新闻混排回归 | 列表 API 按 published_at 排序 | blog+podcast 混排,时间倒序无乱序 | ✅ 30 条 = blog 22 + podcast 8,严格时间倒序 |
| W11 | TS 编译 | `npx tsc --noEmit` | 24 个历史基线错误,0 新增 | ✅ worker 24(基线)/ dashboard build 通过 |

## 三、F 组:前端用例(staging 实测)

| # | 用例 | 验证方式 | 预期 | 结果 |
|---|------|---------|------|------|
| F1 | 流内卡片回归 | 官方新闻频道 podcast 卡片(非海报态) | 无徽标/主持嘉宾/时间轴泄漏;无「有文字稿」;时长带时钟图标 | ✅ DOM 结构精确扫描:0 个结构化主持/嘉宾行、0 徽标、0 时间轴;摘要正文里的「嘉宾」字样是源数据文本,合法 |
| F2 | 抽屉区块顺序 | 打开有 timeline 的播客抽屉 | 概览 → 节目简介 → 本期话题脉络 → 文字稿(折叠) | ✅ 顺序正确,文字稿默认折叠 |
| F3 | 抽屉主持/嘉宾 | 同上 | 麦克风图标+主持行;人像图标+嘉宾行 | ✅ 主持 Chris Benson、Daniel Whitenack / 嘉宾 Craig McLuckie,均带图标 |
| F4 | 抽屉嘉宾去重 | 打开 guests==hosts 的条目(Practical AI 部分集) | 只显主持行,无嘉宾行 | ✅ Zero Trust 集只显主持行(双保险:显示层去重 + 数据手术后 guests=[]) |
| F5 | 抽屉时间轴渲染 | 看「本期话题脉络」 | 竖轴圆点;每节点 时间戳+主题(粗体)+观点+说话人;末节点 ts 接近全集时长 | ✅ 渲染齐全;末节点 44:40(全集 48:09) |
| F6 | 概览不重复 | 找无 ai_summary_zh 的播客 | 无「概览」块,「节目简介」正常出原文(两块不再同文重复) | ✅(代码守卫)staging 所有完整条目均有 LLM 摘要,无现成数据可触发;代码改为 `summary = ai_summary_zh \|\| ai_summary`(不再兜底 shownotes),逻辑上不可能重复 |
| F7 | 海报徽标 | 渲染播客海报 | 「收听播客 · 48:09」单行;波形图标(非播放三角) | ✅ nowrap 生效、单行;svg path 确认是 audio-lines,无播放三角 |
| F8 | 海报主持/嘉宾 | 同上 | 带图标分行;嘉宾对主持去重 | ✅ 两行齐;Zero Trust 海报只显主持 |
| F9 | 海报话题脉络 | 同上 | 最多 5 条「时间戳+主题」;海报高度明显增加 | ✅ 5 条;**追加优化:超 5 条时均匀采样(首/¼/½/¾/尾)**,MCP 集海报展示 1:25→11:42→21:27→33:02→44:40 横跨整集,而非只有开头 |
| F10 | 海报源 chip | blog 海报 + podcast 海报 | 「官方新闻」/「官方新闻 · 播客」中文 | ✅ 此前回退英文 source_type(全站唯一英文离群值),已补 SOURCE_LABELS |
| F11 | blog 海报回归 | 渲染一条 blog 海报 | 标题全文不截断;「阅读约 N 分钟」;右侧缩略图 | ✅ NVIDIA 集验证,三项齐 |
| F12 | 无时间轴播客兜底 | 打开 B/C 档(timeline=[])条目 | 抽屉/海报均不出「话题脉络」区块,无报错 | ✅ 抽屉正常渲染,无该区块,无 JS 报错 |

## 四、测试中发现并修复的问题

### 1. 时间轴只覆盖节目开头(严重,W2 发现)

- **现象**:首批 60 条已生成时间轴,末节点位置中位数仅在全集 **21%** 处,93% 条目覆盖不过半 —— 用户拿到的是"前 10 分钟的话题脉络"。
- **根因**:digest 用固定 45s 锚点累积全文(40min 节目 ≈3-4 万字),再从头 `slice(11000)`,只剩前 ~13 分钟。
- **修复**:锚点间隔改为 `max(45, 全集时长/40)`,每窗文字截到均摊预算(`10500/窗数`),digest 覆盖整集;已生成的 timeline 全部清掉重新生成。

### 2. 存量 guests 含主持人(PM 发现的数据 bug 的存量面)

- worker 侧增量过滤只对**未来**的抽取生效;已入库的错误数据(Practical AI 等)需要一次性 SQL 手术剔除。结果见 W6。

### 3.(前置已修)pro 模型双超时

- timeline 最初按「长上下文综合用 pro」选型,实测单条 2 分钟跑不完(LLM 60s 超时 + curl 120s 超时双卡)。降级 flash 后 27s/条,质量经 W1/W2 复核没有下降 —— 结构化抽取确实不需要 pro。

### 4. 烂源 VTT 防御(W1 离群排查发现)

- **现象**:MSR Podcast 一条 51 分钟节目只生成 1 个节点(0:11,覆盖 0%)。
- **根因**:托管方 Blubrry 的 VTT 文件本身是坏的 —— 1164 字节、8 个 cue,内容是微软招聘文案模板,不是节目逐字稿。**源数据垃圾,非代码 bug**。
- **防御(双层)**:① worker:digest < 600 字符直接跳过(正常 A 档逐字稿远超此值),写 `[]` 收敛;② 前端:单节点不渲染「话题脉络」区块(1 个点不成"轴",也兜住 2 分钟预告片这类合法但无意义的单节点)。

## 五、PM 验收指引(全部在 staging)

1. **抽屉**(F2-F5):打开 `https://staging.ai-feeds.com/o/podcast:practical-ai:78c8093da8eafe94`(MCP × Kubernetes,有真嘉宾 Craig McLuckie + 全集时间轴)
2. **嘉宾去重**(F4):`https://staging.ai-feeds.com/o/podcast:practical-ai:a23a8cbbad9a9ab3`(Zero Trust,只应显示主持行)
3. **海报**(F7-F11):staging 登录后任意播客点「分享」生成海报;blog 同理
4. **流内卡片**(F1):首页「官方新闻」频道滚动浏览

## 六、结论

**23 个用例全部通过**(F6 为代码守卫,无现成数据可触发)。测试过程中发现并修复 2 个真问题(时间轴覆盖率、烂源 VTT 防御)+ 1 个存量数据手术(guests 含主持)+ 2 个追加优化(海报均匀采样、源 chip 中文),并顺手治愈 23 条历史卡住的不完整条目。

**最终数据状态(staging)**:
- 可显示时间轴 110 条(节点 6-14,覆盖率中位数 91%,无一低于 50%)
- guests ∩ hosts = 0;cn_sensitive 全量非空;workflow 未完成数 = 0
- 调试路由已删,临时截图已清,staging worker + dashboard 均为干净最终版

**遗留(不阻塞验收)**:
- 10 条 `is_relevant=NULL` 冷启动占位条目无时间轴(不进 feed,按设计排除)
- prod 未动;合 main 上线时跑 migration 021 + 各 backfill(时间轴生成约 1 小时后台)
- Google 实时音频翻译仍在待讨论清单
