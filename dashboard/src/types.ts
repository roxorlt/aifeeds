export type SourceType =
  | "x_list"
  | "youtube"
  | "podcast"
  | "product_hunt"
  | "github"
  | "arxiv";

export interface MediaItem {
  type: "image" | "video" | string;
  url: string;
  width?: number;
  height?: number;
  alt?: string;
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
  [k: string]: unknown;
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
