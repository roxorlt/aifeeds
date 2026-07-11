import { parseItemRow } from './item-row';

// List responses are a separate public contract from item detail and search.
// Keep this list deliberately small and stable: adding a database column must
// never make it appear in /api/items by accident.
export const BASE_LIST_ITEM_FIELDS = [
  'id',
  'source_type',
  'source_id',
  'source_ref',
  'title',
  'content',
  'content_translated',
  'author',
  'handle',
  'url',
  'media',
  'metrics',
  'published_at',
  'scraped_at',
  'is_relevant',
  'is_hot',
  'matched_by',
  'lang',
] as const;

export const SOURCE_EXTRA_ALLOWLISTS = {
  x_list: [
    'profile_image_url',
    'is_verified',
    'reply_to_id',
    'quote_of_id',
    'quote_of',
    'reply_of_id',
    'reply_of',
    'is_retweet',
    'retweeted_status_id',
    'retweet_of',
    'link_card',
    'thread_root_id',
    'user_mentions',
    'content_resolved_url',
    'x_article',
  ],
  github: [
    'ai_category',
    'ai_summary',
    'contributors_inline',
    'contributors_count',
    'daily_rank',
    'trending_date_str',
    'language',
    'cover_variants',
    'cover_variant_source',
  ],
  product_hunt: [
    'ai_category',
    'ai_summary',
    'launch_date_pt',
    'daily_rank',
    'display_rank',
    'makers',
  ],
  clawhub: [
    'slug',
    'latest_version',
    'category',
    'owner_image',
    'summary_translated',
  ],
  huodongxing: [
    'city',
    'district',
    'is_online',
    'time_raw',
    'location_raw',
    'detail_enriched_at',
    'start_time',
    'end_time',
    'start_short',
    'status',
    'is_free',
    'ticket_tiers',
    'organizer',
    'thumbnail_full',
    'og_image',
    'card_thumbnail_variants',
    'card_thumbnail_variant_source',
    'ai_summary',
  ],
  hf_paper: [
    'arxiv_id',
    'arxiv_categories',
    'title_zh',
    'ai_summary_zh',
    'ai_keywords',
    'submitted_by',
    'submitted_on_daily_at',
    'github_stars',
    'paper_authors',
    'figure_image',
  ],
  blog: [
    'feed_id',
    'source_company',
    'publisher',
    'cover_image',
    'cover_image_variants',
    'cover_variant_source',
    'title_zh',
    'ai_summary',
    'ai_summary_zh',
    'blog_name',
    'reading_minutes',
  ],
  podcast: [
    'feed_id',
    'source_company',
    'publisher',
    'cover_image',
    'cover_image_variants',
    'cover_variant_source',
    'title_zh',
    'ai_summary',
    'ai_summary_zh',
    'show_name',
    'duration_sec',
    'episode_no',
    'episode_type',
    'transcript_tier',
    'hosts',
    'guests',
    'timeline',
  ],
  // Legacy/public placeholders do not currently render source-specific extra.
  youtube: [],
  arxiv: [],
} as const satisfies Readonly<Record<string, readonly string[]>>;

export type ListItemSourceType = keyof typeof SOURCE_EXTRA_ALLOWLISTS;

export function isListItemSourceType(value: string): value is ListItemSourceType {
  return Object.prototype.hasOwnProperty.call(SOURCE_EXTRA_ALLOWLISTS, value);
}

const COMPACT_EXCERPT_LENGTH = 280;
const X_ARTICLE_TEXT_LENGTH = 600;
const X_QUOTE_TEXT_LENGTH = 240;
const X_LINK_TEXT_LENGTH = 400;

const X_ARTICLE_FIELDS = [
  'title',
  'excerpt',
  'cover_image_url',
  'author_handle',
  'author_name',
  'fetched_at',
  'fetch_failed_at',
  'title_translated',
  'excerpt_translated',
] as const;

const X_QUOTE_FIELDS = [
  'id',
  'author',
  'handle',
  'content',
  'content_translated',
  'profile_image_url',
  'is_verified',
  'published_at',
  'quote_of_id',
  'content_resolved_url',
] as const;

const X_LINK_CARD_FIELDS = [
  'url',
  'display_url',
  'title',
  'title_translated',
  'description',
  'description_translated',
  'domain',
  'image_url',
  'video_url',
] as const;

const LIST_MEDIA_FIELDS = [
  'type',
  'url',
  'width',
  'height',
  'alt',
  'poster',
  'card_variants',
  'poster_variants',
  'role',
  // Product Hunt legacy/embed metadata used to derive a static poster.
  'platform',
  'video_id',
  'videoUrl',
] as const;

const X_METRIC_FIELDS = ['views', 'likes', 'replies', 'retweets'] as const;

function compactExcerpt(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized.slice(0, COMPACT_EXCERPT_LENGTH);
}

function compactText(value: unknown, maxLength: number): unknown {
  return typeof value === 'string' ? value.slice(0, maxLength) : value;
}

function pickRecordFields(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(source, field) && source[field] !== undefined) {
      result[field] = source[field];
    }
  }
  return result;
}

function compactXArticle(value: unknown): Record<string, unknown> | undefined {
  const article = pickRecordFields(value, X_ARTICLE_FIELDS);
  if (!article) return undefined;
  for (const field of [
    'title',
    'excerpt',
    'summary_text',
    'title_translated',
    'excerpt_translated',
  ]) {
    if (field in article) article[field] = compactText(article[field], X_ARTICLE_TEXT_LENGTH);
  }
  return article;
}

function compactCardVariants(value: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const variants = value
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
      const source = entry as Record<string, unknown>;
      if (
        typeof source.url !== 'string' ||
        typeof source.width !== 'number' ||
        !Number.isFinite(source.width) ||
        source.width <= 0 ||
        source.format !== 'webp'
      ) return undefined;
      const variant: Record<string, unknown> = {
        url: source.url,
        width: source.width,
        format: 'webp',
      };
      if (
        typeof source.height === 'number' &&
        Number.isFinite(source.height) &&
        source.height > 0
      ) variant.height = source.height;
      return variant;
    })
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .slice(0, 2);
  return variants.length ? variants : undefined;
}

function compactListMedia(value: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const media = value
    .slice(0, 4)
    .map((entry) => pickRecordFields(entry, LIST_MEDIA_FIELDS))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));
  for (const entry of media) {
    for (const field of ['card_variants', 'poster_variants'] as const) {
      const variants = compactCardVariants(entry[field]);
      if (variants) entry[field] = variants;
      else delete entry[field];
    }
  }
  return media;
}

const EXTRA_CARD_VARIANT_FIELDS = [
  'cover_variants',
  'cover_image_variants',
  'card_thumbnail_variants',
] as const;

function compactXMetrics(value: unknown): Record<string, unknown> | undefined {
  return pickRecordFields(value, X_METRIC_FIELDS);
}

function compactXQuote(
  value: unknown,
  allowNestedQuote: boolean,
): Record<string, unknown> | undefined {
  const quote = pickRecordFields(value, X_QUOTE_FIELDS);
  if (!quote) return undefined;
  quote.content = compactText(quote.content, X_QUOTE_TEXT_LENGTH);
  quote.content_translated = compactText(quote.content_translated, X_QUOTE_TEXT_LENGTH);

  const source = value as Record<string, unknown>;
  const media = compactListMedia(source.media);
  const metrics = compactXMetrics(source.metrics);
  const article = compactXArticle(source.x_article);
  if (media) quote.media = media;
  if (metrics) quote.metrics = metrics;
  if (article) quote.x_article = article;
  if (allowNestedQuote) {
    const nested = compactXQuote(source.quote_of, false);
    if (nested) quote.quote_of = nested;
  }
  return quote;
}

function compactXListExtra(
  originalExtra: Record<string, unknown>,
  listExtra: Record<string, unknown>,
): void {
  const quote = compactXQuote(originalExtra.quote_of, true);
  const reply = compactXQuote(originalExtra.reply_of, false);
  const retweet = compactXQuote(originalExtra.retweet_of, true);
  const linkCard = pickRecordFields(originalExtra.link_card, X_LINK_CARD_FIELDS);
  const article = compactXArticle(originalExtra.x_article);

  if (quote) listExtra.quote_of = quote;
  else delete listExtra.quote_of;
  if (reply) listExtra.reply_of = reply;
  else delete listExtra.reply_of;
  if (retweet) listExtra.retweet_of = retweet;
  else delete listExtra.retweet_of;
  if (linkCard) {
    for (const field of ['title', 'title_translated', 'description', 'description_translated']) {
      if (field in linkCard) linkCard[field] = compactText(linkCard[field], X_LINK_TEXT_LENGTH);
    }
    listExtra.link_card = linkCard;
  } else {
    delete listExtra.link_card;
  }
  if (article) listExtra.x_article = article;
  else delete listExtra.x_article;

  if (Array.isArray(originalExtra.user_mentions)) {
    listExtra.user_mentions = originalExtra.user_mentions
      .filter((value): value is string => typeof value === 'string')
      .slice(0, 20)
      .map((value) => value.slice(0, 64));
  }
}

function pickAllowedExtra(
  sourceType: string,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  const allowed = isListItemSourceType(sourceType)
    ? SOURCE_EXTRA_ALLOWLISTS[sourceType]
    : [];
  const result: Record<string, unknown> = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(extra, key) && extra[key] !== undefined) {
      result[key] = extra[key];
    }
  }
  for (const key of EXTRA_CARD_VARIANT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(result, key)) continue;
    const variants = compactCardVariants(result[key]);
    if (variants) result[key] = variants;
    else delete result[key];
  }
  return result;
}

function readGithubRepo(item: Record<string, unknown>): string | null {
  for (const candidate of [item.source_id, item.title]) {
    if (typeof candidate === 'string' && /^[\w.-]+\/[\w.-]+$/.test(candidate)) {
      return candidate;
    }
  }
  return null;
}

function githubReadmeImages(readme: string): string[] {
  const urls: string[] = [];
  const markdown = /!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))/g;
  const html = /<img\b[^>]*\bsrc=["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = markdown.exec(readme)) !== null) {
    const url = match[1] || match[2];
    if (url) urls.push(url);
  }
  while ((match = html.exec(readme)) !== null) {
    if (match[1]) urls.push(match[1]);
  }
  return urls;
}

function isUsableGithubCover(url: string): boolean {
  return !(
    (/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^https?:\/\//i.test(url))
    || /\.svg(?:[?#]|$)/i.test(url)
    || /(shields\.io|badgen\.net|badge\.fury|forthebadge|img\.shields)/i.test(url)
  );
}

function resolveGithubCover(
  url: string,
  item: Record<string, unknown>,
  extra: Record<string, unknown>,
): string | undefined {
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('/r/')) return url;

  const repo = readGithubRepo(item);
  if (!repo) return undefined;
  const branch = typeof extra.default_branch === 'string' && extra.default_branch
    ? extra.default_branch
    : 'main';
  const base = `https://raw.githubusercontent.com/${repo}/${branch}/`;
  try {
    return new URL(url.replace(/^\//, ''), base).toString();
  } catch {
    return undefined;
  }
}

export function deriveGithubCover(
  item: Record<string, unknown>,
  extra: Record<string, unknown>,
): string | undefined {
  if (typeof extra.cover_url === 'string' && isUsableGithubCover(extra.cover_url)) {
    const storedCover = resolveGithubCover(extra.cover_url, item, extra);
    if (storedCover) return storedCover;
  }
  if (typeof extra.readme_excerpt !== 'string') return undefined;
  for (const candidate of githubReadmeImages(extra.readme_excerpt)) {
    if (!isUsableGithubCover(candidate)) continue;
    const resolved = resolveGithubCover(candidate, item, extra);
    if (resolved) return resolved;
  }
  return undefined;
}

function addCompactSourceFields(
  sourceType: string,
  parsed: Record<string, unknown>,
  originalExtra: Record<string, unknown>,
  listExtra: Record<string, unknown>,
): void {
  if (sourceType === 'x_list') {
    compactXListExtra(originalExtra, listExtra);
    return;
  }

  if (sourceType === 'github') {
    const cover = deriveGithubCover(parsed, originalExtra);
    if (cover) listExtra.cover_url = cover;
    return;
  }

  if (sourceType === 'hf_paper') {
    const analysis = originalExtra.deep_analysis;
    if (analysis && typeof analysis === 'object' && !Array.isArray(analysis)) {
      const tldr = (analysis as Record<string, unknown>).tldr;
      if (typeof tldr === 'string' && tldr) listExtra.deep_analysis = { tldr };
    }
    return;
  }

  if (sourceType === 'blog' || sourceType === 'podcast') {
    const excerpt = compactExcerpt(
      originalExtra.excerpt
      ?? (sourceType === 'podcast' ? originalExtra.shownotes : undefined)
      ?? parsed.content,
    );
    const excerptZh = compactExcerpt(
      originalExtra.excerpt_zh
      ?? (sourceType === 'podcast' ? originalExtra.shownotes_zh : undefined)
      ?? parsed.content_translated,
    );
    if (excerpt) listExtra.excerpt = excerpt;
    if (excerptZh) listExtra.excerpt_zh = excerptZh;
  }
}

export function toListItem(row: Record<string, unknown>): Record<string, unknown> {
  // full=true parses JSON without applying the legacy search-response blacklist.
  // The list DTO below is then built from positive allowlists only.
  const parsed = parseItemRow(row, true);
  const result: Record<string, unknown> = {};
  for (const key of BASE_LIST_ITEM_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(parsed, key) && parsed[key] !== undefined) {
      result[key] = parsed[key];
    }
  }
  if (Object.prototype.hasOwnProperty.call(result, 'media')) {
    const media = compactListMedia(result.media);
    if (media) result.media = media;
    else if (result.media !== null) delete result.media;
  }

  const sourceType = typeof parsed.source_type === 'string' ? parsed.source_type : '';
  const originalExtra = parsed.extra && typeof parsed.extra === 'object' && !Array.isArray(parsed.extra)
    ? parsed.extra as Record<string, unknown>
    : {};
  const listExtra = pickAllowedExtra(sourceType, originalExtra);
  addCompactSourceFields(sourceType, parsed, originalExtra, listExtra);
  result.extra = listExtra;

  // These sources historically carried full documents in top-level content.
  // Keep the common base shape but bound its fallback preview.
  if (sourceType === 'clawhub' || sourceType === 'blog' || sourceType === 'podcast') {
    const content = compactExcerpt(result.content);
    const translated = compactExcerpt(result.content_translated);
    if (content !== undefined) result.content = content;
    if (translated !== undefined) result.content_translated = translated;
  }

  return result;
}
