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
const LIST_QUERY = `
  query PhDailyList($postedAfter: DateTime!, $postedBefore: DateTime!) {
    posts(
      postedAfter: $postedAfter,
      postedBefore: $postedBefore,
      featured: true,
      order: VOTES,
      first: 30
    ) {
      edges {
        node { id slug name votesCount featuredAt dailyRank }
      }
    }
  }
`;

const DETAIL_QUERY = `
  query PhPostDetail($id: ID!) {
    post(id: $id) {
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
  posts: { edges: Array<{ node: PhListNode }> };
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

  const data = await phGraphQL<ListQueryData>(env, LIST_QUERY, {
    postedAfter,
    postedBefore,
  });
  if (!data) return [];
  return data.posts.edges.map((e) => e.node);
}

export async function fetchPhPostDetail(
  env: Env,
  postId: string,
): Promise<PhPostDetail | null> {
  const data = await phGraphQL<DetailQueryData>(env, DETAIL_QUERY, { id: postId });
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
  text: string;
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

  // 2. Per-post detail (sequential — 30 small queries, ~30-60s total)
  const items: ItemInput[] = [];
  let fetchedOk = 0;
  for (const node of listNodes) {
    const detail = await fetchPhPostDetail(env, node.id);
    if (!detail) {
      console.warn(`[ph] detail fetch failed for ${node.slug} (${node.id})`);
      continue;
    }
    fetchedOk++;
    items.push(transformPostToIngestItem(detail, ptDate));
  }

  // 3. Ingest via internal function call
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
