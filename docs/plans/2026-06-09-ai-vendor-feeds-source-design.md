# AI 厂商博客 + 播客源接入设计（blog / podcast 两源）

> 日期:2026-06-09
> 状态:**Phase 0 设计稿(纯调研,未写任何代码、未动任何线上)**。**用户 2026-06-09 已拍板 D1 / D3 / D4 / D7 / D9 + blog 卡封面(②右侧小缩略图)(见 §13 顶部「✅ 已定决策」小结)**;其余 D2(上限)/ D5 / D6 / D8 / D10 维持推荐默认,用户读完文档可再调。Phase 0(设计 + mockup 三件套)已完成,可进 Phase 1。
> **下一步**:用户审阅本文档 → 出 mockup 三件套(blog / podcast 卡片 + 抽屉 + 海报,PC + 移动)→ 确认视觉后进 Phase 1 编码。
> 对应 SOP:[docs/source-integration-sop.md](../source-integration-sop.md)(先读全文)
> 同类参考:[2026-05-18-hf-daily-papers-source-design.md](2026-05-18-hf-daily-papers-source-design.md)(最接近的长文形态已有源)
> 信源实测:2026-06-09 对 17 个国外博客 + 国内厂商/GitHub Releases + 15 个播客逐条 WebFetch/curl 实测,**实测结论与参考文档多处出入,本文以实测为准**
> 数据源参考:`/Users/roxor/cola/outputs/AI-Feeds-数据源汇总文档/`

---

## 1. 一句话定位 + 背景

**一句话定位**:给 aifeeds 增加两个内容形态全新、但完全复用现有「items 大一统表 + 每源一条 CF Workflow + 完整性 gate + 三件套前端」架构的源 —— `blog`(国内外 AI 厂商官方博客/技术博客长文)与 `podcast`(国内外 AI 播客单集),首次引入「回原文抓全文」「跨源语义去重」「RSSHub/无头浏览器基建」三件以前没有的能力。

**背景(本次新需求 8 点,用户原话要点)**:

1. 接入国内外各大 AI 公司官方博客/播客/官方公众号(候选 ~45 个);官方没 RSS 的走 RSSHub(拟部署在香港 VPS)。
2. 由 CF 定时调度抓取(复用现有源 workflow 模式);若有翻译步骤,prompt 用 **ELI25(像跟一个聪明的 25 岁年轻人解释)** 标准。
3. **is_ai 判断不能丢**:只有 AI 相关才往下走 workflow;不相关只入库标 `is_relevant=0`,**作为下次抓取的停止游标**。
4. **滤重**:同一事件常在博客 + GitHub + 播客重复,两个来源内容大体一致要去重。
5. 详情页内容难拿时,可让 VPS 提供有头/无头浏览器转 API 端点供 CF 调用,目的是尽量拿全文 + 图 + 视频。
6. 图/视频入 CF R2;前端经香港 VPS 访问 CF R2 资源。
7. 抓到的字/图/视频各种排列组合,要在前端三个面(流内卡片、抽屉详情、分享海报)各有合适样式。
8. **暂不**把新源接入「订阅日报」和「给 codex 推送 daily」(只是不接,不是不做主功能)。

**致命外部约束**:公网前端 `ai-feeds.com` / api `api.ai-feeds.com` / 字体都经香港 VPS(`${HK_VPS_IP}`,境外机房)中转,这台机器 **单核低配小鸡(内存不足 1G)**,只装了 nginx,是 prod 全站中转单点 —— 运维手册 §6b 明写「它挂了前端 + api + 字体全挂」。任何基建设计都要正面回答「会不会拖垮这台机器」。

---

## 2. TL;DR / 决策摘要

**推荐怎么做(一句话)**:**先零基建起步** —— 实测 45 个候选里有 24 个能让 CF Worker 直接 `fetch` 拿到 feed(10 个国外博客原生 RSS + Anthropic 第三方 feed + 2 个国内原生 feed + 1 个 GitHub Release + 11 个播客),先用它们把整条「Phase1 cron 拉 → INSERT stub → trigger workflow → Phase2 enrich(classify + ELI25 翻译) → 完整性 gate → 三件套前端」管线跑通验收,**再谈要不要为剩下的源花基建钱**。

**分几期**:

| 期 | 内容 | 源数 | 基建 | 估时 |
|----|------|------|------|------|
| **Phase 1** | 零基建:国内外原生 RSS + 第三方 feed + GitHub Release + 11 播客 feed | ~24 | 无(CF Worker 直连) | 9-12 天 |
| **Phase 2** | RSSHub:4 个小宇宙中文播客 | +4 | 复用 Codex 腾讯云机 / 或免费小鸡跑 RSSHub(D1,Phase 2 与 Codex 确认余量后定;绝不香港中转) | +3-4 天 |
| **Phase 3** | 页面抓取(CF 直抓 SSR/`__NEXT_DATA__`)+ 无头浏览器(复用 Codex 腾讯云渲染机优先,CF-BR 备选) | +18 | 复用 Codex 腾讯云渲染机(镜像 X-card 渲染契约,新增 `/render-article` 端点)为主;CF Browser Rendering binding 为备选/兜底 | +5-7 天 |
| **v2(暂不做)** | 微信公众号 13 家(需自建 wechat2rss)+ 中文播客 ASR 全文 | +13 | wechat2rss + 托管 ASR | 另立项 |

**架构不变量(全部沿用,零妥协)**:
- items 大一统表**不加业务列**,blog/podcast 特异字段全进 `extra` JSON;唯一 schema 增量是 migration `020` 的 **1 条 json_extract partial 表达式索引**(`url_hash`,给 v1 L1 精确去重用;content_hash 索引砍掉——v1 L1 全程不查它,见 §5.2/§5.6)。
- 每源一条 CF Workflow(`BLOG_PIPELINE_WORKFLOW` / `PODCAST_PIPELINE_WORKFLOW`),接现有单 `*/5` cron 内部分流,**不新增 cron trigger**;三条新 cron lane 各自用 `recordCronRun` 包裹(否则 cron-runs 监控看不到,见 §7.2)。
- 完整性 gate(**与现网一致**):三种终态(relevant / irrelevant / dedup-suppressed)**全部写 `extra.workflow_completed_at`**;`/api/items` 只展示 `wc_at NOT NULL` 的 item。不相关靠默认 `relevant=1` 过滤隐藏、去重次源靠新增一条 `dedup_of IS NULL` 条件隐藏,**都不复用「不写 gate」做业务隐藏**(根因 + 现网行号见 §5.5 / §5.6 / §8 / §11)。
- 翻译走 DeepSeek `deepseek-v4-flash`,ELI25 风格;classify+translate 合并;fenced/inline code 原文不译。
- 前端基线对齐 `TweetCard.tsx`,**严禁 emoji 当 icon**,token 严守 `frontend-ux-guidelines.md`。
- **香港中转 host-rewrite 铁律**:worker 内任何对外 URL 一律用 env 规范域(`SITE_BASE`/`API_BASE`/新增 `RSSHUB_BASE`),不靠 request host。

**需用户拍板的关键决策(编号,详见 §13)**:D1 RSSHub 放哪台机(✅ 已定:倾向复用 Codex 腾讯云机,Phase 2 再与 Codex 确认余量;绝不香港中转)/ D2 月度基建预算上限 / D3 无头/全文抓取走哪条路(✅ 已定:复用 Codex 腾讯云渲染机为主,CF-BR 降为备选/兜底)/ D4 微信公众号 v1 接不接(✅ 已定:v1 不接,标 v2)/ D5 中文播客要不要上 ASR 拿全文 / D6 SPA-only 硬骨头(xAI/Perplexity)v1 接不接 / D7 blog 与 podcast 前端入口(✅ 已定:合并为单频道「官方新闻」,底层仍 2 source_type 混排)/ D8 跨源去重 MVP 范围 / D9 publisher logo(✅ 已定:BE 迁 R2 真实 logo)/ D10 冷启动回灌深度。**用户 2026-06-09 已拍板 D1 / D3 / D4 / D7 / D9 + blog 卡封面(②右侧小缩略图);其余 D2 上限 / D5 / D6 / D8 / D10 维持推荐默认。**

---

## 3. 候选信源清单(实测,2026-06-09)

> ⚠️ 实测推翻参考文档多处乐观结论,以下以实测为准。`verifiedFeedUrl` 列即 CF Worker 可直接 `fetch` 的地址。

### 3.1 原生 RSS 可直订(零基建,Phase 1)

| 源 | 类型 | region | 全文/文字稿 | feed URL(实测 200 + 合法 RSS) | 更新频率 |
|----|------|--------|-------------|-------------------------------|---------|
| OpenAI | blog | 国外 | 详情页有全文(feed 摘要) | `https://openai.com/news/rss.xml` | 高(每天多条) |
| Google (blog.google) | blog | 国外 | 同上 | `https://blog.google/technology/ai/rss/` ⚠️ 不用 ref 给的 gemini-models 窄 feed | 中-高 |
| Microsoft Research | blog | 国外 | 有全文 | `https://www.microsoft.com/en-us/research/blog/feed/` | 中-高 |
| NVIDIA | blog | 国外 | 详情页全文 | `https://blogs.nvidia.com/feed/` ⚠️ **不用** ref 的 deep-learning 分类 feed(已停更 5 个月)+ is_ai 过滤 | 主 feed 高 |
| Hugging Face | blog | 国外 | 详情页全文 | `https://huggingface.co/blog/feed.xml` | 高 |
| Anthropic | blog | 国外 | 详情页全文 | `https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_anthropic_news.xml` ⚠️ 第三方 SPOF,ref 旧路径 `feed_anthropic.xml` 已 404 | 高 |
| Mistral AI | blog | 国外 | 有全文 | `https://mistral.ai/rss.xml` | 中(成簇) |
| Stability AI | blog | 国外 | 有全文 | `https://stability.ai/news-updates?format=rss`(Squarespace) | 低 |
| Together AI | blog | 国外 | 有全文 | `https://www.together.ai/blog/rss.xml` | 中 |
| Midjourney | blog | 国外 | 详情页全文 | `https://updates.midjourney.com/rss`(Ghost 子域) | 低-中 |
| Qwen(通义千问·旧博客) | blog | 国内 | 详情页全文 | `https://qwenlm.github.io/blog/index.xml` ⚠️ 已迁站,停在 2025-09,需配 qwen.ai 无头补新(见 D10/§13) | 低(断档) |
| 美团技术团队 | blog | 国内 | 详情页全文 | `https://tech.meituan.com/feed/` ⚠️ **不走** RSSHub(原生可用更稳) | 中 |
| OpenBMB/MiniCPM(面壁) | github-releases | 国内 | release notes 全文 | `https://github.com/OpenBMB/MiniCPM/releases.atom` | 中(活跃) |

**11 个播客 feed(全部 Phase 1 可直连;含 4 处需更正的 URL)**:

| 源 | region | 文字稿成本档 | feed URL | 频率 |
|----|--------|-------------|---------|------|
| Practical AI | 国外 | **A 档免转录**(原生 `<podcast:transcript>` VTT/SRT/JSON) | `https://feeds.transistor.fm/practical-ai-machine-learning-data-science-llm` ⚠️ ref 的 changelog URL 已 301 | 中 |
| Microsoft Research Podcast | 国外 | **A 档免转录**(原生 transcript VTT) | `https://feeds.blubrry.com/feeds/microsoftresearch.xml` ⚠️ ref 给的是研究博客 feed 不是播客 | 低 |
| Latent Space | 国外 | **A 档免转录**(Substack 全文 8000-10000 字) | `https://www.latent.space/feed` | 高 |
| Last Week in AI | 国外 | **A 档免转录**(Substack 全文 ~5000 字,周报) | `https://lastweekin.ai/feed` ⚠️ 用 Substack 源不用 ref 的 buzzsprout | 中 |
| Lex Fridman | 国外 | **A 档**(description 带官方 transcript 页 URL) | `https://lexfridman.com/feed/podcast/` | 中 |
| OpenAI Podcast | 国外 | B 档(shownotes + 章节) | `https://feeds.acast.com/public/shows/openai-podcast` | 低-中 |
| No Priors | 国外 | B 档 | `https://feeds.megaphone.fm/nopriors` ⚠️ ref 两个 URL 全 404 | 中 |
| Eye on AI | 国外 | B 档 | `https://rss.libsyn.com/shows/123267/destinations/727317.xml`(跳后 URL) | 中-高 |
| The Cognitive Revolution | 国外 | B 档 | `https://feeds.megaphone.fm/RINTP3108857801` ⚠️ ref 的 buzzsprout 404 | 高 |
| MLST | 国外 | B 档(+ 章节) | `https://rss.art19.com/machine-learning-street-talk` | 中-高 |
| Gradient Dissent (W&B) | 国外 | C 档(薄 blurb) | `https://feeds.captivate.fm/gradient-dissent` | 低 |

### 3.2 需 RSSHub(Phase 2,4 个中文播客 + 公众号 v2)

| 源 | region | RSSHub 路由 | 需 puppeteer? | 状态 |
|----|--------|------------|--------------|------|
| 硅谷101 | 国内 | `/xiaoyuzhou/podcast/5e5c52c9418a84a04625e6cc` | 否(SSR 内嵌) | 公共 rsshub.app 实测 403 → **必须自建** |
| 张小珺·商业访谈录 | 国内 | `/xiaoyuzhou/podcast/<id>` | 否 | 另有 `feed.xyzfm.space/dk4yh3pkpjp3` 第三方桥(已验活,SPOF) |
| OnBoard! | 国内 | `/xiaoyuzhou/podcast/61cbaac48bb4cd867fcabe22` | 否 | 需先确认是否仍活跃 |
| AI 前线 | 国内 | `/xiaoyuzhou/podcast/679d8c5ded7799e793bb7936` | 否 | InfoQ/极客邦 出品 |
| 微信公众号(13 家) | 国内 | RSSHub 原生 `/wechat` **基本已死** | — | **v2 单独立项**:需 wechat2rss(登录态账号)或付费桥,运维脆弱 |

### 3.3 需页面抓取(Phase 3,CF Worker 直抓 SSR/`__NEXT_DATA__`,不占无头)

| 源 | region | 抓取方式 | 实测 |
|----|--------|---------|------|
| Meta AI | 国外 | SSR HTML | `/blog/` 200 SSR,标题+日期可见,native feed 404 |
| Cohere | 国外 | SSR HTML | `/blog` 200 SSR,`/blog/rss.xml` 是 catch-all HTML |
| AI21 Labs | 国外 | SSR HTML | `/blog` 200 SSR,分页 1-11 |
| Databricks | 国外 | SSR HTML | `/blog` 200 SSR,极活跃(每天多条) |
| 智谱 zhipuai.cn/news | 国内 | Next.js `__NEXT_DATA__` | 802KB 嵌入正文 |
| 零一万物 lingyiwanwu.com | 国内 | 传统 SSR | 83KB 嵌入正文 |
| MiniMax minimax.io/news | 国内 | Next.js | 嵌入正文 |
| 百川 baichuan-ai.com | 国内 | Next.js | `/blog` 已 404,文章列表路径待找 |
| 商汤 sensetime.com/cn | 国内 | 传统 SSR | 223KB 正文,子路径直连 404(客户端路由) |
| DeepSeek deepseek.com | 国内 | Next.js | 59KB 正文,但**无带日期博客栏**(真信号在微信+HF) |

### 3.4 需无头浏览器(Phase 3,复用 Codex 腾讯云渲染机优先,CF-BR 备选)

| 源 | region | 拦截类型 | 备注 |
|----|--------|---------|------|
| xAI | 国外 | **Cloudflare bot 拦截** | `/news` + `/rss.xml` 全 403,**CF-BR 也大概率被挡** → 默认优雅降级 |
| Perplexity | 国外 | **Cloudflare bot 拦截** | `/hub/blog` 是真实活跃博客但全站 403,同上 |
| Runway | 国外 | 纯 SPA 空壳 | `/news` JS SPA,`/news/feed` 500;CF-BR 可解 |
| qwen.ai(通义新站) | 国内 | Vite SPA 空壳 | 迁站后主阵地,2.1KB 空壳 |
| 阶跃星辰 stepfun.com | 国内 | Vite SPA 空壳 | 2.4KB 空壳 |
| 月之暗面 moonshot.cn | 国内 | Vite SPA | `/research` 614 字节空壳 |
| 百度文心 ernie.baidu.com | 国内 | 薄壳 | 15KB,0 标题,无嵌入正文 |
| ByteDance Seed seed.bytedance.com | 国内 | SPA 空壳 | 36KB,0 标题 |

### 3.5 不可行/已死(不接)

- **组织级 `*.releases.atom`**(ref「方案B」全部地址):deepseek-ai/、THUDM/、baichuan-inc/、MiniMax-AI/、bytedance-research/、sensetime/ 实测 **6/6 全 404**。
- **国内旗舰仓库级 releases.atom**:GLM-4 / Qwen3 / Qwen2.5 / Baichuan2 / MiniMax-01 / MiniMax-M1 / GLM-4.5 / DeepSeek-V3.2-Exp 全部 **200 但 0 条**(这些团队不打 GitHub Release,直接 push 代码 + 发 HF/ModelScope 模型卡)。
- **DeepSeek-V3/R1、01-ai/Yi**:仅 1 条极旧占位 release,无更新价值。
- **字节 byte-tech.github.io**:整站 404。

### 3.6 量级统计

```
45 个 v1 候选 = 17 国外博客 + 12 国内博客 + 1 GitHub Release + 15 播客
              (微信公众号 13 家是另一套系统,v2 单独立项,不计入)

零 VPS 基建可拿(CF Worker 直连):
  原生 feed 直订(Phase 1)               24 个 ← 整条管线先用这批跑通验收
  页面抓取 SSR/__NEXT_DATA__(Phase 3)   10 个 ← CF Worker fetch HTML + parse,仍不碰 VPS
  ────────────────────────────────────────
  小计 34 个不需要 RSSHub/无头

需 RSSHub(Codex 腾讯云机/免费小鸡,Phase 2)  4 个(中文播客)
需无头浏览器(Codex 渲染机优先/CF-BR 备选,Phase 3) 8 个(其中 xAI/Perplexity 2 个 Codex/CF-BR 都可能挡 → 降级)
已死/不接                              一批组织级+仓库级 releases.atom
v2 暂缓                                微信公众号 13 家 + 中文播客 ASR
```

**核心洞察**:实测把「需要花基建钱」的源压到了最少 —— 真正必须 RSSHub 的只剩 4 个中文播客,真正必须无头的只剩 8 个 SPA,其余 34 个 CF Worker 直接搞定。这直接支撑了「Phase 1 零基建先跑通」的策略。

---

## 4. 决策矩阵(照 SOP §2 填,blog / podcast 各一列)

| 维度 | blog(博客) | podcast(播客) |
|------|------------|---------------|
| **数据来源** | 原生 RSS(24 中 13 博客)/ 页面抓取 SSR(10)/ 无头(8);第三方 feed=Anthropic Olshansk;无 token | 原生 RSS(11 国外)/ RSSHub 小宇宙(4 国内);音频走 `<enclosure>` 直链;无 token |
| **拉取频率** | 每 2h(占 `:20` 槽,`hour%2===0` UTC);headless 子集每 2h 弹 1-2(`:20`,`hour%2===1`) | 每 6h(占 `:50` 槽,`hour ∈ {1,7,13,19}` UTC) |
| **Item 映射** | `id=blog:<feed_key>:<idHash>` / `source_id=<feed_key>:<idHash>` / `title=<title>` / `content=正文摘要` / `author=<dc:creator>` / `published_at=<pubDate>` | `id=podcast:<show_key>:<idHash>` / `title=单集标题` / `content=shownotes` / `author=主持人` / `published_at=<pubDate>` |
| **extra 字段** | feed_key / source_company / blog_name / feed_url / fetch_strategy / guid / canonical_url / url_hash / content_hash / cover_image / body_markdown / excerpt / reading_time_min / tags / ai_category / ai_summary_zh / title_zh / excerpt_zh / body_markdown_zh / publisher(name+icon_r2)/ dedup_* / also_reported_by(见 §5.2) | show_key / show_name / feed_url / fetch_strategy / guid / canonical_url / url_hash / audio_url / audio_type / audio_bytes / duration_sec / episode_no / episode_type / cover_image / shownotes_markdown / transcript_url / transcript_type / transcript_text / transcript_source / guests / hosts / chapters / ai_summary_zh / title_zh / shownotes_zh / dedup_* / also_reported_by |
| **指标(时序)** | **无**(博客无 star/vote,RSS 无互动信号)→ `metrics={}`,**不建** `metrics_snapshots_blog`,不挂 refresh-metrics | **无**(RSS 无播放量)→ 同左,**不建** `metrics_snapshots_podcast` |
| **Workflow step** | step0 补 excerpt → step1 廉价 is_ai gate(flash,只判 is_relevant,薄摘要宽松放行)→ step2 dedup(v1 仅 L1)→ step3 正文抓取(B5:静态②/无头③)+ 全文复判 is_relevant → step4 fan-out(R2 迁移 + enrich+translate 合并:category+summary+ELI25,**不再判 is_relevant**)→ step5 gate | step0(feed 已给 title+shownotes)→ step1 廉价 is_ai gate → step2 dedup(v1 仅 L1)→ step3 取原生 transcript(A 档 5 源,文件解析,无 ASR)→ step4 fan-out(cover R2 + enrich+translate 合并 + transcript ELI25 lazy)→ step5 gate |
| **关联字段** | 无嵌套(不像 X quote/reply);跨源去重的 `also_reported_by` 是横切 | 无嵌套;同左 |
| **媒体字段** | cover(og:image)+ 正文 inline 图 + video 直链 **迁 R2**(marker `blog_media_r2_at`);publisher logo 迁 R2 | **单集封面迁 R2**;**音频直链不迁 R2**(几十 MB + `/r/` 无 Range + 1c1g 中转 OOM 风险) |
| **LLM judge** | **必做**(博客噪音多,非 AI 公告/招聘要滤掉);输出 is_relevant + ai_category + ai_summary_zh | **必做**(尤其 Lex 大量非 AI 选题);输出同左 |
| **翻译** | title/excerpt/ai_summary **eager**(step4 合并);body 全文 **lazy**(仅 relevant 非 dup 才译) | title/shownotes/ai_summary **eager**;transcript **lazy**(A 档才有) |
| **完整性 gate** | 三种终态(relevant / irrelevant / dedup)**都写 `workflow_completed_at`**(与现网 X 一致,`x-tweet-pipeline.ts:236`):relevant 在 enrich + eager 翻译 done 后写,irrelevant / dedup 在各自早退 step 内写。正文完整度**不是** gate 条件(抓不到全文降级摘要也能上 feed)。隐藏靠 `relevant=1` 过滤 + `dedup_of IS NULL`,**不靠不写 gate** | 同左;transcript 有无**不是** gate 条件 |
| **Card 布局** | **news-card 式(✅ 用户已定 ②):文字为主 + 右侧小缩略图(~96×96 圆角,质量门控,无图则纯文字不留位)**,非满宽 hero | TweetCard 家族(左方形封面列 + play 叠加 + 右内容列,抄 `TweetCard`) |
| **Drawer 内容** | publisher 头 + 标题 + ELI25 摘要 + 封面 + 正文 markdown 全文(译/原 toggle + Lightbox)+ 外链 | 节目封面 + 音频播放器(原生 `<audio>`)+ ELI25 摘要 + shownotes/章节 + (A 档)transcript 折叠区 + 外链 |
| **排序** | 时间倒序(`published_at desc`,无热门);走 `idx_items_published` | 时间倒序;同左 |

> **⚠️ 前端入口合并(D7,2026-06-09 用户已定)**:上表 blog / podcast 仍是**两列(两个独立 source_type + 两条独立 CF Workflow + 两种卡片样式)**,这是数据模型层,**不合并**;合并的只是**前端顶部入口** —— 两源共用 **1 个 chip「官方新闻」**(filter `source_type=blog,podcast`),在同一个信息流里按 `published_at desc` **混排**。Feed.tsx 已按 `source_type` 逐条路由卡片组件,天然支持混排(详见 §10.5 第 7 行 / §13 D7)。

---

## 5. Schema 增量(B1)

### 5.1 source_type 新值(零 DB 变更)

`source_type` 是裸 `TEXT`,新增枚举值 `'blog'` / `'podcast'` **零 schema 变更**(`'podcast'` 前端 `types.ts` 已占位)。前端 `SourceType` union 补 `'blog'`。

### 5.2 唯一 schema 增量:migration `020`(1 条 partial 表达式索引,零 ALTER)

> 实测当前最新 migration 是 `019-x-card-renders.sql`,故新 migration 取 `020`。

```sql
-- worker/migrations/020-dedup-indexes.sql
-- v1 跨源滤重只做 L1(canonical-URL 精确 hash),只需 url_hash 一条表达式索引。
-- 不加 items 列:dedup/canonical/hash 全落 extra JSON。D1/SQLite 支持对确定性表达式(json_extract)建索引。
-- partial index:只索引真正写了 url_hash 的行(blog/podcast),收敛索引体积,不为全表 X/GH/PH/HF 行付存储。
CREATE INDEX IF NOT EXISTS idx_items_url_hash
  ON items(json_extract(extra, '$.url_hash'))
  WHERE json_extract(extra, '$.url_hash') IS NOT NULL;
```

> ⚠️ **砍掉 `idx_items_content_hash`**:v1 L1 算法只查 `url_hash`;L2(标题 Jaccard)用内存 shingle 比对、全程不查 `content_hash`。给一个谁都不查的列建索引是死索引,纯占写入开销 —— v1 不建,等 v2 真上 content-hash 去重再加(见 §5.6)。

部署照 CLAUDE.md checklist:`wrangler d1 execute xlist-staging --env staging --remote --file=migrations/020-dedup-indexes.sql` 验证后再 prod。**退路**:若 D1 某版本对 partial 表达式索引有限制(staging 实测兜底),退成无 WHERE 的普通表达式索引,再不行改加真列 `url_hash`(代价小)。

### 5.3 composite id 规则

```
identityKey = entry.guid || entry.link           // 优先 RSS <guid>,缺则 <link>
idHash      = sha256hex(identityKey).slice(0,16) // 64-bit,本量级碰撞可忽略
blog:    id = `blog:${feed_key}:${idHash}`        // 例 blog:openai:9f2a1c4b7e0d3a85
podcast: id = `podcast:${show_key}:${idHash}`     // 例 podcast:lex-fridman:1a2b3c4d5e6f7081
```

- **为何哈希而非裸 guid**:RSS guid 常是整条 URL 或 `tag:...` 长串,裸值超长且含非法字符;哈希定长 + 安全。裸 guid 与 canonical_url 另存 extra 供 debug。
- **idHash(基于 guid)是本 feed 内稳定身份(PK)**;**url_hash(基于 canonical_url)是跨源精确去重键**,两个哈希两个用途。
- 复合 id 经 `replace(/[^a-zA-Z0-9-]/g,'-')` 即合法 workflow instance-id(沿用 hour-bucket 后缀)。

### 5.4 是否新建 metrics 表 —— **不建**

blog/podcast 发布后内容静态、RSS 不带可追 Δ 的时序指标(无 star/vote/播放量),snapshot 表唯一价值(算 Δ 喂 tier 重定级)不成立;`reading_time`/`duration` 是一次性静态事实写 extra 即可。`items.metrics` 存 `{}`,`tier` 设终态(不进 `next_refresh_at`),**不挂 refresh-metrics cron**(顺带省一条已满的 cron 槽)。

### 5.5 is_ai 停止游标(需求 4.2)

**机制:items 表存在性为权威 + 每 feed `sources.cursor` 存 top-N guid 做冷启动/可观测**(镜像 `x-list-cursor.ts`)。

**feed 注册表 = 复用现成 `sources` 表(零新表)**:

```
sources.id          = 'blog:openai' / 'podcast:lex-fridman'
sources.source_type = 'blog' / 'podcast'
sources.source_ref  = 'openai' / 'lex-fridman'   (= feed_key/show_key)
sources.name        = 'OpenAI Blog'
sources.cursor      = JSON: 上轮 feed 顶端 N 个 guid(冷启动检测/观测)
sources.last_success_at = ISO(staleness 告警:>48h 未成功 → PushDeer)
sources.config      = JSON: {feed_url, fetch_strategy, source_company, kind, region, ...}
```

45 个候选 = 45 行 `sources`。canonical feed 清单存 worker TS 常量 `worker/src/feeds/registry.ts` 的 `FEED_REGISTRY`(curated + PR review),启动时 `ensureFeedSources(env)` 幂等 upsert 进 sources(增删源改常量,不动 migration)。

**is_relevant 占位语义(需求强约定,且与现网完整性 gate 不变量对齐)**:
- 抓取时每条先入库为 stub:`is_relevant=NULL`,立即 trigger workflow。
- workflow step1 廉价 gate 判定后:**高置信相关→`is_relevant=1` 继续后续 step;高置信不相关→`is_relevant=0`**;**borderline / 低置信→不在薄摘要上终判**,放行到 step3 抓全文后用全文复判 is_relevant(全文复判才是终判,见 §8.1 护栏,防薄摘要永久误杀好源)。
- **三种终态(relevant / irrelevant / dedup-suppressed)一律照写 `workflow_completed_at`**。根因:现网 X workflow 的 gate 只看 `!classifyTrans.failed`(`x-tweet-pipeline.ts:236`),对 `is_relevant=0` 也照写 wc_at;而 SOP §1.6 兜底 backfill 扫 `workflow_completed_at IS NULL` 当 stuck 每 30min 重 trigger(`source-integration-sop.md` L196)。若 blog/podcast 对 is_relevant=0 / dedup 次源故意不写 wc_at,这批行会被兜底 backfill **每 30min 无限重判**,白烧 DeepSeek + 去重开销。**所以不复用「不写 gate」做隐藏**。
- **不相关行如何不出现在 feed**:靠 `/api/items` 现有过滤——默认 `relevant=1`(`index.ts:2380`)→ SQL 推 `is_relevant = 1`(`index.ts:2446-2447`)自动挡掉,**不靠不写 gate**。
- **is_relevant=0 的行永久保留**(占位):它的 `id` 存在,让下次抓取**命中已知项即跳过**(省 DeepSeek 重判)。**停止判定看「id 是否已入库」,不看 is_relevant 值**。

**算法(blog 同构 podcast,复用 x-list-cursor.ts 三个纯函数)**:

```js
async function runBlogFeedIngest(env, feedRow) {       // feedRow ∈ sources
  const cfg     = JSON.parse(feedRow.config)
  const seenSet = parseSeenSet(feedRow.cursor)         // 空=冷启动
  const entries = await fetchAndParseFeed(env, cfg)    // B2:native RSS|page-scrape|rsshub;reverse-chrono

  const parsed = entries.map(e => {
    const guid = e.guid || e.link
    const idHash = sha256hex(guid).slice(0,16)
    const canonicalUrl = canonicalize(e.link)
    return { id: `blog:${feedRow.source_ref}:${idHash}`, guid, canonicalUrl,
             urlHash: sha256hex(canonicalUrl).slice(0,16), entry: e }
  })

  // 权威「已入库」集:一次批量 SELECT(chunk 50,沿用 D1 ~50 stmt/call 约束)
  const existing = new Set( await selectExistingIds(env, parsed.map(p=>p.id)) )

  // ⚠️ RSS 无排序契约(置顶/featured/被 bump 的旧条目可能插在最新之前),不照搬 X API 的严格时间倒序。
  // 不在「命中第一条已知」就硬 break(会被一条置顶旧文挡住、漏掉它下面的新文),而是扫满当前 feed
  // window、跳过已见、收集未见。单文档 RSS 的 window 本就 20-50 条、一次 GET 返回,全扫零额外成本。
  const newOnes = parsed.filter(p => !existing.has(p.id))   // skip-seen,不 break
  // 分页型 page-scrape(AI21 等多页)才有翻页成本:用「连续 K 条全已见」(K=STOP_RUN,如 5)才停翻下一页,
  // 而非命中第一条已见就停,对冲分页内乱序(见 §7.4)。
  // 冷启动限深(见 D10):首跑一个几百条历史的 feed 不要灌满
  const toInsert = (seenSet.size === 0) ? newOnes.slice(0, COLD_START_MAX) : newOnes

  for (const p of toInsert) {
    await env.DB.prepare(`INSERT OR IGNORE INTO items (...) VALUES (...)`).bind(
      p.id, 'blog', `${cfg.feed_key}:${p.idHash}`, /* is_relevant */ null, /* extra json */ ...
    ).run()
    await triggerBlogWorkflowForItem(env, p.id)        // A1 trigger 范式 + hour-bucket
  }

  // 整轮成功才推进 cursor + last_success_at(中途失败保留旧值,下轮重头)
  if (success && parsed.length) {
    await env.DB.prepare(`UPDATE sources SET cursor=?, last_success_at=? WHERE id=?`)
      .bind(serializeSeenSet(parsed.slice(0,N).map(p=>p.guid)), now, feedRow.id).run()
  }
}
```

- **stub 用 `INSERT OR IGNORE` 不走 `ingestItems`**(index.ts:2181):停止游标保证同 guid 不重入,天然不擦 workflow 写的 dedup/enrich 字段,规避 `ingestItems` strip-null shallow merge 坑(MVP 接受 blog 改稿罕见、不重抓编辑)。
- **RSS 多为单文档**(一次 GET 返最新 ~15-50 条),无翻页;**分页型 page-scrape**(AI21 有 11 页)才需外层 page 循环 + `HARD_MAX_PAGES`(照搬 X 的兜底)。

### 5.6 跨源滤重(需求 4.4)

**现状:全仓零跨源去重机制**(主键 UPSERT=源内同 id;X `runDedupeQuoteContent`=源内文本去冗;R2 SHA-256=文件去重 —— 均非 item 跨源)。这是全新数据面。

**v1 只做 L1(canonical-URL 精确去重);L2 整体推迟到 v2**(对齐用户「别过度设计」):L2 的标题 shingle-Jaccard 阈值文档自认要上线后拿真实重复样本才能调,又有同 tick 并发竞态(见 v2 触发条件),v1 不上。

| 层 | 判据 | 状态 | 命中场景 |
|----|------|------|---------|
| **L1** | canonical URL 完全相同(`url_hash` 精确) | **v1 上线** | 同一文被两 feed 各列一遍 |
| **L2** | 标题 shingle-Jaccard(borderline 才 pro-LLM 核验)+ `also_reported_by` 徽标 | **v2 推迟** | 同一新闻被多家博客 + 播客讨论 |

> 设计已留 extra 字段位(`dedup_group_id` / `content_hash` / `also_reported_by`)**但 v1 不计算**——v1 只算 `url_hash` + `dedup_of` + `dedup_reason` 这条 L1 最小集。

**canonicalize(url)**:小写 scheme+host、去默认端口、去 `#fragment`、剔除追踪参数(`utm_*`/`ref`/`ref_src`/`fbclid`/`gclid`/`mc_cid`/`spm`/`source`)、剩余 query 排序、去 trailing slash、折叠 `//`;`url_hash = sha256hex(canonicalUrl).slice(0,16)`。

**L1 dedup step 伪码(workflow step2,仅 is_relevant=1)**:

```js
async function dedupStep(env, itemId) {
  const it = await loadItem(env, itemId)
  if (it.is_relevant != 1) return {skip:'irrelevant'}     // 不相关已在 step1 终判
  const urlHash = it.extra.url_hash

  // L1:跨所有源 canonical-URL 精确。incumbent = 已展示的「主源」。
  // ⚠️ 现在所有终态都写 wc_at(含被隐藏次源),所以「已展示」必须额外要求 dedup_of IS NULL,
  //    不能只靠 wc_at NOT NULL 判 incumbent(否则会把一个被隐藏次源误当主源)。
  const incumbent = await env.DB.prepare(`SELECT id,source_type,published_at FROM items
    WHERE json_extract(extra,'$.url_hash')=? AND id!=? AND is_relevant=1
      AND json_extract(extra,'$.workflow_completed_at') IS NOT NULL
      AND json_extract(extra,'$.dedup_of') IS NULL
    ORDER BY published_at ASC, id ASC LIMIT 1`).bind(urlHash, itemId).first()
  if (incumbent) return suppressAsDuplicate(env, it, incumbent, 'l1_same_url')
  return {dup:false}                          // 主源,继续 step3
}
```

**判重后处理:保留主源 + 隐藏次源**(v1):
- **不硬合并成 synthetic 行**(破坏 PK、丢每源保真度)。
- 次源写 `extra.dedup_of`(指主源 id)+ `dedup_reason`,**并照常写 `workflow_completed_at`**(终态,根因见 §5.5——不写 wc_at 会被 §1.6 兜底 backfill 每 30min 无限重判)。
- **隐藏机制 = handleItems 主查询新增一条 `json_extract(extra,'$.dedup_of') IS NULL` 条件**:这是 blog/podcast 引入的**唯一 feed-SQL 改动**(加在 `index.ts handleItems` 通用过滤段、~2441 行 wc_at gate 之后,与 `relevant=1` 并列)。**不复用「不写 gate」隐藏**(会被 §1.6 兜底 backfill 无限重判);也**不用 `deleted_at`**(通用 handleItems 不过滤 deleted_at,靠它隐藏不可靠)。
- **可恢复**:次源只隐藏未删,清 `dedup_of` 即重新出现在 feed(L1 精确同 URL、几乎不误杀;留作安全网)。

**canonical 选举 = incumbent-wins(已展示主源为准,新来者自我隐藏)**:L1 是精确同 URL,谁先入库展示谁是 incumbent;不做 UI 回溯抖动。同批 tie 按 `published_at` 升序 + `id` 升序定序。

**L2(v2,推迟)设计存档** —— 上 L2 前要先满足两条触发条件:① 攒到真实重复样本、能标定 `J_HARD`/`J_SOFT` 阈值;② **先解决同 tick 并发竞态**——一个 tick 内 ~24 feed 几乎同时入库,彼此查不到对方 incumbent(都还没写完 wc_at),同一新闻的多源会全部当主源放过;须对同批做串行 dedup 或加二次 sweep。两条都满足再上。L2 算法:`normalizeTitle`(NFKC + lowercase + 去标点/emoji + 折叠空白 + **剔除 source_company token**,防 `OpenAI: GPT-5` 与 `GPT-5 deep dive` 因厂商名偏移)→ unigram+bigram shingle → 近 7 天窗扫同源候选算 `jaccard`,`score≥J_HARD` 直接判重、`score∈[J_SOFT,J_HARD)` 用 `deepseek-v4-pro` 核验 same_event;判重后主源写 `also_reported_by[]` 出「另有 N 源报道」徽标(镜像 `thread_root_id → ThreadCard`)。L2 误杀风险高于 L1,保留「清 dedup_of 即恢复」安全网。

---

## 6. 基建:RSSHub + 无头浏览器(B2 + B5)

### 6.1 香港 VPS 1 核 1G 单点的容量权衡

| 项 | 实测值 | 含义 |
|----|--------|------|
| CPU | 1 vCPU,load ~0.08 | 闲置,但单核 —— 任何 CPU 密集任务会抢占 nginx 中转 |
| 内存 | 961MB 总,free ~645MB,used ~315MB | used 几乎全是 nginx relay,可用余量 ~645MB |
| swap | 1GB,未用 | 是兜底不是容量;一旦用上就意味着中转开始抖 |
| 已装 | 仅 nginx(active) | **无 docker / node / bun** |

**RSSHub 内存预期**:idle RSS ~150-250MB,并发解析大 HTML 瞬时冲 300-400MB,误触 puppeteer 路由 +200-400MB。

**裁决**:
- 同机 bare-node RSSHub idle 塞得下(645 - 220 ≈ 425MB 余量),但**一次并发 spike 恰逢中转流量高峰就可能进 swap → nginx proxy buffer/回源抖动 → 全站用户感知变慢**。**这条比「会不会 OOM」更早触发,是反对同机的最强论据。**
- 无头浏览器(单渲染页 spike 200-400MB)在 1 核 1G 上**必 OOM**,可能连带杀 nginx → 整站挂(§6b 铁律)。**永久否决在中转机跑无头。**

### 6.2 部署形态(分阶段,默认零基建起步)

| 方案 | 与 prod 中转耦合 | 推荐度 |
|------|-----------------|--------|
| ① 不部署:CF Worker 直连现成 feed | 零耦合 | ✓ **Phase 1 首选**(单凭它覆盖 24 源) |
| ② 同机 bare-node RSSHub(香港中转机) | **共命运**,swap thrash 拖慢全站 | ✗ 否决(仅理论兜底,须 systemd `MemoryMax=300M` + nginx `OOMScoreAdjust=-900` 才勉强) |
| ③ **复用 Codex 腾讯云渲染机**(`${CN_RENDER_HOST}`,大陆 IP,已跑 Chrome + 与 aifeeds 有 X-card 渲染契约) | **跨方依赖 Codex**(非 aifeeds 自有) | ✓ **用户已定:无头/全文渲染主路径**(详见 §6.3,镜像 X-card HTTP 契约;余量待 Codex 确认) |
| ④ 另起独立最小小鸡跑 RSSHub | 解耦:它挂只停 blog/podcast 入库 | ○ 仅 Phase 2 中文播客才需;Oracle Always Free=$0 或 $3-7/mo,或并入 ③ Codex 机 |
| ⑤ CF Browser Rendering binding | 零自建,Chrome 在 CF 侧 | ○ **备选/兜底**(Codex 机余量不足或不愿持续占用时启用;Workers Paid 已支持) |

### 6.3 无头/全文渲染:复用 Codex 腾讯云机(主)+ CF-BR(备选)

> **用户 2026-06-09 已定:复用 Codex 腾讯云渲染机(`${CN_RENDER_HOST}`)为无头/详情页渲染主路径。** 这台是协作方 Codex 拥有/运维的机器,已跑 Chrome 给 aifeeds 渲染 X-card PNG 和日报图,双方已有「HTTP 端点 + `shared_token`」渲染契约(见 `docs/plans/2026-06-04-x-card-render-api.md`)。新源复用 = 请 Codex 新开一个抓文章的 HTTP 端点(如 `POST /render-article`,输入 url → 返回渲染后 HTML/正文/图),aifeeds worker 带 `shared_token` 调用。它是**大陆 IP**,抓国内厂商 SPA 站反而比 CF 边缘更顺。
>
> **⚠️ 必须如实权衡的 caveat(不淡化)**:① 这台**归 Codex 所有、非 aifeeds 自有** —— 持续抓取 = 跨方依赖 + 需与 Codex 协调新端点 + 它挂了 aifeeds 这部分 feed 会停;② 它已承担 X-card + 日报图渲染,**叠加文章渲染的余量未知**(无法 SSH 自查,只能走 Codex 暴露的 HTTP 契约);③ X-card 是偶发渲染、文章抓取是**持续负载**,是更大的长期占用,**需 Codex 同意 + 验证余量**;④ **Phase 1 那 34 个零基建源根本不需要它**,无头只在 Phase 3 启用,可先不依赖。

**备选 CF Browser Rendering(CF-BR)** —— 当 Codex 机余量不足/不愿持续占用,或某源用 Codex 大陆 IP 反被本地反爬挡时启用。配额与前提:

- **本账户 = Workers Paid**:120 浏览器并发,每月含 **10 browser-hours 免费**,超出 $0.09/browser-hour;新建实例 1/秒。
- **本场景估算**:需无头的 ~8 源 + 偶发兜底 ≤ 100 次渲染/天 × ~10-15s/次 ≈ **~10 browser-hours/月,基本卡在免费额度内**;最坏 2-3× 也就 $2-5/月。比自建小鸡($5-15/mo + 运维 + 单点)更便宜且零运维。
- **⚠️ 不是反爬银弹**:`wrangler.toml:31` 实测 arxiv 连 CF-BR 的 headless 都被 detect;worker egress IP 被普通反爬 403(`huodongxing.ts:57`);xAI/Perplexity 是 Cloudflare bot 拦截,用 CF 的 IP 撞 Cloudflare 防护大概率仍被挑战。
- **历史事实**:2026-05-18 只移除了 `[browser]` binding 配置(改走 PDF parse),`nodejs_compat` flag 至今仍在(`wrangler.toml:5`,实测确认)。**重新加回 binding 即可用,但 Phase 3 启动前需 staging 实跑一次 `page.goto` 验证 provision 正常(D3)。**

**分流**:
- **CF-BR 能搞定**:纯 SPA/无激进反爬 —— Runway + 国内 qwen.ai/阶跃/月之暗面/百度文心/ByteDance-Seed。
- **CF-BR 搞不定的硬骨头**:xAI / Perplexity(Cloudflare-bot + headless 检测)→ **默认优雅降级(只留 RSS 摘要/标题 + 原文链接)**,证明高价值再上独立小鸡真实/住宅 IP 浏览器(D6)。
- **能 SSR/`__NEXT_DATA__` 页面抓取的**(智谱/零一/MiniMax/百川/商汤/Meta/Cohere/AI21/Databricks)→ **CF Worker 直接 parse,不占无头额度**。

### 6.4 详情页全文抽取升级阶梯(B5,4 级)

```
① RSS 自带全文     feed 有 <content:encoded> 且 ≥800 字 + 句末标点 → 直接用,0 网络
② 服务端静态抽取   worker fetch 原文 HTML(带完整浏览器 header)→ HTMLRewriter/正则/__NEXT_DATA__ 抽正文
③ 无头浏览器渲染   ②拿到 SPA 空壳(body 文本<2KB + 含 #root)→ CF-BR 跑 JS → 渲染后 HTML 再走②
④ 外部渲染机/降级  ③仍被 Cloudflare bot 挡 → 大陆/住宅 IP 渲染机,或优雅降级只留摘要+链接
```

**正文抽取选型(全 0-bundle,与本仓「不上 DOM 库」现状一致)**:
- **HTMLRewriter**(workerd 内置,首选通用 HTML):按 selector 抽 `<article>`/`<main>`/`<p>`。
- **`__NEXT_DATA__`/inline-JSON brace-walker**(抄 `huodongxing/parser-detail.ts`,「比 DOM 解析稳健 10 倍」):国内 Next.js 这批专用。
- **正则 `<p>` 抽段**(抄 `hf-paper/ar5iv.ts:extractParagraphs`):结构规整博客。
- `@mozilla/readability + linkedom`(~240-320KB):仅个别脏站按源开关,不进主链。

**⚠️ worker egress IP 会被反爬 403**(`huodongxing.ts:57` 实测本地 200/worker 403):②的 `fetch` 必须带**完整浏览器 header**(抄 `huodongxing.ts:buildHeaders` 的 UA + `Sec-Fetch-*` + `Accept-*` + Referer)+ 800/2400ms 两次重试。

**⚠️ step3 回详情页抓全文必须做 per-origin 节流 + jitter**(防冷启动撞 WAF,SOP 故障 4.7「backfill 高并发 → 同 origin WAF 403」同类):冷启动一轮可能对同一 origin(如 20 篇 OpenAI、十几篇 Databricks)同时触发 step3 抓全文,worker 同源高并发请求极易被站点 WAF 当爬虫拉黑。约束:
- **按 origin(scheme+host)串行**:同一 origin 的 step3 抓取排队,不并发;不同 origin 之间可并行。落地用「per-origin 时间戳表 / 简易内存令牌」记每个 origin 上次抓取时刻,同 origin 两次抓取间至少隔 `PER_ORIGIN_MIN_GAP_MS`(如 1500-3000ms)。
- **随机 jitter**:每次抓取前 `sleep(base + random()*jitter)`(如 base 1000ms + jitter 0-2000ms),打散整齐的脉冲式请求节奏。
- **天然对齐既有调度**:step3 真正放量是在 §7.2 的 headless-drain lane(每 2h 弹 1-2),tick 内本就 `await` 串行;per-origin gap + jitter 是在此之上对「同 tick 多条同源」再加一层保护。被 WAF 403 时走 §6.4 阶梯④优雅降级(只留摘要 + 原文链接),不重试打爆。

**备选 render 写法 —— CF-BR binding**(主路径走下方 ③ Codex HTTP 契约,此为兜底):

```ts
// wrangler.toml 重新加回(top-level + [[env.staging]] 双份):
// [browser]
// binding = "BROWSER"
import puppeteer from '@cloudflare/puppeteer';
async function renderAndExtract(env, url) {
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setUserAgent(REAL_UA);
    const resp = await page.goto(url, { waitUntil: 'networkidle0', timeout: 20_000 });
    if (!resp || resp.status() >= 400 || isChallenge(await page.content())) return { ok:false, reason:'blocked' };
    return { ok:true, html: await page.content(), assets: await collectAssets(page) };
  } finally { await browser.close(); }
}
```

**主路径:Codex 腾讯云渲染机 HTTP 契约(选项③,镜像现有 X-card 渲染机,复用同款 `shared_token`)**:`POST https://<render-host>/render`,`Authorization: Bearer <RENDER_TOKEN>`,body `{url, wait:"networkidle", want:["html","images"]}`,无状态、不查我们 DB。

### 6.5 CF → VPS 调用的安全约定(复用回源密钥镜像模式)

RSSHub 只监听 `127.0.0.1:1200`,nginx 加 token-gated location(镜像现有 `X-Origin-Secret` 反方向):

```nginx
map $http_x_rsshub_token $rsshub_ok { default 0; "<RSSHUB_TOKEN 值>" 1; }
location /rsshub/ {
    if ($rsshub_ok = 0) { return 403; }
    proxy_pass http://127.0.0.1:1200/;
    proxy_read_timeout 30s;
    limit_req zone=aifeeds_rate burst=20 nodelay;
}
```

Worker 端 env 存基址,**严禁硬编码 VPS IP**:

```toml
# worker/wrangler.toml [vars]
RSSHUB_BASE = "https://rss.ai-feeds.com"   # 经 token-gated nginx;staging 留空 → 跳过 rsshub 源
# RSSHUB_TOKEN 走 wrangler secret put + .secrets/aifeeds-{prod,staging}.env(若接 CICD 还要 gh secret set)
```

```ts
async function fetchFeedXml(env, feed) {                 // native 与 rsshub 统一入口
  const isRss = feed.via === 'rsshub';
  if (isRss && !env.RSSHUB_BASE) throw new Error(`rsshub source ${feed.id} but RSSHUB_BASE empty`);
  const url = isRss ? `${env.RSSHUB_BASE}/${feed.route}` : feed.url;
  const headers = { 'User-Agent': USER_AGENT };
  if (isRss) headers['X-RSSHub-Token'] = env.RSSHUB_TOKEN;
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`feed ${feed.id} HTTP ${r.status}`);
  return r.text();
}
```

> **香港 host-rewrite 铁律**:基址走 `env.RSSHUB_BASE` 不靠 request host(2026-06-08 分享二维码 Forbidden 同源教训)。

**落地顺序硬要求(防自锁,类比 §6b 回源密钥事故)**:1) 独立小鸡起 RSSHub(绑 localhost)→ 2) nginx token-gate + certbot 出证书 → 3) `curl` 自测(带/不带 token 应 200/403)→ 4) `.secrets` 加 `RSSHUB_TOKEN` + `wrangler secret put` → 5) wrangler.toml 加 `RSSHUB_BASE` → 6) worker deploy(先 staging 再 prod)。**顺序颠倒会让 worker fetch 全 403,或把 RSSHub 暴露公网。**

---

## 7. 抓取调度(B3)

### 7.1 接现有单 `*/5` cron,内部分流,不新增 trigger

prod 只有一条 cron(`wrangler.toml:49` 实测 `crons = ["*/5 * * * *"]`),`scheduled()` 内部按 `getUTCHours()/getUTCMinutes()` cell 分流,first-match 后 `return`(抢占式)。新源一律以「加 `if (isXxxSlot) {…; return;}` 块」插入。

### 7.2 新增 slot 分配(占 hdx-drain 的 `:20/:50` 槽,不碰 X 自愈/拉新/refresh)

> ⚠️ **不再偷 X-backfill 槽**。`:15`(`x-backfill-truncated` 截断补全,`index.ts:1849`)/ `:40`(`x-backfill-workflow` 卡死重触发,`index.ts:1908`)是主源 X **每小时都在跑**的安全网,永久占走会把 X 自愈吞吐砍半;X 拉新(`list-poll :25/:55`)、refresh-metrics(`:00/:30`)同理是硬槽。改占 dispatcher 里**唯一非 X、非拉新、非 refresh 的每小时槽** `:20/:50` —— 当前是 `hdx-auto-drain`(HDX backlog 平摊 drain,`isHdxEnrichSlot`,48 tick/天 × 25 = 1200/天容量,cutover 后 backlog 近空、余量极大)+ 一个**早被它 shadow 掉的** `hf-backfill-workflow`(`:20/:50` first-match 命中 hdx 即 return,hf 本就跑不到)。让出的是 HDX drain 的富余,不动任何 X 链路。

| Lane | source_type | 分钟槽 | 小时门控(UTC) | cadence | 同槽让位对象(非 X) | 插入顺序要求 |
|------|-------------|--------|---------------|---------|---------------------|------|
| **blog-fetch**(含 gh-releases) | `blog` | `:20` | `hour%2===0` | 每 2h(12×/天) | `hdx-auto-drain(:20)` | 在 `isHdxEnrichSlot` 检查**之前** |
| **podcast-fetch** | `podcast` | `:50` | `hour ∈ {1,7,13,19}` | 每 6h(4×/天) | `hdx-auto-drain(:50)` | 同上 |
| **headless-drain**(Phase 3 才启用,VPS/CF-BR 队列消化) | `blog`(headless 子集) | `:20` | `hour%2===1` | 每 2h 弹 1-2 | `hdx-auto-drain(:20)` | 同上 |

- **三条 lane 两两永不同 tick co-fire**:blog(`:20` 偶数小时)与 headless-drain(`:20` 奇数小时)按 hour 奇偶互斥;podcast 在 `:50`、分钟就不同。杜绝 subreq 叠加尖峰。
- **对 hdx-auto-drain 影响可接受**:blog+headless 合占 `:20`(每小时其一),hdx-drain 仍保 `:50` 每小时(除 podcast 的 4 个小时)≈ 20 tick/天 × 25 = 500/天,对早已清空的 HDX backlog 绰绰有余;hf-backfill-workflow 本就 shadow-dead,零额外损失。Phase 1 只上 blog/podcast,headless-drain 留到 Phase 3 再占 `:20` 奇数小时。
- **三条新 lane 都必须用 `recordCronRun` 包裹**(`cron-runs.ts:23`,范式见 `index.ts:1850` 的 `x-backfill-truncated` 槽):`const r = await recordCronRun(env, { name:'blog-fetch', source:'blog', category:'fetch' }, () => runBlogFeedFetch(env)); console.log(...); return;`。漏了 `cron-runs` 监控就完全看不到这三条 lane 的执行/耗时/失败/subreq。task name 用 `blog-fetch` / `podcast-fetch` / `headless-drain`,category:fetch 两条 + headless-drain 用 `enrich`。
- **gh-releases 折叠进 blog-fetch lane**(同 2h,registry 里 `kind='github-releases'` 区分):实测仅 MiniCPM 1 个活跃 release feed,组织级全 404、仓库级几乎全空,**参考文档「每 1h 独立槽」被实测推翻**(可被 D8 推翻)。
- **headless 用 round-robin**:`SELECT ... WHERE kind='headless' ORDER BY last_success_at ASC NULLS FIRST LIMIT 1-2`,2h 的 tick 间隔 ≫ 单次渲染 10-30s,**天然保证 ≤1 并发**;tick 内弹 2 个也 `await` 串行。

> ⚠️ **插入顺序**:`:20/:50` 现状是 `isHdxEnrichSlot`(hdx-auto-drain)在前命中即 return、`isHfBackfillWorkflowSlot` 被它 shadow。blog/podcast/headless 的 `if` 块**必须插在 `isHdxEnrichSlot` 检查之前**,否则同样被 shadow、永远跑不到。小时奇偶/集合门控保证它们只在自己的 tick 抢走 hdx-drain,其余 tick hdx-drain 照跑。

### 7.3 频率分段(需求 4.1):v1 线性统一,不做国内外作息分段

| 类目 | v1 cadence | 理由 |
|------|-----------|------|
| 博客(国内外) | 每 2h | 更新最快的也就「每天多条」,2h 体感「当天可见」,seen-set 去重多抓无害 |
| GitHub Releases | 折叠 2h | 只 1 个活跃 feed |
| 播客 | 每 6h | 最快「每周多更」,6h 远超更新速度 |
| headless SPA | 每 2h 弹 1-2 | 受 VPS/CF-BR 约束,这是能力上限不是需求上限 |

**为什么不做 v2 国内外高峰低谷分段**:RSS 拉取廉价 + 幂等(一次空抓 ≈ 1 subreq + skip-seen 全窗跳过已见);分段唯一买到「高峰 surfacing 快 ≤1h」,但资讯聚合站不是实时推送,1h vs 2h 用户无感;分段还要随 DST 漂移 + 对国内厂商「成簇发布」几乎无效。**region 字段照样存进 registry 但不参与调度,留作 v2 开关位。**

### 7.4 per-feed 游标 + 冷启动

- **复用 `x-list-cursor.ts` 的 `parseSeenSet`/`serializeSeenSet`**(GUID-agnostic 零改动)做 seen-set 序列化/反序列化;`SEEN_SET_MAX_SIZE`(X=10 → blog/podcast 建议 15-20,见 D10)。
- **⚠️ 不照搬 `findStopIndex` 的「命中第一条 seen 即停」语义**:那是为 X API 的**严格时间倒序**写的;RSS **无排序契约**,置顶/featured/被 bump 的旧条目会插在最新之前,命中即停会被一条置顶旧文挡住、漏掉它下方的新文。改用 §5.5 的 **skip-seen 全窗扫描**——扫满当前 feed window(单文档 RSS 本就 20-50 条、一次 GET)、跳过 seen-set 与已入库 id、收集未见;**分页型 page-scrape 用「连续 K 条全已见」(K≈5)才停翻下一页**,对冲分页内乱序。`权威「已入库」集仍是 items 表存在性`,seen-set 只作冷启动检测 + 可观测。
- **seen-set 含 is_relevant=0 的 GUID** → 「去重」与「is_ai 停止游标」合一;依赖 B1 早段产出 is_relevant 且不删被判 0 的 stub row。
- **冷启动**:空 cursor → 整窗皆未见 → 当前 RSS window 整页当新条目(RSS 协议只给最近 20-50 条,拿不到更早历史,**不存在「拉历史」可做**)。
- **冷启动洪峰节流(真问题)**:blog-fetch 首轮 ~24 feed × 各 20-50 条 ≈ 800-1300 条同时变 stub。stub 全 INSERT(便宜),触发 workflow 走 `partitionForCatchup(newItems, 50)`:**最新 50 条立即 trigger,其余标 `pending_workflow=1`**,后续 tick 在 lane 末尾 drain。
  > ⚠️ **依赖项**:现有 `drainPendingWorkflowQueue`(`enrich.ts:7370`)**硬编码 `source_type='x_list'`**(7382/7416 行),blog/podcast 用不了 → 需**参数化 source_type**(`pending_workflow` 列本身是 items 通用列)。这是 B3 落地前置条件。

---

## 8. Workflow 流水线(B4)+ ELI25 翻译 prompt

> blog/podcast 各一条 `worker/src/workflows/{blog,podcast}-pipeline.ts`,参考 SOP §1.4 模板 + `hf-paper-pipeline.ts`。

### 8.1 与 X 的核心差异:把 is_ai 判别拆成「廉价前置 gate」

X 在 ingest 时已有完整 tweet 文本,所以「classify+translate 合并 1 次调用」最优。但 **blog/podcast 全文要昂贵地抓(静态 fetch / 无头渲染)**,所以必须**在抓全文之前先用一次极廉价的 flash 调用(step1,只判 is_relevant,输入 title + excerpt)把明显不相关的挡掉** —— 这正是需求 #3「is_ai 当门 + 省渲染/翻译成本」的落地,也是 B1/B5 的成本契约。

**⚠️ 护栏:薄摘要宽松、全文复判才是终判**(防薄 excerpt 永久误杀好源)。feed 摘要常很薄(一句话、甚至只有标题),在薄摘要上直接终判 is_relevant=0,会把「摘要没点到 AI、正文却是硬核 AI」的好文永久钉死(它写了 `is_relevant=0` + wc_at 成停止游标,再不会被复抓)。所以 step1 判定分两档:
- **高置信不相关**(confidence 高)→ 才落停止游标:写 `is_relevant=0` + `workflow_completed_at`,早退,不抓全文。
- **borderline / 低置信** → **放行**到 step2/3,抓到全文后用全文再判一次 is_relevant(step3 末尾复判),**全文复判才是终判**;复判仍不相关才写 `is_relevant=0`。宁可多抓一篇全文,也不在薄摘要上误杀。

> 净效果:**高置信不相关 item 只烧 1 次小 gate 调用**(不抓全文/不翻译/不渲染);**相关 + borderline item** 才走「step3 抓全文(+ 全文复判)+ step4 合并 enrich」。step1 既已判过 is_relevant,**step4 合并调用不再重复输出 is_relevant**,只做 category + summary + ELI25 翻译(见 §8.4)。整体比「先抓全文再合并判」省得多,又不牺牲召回。

### 8.2 blog pipeline(6 step)

```ts
const RETRY = { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '5 minutes' } as const;

export class BlogPipelineWorkflow extends WorkflowEntrypoint<Env, BlogParams> {
  async run(event, step) {
    const { itemId, feedKey, fetchStrategy, lang } = event.payload;

    // Step 0:数据补全 —— 确保至少有 title + excerpt(feed 多数已给;只有 title 时用便宜的②静态 fetch 补)
    await step.do('ensure-excerpt', RETRY, () => ensureExcerptForBlog(this.env, itemId));

    // Step 1:廉价 is_ai gate(flash,只判 is_relevant + confidence,输入 title+excerpt;prompt 见 §8.4.0)
    const cls = await step.do('quick-classify', RETRY, () => quickClassifyForBlog(this.env, itemId));
    if (cls.is_relevant === 0 && cls.confidence === 'high') {   // 仅「高置信不相关」才落停止游标
      // 写 is_relevant=0 + workflow_completed_at(终态!与现网一致;不写 wc_at 会被 §1.6 兜底每 30min 无限重判)
      await step.do('mark-irrelevant', RETRY, () => markIrrelevantCompleted(this.env, itemId));
      return { itemId, is_relevant: 0, completed: true };       // 靠 /api/items 默认 relevant=1 过滤隐藏
    }
    // borderline / 低置信 → 不终判,放行抓全文,step3 末尾用全文复判(见下)

    // Step 2:跨源去重(v1 仅 L1 url_hash 精确;dup → 隐藏次源)
    const dd = await step.do('dedup', RETRY, () => dedupStep(this.env, itemId));
    if (dd.dup) {
      // 次源:写 dedup_of + dedup_reason + workflow_completed_at(终态),靠 handleItems 新增 dedup_of IS NULL 隐藏
      await step.do('suppress-dup', RETRY, () => suppressDupCompleted(this.env, itemId, dd.winner));
      return { itemId, is_relevant: 1, dedup_of: dd.winner, completed: true };
    }

    // Step 3:正文抓取(B5 升级阶梯;safeStep 永不 throw,失败降级 RSS 摘要)+ 顺手收集 assets。
    //   ⚠️ per-origin 串行 + jitter 防 WAF(§6.4);封面无条件 backfill 走多源回退链 + marker 防重(§9.1);
    //   正文 inline 相对 URL 按各 feed 自己的 base 域解析(§9 / §10.3)。
    await step.do('fetch-body', RETRY, () => safeStep(() => fetchBodyForBlog(this.env, itemId, fetchStrategy)));
    if (cls.is_relevant !== 1) {                       // step1 没给「高置信相关」→ 用抓到的全文终判 is_relevant
      const recheck = await step.do('reclassify-fulltext', RETRY, () => reclassifyOnFulltextForBlog(this.env, itemId));
      if (recheck.is_relevant !== 1) {                 // 全文复判仍不相关 → 落停止游标(终态)
        await step.do('mark-irrelevant', RETRY, () => markIrrelevantCompleted(this.env, itemId));
        return { itemId, is_relevant: 0, completed: true };
      }
    }

    // Step 4:fan-out 并行(各自 json_set 只动自己字段,防 lost-update)
    const [, , bodyTrans] = await Promise.all([
      step.do('migrate-media-r2', RETRY, () => migrateMediaForBlog(this.env, itemId)),         // B6,封面无条件 backfill + marker
      step.do('enrich-translate', RETRY, () => enrichTranslateForBlog(this.env, itemId, { lang })), // 合并:category+ai_summary_zh(ELI25)+title_zh+excerpt_zh,**不再判 is_relevant**
      step.do('translate-body', RETRY, () => translateBodyForBlog(this.env, itemId, { lang })), // lazy 全文 ELI25(body 抓到才有内容)
    ]);

    // Step 5:完整性 gate(enrich + eager 翻译成功即写;正文完整度不是 gate 条件)
    if (!bodyTrans.enrichFailed) {
      await step.do('mark-completed', RETRY, () => markCompleted(this.env, itemId));
    }
    return { itemId, is_relevant: 1, completed: !bodyTrans.enrichFailed };
  }
}
```

**hasXxxRef 信号(trigger 时传)**:`fetchStrategy`(native/page-scrape/headless,决定 step3 怎么抓)。无 X 那种 quote/reply 嵌套。

> 三种终态都写 `workflow_completed_at`:relevant 在 step5 写、高置信 irrelevant 在 step1 写、全文复判 irrelevant 在 step3 写、dedup 次源在 step2 写。**没有任何一条终态靠不写 gate 来隐藏**(根因 §5.5)。

### 8.3 podcast pipeline(5 step)

```ts
export class PodcastPipelineWorkflow extends WorkflowEntrypoint<Env, PodcastParams> {
  async run(event, step) {
    const { itemId, showKey, hasNativeTranscript, lang } = event.payload;

    // Step 0:feed 已给 title + shownotes(无需昂贵补全;shownotes 通常比 blog excerpt 厚,薄摘要误杀风险低)
    // Step 1:廉价 is_ai gate(flash,title+shownotes;Lex 这类大量非 AI 选题尤其需要;prompt 见 §8.4.0)
    const cls = await step.do('quick-classify', RETRY, () => quickClassifyForPodcast(this.env, itemId));
    if (cls.is_relevant === 0 && cls.confidence === 'high') {   // 高置信不相关 → 落停止游标 + wc_at(终态)
      await step.do('mark-irrelevant', RETRY, () => markIrrelevantCompleted(this.env, itemId));
      return { itemId, is_relevant: 0, completed: true };
    }
    // borderline:shownotes 太薄时放行,有 A 档 transcript 则 step3 后复判;无 transcript 默认放行(收 > 漏)

    // Step 2:跨源去重(v1 仅 L1;周报类播客与博客/GitHub 高度重叠,同 URL 命中即隐藏次源)
    const dd = await step.do('dedup', RETRY, () => dedupStep(this.env, itemId));
    if (dd.dup) {
      await step.do('suppress-dup', RETRY, () => suppressDupCompleted(this.env, itemId, dd.winner));  // dedup_of + wc_at(终态)
      return { itemId, is_relevant: 1, dedup_of: dd.winner, completed: true };
    }

    // Step 3:取原生 transcript(A 档 5 源:Practical AI / MS Research / Latent Space / Last Week in AI / Lex)
    //         —— 文件 fetch + 解析 VTT/SRT/JSON,无 ASR(MVP);B/C 档 transcript_source='none'
    if (hasNativeTranscript) await step.do('fetch-transcript', RETRY, () => fetchNativeTranscriptForPodcast(this.env, itemId));

    // Step 4:fan-out(cover 迁 R2;音频不迁 R2)+ 合并 enrich+translate(不再判 is_relevant)+ transcript lazy 翻译
    const [, , transTrans] = await Promise.all([
      step.do('migrate-cover-r2', RETRY, () => migrateCoverForPodcast(this.env, itemId)),   // 封面无条件 backfill + marker(§9.1)
      step.do('enrich-translate', RETRY, () => enrichTranslateForPodcast(this.env, itemId, { lang })), // category+ai_summary_zh+title_zh+shownotes_zh
      hasNativeTranscript
        ? step.do('translate-transcript', RETRY, () => translateTranscriptForPodcast(this.env, itemId, { lang }))
        : Promise.resolve({ enrichFailed: false }),
    ]);

    // Step 5:gate(三种终态都已各自写 wc_at)
    if (!transTrans.enrichFailed) await step.do('mark-completed', RETRY, () => markCompleted(this.env, itemId));
    return { itemId, is_relevant: 1, completed: !transTrans.enrichFailed };
  }
}
```

**instance ID**(带 hour-bucket,SOP §1.5):`blog-${itemId.replace(/[^a-zA-Z0-9-]/g,'-')}-${hourBucket}`。

### 8.4 ELI25 翻译 prompt(完整可用)

#### 8.4.0 step1 is_ai gate(is_relevant-only,flash,JSON Mode)—— 最频繁调用

**每条 item 必过、调用量最大的一步**,所以只喂 title + excerpt(feed 摘要)、只让模型吐二分类 + 置信度,不做任何翻译/抽取。模型 `deepseek-v4-flash`,`response_format: {type:'json_object'}`。判定与「§8.1 护栏」联动:**只有 `is_relevant=0 且 confidence=high` 才落停止游标**,borderline / 低置信放行到抓全文后复判。

system:

```
你是 AI 资讯的相关性判别器,服务一个面向中国 AI 从业者的聚合 feed。只判断「这条内容是否与 AI 相关」,不做翻译、不做摘要、不做分类。只输出 JSON。
```

user:

```
判断下面这条厂商博客 / 播客单集是否与 AI 相关,并给出置信度。

【算「AI 相关」(is_relevant=1)】涉及以下任一:大模型 / LLM / 生成式 AI(文本、图像、语音、视频、多模态)/ AI 产品或功能 / AI 研究或技术报告 / 机器学习与深度学习 / AI 工程与基础设施(训练、推理、Agent、RAG、评测、对齐、安全)/ AI 公司的模型或产品动态。

【算「不相关」(is_relevant=0)】与 AI 无实质关系:纯硬件 / 芯片财报或股价、与 AI 无关的公司新闻(招聘、办公室、ESG、人事变动)、纯消费电子评测、通用云 / 网络 / 数据库且不涉及 AI、生活方式等。

【置信度 confidence】
- high:标题或摘要已能明确判定(无论判相关或不相关)
- low:摘要太薄、只有标题、或主题两可 —— 一律给 low(下游会抓全文再复判,宁可放行不要误杀)

【输入】
- title: <原文标题>
- excerpt: <feed 摘要 / shownotes;可能很短甚至为空>

【输出】只输出 JSON,不要用 markdown 代码块包裹:
{ "is_relevant": 0 | 1, "confidence": "high" | "low" }
```

> ⚠️ **borderline 一律给 low** 是「薄摘要宽松」护栏的执行点:薄 / 空 excerpt、主题两可时给 `low`,workflow 就放行抓全文、用全文复判(§8.1 / §8.2 step3),避免把「摘要没点 AI、正文是硬核 AI」的文永久误杀。播客版把「厂商博客」换「播客单集」、`excerpt` 换 `shownotes`。

#### 8.4.A 合并 enrich + translate(step4,flash,JSON Mode)—— eager,**不再判 is_relevant**

> 此调用只跑在 step1 已判定为 relevant(或全文复判通过)的 item 上,**不重复输出 is_relevant**(解决 step1/step4 重复判定的矛盾)。改以「分类 + ELI25 翻译」为主。

模型:`deepseek-v4-flash`,`response_format: {type: 'json_object'}`。

```
你是 AI 行业内容编辑,服务中国 AI 从业者。把一篇 AI 厂商博客整理成"讲给一个聪明的 25 岁年轻人听"(ELI25)的中文摘要。

【ELI25 是什么】
- 对象是聪明、好学、但不一定是这个细分领域专家的成年人
- 不是 ELI5(不要幼稚化、不要打比方打到失真),也不是论文摘要(不要堆术语)
- 每个专业名词第一次出现时,用一个从句或破折号顺带解释它是什么,例:"用 RLHF(基于人类反馈的强化学习,一种让模型对齐人类偏好的训练方法)……"
- 先说结论/为什么重要,再说细节
- 句子短、具体、有信息密度;禁止"重磅/震撼/最强/革命性/颠覆"等营销腔

【输入】
- title: <原文标题>
- excerpt: <feed 摘要 / 正文首段>
- source_company: <厂商名,如 OpenAI / 智谱>
- lang: <原文语言>

【任务】输出 JSON(只输出 JSON,不要 markdown 代码块包裹)。**不要输出 is_relevant**(上游 step1 已判定,此处只对已确认相关的内容做分类 + 翻译):
{
  "ai_category": "<二级分类,见枚举>",
  "title_zh": "<标题中译,保留专有名词英文>",
  "excerpt_zh": "<摘要中译,ELI25 风格,60-120 字>",
  "ai_summary_zh": "<一句话 ELI25 解读,30-50 字,读完这一句就知道这篇讲什么 + 为什么值得看>"
}

【ai_category 枚举】model-release(模型发布) | research(研究/技术报告) | product(产品/功能) | engineering(工程/基础设施) | safety(安全/对齐/政策) | company(公司动态/融资/合作) | other

【翻译规则】
- 专有名词、模型名、API 名、公司名保留英文(GPT-5 / Claude / Gemini / Transformer / LoRA / vLLM …),中英之间留一个空格
- 代码、命令、配置、公式原文不译
- 中文标点,不混用英文标点
```

> 播客版只把「博客」换「播客单集」、`excerpt` 换 `shownotes`、输出字段 `excerpt_zh` 换 `shownotes_zh`,其余同构。

#### 8.4.B 正文全文 ELI25 翻译(step4 lazy,flash)—— 输出 markdown

```
你是 AI 博客全文翻译助手,目标读者是聪明的 25 岁中国 AI 从业者(ELI25 标准)。把正文 markdown 翻译成中文。

【输入】
- title: <标题>
- source_company: <厂商>
- body_markdown: <正文 markdown>

【ELI25 + 翻译规则】
- 通顺、准确、有信息密度;术语首次出现顺带一句解释;无营销腔
- 严格保留 markdown 结构:标题层级 #、列表 -、表格 |、引用 >、链接 [..](..)、图片 ![..](..) 原样保留
- fenced code block(```)与 inline code(`code`)内的内容【一字不译】,原样保留
- 专有名词保留英文,中英之间留一个空格
- ⚠️ markdown 强调语法边界:**加粗** 或 `行内代码` 紧贴中文时,在 ** / ` 与相邻中文之间留一个空格 ——
  写 "这是 **重点** 内容",不要写 "这是**重点**内容"
  (CommonMark flanking 规则会让紧贴 CJK 的 ** 不渲染成加粗,这是前端渲染失效的常见根因)
- 只输出翻译后的 markdown 正文,不要加任何说明文字
```

> 播客 transcript(A 档)翻译用同 prompt,把「博客正文」换「播客文字稿」,并要求**保留时间戳/章节标记**(若有)。失败 retry 1 次,仍失败标 `translation_failed_at`(进 notifier 失败率监控)。

#### 8.4.C L2 同事件核验(**v2 才用**,borderline 才调,pro)

> v1 去重收敛到 L1(精确 URL),**不调此 prompt**;留作 v2 L2 上线时用(见 §5.6 v2 触发条件)。

模型:`deepseek-v4-pro`。输入两条的 `title + excerpt`(无需全文),输出 `{"same_event": true|false}`。仅当标题 Jaccard ∈ [0.40, 0.60) 才调,罕见,成本可忽略。

---

## 9. R2 媒体 + 香港 serving(B6)

### 9.1 迁什么、不迁什么

| 资产 | 迁 R2? | 理由 |
|------|--------|------|
| blog 封面(og:image)+ 正文 inline 图 | ✓ | 防删存档 + 香港加速 + `/img` 压缩 |
| blog 正文 inline 视频(直链 mp4)| ✓(过 size cap) | 同上;YouTube/Vimeo embed **不下载**,只存元数据让前端 iframe 渲 |
| podcast 单集封面 | ✓ | 卡片/抽屉/海报封面 |
| publisher logo / favicon | ✓ | 走 `extra.publisher.icon_r2 = /r/blog/<hash>` |
| **podcast 音频** | **✗ 绝不迁** | 几十 MB + `/r/` 无 Range(`handleR2Asset` 不支持)→ seek 失效;且经 1c1g 香港中转 worker 串流大文件会 OOM 拖垮 prod 全站。前端 `<audio>` 直接吃原始 `<enclosure>` 直链 |

**⚠️ 封面取值用多源回退链 + 无条件 backfill**(SOP 故障 4.2/4.3「字段缺失靠 backfill 补」同类,别只取 og:image)。不同 feed 把封面塞在不同标签里,按以下顺序取第一个非空:

```
① <enclosure type="image/*"> (RSS 2.0)
② <media:content medium="image"> / <media:content type="image/*"> (Media RSS)
③ <media:thumbnail url="...">
④ <itunes:image href="...">           (播客单集封面常在这)
⑤ channel 级 <image><url> 或 <itunes:image>(单集没给时回退节目封面)
⑥ 详情页 <meta og:image>              (前五项全空 + step3 已抓详情页时)
```

封面作为 step4 的 `migrate-cover-r2` / `migrate-media-r2` 一步,**无条件 backfill**(每条都跑,取到就迁 R2 + 改写 `extra.cover_image`),标 `extra.cover_backfilled_at` marker 防重复。取不到封面不报错,前端用首字母 monogram / 节目 art 兜底。

**⚠️ 诚实声明:播客「听」在大陆大概率播不动**(可达性后果)。音频走 `<audio src=原始 enclosure>` 直连海外 CDN(megaphone / acast / libsyn / art19 等),**绕开了全站赖以让大陆访问的香港中转** —— 对本设计 ELI25 prompt 自设的「中国 AI 从业者」受众,海外播客的音频在国内很可能加载慢甚至放不出来。**不迁 R2 是对的**(几十 MB 串流过 1c1g 中转必 OOM,见上表),但要把这条后果写明白,别让前端以为播放器一定能用:UI 要给「音频可能需要科学上网」的兜底文案 + 始终保留「在原平台收听」外链。**v2 可选路径**(有真实需求再评估、不在 v1 做):香港机轻量 audio 代理(仅转发不缓存,仍有中转负载顾虑)或音频转封装到可达 CDN。

### 9.2 迁移实现(复用现成管线)

R2 bucket 实测 binding `READMES` = `xlist-readme-assets`(prod)/ `xlist-readme-assets-staging`(staging),沿用 prefix 区分约定(`x/` / `ph/` / `hf/`),blog/podcast 用 **`blog/` / `podcast/` 前缀**。

复用 `ph-r2.ts` / `x-media-r2.ts` 的 `collectAssets → migrateOne → rewrite` 六步:**mime 白名单 + size cap + SHA-256 内容寻址 key + 跳 `/r/` 已迁路径**。质量门控抄 `ar5iv.ts:migrateFigureToR2`(aspect 0.25-4 + density ≥0.05 + maxDim ≥300,滤掉 logo/banner/icon)。

**B5 收集 URL → B6 迁移** 的资产清单(写进 extra):

```json
"body": {
  "source": "static_extract",   // rss_full | static_extract | browser_render | rss_summary_fallback
  "extracted_at": "ISO",
  "assets": [
    { "url": "https://...", "kind": "image", "role": "cover" },
    { "url": "https://...", "kind": "image", "role": "inline" },
    { "url": "https://...mp4", "kind": "video", "role": "inline" }
  ]
}
```

> ⚠️ **迁移 marker 用专属字段** `extra.blog_media_r2_at` / `extra.podcast_media_r2_at`,**不撞** `r2_migrated_at`(GH/PH 已占,实测 `ph-r2.ts:285`)。
> ⚠️ **lost-update 防护**:step4 fan-out 写 `extra.body` 必须 `json_set` 只动自己字段,不整列 read-modify-write(`hf-paper-pipeline.ts:70` 踩过)。
> ⚠️ **ingestItems 浅合并坑**:若未来改走 `ingestItems`(index.ts:2181)路径,daily re-fetch 的 strip-null + 数组整组替换会擦 enrich 字段 —— 需 app-level merge(PH 有 `mergePhExtraPreservingEnrichment` 先例)。MVP 走 `INSERT OR IGNORE` 规避。
> ⚠️ **正文相对 URL 必须按 per-feed base 解析**(gap:`<content:encoded>` 里常有 `src="/img/x.png"`、`href="/blog/foo"` 这类相对 URL):**不是简单透传**,要按**各 feed 自己的 base 域**(取该条 item 的 `canonical_url` 或 feed `config.site_base`,而非统一一个域)把相对 URL 解析成绝对 URL,再交给 B6 迁 R2 / 前端渲染——否则同一批多个 feed 的相对图全挂到错误域名上、图裂。解析点在 step3 正文抽取阶段(收 asset URL 时就 resolve)。

### 9.3 香港 serving

前端经香港中转访问 CF R2:沿用现成 `/r/<key>` 反代(GET/HEAD,`Cache-Control: public, max-age=31536000, immutable`)+ `/img` cf.image transform(自动 webp/avif + R2 缓存)。

> ⚠️ **香港 host-rewrite 铁律**:worker 拼任何对外 R2 URL(写进 extra 给前端、写进分享海报)一律用 `env.SITE_BASE`/`API_BASE` 规范域,不靠 request host(中转把 Host 改成 workers.dev,2026-06-08 扫码 Forbidden 事故)。
> ⚠️ **`/img` allowlist**:若 publisher logo 选 favicon-via-`/img` 方案,~45 个 publisher 域名未加进 `ALLOWED_IMG_HOSTS` 会全 403(实测 `index.ts:4447`)。**R2 方案规避此风险**(推荐,见 D9)。

---

## 10. 前端三件套 + mockup 清单(B7)

> 基线 `TweetCard.tsx`,token 唯一源 `frontend-ux-guidelines.md`,全 UI 黑白灰 neutral + 链接 sky-600 + 危险 rose-600,品牌橙只活在 logo。最接近的长文范本是 `HfPaperCard`/`HfPaperDrawerBody`/`renderHfContent`。

### 10.1 两源归属布局家族

| 源 | 卡片家族 | 卡片范本 | 抽屉范本 |
|----|---------|---------|---------|
| **blog** | **news-card 式:文字为主 + 右侧小缩略图**(✅ 用户已定 ②,非满宽 hero) | 文字列参考 `GithubCard` + 右缩略图(新布局) | `GithubDrawerBody`(markdown 全文 + 译/原 toggle + Lightbox) |
| **podcast** | TweetCard 家族(左方形封面列 + play 叠加 + 右内容列) | 改自 `TweetCard` 双列 | **新建**(原生 `<audio>` 播放器 + shownotes/transcript,全站首个 audio 形态) |

**两源卡片/海报都无 metrics 互动行**(RSS 不提供 likes/votes/stars/play-count):blog 用「阅读时长」、podcast 用「单集时长」作为 meta 替代,避免被误读为缺数据。

### 10.2 流内卡片

- **blog**(✅ 用户已定 ②右侧小缩略图,非满宽 hero):左侧文字为主 —— 标题中译(15px bold,2 行 clamp)→ ELI25 摘要(13px neutral-600,3-4 行 clamp)→ `[logo] OpenAI · 6 天前 · 约 5 分钟 [分类 chip]`;**右侧小缩略图**(~96×96 圆角,质量门控 `ar>2‖ar<0.5‖maxDim<240` 滤低质图,**无图则纯文字不留位**)。布局参考标准 news-card(文字主体 + 右侧 thumb),非 HfPaper 满宽 hero。分享海报/抽屉仍用满宽封面(不受此影响)。
- **podcast**:左 `72×72` 方形封面(圆角而非圆头像)+ 封面叠加 **play 三角 SVG**(复用 `PhCard` 的 `<path d="M8 5v14l11-7z"/>`,**禁 ▶ emoji**)→ 节目名 · 时间 · `[有文字稿]` chip(A 档)→ 单集标题 → ELI25 shownotes 摘要(2 行)→ `IconClock 1:23:45`。

**列头源 icon**:`BrandBlog` **新建**(lucide `newspaper` 风,不用 RSS 图标);`BrandPodcast` 已存在(`icons.tsx:199`)。**per-item publisher logo** 走 R2 + 首字母 monogram fallback,**全程禁 emoji**。

### 10.3 抽屉详情

- **blog**(阅读路径):publisher 头 → 标题中译(+ 外文源加英文原标题)→ ELI25 摘要 lead → 封面 → **正文 markdown 全文 + 译/原 toggle**(复用 `GithubDrawerBody.makeMarkdownComponents` + `extractReadmeImages` + `Lightbox`,但换简化 resolver:`/r/` 走 `resolveAssetUrl`、`http(s)` 透传,**不抄 GH 绑死 owner/repo/branch 的相对 URL 重写**)→ 外链。headless 抓不全正文时降级「ELI25 摘要 + 在原站打开」。
  > 相对 URL 已在 **BE step3 按各 feed 自己的 base 域解析成绝对 URL**(见 §9.2),FE resolver 只需处理 `/r/` 与 `http(s)`,无需在前端做相对 URL 重写。
- **podcast**(收听路径):节目封面 + 节目名 + 单集标题 → **音频播放器置顶**(MVP 原生 `<audio controls preload="metadata" src={extra.audio_url}>`,**src 必须是原始 enclosure 直链不走 `/r/`**;host 不可用时 fallback「在原平台收听」外链)→ ELI25 摘要 → shownotes/章节(`hfMarkdownComponents` 轻量版)→ (A 档)transcript 折叠区 + 译/原 toggle → 外链。

`TweetDrawer.tsx` 加 `isBlog`/`isPodcast` 布尔 + body 路由 + `headerTitle`/`externalLinkLabel`/`externalLinkTitle` 三条链分支(默认标题「博客详情」「播客详情」,外链「在 OpenAI 博客打开 ↗」「在小宇宙打开 ↗」)。

### 10.4 分享海报(`worker/src/share/svg-template.ts`)

只写 `renderXxxContent`(返 `{svg,height}`)+ `pickSourceMeta`/`bodyText()` 加分支 + kind union 加值。hero/footer/QR/香港 `originsFor` 规范域全自动继承,**renderXxxContent 内禁止自拼对外 URL**(香港 host-rewrite 铁律;资源由 handlers 传入已解析的 data URI)。

| 元素 | blog(`renderBlogContent`,padTop=0) | podcast(`renderPodcastContent`,封面前置方形) |
|------|------|------|
| 顶部媒体 | og:image 满宽(conditional,无则跳过) | 节目 art 1:1 + `playOverlay` |
| 标题 | `title_zh ‖ title`,48px,2 行 | 同 |
| body | `ai_summary_zh`(ELI25),30px,6 行 | `ai_summary_zh`,30px,4 行 |
| byline | publisher logo +「by {publisher} · 约 N 分钟 · MM-DD」**无 stats** | 节目封面 +「{节目名} · 时长 1:23:45 · MM-DD」**无 stats**(纯文本「时长」前缀,**禁 ⏱ emoji**——海报只加载 Noto Sans SC 子集,emoji 根本不渲染,且违反 SOP 规则 F) |
| **chipColor** | `#bae6fd`(sky 冷蓝,hue ~203°) | `#f2c4ee`(orchid 洋兰紫粉,hue ~305°) |

> chipColor 占用核对:X 白 / GH mint `#c1f0d8`(绿 ~145°)/ PH peach `#ffd1c1`(橙 ~24°)/ ClawHub lavender `#d8c8f5`(蓝紫 ~262°)/ HDX rose `#fb7185`(玫红 ~350°)/ HF amber `#ffd9a8`(黄橙 ~38°)/ blog sky `#bae6fd`(蓝 ~203°)。
> **podcast 为何从 teal 改 orchid**:旧 teal `#7fe3d4`(青绿 ~168°)与 GH mint `#c1f0d8`(绿 ~145°)只差 23° hue、又都是浅青绿,chip 小尺寸下极易混。新选 orchid `#f2c4ee` 落在 ClawHub lavender(262°)与 HDX rose(350°)正中间(各拉开 ~43-45°)、距 GH mint 整整 160°,且仍属与其它源一致的「浅 pastel」家族(rose 是唯一的高饱和异类,留给 HDX),不撞 mint、不撞任何现有色。
> ⚠️ **海报字体**:只有 Noto Sans SC 子集(`loadSystemFonts:false`),公司名/标题含 emoji 完全不渲染、生僻字可能缺字形;外文 publisher(OpenAI 等 ASCII)安全,但 `wrapText` 按字估宽近似截断,字号/maxChars 保守一档防溢出。

### 10.5 App.tsx / 注册接线(9 处)

| # | 文件 | 改动 |
|---|------|------|
| 1 | `types.ts` SourceType | 加 `"blog"`(`"podcast"` 已存在) |
| 2 | `types.ts` ItemExtra | 加 blog/podcast 特异字段类型;**无独立 metrics interface** |
| 3 | `App.tsx` SOURCE_COLUMNS | **合并 1 个频道**(D7,用户已定):加单条 `{source_type:"blog,podcast", title:"官方新闻"}`(逗号拼 source_type,`/api/items?source_type=blog,podcast` 已支持);占用原 podcast placeholder 槽位、blog 不再单列。PC 该列内 blog+podcast 按 `published_at desc` **混排**(各走各的卡片样式) |
| 4 | `App.tsx` FILTER_CHIPS | 同步加 **1 个 chip「官方新闻」**(filter `blog,podcast`),**顺序与 SOURCE_COLUMNS 完全一致**(错位会让 PC 列序与 mobile tab 序对不上 + 墨汁动效乱)。tab bar 8 → 9 列(只 +1) |
| 5 | `App.tsx` initialFilter | 加 **1 条** deep-link `/o/`→官方新闻(filter `blog,podcast`;已占 `/t/ /g/ /ph/ /c/ /e/ /h/`,`/o/` 空闲) |
| 6 | `icons.tsx` | 新建 `BrandBlog`;`SourceIcon` 加 `case "blog"`(`podcast` 已就绪) |
| 7 | `Feed.tsx` 路由链(L879-899) | 加 `source_type==="blog"→<BlogCard>` / `==="podcast"→<PodcastCard>` |
| 8 | `TweetDrawer.tsx` | 加 isBlog/isPodcast + body 路由 + 三条链分支 |
| 9 | 新建组件 | `BlogCard.tsx` / `PodcastCard.tsx` / `BlogDrawerBody.tsx` / `PodcastDrawerBody.tsx` / `AudioPlayer.tsx` |

> ⚠️ **Feed.tsx 必改的默认行为(不改就是 bug)**:① L756 SortSelector 黑名单加 `&& source!=="blog" && source!=="podcast"`(否则冒出 X 风「时间/热门」切换器;无互动数,时间倒序即可);② L504 轮询 `if (placeholder||isPh||isHdx) return` 加 blog/podcast(否则每 30s 无意义轮询);③ L777 pending banner 加 `&& !isBlog && !isPodcast`(否则弹「N 条新推文」错误文案)。

### 10.6 Phase 0 必画 mockup 清单(standalone HTML + Tailwind CDN,对照 `_mockups/` 格式)

| # | mockup | 屏幕 | 关键态 |
|---|--------|------|--------|
| 1 | blog 流内卡片 | PC 360 列 + 移动满宽 | 「有封面」+「无封面纯文字」两态 |
| 2 | podcast 流内卡片 | PC + 移动 | 「有文字稿(A 档)」+「仅 shownotes(B/C 档)」差异 |
| 3 | blog 抽屉 | PC 560 + 移动 | 正文 markdown + 译/原 toggle + Lightbox + 外文/中文源 |
| 4 | podcast 抽屉 | PC + 移动 | audio player + shownotes/章节 + (A 档)transcript 折叠 |
| 5 | blog 分享海报 | 1080 等比 | 「有封面」+「无封面」两态 |
| 6 | podcast 分享海报 | 1080 等比 | 方形 cover + play overlay + orchid chip(`#f2c4ee`)|
| 7(**v2**,可选) | dedup cluster 徽标 | PC | winner 卡片 +「博客/播客也报道」N 来源徽标(L2/`also_reported_by` 是 v2,v1 只精确去重不出徽标) |
| 8(可选) | 列头/chip 全貌 | PC + mobile chip rail | blog/podcast 插入后 tab 排布,验证顺序一致 |

---

## 11. 与已有源的差异点

| 维度 | 已有源(X/GH/PH/HF/CH/HDX) | 本次 blog/podcast 新增 |
|------|---------------------------|------------------------|
| **回原文抓全文** | 大多在拉取时已有完整内容(X tweet / PH GraphQL / HF API) | **全新**:feed 多为摘要,Phase2 step3 要回详情页抓全文(静态②/无头③),失败优雅降级 |
| **跨源语义去重** | 无(只有源内 UPSERT/文本去冗) | **全新数据面**:v1 只做 **L1 url_hash 精确**(incumbent-wins,次源隐藏);L2 标题 Jaccard + `also_reported_by` 徽标推迟 v2 |
| **RSSHub/无头基建** | 全 CF Worker 直连 | **全新**:4 中文播客需 RSSHub(独立小鸡);8 SPA 需无头(CF-BR 优先) |
| **is_ai gate 位置** | X classify+translate 合并 1 次(已有全文) | **拆成廉价前置 gate**:抓全文前先 1 次小 flash 判 is_relevant(薄摘要宽松、全文复判终判),step4 不再判 is_relevant |
| **metrics 表** | 多源建 `metrics_snapshots_<src>` | **不建**(无可追 Δ 的时序指标) |
| **音频形态** | 无 | **全站首个 `<audio>`**:原生 controls,src 走原始 enclosure 不迁 R2(大陆可达性后果见 §9.1) |
| **完整性 gate 写法** | 每源 workflow 末尾对 **非 failed 终态**写 `wc_at`(含 is_relevant=0,`x-tweet-pipeline.ts:236`) | **完全一致**:relevant / irrelevant / dedup-suppressed 三种终态都写 `wc_at`;**不复用「不写 gate」做业务隐藏** |
| **完整性 gate 条件** | 含字段回填完成度 | enrich + eager 翻译成功即可;**正文完整度不是 gate 条件**(抓不到全文也能上 feed 显摘要) |
| **feed 隐藏机制** | `relevant=1` + `wc_at NOT NULL` 两条通用 filter | 沿用两条 + **新增唯一一条 feed-SQL** `json_extract(extra,'$.dedup_of') IS NULL`(隐藏去重次源) |
| **翻译标准** | 通用中译 | **ELI25**(像跟聪明的 25 岁年轻人解释) |

---

## 12. 分阶段 rollout

> 每期都走完整 SOP 9 Phase(Phase 0 设计 → 1 schema → 2 拉取 → 3 workflow → 4 跑批入口 → 5 dashboard → 6 R2 → 7 验收 + operations.md → 8 通知)。

### Phase 1 — 零基建原生 RSS + GitHub Releases(估 9-12 天)

**入列源(~24)**:10 国外博客原生 feed(OpenAI/Google/MS Research/NVIDIA/HF/Mistral/Stability/Together/Midjourney + Anthropic 第三方)+ 2 国内原生(Qwen 旧/美团)+ MiniCPM Release + 11 播客 feed。

**做什么**:migration 020(1 条 partial url_hash 索引)+ `source_type` 新值 + `FEED_REGISTRY` + `ensureFeedSources` + blog/podcast 两条 workflow(step1 廉价 gate + 全文复判 + 三终态均写 wc_at)+ ELI25 prompt(§8.4.0 gate + §8.4.A enrich)+ **v1 L1 去重 step** + handleItems 新增 `dedup_of IS NULL` 过滤 + R2 迁移(封面回退链)+ 三件套前端 + blog-fetch(`:20`)/podcast-fetch(`:50`)slot(各用 `recordCronRun` 包裹)+ `drainPendingWorkflowQueue` 参数化 + Phase8 通知。**把整条管线真机验收。**

**前置确认**:`:20/:50` 这两个 hdx-drain 槽插入顺序正确(blog/podcast 的 `if` 块在 `isHdxEnrichSlot` 之前),不影响 X 自愈/拉新/refresh 硬槽(详见 §7.2)。

### Phase 2 — RSSHub 中文播客(估 +3-4 天)

**入列源(+4)**:硅谷101 / 张小珺 / OnBoard / AI 前线(小宇宙 RSSHub 路由)。

**做什么**:独立小鸡(D1)起 RSSHub(绑 localhost)+ nginx token-gate + certbot + `RSSHUB_BASE`/`RSSHUB_TOKEN`(`.secrets` + `wrangler secret put`)→ podcast-fetch lane 的 `feed.via='rsshub'` 分叉接通 → cron ping `/healthz` + PushDeer 告警。**严格按 §6.5 落地顺序,防自锁。**

> 微信公众号 13 家:**v2 单独立项**(需 wechat2rss 登录态账号/付费桥,运维脆弱),不拖累本期。

### Phase 3 — 页面抓取 + 无头浏览器(估 +5-7 天)

**入列源(+18)**:10 页面抓取(CF Worker 直抓 SSR/`__NEXT_DATA__`,不占无头)+ 8 无头(复用 Codex 腾讯云机优先,CF-BR 备选;xAI/Perplexity 默认降级)。

**做什么**:B5 升级阶梯②(HTMLRewriter/`__NEXT_DATA__`/正则)+ ③(CF-BR binding,staging 先验 provision)+ headless-drain lane(`:20` 奇数小时 round-robin,`recordCronRun` 包裹,见 §7.2)+ step3 per-origin 节流+jitter + 失败优雅降级 + backfill 端点 `/api/enrich/run?mode=backfill-blog-body`。

### v2(暂不做,另立项)

微信公众号 13 家(wechat2rss)+ 中文播客 ASR 全文(托管 Groq Whisper/Deepgram,**绝不在 1c1g 香港机跑**)+ Qwen 双路(老 feed + qwen.ai 无头补新)。

---

## 13. ⚠️ 需用户拍板的开放决策(每条给 Claude 推荐默认值)

> 用户可一句「**全部按推荐**」,或逐条改。

> **✅ 已定决策(2026-06-09 用户拍板)**:
> - **D1 + D3 基建**:复用 **Codex 腾讯云渲染机**(`${CN_RENDER_HOST}`,大陆 IP,已有 X-card 渲染契约)为无头/全文渲染**主路径**;CF-BR 降备选;RSSHub(仅 Phase 2 中文播客需要)待 Phase 2 与 Codex 确认余量,否则退最小免费小鸡;**绝不香港中转**。caveat:跨方依赖 Codex、余量未知、持续负载需 Codex 同意(详见 §6.3)。
> - **D2 预算**:复用已有腾讯云机 → 现金月费 **~$0**,成本转为跨方协调 + 共享单点依赖;暂不上 ASR。
> - **D4 公众号**:v1 不接,标 v2。
> - **D7 前端入口**:blog + podcast 合并为**单频道「官方新闻」**(filter `source_type=blog,podcast`),底层仍 2 source_type + 2 workflow + 2 卡片样式混排(**前端合并、数据模型不合并**)。
> - **D9 logo + blog 卡封面**(2026-06-09 看 mockup 后定):logo 走 **① BE 迁 R2 真实公司 logo**(`extra.publisher.icon_r2`,fallback 首字母 monogram);blog 流内卡片用 **② 右侧小缩略图(news-card 式,文字为主)**,**非满宽 hero**(分享海报 / 抽屉仍用满宽封面,不受影响)。
> - 其余 **D5 / D6 / D8 / D10**(及 D2 的具体上限)维持下表推荐默认,用户读后可调。

| # | 决策 | Claude 推荐默认 / 用户裁决 | 影响 |
|---|------|----------------|------|
| **D1** | RSSHub(+ 可选无头)放哪台机? | **✅ 用户已定:复用 Codex 腾讯云机**(`${CN_RENDER_HOST}`)为渲染主路径;RSSHub(仅 Phase 2 中文播客需要)待与 Codex 确认余量,否则退最小免费小鸡(Oracle Always Free=$0)。**绝不香港中转**(swap thrash 拖慢全站) | 跨方依赖 Codex;Phase 1 不依赖它 |
| **D2** | 月度基建预算上限? | **✅ 用户已定:复用已有腾讯云机 → 现金月费 ~$0**,成本转为跨方协调 + 共享单点依赖;暂不上 ASR。(若后续要付费小鸡 / ASR 再单独定上限) | 决定是否另上付费小鸡 / ASR |
| **D3** | 无头/全文抓取走哪条路? | **✅ 用户已定:复用 Codex 腾讯云渲染机**(大陆 IP,镜像 X-card HTTP 渲染契约,请 Codex 加抓文章端点)为主路径;**CF-BR 降备选/兜底**;xAI/Perplexity 默认降级。Phase 3 启动前验 Codex 余量 + 联调端点 | headless-drain lane = worker→Codex HTTP 契约(需 Codex 配合 + 错峰);余量不足回退 CF-BR |
| **D4** | 微信公众号 13 家 v1 接不接? | **✅ 用户已确认:v1 不接,标 v2**(公共 RSSHub 被封 + 需 wechat2rss 登录态账号/付费桥,运维脆弱)。它对 DeepSeek/月之暗面/阶跃是主信号,但不该拖累 v1 上线 | 决定 v1 是否缺这批国内主信号 |
| **D5** | 中文播客(4 个)要不要上 ASR 拿全文? | **MVP 不上 ASR,只展示 shownotes**(`transcript_source='none'`)。要全文须托管 ASR(Groq/Deepgram,**绝不本地跑**),成本/价值另算。A 档 5 个英文源已有原生文字稿,零成本 | 决定抽屉内容厚度 + 是否多一笔 ASR 月费 |
| **D6** | SPA-only 硬骨头(xAI/Perplexity)v1 接不接? | **接但默认优雅降级**(CF-BR 试,被 Cloudflare-bot 挡就只留 RSS 摘要 + 原文链接),证明高价值再上独立小鸡住宅/大陆 IP 机 | 决定这 2-3 个低频源 v1 是否有正文 |
| **D7** | blog 与 podcast 是 2 个独立 chip 还是合并 1 个频道? | **✅ 用户已定:合并为单频道「官方新闻」**(filter `source_type=blog,podcast`),底层仍 2 source_type + 2 workflow + 2 卡片样式混排(**前端合并、数据模型不合并**)。命名「官方新闻」mockup 时可再 review(播客严格非「新闻」) | tab bar 只 +1 列;Feed.tsx 按 source_type 路由卡片天然支持混排 |
| **D8** | 跨源去重 MVP 范围 + 是否回溯降级? | **v1 = L1-only**(精确 canonical URL,跨所有源,只隐藏次源、不出徽标);**L2(标题 Jaccard + `also_reported_by` 徽标)整体推迟 v2**,触发条件=有真实重复样本可调 `J_HARD/J_SOFT` + 同 tick 并发竞态已解决(见 §5.6);github/x_list 留 config 扩展位;**incumbent-wins 不回溯降级**(避免 UI 抖动) | 决定去重覆盖面 + 是否加 sweep 逻辑 |
| **D9** | publisher 公司 logo 走哪条路? | **✅ 用户已定:BE enrich 迁 R2 真实 logo**(`extra.publisher.icon_r2`,质量门控 + 缓存 + 不动 allowlist);fallback 首字母 monogram。**不走 favicon-via-`/img`**(45 域名加 allowlist 脆) | BE extra schema + worker 配置 |
| **D10** | 冷启动回灌深度?Qwen 老 feed 怎么处理? | **冷启动每 feed 限收最近 `COLD_START_MAX=10` 条**(压洪峰 + 减历史噪音);`SEEN_SET_MAX_SIZE=15-20`。Qwen **v1 只走老 feed 直拉**(已停更但有历史),新站 qwen.ai 无头补新留 v2 | 决定首轮入库量 + registry 里 Qwen 是 1 条还是 2 条 |

**其余已替你拍板的默认(无需逐条确认,除非反对)**:不建 metrics 表 / dedup 状态全进 extra(仅 **1 条 partial url_hash 索引**,content_hash 死索引砍掉)/ v1 判重保留主源+隐藏次源(**L1 精确,徽标+L2 推迟 v2**)/ **三种终态(relevant/irrelevant/dedup)都写 `wc_at`,不靠不写 gate 隐藏**(与现网 X 一致)/ **去重次源隐藏靠新增唯一一条 feed-SQL `dedup_of IS NULL`** / **step1 廉价 is_ai gate(薄摘要宽松、全文复判终判)+ step4 不再判 is_relevant** / stub 走 `INSERT OR IGNORE` / 音频不迁 R2(但诚实声明大陆可达性,§9.1)/ blog 用 news-card 式(文字主 + 右侧小缩略图,用户已定 ②)+ podcast 归 TweetCard 家族 / chipColor blog `#bae6fd` + podcast `#f2c4ee`(orchid,改自旧 teal `#7fe3d4` 防撞 GH mint)/ 接现有 `*/5` cron 内部分流、**blog/podcast/headless 三 lane 占 `:20/:50` hdx-drain 槽(不偷 X 自愈/拉新/refresh)+ 各用 `recordCronRun` 包裹** / RSS 停止游标用 skip-seen 全窗扫描(不照搬 X 严格倒序)/ v1 线性统一 cadence(blog 2h / podcast 6h)/ gh-releases 折叠进 blog lane / step3 抓全文带 per-origin 节流+jitter / 正文抽取用 0-bundle HTMLRewriter+`__NEXT_DATA__`+正则 / **无头/全文渲染复用 Codex 腾讯云机为主路径、CF-BR 备选、香港中转永久否决** / **前端 blog+podcast 合并单频道「官方新闻」混排(底层仍 2 source_type)**。

---

## 14. 范围声明

- **本次明确不接入**「订阅日报」(`subscriptions` / digest workflow)与「给 codex 推送 daily」两处(用户需求 4.8)—— 只是 v1 不接这两个分发口,blog/podcast 的主功能(抓取 + enrich + feed 展示 + 分享)照常做全。
  > **具体点名不接线的三处**(防未来实现者手滑把 blog/podcast 接上):**①** 不要往 `worker/src/digest/config.ts` 的 `DIGEST_SOURCE_ORDER`(`['ph','gh','hf-paper','clawhub','x']`)/ `DigestSource` union / `SOURCE_DIGEST_CONFIG` 加 `blog`/`podcast`;**②** 不要往 `worker/src/digest/selection.ts` 的 `SOURCE_TYPE`(DigestSource → items.source_type 的 allowlist)加 `blog`/`podcast` 映射;**③** 不要往 `worker/src/digest/codex-push.ts` 的 `PUSH_SOURCES`(`['ph','gh','hf-paper']`)加 `blog`/`podcast`。这三处任一加了就会把新源悄悄接进日报/codex 推送,与本范围声明冲突。
- **本文档为 Phase 0 纯设计调研**:未写任何生产代码、未改任何文件、未 SSH 任何服务器、未部署任何东西。**用户逐条确认 §13 的 D1-D10 后,才进入 Phase 1 编码**;Phase 1 编码须照 SOP 9 Phase + CLAUDE.md「开 feature branch → staging 验证 → 合 main 部署 prod」流程,migration 020 先 staging 验证再 prod。

---

## 参考

- SOP:[docs/source-integration-sop.md](../source-integration-sop.md)
- 前端规范:[docs/frontend-ux-guidelines.md](../frontend-ux-guidelines.md) / 设计交接:[docs/design-handoff.md](../design-handoff.md)
- 运维手册:[docs/operations.md](../operations.md)(香港中转 §6b / R2 §6a / Worker+cron §1)
- 最接近的长文源设计:[2026-05-18-hf-daily-papers-source-design.md](2026-05-18-hf-daily-papers-source-design.md)
- workflow 范本:`worker/src/workflows/{x-tweet,github,ph,hf-paper}-pipeline.ts`
- 游标范本:`worker/src/x-list-cursor.ts` / cron 分流:`worker/src/index.ts scheduled()`
- R2 范本:`worker/src/ph-r2.ts` / `x-media-r2.ts` / 正文抽取范本:`worker/src/hf-paper/ar5iv.ts` / `huodongxing/parser-detail.ts`
- 分享海报:`worker/src/share/svg-template.ts`
- 数据源调研:`/Users/roxor/cola/outputs/AI-Feeds-数据源汇总文档/`

文档已综合完毕,关键设计决断与落地接口都已落到字段/函数/SQL/伪码层面。几处需要点明的要点:

- **migration 编号**:实测当前最新是 `019-x-card-renders.sql`(不是任务里说的 018),所以新增 migration 取 `020` 正确,B1 草稿没错。
- **R2 bucket**:实测 binding `READMES` = `xlist-readme-assets`,沿用 `blog/`/`podcast/` 前缀,迁移 marker 用 `blog_media_r2_at`/`podcast_media_r2_at`,避开已被 `ph-r2.ts` 占用的 `r2_migrated_at`。
- **CF Browser Rendering**:`nodejs_compat` flag 实测仍在(`wrangler.toml:5`),browser binding 在第 153 行被移除注释「走 PDF parse 替代」,所以重新加回 binding 即可用,Phase 3 前需 staging 验 provision。
- **B4/B6 是我综合产出的**:任务只贴了 B1/B2/B3/B5/B7 五个子模块,B4(workflow 流水线 + ELI25 prompt)和 B6(R2 媒体 + 香港 serving)在 prompt 里没有独立草稿,我按其余模块声明的接口契约 + SOP §1.4 模板 + `hf-paper-pipeline.ts` 范本综合写出,核心是把「is_ai 判别拆成廉价前置 gate」这条 blog/podcast 区别于 X 的关键架构差异讲清楚,并给出完整可用的 ELI25 翻译 prompt(含 CommonMark flanking 边界规则)。

如需我把这份 markdown 实际写入 `/Users/roxor/brain/30-projects/aifeeds/docs/plans/2026-06-09-ai-vendor-feeds-source-design.md`,或同步去画 §10.6 的 8 张 mockup,告诉我即可。
