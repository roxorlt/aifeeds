# `.cc` 国内静态镜像站设计 — ai-feeds

> **目标**：用 `ai-feeds.cc`（已备案，主体「${BEIAN_ENTITY}」、对外品牌「AI源信」）做国内 SEO / GEO 的合规入口。`.com` 继续承载完整动态产品，`.cc` 只做「从 `.com` 数据库抓取 + 渲染成静态页」的内容矩阵，把 C 端用户引流回 `.com` 使用完整功能。
>
> **背景**：调研报告 [`docs/plans/_research/2026-05-07-search-engines-ai-bots-research.html`](_research/2026-05-07-search-engines-ai-bots-research.html) 结论——`.com` 未备案 + 境内 ISP 在 80 / 443 端口拦截未备案的境内 IP，百度 / 360 / 神马 / 搜狗 / 头条搜索的爬虫从大陆节点连不上 `.com`。意味着面向中国市场的 SEO 流量天花板被卡在底层，必须开第二条合规路径。
>
> **状态**：设计稿。本文档不含实施代码，只锁定方案、成本、合规策略。下一阶段拆 PR 实施。

---

## 一、问题陈述

### 当前现状（来自 2026-05-07 CF API 实测）

| 维度 | 现状 | 含义 |
|------|------|------|
| `.com` 24h Search Engine Crawler 抓取 | 5 次（主站 0 次，1 次落 blog 子域） | 百度 / Googlebot 等基本没认识到这个站 |
| `.com` 24h AI Bot 抓取 | 约 206 次 | GEO 自然流量已起，但 dashboard 是 SPA，AI bot 看到的是 `<div id="root">` 空壳 |
| CN 24h 流量占比 | 1.6%（含 staging 自家测试） | 中国市场尚未真正进入 |
| `.com` 备案状态 | 未备案 | 境内 ISP 拦截，百度爬虫从大陆节点连不上 |
| `.cc` 备案状态 | 已备案，主体「${BEIAN_ENTITY}」 | 国内合规入口的物质基础已就绪 |

### `.cc` 镜像站要解决的核心 3 件事

1. **绕过未备案带来的 ISP 拦截**，让百度 / 360 / 神马 / 搜狗 / 头条搜索的爬虫能稳定抓到合法的境内页面
2. **绕过 SPA 不渲染的问题**，给所有非 Googlebot 引擎和所有 AI bot 喂可读的静态 HTML（调研报告 §10：Vercel 2025-12 实测主流 AI 爬虫全部不渲染 JS）
3. **建立国内合规品牌入口**，备案号、公安备案号、takedown 表单、免责声明等国内站强制要求都集中在 `.cc` 上，避免污染 `.com` 的产品体验

---

## 二、方案选型

### 方案对比

| 方案 | 描述 | 国内 SEO 上限 | 实施成本 | 合规复杂度 | 评估 |
|------|------|--------------|---------|----------|------|
| **A. `.cc` 静态镜像站** | `.com` D1 → cron 生成 HTML → 境内 OSS + CDN → `.cc` 服务静态页，底部跳转 `.com` | 完整百度 / 360 / 神马 / 搜狗收录 | 中 | 中 | **采用** |
| B. `.cc` 301 重定向到 `.com` | `.cc` 仅做品牌入口跳转 | 接近零（百度对 301 跳出境外的页面收录极差） | 极低 | 低 | 不采用 |
| C. 维持 `.com` 单域 | 不做国内市场 | 0 | 0 | 0 | 不采用（放弃国内） |
| D. CF 中国合作版（百度云 / 京东云接入） | 让 `.com` 走中国合作版 CDN | 完整 | 极高（企业级合同，几万 / 年起） | 等同 A | 不适合当前阶段 |

### 为什么选 A

- 业内成熟做法：量子位、机器之心、新智元、36氪、雷锋网、aibase 等都是「境外动态产品 / SaaS + 境内静态内容矩阵」双站架构，运营多年合规可控
- `.com` 产品体验不受影响（任何动态需求都在 `.com` 完成）
- 静态生成的合规风险最低（不开评论、不收 UGC、不做用户登录，避免被定性为 BBS / 论坛 / 新闻信息服务）
- 成本可控（早期月百元级，详见第六节）

---

## 三、架构总览

### 数据流向

```
┌──────────────  Production (.com，境外，未备案)  ──────────────┐
│                                                              │
│  https://ai-feeds.com                                        │
│    ├→ Pages: xlist-dashboard（React + Vite SPA）             │
│    └→ Worker: xlist-api                                      │
│        ├→ D1: xlist（items 表 = 4 源统一 schema）            │
│        ├→ KV / R2 / Cron / Auth                              │
│        └→ 完整动态产品：登录 / 抽屉 / 筛选 / 分享             │
└──────────────────────────────────────────────────────────────┘
                          │
                          │ 每小时增量 cron（在 .com worker 里加新 handler）
                          │ SELECT * FROM items WHERE updated_at > ? AND is_relevant=1
                          ▼
┌──────────  静态生成器（在 .com worker 内）  ──────────────────┐
│                                                              │
│  1. 拉新增 / 更新的 item（增量）                              │
│  2. 模板渲染 → HTML（template literal，无依赖）              │
│     - 详情页：/item/<id>.html                                │
│     - 列表页：/source/<x|gh|ph|clawhub>/index.html           │
│     - 主页：/index.html                                      │
│  3. 生成 sitemap.xml（按更新时间分块，单文件 ≤ 5万 URL）      │
│  4. 上传到境内 OSS（阿里云 OSS 或腾讯云 COS）                │
└──────────────────────────────────────────────────────────────┘
                          │
                          │ S3 兼容 API 上传（@aws-sdk/client-s3 适配）
                          ▼
┌──────  境内对象存储 + CDN (.cc，已备案)  ──────────────────────┐
│                                                              │
│  阿里云 OSS（或腾讯云 COS）                                  │
│    └→ Bucket: ai-feeds-cn-mirror                             │
│  阿里云 CDN（或腾讯云 EdgeOne 国内版）                       │
│    └→ CNAME: ai-feeds.cc → CDN 加速域名                      │
│                                                              │
│  https://ai-feeds.cc                                         │
│    ├→ /            主页（按 source 分类的列表索引）          │
│    ├→ /item/<id>   单条 item 静态页                          │
│    ├→ /source/x    X 源列表页                                │
│    ├→ /source/gh   GitHub trending 源列表页                  │
│    ├→ /source/ph   Product Hunt 源列表页                     │
│    ├→ /source/ch   ClawHub 源列表页                          │
│    ├→ /sitemap.xml 自动生成                                  │
│    ├→ /robots.txt  按调研 §03 三类法模板                     │
│    ├→ /takedown    侵权 / 违规内容举报表单                   │
│    └→ /about       品牌介绍 + 备案号 + 免责声明              │
│                                                              │
│  Cron: 在 .com 主 worker 里跑（不在 .cc 起单独服务）          │
│  Secrets: 阿里云 / 腾讯云 AccessKey 写入 .com worker secrets  │
└──────────────────────────────────────────────────────────────┘
```

### 职责分工

| 职责 | 归属 | 备注 |
|------|------|------|
| 数据抓取（4 源 scraper） | `.com` | 不变 |
| 翻译 / AI 评分 / metric 刷新 | `.com` | 不变 |
| D1 数据库 | `.com` | `.cc` 不直接读 D1 |
| 用户系统（登录 / session / share） | `.com` | `.cc` 不做 |
| 抽屉 / 筛选 / 排序 | `.com` | `.cc` 不做 |
| 静态页生成 + 上传 OSS | `.com` worker（新增 cron） | 复用现有架构，不另起服务 |
| 境内 CDN 加速 | `.cc` | 阿里云 / 腾讯云 |
| 备案号 / takedown / 公安备案展示 | `.cc` | 模板固定区域 |
| 内容审核（敏感词过滤） | `.com` 在生成阶段做 | 调用阿里云 / 腾讯云内容安全 API |

---

## 四、技术方案细节

### 4.1 静态生成器

**位置**：复用 `.com` 现有 worker（`xlist-api`），新增一个 cron handler。

**触发频率**：每小时一次（与 enrich cron 错开 5-10 分钟）。

**增量策略**：
- 维护 `cn_mirror_state` D1 表，记录每个 source 的 `last_synced_at`
- 每次 cron 拉 `items WHERE updated_at > last_synced_at AND is_relevant = 1` → 渲染 → 上传
- 主页 / 列表页 / sitemap 每次都重生（小，可忽略）
- 详情页只生成新增 / metrics 有变化的

**模板**：worker 里直接 template literal 拼字符串，不引入 Eta / Mustache 等依赖。模板独立成文件 `worker/src/cn-mirror/template.ts`。

**模板需要包含**：
- `<head>` 完整 SEO 元数据：title / meta description / canonical / og:* / schema.org JSON-LD
- 备案号 + 公安备案号（链接到 beian.miit.gov.cn）固定底部
- 免责声明区块
- takedown 联系方式
- 「在 AI源信完整版查看 →」按钮跳转到 `https://ai-feeds.com/?item=<id>`（命中 `.com` 现有 URL routing）

### 4.2 境内对象存储 + CDN 选型

| 厂商 | OSS / 对象存储 | CDN | 优点 | 缺点 |
|------|--------------|-----|-----|-----|
| **阿里云**（推荐） | OSS 标准存储 | 阿里云 CDN | 文档最完善，与 ICP 备案系统打通最好 | 需预付（最低 100 元充值） |
| 腾讯云 | COS | EdgeOne 国内版 | 价格相近，备案审核略快 | EdgeOne 是较新产品，文档较少 |
| 七牛云 | Kodo | 七牛 CDN | 早期免费额度（10GB 存储 + 10GB 月流量） | 大规模时价格优势消失 |
| 华为云 | OBS | 华为 CDN | 政企合规口碑好 | 控制台不友好 |

**选型决策**：早期建议从**七牛云**开始（免费额度覆盖前 1-2 个月），稳定后切阿里云（成熟 + 长期可靠）。

**注意事项**：
- OSS Bucket 绑定的自定义域名（如 `static.ai-feeds.cc`）必须做接入备案。`ai-feeds.cc` 主体备案已有，只需补"接入备案"，1-7 个工作日
- CDN 域名也需接入备案，同上

### 4.3 域名与 DNS 设计

```
ai-feeds.cc               → CNAME → 阿里云 CDN 加速域名
www.ai-feeds.cc           → CNAME → 同上
static.ai-feeds.cc        → 备用，OSS 直连（不走 CDN，仅调试）
sitemap.ai-feeds.cc       → 不需要，sitemap.xml 直接放主域根路径
```

**DNS 服务商**：建议直接用境内 DNS（阿里云解析 / DNSPod），不要走 Cloudflare（境外 DNS + 备案接入冲突）。

**HTTPS 证书**：阿里云 / 腾讯云 CDN 自带免费 SSL（DigiCert / TrustAsia），无需自配。

### 4.4 页面结构

#### 4.4.1 主页 `/`

- 头部：品牌名「AI源信」+ 一句话定位
- 导航：4 个源链接（X / GitHub / Product Hunt / ClawHub）
- 主体：最新 N 条 item 列表（按 created_at 倒序，每条 卡片 = 标题 + 一句话摘要 + source 标签 + 时间）
- 底部：备案号、公安备案号、takedown 邮箱、免责声明、跳转 `.com` 完整版按钮

#### 4.4.2 source 列表页 `/source/<source>/`

- 同主页结构，但只展示该 source 的 item
- 加翻页（每页 50 条，纯静态分页）

#### 4.4.3 详情页 `/item/<id>.html`

- 标题（翻译后 + 原标题双语）
- 元信息：作者 / 来源 / 发布时间 / 抓取时间
- 翻译后正文（markdown 渲染成 HTML，保留代码块、链接、引用）
- 媒体：
  - 图片：渲染为 `<img>`，URL 仍指向原平台 CDN（不下载到境内 OSS，避免存储成本和潜在版权问题）
  - 视频（YouTube / X）：**不 inline iframe**，渲染为「截图占位 + 播放按钮」，点击跳转原平台
- 底部固定区域：
  - 「在 AI源信完整版查看完整翻译、筛选、分享 → ai-feeds.com/?item=&lt;id&gt;」按钮
  - 「原文链接」按钮跳转 source_url
  - 备案号、公安备案号、takedown 邮箱、免责声明

#### 4.4.4 关键 SEO / GEO 元数据

每个详情页 `<head>` 必须包含：

```html
<title>{{title}} - AI源信</title>
<meta name="description" content="{{summary, 160 字以内}}">
<link rel="canonical" href="https://ai-feeds.cc/item/{{id}}">

<!-- OpenGraph -->
<meta property="og:title" content="{{title}}">
<meta property="og:description" content="{{summary}}">
<meta property="og:type" content="article">
<meta property="og:url" content="https://ai-feeds.cc/item/{{id}}">

<!-- schema.org JSON-LD -->
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Article",
  "headline": "{{title}}",
  "description": "{{summary}}",
  "author": { "@type": "Person", "name": "{{author}}" },
  "datePublished": "{{published_at}}",
  "dateModified": "{{updated_at}}",
  "publisher": { "@type": "Organization", "name": "AI源信", "url": "https://ai-feeds.cc" },
  "mainEntityOfPage": "https://ai-feeds.cc/item/{{id}}",
  "isBasedOn": "{{source_url}}"
}
</script>
```

### 4.5 跳转策略

**核心原则**：让 `.cc` 用户在看完静态页后有清晰的动机跳到 `.com`。

**实现**：
- 详情页底部一个明显的 CTA：「在 AI源信完整版查看完整功能（筛选 / 排序 / 收藏 / 分享）→」
- 主页 / 列表页右上角 nav：「完整版」按钮 → `https://ai-feeds.com`
- 跳转 URL 带 `?utm_source=cc&utm_medium=mirror&utm_campaign=cn_seo` 方便 `.com` 侧统计回流量

**不做的**：
- 不做强制跳转 / 弹窗（影响百度 SEO 打分，且影响用户体验）
- 不做 iframe 嵌入 `.com`（GFW 拦截 + 跨域）

### 4.6 sitemap.xml / robots.txt / llms.txt

#### sitemap.xml

- 按更新时间分块：`sitemap-1.xml` / `sitemap-2.xml` ... 每文件 ≤ 5 万 URL
- `sitemap-index.xml` 列出所有分块
- 每条 URL 的 `<lastmod>` 严格反映 D1 `updated_at`，让 IndexNow / 百度推送能识别增量

#### robots.txt

按调研报告 §03 三类法模板，针对 `.cc` 调整（注意 `.cc` 主要面向国内引擎 + AI 引擎）：

```
# 国内搜索引擎全放
User-agent: Baiduspider
User-agent: Baiduspider-render
User-agent: 360Spider
User-agent: HaosouSpider
User-agent: Sogou web spider
User-agent: YisouSpider
User-agent: Bytespider
Allow: /

# 国际搜索引擎全放
User-agent: Googlebot
User-agent: Bingbot
User-agent: YandexBot
Allow: /

# AI 检索 / 用户 fetch 全放（让 AI 引擎引用）
User-agent: OAI-SearchBot
User-agent: Claude-SearchBot
User-agent: PerplexityBot
User-agent: ChatGPT-User
User-agent: Claude-User
User-agent: Perplexity-User
User-agent: MistralAI-Index
User-agent: MistralAI-User
User-agent: Applebot
Allow: /

# AI 训练 bot 看后续策略（暂放，未来可调整为 Disallow 减少带宽消耗）
User-agent: GPTBot
User-agent: ClaudeBot
User-agent: Google-Extended
User-agent: Applebot-Extended
User-agent: Meta-ExternalAgent
User-agent: CCBot
User-agent: cohere-ai
User-agent: anthropic-ai
Allow: /

User-agent: *
Allow: /

Sitemap: https://ai-feeds.cc/sitemap-index.xml
```

#### llms.txt

调研报告显示主流 AI bot 实际不访问 `llms.txt`（CF 实测），但成本几乎为零，先放上：

```
# AI源信 - llms.txt
> 中文 AI 行业资讯整理站。从 X / GitHub trending / Product Hunt / ClawHub 抓取 + 翻译 + AI 评分过滤。

## 核心内容
- /index.md - 最新 AI 行业资讯
- /sitemap.xml - 完整内容索引
```

### 4.7 静态页生成的边界

**生成的内容**：
- 当前已 `is_relevant = 1` 的 item
- 翻译已完成（`translated = 1`）的 item
- 通过敏感内容过滤的 item（详见第五节）

**不生成的**：
- staging 环境数据
- 用户产生的数据（评论 / 收藏 / 分享）— `.cc` 完全不展示用户行为
- 私密 / 内部测试 item

**删除策略**：
- 收到 takedown 投诉 → 立即删除 OSS 上对应 HTML + 标记 D1 `cn_mirror_excluded = 1` → CDN 主动 purge → 提交搜索引擎 URL removal
- 删除后 24h 内不再重生

---

## 五、合规设计

### 5.1 风险等级判断

**整体评估：低 - 中等风险，可控。**

| 风险维度 | 状况 | 风险减分 |
|---------|------|---------|
| 内容垂类 | AI / 软件工程 / 创业，非时政 / 社会 / 金融 / 医疗 | 显著减分 |
| 已过滤 | LLM `is_relevant` 二分类 + 后续敏感词过滤 | 进一步减分 |
| 已翻译 | 不是纯英文搬运 | 算"加工内容" |
| 信源类型 | 行业账号 + 开源项目 + 产品发布，非个人 vlog / 政治评论 | 减分 |
| 互动模型 | 纯静态，不开评论 / UGC / 登录 | 显著减分（避开 BBS / 新闻信息服务定性） |

**类似先例**：量子位、机器之心、新智元、aibase、AI 工具集等长期翻译聚合海外 AI 资讯，运营多年无大风险事件。

**真实风险**：
1. 某条内容意外触发举报 → 临时整改 → 国内访问中断几天（高概率事件，需 takedown 流程兜底）
2. X 信源里偶尔混进政治评论 → 仅靠 `is_relevant` 不够（必须二层过滤）
3. YouTube 视频 inline 嵌入 → 可能被判"传播境外视听节目"（设计上规避，不 iframe）

### 5.2 合规加固清单

按重要性排序：

| # | 项 | 类型 | 重要性 | 状态 |
|---|---|------|------|------|
| 1 | **第二层敏感内容审核**：阿里云内容安全 / 腾讯云天御 / 火山引擎内容审核 API（每次几毛钱），LLM `is_relevant` 之后再过一遍 | coding | 阻塞级 | 待实施 |
| 2 | **takedown 流程**：底部固定邮箱 / 表单，收到投诉 1-2h 内下线该 item（脚本 + cron） | coding + 人工 | 阻塞级 | 待实施 |
| 3 | **底部固定展示**：ICP 备案号 + 公安备案号 + 链接到 beian.miit.gov.cn 查询页 | coding | 强制要求 | 备案号已有 |
| 4 | **免责声明**：「本站为垂类技术资讯整理，内容来自公开来源（已附原始链接），不构成任何投资 / 商业建议」 | 文案 | 强制要求 | 待实施 |
| 5 | **来源溯源**：每条 item 保留原 URL + 抓取时间戳 + 翻译模型版本（D1 已有，确保展示） | 已有 | 中 | D1 schema 已支持 |
| 6 | **不 inline 嵌入境外视频**：YouTube / X 视频用截图 + 播放按钮 + 跳转链接，不 iframe | coding | 中-高 | 模板设计阶段确认 |
| 7 | **不开评论 / UGC 二次互动**：`.cc` 静态架构自动满足 | 设计上避免 | 强制要求 | 已满足 |
| 8 | **公安备案**：ICP 备案后 30 天内办公网安备号（独立于 ICP 备案） | 人工 | 强制要求 | 待办 |
| 9 | **AI 网站说明函**：2024 工信部新规，AI 类网站需提交（确认是否需补充） | 人工 | 中 | 备案时已附 / 待确认 |

### 5.3 takedown 流程

```
用户填写表单 / 发邮件
  ↓
takedown@ai-feeds.cc（邮箱或 Cloudflare worker 转发）
  ↓
管理员后台（.com worker 加 admin endpoint）确认
  ↓
标记 D1 items.cn_mirror_excluded = 1
  ↓
worker cron 下次运行时：
  - 删除 OSS 上的对应 HTML
  - CDN 调 purge API 主动刷新
  - 从 sitemap.xml 移除该 URL
  - 调用百度 / 360 / 神马 / 搜狗 / 头条 站长平台 URL removal API
  ↓
邮件回复举报人
```

**响应 SLA**：营业时间内 1-2 小时；非营业时间 24 小时内。

### 5.4 内容审核 API 集成

在 `is_relevant = 1` 判定后、生成 HTML 前，加一道内容安全审核：

```
item.translated 文本
  ↓
阿里云内容安全 / 文本审核 API
  ↓
返回 risk_level（normal / suspicious / violation）
  ↓
normal → 进入静态生成流程
suspicious → 标记 D1 cn_review_required = 1，人工 review
violation → 标记 D1 cn_excluded = 1，永不生成
```

**成本**：阿里云内容安全文本审核 4 元 / 万次调用，每月 10K item ≈ 4 元 / 月。

---

## 六、成本估算

按规模阶段：

| 规模 | 累计存储 | 日 PV | 月流量 | OSS 月费 | CDN 月费 | 内容审核 | **月总成本** |
|------|---------|-------|--------|---------|---------|---------|-------------|
| 第 1 个月 | ~600 MB | 1 万 | ~24 GB | ~1 元 | ~6 元 | ~2 元 | **~30-50 元** |
| 第 6 个月 | ~4 GB | 5 万 | ~120 GB | ~1 元 | ~30 元 | ~5 元 | **~80-150 元** |
| 第 1 年 | ~7 GB | 10 万 | ~240 GB | ~1 元 | ~60 元 | ~5 元 | **~150-300 元** |
| 成熟期 | ~50 GB | 100 万 | 2.4 TB | ~6 元 | ~600 元 | ~10 元 | **~1000-2000 元** |

**单价参考（2026 国内主流厂商）**：
- 阿里云 OSS 标准存储：0.12 元 / GB / 月
- 阿里云 CDN（HTTPS，10TB / 月以下阶梯定价）：0.24 元 / GB
- 腾讯云 COS + EdgeOne 国内版：相近价位
- 七牛云：免费额度 10GB 存储 + 10GB 月流量，覆盖前 1-2 个月

**一次性 / 周期性成本**：
- `.cc` 域名续费：约 50 元 / 年
- 阿里云 / 腾讯云预付充值：最低 100 元起
- 接入备案（如换接入服务商）：免费但需 1-7 工作日审核

**不需要花的**：
- Cloudflare 中国合作版（百度云 / 京东云接入）— 企业级合同，几万 / 年起，不适合当前阶段
- 自建服务器 — 静态托管不需要 ECS

**总评**：早期月百元级，规模化后月千元级，相对潜在国内流量性价比高。

---

## 七、实施分阶段

### P0 准备（不写代码，仅决策与申请，1-2 周）

- [ ] 拍板境内 OSS + CDN 选型（七牛云试 1 个月 / 阿里云一步到位 / 腾讯云）
- [ ] `ai-feeds.cc` 接入备案（如果之前的接入服务商不是要用的厂商）
- [ ] 公安备案（ICP 备案后 30 天内必办）
- [ ] 申请阿里云内容安全 / 腾讯云天御 API 密钥
- [ ] 设计 `.cc` 视觉风格 + 模板原型（HTML 静态原型，不接数据）
- [ ] 准备 takedown 邮箱 + 公开声明文案
- [ ] 写 D1 migration（`cn_mirror_state` 表 + items 表新增 `cn_mirror_excluded` / `cn_review_required` 字段）

### P1 MVP（核心实现，1-2 周）

- [ ] worker 加 `cn-mirror` 模块：模板渲染 + 增量逻辑
- [ ] 接 OSS SDK（S3 兼容 API），上传 HTML
- [ ] 内容审核 API 集成（每次 item 翻译完成后调用）
- [ ] sitemap.xml / robots.txt / llms.txt 自动生成
- [ ] takedown 表单（worker endpoint + 邮件通知）
- [ ] 主页 / 列表页 / 详情页 三套模板
- [ ] 备案号 / 公安备案号 / 免责声明 模板组件

### P2 上线（验证 + 提交搜索引擎，1 周）

- [ ] 在 staging 环境跑一遍（生成到 staging OSS bucket，验证模板）
- [ ] 切到 prod，先生成最近 100 条 item 验证
- [ ] 五个国内站长平台注册（百度 / 360 / 神马 / 搜狗 / 头条），逐一提交 sitemap
- [ ] 国际站长平台同步（Google / Bing / Yandex）
- [ ] IndexNow key 集成（一行：worker 在生成新 item 时 push 到 Bing endpoint）
- [ ] 监控接入：访问日志 + GA4 / Plausible（可选）+ AI referrer 追踪

### P3 优化（持续，按月迭代）

- [ ] 根据搜索引擎收录情况调整 sitemap 优先级
- [ ] 内容审核 API 误判率分析与策略调整
- [ ] 静态页性能优化（HTML 体积、CDN 命中率、Core Web Vitals）
- [ ] 加 FAQ section 等 GEO 友好结构
- [ ] crawl-to-referral 比率追踪与分析

---

## 八、风险与待决策

### 关键决策点

1. **境内 OSS / CDN 厂商**：七牛云（早期免费）/ 阿里云（一步到位）/ 腾讯云
2. **`.cc` 是否承担登录入口跳转**：用户从 `.cc` 要登录时，是当场跳 `.com` 登录，还是 `.cc` 完全无登录痕迹？建议后者（最简单合规）
3. **AI 训练 bot（GPTBot / ClaudeBot 等）放还是禁**：放 → 数据消耗带宽但有助 AI 引用（已训练数据未来可能被使用）；禁 → 节省带宽但放弃训练侧曝光。建议初期放，规模大后再调
4. **媒体存储策略**：图片 / 视频缩略图是否复制到境内 OSS（保命存档）？建议初期不复制（仅嵌外链），规模大后看版权风险评估
5. **`.cc` 是否做多语言**：当前规划纯中文。是否预留英文版（针对台港用户）？建议初期不做

### 监控指标（上线后跟踪）

| 指标 | 频率 | 说明 |
|------|------|------|
| `.cc` 主域 Search Engine Crawler 抓取次数 | 每日 | 百度 / 360 / 神马 / 搜狗 / 头条分别统计 |
| `.cc` 收录页面数（百度 / 360 / 神马 / 搜狗 / 头条 / Google） | 每周 | 各站长后台查 |
| `.cc` → `.com` 跳转流量（utm_source=cc） | 每日 | `.com` GA4 |
| `.cc` 月度成本 | 每月 | 控制台账单 |
| takedown 投诉数 | 每月 | 投诉数 + 平均响应时间 |
| 内容审核 API 拦截率 | 每月 | 评估过滤策略是否合适 |

### 未解的问题

1. **`.cc` 的 D1 数据是 `.com` 的子集**：`.com` 出问题（如 D1 损坏 / worker 故障）`.cc` 也跟着停更，是否需要独立的境内备份策略？早期不做
2. **媒体跨境失败**：`.cc` 详情页里的图片 URL 指向 X / YouTube CDN，国内访问可能慢 / 失败。是否做图片代理？建议第二阶段做（性能问题，不是合规问题）
3. **百度收录验证**：百度对 SPA 翻译聚合站的态度是否真如预期？需上线后实测，不能仅凭调研结论拍板长期策略

---

## 九、相关文档

- [`docs/plans/_research/2026-05-07-search-engines-ai-bots-research.html`](_research/2026-05-07-search-engines-ai-bots-research.html) — 全网搜索引擎 + AI 抓取规则 + 中国备案调研报告（本文档的事实基础）
- [`docs/plans/2026-05-03-staging-environment-design.md`](2026-05-03-staging-environment-design.md) — staging 环境设计（`.cc` 上线前先在 staging 跑一遍的依据）
- [`docs/operations.md`](../operations.md) — 运维手册（CDN / OSS / 备案 / takedown 流程上线后需补充到此）
- [`docs/source-integration-sop.md`](../source-integration-sop.md) — 数据源接入 SOP（`.cc` 镜像作为新"输出端"，可参考其 7 阶段流程）
- [`docs/frontend-ux-guidelines.md`](../frontend-ux-guidelines.md) — 前端 UX 规范（`.cc` 静态模板的视觉基线）

---

## 十、待确认 / 待补充

- [ ] 确认 `.cc` 备案中是否已勾选「AI 服务」类目（2024 工信部新规）
- [ ] 确认 `.cc` 主体备案号 + 公安备案号的具体编号（用于模板）
- [ ] 确认 takedown 邮箱地址（建议 `takedown@ai-feeds.cc` 或类似）
- [ ] 七牛云 / 阿里云 / 腾讯云 三选一的最终决策
- [ ] 决定是否为 `.cc` 单独申请微信公众号 / 知乎等平台账号（用于内容矩阵反链）
