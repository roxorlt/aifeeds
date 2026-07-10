import { create } from "zustand";
import type {
  Item,
  ItemsResponse,
  SearchResponse,
  SearchSuggestTerm,
  Source,
  SourceType,
  Stats,
} from "./types";
import { getDeviceId } from "./lib/device";
import { track, EVENTS } from "./lib/telemetry";
import { useAuthStore } from "./lib/authStore";
import { API_BASE } from "./lib/apiBase";
import { consumeFeedPrefetch } from "./lib/feed-prefetch";

export interface MetricsSnapshotGh {
  captured_at: number;
  trending_date_str: string | null;
  total_stars: number | null;
  today_stars: number | null;
  forks: number | null;
  watchers: number | null;
  open_issues: number | null;
  open_prs: number | null;
}

export interface ItemDetailResponse {
  item: Item;
  siblings: Item[];
  siblings_has_more?: boolean;
  metrics_history?: MetricsSnapshotGh[];
}

export class ItemNotFoundError extends Error {
  constructor(id: string) {
    super(`item not found: ${id}`);
    this.name = "ItemNotFoundError";
  }
}

// API_BASE 的定义已收敛到唯一事实源 lib/apiBase.ts(2026-07-05 镜像分叉事故后)。
// 这里 re-export,保持既有 `import { API_BASE } from './api'` 的消费者不破。
export { API_BASE };

export const TRACK_ENDPOINT = `${API_BASE}/api/track`;

// ─── 401 自动登出断路器 ─────────────────────────────────────────────────────
// 个人态请求收到 401 时会「清登录态 + 弹登录弹窗」。若 base 再次分叉(auth 打
// 一个环境、业务打另一个),logout 会连锁触发新一轮 401 → 又 logout → 无限循环
// (2026-07-05 事故现象)。断路器:同一 60s 窗口内只允许触发一次,其余只 warn
// 不动作。请求本身照常把 401 返回给调用方走各自错误态,断路器只压「自动登出/弹窗」
// 这一副作用,不吞状态码。handle401(apiFetch)与 submitFeedback 的 401 分支共用
// 此 helper,消除两处逻辑漂移。
let last401At = 0;
function trigger401Login(): void {
  const now = Date.now();
  if (now - last401At < 60_000) {
    console.warn('[auth] 401 circuit-breaker: suppressed auto-logout');
    return;
  }
  last401At = now;
  const store = useAuthStore.getState();
  if (store.user) store.logout();
  store.openLoginModal('api_401');
}

/**
 * 统一 fetch 包装：自动注入 X-Device-Id，失败上报 api_error，
 * AbortController 超时 + 指数 backoff 重试（移动端 / WeChat WebView
 * 的 fetch 抖动通常瞬时；快速失败 + 重试比单次长等待 UX 好）。
 * 业务 endpoint（/api/items / /api/sources 等）走这个；
 * /api/track 自身不能走（会循环），用原生 fetch。
 */
const FETCH_TIMEOUT_MS = 5000;
// BE 2026-05-19 建议:retry 第三档拉长到 ≥ 2s 跨过 CF Workers deploy 切换窗口
// (deploy 是 replace-style cutover,几秒切换里 in-flight 必然有损,旧 200/600ms
// retry 间隔太短可能两次都撞在窗口里);加 ±20% jitter 避免雪崩 retry storm
// (多 client 同步 retry 会瞬时叠加压力)。
// 共 4 次 attempt(初次 + 3 次 retry),最坏 case 总耗时 ≈ 400+1500+2500+timeoutMs。
// 调用方对延迟敏感的 endpoint 用 timeoutMs override 来截断。
const RETRY_BACKOFFS_MS = [400, 1500, 2500] as const;

function backoffWithJitter(baseMs: number): number {
  // ±20% jitter:randomize within [base*0.8, base*1.2)
  return Math.floor(baseMs * (0.8 + Math.random() * 0.4));
}

async function apiFetch(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  const headers = new Headers(init.headers);
  headers.set('X-Device-Id', getDeviceId());
  // Caller can override default 5s timeout per-call (e.g. refreshHfDiscussion
  // 跑评论 fetch + img R2 mirror + 翻译 ~8s,默认 5s 会 abort 掉)
  const timeoutMs = init.timeoutMs ?? FETCH_TIMEOUT_MS;
  // 单独把 timeoutMs / signal 从 init 摘出来:timeoutMs 避免 fetch() 收到 unknown
  // 属性;signal 单独接管(见 tryOnce),否则会被下方 ctrl.signal 覆盖而失效。
  const { timeoutMs: _omit, signal: externalSignal, ...fetchInit } = init;
  void _omit;

  // Each attempt is wrapped in its own AbortController so a single hung
  // request can't block the entire retry chain. WeChat WebView is known
  // to occasionally drop fetches without erroring out, leaving them
  // pending forever.
  const tryOnce = async (): Promise<Response> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    // 外部 signal（如 suggest debounce 弃单）联动内部 timeout controller:任一触发都
    // abort。仅在调用方传 signal 时生效 —— 既有调用方全部无 signal,行为完全不变。
    const onExternalAbort = () => ctrl.abort();
    if (externalSignal) {
      if (externalSignal.aborted) ctrl.abort();
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
    try {
      return await fetch(url, { ...fetchInit, headers, credentials: 'include', signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  };

  // 401 拦截：仅对个人态 endpoint 弹登录（避免 /api/items 等公开 endpoint 误触发）。
  // 实际的登出+弹窗走 trigger401Login（含 60s 断路器，防分叉时死循环）。
  const handle401 = (status: number) => {
    if (status !== 401) return;
    const protectedPaths = ['/api/auth/me', '/api/favorites', '/api/subscriptions', '/api/feedback'];
    const isProtected = protectedPaths.some((p) => path.startsWith(p));
    if (!isProtected) return;
    trigger401Login();
  };

  let res: Response | null = null;
  let lastErr: unknown = null;

  for (let attempt = 0; attempt <= RETRY_BACKOFFS_MS.length; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, backoffWithJitter(RETRY_BACKOFFS_MS[attempt - 1])));
    }
    try {
      const r = await tryOnce();
      // 5xx is retryable (idempotent GETs only)
      if (r.status >= 500 && r.status < 600 && attempt < RETRY_BACKOFFS_MS.length) {
        res = r;
        lastErr = new Error(`HTTP ${r.status}`);
        continue;
      }
      // Final response (success / 4xx / final 5xx)
      if (!r.ok && r.status >= 400) {
        track(EVENTS.API_ERROR, {
          endpoint: path,
          status: r.status,
          attempts: attempt + 1,
        });
      }
      handle401(r.status);
      return r;
    } catch (e) {
      // catch path 覆盖:network fail / CORS preflight fail(TypeError:Failed to fetch)/
      // AbortError(timeout)。这三种都走 retry — for loop 在 attempt < length 时
      // 自然进入下一轮 attempt(无需显式 continue);只在最后一轮才 track + throw
      lastErr = e;
      // 外部 signal 主动取消（调用方 debounce 弃单等）→ 不 retry、不上报 api_error,
      // 直接抛出让调用方按需忽略 AbortError。timeout 触发的内部 abort 不受此影响。
      if (externalSignal?.aborted) throw e;
      if (attempt >= RETRY_BACKOFFS_MS.length) {
        // Every fetch attempt is wrapped in its own AbortController with a
        // FETCH_TIMEOUT_MS timeout, so AbortError almost always means "timeout"
        // rather than user cancellation. Normalize to a stable string so the
        // admin dashboard can bucket timeouts separately from real errors.
        const rawMsg = e instanceof Error ? e.message : String(e);
        const isAbort = e instanceof Error && (e.name === 'AbortError' || /aborted|abort/i.test(rawMsg));
        // CORS preflight failure / network unreachable / opaque fetch error 浏览器
        // 统一抛 TypeError: "Failed to fetch",上报时归类 cors_or_network 便于
        // admin dashboard 分桶(deploy 切换暂态 CORS fail 应该 < 1% 全部 attempts)
        const isCorsOrNet = e instanceof TypeError && /failed to fetch|fetch/i.test(rawMsg);
        track(EVENTS.API_ERROR, {
          endpoint: path,
          status: 0,
          error_msg: isAbort
            ? `timeout_${timeoutMs}ms`
            : (isCorsOrNet ? 'cors_or_network' : rawMsg),
          attempts: attempt + 1,
        });
        throw e;
      }
    }
  }

  // Unreachable in practice — loop either returns or throws. Keep TS happy.
  if (res) return res;
  throw lastErr;
}

export interface ItemsQuery {
  // "blog,podcast" 为「官方新闻」合并频道哨兵值：buildQuery 透传为 source_type=blog,podcast，
  // worker handleItems 按逗号 split 过滤（见设计文档 §10）。
  source_type?: SourceType | SourceType[] | "blog,podcast";
  since?: string;
  until?: string;
  relevant?: 0 | 1;
  limit?: number;
  cursor?: string;
  sort?: "scraped_at" | "published_at" | "hot" | "stars" | "downloads" | "installs" | "updated" | "name";
  /** ClawHub 专属：客户端 8-class 关键词分类筛选 */
  category?: string;
  /** ClawHub 专属：true = 包含可疑 skill；undefined/false = 默认隐藏（v0：当前 DB 只有非可疑数据，flag 透传 worker 但实际 no-op）*/
  include_suspicious?: boolean;
  /** 活动行专属：城市筛选（24 城之一，HUODONGXING_CITIES） */
  city?: string;
  /** 活动行专属：时段筛选（this=本周 / weekend=本周末 / month=30 天内） */
  when?: "this" | "weekend" | "month";
  /** 活动行专属：形式筛选（online=线上 / offline=线下） */
  form?: "online" | "offline";
}

function buildQuery(params: Record<string, unknown>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      qs.set(k, v.join(","));
    } else {
      qs.set(k, String(v));
    }
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
}

export async function fetchItems(query: ItemsQuery = {}): Promise<ItemsResponse> {
  const path = `/api/items${buildQuery(query as Record<string, unknown>)}`;
  const fetchFromNetwork = async (): Promise<ItemsResponse> => {
    const res = await apiFetch(path);
    if (!res.ok) throw new Error(`fetchItems failed: ${res.status}`);
    return res.json();
  };
  // 首屏冷启动:index.html 已在 JS 加载阶段并行预取默认 x_list feed。path 严格匹配就直接用
  // 预取结果,省掉「等 JS 跑完才发请求」的串行等待;只用一次,失败/不匹配自动回退正常请求。
  const w = window as unknown as {
    __feedPrefetch?: { path: string; promise: Promise<ItemsResponse | null> } | null;
  };
  const pf = w.__feedPrefetch;
  if (pf && pf.path === path) {
    w.__feedPrefetch = null;
    // 只有 race 中实际胜出的合法对象会被 WeakSet 标记为 html_prefetch；超时后
    // 晚到的 prefetch 不能误标正常网络 fallback，也不会再阻塞 Feed 的 .then。
    return consumeFeedPrefetch(pf.promise, fetchFromNetwork);
  }
  return fetchFromNetwork();
}

export async function fetchSources(): Promise<Source[]> {
  const res = await apiFetch('/api/sources');
  if (!res.ok) throw new Error(`fetchSources failed: ${res.status}`);
  const data = await res.json();
  return data.sources || [];
}

export async function fetchItem(id: string): Promise<ItemDetailResponse> {
  const path = `/api/items/${encodeURIComponent(id)}`;
  const res = await apiFetch(path);
  if (res.status === 404) throw new ItemNotFoundError(id);
  if (!res.ok) throw new Error(`fetchItem failed: ${res.status}`);
  return res.json();
}

// PR6.6 on-demand refresh — drawer 打开时调一次。worker 端 KV throttle 5min。
// reason: throttled / unsupported_source / item_not_found / fetch_failed / success
export interface RefreshItemResponse {
  refreshed: boolean;
  source_type: string;
  reason?: 'throttled' | 'unsupported_source' | 'item_not_found' | 'fetch_failed' | 'success';
  metrics?: Record<string, number | null | undefined>;
}

export async function refreshItem(id: string): Promise<RefreshItemResponse> {
  const path = `/api/items/${encodeURIComponent(id)}/refresh`;
  const res = await apiFetch(path, { method: 'POST' });
  if (!res.ok) return { refreshed: false, source_type: 'unknown', reason: 'fetch_failed' };
  return res.json();
}

// hf_paper 专用 — discussion fetch + content_html <img> 抓 R2 + rewrite src + 翻译。
// 慢路径,BE 跑 ~5-10s,跟 refreshItem(metrics-only ~2s)拆分独立 endpoint
// 避免 FE 5s 默认 abort timeout。drawer mount 时跟主 refresh 并行 fire。
// BE: POST /api/items/:id/refresh-hf-discussion(KV 5min throttle 独立 key)
export interface RefreshHfDiscussionResponse {
  refreshed: boolean;
  comments_count: number;
  translated_count: number;
  images_mirrored: number;
  reason?: string;
}

export async function refreshHfDiscussion(id: string): Promise<RefreshHfDiscussionResponse> {
  const path = `/api/items/${encodeURIComponent(id)}/refresh-hf-discussion`;
  const res = await apiFetch(path, { method: 'POST', timeoutMs: 15000 });
  if (!res.ok) {
    return { refreshed: false, comments_count: 0, translated_count: 0, images_mirrored: 0, reason: 'fetch_failed' };
  }
  return res.json();
}

// translate-now: 即时翻译 endpoint。x_list 推文翻译失败时用户点「译文」按钮触发。
// 6 档错误码契约（BE 对齐 plan 第九节 ④）：200 / 401 / 404 / 400 / 429 ×2 / 503
export interface TranslateNowResponse {
  content_zh: string | null;
  quote_of_zh: string | null;
  reply_of_zh: string | null;
  retweet_of_zh: string | null;
  link_card_title_zh: string | null;
  link_card_desc_zh: string | null;
  translated_at: string | null;
}

export type TranslateNowErrorCode =
  | 'unauthorized'
  | 'not_found'
  | 'unsupported_source'
  | 'rate_limited'
  | 'daily_cap_exceeded'
  | 'translation_failed'
  | 'unknown';

export interface TranslateNowErrorDetails {
  source_type?: string;
  retry_after_sec?: number;
  cap?: number;
  used?: number;
  reason?: string;
}

export class TranslateNowError extends Error {
  code: TranslateNowErrorCode;
  details: TranslateNowErrorDetails;
  constructor(code: TranslateNowErrorCode, details: TranslateNowErrorDetails = {}) {
    super(`translate-now failed: ${code}`);
    this.code = code;
    this.details = details;
  }
}

export async function translateNowItem(id: string): Promise<TranslateNowResponse> {
  const path = `/api/items/${encodeURIComponent(id)}/translate-now`;
  const res = await apiFetch(path, { method: 'POST' });
  if (res.ok) return res.json();
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // body 不是 JSON / 解析失败 — 走默认 unknown code
  }
  const rawError = typeof body.error === 'string' ? body.error : '';
  let code: TranslateNowErrorCode;
  if (rawError === 'unauthorized' || res.status === 401) code = 'unauthorized';
  else if (rawError === 'not_found' || res.status === 404) code = 'not_found';
  else if (rawError === 'unsupported_source') code = 'unsupported_source';
  else if (rawError === 'rate_limited') code = 'rate_limited';
  else if (rawError === 'daily_cap_exceeded') code = 'daily_cap_exceeded';
  else if (rawError === 'translation_failed' || res.status === 503) code = 'translation_failed';
  else code = 'unknown';
  throw new TranslateNowError(code, {
    source_type: typeof body.source_type === 'string' ? body.source_type : undefined,
    retry_after_sec: typeof body.retry_after_sec === 'number' ? body.retry_after_sec : undefined,
    cap: typeof body.cap === 'number' ? body.cap : undefined,
    used: typeof body.used === 'number' ? body.used : undefined,
    reason: typeof body.reason === 'string' ? body.reason : undefined,
  });
}

export async function fetchStats(): Promise<Stats> {
  const res = await apiFetch('/api/stats');
  if (!res.ok) throw new Error(`fetchStats failed: ${res.status}`);
  return res.json();
}

// ─── C 端搜索（匿名可搜，不入 protectedPaths）─────────────────────────────
// 契约见 types.ts SearchResponse / worker/src/search/handlers.ts（Task 6 定稿）。
// 无 source → grouped（每源预览）；带 source → list（单源分页流）。mode 字段收窄类型。
// 错误码由 worker 以 4xx/5xx + {error} 返回。此层把非 2xx 归一成 SearchError，
// 携带 status + body 的 error code（如 429 rate_limited），供 Task 11 消费方按
// 429 → toast / 其它 → 行内重试分支处理（apiFetch 只透传 status，不细分 code）。
export class SearchError extends Error {
  status: number;
  /** worker body 的 error 字段（如 'rate_limited' / 'invalid_source' / 'search_unavailable'）；解析不出为 null */
  code: string | null;
  constructor(status: number, code: string | null) {
    super(`searchItems failed: ${status}`);
    this.name = 'SearchError';
    this.status = status;
    this.code = code;
  }
}

export type SearchErrorKind = 'rate_limited' | 'server' | 'client' | 'network';

// 归类给埋点 / UI 分支用。SearchError（拿到了 HTTP 响应）按 status/code 分；
// 非 SearchError（apiFetch retry 用尽后抛的 timeout / CORS / 断网 TypeError）→ network。
export function classifySearchError(err: unknown): SearchErrorKind {
  if (err instanceof SearchError) {
    if (err.status === 429 || err.code === 'rate_limited') return 'rate_limited';
    if (err.status >= 500) return 'server';
    return 'client';
  }
  return 'network';
}

export function isRateLimited(err: unknown): boolean {
  return err instanceof SearchError && (err.status === 429 || err.code === 'rate_limited');
}

export async function searchItems(
  q: string,
  opts: { source?: string; cursor?: string } = {},
): Promise<SearchResponse> {
  const p = new URLSearchParams({ q });
  if (opts.source) p.set('source', opts.source);
  if (opts.cursor) p.set('cursor', opts.cursor);
  const res = await apiFetch(`/api/search?${p}`);
  if (!res.ok) {
    let code: string | null = null;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === 'string') code = body.error;
    } catch {
      // body 非 JSON / 解析失败 → code 保持 null，仅凭 status 判别
    }
    throw new SearchError(res.status, code);
  }
  return res.json();
}

// suggest：空 prefix = 热搜 top10。worker 对超限/出错一律返回 200 空 terms，
// 前端无需 429/错误分支。signal 用于输入态 debounce 弃单（AbortError 由调用方忽略）。
export async function searchSuggest(
  prefix: string,
  signal?: AbortSignal,
): Promise<SearchSuggestTerm[]> {
  const res = await apiFetch(
    `/api/search/suggest?prefix=${encodeURIComponent(prefix)}`,
    { signal },
  );
  if (!res.ok) return [];
  const data = (await res.json()) as { terms?: SearchSuggestTerm[] };
  return data.terms ?? [];
}

// ─── 中文配音「愿望清单」假门(painted door)─────────────────────────
// 点击只记录需求信号(后台统计用),不真做配音;计数不回给 C 端。匿名即可
// (apiFetch 自动带 X-Device-Id),登录则后端附 user_id。失败静默(假门容错优先)。
export async function addDubWishlist(itemId: string): Promise<void> {
  try {
    await apiFetch('/api/dub-wishlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_id: itemId }),
    });
  } catch {
    // 假门信号丢一条无所谓,不打扰用户
  }
}

// 刷新后回显「已加入」:查当前设备是否已对这集点过。失败当未加入。
export async function getDubWishlistState(itemId: string): Promise<boolean> {
  try {
    const res = await apiFetch(`/api/dub-wishlist?item_id=${encodeURIComponent(itemId)}`);
    const d = (await res.json()) as { wishlisted?: boolean };
    return !!d.wishlisted;
  } catch {
    return false;
  }
}

// ─── 订阅推送（digest subscription）──────────────────────────────────
// 契约见 docs/plans 设计文档「API 契约」节，源 key / slot / density 以 BE 为单一可信源。
// 匿名订阅走 POST /api/subscribe（非个人态路径，不触发 401 拦截）；登录态管理走
// /api/auth/me/subscription（apiFetch 401 拦截白名单已含 /api/auth/me 前缀）。

export type DigestSourceKey = 'ph' | 'gh' | 'hf-paper' | 'clawhub' | 'x';
export type DigestSlot = 8 | 12 | 17;
export type DigestDensity = 'normal' | 'curated';
// status 对外三态：active / unsubscribed / kicked（内部 paused 后端归一成 active 不暴露）
export type SubscriptionStatus = 'active' | 'unsubscribed' | 'kicked';

export interface SubscriptionData {
  email: string;
  sources: DigestSourceKey[];
  send_slot: DigestSlot;
  density: DigestDensity;
  status: SubscriptionStatus;
}

export type SubscribeErrorCode =
  | 'invalid_email'
  | 'invalid_sources'
  | 'invalid_slot'
  | 'turnstile_failed'
  | 'rate_limited'
  | 'server_error';

export type SubscribeResult =
  // edit_token：active 时后端下发的短期令牌，供两步订阅的「第二页改偏好」免二次人机校验使用。
  | { ok: true; status: 'active' | 'pending_confirm'; edit_token?: string }
  | { ok: false; code: SubscribeErrorCode };

export interface SubscribePayload {
  email: string;
  sources: DigestSourceKey[];
  send_slot: DigestSlot;
  density: DigestDensity;
  turnstile_token: string;
}

// 匿名订阅。后端 ON CONFLICT DO UPDATE 幂等，apiFetch 的 retry 不会造成重复 welcome。
// 两步流程：第一页只填邮箱 + 人机校验，按默认配置订阅；成功（active）后端回 edit_token，
// 第二页用 configureSubscription 带 token 改偏好（不再过人机校验）。
export async function subscribeDigest(payload: SubscribePayload): Promise<SubscribeResult> {
  const res = await apiFetch('/api/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  try {
    return (await res.json()) as SubscribeResult;
  } catch {
    return { ok: false, code: 'server_error' };
  }
}

export type ConfigureErrorCode =
  | 'invalid_token'
  | 'expired_token'
  | 'invalid_sources'
  | 'invalid_slot'
  | 'server_error';

export type ConfigureResult = { ok: true } | { ok: false; code: ConfigureErrorCode };

export interface ConfigurePayload {
  edit_token: string;
  sources: DigestSourceKey[];
  send_slot: DigestSlot;
  density: DigestDensity;
}

// 两步订阅第二页：用 subscribeDigest 下发的 edit_token 改偏好。无需登录、无需人机校验
// （token 即凭证，短期有效）。token 失效返回 expired_token / invalid_token，FE 兜底"已按默认订阅"。
export async function configureSubscription(payload: ConfigurePayload): Promise<ConfigureResult> {
  const res = await apiFetch('/api/subscribe/configure', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  try {
    return (await res.json()) as ConfigureResult;
  } catch {
    return { ok: false, code: 'server_error' };
  }
}

// 登录态读当前订阅（未订阅返回 { subscription: null }）。
export async function getMySubscription(): Promise<{ subscription: SubscriptionData | null }> {
  const res = await apiFetch('/api/auth/me/subscription');
  if (!res.ok) throw new Error(`getMySubscription failed: ${res.status}`);
  return res.json();
}

export type UpdateSubscriptionErrorCode =
  | 'invalid_sources'
  | 'invalid_slot'
  | 'not_subscribed'
  | 'server_error';

export type UpdateSubscriptionResult =
  | { ok: true }
  | { ok: false; code: UpdateSubscriptionErrorCode };

export interface UpdateSubscriptionPayload {
  sources: DigestSourceKey[];
  send_slot: DigestSlot;
  density: DigestDensity;
}

// 登录态改偏好（不含 email，管理页不可改邮箱）。后端改 send_slot 时自行重算 next_send_at。
export async function updateMySubscription(
  payload: UpdateSubscriptionPayload,
): Promise<UpdateSubscriptionResult> {
  const res = await apiFetch('/api/auth/me/subscription', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  try {
    return (await res.json()) as UpdateSubscriptionResult;
  } catch {
    return { ok: false, code: 'server_error' };
  }
}

// 站内退订（status → unsubscribed，与邮件 RFC 8058 一键退订归同一状态）。
export async function unsubscribeMySubscription(): Promise<{ ok: boolean }> {
  const res = await apiFetch('/api/auth/me/subscription/unsubscribe', { method: 'POST' });
  try {
    return (await res.json()) as { ok: boolean };
  } catch {
    return { ok: false };
  }
}

// ─── 用户反馈（feedback）──────────────────────────────────────────────────
// C 端登录用户图文反馈 + 后台图文回复回执。契约见设计文档 §4.1
// docs/plans/2026-07-05-user-feedback-design.md。
//
// 401 策略（三条路径各不同，刻意不统一走 apiFetch）：
//  - 提交（multipart）：手写 fetch，单次尝试，绝不自动重试写请求；401 时显式复用
//    openLoginModal('api_401') 语义（清登录态 + 弹登录弹窗）。
//  - 我的反馈（GET /mine）：走 apiFetch，靠 protectedPaths 前缀命中自动 401 拦截
//    （与订阅管理页 /api/auth/me 同款；反馈页是主动导航，会话真失效时弹登录正确）。
//  - 已读回执 / 未读数：手写 fetch 且静默吞错（fire-and-forget / 后台红点），绝不
//    因后台瞬时 401 把用户假踢下线（对齐 authStore hydrate 的乐观保留策略）。

export interface FeedbackReply {
  id: number;
  content: string;
  image_url: string | null;
  created_at: number;
  read_at: number | null;
}

export interface FeedbackItem {
  id: number;
  content: string;
  image_url: string | null;
  created_at: number;
  replies: FeedbackReply[];
}

export interface FeedbackMineResponse {
  ok: true;
  unread_count: number;
  items: FeedbackItem[];
}

export type SubmitFeedbackCode =
  | 'rate_limited'
  | 'unauthorized'
  | 'server_error';

export type SubmitFeedbackResult =
  | { ok: true; id: number; created_at: number; remaining: number }
  | { ok: false; code: SubmitFeedbackCode };

// 前端采集的设备信息（§5.4 device JSON 结构逐字对齐：ua / platform / language /
// languages / screen / viewport / dpr / timezone / page / network）。
function collectDeviceInfo(): Record<string, unknown> {
  const nav = navigator as Navigator & {
    connection?: { effectiveType?: string };
    languages?: readonly string[];
  };
  let timezone: string | null = null;
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  } catch {
    timezone = null;
  }
  return {
    ua: nav.userAgent,
    platform: nav.platform,
    language: nav.language,
    languages: nav.languages ? Array.from(nav.languages) : null,
    screen: { w: window.screen?.width ?? null, h: window.screen?.height ?? null },
    viewport: { w: window.innerWidth, h: window.innerHeight },
    dpr: window.devicePixelRatio ?? null,
    timezone,
    page: location.pathname,
    network: nav.connection?.effectiveType ?? null,
  };
}

// 提交反馈：multipart/form-data { content, image?, device }。手写 fetch，单次尝试，
// 绝不自动重试（写请求）。Content-Type 交给浏览器按 FormData 自动带 boundary，
// 手动设会破坏 multipart 分隔符。
export async function submitFeedback(
  content: string,
  image: File | null,
): Promise<SubmitFeedbackResult> {
  const fd = new FormData();
  fd.append('content', content);
  if (image) fd.append('image', image);
  fd.append('device', JSON.stringify(collectDeviceInfo()));

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/feedback`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'X-Device-Id': getDeviceId() },
      body: fd,
    });
  } catch {
    return { ok: false, code: 'server_error' };
  }

  if (res.ok) {
    try {
      const d = (await res.json()) as { id: number; created_at: number; remaining: number };
      return { ok: true, id: d.id, created_at: d.created_at, remaining: d.remaining };
    } catch {
      return { ok: false, code: 'server_error' };
    }
  }

  if (res.status === 401) {
    trigger401Login();
    return { ok: false, code: 'unauthorized' };
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // 非 JSON body — 归为 server_error
  }
  const err = typeof body.error === 'string' ? body.error : '';
  if (res.status === 429 || err === 'rate_limited') return { ok: false, code: 'rate_limited' };
  return { ok: false, code: 'server_error' };
}

// 我的反馈列表（最近 50 条 + 每条回复 + 未读回复数）。走 apiFetch → protectedPaths
// 命中 → 401 自动弹登录。
export async function fetchMyFeedback(): Promise<FeedbackMineResponse> {
  const res = await apiFetch('/api/feedback/mine');
  if (!res.ok) throw new Error(`fetchMyFeedback failed: ${res.status}`);
  return res.json();
}

// 标记本人全部未读回复为已读（fire-and-forget）。手写 fetch，静默吞错。
export async function markFeedbackRead(): Promise<void> {
  try {
    await fetch(`${API_BASE}/api/feedback/read`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'X-Device-Id': getDeviceId() },
    });
  } catch {
    // 已读回执丢一条无妨，下次打开反馈页会再标
  }
}

// 未读回复数（后台红点用）。手写 fetch，失败/401 一律当 0，绝不触发登出/弹窗
// —— 后台瞬时 401 不该把用户假踢下线。
export async function fetchFeedbackUnreadCount(): Promise<number> {
  try {
    const res = await fetch(`${API_BASE}/api/feedback/unread-count`, {
      method: 'GET',
      credentials: 'include',
      headers: { 'X-Device-Id': getDeviceId() },
    });
    if (!res.ok) return 0;
    const d = (await res.json()) as { count?: number };
    return typeof d.count === 'number' ? d.count : 0;
  } catch {
    return 0;
  }
}

// 未读红点共享 state：UserMenu / Settings 读红点，Feedback 页拉取列表后清零。
// 放在 api.ts 内而非单独 lib 文件 —— 本任务文件边界只允许改这 5 个文件，
// store 依附 api 层（无 JSX 组件导出，不触发 react-refresh 规则）可接受。
interface FeedbackUnreadStore {
  unread: number;
  setUnread: (n: number) => void;
  clearUnread: () => void;
  loadUnread: () => Promise<void>;
}

export const useFeedbackUnreadStore = create<FeedbackUnreadStore>((set) => ({
  unread: 0,
  setUnread: (n) => set({ unread: Math.max(0, n) }),
  clearUnread: () => set({ unread: 0 }),
  async loadUnread() {
    const n = await fetchFeedbackUnreadCount();
    set({ unread: Math.max(0, n) });
  },
}));
