---
title: ai-feeds SEO / GEO 优化讨论备忘录（2026-05-07 → 2026-05-10）
date_range: 2026-05-07 / 2026-05-10
topic: SEO / GEO / .cc 国内镜像站 / Cloudflare 配置 / 中国备案
participants: 用户 + Claude Code (Opus 4.7, 1M context)
status: 讨论已结束，设计稿已落盘，未实施
---

# ai-feeds SEO / GEO 优化讨论备忘录

> **背景**：从 2026-05-07 开始的一段连续讨论，目标是为 ai-feeds（X / GitHub / Product Hunt / ClawHub 四源 AI 资讯聚合站）规划 SEO 和 GEO（生成式引擎优化）的整体策略。讨论横跨 4 天 12 轮，最终落盘了一份调研报告 + 一份 `.cc` 国内静态镜像站设计稿。
>
> **本文档目的**：把这段对话的关键事实、判断、决策、产出按时间线归档，方便未来检索。不是设计文档替代品（设计文档见相关链接）。

---

## 关键产出索引

| 类型 | 路径 | 用途 |
|------|------|------|
| 调研报告（HTML） | [`docs/plans/_research/2026-05-07-search-engines-ai-bots-research.html`](../plans/_research/2026-05-07-search-engines-ai-bots-research.html) | 30+ 引擎规则 + AI bot 三类法 + ICP 备案专题 + JS 渲染对比 + 来源 URL |
| 镜像站设计稿 | [`docs/plans/2026-05-08-cn-mirror-cc-domain-design.md`](../plans/2026-05-08-cn-mirror-cc-domain-design.md) | `.cc` 静态镜像方案、成本估算、合规加固、实施分阶段 |
| 运维手册更新 | [`docs/operations.md`](../operations.md) §「Cloudflare 运维 token」 | CF master / sub-token 用法 + zone resource 写法表 + permission group ID + endpoint 速查 |
| 环境变量 | `.secrets/cf-ops.env` | 新增 `CF_ZONE_AIFEEDS_COM` / `CF_ZONE_ID` |
| TODO.md | Roadmap 第 6 项 | 国内 SEO / GEO 镜像站任务登记 |

---

## 第 1 轮：四个开放问题（2026-05-07 早）

**用户问**：

1. Cloudflare 反爬配置与 SEO 爬虫抓取是否矛盾？
2. 长期国内 + 国际都要做，但短期没做 i18n、产品没多语言，先面向国内做优化的具体手段差异？
3. `find-skills` 看下有哪些 SEO skill 可用
4. 不清楚的可以从社区搜高质量答案

**我做的事**：
- 跑 `npx skills find seo` / `find geo` 列出 6 个最相关 skill（含 `coreyhaines31/marketingskills@seo-audit` 99.5K 安装、`addyosmani/web-quality-skills@seo` 等）
- tavily 搜 CF Bot Fight Mode + Googlebot / 国内 SEO + 备案 / GEO 2025 三个维度
- qmd 搜 brain 知识库 GEO 历史调研笔记

**关键判断**：
- CF Bot Fight Mode / Super Bot Fight Mode / Block AI Bots 默认排除 `Search Engine Crawler` 这一 verified bot 分类，对 Googlebot / Bingbot / Baiduspider 不影响
- 真正可能误伤搜索引擎的是 Under Attack Mode（5 秒盾）和 Block AI Bots 这两个开关
- 国内 SEO 的核心瓶颈不是 SEO 算法本身，而是 SPA 不渲染、`.com` 未备案被境内 ISP 拦截
- 国内 vs 国际差异：JS 渲染（Baiduspider 不执行 JS）、备案、CDN 节点、外链结构、提交入口都不一样

---

## 第 2 轮：CF 配置实测 + 流量洞察

**用户问**：
1. 看项目 env 和运维文档，找 CF 主权限 token，检查 3 个开关（Bot Fight / Under Attack / Block AI Bots）现状
2. CF 后台是否有流量洞察 / SEO 分析数据？

**我做的事**：
- 读 `.secrets/cf-ops.env` 拿到 master token（account-owned，权限只能创建子 token）
- 列 permission groups 找需要的几组：Zone Read / Zone Settings Read / Zone WAF Read / Bot Management Read / Analytics Read / Firewall Services Read / Account Analytics Read
- 创建 24h 过期的只读子 token（**踩了 zone resource 写法的坑，后来落到运维手册**）
- 拉 3 个开关 + 4 条 WAF 规则 + 24h GraphQL Analytics

**关键发现（CF 实测）**：

| 开关 | 现状 | 含义 |
|------|------|------|
| `security_level` | medium | 没开 5 秒盾 |
| `fight_mode` | true | Bot Fight Mode 开着，但默认排除 verified bot |
| `ai_bots_protection` | disabled | AI bot 都能进，GEO 友好 |
| `content_bots_protection` | disabled | 同上 |
| `crawler_protection` | disabled | 同上 |

**4 条 WAF 规则**（关键发现）：
- `allow-verified-search-engines`: 给所有 verified search engine bot 开 SKIP 绿灯（项目早期就有意识地配过）
- `block-bad-bots`: 拦 MJ12bot / **AhrefsBot** / **SemrushBot** / DotBot / 空 UA — **以后想用 Ahrefs/Semrush 反向审计自家站会被自家拦**
- 2 条 blog 子域专用（不影响主站）

**24h verified bot 流量分布（最关键的数据）**：

| 类别 | 24h 次数 |
|------|---------|
| AI Assistant（ChatGPT-User 等） | 124 |
| AI Search（Perplexity 等） | 59 |
| AI Crawler（GPTBot / ClaudeBot 等） | 23 |
| **Search Engine Crawler** | **5**（且其中 1 次落 blog 子域） |
| Advertising & Marketing | 2 |

**Top AI bot UA**：ChatGPT-User/1.0 = 119 次、PerplexityBot/1.0 = 44 次、GPTBot/1.3 = 22 次、ClaudeBot/1.0 = 19 次。

**结论**：
- CF 配置完全没问题，反而 `allow-verified-search-engines` 是有意识为搜索引擎留的绿灯
- 真正的 SEO 死结不在 CF，是 SPA 没 SSR + 没提交 sitemap + 没外链
- GEO 数据意外好——完全没做优化 AI bot 已经主动来抓
- **CF 免费版限制**：`httpRequestsAdaptiveGroups` 时间窗严格 < 24h；`botScore` 字段 authz 拒；Page Rules endpoint 不接受 account-owned token

---

## 第 3 轮：把 zone ID 和 token 用法落盘

**用户指示**：
> 把 zone ID 也放到 env 和运维手册里说明好，以后不要再被权限限制，主 token 的用法写明白

**我做的事**：
- `.secrets/cf-ops.env` 新增 `CF_ZONE_AIFEEDS_COM='<32-hex zone id>'` + `CF_ZONE_ID`（默认指向，实际值见 `.secrets/cf-ops.env`，不进 docs）
- `docs/operations.md` § Cloudflare 运维 token 节大幅扩展：
  - **Resource 写法表**（踩坑笔记）：account-owned token 创建子 token 时，zone resource 不能用 `com.cloudflare.api.account.zone.*`（会报"必须 nest 到具体 account"）也不能用 `com.cloudflare.api.account.{account_id}.zone.*`（报"not supported resource type"），正确写法是 `com.cloudflare.api.account.zone.{ZONE_ID}` nest 到具体 zone ID
  - 已知 permission group ID 表扩到 13 项（含 Bot Management / Zone / WAF / Analytics / Firewall）
  - 常用 endpoint 速查：3 个开关一次性查 + Analytics GraphQL 模板（含 23h 时间窗注意）
  - 免费版 plan 已知限制清单

---

## 第 4 轮：要计划，并提出备案疑问

**用户问**：
- 不着急动手，但要做详细的计划，按效果排优先级，区分 coding vs 人工提交
- 听说百度 / 360 对大陆未备案站点不收录是真的吗？
- 各搜索引擎和 AI 平台的官方规则做一轮严谨调研，形成文档，HTML 可视化也行

**我做的事**：
- 用 `AskUserQuestion` 确认产出形式：用户选「先调研 HTML，看完后再讨论计划」
- 用户明示：「brain 里关于"搜狐GEO"是公司创新项目，不要作为重点参考，把精力中心放到全网权威信源和社区信息」
- 用户明示：调研要全面，优化侧重和节奏后续看过调研再讨论

**关键约束记录**：
- 调研产出：单文件 HTML（self-contained）
- 信源优先级：官方文档 > 英文 SEO 媒体（SEJ / SEL / Moz）> 中文社区（V2EX / 知乎 / CSDN / 蓝点网 / 白杨 SEO）> 个人博客
- 不依赖 brain 内部资料

---

## 第 5 - 6 轮：4 个并行 agent 调研 + 整合 HTML

**我做的事**：用 background agent 并行 4 路调研：

| Agent | 范围 |
|-------|------|
| 1 | 国内搜索引擎（百度 / 360 / 搜狗 / 神马 / 头条）+ 备案要求确认 |
| 2 | 国际搜索引擎（Google / Bing / Yandex / DuckDuckGo / Brave / Naver / Seznam / Mojeek / Marginalia） |
| 3 | 国际 AI 引擎（OpenAI / Anthropic / Perplexity / Google-Extended / Apple / Meta / Amazon / ByteDance / Common Crawl / Cohere / Mistral / xAI / DeepSeek） |
| 4 | 国内 AI 平台（豆包 / 文心 / 通义 / Kimi / 智谱 / 混元 / 商汤 / 讯飞 / MiniMax / DeepSeek / 华为 / 360）+ ICP 备案规则全景 |

整合到一份 12 章 HTML 报告，含 sticky TOC、可折叠按钮、`localStorage` 状态保存、键盘快捷键 `T`。

**调研里最关键的 10 个发现**：

1. CF verified bot 体系默认放行所有搜索引擎；ai-feeds 当前不需要再调 CF
2. AI bot 已分裂为训练 / 检索 / 用户 fetch 三类，不能用一个开关一刀切
3. OpenAI 2025-12-09 修订文档：ChatGPT-User 不再保证遵守 robots.txt；Anthropic 三个 bot 都遵守
4. Cloudflare 在 2025-08 公开取消 Perplexity 的 verified bot 资格（Perplexity 用伪装成 macOS Chrome 的 UA + ASN 轮换）
5. 国内 8 家主流 AI 厂商（阿里 Qwen / 腾讯混元 / Kimi / 智谱 / DeepSeek / MiniMax / 商汤 / 讯飞）没有公开训练 UA，robots.txt 对它们无效
6. Bytespider 不严格守 robots.txt（HAProxy 实测占其 AI 爬虫流量约 90%）
7. **「百度对未备案站不收录」是软强制**：政策上无明文，但境内 ISP 在 80/443 端口拦截未备案的境内 IP，等价于爬虫连不上
8. Vercel 2025-12 实测：主流 AI 爬虫全部不渲染 JS。只有 Googlebot 是 evergreen Chromium 全量渲染
9. IndexNow 2026 仍由 Bing / Yandex / Seznam / Naver 主推，Google 长期拒绝
10. CF 在 2025-07-01 「Content Independence Day」之后，约 2.5M+ 站点（约 20% 公网）启用了 managed AI block

---

## 第 7 轮：可折叠 TOC

**用户指示**：
> 左侧目录改成可收起的

**我做的事**：
- CSS：layout `grid-template-columns` 加过渡，`.collapsed` 状态压到 0
- 加 `<button class="toc-toggle">` 浮动在屏幕左上 14px、宽 32px
- 状态用 `localStorage` 持久化，刷新后保持
- 键盘快捷键 `T` 触发（输入框中不响应）
- sidebar 顶部 padding 加大到 60px 让按钮不挡 toc-title
- 折叠态 main 加 padding-left 60px 让按钮不压主内容

---

## 第 8 轮：可读性重写

**用户指示**：
> 调研信息很完备，但写的文案可读性太差。看下项目 GitHub 内容翻译给 DeepSeek 时的 prompt，从中提取写作质量要求，按这个质量要求重写

**我做的事**：找 3 处翻译 prompt：

| 位置 | 关键质量要求 |
|------|------------|
| `worker/src/github.ts:785`（README 翻译 v2.2） | 「清晰、自然、技术性，避免营销腔」（第 8 条）|
| `worker/src/enrich.ts:2121`（推文翻译） | 「Output natural colloquial Chinese (口语化)」+ 中国 AI 社区惯用术语：agent → 智能体、token 不译、PR 不译、fork 不译、fine-tune → 微调 |
| `scrapers/ph/translate.py:24`（PH 翻译） | tagline 用正式 product copy 调性、用户评论用口语化保留语气词、保留 LLM/RAG/agent/Cursor/Claude/GPT/TypeScript/LSP/Slack 等专有名词原文 |

**对照诊断的 6 类问题**：
1. 大量情绪词（"灾难性 / 撕得很难看 / 严重违规 / 重磅 / 硬伤"）→ 改精确描述
2. 摘要 listicle 没有判断收口 → 改"事实 + 判断 + 数据印证"短段
3. 大表格塞 7-8 列硬塞 → 主表 4-5 列，细节折叠到 `<details>`
4. 关键问题答案是依据罗列 → 改"答 + 据 + 容易忽略"三段结构
5. 大量 emoji（🚨🎉⚠️📌）当判断符号 → 删除文中 emoji，靠 pill / badge 系统传达状态
6. 复述原文叙事顺序 → 按"模型 → 例证 → 反证"层次重组

**实施**：用 Bash 拼接（head 1-408 + 新 main + tail 1694-）整体替换 main 内容，CSS / TOC / 折叠按钮 / JS 不动。`.bak` 保留原版以便对比。

---

## 第 9 轮：要 SEO / GEO 计划

**用户问**：
> 我应该如何给本项目做 SEO 和 GEO 优化呢？

**我给的 P0-P5 框架**：

| 层 | 主题 | 类型 | 工作量 |
|---|------|------|--------|
| P0 修底 | SSR / prerender + robots.txt 三类法 + sitemap.xml + schema.org JSON-LD | coding | 1 周 |
| P1 站长平台提交 | Google / Bing / Yandex + IndexNow key + 国内五站长 | 人工 + 一行 coding | 单平台 30-60 min |
| P2 中国战略决策 | A. 启用 `.cc` 国内主站 / B. 维持 `.com` 单域 / C. 走纯 AI 引擎路径 | 决策 | — |
| P3 GEO 强化 | llms.txt + AI 友好结构 + AI referrer 追踪 | coding | 半天 - 2 天 |
| P4 内容矩阵 | 国内（知乎 / CSDN / SegmentFault / 稀土掘金）+ 国际（HN / Reddit / Twitter / Substack） | 持续 | 按月 |
| P5 监测 | GA4 / CF AI Crawl Control / crawl-to-referral 比率 | 半天 + 月度 | — |

**核心判断**：**SSR 是阻塞所有其他动作的单点瓶颈**。CF 配置已经友好、AI bot 已经在自然抓、连 GEO 自然流量都有——但抓到的是空壳，引用质量为零。修这一项收益最大；不修的话 sitemap、schema、内容矩阵全是空转。

---

## 第 10 轮：讨论 `.cc` 静态镜像可行性

**用户问**（明确不动手，先讨论）：
> P2 应该做，但问题是如何做。.cc 完成备案后，面向国内用户和搜索引擎，提供由 .com 抓取、翻译完成后的页面的静态页内容，每天几百几千个新增静态页，这些 .cc 页面仅展示 .com 抽屉内容，然后页面内部留跳转链接把 C 端用户导流去 .com 使用完整产品。
>
> 1. 是否可行？
> 2. .cc 国内轻量服务器是否会大量增加成本（存储、流量）？
> 3. 是否有监管合规风险？信源是 X / YouTube 等"墙外" UGC 内容，但已从抓取源头过滤只做垂类 AI 领域

**我答**（三问三答）：

### Q1 可行性：完全可行
业内成熟做法（量子位 / 机器之心 / 新智元 / 36氪 / 雷锋网 / aibase 等）。数据流：`.com` D1 → cron 增量生成器 → 境内 OSS（阿里云 / 腾讯云 / 七牛）→ 境内 CDN → `.cc` 域名指向。每个 item 一个 `.html`，主页 / 列表页静态生成，sitemap 按更新时间分块。`.cc` 不做交互、不调 `.com` API、不开评论——纯静态最大降低合规复杂度。

### Q2 成本：早期月百元级，规模化月千元级

| 规模 | 累计存储 | 日 PV | 月流量 | 月成本 |
|------|---------|-------|--------|------|
| 第 1 个月 | ~600 MB | 1 万 | ~24 GB | ~30-50 元 |
| 第 6 个月 | ~4 GB | 5 万 | ~120 GB | ~80-150 元 |
| 第 1 年 | ~7 GB | 10 万 | ~240 GB | ~150-300 元 |
| 成熟期 | ~50 GB | 100 万 | 2.4 TB | ~1000-2000 元 |

不需要 Cloudflare 中国合作版（企业级合同几万 / 年起，不适合当前阶段）。七牛云免费额度（10GB / 10GB）覆盖前 1-2 个月。

### Q3 合规：低 - 中等风险，可控但需加固

**整体评估**：风险比"政治新闻聚合站"低一个量级，比"国内自建 AI 工具发布站"高一档。同行（量子位 / 机器之心 / aibase 等）已验证可行多年。

**真实风险（按概率排序）**：
1. 某条内容意外触发举报 → 临时整改 → 国内访问中断几天（高概率事件，需 takedown 流程兜底）
2. X 信源里偶尔混进政治评论 → 仅靠 `is_relevant` 不够，需第二层敏感内容过滤
3. YouTube 视频 inline 嵌入 → 可能被判"传播境外视听节目"（设计上规避，不 iframe）

**9 条加固清单**（按重要性）：
1. 第二层敏感内容审核（阿里云 / 腾讯云天御 / 火山引擎，每次几毛钱）
2. takedown 流程（底部固定邮箱 / 表单 + 1-2h 内下线）
3. 备案号 + 公安备案号 + 链接到 beian.miit.gov.cn
4. 免责声明（"垂类技术资讯整理 / 不构成投资建议"）
5. 来源溯源（每条 item 留原 URL + 抓取时间戳 + 翻译模型版本）
6. 不 inline 嵌入境外视频（用截图 + 跳转链接）
7. 不开评论 / UGC 二次互动（避开 BBS / 新闻信息服务定性）
8. 公安备案（ICP 备案后 30 天内办）
9. AI 网站说明函（2024 工信部新规）

**用户已具备的优势**：垂类 AI、已 LLM 过滤、已翻译、信源是行业账号 / 论文 / 开源项目（非个人 vlog）、纯静态架构。

---

## 第 11 轮：把讨论结论展开成正式设计文档

**用户指示**：
> A 启用 `.cc` 是必要的，但不着急动手实际开发，可以先把讨论结论展开记录到文档，方便未来开展对应工作

**我做的事**：
- 落地设计稿 [`docs/plans/2026-05-08-cn-mirror-cc-domain-design.md`](../plans/2026-05-08-cn-mirror-cc-domain-design.md)（28 KB / 529 行 / 10 节）
- 章节：问题陈述 → 方案选型（4 方案对比）→ 架构总览（ASCII 数据流图）→ 技术方案细节 → 合规设计 → 成本估算 → 实施分阶段（P0 准备 / P1 MVP / P2 上线 / P3 优化）→ 风险与待决策 → 相关文档 → 待确认 / 待补充
- 同步登记到 TODO.md Roadmap 第 6 项

**5 个等用户拍板的决策点**：
1. 境内 OSS / CDN 厂商（七牛云 / 阿里云 / 腾讯云）
2. AI 训练 bot（GPTBot / ClaudeBot 等）在 `.cc` 上放还是禁
3. takedown 邮箱地址定名
4. 备案中是否已勾选「AI 服务」类目（2024 工信部新规）
5. 媒体存储策略（图片 / 视频缩略图是否复制到境内 OSS）

---

## 第 12 轮：归档对话（本备忘录）

用户要求把整段 session 关于 SEO / GEO 的对话记录归档到 brain 项目目录下。本文档即此。

---

## 跨 session 的关键事实速查

如果未来 session 接手时只看一份文档，看本备忘录的「关键产出索引」+「调研里最关键的 10 个发现」+「P0-P5 框架」+「.cc 镜像方案 5 个待决策点」即可快速进入语境。

更深的：
- 调研报告 HTML 是事实层
- `.cc` 设计稿是方案层
- `docs/operations.md` § Cloudflare 运维 token 是工具层（CF API 怎么用）

---

## 备注：本次 session 中的工具操作踩坑（已落到 operations.md）

CF API 创建子 token 时 zone resource 的写法有 3 种错误尝试 + 1 种正确：

| 写法 | 结果 |
|------|------|
| `com.cloudflare.api.account.zone.*` | 报 "must specify a zone for account owned tokens" |
| `com.cloudflare.api.account.{account_id}.zone.*` | 报 "is not a supported resource type" |
| `com.cloudflare.api.account.{account_id}.zone.{zone_id}` | 同上 |
| `com.cloudflare.api.account.zone.{zone_id}` | ✅ 正确 |

完整流程 + 可复制的 JSON 模板 + 13 个 permission group ID 表见 `docs/operations.md` § Cloudflare 运维 token。
