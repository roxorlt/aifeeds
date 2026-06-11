export type SourceType =
  | "x_list"
  | "youtube"
  | "podcast"
  | "product_hunt"
  | "huodongxing"
  | "github"
  | "arxiv"
  | "clawhub"
  | "hf_paper"
  | "blog";

export interface MediaItem {
  type: "image" | "video" | string;
  url: string;
  width?: number;
  height?: number;
  alt?: string;
  // Video-only fields. PH 给的 launch video 可能附 thumbnail；X video.twimg.com
  // 我们让浏览器自己 preload="metadata" 抓首帧（poster 留空）。
  poster?: string;
  // PH gallery role: "logo" | "gallery" | undefined（旧 X 数据无此字段）
  role?: string;
}

export interface Metrics {
  views?: number;
  likes?: number;
  replies?: number;
  retweets?: number;
  [k: string]: number | undefined;
}

export interface Item {
  id: string;
  source_type: SourceType;
  source_id: string;
  source_ref?: string | null;
  title?: string | null;
  content?: string | null;
  content_translated?: string | null;
  author?: string | null;
  handle?: string | null;
  url?: string | null;
  media?: MediaItem[] | string | null;
  metrics?: Metrics | string | null;
  published_at?: string | null;
  scraped_at: string;
  is_relevant?: number | null;
  // 运营看板内容池：score > P90（X 7d AI 基线）时为 1，cron 自动维护
  // 设计：docs/plans/2026-05-21-ops-pool-design.md
  is_hot?: number | null;
  matched_by?: string | null;
  lang?: string | null;
  extra?: ItemExtra | string | null;
}

export interface QuoteOf {
  id?: string | null;
  author?: string | null;
  handle?: string | null;
  content?: string | null;
  content_translated?: string | null;
  profile_image_url?: string | null;
  is_verified?: number | boolean | null;
  media?: MediaItem[] | null;
  published_at?: string | null;
  metrics?: Metrics | null;
  // 嵌套引用(BE apiToQuoteOf 输出 — quote_of_id 始终在,quote_of 取决于 API
  // 是否返 inline)。FE 渲染最多到 depth=2,不再继续递归。
  quote_of_id?: string | null;
  quote_of?: QuoteOf | null;
  // BE PR #99 (2026-05-21): content 是单纯 t.co 短链时,BE 会 resolve 真实 URL
  // 写到 content_resolved_url。失败时(t.co 已删)写 content_resolve_failed_at
  // 而非 url(mutex,两者不会同时有)。FE 看到 resolved_url 时把 t.co 替换成
  // 可识别 link card(几乎全是 x.com/i/article/... X Articles)
  content_resolved_url?: string | null;
  content_resolve_failed_at?: string | null;
  // BE PR5 (2026-05-21): X Article 内容 (ScrapeBadger 抓回)。
  // mutex: fetched_at 有 title 通常齐 → Rich tier;fetch_failed_at 有但
  // author_handle 在 → Mid tier (老 article SB 反索引,只剩 author meta);
  // 完全没字段 → Basic tier (fallback 到 TcoResolvedLinkCard 裸 URL)。
  x_article?: XArticle | null;
}

export interface XArticle {
  article_id?: string | null;
  title?: string | null;
  excerpt?: string | null;
  cover_image_url?: string | null;
  summary_text?: string | null;       // Grok 5-bullet, bonus
  author_handle?: string | null;
  author_name?: string | null;
  fetched_at?: string | null;
  fetch_failed_at?: string | null;    // mutex 跟 fetched_at
  fetch_failed_reason?: string | null;
  // BE PR #112 (2026-05-22): DeepSeek 翻译 title + excerpt
  // (workflow step 1.7,跟 1.6 fetch 串行)
  title_translated?: string | null;
  excerpt_translated?: string | null;
  translated_at?: string | null;
  translate_failed_at?: string | null;
  translate_skipped_at?: string | null;   // 中文原文 / 中英混合 skip 翻译
  // BE PR6 / #113 (2026-05-25): body 抓取 (X GraphQL + cookie) + 翻译
  // body 跟 title/excerpt 是独立 mutex:body fetch 失败不影响 title/excerpt
  body?: string | null;                       // article.plain_text 完整正文
  body_fetched_at?: string | null;            // success sentinel
  body_fetch_failed_at?: string | null;       // failed sentinel (cookie 失效 / 老 article)
  body_fetch_failed_reason?: string | null;
  body_translated?: string | null;            // DeepSeek 译文
  // body 单字段 skip 标记:body > 15000 字符跳过翻译 (不影响 title/excerpt 翻译)
  body_translate_skipped_at?: string | null;
  body_translate_skipped_reason?: string | null;
}

export interface LinkCard {
  url?: string | null;
  display_url?: string | null;
  title?: string | null;
  title_translated?: string | null;
  description?: string | null;
  description_translated?: string | null;
  domain?: string | null;
  image_url?: string | null;
  // YouTube / Vimeo / 其他视频站的播放地址（BE PR #77 起返回）。
  // 有值时 LinkCard 用 <video> 渲染；播放失败时 fallback 到 image_url。
  video_url?: string | null;
}

export interface ItemExtra {
  author_id?: string;
  profile_image_url?: string;
  is_verified?: number | boolean;
  reply_to_id?: string;
  quote_of_id?: string;
  quote_of?: QuoteOf;
  reply_of_id?: string | null;
  reply_of?: QuoteOf | null;
  // F1: 转推父推快照。is_retweet=1 时前端用 retweet_of 翻转主体（被转推者
  // 当主卡），content 剥离 "RT @xxx: " 前缀，顶部加 "♻ 转推者 已转帖" 小字。
  is_retweet?: boolean;
  retweeted_status_id?: string;
  retweet_of?: QuoteOf | null;
  link_card?: LinkCard;
  thread_root_id?: string;
  hashtags?: string[];
  // 推文里 @ 到的 handle 列表(SB ingest)。转推无快照降级时取 [0] 当原作者 handle 兜底。
  user_mentions?: string[];
  urls?: Array<{ display_url?: string; expanded_url?: string; url?: string }>;
  ocr_text?: string;
  // BE PR #99 (2026-05-21): L1 主推 content 是单纯 t.co 短链时的 resolve 结果。
  // L2/L3 字段在 QuoteOf 自己上(quote_of/reply_of/retweet_of.content_resolved_url)。
  // 6 个 path 都遵守同一语义(mutex: 要么 url 要么 failed_at)
  content_resolved_url?: string | null;
  content_resolve_failed_at?: string | null;
  // BE PR5 (2026-05-21): L1 主推的 X Article meta(同样 6 个 path,L2/L3 在 QuoteOf)
  x_article?: XArticle | null;

  // GitHub-source specific fields (source_type = 'github')
  // 注：union 末尾的 model-release|research|product|engineering|safety|company 是
  // blog/podcast 源的 ai_category（§8.4.A）；与 GH 的 agent/model/... 共用同一 extra
  // 字段但语义不同，各卡片只 switch 自己的取值，不匹配的落 default。
  ai_category?:
    | "agent" | "model" | "tool" | "infra" | "app" | "tutorial" | "other"
    | "model-release" | "research" | "product" | "engineering" | "safety" | "company"
    | null;
  ai_summary?: string;
  llm_model?: string;
  llm_called_at?: number;
  readme_excerpt?: string;
  readme_translated?: string | null;
  contributors_inline?: Array<{ login: string; avatar_url: string }>;
  contributors_count?: number | null;
  sponsor?: number;
  daily_rank?: number | null;
  trending_date_str?: string;
  first_trending_at?: number;
  last_seen_on_trending_at?: number;
  default_branch?: string;
  license_spdx?: string | null;

  // Product Hunt-source specific fields (source_type = 'product_hunt')
  launch_date_pt?: string;
  product_slug?: string;
  ph_url?: string;
  website_url?: string | null;
  description?: string;
  pricing_type?: "free" | "free_options" | "paid" | "subscription" | string | null;
  is_open_source?: boolean;
  categories?: Array<{ name: string; slug: string; parent_name?: string; parent_slug?: string }>;
  makers?: Array<{ name?: string; handle?: string; avatar_url?: string; profile_url?: string }>;
  hunter?: { name?: string; handle?: string; avatar_url?: string } | null;
  maker_post_text?: string;
  maker_post_translated?: string;
  maker_post?: PhComment | null;
  top_comments?: PhComment[];
  top_reviews?: PhReview[];
  r2_migrated_at?: string | null;

  // Huodongxing-source specific fields (source_type = 'huodongxing')
  // KPI 数值（max_instance / registered_count / follows / visit_number /
  // organizer_fans）不在这里，在顶层 Item.metrics 列，类型见 HuodongxingMetrics。
  // 见 docs/plans/2026-05-11-huodongxing-frontend-handoff.md
  //
  // Listing 阶段就有（worker 入库 D1 即写入）：
  city?: string;                              // "北京"；线上活动也填 city（抓取参数）
  district?: string | null;                   // "朝阳"；跟 city 同名或线上活动时为 null
  is_online?: boolean;                        // location_raw === "线上活动" → true
  time_raw?: string;                          // "05/21 周四 14:30"，detail 未 enrich 时卡片显示用
  location_raw?: string;                      // "北京朝阳"，detail 未 enrich 时卡片显示用
  first_seen_at?: number;                     // unix sec
  last_seen_at?: number;                      // unix sec
  detail_enriched_at?: number | null;         // unix sec；null = 未 enrich，下方 detail 字段不可信
  organizer?: HuodongxingOrganizer;

  // Detail enrich 后才有（detail_enriched_at != null 才可信）：
  start_time?: string | null;                 // ISO+08:00；站点偶尔不给
  end_time?: string | null;                   // ISO+08:00；更常 null
  start_short?: string | null;                // "05/21 14:30" 站点 SSR 短文本
  end_short?: string | null;                  // "05/21 17:00"
  address?: string | null;                    // "三板汇茶咖空间发布厅"，仅场所名
  location_full?: string | null;              // "北京 · 朝阳 · xxx 发布厅"，已拼接 + 相邻段去重
  category?: number | null;                   // 活动行平台分类码
  tags?: string[];                            // ["硬科技路演", "投融资对接"]
  is_free?: boolean;
  is_private?: boolean;                       // 私密活动
  ticket_tiers?: HuodongxingTicketTier[];     // 前端取 .length / .slice(0, N) 自己算 count / preview
  guests?: HuodongxingGuest[] | string[];     // huodongxing 用对象数组；podcast 复用此字段存嘉宾名 string[]（合并避免 ItemExtra 重复声明）
  contact?: HuodongxingContact;
  thumbnail_full?: string | null;             // 大图原 URL（可能尚未迁 R2）
  og_image?: string | null;                   // 主图 og:image
  organizer_ids?: number[];                   // 主办方数字 ID 数组（备用）
  create_date?: string | null;                // 活动创建日期
  update_date?: string | null;                // 活动更新日期

  // Status 字段说明：worker 入库 extra.status 是字符串 "active" | "historical"
  // POC parsed.status 是站点原 status code（数字），两者不要混。
  // 这里只声明前端会看到的最终入库形态。worker /api/items 默认 filter
  // status != 'historical'，需要历史活动加 ?include_historical=1。
  status?: "active" | "historical";

  // HF Paper-source specific fields (source_type = 'hf_paper')
  // 见 docs/plans/2026-05-18-hf-daily-papers-frontend-handoff.md
  arxiv_id?: string;                          // "2605.13301"
  arxiv_categories?: string[];                // arxiv 分类(BE Phase 1 抓 arxiv.org Atom API),primary 在 [0],卡片右上角下拉筛选用
  title_zh?: string;                          // 标题中译
  summary_zh?: string;                        // arxiv abstract 中译
  ai_summary_zh?: string;                     // HF AI summary 中译
  ai_keywords?: string[];                     // HF 自带关键词（卡片显前 3）
  submitted_by?: HfSubmitter;                 // 提交人
  submitted_on_daily_at?: string;             // ISO8601
  project_page?: string | null;               // 项目主页 URL
  github_repo?: string | null;                // GH 链接
  github_url?: string | null;                 // 同义,兼容 BE 字段命名
  github_stars?: number | null;
  arxiv_pdf_url?: string;                     // arxiv.org/pdf/{id}.pdf
  ar5iv_html_url?: string;                    // ar5iv.org/abs/{id}
  paper_authors?: HfAuthor[];                 // 完整作者列表(避免和顶层 author 冲突重命名)
  discussion_id?: string;
  discussion_comments?: HfDiscussionComment[];  // HF discussion 顶级评论(Phase 2/3 抓)
  discussion_fetched_at?: string | null;        // ISO,null = 未抓 → 显示「加载中」
  full_text_zh?: string | null;               // ar5iv markdown 翻译(Phase 2)
  deep_analysis?: HfDeepAnalysis;             // 8 维度 + novelty meta 评分
  // BE figure lookahead 抽出的 hero 配图元数据;FE 用 width/height 算 aspect 决定容器形状,
  // 避免纵向 figure(GUI/screenshot 类 paper) 在 16:9 容器内 letterbox 留巨大补白
  figure_image?: { width?: number; height?: number; src_url?: string };
  workflow_completed_at?: string;

  // ── blog / podcast 两源共享字段（source_type = 'blog' | 'podcast'）──────────
  // 设计文档：docs/plans/2026-06-09-ai-vendor-feeds-source-design.md §4 / §5 / §10
  // 与 worker/src/feeds/types.ts 的 BlogExtra / PodcastExtra 形态对齐（BE 写、FE 读）。
  feed_id?: string;                           // 'blog:openai' / 'podcast:lex-fridman'
  source_company?: string;                    // 'OpenAI' / 'Lex Fridman'
  publisher?: BlogPublisher;                  // 出品方品牌（name + 迁 R2 logo）
  cover_image?: string;                       // 封面（迁 R2 后为 /r/ 路径）
  // ai_summary_zh / title_zh 复用上方 HF 已声明字段（ELI25 摘要 + 标题中译）
  // 跨源去重：次源写 dedup_of 指主源；handleItems 用 dedup_of IS NULL 隐藏
  dedup_of?: string | null;
  dedup_reason?: string;

  // blog 专属
  blog_name?: string;
  feed_key?: string;
  body_markdown?: string;                     // 正文原文 markdown（抓到才有）
  body_markdown_zh?: string;                  // 正文中译（ELI25 lazy）
  excerpt?: string;                           // 摘要原文（注：PH 也有 description，不混）
  excerpt_zh?: string;                        // 摘要中译（ELI25 eager）
  reading_minutes?: number;                   // 阅读时长（卡片 meta，替代缺失互动数）
  blog_media_r2_at?: string;

  // podcast 专属
  show_name?: string;
  show_key?: string;
  audio_url?: string;                         // ⚠️ 原始 enclosure 直链，前端 <audio> 直吃，不走 /r/
  audio_type?: string;
  audio_bytes?: number;
  duration_sec?: number;                      // 单集时长（卡片 / 海报 meta）
  episode_no?: number;
  episode_type?: string;
  shownotes?: string;                         // shownotes 原文
  shownotes_zh?: string;                      // shownotes 中译（ELI25 eager）
  transcript_tier?: "A" | "B" | "C";
  transcript_source?:
    | "podcast:transcript" | "substack-fulltext" | "show-page" | "none";
  transcript_url?: string;
  transcript_type?: string;
  transcript_text?: string;                   // A 档原生文字稿全文
  transcript_text_zh?: string;                // 文字稿中译（ELI25 lazy）
  chapters?: Array<{ start_sec: number; title: string }>;
  // guests 见上方 huodongxing 段：已合并为 HuodongxingGuest[] | string[] union（podcast 写 string[]）
  hosts?: string[];
  podcast_media_r2_at?: string;

  [k: string]: unknown;
}

// blog / podcast 出品方品牌信息（与 worker FeedPublisher 对齐）。
// icon_r2 = 迁 R2 后的反代路径（'/r/blog/<hash>'）；无则前端用首字母 monogram 兜底。
export interface BlogPublisher {
  name: string;
  icon_r2?: string;
  icon_src_url?: string;
  domain?: string;
}

export interface HfSubmitter {
  user: string;                               // HF username（@xxx）
  name?: string;                              // 显示名
  fullname?: string;
  avatar_url: string;                         // 走 /img 反代
  is_pro?: boolean;
}

export interface HfAuthor {
  name: string;
  hidden?: boolean;
}

export interface HfDiscussionComment {
  id: string;                                 // HF 内部 comment ID
  author_name: string;                        // fullname
  author_handle: string;                      // @handle
  author_avatar_url: string;                  // R2 迁移后路径
  raw_author_avatar_url?: string;             // 原 HF CDN URL 备份
  is_pro: boolean;                            // HF PRO 标识
  is_hf_admin: boolean;                       // HF 官方 admin
  content: string;                            // markdown 原文
  content_html: string;                       // BE rendered HTML(FE 直渲,跳 markdown 解析)
  content_zh?: string;                        // DeepSeek flash 翻译(language='zh' 时跳)
  posted_at: string;                          // ISO8601 createdAt
  updated_at?: string;                        // 编辑过的最后 update 时间
  edited?: boolean;                           // 是否编辑过
  is_author_reply: boolean;                   // BE 推算:comment.author._id === paper.submittedOnDailyBy._id
  language: string;                           // 'en' / 'zh' / etc(BE 抽 identifiedLanguage)
  reactions: Array<{ emoji: string; count: number }>;  // 简化版,去 users[]
  like_count: number;                         // 👍 reaction count 兜底字段
}

export interface HfExperiments {
  datasets: string[];                         // ≤5，chip 行
  key_metrics: Array<{
    name: string;
    value: string;
    vs_baseline: string;
  }>;                                         // ≤5，2-3 列 grid/table
  compute: string;                            // ≤20 字，monospace
  narrative?: string;                         // BE pro reasoning 的实验叙事长文(可选,2026-05-18 staging 起返回)
}

// code_status 是结构化对象(2026-05-18 staging 起):github / star / license / 可复现度 + 叙事
export interface HfCodeStatus {
  github_url?: string | null;                 // GH URL,null = 未开源
  star_count?: number | null;                 // GH star 数
  license?: string;                           // "MIT" / "Apache 2.0" / "unknown" / ...
  reproducibility?: "easy" | "medium" | "hard" | string;  // 复现难度
  narrative?: string;                         // 复现指引长文
}

// 8 维度 + 1 meta 评分
// novelty_rating 不在 drawer 8 维度列表里显示，单独作为 ★ 5 星条
export interface HfDeepAnalysis {
  version?: string;                           // 'v1' / 'v2',BE schema 版本
  tldr: string;                               // TL;DR 区
  problem: string;                            // 维度 1
  key_insight: string[];                      // 维度 2 — BE 实际返 1-3 条 list,FE 渲为 ul
  method: string;                             // 维度 3
  experiments: HfExperiments;                 // 维度 4
  industry_impact: string;                    // 维度 5
  code_status: HfCodeStatus;                  // 维度 6 — 2026-05-18 staging 起为结构化对象(github_url/star_count/license/reproducibility/narrative)
  limitations: string[];                      // 维度 7 — BE 实际返 list(典型 3 条,每条 200-500 字)
  novelty_rating: number;                     // 1-5 整数，meta 评分
}

export interface HfPaperMetrics {
  upvotes?: number;
  num_comments?: number;
  github_stars?: number;
  [k: string]: number | undefined;
}

export interface HuodongxingOrganizer {
  name: string;
  url: string;                                // 始终 absolute（worker 补成 https://www.huodongxing.com/org/<id>）
  slug?: string | null;                       // 自定义子域名形式才有，否则 null
  org_id?: number | null;                     // /org/<numeric_id> 形式才有，slug + org_id 至少一个非 null
  avatar_url?: string | null;
  fans?: number;
  is_certified_company?: boolean;
  is_vip_gold?: boolean;
}

export interface HuodongxingTicketTier {
  sn: number;
  name: string;
  description?: string;
  price: number;
  price_str: string;                          // "免费" / "¥199"
  src_price_str?: string | null;
  currency?: string | null;
  quantity?: number;                          // 总票数（0 = 不限）
  sold_number?: number;
  book_number?: number;
  status_str?: string;                        // "报名中" / "热销中" / "已结束"
  need_apply?: boolean;
}

export interface HuodongxingGuest {
  name: string;
  titles?: string[];                          // ["秘书长"]，注意是数组
  company?: string;
  description?: string;                       // 完整 bio
  avatar_url?: string | null;
  sort?: number;
}

export interface HuodongxingContact {
  org_phone?: string | null;
  org_email?: string | null;
  org_qr_code?: string | null;                // 客服微信二维码
  org_description?: string | null;
}

export interface PhComment {
  author_name?: string;
  author_handle?: string;
  avatar_url?: string;
  /** stripped 纯文本 — 旧字段，新 row + 翻译 fallback 仍用 */
  text?: string;
  /** 原始 HTML — 新字段（2026-05-14 起），前端 DOMPurify 渲染保留链接/段落 */
  body_html?: string;
  translated?: string;
  upvotes?: number | null;
  posted_at?: string;
  is_reply?: boolean;
}

export interface PhReview {
  author_name?: string;
  author_handle?: string;
  avatar_url?: string;
  rating?: number | null;
  body?: string;
  body_translated?: string;
}

export interface PhMetrics {
  votes?: number;
  comments?: number;
  reviews_count?: number;
  reviews_avg?: number;
  followers?: number;
  pricing_type?: string;
  [k: string]: number | string | undefined;
}

export interface GithubMetrics {
  stars?: number;
  today_stars?: number;
  forks?: number;
  watchers?: number;
  open_issues?: number;
  open_prs?: number;
  [k: string]: number | undefined;
}

export interface HuodongxingMetrics {
  organizer_fans?: number;     // 主办方粉丝数（drawer organizer block）
  max_instance?: number;       // 活动总容量
  registered_count?: number;   // 已报名（drawer KPI 核心数）
  follows?: number;            // 活动 follow 数
  visit_number?: number;       // 浏览数
  [k: string]: number | undefined;
}

export interface ItemsResponse {
  items: Item[];
  next_cursor: string | null;
  has_more: boolean;
  query_time_ms?: number;
}

export interface Source {
  id: string;
  source_type: SourceType;
  source_ref: string;
  name?: string | null;
  topic?: string | null;
  cursor?: string | null;
  last_success_at?: string | null;
  item_count?: number;
}

export interface SourcesResponse {
  sources: Source[];
}

export interface Stats {
  total_items: number;
  relevant_items: number;
  by_source: Record<string, number>;
  last_updated: string | null;
  items_today: number;
}
