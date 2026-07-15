// worker/src/feeds/types.ts
//
// blog / podcast 两源的全队共享契约（Foundation 产出，并行 agent 照此实现/消费）。
// 设计文档：docs/plans/2026-06-09-ai-vendor-feeds-source-design.md §4 / §5 / §8 / §9
//
// 命名权威：设计文档 > 本文件注释。字段名一旦定稿，lib / pipeline / fetch / fe 各层
// 必须照此读写，不得各自改名（否则 extra JSON 在 BE 写、FE 读两端对不上）。
//
// 设计不变量速记：
//   - items 大一统表不加业务列，所有 blog/podcast 特异字段进 items.extra JSON。
//   - source_type ∈ {'blog','podcast'}；UNIQUE(source_type, source_id) 是去重键。
//   - 三种终态（relevant / irrelevant / dedup-suppressed）都写 extra.workflow_completed_at。
//   - 香港 host-rewrite 铁律：worker 拼对外 URL 一律用 env 规范域，不靠 request host。

// ─────────────────────────────────────────────────────────────────────────────
// 1. 枚举 / 基础类型
// ─────────────────────────────────────────────────────────────────────────────

/** 新源的 source_type（= items.source_type = sources.source_type）。 */
export type FeedKind = "blog" | "podcast";

/** 国内外（registry 存但 v1 不参与调度，留作 v2 作息分段开关位，见 §7.3）。 */
export type FeedRegion = "foreign" | "domestic";

/** feed XML 怎么 GET 回来：native=CF Worker 直连；rsshub=经 token-gated nginx 转发（Phase 2）。 */
export type FeedVia = "native" | "rsshub";

/**
 * feed XML 怎么 PARSE（parse.ts 据此选解析分支）。
 *   rss             普通 RSS 2.0 <item>
 *   atom            Atom <entry>（如 HF blog feed.xml）
 *   github-releases  GitHub /releases.atom（MiniCPM；release notes 当正文，归 source_type='blog'）
 */
export type FeedFormat = "rss" | "atom" | "github-releases";

/**
 * 详情页正文抓取策略（= BlogPipelineParams.fetchStrategy；决定 workflow step3 怎么拿全文，§6.4 升级阶梯）。
 *   native       feed 已自带全文，或简单静态 fetch 即可（Phase 1 全部 blog 走这条）
 *   page-scrape  CF Worker fetch HTML + HTMLRewriter/__NEXT_DATA__/正则 抽正文（Phase 3 SSR 站）
 *   headless     需无头浏览器渲染（Phase 3，复用 Codex 腾讯云渲染机 / CF-BR 备选）
 */
export type FetchStrategy = "native" | "page-scrape" | "headless";

/** 目标语言。当前仅支持 zh（与 X pipeline 一致）。 */
export type FeedLang = "zh";

/** 播客文字稿成本档（§3.1）：A=原生文字稿免转录；B=仅 shownotes+章节；C=薄 blurb。 */
export type TranscriptTier = "A" | "B" | "C";

/** 文字稿来源（写进 PodcastExtra.transcript_source）。v1 无 ASR，只有 native / none。 */
export type TranscriptSource =
  | "podcast:transcript" // RSS 原生 <podcast:transcript> VTT/SRT/JSON
  | "substack-fulltext" // Substack 全文当文字稿（Latent Space / Last Week in AI）
  | "show-page" // description 带官方 transcript 页 URL（Lex）
  | "none"; // B/C 档无原生文字稿（v1 不 ASR）

/**
 * ELI25 enrich 的二级分类（§8.4.A 枚举）。blog/podcast 共用同一套，
 * 与 GitHub 源的 ai_category 语义不同（GH 是 agent/model/tool/...），不要混用。
 */
export type FeedAiCategory =
  | "model-release" // 模型发布
  | "research" // 研究 / 技术报告
  | "product" // 产品 / 功能
  | "engineering" // 工程 / 基础设施
  | "safety" // 安全 / 对齐 / 政策
  | "company" // 公司动态 / 融资 / 合作
  | "other";

// ─────────────────────────────────────────────────────────────────────────────
// 2. FeedDef — registry.ts 里登记的单条 feed 定义（= sources.config 序列化形态）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 一条可订阅 feed 的静态定义。FEED_REGISTRY: FeedDef[] 是 curated 常量；
 * ensureFeedSources() 启动时幂等 upsert 进 sources 表（id=FeedDef.id, source_ref=FeedDef.key,
 * config=JSON.stringify(FeedDef)）。增删源改常量，不动 migration。
 */
export interface FeedDef {
  /** sources.id，形如 'blog:openai' / 'podcast:lex-fridman'。= `${kind}:${key}`。 */
  id: string;
  /**
   * feed_key（blog）/ show_key（podcast），形如 'openai' / 'lex-fridman'。
   * = sources.source_ref。复合 item id 用它：`blog:${key}:${idHash}`（§5.3）。
   * 约束：只含 [a-z0-9-]，保证拼进 workflow instance-id 合法。
   */
  key: string;
  /** = source_type。'blog'（含 github-releases 形态）/ 'podcast'。 */
  kind: FeedKind;
  /** feed XML 解析分支。缺省按 'rss' 处理。 */
  format: FeedFormat;
  /** 厂商 / 出品方显示名，进 enrich prompt 的 source_company 与 extra.publisher.name。如 'OpenAI' / 'Lex Fridman'。 */
  source_company: string;
  /** sources.name 用的人类可读名，如 'OpenAI Blog' / 'Lex Fridman Podcast'。 */
  name: string;
  region: FeedRegion;
  via: FeedVia;
  /**
   * via='native' → 完整 feed 直链（CF Worker fetch 用）；
   * via='rsshub' → rsshub route path（不含 base，如 '/xiaoyuzhou/podcast/<id>'，fetch 时拼 env.RSSHUB_BASE）。
   */
  feed_url: string;
  /** 拉取间隔小时数：blog=2，podcast=6（仅文档/观测用；真实调度由 cron slot 门控，§7.2）。 */
  cadence_hours: number;
  /** 详情页正文抓取策略。Phase 1 全部 'native'。 */
  fetch_strategy: FetchStrategy;
  /** 明确跳过涉华敏感 LLM 判定，直接写 extra.cn_sensitive=0（仅限可信白名单源）。 */
  skip_cn_sensitive?: boolean;
  /** 该 RSSHub 路由需要 Worker 通过 X-Weibo-Cookie 转发 WEIBO_COOKIES。 */
  needs_weibo_cookie?: boolean;
  /**
   * 正文相对 URL 解析的 base 域（§9.2：<content:encoded> 里的 src="/img/x.png" 要按各 feed 自己的域解析）。
   * 缺省时用该 item 的 canonical_url 推导。例 'https://openai.com'。
   */
  site_base?: string;
  /** 播客文字稿成本档（podcast only）。 */
  transcript_tier?: TranscriptTier;
  /**
   * 是否有原生文字稿（A 档 = true）。trigger workflow 时作为 PodcastPipelineParams.hasNativeTranscript 信号，
   * 决定 podcast pipeline step3 是否抓 transcript。
   */
  has_native_transcript?: boolean;
  /** 关闭开关（registry 里保留但临时不拉的源置 false；ensureFeedSources/调度跳过）。缺省视为 true。 */
  enabled?: boolean;
  /** 备注（停更 / SPOF / URL 修正说明等，仅人读）。 */
  notes?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. ParsedFeedItem — parse.ts 把 feed XML 归一化后的单条产出
// ─────────────────────────────────────────────────────────────────────────────

/**
 * parseFeed(xml, feed) 的单条输出。reverse-chrono 不保证（RSS 无排序契约，§7.4）。
 * fetch 层据此算复合 id / canonical / url_hash，并 INSERT OR IGNORE stub。
 */
export interface ParsedFeedItem {
  /** RSS <guid> ‖ <link>（identityKey；缺 guid 用 link）。算 idHash 的输入。 */
  guid: string;
  /** 原文详情页链接（算 canonical_url + url_hash 的输入）。 */
  link: string;
  /** 原文标题。 */
  title: string;
  /** 正文 HTML 原文（<content:encoded> / <description> / Atom <content>）。可能只是摘要。 */
  content_html?: string;
  /** 纯文本摘要 / shownotes 文本（喂 step1 廉价 gate 的 excerpt）。 */
  summary?: string;
  /** 发布时间 ISO8601（<pubDate>/<published>/<updated> 归一化）。 */
  published_at?: string;
  /** 作者 / <dc:creator>。 */
  author?: string;
  /**
   * 封面候选 URL（按 §9.1 多源回退链取第一个非空：enclosure image → media:content →
   * media:thumbnail → itunes:image → channel image → og:image）。原始域名，尚未迁 R2。
   */
  cover_url?: string;
  /** 播客音频直链（<enclosure url>）。podcast only。绝不迁 R2，前端 <audio> 直吃。 */
  enclosure_url?: string;
  /** 音频 MIME（<enclosure type>，如 'audio/mpeg'）。podcast only。 */
  enclosure_type?: string;
  /** 音频字节数（<enclosure length>）。podcast only。 */
  enclosure_bytes?: number;
  /** 单集时长秒数（<itunes:duration> 归一化）。podcast only。 */
  duration_sec?: number;
  /** 原生文字稿 URL（A 档 <podcast:transcript url>）。podcast only。 */
  transcript_url?: string;
  /** 原生文字稿 MIME（'text/vtt' / 'application/srt' / 'application/json'）。podcast only。 */
  transcript_type?: string;
  /** 单集序号（<itunes:episode>）。podcast only。 */
  episode_no?: number;
  /** 单集类型（<itunes:episodeType>：full/trailer/bonus）。podcast only。 */
  episode_type?: string;
  /** 主持人（<podcast:person role=host>，部分 feed 有）。海报增信息量。podcast only。 */
  hosts?: string[];
  /** 时间轴主题概要(A 档 VTT，#4)：[{ts,topic,speaker?,point}]。 */
  timeline?: Array<{ ts: string; topic: string; speaker?: string; point: string }>;
  /** 嘉宾（<podcast:person role=guest>，部分 feed 有）。podcast only。 */
  guests?: string[];
  /** 原始 feed item 标签 / 分类（<category>）。 */
  tags?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. extra JSON 形态 — BE 写 items.extra、FE 从 ItemExtra 读（dashboard/src/types.ts 镜像）
// ─────────────────────────────────────────────────────────────────────────────

/** publisher / 节目出品方品牌信息。icon_r2 = '/r/blog/<hash>'（迁 R2 后的反代路径，D9）。 */
export interface FeedPublisher {
  name: string;
  /** 迁 R2 后的 logo 反代路径（如 '/r/blog/ab12...'）；无则前端用首字母 monogram 兜底。 */
  icon_r2?: string;
  /** 原始 logo / favicon URL（迁移前备份 + debug）。 */
  icon_src_url?: string;
  /** 站点域名（如 'openai.com'）。 */
  domain?: string;
}

/** 正文媒体资产清单条目（B5 收集 → B6 迁 R2）。 */
export interface FeedBodyAsset {
  /** 已按 per-feed base 域 resolve 成绝对 URL 的原始地址（§9.2）。 */
  url: string;
  kind: "image" | "video";
  /** cover=封面；inline=正文内嵌。 */
  role: "cover" | "inline";
  /** 迁 R2 后的 /r/ 路径（迁移完成才有）。 */
  r2_url?: string;
  width?: number;
  height?: number;
}

export interface FeedCardImageVariant {
  url: string;
  width: number;
  height?: number;
  format: "webp";
  bytes?: number;
}

/** 正文抓取结果元数据（写 extra.body）。 */
export interface FeedBodyMeta {
  /** 正文来源：rss_full=feed 自带全文；static_extract=②静态抽取；browser_render=③无头；rss_summary_fallback=抓全文失败降级摘要。 */
  source:
    | "rss_full"
    | "static_extract"
    | "browser_render"
    | "rss_summary_fallback";
  /** 抽取时间 ISO。 */
  extracted_at: string;
  /** 收集到的媒体资产（迁 R2 前的清单）。 */
  assets?: FeedBodyAsset[];
}

/**
 * 跨源去重 + 完整性 gate 的共享 marker 字段。三态终态都写 workflow_completed_at（§5.5）。
 * v1 只计算 url_hash / canonical_url / dedup_of / dedup_reason；content_hash / dedup_group_id /
 * also_reported_by 是 v2（L2）预留位，v1 不写（见 §5.6）。
 */
export interface FeedDedupMarkers {
  /** 跨源精确去重键 = sha256hex(canonical_url).slice(0,16)。L1 唯一查的字段。 */
  url_hash?: string;
  /** 规范化后的 canonical URL（剔除追踪参数 / fragment / 默认端口等，§5.6）。 */
  canonical_url?: string;
  /** RSS 原始 guid（debug 用）。 */
  guid?: string;
  /** 被判为次源时，指向主源 item id（incumbent-wins）。隐藏靠 handleItems `dedup_of IS NULL`。 */
  dedup_of?: string;
  /** 去重判据（如 'l1_same_url'）。 */
  dedup_reason?: string;
  /** v2 预留：聚类 id。v1 不写。 */
  dedup_group_id?: string;
  /** v2 预留：标题 shingle hash。v1 不写。 */
  content_hash?: string;
  /** v2 预留：另有 N 源报道徽标。v1 不写。 */
  also_reported_by?: Array<{ item_id: string; source_company: string }>;
}

/**
 * 完整性 gate / workflow 生命周期 marker。三态终态都写 workflow_completed_at；
 * 隐藏靠业务 filter（relevant=1 + dedup_of IS NULL），不靠不写 gate（§5.5 根因）。
 */
export interface FeedWorkflowMarkers {
  workflow_triggered_at?: number | string;
  /** 终态写入（relevant 在 step5、高置信 irrelevant 在 step1、全文复判 irrelevant 在 step3、dedup 次源在 step2）。 */
  workflow_completed_at?: string;
  /** ELI25 enrich 失败时间（进 notifier 失败率监控）。 */
  enrich_failed_at?: string;
  /** 翻译失败时间。 */
  translation_failed_at?: string;
  /** 封面回填 marker，防重复迁移（§9.1）。 */
  cover_backfilled_at?: string;
  /** cover-quality-sweep 已处理 marker（分页前进，下轮不再扫）。 */
  cover_swept_at?: string;
  /** 封面迁移/门控拒绝时间（cover_image 落 ''）。 */
  cover_rejected_at?: string;
  /** og:image 存量回填游标（单调，处理必置位，无论 adopt/skip）。 */
  cover_og_backfilled_at?: string;
  /** generic-sweep 清簇时间（源级通用图被整簇清空）。 */
  cover_generic_cleared_at?: string;
  /** generic-sweep 清簇时记录的被清 R2 key（Fix C：og-backfill 判同 hash 回填终止循环）。 */
  cover_generic_cleared_hash?: string;
  /** 采用护栏（Task 2，2026-07-06）：迁 R2 后判同源 ≥3 条共用同图 → 撤销 og 采用的时间。 */
  cover_brandlogo_guarded_at?: string;
  /** 正文 hero 存量回填游标（bodyhero-backfill，单调，处理必置位，无论 adopt/skip）。 */
  cover_bodyhero_backfilled_at?: string;
  /** 正文作者头像/署名图存量清理游标（The Verge 首轮回填使用）。 */
  editorial_image_cleaned_at?: string;
  /** The Verge 独立 cover 命中作者头像强规则并在迁 R2 前被拒绝。 */
  editorial_image_cover_blocked_at?: string;
  /** 已确认的非正文图片 URL（含归一后的 /r/ 路径），供删除 asset 映射后继续兜底。 */
  editorial_image_blocked_urls?: string[];
}

/** blog / podcast 共有的 enrich 产物（§8.4.A）。 */
export interface FeedEnrichFields {
  ai_category?: FeedAiCategory;
  /** 一句话 ELI25 解读（30-50 字）。 */
  ai_summary_zh?: string;
  /** 标题中译（保留专有名词英文）。 */
  title_zh?: string;
  /** enrich 调用用的模型常量（如 'deepseek-v4-flash'）。 */
  llm_model?: string;
  llm_called_at?: number;
}

/**
 * source_type='blog' 的 items.extra 形态。
 * BE 各 workflow step 用 json_set 只动自己字段（防 lost-update，§9.2）。
 */
export interface BlogExtra
  extends FeedDedupMarkers,
    FeedWorkflowMarkers,
    FeedEnrichFields {
  /** = FeedDef.id（'blog:openai'），可回查 registry / sources。 */
  feed_id?: string;
  /** = FeedDef.key（'openai'）。 */
  feed_key?: string;
  source_company?: string;
  /** 博客名（= FeedDef.name）。 */
  blog_name?: string;
  feed_url?: string;
  fetch_strategy?: FetchStrategy;
  skip_cn_sensitive?: boolean;
  publisher?: FeedPublisher;

  /** 封面（迁 R2 后改写为 /r/ 路径；迁移前是原始域名 URL）。 */
  cover_image?: string;
  /** 与当前 cover_image 绑定的入库时 400/800 卡片 WebP。 */
  cover_image_variants?: FeedCardImageVariant[];
  cover_variant_source?: string;
  /** 正文 markdown 原文（step3 抓到才有；抓不到降级仅摘要也能上 feed）。 */
  body_markdown?: string;
  /** 正文 markdown 中译（ELI25，lazy，仅 relevant 非 dup 才译）。 */
  body_markdown_zh?: string;
  /** 摘要原文。 */
  excerpt?: string;
  /** 摘要中译（ELI25，60-120 字，eager）。 */
  excerpt_zh?: string;
  /** 阅读时长（分钟，卡片 meta 用，替代缺失的互动数）。 */
  reading_minutes?: number;
  /** 正文抓取元数据 + 媒体资产清单。 */
  body?: FeedBodyMeta;
  /** R2 媒体迁移 marker（专属字段，不撞 GH/PH 的 r2_migrated_at，§9.2）。 */
  blog_media_r2_at?: string;
  /** feed item 原始标签。 */
  tags?: string[];
}

/**
 * source_type='podcast' 的 items.extra 形态。音频直链不迁 R2（前端 <audio> 直吃 audio_url）。
 */
export interface PodcastExtra
  extends FeedDedupMarkers,
    FeedWorkflowMarkers,
    FeedEnrichFields {
  /** = FeedDef.id（'podcast:lex-fridman'）。 */
  feed_id?: string;
  /** = FeedDef.key（'lex-fridman'）。 */
  show_key?: string;
  source_company?: string;
  /** 节目名（= FeedDef.name）。 */
  show_name?: string;
  feed_url?: string;
  fetch_strategy?: FetchStrategy;
  publisher?: FeedPublisher;

  /** ⚠️ 音频原始 enclosure 直链。绝不迁 R2、绝不走 /r/（无 Range + 中转 OOM，§9.1）。 */
  audio_url?: string;
  audio_type?: string;
  audio_bytes?: number;
  /** 单集时长秒数（卡片 / 海报 meta 用「单集时长」替代互动数）。 */
  duration_sec?: number;
  episode_no?: number;
  episode_type?: string;

  /** 单集封面（迁 R2 后为 /r/ 路径）。 */
  cover_image?: string;
  cover_image_variants?: FeedCardImageVariant[];
  cover_variant_source?: string;
  /** shownotes markdown 原文。 */
  shownotes?: string;
  /** shownotes 中译（ELI25，eager）。 */
  shownotes_zh?: string;

  /** 文字稿成本档。 */
  transcript_tier?: TranscriptTier;
  /** 文字稿来源；'none' = B/C 档无原生稿（v1 不 ASR）。 */
  transcript_source?: TranscriptSource;
  transcript_url?: string;
  transcript_type?: string;
  /** 原生文字稿全文（A 档，解析 VTT/SRT/JSON 后）。 */
  transcript_text?: string;
  /** 文字稿中译（ELI25，lazy，A 档才有）。 */
  transcript_text_zh?: string;
  /** 章节（若 feed 提供）。 */
  chapters?: Array<{ start_sec: number; title: string }>;
  /** 嘉宾 / 主持人（若 shownotes 可抽）。 */
  guests?: string[];
  hosts?: string[];
  /** 时间轴主题概要(A 档 VTT，#4):[{ts,topic,speaker?,point}]。 */
  timeline?: Array<{ ts: string; topic: string; speaker?: string; point: string }>;
  /** R2 媒体迁移 marker（专属字段，不撞 r2_migrated_at）。 */
  podcast_media_r2_at?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Workflow payload — trigger 时传给 CF Workflow 的 params
// ─────────────────────────────────────────────────────────────────────────────

/** BLOG_PIPELINE_WORKFLOW.create({ id, params }) 的 params（§8.2）。 */
export interface BlogPipelineParams {
  itemId: string;
  /** = FeedDef.key，pipeline 据此回查 registry 取 fetch 细节 / site_base。 */
  feedKey: string;
  /** 详情页正文抓取策略（step3 用）。 */
  fetchStrategy: FetchStrategy;
  lang: FeedLang;
  /** 信号：feed 是否自带全文（true 时 step3 可跳过回源抓取）。 */
  hasNativeFulltext?: boolean;
  /** 信号：是否跳过涉华敏感 LLM 判定，直接写 extra.cn_sensitive=0。 */
  skipCnSensitive?: boolean;
}

/** PODCAST_PIPELINE_WORKFLOW.create({ id, params }) 的 params（§8.3）。 */
export interface PodcastPipelineParams {
  itemId: string;
  /** = FeedDef.key。 */
  showKey: string;
  /** 信号：是否有原生文字稿（A 档），决定是否跑 step3 抓 transcript。 */
  hasNativeTranscript?: boolean;
  lang: FeedLang;
}

/** trigger 时传的信号集合（fetch 层 → trigger helper）。 */
export interface BlogTriggerSignals {
  fetchStrategy: FetchStrategy;
  hasNativeFulltext?: boolean;
  skipCnSensitive?: boolean;
}
export interface PodcastTriggerSignals {
  hasNativeTranscript?: boolean;
}

/** workflow / fetch helper 统一返回的 trigger 结果（与 github triggerGhWorkflowForItem 对齐）。 */
export type TriggerResult =
  | "triggered"
  | "already_exists"
  | "binding_missing"
  | "failed";
