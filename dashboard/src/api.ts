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
const RETRY_BACKOFFS_MS = [200, 600] as const; // 重试 2 次 = 共 3 次 attempt

async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  const headers = new Headers(init.headers);
  headers.set('X-Device-Id', getDeviceId());

  // Each attempt is wrapped in its own AbortController so a single hung
  // request can't block the entire retry chain. WeChat WebView is known
  // to occasionally drop fetches without erroring out, leaving them
  // pending forever.
  const tryOnce = async (): Promise<Response> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, headers, credentials: 'include', signal: ctrl.signal });
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
      await new Promise((r) => setTimeout(r, RETRY_BACKOFFS_MS[attempt - 1]));
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
      lastErr = e;
      // Last attempt — give up
      if (attempt >= RETRY_BACKOFFS_MS.length) {
        track(EVENTS.API_ERROR, {
          endpoint: path,
          status: 0,
          error_msg: e instanceof Error ? e.message : String(e),
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
  source_type?: SourceType | SourceType[];
  since?: string;
  until?: string;
  relevant?: 0 | 1;
  limit?: number;
  cursor?: string;
  sort?: "scraped_at" | "published_at" | "hot";
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

export async function fetchStats(): Promise<Stats> {
  const res = await apiFetch('/api/stats');
  if (!res.ok) throw new Error(`fetchStats failed: ${res.status}`);
  return res.json();
}
