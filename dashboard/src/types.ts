export type SourceType =
  | "x_list"
  | "youtube"
  | "podcast"
  | "product_hunt"
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

  [k: string]: unknown;
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
