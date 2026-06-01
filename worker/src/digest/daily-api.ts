// GET /api/digest/daily — 对外日报 JSON API(Bearer key 鉴权,实时选品)。
// 用途:受信设备 agent 定时带 key 取"此刻往前 24h"的 AI 精选,做下游分发(图/视频/转载)。
//
// 鉴权:Authorization: Bearer <DIGEST_API_KEY>(prod secret)。缺/错 → 401。
// 参数:
//   density  normal | curated | both(默认 both)  —— normal=默认档,curated=AI精选(更少更精,走 LLM)
//   sources  csv 子集(默认全部 5 源),如 ?sources=ph,gh
//   verbose  0|1(默认 0)。1 时每条附 raw 原始字段(不缓存,调试用)
// 实时:每次现跑 selectTopForSource(normal,纯 SQL)+ curateSource(curated,DeepSeek)。
//   curated 烧 token,故同参数结果 KV 缓存 15min(verbose 不缓存)。
// 注:实时模式取"此刻最新",非历史快照;要历史某天需读 digest_pool(后续可加)。

import type { Env } from '../index';
import {
  DIGEST_SOURCE_ORDER,
  SOURCE_DIGEST_CONFIG,
  CURATED_CANDIDATE_POOL,
  type DigestSource,
  type Density,
} from './config';
import { selectTopForSource } from './selection';
import { curateSource } from './llm-curate';
import { fetchCandidates } from './node-run';
import { renderItem, type RenderRow, type RenderedItem } from './render';
import { getBases } from './lib';
import { SOURCE_LABELS } from './templates';

function jsonRes(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

interface DailySection {
  source: DigestSource;
  source_label: string;
  count: number;
  items: Array<RenderedItem & { raw?: Record<string, unknown> }>;
}

// 拉候选 id 的渲染所需全字段(一次拉,normal + curated 共用)
async function fetchRows(env: Env, ids: string[]): Promise<Map<string, RenderRow & { content: string | null }>> {
  if (!ids.length) return new Map();
  const ph = ids.map(() => '?').join(',');
  const r = await env.DB.prepare(
    `SELECT id, title, content, content_translated, author, handle, url, media, extra, metrics, published_at
     FROM items WHERE id IN (${ph})`,
  )
    .bind(...ids)
    .all<RenderRow & { content: string | null; metrics: string | null; published_at: number | null }>();
  return new Map((r.results || []).map((row) => [row.id, row]));
}

function toRaw(row: Record<string, unknown>): Record<string, unknown> {
  const parse = (s: unknown) => {
    if (typeof s !== 'string') return s ?? null;
    try {
      return JSON.parse(s);
    } catch {
      return s;
    }
  };
  return {
    title: row.title ?? null,
    content: row.content ?? null,
    content_translated: row.content_translated ?? null,
    author: row.author ?? null,
    handle: row.handle ?? null,
    url: row.url ?? null,
    published_at: row.published_at ?? null,
    media: parse(row.media),
    metrics: parse(row.metrics),
    extra: parse(row.extra),
  };
}

function buildSection(
  source: DigestSource,
  ids: string[],
  rows: Map<string, RenderRow & { content: string | null }>,
  apiBase: string,
  verbose: boolean,
): DailySection {
  const items: Array<RenderedItem & { raw?: Record<string, unknown> }> = [];
  ids.forEach((id, i) => {
    const row = rows.get(id);
    if (!row) return;
    const rendered = renderItem(source, row, i + 1, apiBase);
    items.push(verbose ? { ...rendered, raw: toRaw(row as Record<string, unknown>) } : rendered);
  });
  return { source, source_label: SOURCE_LABELS[source] || source, count: items.length, items };
}

export async function handleDigestDaily(request: Request, env: Env): Promise<Response> {
  // ── 鉴权 ──
  const auth = request.headers.get('Authorization') || '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!env.DIGEST_API_KEY) return jsonRes({ error: 'api_not_configured' }, 503);
  if (!key || key !== env.DIGEST_API_KEY) {
    return jsonRes({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer' });
  }

  // ── 参数 ──
  const url = new URL(request.url);
  const densityParam = (url.searchParams.get('density') || 'both').toLowerCase();
  if (!['normal', 'curated', 'both'].includes(densityParam)) {
    return jsonRes({ error: 'invalid_density', allowed: ['normal', 'curated', 'both'] }, 400);
  }
  const verbose = url.searchParams.get('verbose') === '1';
  const sourcesParam = url.searchParams.get('sources');
  const wantSources = sourcesParam
    ? sourcesParam.split(',').map((s) => s.trim()).filter((s): s is DigestSource => (DIGEST_SOURCE_ORDER as readonly string[]).includes(s))
    : [...DIGEST_SOURCE_ORDER];
  if (!wantSources.length) return jsonRes({ error: 'invalid_sources', allowed: DIGEST_SOURCE_ORDER }, 400);

  const wantNormal = densityParam !== 'curated';
  const wantCurated = densityParam !== 'normal';
  const { apiBase } = getBases(env);

  // ── 缓存(防频繁实时 curated 烧 token;verbose 含 raw 不缓存)──
  const win = Math.floor(Date.now() / (15 * 60 * 1000));
  const cacheKey = `digestapi:v1:${densityParam}:${wantSources.join(',')}:${win}`;
  if (env.AUTH_KV && !verbose) {
    const cached = await env.AUTH_KV.get(cacheKey);
    if (cached) return new Response(cached, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Cache': 'HIT' } });
  }

  // ── 实时选品 + 渲染 ──
  const normalSecs: DailySection[] = [];
  const curatedSecs: DailySection[] = [];
  for (const source of DIGEST_SOURCE_ORDER) {
    if (!wantSources.includes(source)) continue;
    const cfg = SOURCE_DIGEST_CONFIG[source];
    const candidateIds = await selectTopForSource(env, source, CURATED_CANDIDATE_POOL);
    if (!candidateIds.length) continue;
    const rows = await fetchRows(env, candidateIds);
    if (wantNormal) {
      normalSecs.push(buildSection(source, candidateIds.slice(0, cfg.normal), rows, apiBase, verbose));
    }
    if (wantCurated) {
      const cands = await fetchCandidates(env, source, candidateIds);
      const curatedIds = await curateSource(env, source, cands, cfg.curated);
      curatedSecs.push(buildSection(source, curatedIds, rows, apiBase, verbose));
    }
  }

  const nowMs = Date.now();
  const result = {
    meta: {
      mode: 'realtime',
      generated_at: new Date(nowMs + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' (BJT)',
      density: densityParam,
      sources_requested: wantSources,
      source_order: DIGEST_SOURCE_ORDER,
      source_labels: SOURCE_LABELS,
      note: '实时选品(此刻往前 24h),非历史快照;同参数结果 15min 缓存。rank=该源热度排名;cover 无图为 null(gh=owner头像,x仅推文附图,clawhub无)。',
    },
    sections: {
      ...(wantNormal ? { normal: normalSecs } : {}),
      ...(wantCurated ? { curated: curatedSecs } : {}),
    },
  };

  const body = JSON.stringify(result);
  if (env.AUTH_KV && !verbose) {
    await env.AUTH_KV.put(cacheKey, body, { expirationTtl: 900 });
  }
  return new Response(body, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Cache': 'MISS' } });
}
