// worker/src/feeds/registry.ts
//
// FEED_REGISTRY = curated 的可订阅 feed 清单（增删源改这里，不动 migration）。
// 设计文档 §3.1：2026-06-09 逐条实测可直连的 ~24 源（feed_url 用 verifiedFeedUrl 列真实地址）。
//   - 10 国外博客原生 RSS（含 Anthropic 第三方桥）+ 2 国内原生（Qwen 旧站 / 美团）
//   - 1 GitHub Releases（MiniCPM，归 source_type='blog'）
//   - 11 播客 feed（A 档 5 个有原生文字稿）
//   - (Phase 2,2026-06-22) +4 国内播客,经 HK VPS 自托管 RSSHub 小宇宙路由（via='rsshub'）→ 共 28
//   - (Phase 3,2026-06-22) +5 page-scrape 博客（AI21/Cohere/Databricks/MiniMax/美团）→ 共 32
//   - (2026-06-24) +3 国外第三方新闻媒体原生 RSS（TechCrunch / The Verge / MIT Technology Review）→ 共 35
//
// ensureFeedSources(env) 启动时幂等 upsert 进 sources 表（镜像 X 把 list 存 sources 的范式）：
//   sources.id=FeedDef.id, source_type=kind, source_ref=key, name, config=JSON.stringify(FeedDef)。
//   只覆盖 name/config，不动 cursor/last_success_at（保留运行时游标状态）。

import type { FeedDef } from "./types";

/** 冷启动每 feed 只 enrich「最近 N 天内发布」的条目（压洪峰 + 减历史噪音，D10）。
 *  2026-06-24 由「最近 N 条」改为「最近 N 天」：count 上限对高产源(OpenAI/NVIDIA 等)
 *  会把窗口内(30 天显示窗)还该展示的新文也当历史压掉(实测 OpenAI 误伤 35 条)。
 *  改成发布日期窗口后：窗口内全 enrich、不再误伤；仅压窗口外的真历史(防几年老文涌入)。
 *  值对齐 C 端 blog/podcast 显示窗(index.ts handleItems isFeeds=30 天)。 */
export const COLD_START_WINDOW_DAYS = 30;
/** seen-set 大小上限（blog/podcast 比 X 的 10 略宽，D10）。 */
export const FEED_SEEN_SET_MAX_SIZE = 20;
/** 分页型 page-scrape「连续 K 条全已见」才停翻下一页（对冲分页内乱序，§7.4）。 */
export const STOP_RUN_K = 5;

// ── 国外博客（原生 RSS，10）─────────────────────────────────────────────────
const FOREIGN_BLOGS: FeedDef[] = [
  {
    id: "blog:openai",
    key: "openai",
    kind: "blog",
    format: "rss",
    source_company: "OpenAI",
    name: "OpenAI News",
    region: "foreign",
    via: "native",
    feed_url: "https://openai.com/news/rss.xml",
    cadence_hours: 2,
    fetch_strategy: "native",
    site_base: "https://openai.com",
  },
  {
    id: "blog:google",
    key: "google",
    kind: "blog",
    format: "rss",
    source_company: "Google",
    name: "The Keyword — AI",
    region: "foreign",
    via: "native",
    feed_url: "https://blog.google/technology/ai/rss/",
    cadence_hours: 2,
    fetch_strategy: "native",
    site_base: "https://blog.google",
    notes: "用 technology/ai 分类 feed，不用 ref 给的 gemini-models 窄 feed",
  },
  {
    id: "blog:microsoft-research",
    key: "microsoft-research",
    kind: "blog",
    format: "rss",
    source_company: "Microsoft Research",
    name: "Microsoft Research Blog",
    region: "foreign",
    via: "native",
    feed_url: "https://www.microsoft.com/en-us/research/blog/feed/",
    cadence_hours: 2,
    fetch_strategy: "native",
    site_base: "https://www.microsoft.com",
  },
  {
    id: "blog:nvidia",
    key: "nvidia",
    kind: "blog",
    format: "rss",
    source_company: "NVIDIA",
    name: "NVIDIA Blog",
    region: "foreign",
    via: "native",
    feed_url: "https://blogs.nvidia.com/feed/",
    cadence_hours: 2,
    fetch_strategy: "native",
    site_base: "https://blogs.nvidia.com",
    notes: "主 feed 高频，is_ai gate 滤非 AI；不用 ref 的 deep-learning 分类 feed（已停更）",
  },
  {
    id: "blog:huggingface",
    key: "huggingface",
    kind: "blog",
    format: "atom",
    source_company: "Hugging Face",
    name: "Hugging Face Blog",
    region: "foreign",
    via: "native",
    feed_url: "https://huggingface.co/blog/feed.xml",
    cadence_hours: 2,
    fetch_strategy: "native",
    site_base: "https://huggingface.co",
  },
  {
    id: "blog:anthropic",
    key: "anthropic",
    kind: "blog",
    format: "rss",
    source_company: "Anthropic",
    name: "Anthropic News",
    region: "foreign",
    via: "native",
    feed_url:
      "https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_anthropic_news.xml",
    cadence_hours: 2,
    fetch_strategy: "native",
    site_base: "https://www.anthropic.com",
    notes: "第三方 SPOF（Olshansk RSS 桥）；官方无 RSS",
  },
  {
    id: "blog:mistral",
    key: "mistral",
    kind: "blog",
    format: "rss",
    source_company: "Mistral AI",
    name: "Mistral AI News",
    region: "foreign",
    via: "native",
    feed_url: "https://mistral.ai/rss.xml",
    cadence_hours: 2,
    fetch_strategy: "native",
    site_base: "https://mistral.ai",
  },
  {
    id: "blog:stability",
    key: "stability",
    kind: "blog",
    format: "rss",
    source_company: "Stability AI",
    name: "Stability AI News",
    region: "foreign",
    via: "native",
    feed_url: "https://stability.ai/news-updates?format=rss",
    cadence_hours: 2,
    fetch_strategy: "native",
    site_base: "https://stability.ai",
    notes: "Squarespace feed",
  },
  {
    id: "blog:together",
    key: "together",
    kind: "blog",
    format: "rss",
    source_company: "Together AI",
    name: "Together AI Blog",
    region: "foreign",
    via: "native",
    feed_url: "https://www.together.ai/blog/rss.xml",
    cadence_hours: 2,
    fetch_strategy: "native",
    site_base: "https://www.together.ai",
  },
  {
    id: "blog:midjourney",
    key: "midjourney",
    kind: "blog",
    format: "rss",
    source_company: "Midjourney",
    name: "Midjourney Updates",
    region: "foreign",
    via: "native",
    feed_url: "https://updates.midjourney.com/rss",
    cadence_hours: 2,
    fetch_strategy: "native",
    site_base: "https://updates.midjourney.com",
    notes: "Ghost 子域",
  },
];

// ── 国外第三方 AI/科技新闻媒体（原生 RSS，3；2026-06-24 接入）──────────────────
// 区别于上方 FOREIGN_BLOGS（厂商官方博客 = PR 软文）：这层是第三方媒体报道，补「官博漏掉的
// 突发 + 第三方视角」。都高产且非全 AI（尤其 The Verge 偏消费科技），blog 管线的 is_ai
// gate（DeepSeek flash）滤非 AI，冷启动走「最近 30 天发布窗」压历史。format 照各 feed 实测：
// TechCrunch/MITTR = RSS 2.0，The Verge = Atom（<entry>/<content>）。
const FOREIGN_NEWS_MEDIA: FeedDef[] = [
  {
    id: "blog:techcrunch",
    key: "techcrunch",
    kind: "blog",
    format: "rss",
    source_company: "TechCrunch",
    name: "TechCrunch — AI",
    region: "foreign",
    via: "native",
    feed_url: "https://techcrunch.com/category/artificial-intelligence/feed/",
    cadence_hours: 2,
    fetch_strategy: "native",
    site_base: "https://techcrunch.com",
    notes: "AI 板块 feed,高产(实测窗口内 ~19 条);<description> 只给摘要(无 content:encoded),正文是摘要级;含少量活动促销条,is_ai gate 滤",
  },
  {
    id: "blog:the-verge",
    key: "the-verge",
    kind: "blog",
    format: "atom",
    source_company: "The Verge",
    name: "The Verge — AI",
    region: "foreign",
    via: "native",
    feed_url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml",
    cadence_hours: 2,
    fetch_strategy: "native",
    site_base: "https://www.theverge.com",
    notes: "AI 板块 Atom feed(<entry>/<content>,parseFeed atom 分支);选题偏消费科技、非 AI 噪音最多,is_ai gate 必做",
  },
  {
    id: "blog:mit-tech-review",
    key: "mit-tech-review",
    kind: "blog",
    format: "rss",
    source_company: "MIT Technology Review",
    name: "MIT Technology Review — AI",
    region: "foreign",
    via: "native",
    feed_url: "https://www.technologyreview.com/topic/artificial-intelligence/feed/",
    cadence_hours: 2,
    fetch_strategy: "native",
    site_base: "https://www.technologyreview.com",
    notes: "替 VentureBeat(其 /category/ai/feed 实测停更:最新仅 2026-05-19,之前跳回 1 月);MITTR AI 主题 feed 新鲜 + content:encoded 带全文,低产高质",
  },
];

// ── 国内博客（原生，2）+ GitHub Releases（1）─────────────────────────────────
const DOMESTIC_BLOGS: FeedDef[] = [
  {
    id: "blog:qwen",
    key: "qwen",
    kind: "blog",
    format: "atom",
    source_company: "Qwen",
    name: "Qwen Blog",
    region: "domestic",
    via: "native",
    feed_url: "https://qwenlm.github.io/blog/index.xml",
    cadence_hours: 2,
    fetch_strategy: "native",
    site_base: "https://qwenlm.github.io",
    notes: "已迁站、停在 2025-09；v1 只走老 feed 直拉，qwen.ai 无头补新留 v2（D10）",
  },
  {
    id: "blog:meituan-tech",
    key: "meituan-tech",
    kind: "blog",
    format: "rss",
    source_company: "美团技术团队",
    name: "美团技术团队",
    region: "domestic",
    via: "native",
    feed_url: "https://tech.meituan.com/",
    cadence_hours: 2,
    fetch_strategy: "page-scrape",
    site_base: "https://tech.meituan.com",
    notes: "2026-06-22 原 RSS(/feed/)已 301 迁走且停更 → 改 page-scrape;首页 + history.html 发现(page-index.ts),date 在 URL /YYYY/MM/DD/;is_ai gate 滤非 AI 工程文",
  },
  {
    id: "blog:minicpm",
    key: "minicpm",
    kind: "blog",
    format: "github-releases",
    source_company: "面壁智能 / OpenBMB",
    name: "MiniCPM Releases",
    region: "domestic",
    via: "native",
    feed_url: "https://github.com/OpenBMB/MiniCPM/releases.atom",
    cadence_hours: 2,
    fetch_strategy: "native",
    site_base: "https://github.com/OpenBMB/MiniCPM",
    notes: "GitHub Releases.atom，release notes 当正文；折叠进 blog-fetch lane",
  },
];

// ── 国外博客 page-scrape（Phase 3,无 RSS;sitemap 发现 + og: 详情页抽,2026-06-22）──────
// fetch_strategy='page-scrape' → blog.ts 走 feeds/page-index.ts 的 discoverPageIndex(sitemap),
// 不走 parseFeed;feed_url 仅文档/展示用(真实 sitemap 在 page-index.ts 配)。via 字段不参与。
const PAGE_SCRAPE_BLOGS: FeedDef[] = [
  {
    id: "blog:ai21",
    key: "ai21",
    kind: "blog",
    format: "rss",
    source_company: "AI21 Labs",
    name: "AI21 Labs Blog",
    region: "foreign",
    via: "native",
    feed_url: "https://www.ai21.com/blog/",
    cadence_hours: 2,
    fetch_strategy: "page-scrape",
    site_base: "https://www.ai21.com",
    notes: "Phase 3 page-scrape;post-sitemap.xml 发现(带 lastmod),标题/封面/正文 og: 详情页抽",
  },
  {
    id: "blog:cohere",
    key: "cohere",
    kind: "blog",
    format: "rss",
    source_company: "Cohere",
    name: "Cohere Blog",
    region: "foreign",
    via: "native",
    feed_url: "https://cohere.com/blog",
    cadence_hours: 2,
    fetch_strategy: "page-scrape",
    site_base: "https://cohere.com",
    notes: "Phase 3 page-scrape;sitemap.xml 扁平发现(带 lastmod,排除 locale 变体),og: 详情页抽",
  },
  {
    id: "blog:databricks",
    key: "databricks",
    kind: "blog",
    format: "rss",
    source_company: "Databricks",
    name: "Databricks Blog",
    region: "foreign",
    via: "native",
    fetch_strategy: "page-scrape",
    feed_url: "https://www.databricks.com/blog",
    cadence_hours: 2,
    site_base: "https://www.databricks.com",
    notes: "Phase 3 page-scrape;sitemap 无 lastmod → 扒首页 anchor 发现(html-index),date 靠详情页 og;极活跃",
  },
  {
    id: "blog:minimax",
    key: "minimax",
    kind: "blog",
    format: "rss",
    source_company: "MiniMax",
    name: "MiniMax News",
    region: "foreign",
    via: "native",
    fetch_strategy: "page-scrape",
    feed_url: "https://www.minimax.io/news",
    cadence_hours: 2,
    site_base: "https://www.minimax.io",
    notes: "Phase 3 page-scrape;Next.js app-router,首页 server 渲染最新数篇 /news/ anchor(html-index),标题/封面/日期 og 详情页抽",
  },
];

// ── 播客（11；A 档 5 个 has_native_transcript=true）──────────────────────────
const PODCASTS: FeedDef[] = [
  {
    id: "podcast:practical-ai",
    key: "practical-ai",
    kind: "podcast",
    format: "rss",
    source_company: "Practical AI",
    name: "Practical AI",
    region: "foreign",
    via: "native",
    feed_url:
      "https://feeds.transistor.fm/practical-ai-machine-learning-data-science-llm",
    cadence_hours: 6,
    fetch_strategy: "native",
    transcript_tier: "A",
    has_native_transcript: true,
    notes: "原生 <podcast:transcript> VTT/SRT/JSON；ref 的 changelog URL 已 301",
  },
  {
    id: "podcast:msr-podcast",
    key: "msr-podcast",
    kind: "podcast",
    format: "rss",
    source_company: "Microsoft Research",
    name: "Microsoft Research Podcast",
    region: "foreign",
    via: "native",
    feed_url: "https://feeds.blubrry.com/feeds/microsoftresearch.xml",
    cadence_hours: 6,
    fetch_strategy: "native",
    transcript_tier: "A",
    has_native_transcript: true,
    notes: "原生 transcript VTT；ref 给的是研究博客 feed 不是播客",
  },
  {
    id: "podcast:latent-space",
    key: "latent-space",
    kind: "podcast",
    format: "rss",
    source_company: "Latent Space",
    name: "Latent Space",
    region: "foreign",
    via: "native",
    feed_url: "https://www.latent.space/feed",
    cadence_hours: 6,
    fetch_strategy: "native",
    transcript_tier: "A",
    has_native_transcript: true,
    notes: "Substack 全文 8000-10000 字当文字稿",
  },
  {
    id: "podcast:last-week-in-ai",
    key: "last-week-in-ai",
    kind: "podcast",
    format: "rss",
    source_company: "Last Week in AI",
    name: "Last Week in AI",
    region: "foreign",
    via: "native",
    feed_url: "https://lastweekin.ai/feed",
    cadence_hours: 6,
    fetch_strategy: "native",
    transcript_tier: "A",
    has_native_transcript: true,
    notes: "Substack 全文周报 ~5000 字；用 Substack 源不用 ref 的 buzzsprout",
  },
  {
    id: "podcast:lex-fridman",
    key: "lex-fridman",
    kind: "podcast",
    format: "rss",
    source_company: "Lex Fridman",
    name: "Lex Fridman Podcast",
    region: "foreign",
    via: "native",
    feed_url: "https://lexfridman.com/feed/podcast/",
    cadence_hours: 6,
    fetch_strategy: "native",
    transcript_tier: "A",
    has_native_transcript: true,
    notes: "description 带官方 transcript 页 URL；大量非 AI 选题，is_ai gate 必做",
  },
  {
    id: "podcast:openai-podcast",
    key: "openai-podcast",
    kind: "podcast",
    format: "rss",
    source_company: "OpenAI",
    name: "OpenAI Podcast",
    region: "foreign",
    via: "native",
    feed_url: "https://feeds.acast.com/public/shows/openai-podcast",
    cadence_hours: 6,
    fetch_strategy: "native",
    transcript_tier: "B",
    has_native_transcript: false,
  },
  {
    id: "podcast:no-priors",
    key: "no-priors",
    kind: "podcast",
    format: "rss",
    source_company: "No Priors",
    name: "No Priors",
    region: "foreign",
    via: "native",
    feed_url: "https://feeds.megaphone.fm/nopriors",
    cadence_hours: 6,
    fetch_strategy: "native",
    transcript_tier: "B",
    has_native_transcript: false,
    notes: "ref 两个 URL 全 404，用 megaphone",
  },
  {
    id: "podcast:eye-on-ai",
    key: "eye-on-ai",
    kind: "podcast",
    format: "rss",
    source_company: "Eye on AI",
    name: "Eye on AI",
    region: "foreign",
    via: "native",
    feed_url: "https://rss.libsyn.com/shows/123267/destinations/727317.xml",
    cadence_hours: 6,
    fetch_strategy: "native",
    transcript_tier: "B",
    has_native_transcript: false,
    notes: "libsyn 跳转后 URL",
  },
  {
    id: "podcast:cognitive-revolution",
    key: "cognitive-revolution",
    kind: "podcast",
    format: "rss",
    source_company: "The Cognitive Revolution",
    name: "The Cognitive Revolution",
    region: "foreign",
    via: "native",
    feed_url: "https://feeds.megaphone.fm/RINTP3108857801",
    cadence_hours: 6,
    fetch_strategy: "native",
    transcript_tier: "B",
    has_native_transcript: false,
    notes: "ref 的 buzzsprout 404，用 megaphone",
  },
  {
    id: "podcast:mlst",
    key: "mlst",
    kind: "podcast",
    format: "rss",
    source_company: "Machine Learning Street Talk",
    name: "Machine Learning Street Talk",
    region: "foreign",
    via: "native",
    feed_url: "https://rss.art19.com/machine-learning-street-talk",
    cadence_hours: 6,
    fetch_strategy: "native",
    transcript_tier: "B",
    has_native_transcript: false,
  },
  {
    id: "podcast:gradient-dissent",
    key: "gradient-dissent",
    kind: "podcast",
    format: "rss",
    source_company: "Weights & Biases",
    name: "Gradient Dissent",
    region: "foreign",
    via: "native",
    feed_url: "https://feeds.captivate.fm/gradient-dissent",
    cadence_hours: 6,
    fetch_strategy: "native",
    transcript_tier: "C",
    has_native_transcript: false,
  },
];

// ── 国内播客（Phase 2,经 HK VPS 自托管 RSSHub 的小宇宙路由;2026-06-22 接入,4）─────
// via='rsshub' → fetchFeedXml 拼 env.RSSHUB_BASE + feed_url(route path)+ X-RSSHub-Token。
// region='domestic' → pipeline 自动 lang='zh'(podcast.ts)。小宇宙只有 shownotes、无原生
// 文字稿(has_native_transcript=false,tier B);is_ai gate 滤掉非 AI 单集。
const DOMESTIC_PODCASTS: FeedDef[] = [
  {
    id: "podcast:guigu101",
    key: "guigu101",
    kind: "podcast",
    format: "rss",
    source_company: "硅谷101",
    name: "硅谷101",
    region: "domestic",
    via: "rsshub",
    feed_url: "/xiaoyuzhou/podcast/5e5c52c9418a84a04625e6cc",
    cadence_hours: 6,
    fetch_strategy: "native",
    transcript_tier: "B",
    has_native_transcript: false,
    notes: "小宇宙 via RSSHub(rss.ai-feeds.com);shownotes 当正文,无原生文字稿",
  },
  {
    id: "podcast:onboard",
    key: "onboard",
    kind: "podcast",
    format: "rss",
    source_company: "OnBoard!",
    name: "OnBoard!",
    region: "domestic",
    via: "rsshub",
    feed_url: "/xiaoyuzhou/podcast/61cbaac48bb4cd867fcabe22",
    cadence_hours: 6,
    fetch_strategy: "native",
    transcript_tier: "B",
    has_native_transcript: false,
    notes: "小宇宙 via RSSHub",
  },
  {
    id: "podcast:ai-qianxian",
    key: "ai-qianxian",
    kind: "podcast",
    format: "rss",
    source_company: "AI 前线",
    name: "AI 前线",
    region: "domestic",
    via: "rsshub",
    feed_url: "/xiaoyuzhou/podcast/679d8c5ded7799e793bb7936",
    cadence_hours: 6,
    fetch_strategy: "native",
    transcript_tier: "B",
    has_native_transcript: false,
    notes: "小宇宙 via RSSHub;InfoQ/极客邦出品",
  },
  {
    id: "podcast:zhangxiaojun",
    key: "zhangxiaojun",
    kind: "podcast",
    format: "rss",
    source_company: "张小珺·商业访谈录",
    name: "张小珺·商业访谈录",
    region: "domestic",
    via: "rsshub",
    feed_url: "/xiaoyuzhou/podcast/626b46ea9cbbf0451cf5a962",
    cadence_hours: 6,
    fetch_strategy: "native",
    transcript_tier: "B",
    has_native_transcript: false,
    notes: "小宇宙 via RSSHub",
  },
];

// ── 国内第三方 AI 新闻媒体（2026-06-24）─────────────────────────────────────────
// 对标 FOREIGN_NEWS_MEDIA：第三方媒体报道（非厂商官博），补国内生态热点（字节/腾讯/阿里
// 产品发布等）。量子位有可用原生 RSS（qbitai.com/feed，RFC822 pubDate 经 parseFeed 归一 ISO，
// 含 content:encoded 全文）→ 走 native，无需 RSSHub。机器之心/新智元无可靠直连 RSS，待 Codex
// 经 HK VPS RSSHub 接（via='rsshub'），见 docs/plans/2026-06-24-rsshub-domestic-ai-media-handoff.md。
const DOMESTIC_NEWS_MEDIA: FeedDef[] = [
  {
    id: "blog:qbitai",
    key: "qbitai",
    kind: "blog",
    format: "rss",
    source_company: "量子位",
    name: "量子位",
    region: "domestic",
    via: "native",
    feed_url: "https://www.qbitai.com/feed",
    cadence_hours: 2,
    fetch_strategy: "native",
    site_base: "https://www.qbitai.com",
    notes: "国内顶级 AI 媒体,追产品发布最快(Seedance/腾讯等第一时间报);原生 RSS 含 content:encoded 全文,中文无需翻译;is_ai gate + cn_sensitive 过滤照常",
  },
  {
    id: "blog:jiqizhixin",
    key: "jiqizhixin",
    kind: "blog",
    format: "rss",
    source_company: "机器之心",
    name: "机器之心",
    region: "domestic",
    via: "rsshub",
    feed_url: "/jiqizhixin",
    cadence_hours: 2,
    fetch_strategy: "native",
    notes: "经 HK VPS RSSHub /jiqizhixin(官网文章库 API 直连:列表 API 取最新 + 详情 API 补全文进 RSS description,~4.4KB/条);Codex 2026-06-24 换源,原 /wechat/sogou/jiqizhixin(只标题+Sogou跳转无正文)已废",
  },
  {
    id: "blog:aiera",
    key: "aiera",
    kind: "blog",
    format: "rss",
    source_company: "新智元",
    name: "新智元",
    region: "domestic",
    via: "rsshub",
    feed_url: "/aiera",
    cadence_hours: 2,
    fetch_strategy: "native",
    notes: "经 HK VPS RSSHub(/aiera 路由),Codex 2026-06-24 部署验证 200/10 条;无可靠直连 RSS",
  },
];

/** 全部 feed(Phase 1 原生 23 + Phase 2 RSSHub 中文播客 4 + Phase 3 page-scrape 5
 *  + 2026-06-24 国外第三方新闻媒体 3 + 国内新闻媒体 3（量子位 native + 机器之心/新智元 rsshub）= 38）。
 *  注:美团 2026-06-22 从原生 RSS 改 page-scrape(RSS 已迁走),故原生从 24→23、page-scrape 含美团;
 *  page-scrape 5 = AI21 / Cohere / Databricks / MiniMax / 美团;
 *  国外新闻媒体 3 = TechCrunch / The Verge / MIT Technology Review;
 *  国内新闻媒体 3 = 量子位(原生 RSS)+ 机器之心(/jiqizhixin 官网直连全文)+ 新智元(/aiera)(后两者 HK VPS RSSHub,Codex 2026-06-24 部署)。 */
export const FEED_REGISTRY: FeedDef[] = [
  ...FOREIGN_BLOGS,
  ...FOREIGN_NEWS_MEDIA,
  ...DOMESTIC_BLOGS,
  ...DOMESTIC_NEWS_MEDIA,
  ...PAGE_SCRAPE_BLOGS,
  ...PODCASTS,
  ...DOMESTIC_PODCASTS,
];

/** 按 id 查 FeedDef。 */
export function getFeedDef(id: string): FeedDef | undefined {
  return FEED_REGISTRY.find((f) => f.id === id);
}

/** 按 kind + key 查 FeedDef（pipeline 拿 feedKey/showKey 回查用）。 */
export function getFeedDefByKey(
  kind: FeedDef["kind"],
  key: string,
): FeedDef | undefined {
  return FEED_REGISTRY.find((f) => f.kind === kind && f.key === key);
}

/** 取某 kind 下启用的 feed（enabled !== false）。 */
export function feedsByKind(kind: FeedDef["kind"]): FeedDef[] {
  return FEED_REGISTRY.filter((f) => f.kind === kind && f.enabled !== false);
}

/**
 * 幂等把 FEED_REGISTRY upsert 进 sources 表。
 * 只覆盖 name/config（静态定义），不动 cursor/last_success_at（运行时游标状态）。
 * 由调度入口（runBlogFetch / runPodcastFetch 起头）或专用 admin endpoint 调用。
 *
 * @returns upsert 的行数
 */
export async function ensureFeedSources(env: {
  DB: D1Database;
}): Promise<number> {
  const enabled = FEED_REGISTRY.filter((f) => f.enabled !== false);
  const stmts = enabled.map((f) =>
    env.DB.prepare(
      `INSERT INTO sources (id, source_type, source_ref, name, config)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         source_type = excluded.source_type,
         source_ref  = excluded.source_ref,
         name        = excluded.name,
         config      = excluded.config`,
    ).bind(f.id, f.kind, f.key, f.name, JSON.stringify(f)),
  );
  if (stmts.length === 0) return 0;
  await env.DB.batch(stmts);
  return stmts.length;
}
