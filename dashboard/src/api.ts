import type { ItemsResponse, Source, SourceType, Stats } from "./types";

const API_BASE =
  import.meta.env.VITE_API_BASE ||
  "https://api.ai-feeds.com";

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
  const url = `${API_BASE}/api/items${buildQuery(query as Record<string, unknown>)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetchItems failed: ${res.status}`);
  return res.json();
}

export async function fetchSources(): Promise<Source[]> {
  const res = await fetch(`${API_BASE}/api/sources`);
  if (!res.ok) throw new Error(`fetchSources failed: ${res.status}`);
  const data = await res.json();
  return data.sources || [];
}

export async function fetchStats(): Promise<Stats> {
  const res = await fetch(`${API_BASE}/api/stats`);
  if (!res.ok) throw new Error(`fetchStats failed: ${res.status}`);
  return res.json();
}
