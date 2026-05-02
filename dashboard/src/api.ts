import type { Item, ItemsResponse, Source, SourceType, Stats } from "./types";
import { getDeviceId } from "./lib/device";
import { track, EVENTS } from "./lib/telemetry";

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

const API_BASE = (() => {
  if (import.meta.env.VITE_API_BASE) return import.meta.env.VITE_API_BASE;
  if (typeof window !== "undefined") {
    const host = window.location.hostname;
    if (host === "localhost" || host === "127.0.0.1") {
      return "http://localhost:8788";
    }
  }
  return "https://api.ai-feeds.com";
})();

export const TRACK_ENDPOINT = `${API_BASE}/api/track`;

/**
 * 统一 fetch 包装：自动注入 X-Device-Id，失败上报 api_error，
 * 对网络错误和 5xx 自动重试一次（移动端常见的瞬时抖动）。
 * 业务 endpoint（/api/items / /api/sources 等）走这个；
 * /api/track 自身不能走（会循环），用原生 fetch。
 */
const RETRY_BACKOFF_MS = 250;

async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  const headers = new Headers(init.headers);
  headers.set('X-Device-Id', getDeviceId());

  const doFetch = () => fetch(url, { ...init, headers });

  let res: Response;
  try {
    res = await doFetch();
  } catch (e) {
    // Network error — retry once after short backoff
    try {
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
      res = await doFetch();
    } catch (e2) {
      track(EVENTS.API_ERROR, {
        endpoint: path,
        status: 0,
        error_msg: e2 instanceof Error ? e2.message : String(e2),
      });
      throw e2;
    }
  }

  // Retry once on 5xx (idempotent GET requests only — that's all we issue here)
  if (res.status >= 500 && res.status < 600) {
    await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
    try {
      res = await doFetch();
    } catch {
      // keep the original 5xx response below if the retry itself errored
    }
  }

  if (!res.ok && res.status >= 400) {
    track(EVENTS.API_ERROR, {
      endpoint: path,
      status: res.status,
    });
  }
  return res;
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

export async function fetchStats(): Promise<Stats> {
  const res = await apiFetch('/api/stats');
  if (!res.ok) throw new Error(`fetchStats failed: ${res.status}`);
  return res.json();
}
