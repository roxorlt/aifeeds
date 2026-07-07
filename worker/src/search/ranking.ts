// worker/src/search/ranking.ts
// 排序公式：final = (-bm25) × 0.5^(age_days / half_life)。
// 半衰期按源分组；调参只改这张表。
export const HALF_LIFE_DAYS: Record<string, number> = {
  x_list: 7, blog: 7, weibo: 7,
  podcast: 30, hf_paper: 30, huodongxing: 30, youtube: 30, arxiv: 30,
  github: 180, product_hunt: 180, clawhub: 180,
};
export const DEFAULT_HALF_LIFE = 30;
export const RECALL_LIMIT = 200;
export const GROUP_TOP_N = 3;
export const LIST_PAGE_SIZE = 20;

export type Hit = { source_type: string; published_at: string | null; b: number };

export function finalScore(bm25: number, publishedAt: string | null, sourceType: string, nowMs: number): number {
  const rel = -bm25; // sqlite bm25() 返回负值，越小越相关
  const ts = publishedAt ? Date.parse(publishedAt) : NaN;
  const ageDays = Number.isFinite(ts) ? Math.max(0, (nowMs - ts) / 86400000) : 365;
  const hl = HALF_LIFE_DAYS[sourceType] ?? DEFAULT_HALF_LIFE;
  return rel * Math.pow(0.5, ageDays / hl);
}

export function rankHits<T extends Hit>(hits: T[], nowMs: number): (T & { score: number })[] {
  return hits
    .map((h) => ({ ...h, score: finalScore(h.b, h.published_at, h.source_type, nowMs) }))
    .sort((a, b) => b.score - a.score);
}

export function groupHits<T extends Hit & { score: number }>(
  ranked: T[],
): { source_type: string; total: number; top: T[] }[] {
  const map = new Map<string, { source_type: string; total: number; top: T[]; best: number }>();
  for (const h of ranked) {
    let g = map.get(h.source_type);
    if (!g) { g = { source_type: h.source_type, total: 0, top: [], best: h.score }; map.set(h.source_type, g); }
    g.best = Math.max(g.best, h.score); // 组内最高分逐条更新，不依赖输入预排序
    g.total += 1;
    if (g.top.length < GROUP_TOP_N) g.top.push(h);
  }
  return [...map.values()].sort((a, b) => b.best - a.best)
    .map(({ best: _b, ...g }) => g);
}

export function encodeOffsetCursor(offset: number): string {
  return btoa(`o:${Math.max(0, Math.floor(offset))}`);
}
export function decodeOffsetCursor(cursor: string | null): number {
  if (!cursor) return 0;
  try {
    const m = /^o:(\d+)$/.exec(atob(cursor));
    return m ? Math.min(parseInt(m[1], 10), RECALL_LIMIT) : 0; // offset 语义上不会超过召回集上限

  } catch { return 0; }
}
