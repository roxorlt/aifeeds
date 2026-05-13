export type SourceType =
  | "x_list"
  | "youtube"
  | "podcast"
  | "product_hunt"
  | "huodongxing"
  | "github"
  | "arxiv"
  | "clawhub";

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
  link_card?: LinkCard;
  thread_root_id?: string;
  hashtags?: string[];
  urls?: Array<{ display_url?: string; expanded_url?: string; url?: string }>;
  ocr_text?: string;

  // GitHub-source specific fields (source_type = 'github')
  ai_category?: "agent" | "model" | "tool" | "infra" | "app" | "tutorial" | "other" | null;
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
  guests?: HuodongxingGuest[];                // 同上
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

  [k: string]: unknown;
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
  text?: string;
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
