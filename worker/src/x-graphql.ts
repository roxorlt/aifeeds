// X (Twitter) authenticated GraphQL client.
// Used to fetch fields that public syndication API does not expose,
// most importantly `article.plain_text` (article body 全文,登录后才返).
//
// 设计:
// - Cookie 存 AUTH_KV (key=X_COOKIE_BLOB),admin endpoint 可热更
// - bearer 是 X web bundle 公开常量,跟 react-tweet 同款
// - csrf token = ct0 cookie value (X 客户端约定 cookie 值跟 x-csrf-token header 必须一致)
// - 失败模式:
//   401/403 → CookieInvalidError,caller 应标 fetch_failed_at + 触发 PushDeer
//   429     → RateLimitError,caller 应中断 backfill 等次日 cron
//   404     → TweetNotFoundError,caller 标 fetch_failed_reason='tweet_404'
//
// 风控:本 module 不直接 sleep — caller 在 batch 循环里加 jitter。
// 这是因为 cron / workflow 上下文不同,统一在 caller 控更灵活。

import { pushDeerAlert } from './notifier';
import type { Env as IndexEnv } from './index';

export const X_COOKIE_KV_KEY = 'X_COOKIE_BLOB';

// X web bundle 公开 bearer (大家爬虫都用同一个,X 没换过)
const WEB_BEARER =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

// GraphQL query ids (从 X web bundle main.js 抓出,2026-05-22 spike 时确认)
const Q_TWEET_RESULT_BY_REST_ID = 'SgZWKwvBiOKrSC0QeOGvXw';

const FEATURES_TWEET_RESULT = {
  creator_subscriptions_tweet_preview_api_enabled: true,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  articles_preview_enabled: true,
  tweetypie_unmention_optimization_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  rweb_video_timestamps_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_enhance_cards_enabled: false,
};

const FIELD_TOGGLES_ARTICLE = {
  withArticleRichContentState: true,
  withArticlePlainText: true,
  withGrokAnalyze: false,
  withDisallowedReplyControls: false,
};

export interface XCookieBlob {
  cookie_string: string;       // 完整 Cookie header 值
  ct0: string;                 // csrf token (从 cookie_string 提取出来,header 用)
  auth_token: string;          // login token (cookie_string 里也有,这里冗余存方便健康检查)
  updated_at: string;          // ISO timestamp,user 何时更新过
  invalid_at?: string;         // ISO timestamp,被检测失效的时间(401/403)
  invalid_reason?: string;     // 'http_401' | 'http_403' | 'no_article_in_response' | ...
}

export class CookieInvalidError extends Error {
  constructor(public status: number, public detail?: string) {
    super(`X cookie invalid (HTTP ${status}${detail ? ': ' + detail : ''})`);
    this.name = 'CookieInvalidError';
  }
}

export class CookieMissingError extends Error {
  constructor() {
    super('X cookie not configured in AUTH_KV');
    this.name = 'CookieMissingError';
  }
}

export class RateLimitError extends Error {
  constructor(public retryAfter?: number) {
    super(`X GraphQL rate limited${retryAfter ? ' (retry-after ' + retryAfter + 's)' : ''}`);
    this.name = 'RateLimitError';
  }
}

export class TweetNotFoundError extends Error {
  constructor(public tweetId: string) {
    super(`X tweet not found: ${tweetId}`);
    this.name = 'TweetNotFoundError';
  }
}

export interface XGraphqlEnv {
  AUTH_KV: KVNamespace;
  PUSHDEER_ADMIN_KEYS?: string;
}

// 从完整 cookie string 提取 ct0 / auth_token 值(用 ; 分割,trim,k=v split)
export function extractCookieValue(cookieString: string, name: string): string | null {
  const parts = cookieString.split(';').map((p) => p.trim());
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq) === name) {
      return part.slice(eq + 1);
    }
  }
  return null;
}

export async function getXCookie(env: XGraphqlEnv): Promise<XCookieBlob | null> {
  const raw = await env.AUTH_KV.get(X_COOKIE_KV_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as XCookieBlob;
  } catch {
    return null;
  }
}

export async function saveXCookie(
  env: XGraphqlEnv,
  blob: XCookieBlob,
): Promise<void> {
  await env.AUTH_KV.put(X_COOKIE_KV_KEY, JSON.stringify(blob));
}

// 标记 cookie 失效 + 推 PushDeer(异步,不阻塞 caller)
export async function markCookieInvalid(
  env: XGraphqlEnv,
  reason: string,
  ctx?: { waitUntil: (p: Promise<unknown>) => void },
): Promise<void> {
  const blob = await getXCookie(env);
  if (!blob) return;
  if (blob.invalid_at) return; // 已标过不重推
  blob.invalid_at = new Date().toISOString();
  blob.invalid_reason = reason;
  await saveXCookie(env, blob);
  const alert = pushDeerAlert(
    env as unknown as IndexEnv,
    'X Cookie 失效',
    `## X Cookie 失效\n\n- 失效原因: ${reason}\n- 失效时间: ${blob.invalid_at}\n- 请打开运维面板「X Cookie 更新」card,粘新 cookie 提交`,
  );
  if (ctx?.waitUntil) ctx.waitUntil(alert);
  else await alert;
}

// 主入口:拉单条 tweet 的 GraphQL 结果(含 article body)
// 成功返完整 article obj (含 plain_text);失败抛 typed error。
export async function fetchTweetResultByRestId(
  env: XGraphqlEnv,
  tweetId: string,
  ctx?: { waitUntil: (p: Promise<unknown>) => void },
): Promise<Record<string, unknown>> {
  const cookie = await getXCookie(env);
  if (!cookie) throw new CookieMissingError();
  if (cookie.invalid_at) {
    throw new CookieInvalidError(401, `previously marked invalid: ${cookie.invalid_reason || 'unknown'}`);
  }

  const variables = {
    tweetId,
    includePromotedContent: false,
    withCommunity: false,
    withVoice: false,
  };

  const url =
    `https://api.x.com/graphql/${Q_TWEET_RESULT_BY_REST_ID}/TweetResultByRestId` +
    `?variables=${encodeURIComponent(JSON.stringify(variables))}` +
    `&features=${encodeURIComponent(JSON.stringify(FEATURES_TWEET_RESULT))}` +
    `&fieldToggles=${encodeURIComponent(JSON.stringify(FIELD_TOGGLES_ARTICLE))}`;

  const resp = await fetch(url, {
    headers: {
      Cookie: cookie.cookie_string,
      Authorization: `Bearer ${WEB_BEARER}`,
      'x-csrf-token': cookie.ct0,
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-client-language': 'en',
      'x-twitter-active-user': 'yes',
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      Origin: 'https://x.com',
      Referer: 'https://x.com/',
    },
  });

  if (resp.status === 401 || resp.status === 403) {
    await markCookieInvalid(env, `http_${resp.status}`, ctx);
    throw new CookieInvalidError(resp.status);
  }
  if (resp.status === 429) {
    const ra = Number(resp.headers.get('Retry-After')) || undefined;
    throw new RateLimitError(ra);
  }
  if (resp.status === 404) {
    throw new TweetNotFoundError(tweetId);
  }
  if (!resp.ok) {
    throw new Error(`X GraphQL HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }

  const body = await resp.json<{ data?: { tweetResult?: { result?: Record<string, unknown> } } }>();
  const result = body.data?.tweetResult?.result;
  if (!result) throw new TweetNotFoundError(tweetId); // tweetResult={} = soft 404
  return result;
}

// 从 TweetResultByRestId result 中抽 article body + media。
// 返 null 表示该 tweet 不是 article tweet。
export interface XArticleBodyData {
  rest_id: string;
  title: string | null;
  plain_text: string | null;       // article 全文(X 已 reconstruct,直接用)
  preview_text: string | null;     // 123 字预览(跟 syndication preview_text 一样)
  cover_image_url: string | null;
  first_published_at_secs: number | null;
  media_entities: Array<Record<string, unknown>>;
}

export function extractArticleBodyFromTweet(
  tweetResult: Record<string, unknown>,
): XArticleBodyData | null {
  const articleWrap = tweetResult.article as Record<string, unknown> | undefined;
  const article = articleWrap?.article_results as { result?: Record<string, unknown> } | undefined;
  const a = article?.result;
  if (!a) return null;

  const coverMedia = a.cover_media as Record<string, unknown> | undefined;
  const mediaInfo = coverMedia?.media_info as Record<string, unknown> | undefined;
  const metadata = a.metadata as Record<string, unknown> | undefined;

  return {
    rest_id: (a.rest_id as string) || '',
    title: (a.title as string) || null,
    plain_text: (a.plain_text as string) || null,
    preview_text: (a.preview_text as string) || null,
    cover_image_url: (mediaInfo?.original_img_url as string) || null,
    first_published_at_secs:
      (metadata?.first_published_at_secs as number | undefined) ?? null,
    media_entities: (a.media_entities as Array<Record<string, unknown>>) || [],
  };
}

// ─── 风控: 日总量 cap ─────────────────────────────────────────────
// KV key X_GRAPHQL_DAY_COUNT_<YYYY-MM-DD> 记当日调用次数。
// caller 在 batch 前 check + 每次成功调用后 incr。

const DAILY_CAP_DEFAULT = 50;

export function todayUtcKey(): string {
  const d = new Date();
  return `X_GRAPHQL_DAY_COUNT_${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export async function getDailyCount(env: XGraphqlEnv): Promise<number> {
  const v = await env.AUTH_KV.get(todayUtcKey());
  return v ? Number(v) || 0 : 0;
}

export async function incrDailyCount(env: XGraphqlEnv): Promise<number> {
  const key = todayUtcKey();
  const cur = await getDailyCount(env);
  const next = cur + 1;
  // KV put: 48h TTL,过期自动清理(够覆盖 cron 跨日窗口)
  await env.AUTH_KV.put(key, String(next), { expirationTtl: 48 * 3600 });
  return next;
}

export function getDailyCap(env: XGraphqlEnv & { X_GRAPHQL_DAILY_CAP?: string }): number {
  return Number(env.X_GRAPHQL_DAILY_CAP) || DAILY_CAP_DEFAULT;
}
