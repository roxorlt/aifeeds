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
  const mergedExtra: Record<string, unknown> = { ...freshExtra };
  for (const k of ENRICH_ONLY_EXTRA_KEYS) {
    if (oldExtra[k] !== undefined) mergedExtra[k] = oldExtra[k];
  }

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

  // 4. Ingest via internal function call
  const ingestResult = await ingestItems(env, items);
  console.log(
    `[ph] ingestItems: inserted=${ingestResult.inserted} updated=${ingestResult.updated} errors=${ingestResult.errors.length}`,
  );

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

const DS_URL_TR = 'https://api.deepseek.com/v1/chat/completions';
const DS_MODEL_TR = 'deepseek-chat';
const NL_MARK_TR = '⟪NL⟫';

function cjkRatioPh(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let total = 0;
  for (const c of text) {
    if (/\s/.test(c)) continue;
    total++;
    const code = c.charCodeAt(0);
    if (code >= 0x4e00 && code <= 0x9fff) cjk++;
  }
  return total === 0 ? 0 : cjk / total;
}

function isLikelyChinesePh(text: string): boolean {
  return !!text && cjkRatioPh(text) > 0.3;
}

interface PhTranslateTask {
  itemIdx: number;
  field: 'content' | 'maker_post';
  text: string;
}

const PH_TRANSLATE_PROMPT = `把下面每条 Product Hunt 产品文案或开发者帖文翻译成自然中文。

规则：
- 专有名词、人名、品牌名、产品名、模型名（GPT-4 / Claude / Cursor 等）保留英文
- 技术术语保留英文：fork / branch / merge / commit / PR / repo / push / pretrain / RLHF / prompt / embedding / RAG / LLM / API / SDK / CLI / IDE / CI/CD / OSS / MCP
- 'agent' → '智能体'（不是'代理'）
- 'token' → 'token'（不是'令牌'）
- 'fine-tune' → '微调'
- 代码/命令/URL/@handle 原样保留
- 输出自然口语化中文，避免直译腔
- 保留 ${NL_MARK_TR} 标记（代表换行）

每行格式：index:translated_text
不要加任何额外文字。

输入：
%INPUT%

输出：`;

async function translatePhBatch(
  apiKey: string,
  texts: string[],
): Promise<Map<number, string>> {
  const numbered = texts
    .map((t, i) => `${i}:${t.replace(/\r\n/g, '\n').replace(/\n/g, NL_MARK_TR)}`)
    .join('\n');
  const prompt = PH_TRANSLATE_PROMPT.replace('%INPUT%', numbered);

  const out = new Map<number, string>();
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45000);
    const resp = await fetch(DS_URL_TR, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: DS_MODEL_TR,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 4000,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!resp.ok) {
      console.warn(`[ph] inline translate HTTP ${resp.status}`);
      return out;
    }
    const body = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = body.choices?.[0]?.message?.content || '';
    for (const line of text.split('\n')) {
      const m = line.match(/^(\d+):(.*)$/);
      if (!m) continue;
      const idx = parseInt(m[1], 10);
      const tr = m[2].replace(new RegExp(NL_MARK_TR, 'g'), '\n').trim();
      if (tr) out.set(idx, tr);
    }
  } catch (e) {
    console.warn('[ph] inline translate error:', e instanceof Error ? e.message : String(e));
  }
  return out;
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
