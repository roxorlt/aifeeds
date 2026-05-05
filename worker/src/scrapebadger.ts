// ScrapeBadger Twitter API 接入。
// 目的：替代 cdn.syndication.twimg.com 的 refresh-metrics 路径，拿回 syndication
// 不再返回的 retweet_count + view_count（外加全套 favorite/reply/quote/bookmark）。
//
// API base: https://scrapebadger.com/v1
// Auth: x-api-key header
// Pricing: ~1 credit base + 1 per tweet（5 IDs/call 实测扣 6 credits）
// Rate limit: 5 requests/min（响应头 x-ratelimit-{limit,remaining,reset}）
// 响应延迟：3-7s/call（JS 渲染走反爬），所以 cron 每个 tick 只发 1 个 batch 不会撞 30s 上限

import type { Metrics } from './enrich';

const SB_BASE = 'https://scrapebadger.com/v1';
const SB_BATCH_PATH = '/twitter/tweets/'; // GET ?tweets=id1,id2,...

export interface ScrapeBadgerEnv {
  SCRAPEBADGER_API_KEY?: string;
}

interface ScrapeBadgerTweet {
  id: string;
  text?: string;
  full_text?: string;
  favorite_count?: number;
  retweet_count?: number;
  reply_count?: number;
  quote_count?: number;
  view_count?: string | number | null;
  bookmark_count?: number | null;
  quoted_status_id?: string | null;
  retweeted_status_id?: string | null;
  in_reply_to_status_id?: string | null;
}

interface ScrapeBadgerBatchResponse {
  data?: ScrapeBadgerTweet[];
}

export interface ScrapeBadgerBatchResult {
  // 命中的：tweet_id → 解析好的 metrics
  metrics: Map<string, Metrics>;
  // 漏的：API 没返回（已删除 / 私密 / 配额炸）
  missing: string[];
  // API 元数据（用于 cron log + 配额监控）
  creditsUsed?: number;
  rateLimitRemaining?: number;
  durationMs?: number;
  error?: 'no_key' | 'rate_limit' | 'no_credits' | 'http_error' | 'fetch_failed';
  status?: number;
}

function parseIntStrict(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  return Number.isFinite(n) ? n : undefined;
}

function tweetToMetrics(t: ScrapeBadgerTweet): Metrics {
  return {
    replies: parseIntStrict(t.reply_count),
    retweets: parseIntStrict(t.retweet_count),
    likes: parseIntStrict(t.favorite_count),
    bookmarks: parseIntStrict(t.bookmark_count),
    views: parseIntStrict(t.view_count), // view_count 是字符串如 "7344"
  };
}

/**
 * 批量拉 tweets。`ids` 上限按 ScrapeBadger 文档没明说，实测 5 OK；保守 50/批。
 * 调用方负责按 cron tick 节流（rate limit 5/min）。
 */
export async function fetchTweetsScrapeBadger(
  env: ScrapeBadgerEnv,
  ids: string[],
): Promise<ScrapeBadgerBatchResult> {
  if (!env.SCRAPEBADGER_API_KEY) {
    return { metrics: new Map(), missing: ids, error: 'no_key' };
  }
  if (ids.length === 0) {
    return { metrics: new Map(), missing: [] };
  }
  const url = `${SB_BASE}${SB_BATCH_PATH}?tweets=${ids.join(',')}`;
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        'x-api-key': env.SCRAPEBADGER_API_KEY,
        Accept: 'application/json',
      },
    });
  } catch (e) {
    console.error('[scrapebadger] fetch error:', e);
    return {
      metrics: new Map(),
      missing: ids,
      error: 'fetch_failed',
      durationMs: Date.now() - t0,
    };
  }

  const durationMs = Date.now() - t0;
  const creditsUsed = Number(res.headers.get('x-credits-used')) || undefined;
  const rateLimitRemaining =
    Number(res.headers.get('x-ratelimit-remaining')) || undefined;

  if (res.status === 402) {
    console.warn('[scrapebadger] 402 no credits');
    return {
      metrics: new Map(),
      missing: ids,
      error: 'no_credits',
      status: 402,
      creditsUsed,
      rateLimitRemaining,
      durationMs,
    };
  }
  if (res.status === 429) {
    console.warn('[scrapebadger] 429 rate limit; remaining', rateLimitRemaining);
    return {
      metrics: new Map(),
      missing: ids,
      error: 'rate_limit',
      status: 429,
      creditsUsed,
      rateLimitRemaining,
      durationMs,
    };
  }
  if (!res.ok) {
    console.warn(`[scrapebadger] HTTP ${res.status}`);
    return {
      metrics: new Map(),
      missing: ids,
      error: 'http_error',
      status: res.status,
      creditsUsed,
      rateLimitRemaining,
      durationMs,
    };
  }

  let body: ScrapeBadgerBatchResponse;
  try {
    body = (await res.json()) as ScrapeBadgerBatchResponse;
  } catch (e) {
    console.error('[scrapebadger] json parse:', e);
    return {
      metrics: new Map(),
      missing: ids,
      error: 'http_error',
      status: res.status,
      creditsUsed,
      rateLimitRemaining,
      durationMs,
    };
  }

  const metrics = new Map<string, Metrics>();
  for (const t of body.data || []) {
    if (t.id) metrics.set(t.id, tweetToMetrics(t));
  }
  const missing = ids.filter((id) => !metrics.has(id));
  return {
    metrics,
    missing,
    creditsUsed,
    rateLimitRemaining,
    durationMs,
  };
}
