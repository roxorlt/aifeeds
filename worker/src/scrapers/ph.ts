// Product Hunt fetch module — GraphQL v2 + client_credentials OAuth.
//
// Scope: list yesterday's PT-day top 30 posts, fetch each post's full detail,
// transform to IngestItem[], hand to internal ingestItems() — no HTTP self-fetch.
//
// Rate limit: 6250 complexity points / 15min. We use ~1500-2000/day.
// PH client_credentials access tokens default ~30 day TTL; we cache 25 days
// defensively in AUTH_KV + auto-refresh on 401.
//
// Sister file `worker/src/ph-r2.ts` handles R2 asset migration after ingest.
// Schema (Post / Media / User / Comment / CommentsOrder) verified via
// introspection 2026-05-11; `Post.dailyRank` is API-given, no order inference.

import type { Env, ItemInput } from '../index';
import { ingestItems } from '../index';
import { PH_ENRICH_PROMPT, DEEPSEEK_URL } from '../enrich';
// 翻译原语抽到 ph-translate.ts（无 index.ts 依赖，可单测）。ph.ts 与回填 mode 共用同一封装。
import { translatePhBatch, isLikelyChinesePh } from './ph-translate';

// ─── Constants ─────────────────────────────────────────────────

const PH_OAUTH_URL = 'https://api.producthunt.com/v2/oauth/token';
const PH_GRAPHQL_URL = 'https://api.producthunt.com/v2/api/graphql';
const TOKEN_KV_KEY = 'ph:access_token';
const TOKEN_KV_TTL = 60 * 60 * 24 * 25; // 25 days (PH default ~30, defensive)
const SENTINEL_KEY_PREFIX = 'ph:fetched:';
const SENTINEL_TTL = 60 * 60 * 24 * 2;  // 2 days (allow next-day retry)

// ─── OAuth ─────────────────────────────────────────────────────

interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
}

/**
 * Get PH access token from KV cache, or fetch fresh + cache. Returns null if
 * credentials missing (caller should noop and log).
 */
export async function getPhAccessToken(env: Env): Promise<string | null> {
  if (!env.PH_CLIENT_ID || !env.PH_CLIENT_SECRET) {
    console.warn('[ph] PH_CLIENT_ID/SECRET not set — skip');
    return null;
  }

  const cached = await env.AUTH_KV.get(TOKEN_KV_KEY);
  if (cached) return cached;

  const res = await fetch(PH_OAUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.PH_CLIENT_ID,
      client_secret: env.PH_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`[ph] OAuth fetch failed: HTTP ${res.status} ${body.slice(0, 200)}`);
    return null;
  }
  const data = (await res.json()) as OAuthTokenResponse;
  if (!data.access_token) {
    console.error('[ph] OAuth response missing access_token:', JSON.stringify(data));
    return null;
  }
  await env.AUTH_KV.put(TOKEN_KV_KEY, data.access_token, { expirationTtl: TOKEN_KV_TTL });
  console.log(`[ph] OAuth fresh token cached for ${TOKEN_KV_TTL}s`);
  return data.access_token;
}

/** Drop cached token (called on 401 — caller retries with fresh). */
export async function invalidatePhAccessToken(env: Env): Promise<void> {
  await env.AUTH_KV.delete(TOKEN_KV_KEY);
}

// ─── GraphQL queries ───────────────────────────────────────────
//
// Field names verified via introspection (2026-05-11). Notable:
// - Post.dailyRank is API-given (no list-order inference needed)
// - User.profileImage takes no args (plain String field)
// - Media.videoUrl is the embed URL when type='video' (mp4 direct via .url)
// - CommentsOrder enum: NEWEST | VOTES_COUNT
// - Comment.votesCount + Comment.parentId both exist for thread filtering

// Query.posts args (verified via introspection 2026-05-11):
//   featured (Boolean) — only featured posts (vs user submissions)
//   postedAfter / postedBefore (DateTime) — filter by createdAt
//   order (PostsOrder enum) — FEATURED_AT | VOTES | RANKING | NEWEST
// No featuredAfter/featuredBefore params; postedAfter+featured covers 95%+
// (PH posts are usually featured same-day they're posted).
// PH API 每页最多返回 20 个 post，要拿全要走 cursor 翻页（pageInfo.hasNextPage）。
// PT 一日 featured 总数实测可达 50+，原 first:30 单页只拿到 20 漏掉一大半。
const LIST_QUERY = `
  query PhDailyList($postedAfter: DateTime!, $postedBefore: DateTime!, $after: String) {
    posts(
      postedAfter: $postedAfter,
      postedBefore: $postedBefore,
      featured: true,
      order: VOTES,
      first: 20,
      after: $after
    ) {
      edges {
        node { id slug name votesCount featuredAt dailyRank }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// 共享 Post 字段串。两个 query（by id / by slug）都用这一份，避免双份维护。
//
// ⚠️ PH GraphQL Post 不暴露 reviews 列表 — 只有 reviewsCount / reviewsRating
// 两个数字摘要（实测 2026-05-14：PH 报 "Field 'reviews' doesn't exist on type
// 'Post' (Did you mean reviewsCount?)"）。老 scraper 的 extra.top_reviews 是 DOM
// 抠 PH 网页的"评测页"，GraphQL 没对应 endpoint。如果未来要补 review 列表，要么
// 等 PH 开放（不大可能），要么回到 DOM 抓（Browser binding / 本地 scraper 重型）。
const POST_DETAIL_FIELDS = `
  id slug name tagline description url website
  featuredAt createdAt dailyRank
  votesCount commentsCount reviewsCount reviewsRating
  thumbnail { url type videoUrl }
  media { url type videoUrl }
  user { id name username headline profileImage }
  makers { id name username headline profileImage }
  topics(first: 5) { edges { node { name slug } } }
  comments(order: VOTES_COUNT, first: 10) {
    edges {
      node {
        id body votesCount createdAt parentId
        user { id name username profileImage }
      }
    }
  }
  productLinks { type url }
`;

const DETAIL_QUERY = `
  query PhPostDetail($id: ID!) {
    post(id: $id) {
      ${POST_DETAIL_FIELDS}
    }
  }
`;

// PH GraphQL Query.post(slug: String) 与 post(id: ID) 同源，二选一参数。
// refreshPhItem 用 by-slug：items.source_id 形如 "<slug>:<launch_date>"，
// 没存 PH 内部 post.id（旧数据兼容性 + transform 时 sourceId 用 slug 派生）。
const DETAIL_QUERY_BY_SLUG = `
  query PhPostDetailBySlug($slug: String!) {
    post(slug: $slug) {
      ${POST_DETAIL_FIELDS}
    }
  }
`;

// ─── GraphQL fetch helper ──────────────────────────────────────

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; path?: string[] }>;
}

/**
 * POST GraphQL with auto-retry on 401 (token expired earlier than KV TTL).
 * Returns parsed `data` field, or null on error (logged).
 */
async function phGraphQL<T>(
  env: Env,
  query: string,
  variables: Record<string, unknown>,
  retried = false,
): Promise<T | null> {
  const token = await getPhAccessToken(env);
  if (!token) return null;

  const res = await fetch(PH_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (res.status === 401 && !retried) {
    console.warn('[ph] GraphQL 401 — invalidating token + retry once');
    await invalidatePhAccessToken(env);
    return phGraphQL<T>(env, query, variables, true);
  }
  if (!res.ok) {
    const body = await res.text();
    console.error(`[ph] GraphQL HTTP ${res.status}: ${body.slice(0, 200)}`);
    return null;
  }
  const json = (await res.json()) as GraphQLResponse<T>;
  if (json.errors && json.errors.length) {
    console.error('[ph] GraphQL errors:', JSON.stringify(json.errors));
    return null;
  }
  return json.data ?? null;
}

// ─── Typed PH response shapes ──────────────────────────────────

export interface PhListNode {
  id: string;
  slug: string;
  name: string;
  votesCount: number;
  featuredAt: string;
  dailyRank: number | null;
}

export interface PhMedia {
  url: string;
  type: string;        // "image" | "video"
  videoUrl: string | null; // populated when type='video' (embed URL)
}

export interface PhUser {
  id: string;
  name: string | null;
  username: string | null;
  headline: string | null;
  profileImage: string | null;
}

export interface PhCommentNode {
  id: string;
  body: string;
  votesCount: number;
  createdAt: string;
  parentId: string | null;
  user: PhUser;
}

export interface PhPostDetail {
  id: string;
  slug: string;
  name: string;
  tagline: string;
  description: string | null;
  url: string;
  website: string | null;
  featuredAt: string;
  createdAt: string;
  dailyRank: number | null;
  votesCount: number;
  commentsCount: number;
  reviewsCount: number;
  reviewsRating: number | null;
  thumbnail: PhMedia | null;
  media: PhMedia[];
  user: PhUser;
  makers: PhUser[];
  topics: { edges: Array<{ node: { name: string; slug: string } }> };
  comments: { edges: Array<{ node: PhCommentNode }> };
  productLinks: Array<{ type: string; url: string }>;
}

interface ListQueryData {
  posts: {
    edges: Array<{ node: PhListNode }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

interface DetailQueryData {
  post: PhPostDetail;
}

// ─── Date helpers (PT-aware, DST-safe) ─────────────────────────

/**
 * Get current PT date in YYYY-MM-DD form using IANA tz America/Los_Angeles.
 * Auto handles PDT/PST switch.
 */
export function ptDateNow(now: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  // en-CA gives "YYYY-MM-DD" format
  return fmt.format(now);
}

export function ptYesterday(now: Date = new Date()): string {
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return ptDateNow(yesterday);
}

/** Compute next-day PT date string (for query upper bound). */
function nextPtDate(ptDateStr: string): string {
  // Parse as PT noon (avoids DST edge), add 1 day, format.
  const [y, m, d] = ptDateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 20, 0, 0)); // 20:00 UTC ≈ 12:00/13:00 PT
  dt.setUTCDate(dt.getUTCDate() + 1);
  return ptDateNow(dt);
}

/** Get PT UTC offset for a given PT date. Returns "-07:00" (PDT) or "-08:00" (PST). */
function ptOffsetForDate(ptDateStr: string): string {
  const [y, m, d] = ptDateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 20, 0, 0));
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'longOffset',
  });
  const parts = fmt.formatToParts(dt);
  const tzPart = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT-08:00';
  return tzPart.replace('GMT', '');
}

// ─── List + Detail wrappers ────────────────────────────────────

export async function listPhDailyPosts(
  env: Env,
  ptDateStr: string,
): Promise<PhListNode[]> {
  const offsetStr = ptOffsetForDate(ptDateStr);
  const postedAfter = `${ptDateStr}T00:00:00${offsetStr}`;
  const nextDay = nextPtDate(ptDateStr);
  const postedBefore = `${nextDay}T00:00:00${offsetStr}`;

  // Cursor 翻页直到 hasNextPage=false。PH 每页 20 条，日 featured 50+ 时
  // 需要 3 页才能拿全。保护：max 10 页（200 条），防 API 抖动死循环。
  const all: PhListNode[] = [];
  let after: string | null = null;
  for (let page = 0; page < 10; page++) {
    const data: ListQueryData | null = await phGraphQL<ListQueryData>(env, LIST_QUERY, {
      postedAfter,
      postedBefore,
      after,
    });
    if (!data) break;
    all.push(...data.posts.edges.map((e: { node: PhListNode }) => e.node));
    if (!data.posts.pageInfo.hasNextPage || !data.posts.pageInfo.endCursor) break;
    after = data.posts.pageInfo.endCursor;
  }
  return all;
}

export async function fetchPhPostDetail(
  env: Env,
  postId: string,
): Promise<PhPostDetail | null> {
  const data = await phGraphQL<DetailQueryData>(env, DETAIL_QUERY, { id: postId });
  return data?.post ?? null;
}

/**
 * Same as fetchPhPostDetail but keyed by slug (URL-friendly id), used by
 * lazy-enrich-on-drawer where items.source_id 形如 "<slug>:<launch_date>"
 * 没保留 PH 内部 post.id。
 */
export async function fetchPhPostDetailBySlug(
  env: Env,
  slug: string,
): Promise<PhPostDetail | null> {
  const data = await phGraphQL<DetailQueryData>(env, DETAIL_QUERY_BY_SLUG, { slug });
  return data?.post ?? null;
}

// ─── Transform PhPostDetail → IngestItem ───────────────────────

interface PhMediaItemDb {
  url: string;
  type: 'image' | 'video';
  role?: 'logo';
  // For video: embed URL (videoUrl from API). Frontend already handles
  // platform-aware embedding (youtube/vimeo) by pattern-matching the URL.
  videoUrl?: string;
}

interface PhMakerDb {
  name: string | null;
  handle: string | null;
  avatar_url: string | null;
  profile_url: string | null;
}

interface PhCommentDb {
  author_name: string | null;
  author_handle: string | null;
  avatar_url: string | null;
  /** Stripped plain text — 旧字段，保留给旧 row + 翻译 fallback */
  text: string;
  /** 原始 HTML — 前端用 DOMPurify 清洗后渲染，保留链接 / 段落 / 图片 */
  body_html: string;
  upvotes: number;
}

function userToProfileUrl(u: PhUser): string | null {
  return u.username ? `https://www.producthunt.com/@${u.username}` : null;
}

/**
 * PH GraphQL with client_credentials auth (no user context) masks most user
 * identities as "[REDACTED]" / id="0" — only the post.user (hunter) and
 * the viewer's own info come through real. This is a privacy protection vs
 * scraping; nothing to do with the user being deleted.
 *
 * Strategy:
 * - makers[] array: filter out [REDACTED] (full anonymous list has no value)
 * - comments / maker_post: KEEP, but show author as "PH 用户" placeholder —
 *   the comment text itself is valuable (e.g. maker self-intro often there)
 * - hunter: trust as-is (always real)
 */
function isRedactedUser(u: PhUser): boolean {
  return u.name === '[REDACTED]' || u.username === '[REDACTED]';
}

const ANONYMOUS_PH_USER_LABEL = 'PH 用户';

function userToMakerOrNull(u: PhUser): PhMakerDb | null {
  if (isRedactedUser(u)) return null;
  return {
    name: u.name,
    handle: u.username,
    avatar_url: u.profileImage,
    profile_url: userToProfileUrl(u),
  };
}

/**
 * Strip basic HTML tags from PH comment bodies. PH returns rich-text HTML
 * (<p>, <br>, <img>, <a>) but our frontend uses whitespace-pre-wrap and
 * renders tags literally. Convert to plain text with paragraph/line breaks.
 */
function stripHtml(html: string): string {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<p[^>]*>/gi, '')
    .replace(/<\/p>/gi, '')
    .replace(/<\/?(div|span|strong|b|i|em|u)[^>]*>/gi, '')
    .replace(/<a[^>]*>(.*?)<\/a>/gi, '$1')
    .replace(/<img[^>]*alt=["']([^"']*)["'][^>]*>/gi, '[图片:$1]')
    .replace(/<img[^>]*>/gi, '[图片]')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function commentToDb(c: PhCommentNode): PhCommentDb {
  const isRedacted = isRedactedUser(c.user);
  return {
    author_name: isRedacted ? ANONYMOUS_PH_USER_LABEL : c.user.name,
    author_handle: isRedacted ? null : c.user.username,
    avatar_url: isRedacted ? null : c.user.profileImage,
    text: stripHtml(c.body),
    body_html: c.body || '',
    upvotes: c.votesCount,
  };
}

function mediaToDb(m: PhMedia, role?: 'logo'): PhMediaItemDb {
  const out: PhMediaItemDb = {
    url: m.url,
    type: m.type === 'video' ? 'video' : 'image',
  };
  if (role) out.role = role;
  if (m.type === 'video' && m.videoUrl) out.videoUrl = m.videoUrl;
  return out;
}

/**
 * Convert PH API post detail to IngestItem ready for ingestItems().
 * dailyRank from API directly (Post.dailyRank, schema-given).
 */
export function transformPostToIngestItem(
  post: PhPostDetail,
  ptLaunchDate: string,
): ItemInput {
  const sourceId = `${post.slug}:${ptLaunchDate}`;

  // Media: thumbnail → role='logo'; media[] → gallery
  const media: PhMediaItemDb[] = [];
  if (post.thumbnail?.url) {
    media.push(mediaToDb(post.thumbnail, 'logo'));
  }
  for (const m of post.media) {
    if (!m.url) continue;
    media.push(mediaToDb(m));
  }

  // Makers + Hunter — filter out [REDACTED] users (PH masks deleted/spam users)
  const makers: PhMakerDb[] = post.makers
    .map(userToMakerOrNull)
    .filter((m): m is PhMakerDb => m !== null);
  const hunter = userToMakerOrNull(post.user);

  // Comments: separate maker_post (first by maker, by votes) vs top_comments.
  // Keep [REDACTED] comments — text content is valuable (maker self-intros etc),
  // commentToDb shows author as "PH 用户" placeholder.
  const makerIdSet = new Set(post.makers.map((m) => m.id));
  const sortedComments = post.comments.edges
    .map((e) => e.node)
    .filter((c) => !c.parentId) // top-level only
    .sort((a, b) => b.votesCount - a.votesCount);

  let makerPost: PhCommentDb | null = null;
  const topComments: PhCommentDb[] = [];
  for (const c of sortedComments) {
    if (!makerPost && makerIdSet.has(c.user.id)) {
      makerPost = commentToDb(c);
      continue; // exclude from top_comments to avoid dup
    }
    topComments.push(commentToDb(c));
  }

  // Metrics — followers not exposed by API, frontend KPI displays "—"
  const metrics: Record<string, number | undefined> = {
    votes: post.votesCount,
    comments: post.commentsCount,
    reviews_count: post.reviewsCount,
  };
  if (post.reviewsRating !== null) {
    metrics.reviews_avg = post.reviewsRating;
  }

  // Extra JSON
  const extra: Record<string, unknown> = {
    daily_rank: post.dailyRank ?? null,
    launch_date_pt: ptLaunchDate,
    product_slug: post.slug,
    ph_url: post.url,
    website_url: post.website,
    description: post.description,
    topics: post.topics.edges.map((e) => e.node.slug),
    makers,
    hunter,
    maker_post: makerPost,
    maker_post_text: makerPost?.text ?? null,
    top_comments: topComments,
    r2_migrated_at: null, // ph-r2-migrate cron will set
    // ai_summary / ai_category filled by ph-enrich cron
    // pricing_type / is_open_source: API doesn't expose — front-end hides chips
    // top_reviews: PH GraphQL 不暴露 reviews 列表，老 scraper DOM 抠的字段 worker
    //   流程下永远为空。前端 ReviewItem 仍能渲染，只是数据源缺失。
  };

  return {
    source_type: 'product_hunt',
    source_id: sourceId,
    title: post.name,
    content: post.tagline,
    // Use filtered makers/hunter (skip [REDACTED] users) for author fallback
    author: makers[0]?.name ?? hunter?.name ?? undefined,
    handle: makers[0]?.handle ?? hunter?.handle ?? undefined,
    url: post.url,
    media: JSON.stringify(media),
    metrics: JSON.stringify(metrics),
    published_at: post.featuredAt,
    scraped_at: new Date().toISOString(),
    is_relevant: undefined, // NULL → triggers ph-enrich
    lang: 'en',
    extra: JSON.stringify(extra),
  };
}

// ─── Lazy enrich (drawer 打开时调一次) ─────────────────────────
//
// 仿 github.refreshGithubItem / clawhub.refreshClawhubItem 模式：用户打开抽屉
// 时由 enrich.refreshSingleItem 分发过来，主动 fetch 一次单 product 拿最新
// votes / commentsCount / reviews / makers / comments，写回 D1 + append snapshot。
//
// 字段保留策略（merge 而非覆盖）：
// - metrics: 直接覆盖（votes/comments/reviews 都是计数随时间变）
// - extra: 拿新 fetch 的全套，再用 oldExtra 覆盖 enrich-only 字段
//   （ai_summary / ai_category / classified_at / r2_migrated_at / *_translated）
//   避免 enrich 结果被擦掉。

const ENRICH_ONLY_EXTRA_KEYS = [
  'ai_category',
  'ai_summary',
  'classified_at',
  'r2_migrated_at',
  'maker_post_translated',
  'maker_post_text_translated',
] as const;

/**
 * 合并新拉的 PH extra 与老的 D1 extra,保留 enrichment 字段 + comment 元素级翻译。
 *
 * 用法:
 * - refreshPhItem(FE drawer 调) 老 extra 已读 → 直接传入
 * - runPhDailyFetch ingest 前批量预读老 extra → 单条调用
 *
 * 策略:
 * - root 字段:ENRICH_ONLY_EXTRA_KEYS 列表里的字段从老 extra 取(覆盖新值)
 * - top_comments 数组:按 text 匹配老 comment,复制 .translated 到新 comment
 *   (新 ingest 永远不含 translated → 不会反向覆盖老 translated)
 */
export function mergePhExtraPreservingEnrichment(
  oldExtra: Record<string, unknown>,
  newExtra: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...newExtra };

  // root-level enrichment 字段保留老值
  for (const k of ENRICH_ONLY_EXTRA_KEYS) {
    if (oldExtra[k] !== undefined) merged[k] = oldExtra[k];
  }

  // top_comments 元素级保留 translated
  if (Array.isArray(merged.top_comments) && Array.isArray(oldExtra.top_comments)) {
    const oldByText = new Map<string, Record<string, unknown>>();
    for (const c of oldExtra.top_comments as Array<Record<string, unknown>>) {
      const text = c?.text;
      if (typeof text === 'string') oldByText.set(text, c);
    }
    merged.top_comments = (merged.top_comments as Array<Record<string, unknown>>).map((newC) => {
      const text = newC?.text;
      if (typeof text === 'string') {
        const oldC = oldByText.get(text);
        if (oldC?.translated && !newC.translated) {
          return { ...newC, translated: oldC.translated };
        }
      }
      return newC;
    });
  }

  return merged;
}

export interface PhRefreshResult {
  refreshed: boolean;
  reason: 'success' | 'not_found' | 'fetch_failed' | 'invalid_source_id';
  metrics?: Record<string, number | null>;
}

// Narrow env shape for refreshPhItem — 仿 GithubEnv / ClawhubEnv 模式，避免要求
// caller 传完整 Env（refreshSingleItem 在 enrich.ts 用的是 EnrichEnv 派生类型）。
export interface PhRefreshEnv {
  DB: D1Database;
  AUTH_KV: KVNamespace;
  PH_CLIENT_ID?: string;
  PH_CLIENT_SECRET?: string;
}

export async function refreshPhItem(
  env: PhRefreshEnv,
  itemId: string,
  sourceId: string, // 形如 "<slug>:<launch_date>" 例如 "staff-rip:2026-05-09"
): Promise<PhRefreshResult> {
  // 1. 拆 sourceId 拿 slug + ptLaunchDate
  //    slug 可含 "-" 但不含 ":"，date 是 "YYYY-MM-DD" → 用最后一个 ":" 作分隔
  const lastColon = sourceId.lastIndexOf(':');
  if (lastColon < 1 || lastColon === sourceId.length - 1) {
    return { refreshed: false, reason: 'invalid_source_id' };
  }
  const slug = sourceId.slice(0, lastColon);
  const ptLaunchDate = sourceId.slice(lastColon + 1);

  // 2. PH GraphQL by slug
  // PhRefreshEnv 是 Env 的 structural subset（DB/AUTH_KV/PH_CLIENT_*），
  // fetchPhPostDetailBySlug + 链路上的 phGraphQL/getPhAccessToken 实际只用到这几个字段。
  // widening cast 在 runtime 安全；type system 缺乏精度因为现有 PH 函数签名都用 Env。
  let post: PhPostDetail | null;
  try {
    post = await fetchPhPostDetailBySlug(env as unknown as Env, slug);
  } catch (e) {
    console.error(`[ph-refresh] fetch error for slug=${slug}:`, e);
    return { refreshed: false, reason: 'fetch_failed' };
  }
  if (!post) {
    return { refreshed: false, reason: 'not_found' };
  }

  // 3. 复用 transform 拿新 metrics + extra（含 makers/comments/maker_post 全套）
  const fresh = transformPostToIngestItem(post, ptLaunchDate);
  const newMetrics = JSON.parse(fresh.metrics as string) as Record<string, number>;
  const freshExtra = JSON.parse(fresh.extra as string) as Record<string, unknown>;

  // 4. 读旧 extra，merge：fresh 覆盖大部分，enrich-only 字段保留旧值
  const row = await env.DB.prepare(
    `SELECT extra FROM items WHERE id = ?`,
  ).bind(itemId).first<{ extra: string | null }>();
  let oldExtra: Record<string, unknown> = {};
  if (row?.extra) {
    try {
      const parsed = JSON.parse(row.extra);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        oldExtra = parsed as Record<string, unknown>;
      }
    } catch { /* ignore — treat as empty */ }
  }
  // 2026-05-21 fix:用统一 merge helper 保留 enrichment + comment 元素级 translated。
  // 之前只保 6 个 root 字段,top_comments 数组被新 fetch 整组替换 → translated 全 wipe。
  // user 反馈 FE drawer 打开后 "zh→en flip 1s" 的根因。
  const mergedExtra = mergePhExtraPreservingEnrichment(oldExtra, freshExtra);

  // 5. UPDATE items + append metrics_snapshots_ph（atomic batch）
  const capturedAt = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE items SET metrics = ?, extra = ? WHERE id = ?`,
    ).bind(JSON.stringify(newMetrics), JSON.stringify(mergedExtra), itemId),
    env.DB.prepare(
      `INSERT INTO metrics_snapshots_ph
         (item_id, captured_at, launch_date_pt,
          votes, comments_count, reviews_count, reviews_avg, followers, daily_rank)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      itemId,
      capturedAt,
      ptLaunchDate,
      newMetrics.votes ?? null,
      newMetrics.comments ?? null,
      newMetrics.reviews_count ?? null,
      newMetrics.reviews_avg ?? null,
      null, // followers — API 不暴露
      (freshExtra.daily_rank as number | null) ?? null,
    ),
  ]);

  return { refreshed: true, reason: 'success', metrics: newMetrics };
}

// ─── Orchestrator ──────────────────────────────────────────────

export interface PhDailyFetchResult {
  mode: 'ph-daily-fetch';
  pt_date: string;
  skipped?: 'sentinel' | 'no_credentials' | 'list_empty';
  list_size?: number;
  fetched?: number;
  ingested?: { inserted: number; updated: number; errors: number };
  duration_ms: number;
  error?: string;
}

/**
 * 合并新 ingest 的 extra 与 D1 现存 extra,防 daily re-fetch 覆盖 enrichment 字段。
 *
 * 策略:
 * - 老 extra 字段全保留(spread base)
 * - 新 ingest 字段覆盖同名字段(新 wins),但 null 不覆盖老的非 null(避免新写的占位 null 擦掉)
 * - top_comments 元素级合并:按 text 匹配,新数组里每条 comment 若 .text 在老 comment 中
 *   找到,且老 comment 有 translated → 把 translated 复制到新 comment
 * - 同样的 maker_post.text → maker_post_translated 在 root 不在 maker_post 对象里,
 *   靠新数据不写 maker_post_translated + 老 extra 保留 自然 work
 */
async function mergePhItemsWithExisting(
  env: Env,
  items: ItemInput[],
): Promise<ItemInput[]> {
  if (items.length === 0) return items;
  const ids = items.map((i) => `${i.source_type}:${i.source_id}`);
  const placeholders = ids.map(() => '?').join(',');
  const existing = await env.DB.prepare(
    `SELECT id, extra FROM items WHERE id IN (${placeholders})`,
  ).bind(...ids).all<{ id: string; extra: string | null }>();

  const oldExtraById = new Map<string, Record<string, unknown>>();
  for (const r of existing.results) {
    if (r.extra) {
      try { oldExtraById.set(r.id, JSON.parse(r.extra) as Record<string, unknown>); } catch { /* ignore */ }
    }
  }

  return items.map((item) => {
    const id = `${item.source_type}:${item.source_id}`;
    const oldExtra = oldExtraById.get(id);
    if (!oldExtra) return item; // 新 item,无需合并

    const newExtra = typeof item.extra === 'string'
      ? (JSON.parse(item.extra) as Record<string, unknown>)
      : ((item.extra as Record<string, unknown> | null) ?? {});

    const merged = mergePhExtraPreservingEnrichment(oldExtra, newExtra);
    return { ...item, extra: JSON.stringify(merged) };
  });
}

export async function runPhDailyFetch(
  env: Env,
  opts: { force?: boolean; ptDate?: string } = {},
): Promise<PhDailyFetchResult> {
  const t0 = Date.now();
  const ptDate = opts.ptDate ?? ptYesterday();
  const sentinelKey = `${SENTINEL_KEY_PREFIX}${ptDate}`;

  if (!opts.force) {
    const exists = await env.AUTH_KV.get(sentinelKey);
    if (exists) {
      return {
        mode: 'ph-daily-fetch',
        pt_date: ptDate,
        skipped: 'sentinel',
        duration_ms: Date.now() - t0,
      };
    }
  }

  if (!env.PH_CLIENT_ID || !env.PH_CLIENT_SECRET) {
    return {
      mode: 'ph-daily-fetch',
      pt_date: ptDate,
      skipped: 'no_credentials',
      duration_ms: Date.now() - t0,
    };
  }

  // 1. List query
  const listNodes = await listPhDailyPosts(env, ptDate);
  if (listNodes.length === 0) {
    console.warn(`[ph] list query returned 0 posts for PT ${ptDate}`);
    return {
      mode: 'ph-daily-fetch',
      pt_date: ptDate,
      skipped: 'list_empty',
      duration_ms: Date.now() - t0,
    };
  }
  console.log(`[ph] list query: ${listNodes.length} posts for PT ${ptDate}`);

  // 2. Per-post detail — Promise.all 并行 50 query
  //    串行版 50×~1s=50s 超 CF HTTP 30s timeout，admin endpoint 跑不完。
  //    并行后 wall clock ~3-5s（瓶颈最慢一条）。subrequest 50+1+2=53 << 1000 cap。
  //    PH rate limit 6250 complexity / 15min，单次 ~2500 points 在配额内。
  const items: ItemInput[] = [];
  let fetchedOk = 0;
  const detailResults = await Promise.all(
    listNodes.map((node) => fetchPhPostDetail(env, node.id)),
  );
  for (let i = 0; i < listNodes.length; i++) {
    const detail = detailResults[i];
    if (!detail) {
      console.warn(`[ph] detail fetch failed for ${listNodes[i].slug} (${listNodes[i].id})`);
      continue;
    }
    fetchedOk++;
    items.push(transformPostToIngestItem(detail, ptDate));
  }

  // 3. Inline translate tagline + maker_post_text (短文本，60s 内完成 50 条 batch)
  //    评论/long content 留 fill-translations cron 后台慢慢翻
  await translatePhItemsInline(env, items);

  // 4. Merge with existing extra(防 daily re-fetch 覆盖 enrichment 字段)
  //    根因:ingestItems UPSERT 用 excluded.extra 整体覆盖老 extra(只保 longform/enriched_at
  //    两个 X-only 字段),PH 每天再抓时 r2_migrated_at / ai_summary / classified_at /
  //    maker_post_translated / top_comments[].translated 全被 wipe(staging prod 反复观察)。
  //    app-level 合并:保留老 enrichment + 新 ingest 字段 + comment 元素级保留 translated。
  const mergedItems = await mergePhItemsWithExisting(env, items);

  // 5. Ingest via internal function call
  const ingestResult = await ingestItems(env, mergedItems);
  console.log(
    `[ph] ingestItems: inserted=${ingestResult.inserted} updated=${ingestResult.updated} errors=${ingestResult.errors.length}`,
  );

  // 阶段 6 cutover: 对每条新 post (is_relevant=NULL) 触发 PH workflow
  if (env.PH_PIPELINE_WORKFLOW) {
    const sourceIds = items.map((i) => i.source_id);
    if (sourceIds.length > 0) {
      const placeholders = sourceIds.map(() => '?').join(',');
      const needsWorkflow = await env.DB.prepare(
        `SELECT id FROM items
          WHERE source_type='product_hunt'
            AND source_id IN (${placeholders})
            AND is_relevant IS NULL`,
      ).bind(...sourceIds).all<{ id: string }>();
      let triggered = 0;
      for (const r of needsWorkflow.results) {
        const res = await triggerPhWorkflowForItem(env, r.id);
        if (res === 'triggered') triggered++;
      }
      console.log(`[ph] workflows_triggered=${triggered}/${needsWorkflow.results.length}`);
    }
  }

  // 4. Append metrics_snapshots_ph
  await appendMetricsSnapshots(env, items, ptDate);

  // 5. KV sentinel
  await env.AUTH_KV.put(sentinelKey, '1', { expirationTtl: SENTINEL_TTL });

  return {
    mode: 'ph-daily-fetch',
    pt_date: ptDate,
    list_size: listNodes.length,
    fetched: fetchedOk,
    ingested: {
      inserted: ingestResult.inserted,
      updated: ingestResult.updated,
      errors: ingestResult.errors.length,
    },
    duration_ms: Date.now() - t0,
  };
}

async function appendMetricsSnapshots(
  env: Env,
  items: ItemInput[],
  ptDate: string,
): Promise<void> {
  // Schema (worker/migrations/008-metrics-snapshots-ph.sql):
  //   id, item_id, captured_at, launch_date_pt,
  //   votes, comments_count, reviews_count, reviews_avg, followers, daily_rank
  // followers not exposed by API — always null.
  const stmts: D1PreparedStatement[] = [];
  const capturedAt = Math.floor(Date.now() / 1000);
  for (const item of items) {
    const id = `product_hunt:${item.source_id}`;
    const m = item.metrics as string;
    let parsed: { votes?: number; comments?: number; reviews_count?: number; reviews_avg?: number };
    try {
      parsed = JSON.parse(m);
    } catch {
      continue;
    }
    let dailyRank: number | null = null;
    try {
      const ex = JSON.parse(item.extra as string) as { daily_rank?: number | null };
      dailyRank = ex?.daily_rank ?? null;
    } catch { /* noop */ }
    stmts.push(
      env.DB.prepare(
        `INSERT INTO metrics_snapshots_ph (item_id, captured_at, launch_date_pt,
                                           votes, comments_count, reviews_count, reviews_avg,
                                           followers, daily_rank)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        capturedAt,
        ptDate,
        parsed.votes ?? null,
        parsed.comments ?? null,
        parsed.reviews_count ?? null,
        parsed.reviews_avg ?? null,
        null, // followers — API doesn't expose
        dailyRank,
      ),
    );
  }
  if (stmts.length > 0) {
    try {
      await env.DB.batch(stmts);
    } catch (e) {
      console.error('[ph] metrics_snapshots_ph insert error:', e);
    }
  }
}

// ─── Inline DeepSeek translation (tagline + maker_post) ────────
//
// Fetch 阶段同步翻译核心两个字段（卡片 tagline + 抽屉 maker_post），原文+译文一起入库。
// 用户感知中文延迟从 5-30min（fill-translations cron 后台接力）降到秒级。
// 评论文本仍走 fill-translations 后台（评论是抽屉打开才看，可异步）。
//
// 复用 fill-translations 那套 sanity check 风格但简化（PH 全英文 + 短文本，
// sanity 误判率低）。batch_size=20，50 条 × 2 字段 ≈ 5 个 LLM call ≈ 15-25s wall clock。

// DS_URL_TR / DS_MODEL_TR / NL_MARK_TR / cjkRatioPh / isLikelyChinesePh / PH_TRANSLATE_PROMPT /
// translatePhBatchChunk / translatePhBatch 已抽到 ./ph-translate（上方 import）。

interface PhTranslateTask {
  itemIdx: number;
  field: 'content' | 'maker_post';
  text: string;
}

/**
 * 批量翻译 items[].content (tagline) + extra.maker_post_text，
 * 直接 mutate items 写入 content_translated + extra.maker_post_translated。
 * 静默失败：DeepSeek 挂了/缺 key，items 保持原样（fill-translations cron 兜底）。
 */
async function translatePhItemsInline(env: Env, items: ItemInput[]): Promise<void> {
  if (!env.DEEPSEEK_API_KEY) {
    console.log('[ph] inline translate skipped — no DEEPSEEK_API_KEY');
    return;
  }

  const tasks: PhTranslateTask[] = [];
  // 同步 parse extra 一次，避免重复 JSON.parse
  const extras = items.map((item) => {
    try {
      return JSON.parse(item.extra as string) as Record<string, unknown>;
    } catch {
      return {} as Record<string, unknown>;
    }
  });

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const extra = extras[i];
    // tagline (item.content)
    if (item.content && !isLikelyChinesePh(item.content)) {
      tasks.push({ itemIdx: i, field: 'content', text: item.content });
    }
    // maker_post_text (extra.maker_post_text)
    const mpText = extra.maker_post_text as string | undefined;
    if (mpText && !isLikelyChinesePh(mpText)) {
      tasks.push({ itemIdx: i, field: 'maker_post', text: mpText });
    }
  }

  if (tasks.length === 0) {
    console.log('[ph] inline translate: 0 tasks (all already zh or empty)');
    return;
  }

  console.log(`[ph] inline translate: ${tasks.length} tasks across ${items.length} items`);
  const t0 = Date.now();

  // batch_size 20，50 items × 2 fields ≈ 100 tasks ÷ 20 = 5 LLM calls
  const BATCH = 20;
  let translated = 0;
  for (let start = 0; start < tasks.length; start += BATCH) {
    const batch = tasks.slice(start, start + BATCH);
    const result = await translatePhBatch(env.DEEPSEEK_API_KEY, batch.map((t) => t.text));
    for (let j = 0; j < batch.length; j++) {
      const tr = result.get(j);
      if (!tr) continue;
      const task = batch[j];
      const item = items[task.itemIdx];
      if (task.field === 'content') {
        item.content_translated = tr;
      } else {
        // maker_post_translated 写回 extra
        const extra = extras[task.itemIdx];
        extra.maker_post_translated = tr;
        item.extra = JSON.stringify(extra);
      }
      translated++;
    }
  }
  console.log(`[ph] inline translate done: ${translated}/${tasks.length} in ${Date.now() - t0}ms`);
}

// ═══════════════════════════════════════════════════════════════════════════
//
// 阶段 6 PH workflow 单 itemId 函数 (STUB — 实施 turn 2 填充真实 body)
//
// 设计：docs/plans/2026-05-16-ph-clawhub-workflow-design.md
//
// ═══════════════════════════════════════════════════════════════════════════

export async function classifyPhItemWithLlm(
  env: Env,
  itemId: string,
): Promise<{ is_relevant: 0 | 1 }> {
  if (!env.DEEPSEEK_API_KEY) {
    throw new Error('classifyPhItemWithLlm: DEEPSEEK_API_KEY missing');
  }

  const row = await env.DB.prepare(
    `SELECT id, source_id, title, content, extra
       FROM items
      WHERE id = ? AND source_type = 'product_hunt'`,
  ).bind(itemId).first<{
    id: string; source_id: string; title: string | null;
    content: string | null; extra: string | null;
  }>();
  if (!row) throw new Error(`classifyPhItemWithLlm: item not found ${itemId}`);

  let extra: { description?: string; topics?: string[] } = {};
  try {
    const p = JSON.parse(row.extra || '{}');
    if (p && typeof p === 'object') extra = p;
  } catch { /* noop */ }

  const input = [{
    idx: 0,
    name: row.title || '',
    tagline: row.content || '',
    description: (extra.description || '').slice(0, 400),
    topics: (extra.topics || []).slice(0, 5),
  }];
  const prompt = PH_ENRICH_PROMPT.replace('%INPUT%', JSON.stringify(input));

  const res = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      response_format: { type: 'json_object' },
      max_tokens: 500,
    }),
  });
  if (!res.ok) throw new Error(`classifyPhItemWithLlm: HTTP ${res.status} for ${itemId}`);
  const body = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  const raw = body.choices?.[0]?.message?.content || '';
  let parsed: { items?: Array<{ idx: number; is_relevant: 0 | 1; ai_category?: string; ai_summary?: string }> };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`classifyPhItemWithLlm: JSON parse failed for ${itemId}`);
  }
  const item = (parsed.items || [])[0];
  if (!item) throw new Error(`classifyPhItemWithLlm: empty items for ${itemId}`);

  const isRel = item.is_relevant === 1 ? 1 : 0;
  const cat = isRel ? (item.ai_category || 'ai_other') : null;
  const summary = isRel ? (item.ai_summary || '').trim() : '';

  await env.DB.prepare(
    `UPDATE items
        SET is_relevant = ?,
            matched_by = COALESCE(matched_by, 'ph-workflow'),
            extra = json_set(coalesce(extra, '{}'),
                             '$.ai_category', ?,
                             '$.ai_summary', ?,
                             '$.classified_at', ?)
      WHERE id = ?`,
  ).bind(isRel, cat, summary, new Date().toISOString(), itemId).run();

  console.log(`[ph-workflow:step1] ${itemId}: is_relevant=${isRel} cat=${cat}`);
  return { is_relevant: isRel };
}

// r2MigratePhItemById 移到 ph-r2.ts (跟 runPhR2Migrate 同文件共享 helpers)
// workflow class import 从 '../ph-r2' 而不是 '../scrapers/ph'

/**
 * Workflow Step 3: 翻译 tagline (item.content) + maker_post (extra.maker_post_text)
 * + top_comments[].text (extra.top_comments[i].text)，写回 content_translated +
 * extra.maker_post_translated + extra.top_comments[i].translated。
 *
 * task #8: 写 translated_at 给 C 端「N 条新译文」横条用
 */
export async function translatePhFieldsForItem(
  env: Env,
  itemId: string,
): Promise<{ fields_translated: number }> {
  if (!env.DEEPSEEK_API_KEY) {
    throw new Error('translatePhFieldsForItem: DEEPSEEK_API_KEY missing');
  }

  const row = await env.DB.prepare(
    `SELECT id, content, content_translated, extra FROM items
      WHERE id = ? AND source_type='product_hunt'`,
  ).bind(itemId).first<{
    id: string; content: string | null;
    content_translated: string | null; extra: string | null;
  }>();
  if (!row) throw new Error(`translatePhFieldsForItem: item not found ${itemId}`);

  const extra = row.extra ? JSON.parse(row.extra) as Record<string, unknown> : {};

  // 收集需要翻译的 task（field 名 + text）
  type Task = { field: 'content' | 'maker_post' | string; text: string; commentIdx?: number };
  const tasks: Task[] = [];

  // tagline
  if (row.content && !row.content_translated && !isLikelyChinesePh(row.content)) {
    tasks.push({ field: 'content', text: row.content });
  }
  // maker_post
  const mpText = extra.maker_post_text as string | undefined;
  const mpTranslated = extra.maker_post_translated as string | undefined;
  if (mpText && !mpTranslated && !isLikelyChinesePh(mpText)) {
    tasks.push({ field: 'maker_post', text: mpText });
  }
  // top_comments[]
  const topComments = extra.top_comments as Array<{ text?: string; translated?: string }> | undefined;
  if (Array.isArray(topComments)) {
    topComments.forEach((c, idx) => {
      if (c?.text && !c.translated && !isLikelyChinesePh(c.text)) {
        tasks.push({ field: 'top_comment', text: c.text, commentIdx: idx });
      }
    });
  }
  // description（Task 3，2026-07-06）：产品英文长描述 → extra.description_zh，供 daily 页 SEO 用。
  // 幂等：已有 description_zh 不重译；空/已是中文 → 跳过。
  const descText = extra.description as string | undefined;
  const descZh = extra.description_zh as string | undefined;
  if (descText && !descZh && !isLikelyChinesePh(descText)) {
    tasks.push({ field: 'description', text: descText });
  }

  if (tasks.length === 0) {
    console.log(`[ph-workflow:step3] ${itemId}: 0 tasks (all already translated)`);
    return { fields_translated: 0 };
  }

  const result = await translatePhBatch(env.DEEPSEEK_API_KEY, tasks.map((t) => t.text));
  let translated = 0;
  let contentTranslated: string | null = null;
  for (let i = 0; i < tasks.length; i++) {
    const tr = result.get(i);
    if (!tr) continue;
    const task = tasks[i];
    if (task.field === 'content') {
      contentTranslated = tr;
    } else if (task.field === 'maker_post') {
      extra.maker_post_translated = tr;
    } else if (task.field === 'top_comment' && task.commentIdx !== undefined) {
      const arr = (extra.top_comments as Array<{ text?: string; translated?: string }>);
      arr[task.commentIdx] = { ...arr[task.commentIdx], translated: tr };
    } else if (task.field === 'description') {
      extra.description_zh = tr;
    }
    translated++;
  }

  // 写回 D1: content_translated 列（task #8 同步设 translated_at）+ extra
  const nowTs = Math.floor(Date.now() / 1000);
  if (contentTranslated) {
    await env.DB.prepare(
      `UPDATE items
          SET content_translated = ?,
              translated_at = ?,
              extra = ?
        WHERE id = ?`,
    ).bind(contentTranslated, nowTs, JSON.stringify(extra), itemId).run();
  } else {
    await env.DB.prepare(
      `UPDATE items SET extra = ? WHERE id = ?`,
    ).bind(JSON.stringify(extra), itemId).run();
  }

  console.log(`[ph-workflow:step3] ${itemId}: translated ${translated}/${tasks.length} fields`);
  return { fields_translated: translated };
}

/**
 * PH 评论翻译 backfill (2026-05-21):一次性扫存量 PH items 哪些
 * top_comments[i].text 是英文但没有 translated → 重跑 translatePhFieldsForItem。
 *
 * 根因:老版 translatePhBatch 一次发 10+ task 用 max_tokens=4000,中文输出撞
 * token 上限 → 尾部 comments 被截断 → 永远 null。新版拆 chunk 5/批 + 8000 tokens。
 */
export async function runBackfillPhCommentsTranslation(
  env: Env,
  limit: number,
  rateSleepMs: number = 200,
): Promise<{
  scanned: number;
  processed: number;
  total_translated: number;
  errors: Array<{ id: string; reason: string }>;
  remaining: number;
}> {
  // 找 top_comments 里有 text 非中文但 translated=null 的 item
  // 用 EXISTS sub-query 检查至少一条 comment 缺翻译
  const HAS_UNTRANS_COMMENT = `EXISTS (
    SELECT 1 FROM json_each(json_extract(extra, '$.top_comments')) AS c
    WHERE json_extract(c.value, '$.text') IS NOT NULL
      AND json_extract(c.value, '$.translated') IS NULL
  )`;

  const candidates = await env.DB.prepare(
    `SELECT id FROM items
      WHERE source_type='product_hunt'
        AND is_relevant=1
        AND ${HAS_UNTRANS_COMMENT}
      ORDER BY scraped_at DESC
      LIMIT ?`,
  ).bind(limit).all<{ id: string }>();

  const remainingRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM items
      WHERE source_type='product_hunt'
        AND is_relevant=1
        AND ${HAS_UNTRANS_COMMENT}`,
  ).first<{ n: number }>();

  let processed = 0;
  let totalTranslated = 0;
  const errors: Array<{ id: string; reason: string }> = [];

  for (const c of candidates.results) {
    processed++;
    try {
      const r = await translatePhFieldsForItem(env, c.id);
      totalTranslated += r.fields_translated;
    } catch (e) {
      errors.push({ id: c.id, reason: String(e).slice(0, 200) });
    }
    if (rateSleepMs > 0 && processed < candidates.results.length) {
      await new Promise((r) => setTimeout(r, rateSleepMs));
    }
  }

  return {
    scanned: candidates.results.length,
    processed,
    total_translated: totalTranslated,
    errors: errors.slice(0, 20),
    remaining: (remainingRow?.n || 0) - processed,
  };
}

/**
 * 治本幂等：写 marker + create PH workflow instance。
 * 调用方：drain endpoint + Phase 1 runPhDailyFetch + drawer refreshSingleItem。
 */
export async function triggerPhWorkflowForItem(
  env: { DB: D1Database; PH_PIPELINE_WORKFLOW?: Workflow },
  itemId: string,
): Promise<'triggered' | 'already_exists' | 'binding_missing' | 'failed'> {
  if (!env.PH_PIPELINE_WORKFLOW) return 'binding_missing';
  const nowUnix = Math.floor(Date.now() / 1000);
  try {
    await env.DB.prepare(
      `UPDATE items SET extra = json_set(coalesce(extra, '{}'), '$.workflow_triggered_at', ?) WHERE id = ?`,
    ).bind(nowUnix, itemId).run();
  } catch (e) {
    console.error(`[ph-trigger] mark failed for ${itemId}:`, e);
  }
  // 2026-05-17 fix workflow instance reuse:hour-bucket suffix
  const hourBucket = new Date().toISOString().slice(0, 13).replace('T', '-');
  const instanceId = `ph-${itemId.replace(/[^a-zA-Z0-9-]/g, '-')}-${hourBucket}`;
  try {
    await env.PH_PIPELINE_WORKFLOW.create({ id: instanceId, params: { itemId } });
    return 'triggered';
  } catch (e) {
    if (String(e).toLowerCase().includes('already exists')) return 'already_exists';
    console.error(`[ph-trigger] create failed for ${itemId}:`, e);
    return 'failed';
  }
}
