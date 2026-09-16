/**
 * 补录线索的封面图：从 owner 提交的那条链接里取一张图，迁进 R2，写回 `extra.cover_image`。
 *
 * **为什么补录条目一直没有图**：三种准入（`owner_asserted_v1` / `owner_vouched_v1` /
 * `source_support_v1`）写 items 行时都不写 `media`，`extra` 里也没有 `cover_image`，
 * 于是日报视频、Codex 推送、静态日报页对补录条目一律无图。
 *
 * **只写站内 `/r/` 形态**：静态日报页（`daily-page.ts` 开 `newsCoverQualityGate`）只认站内
 * 图；出片机在大陆，外链多半下不来。所以这里一定要先迁 R2 再写库，迁不成就当没取到。
 *
 * **签名约束（本模块最重要的一条）**：`title` / `content` / `content_translated` / `author` /
 * `url` / `published_at` 这几列，以及 `extra.event_fingerprint`、`extra.manual_lead`、
 * `extra.manual_source_support` 被 HMAC 投影逐字覆盖，一个字都不能改。本模块只在**入池完成
 * 之后**用 `json_set` 往 `extra` 里加新键（`cover_image` / `cover_image_source` /
 * `cover_resolved_at` / 三个失败计数键），**绝不写 `media`**。
 *
 * 设计文档：`docs/plans/2026-09-16-manual-lead-cover-spec.md`
 */
import type { Env } from '../index';
import { metaContent } from '../feeds/extract';
import { FEED_R2_USER_AGENT, migrateFeedCover } from '../feeds/media-r2';
import { COVER_BLACKLIST } from '../feeds/cover-heuristics';
import {
  fetchTweetEvidence,
  parseTwitterStatusUrl,
  validatePublicHttpUrl,
  type TrustedResearchService,
} from '../security/safe-url-fetch';

/** 取图从哪儿来的，写进 `extra.cover_image_source`，出问题时按它分布决定下一步改哪条路。 */
export type ManualLeadCoverSource = 'tweet' | 'og' | 'twitter' | 'wechat' | 'body';

export interface ManualLeadCoverResolution {
  /** 迁进 R2 之后的站内路径（`/r/blog/<sha256>.<ext>`）；取不到是 `null`。 */
  cover: string | null;
  source: ManualLeadCoverSource | null;
  /** 取不到时的短码，写进 `extra.cover_last_error`，只给运维看。 */
  reason?: string;
}

/** 外呼那三件事全部可注入，测试不碰网络。 */
export interface ManualLeadCoverDeps {
  /** 抓网页用。默认全局 `fetch`。 */
  fetcher?: (input: string, init?: RequestInit) => Promise<Response>;
  /** 取推文里的图。默认走网关 `POST /v1/tweet`。 */
  fetchTweet?: (url: string) => Promise<{ images: string[] }>;
  /** 图迁 R2。默认 `migrateFeedCover`（5MB 上限 + 质量门 + 内容寻址去重）。 */
  migrate?: (env: Env, coverUrl: string) => Promise<string | null>;
}

/** 抓网页的超时。比取证那条路短得多：这是锦上添花的一步，等不起。 */
export const MANUAL_LEAD_COVER_FETCH_TIMEOUT_MS = 12_000;

/**
 * 网页正文最多读这么多字节就停。
 *
 * **不按总大小拒页**：实测一篇微信公众号文章的 HTML 有 3.4MB，一刀切「超 2MB 就拒」会把最常见
 * 的那类线索整片丢掉。og / twitter 那几个 meta 标签与 `msg_cdn_url` 变量都在 head 与正文很
 * 靠前的位置，读够这些就够了 —— 所以改成「流式读前 512KB 就掐断」，读到多少算多少。
 */
export const MANUAL_LEAD_COVER_HTML_MAX_BYTES = 512 * 1024;

/** 一条链接最多试几张候选图。每张都要下载 + 过质量门，试多了就成了慢操作。 */
export const MANUAL_LEAD_COVER_MAX_CANDIDATES = 3;

/** 连试三次还取不到就先歇着，`cover_last_attempt_at` 过 24h 之后才允许再试。 */
export const MANUAL_LEAD_COVER_MAX_ATTEMPTS = 3;
export const MANUAL_LEAD_COVER_RETRY_AFTER_MS = 24 * 60 * 60 * 1_000;

/** 与取证那条路同一份 env → 服务配置口径（`manual-news-leads-runtime.ts` 里的那份的副本）。 */
function coverResearchService(env: Env): TrustedResearchService | undefined {
  if (!env.MANUAL_NEWS_RESEARCH_ORIGIN || !env.MANUAL_NEWS_RESEARCH_TOKEN
    || !env.MANUAL_NEWS_RESEARCH_RESPONSE_SECRET
    || !env.MANUAL_NEWS_RESEARCH_RESPONSE_KEY_ID) return undefined;
  return {
    origin: env.MANUAL_NEWS_RESEARCH_ORIGIN,
    token: env.MANUAL_NEWS_RESEARCH_TOKEN,
    responseKeyId: env.MANUAL_NEWS_RESEARCH_RESPONSE_KEY_ID,
    responseSecret: env.MANUAL_NEWS_RESEARCH_RESPONSE_SECRET,
    responseKeyringJson: env.MANUAL_NEWS_RESEARCH_RESPONSE_KEYRING_JSON,
  };
}

/** HTML 属性值里的实体：URL 的查询串里 `&amp;` 极常见，不还原就拼出一个死链。 */
function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&(?:amp|#38|#x26);/gi, '&')
    .replace(/&(?:quot|#34|#x22);/gi, '"')
    .replace(/&(?:apos|#39|#x27);/gi, "'")
    .replace(/&(?:lt|#60|#x3c);/gi, '<')
    .replace(/&(?:gt|#62|#x3e);/gi, '>');
}

function attrOf(tag: string, name: string): string | undefined {
  const quoted = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag);
  if (quoted) return decodeHtmlEntities(quoted[1]);
  const bare = new RegExp(`\\b${name}\\s*=\\s*([^\\s"'>]+)`, 'i').exec(tag);
  return bare ? decodeHtmlEntities(bare[1]) : undefined;
}

/**
 * pbs.twimg.com 的图链没带参数时只给一张缩略图，补上「原图 + 大尺寸」两个参数。
 * 已经自带 `format` 或 `name` 的（网关返回的多半带）原样不动。
 */
function normalizeTweetImageUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { return raw; }
  if (url.hostname.toLowerCase() !== 'pbs.twimg.com') return raw;
  if (url.searchParams.has('format') || url.searchParams.has('name')) return raw;
  url.searchParams.set('format', 'jpg');
  url.searchParams.set('name', 'large');
  return url.toString();
}

/**
 * 候选图的统一过滤：相对路径按最终页面地址解析，只留 http(s)，丢掉 `data:` / `.svg` /
 * 黑名单关键词（二维码 / logo / 头像 / 图标），再过一遍 SSRF 校验。留不下就是 `null`。
 */
export function normalizeManualLeadCoverCandidate(
  raw: string | undefined | null,
  baseUrl: string,
): string | null {
  const value = String(raw || '').trim();
  if (!value || /^data:/i.test(value)) return null;
  let url: URL;
  try { url = new URL(decodeHtmlEntities(value), baseUrl); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (/\.svg$/i.test(url.pathname)) return null;
  if (COVER_BLACKLIST.test(url.href)) return null;
  try { validatePublicHttpUrl(url.href); } catch { return null; }
  return url.href;
}

interface RawCandidate {
  url: string;
  source: ManualLeadCoverSource;
}

/**
 * 从一页 HTML 里按优先级列出候选图。
 *
 * og:image → og:image:secure_url → twitter:image（三者共用 `feeds/extract.ts` 的 meta 解析）
 * → 微信专属（`var msg_cdn_url = "…"` 是公众号文章的封面变量；公众号正文图用 `data-src`
 * 不用 `src`）→ 通用兜底（正文第一张自己声明 width/height 都 ≥300 的图）。
 */
export function manualLeadCoverCandidates(html: string, pageUrl: string): RawCandidate[] {
  const out: RawCandidate[] = [];
  const push = (raw: string | undefined, source: ManualLeadCoverSource): void => {
    const normalized = normalizeManualLeadCoverCandidate(raw, pageUrl);
    if (normalized && !out.some((item) => item.url === normalized)) out.push({ url: normalized, source });
  };

  push(metaContent(html, 'og:image'), 'og');
  push(metaContent(html, 'og:image:secure_url'), 'og');
  push(metaContent(html, 'twitter:image'), 'twitter');

  let wechat = false;
  try { wechat = new URL(pageUrl).hostname.toLowerCase().endsWith('mp.weixin.qq.com'); } catch { wechat = false; }
  if (wechat) {
    const cdn = /var\s+msg_cdn_url\s*=\s*["']([^"']+)["']/i.exec(html);
    if (cdn) push(cdn[1], 'wechat');
    for (const tag of html.match(/<img\b[^>]*>/gi) || []) {
      const src = attrOf(tag, 'data-src');
      if (src) { push(src, 'wechat'); break; }
    }
  }

  // 通用兜底：只认自己把尺寸写在标签上的图，声明 <300 的一律不当封面（多半是图标 / 间隔图）。
  for (const tag of html.match(/<img\b[^>]*>/gi) || []) {
    const width = parseInt(String(attrOf(tag, 'width') || ''), 10);
    const height = parseInt(String(attrOf(tag, 'height') || ''), 10);
    if (!(width >= 300 && height >= 300)) continue;
    push(attrOf(tag, 'src') || attrOf(tag, 'data-src'), 'body');
    break;
  }
  return out;
}

interface FetchedPage {
  html: string;
  finalUrl: string;
}

/** 读前 512KB 就掐断（见 {@link MANUAL_LEAD_COVER_HTML_MAX_BYTES}），绝不整页读完。 */
async function readCappedText(response: Response): Promise<string> {
  const body = response.body as ReadableStream<Uint8Array> | null;
  if (!body || typeof body.getReader !== 'function') {
    const text = await response.text();
    return text.slice(0, MANUAL_LEAD_COVER_HTML_MAX_BYTES);
  }
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let read = 0;
  let html = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const bytes = chunk.value as Uint8Array;
      read += bytes.byteLength;
      html += decoder.decode(bytes, { stream: true });
      if (read >= MANUAL_LEAD_COVER_HTML_MAX_BYTES) break;
    }
  } finally {
    try { await reader.cancel(); } catch { /* 已经读完的流 cancel 会抛，无所谓 */ }
  }
  return html;
}

/** 抓一页 HTML。拿不到只回一个短码，绝不抛。 */
async function fetchCoverPage(
  url: string,
  deps: ManualLeadCoverDeps,
): Promise<{ page: FetchedPage } | { reason: string }> {
  const fetcher = deps.fetcher || ((input: string, init?: RequestInit) => fetch(input, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MANUAL_LEAD_COVER_FETCH_TIMEOUT_MS);
  try {
    const response = await fetcher(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        // 接近真实浏览器的 UA：不少站点对纯 bot UA 直接 403。
        'User-Agent': FEED_R2_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      },
    });
    if (!response.ok) return { reason: `fetch_failed:${response.status}` };
    const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (type && type !== 'text/html' && type !== 'application/xhtml+xml') return { reason: 'not_html' };
    const html = await readCappedText(response);
    if (!html.trim()) return { reason: 'not_html' };
    return { page: { html, finalUrl: response.url || url } };
  } catch (error) {
    const aborted = controller.signal.aborted
      || /abort|timeout/i.test(String((error as Error)?.message || ''));
    return { reason: aborted ? 'fetch_failed:timeout' : 'fetch_failed:error' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 按一条链接取一张能用的封面图。**永不抛异常。**
 *
 * 推文走网关取证接口拿 `images[]`；其它链接直接从 Worker 抓页面取 og / 微信封面 / 正文图。
 * 每个候选都要真下载一遍并过质量门（`migrateFeedCover`），过了才算数。
 */
export async function resolveManualLeadCover(
  env: Env,
  input: { url: string },
  deps: ManualLeadCoverDeps = {},
): Promise<ManualLeadCoverResolution> {
  const migrate = deps.migrate || migrateFeedCover;
  const url = String(input.url || '').trim();
  if (!url) return { cover: null, source: null, reason: 'no_url' };

  const tryCandidates = async (
    candidates: readonly RawCandidate[],
  ): Promise<ManualLeadCoverResolution | null> => {
    for (const candidate of candidates.slice(0, MANUAL_LEAD_COVER_MAX_CANDIDATES)) {
      let migrated: string | null = null;
      try {
        migrated = await migrate(env, candidate.url);
      } catch (error) {
        console.warn('[manual-lead-cover] migrate failed:',
          String((error as Error)?.message || error).slice(0, 200));
        migrated = null;
      }
      if (migrated) return { cover: migrated, source: candidate.source };
    }
    return null;
  };

  if (parseTwitterStatusUrl(url)) {
    let images: string[] = [];
    try {
      const fetchTweet = deps.fetchTweet
        || ((target: string) => fetchTweetEvidence(target, { service: coverResearchService(env) }));
      images = (await fetchTweet(url)).images || [];
    } catch (error) {
      console.warn('[manual-lead-cover] tweet fetch failed:',
        String((error as Error)?.message || error).slice(0, 200));
      return { cover: null, source: null, reason: 'tweet_fetch_failed' };
    }
    const candidates: RawCandidate[] = [];
    for (const image of images) {
      const normalized = normalizeManualLeadCoverCandidate(normalizeTweetImageUrl(image), url);
      if (normalized && !candidates.some((item) => item.url === normalized)) {
        candidates.push({ url: normalized, source: 'tweet' });
      }
    }
    if (!candidates.length) return { cover: null, source: null, reason: 'tweet_no_images' };
    return (await tryCandidates(candidates))
      || { cover: null, source: null, reason: 'all_candidates_rejected' };
  }

  let safeUrl: string;
  try { safeUrl = validatePublicHttpUrl(url).toString(); } catch { return { cover: null, source: null, reason: 'invalid_url' }; }
  const fetched = await fetchCoverPage(safeUrl, deps);
  if ('reason' in fetched) return { cover: null, source: null, reason: fetched.reason };
  const candidates = manualLeadCoverCandidates(fetched.page.html, fetched.page.finalUrl);
  if (!candidates.length) return { cover: null, source: null, reason: 'no_candidates' };
  return (await tryCandidates(candidates))
    || { cover: null, source: null, reason: 'all_candidates_rejected' };
}

export interface ManualLeadCoverOutcome {
  status: 'set' | 'skipped' | 'failed';
  reason?: string;
  cover?: string | null;
}

interface ManualLeadCoverRow {
  url: string | null;
  extra: string | null;
}

/**
 * 给一条已经入池的补录条目补封面。**永不抛异常。**
 *
 * 幂等：`extra.cover_image` 已经是站内 `/r/` 形态就直接跳过，写库那句也再带一次同样的条件，
 * 两条路同时跑也不会互相覆盖。取不到只记失败计数（`cover_attempts` / `cover_last_error` /
 * `cover_last_attempt_at`），连试三次之后 24h 内不再试。
 */
export async function ensureManualLeadCover(
  env: Env,
  itemId: string,
  deps: ManualLeadCoverDeps & { force?: boolean; now?: number } = {},
): Promise<ManualLeadCoverOutcome> {
  const now = deps.now ?? Date.now();
  try {
    const row = await env.DB.prepare(
      `/* manual_lead:cover_row */ SELECT url, extra FROM items WHERE id = ?`,
    ).bind(itemId).first<ManualLeadCoverRow>();
    if (!row) return { status: 'skipped', reason: 'not_found' };

    let extra: Record<string, unknown> = {};
    try { extra = row.extra ? (JSON.parse(row.extra) as Record<string, unknown>) : {}; } catch { extra = {}; }
    const existing = String(extra.cover_image || '');
    if (existing.startsWith('/r/')) return { status: 'skipped', reason: 'already', cover: existing };
    const url = String(row.url || '').trim();
    if (!url) return { status: 'skipped', reason: 'no_url' };

    const attempts = Number(extra.cover_attempts || 0);
    const lastAttemptAt = Date.parse(String(extra.cover_last_attempt_at || ''));
    if (!deps.force && attempts >= MANUAL_LEAD_COVER_MAX_ATTEMPTS
      && Number.isFinite(lastAttemptAt) && now - lastAttemptAt < MANUAL_LEAD_COVER_RETRY_AFTER_MS) {
      return { status: 'skipped', reason: 'attempts' };
    }

    const resolved = await resolveManualLeadCover(env, { url }, deps);
    const nowIso = new Date(now).toISOString();
    if (resolved.cover) {
      // WHERE 里再判一次：入池之后另一条路（workflow / 确认接口 / 兜底扫描）可能已经写过封面，
      // 后到的这次绝不覆盖它。签名覆盖的列与键一个都不碰，只 json_set 三个新键。
      await env.DB.prepare(
        `/* manual_lead:cover_set */ UPDATE items
         SET extra = json_set(coalesce(extra,'{}'),
           '$.cover_image', ?, '$.cover_image_source', ?, '$.cover_resolved_at', ?)
         WHERE id = ?
           AND (json_extract(extra,'$.cover_image') IS NULL
             OR json_extract(extra,'$.cover_image') NOT LIKE '/r/%')`,
      ).bind(resolved.cover, resolved.source || '', nowIso, itemId).run();
      return { status: 'set', cover: resolved.cover, reason: resolved.source || undefined };
    }

    await env.DB.prepare(
      `/* manual_lead:cover_attempt */ UPDATE items
       SET extra = json_set(coalesce(extra,'{}'),
         '$.cover_attempts', ?, '$.cover_last_error', ?, '$.cover_last_attempt_at', ?)
       WHERE id = ?`,
    ).bind(attempts + 1, resolved.reason || 'unknown', nowIso, itemId).run();
    return { status: 'failed', reason: resolved.reason || 'unknown', cover: null };
  } catch (error) {
    // 封面是锦上添花的一步：写库出故障也只记一行日志，绝不往外抛。
    console.warn(`[manual-lead-cover] ${itemId} failed:`,
      String((error as Error)?.message || error).slice(0, 200));
    return { status: 'failed', reason: 'exception' };
  }
}

/** 兜底扫描一轮的总预算。挂在出片之前，等不起更久。 */
export const MANUAL_LEAD_COVER_BACKFILL_BUDGET_MS = 60_000;
/** 同时取几条。每条都要外呼一次原文页 + 下载一张图，3 条并发已经够快。 */
export const MANUAL_LEAD_COVER_BACKFILL_CONCURRENCY = 3;
/** 一轮最多处理多少条，防一次扫描拉回一整年的行。 */
export const MANUAL_LEAD_COVER_BACKFILL_MAX_ITEMS = 50;
/** 扫描默认覆盖几天（1 = 只看当天）。 */
export const MANUAL_LEAD_COVER_BACKFILL_MAX_DAYS = 14;

export interface ManualLeadCoverBackfillItem {
  id: string;
  status: ManualLeadCoverOutcome['status'];
  reason?: string;
  cover?: string | null;
}

export interface ManualLeadCoverBackfillStats {
  scanned: number;
  set: number;
  skipped: number;
  failed: number;
  remaining: number;
  items: ManualLeadCoverBackfillItem[];
}

/** `YYYY-MM-DD` 往前推 n 天，仍按北京时区的日历日算（只做日期减法，不碰时区换算）。 */
function shiftDate(date: string, days: number): string {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(ms)) return date;
  return new Date(ms - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * 兜底扫描：把这几天里还没有站内封面的补录条目再取一遍。
 *
 * **按 `manual_news_leads.review_date` 选行**，不按 `items.published_at`：后者取自证据的发布
 * 时间，零证据的 owner 断言线索上恒为 `null`，按它扫会整片漏掉；`review_date` 恒非空，而且
 * 「哪天的日报」本来就是这个扫描该用的口径（与 `backfillManualLeadEnrichment` 一致）。
 *
 * **永不抛异常**：读库失败只回一份零统计 —— 补封面失败绝不能变成出片失败。
 */
export async function backfillManualLeadCover(
  env: Env,
  opts: {
    date: string;
    days?: number;
    limit?: number;
    force?: boolean;
    dry?: boolean;
    now?: () => number;
    budgetMs?: number;
    concurrency?: number;
  },
  deps: ManualLeadCoverDeps = {},
): Promise<ManualLeadCoverBackfillStats> {
  const stats: ManualLeadCoverBackfillStats = {
    scanned: 0, set: 0, skipped: 0, failed: 0, remaining: 0, items: [],
  };
  const now = opts.now ?? (() => Date.now());
  const deadline = now() + (opts.budgetMs ?? MANUAL_LEAD_COVER_BACKFILL_BUDGET_MS);
  const concurrency = Math.max(1, opts.concurrency ?? MANUAL_LEAD_COVER_BACKFILL_CONCURRENCY);
  const limit = Math.min(Math.max(1, opts.limit ?? 20), MANUAL_LEAD_COVER_BACKFILL_MAX_ITEMS);
  const days = Math.min(Math.max(1, opts.days ?? 1), MANUAL_LEAD_COVER_BACKFILL_MAX_DAYS);
  const since = shiftDate(opts.date, days - 1);
  const retryBefore = new Date(now() - MANUAL_LEAD_COVER_RETRY_AFTER_MS).toISOString();

  // 候选行按 manual_news_leads 的 review_date 索引选，再用主键连回 items；json_extract 只在
  // 连上之后的那一行上判断，不参与选行。
  const extraExpr = `CASE WHEN i.extra IS NOT NULL AND json_valid(i.extra) = 1 THEN i.extra ELSE '{}' END`;
  const attemptsGate = opts.force ? '' : `
         AND (COALESCE(json_extract(${extraExpr}, '$.cover_attempts'), 0) < ${MANUAL_LEAD_COVER_MAX_ATTEMPTS}
           OR COALESCE(json_extract(${extraExpr}, '$.cover_last_attempt_at'), '') < ?)`;
  const predicate = `FROM manual_news_leads l
       JOIN items i ON i.id = 'blog:manual:' || l.id
       WHERE l.review_date BETWEEN ? AND ?
         AND COALESCE(json_extract(${extraExpr}, '$.cover_image'), '') NOT LIKE '/r/%'${attemptsGate}`;
  const scanBindings = opts.force ? [since, opts.date] : [since, opts.date, retryBefore];

  let pending: Array<{ id: string }>;
  try {
    const rows = await env.DB.prepare(
      `/* manual_lead:cover_backfill_scan */ SELECT i.id AS id ${predicate}
       ORDER BY l.id DESC LIMIT ?`,
    ).bind(...scanBindings, limit).all<{ id: string }>();
    pending = rows.results || [];
  } catch (error) {
    console.warn('[manual-lead-cover] backfill scan failed:',
      String((error as Error)?.message || error).slice(0, 200));
    return stats;
  }

  stats.scanned = pending.length;
  if (opts.dry) {
    stats.skipped = pending.length;
    stats.items = pending.map((row) => ({ id: row.id, status: 'skipped' as const, reason: 'dry' }));
  } else if (pending.length) {
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < pending.length) {
        if (now() >= deadline) return;
        const row = pending[cursor++];
        const outcome = await ensureManualLeadCover(env, row.id, {
          ...deps, ...(opts.force ? { force: true } : {}),
        });
        stats[outcome.status] += 1;
        stats.items.push({
          id: row.id,
          status: outcome.status,
          ...(outcome.reason ? { reason: outcome.reason } : {}),
          ...(outcome.cover ? { cover: outcome.cover } : {}),
        });
      }
    };
    try {
      await Promise.all(Array.from(
        { length: Math.min(concurrency, pending.length) }, () => worker(),
      ));
    } catch (error) {
      // ensureManualLeadCover 自己就把失败收敛成返回值了，走到这里只可能是意料之外的东西。
      console.warn('[manual-lead-cover] backfill failed:',
        String((error as Error)?.message || error).slice(0, 200));
    }
  }

  try {
    const rest = await env.DB.prepare(
      `/* manual_lead:cover_backfill_remaining */ SELECT COUNT(*) AS c ${predicate}`,
    ).bind(...scanBindings).first<{ c: number }>();
    stats.remaining = rest?.c ?? 0;
  } catch {
    stats.remaining = 0;
  }
  return stats;
}
