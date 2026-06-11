import type { Item, ItemsResponse, Source, SourceType, Stats } from "./types";
import { getDeviceId } from "./lib/device";
import { track, EVENTS } from "./lib/telemetry";
import { useAuthStore } from "./lib/authStore";

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

export const API_BASE = (() => {
  if (import.meta.env.VITE_API_BASE) return import.meta.env.VITE_API_BASE;
  if (typeof window !== "undefined") {
    const host = window.location.hostname;
    // Dev: 走相对路径 → vite proxy 透传到目标 worker（默认 prod，可用 VITE_API_PROXY 覆盖）
    if (host === "localhost" || host === "127.0.0.1") {
      return "";
    }
    // Staging dashboard 必须打 staging worker，否则线上 prod 没有最新 endpoint
    // 时（例如 PR 部署的新接口）会全线 404
    if (host === "staging.ai-feeds.com" || host.endsWith(".xlist-dashboard-staging.pages.dev")) {
      return "https://staging-api.ai-feeds.com";
    }
  }
  return "https://api.ai-feeds.com";
})();

export const TRACK_ENDPOINT = `${API_BASE}/api/track`;

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
  // 单独把 timeoutMs 从 init 摘出来,避免 fetch() 收到 unknown 属性
  const { timeoutMs: _omit, ...fetchInit } = init;
  void _omit;

  // Each attempt is wrapped in its own AbortController so a single hung
  // request can't block the entire retry chain. WeChat WebView is known
  // to occasionally drop fetches without erroring out, leaving them
  // pending forever.
  const tryOnce = async (): Promise<Response> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(url, { ...fetchInit, headers, credentials: 'include', signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  // 401 拦截：仅对个人态 endpoint 弹登录（避免 /api/items 等公开 endpoint 误触发）
  const handle401 = (status: number) => {
    if (status !== 401) return;
    const protectedPaths = ['/api/auth/me', '/api/favorites', '/api/subscriptions'];
    const isProtected = protectedPaths.some((p) => path.startsWith(p));
    if (!isProtected) return;
    const store = useAuthStore.getState();
    if (store.user) store.logout();
    store.openLoginModal('api_401');
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
  // 首屏冷启动:index.html 已在 JS 加载阶段并行预取默认 x_list feed。path 严格匹配就直接用
  // 预取结果,省掉「等 JS 跑完才发请求」的串行等待;只用一次,失败/不匹配自动回退正常请求。
  const w = window as unknown as {
    __feedPrefetch?: { path: string; promise: Promise<ItemsResponse | null> } | null;
  };
  const pf = w.__feedPrefetch;
  if (pf && pf.path === path) {
    w.__feedPrefetch = null;
    try {
      // 跟 4.5s 超时赛跑:WeChat WebView 偶尔会把 fetch 丢掉永不 resolve,
      // 那样直接 await 会把 feed 永久挂住 —— 超时就回退到带重试的正常请求。
      const data = await Promise.race([
        pf.promise,
        new Promise<null>((r) => setTimeout(() => r(null), 4500)),
      ]);
      if (data && Array.isArray(data.items)) return data;
    } catch {
      /* fall through to normal fetch */
    }
  }
  const res = await apiFetch(path);
  if (!res.ok) throw new Error(`fetchItems failed: ${res.status}`);
  return res.json();
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
