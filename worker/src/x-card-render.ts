// X 卡片渲染 P2(拼 payload)+ P3(调 Codex 渲染 API → 转存 R2)。
// 设计:docs/plans/2026-06-04-x-card-render-api.md
//
// 流程:itemId → 从 D1 拼扁平 payload(媒体/头像走 P0 的 R2 稳定链接)→ render_key(tweet_id+内容哈希)
//   → 查我侧 R2 缓存命中则直接返;否则 POST Codex(Bearer token,Accept image/png)→ 收 PNG 字节
//   → put 到 R2 `x-card/<render_key>.png` → 返 https://<apiBase>/r/x-card/<render_key>.png
//
// Codex 约定(2026-06-05 确认):
//   - 端点 POST http://82.156.0.68/aifeeds/api/render/x-card,成功 200 image/png(Header X-Render-Key)
//   - 失败 JSON {error,message};401/400/413/500;4xx 不重试,5xx/网络超时重试 1 次
//   - 限流保守:uncached 并发 1、3-5s/张;render_key 幂等(Codex 侧也缓存)
//   - v1 只处理 media type=image;纯视频发 poster 当 image;固定 1080x1440

import type { Env } from './index';
import { getBases } from './digest/lib';
import { migrateXMediaForItem } from './x-media-r2';

// 2026-06-05 Codex 切到 HTTPS 域名端点(避免 token 明文 + 绕开 Worker 调 IP literal 触发的网络层拦截)。
// 旧 http://82.156.0.68 端点 Worker 调会 403(疑似腾讯云/宝塔全局 IP 黑名单,请求没进 nginx)。
const DEFAULT_ENDPOINT = 'https://ai-feeds.cc/aifeeds/api/render/x-card';
const RENDER_TIMEOUT_MS = 60_000;

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface XItemRow {
  id: string; source_id: string;
  content: string | null; content_translated: string | null;
  author: string | null; handle: string | null; url: string | null;
  media: string | null; extra: string | null; metrics: string | null;
  lang: string | null; published_at: string | null;
}

interface XCardPayload {
  render_key: string;
  tweet: { id: string; lang: string | null; text: string; text_zh: string | null; summary_zh: string | null; permalink: string | null; created_at: string | null };
  author: { name: string; handle: string; avatar_url: string | null; verified: boolean };
  media: Array<{ type: 'image'; url: string; width: number | null; height: number | null }>;
  metrics: { likes: number | null; reposts: number | null; replies: number | null; views: number | null };
  style: { variant: string; size: string };
}

function toIso(d: string | null): string | null {
  if (!d) return null;
  // D1 "YYYY-MM-DD HH:MM:SS"(UTC)→ ISO 8601
  const t = new Date(d.replace(' ', 'T') + 'Z');
  return isNaN(t.getTime()) ? null : t.toISOString();
}
function intOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}

// P2:拼 payload(确保媒体已 R2)。返回 null = item 不存在。
export async function buildXCardPayload(env: Env, itemId: string): Promise<XCardPayload | null> {
  const sel = `SELECT id, source_id, content, content_translated, author, handle, url, media, extra, metrics, lang, published_at
                 FROM items WHERE id = ? AND source_type = 'x_list'`;
  let row = await env.DB.prepare(sel).bind(itemId).first<XItemRow>();
  if (!row) return null;

  // 按需:媒体没迁过 R2 就先迁(让 payload 里都是稳定 R2 链接),迁完重读。
  let ex: Record<string, unknown> = {};
  try { ex = JSON.parse(row.extra || '{}'); } catch { /* ignore */ }
  if (!ex.x_media_r2_at && env.READMES) {
    try { await migrateXMediaForItem(env, itemId); } catch { /* 失败不阻塞,用原链接 */ }
    row = (await env.DB.prepare(sel).bind(itemId).first<XItemRow>()) || row;
    try { ex = JSON.parse(row.extra || '{}'); } catch { /* ignore */ }
  }

  const { apiBase } = getBases(env);
  const abs = (u: string | null | undefined): string | null => (!u ? null : u.startsWith('http') ? u : `${apiBase}${u}`);

  let mediaArr: Array<Record<string, unknown>> = [];
  try { mediaArr = JSON.parse(row.media || '[]'); } catch { /* ignore */ }
  const media: XCardPayload['media'] = [];
  for (const m of mediaArr) {
    // v1 只发 image;视频用 poster 当 image。
    const isVideo = m.type === 'video';
    const src = isVideo ? (m.poster as string | undefined) : (m.url as string | undefined);
    if (!src) continue;
    const u = abs(src);
    if (!u) continue;
    media.push({ type: 'image', url: u, width: intOrNull(m.width), height: intOrNull(m.height) });
  }

  let mt: Record<string, unknown> = {};
  try { mt = JSON.parse(row.metrics || '{}'); } catch { /* ignore */ }

  const sourceId = row.source_id;
  const isZh = row.lang === 'zh' || row.lang === 'zh-cn' || row.lang === 'zh-tw';
  const textZh = !isZh ? (row.content_translated || null) : null;
  const summaryZh = (ex.ai_summary as string) || null;

  // render_key = tweet_id + 内容哈希(内容变了重渲;只覆盖影响成图的字段)
  const hashInput = JSON.stringify({
    t: row.content || '', tz: textZh || '', s: summaryZh || '',
    m: media.map((x) => x.url), mt: { l: mt.likes, r: mt.retweets, rp: mt.replies, v: mt.views },
    a: abs((ex.profile_image_url as string) || null),
  });
  const renderKey = `${sourceId}-${(await sha256Hex(hashInput)).slice(0, 12)}`;

  return {
    render_key: renderKey,
    tweet: {
      id: sourceId, lang: row.lang,
      text: row.content || '', text_zh: textZh, summary_zh: summaryZh,
      permalink: row.url, created_at: toIso(row.published_at),
    },
    author: {
      name: row.author || row.handle || '', handle: row.handle || '',
      avatar_url: abs((ex.profile_image_url as string) || null), verified: !!ex.is_verified,
    },
    media,
    metrics: {
      likes: intOrNull(mt.likes), reposts: intOrNull(mt.retweets),
      replies: intOrNull(mt.replies), views: intOrNull(mt.views),
    },
    style: { variant: 'daily-x-v1', size: '1080x1440' },
  };
}

export interface XCardRenderResult {
  ok: boolean;
  render_key?: string;
  url?: string;        // 最终对外 https R2 链接
  cached?: boolean;    // true=命中我侧 R2,没调 Codex
  error?: string;
  status?: number;
}

// P3:渲染 + 转存。幂等(我侧 R2 命中直接返);失败按 Codex 约定处理。
export async function renderXCardViaCodex(env: Env, itemId: string): Promise<XCardRenderResult> {
  if (!env.X_CARD_SHARED_TOKEN) return { ok: false, error: 'no_token' };
  if (!env.READMES) return { ok: false, error: 'no_r2_binding' };

  const payload = await buildXCardPayload(env, itemId);
  if (!payload) return { ok: false, error: 'item_not_found' };

  const { apiBase } = getBases(env);
  const r2Key = `x-card/${payload.render_key}.png`;
  const publicUrl = `${apiBase}/r/${r2Key}`;

  // 我侧 R2 幂等:命中直接返,连 Codex 都不调。
  const existing = await env.READMES.head(r2Key);
  if (existing) return { ok: true, render_key: payload.render_key, url: publicUrl, cached: true };

  const endpoint = env.X_CARD_RENDER_ENDPOINT || DEFAULT_ENDPOINT;
  let lastErr = 'unknown';
  // 5xx/网络:重试 1 次;4xx:不重试。
  for (let attempt = 1; attempt <= 2; attempt++) {
    let resp: Response;
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), RENDER_TIMEOUT_MS);
      resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.X_CARD_SHARED_TOKEN}`,
          'Content-Type': 'application/json',
          Accept: 'image/png',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(tid);
    } catch (e) {
      lastErr = `network_${e instanceof Error ? e.name : 'err'}`;
      if (attempt === 1) continue; // 网络错误重试 1 次
      return { ok: false, error: lastErr };
    }

    if (resp.status >= 500) {
      lastErr = `http_${resp.status}`;
      if (attempt === 1) continue; // 5xx 重试 1 次
      const body = await resp.json<{ error?: string; message?: string }>().catch(() => ({}));
      return { ok: false, error: body.error || lastErr, status: resp.status };
    }
    if (!resp.ok) {
      // 4xx:不重试,记录校验问题。
      const body = await resp.json<{ error?: string; message?: string }>().catch(() => ({}));
      return { ok: false, error: body.error || `http_${resp.status}`, status: resp.status };
    }

    // 200 image/png → 转存 R2
    const buf = await resp.arrayBuffer();
    if (!buf.byteLength) return { ok: false, error: 'empty_png' };
    await env.READMES.put(r2Key, buf, {
      httpMetadata: { contentType: 'image/png' },
      customMetadata: { render_key: payload.render_key, source: 'x-card', item: itemId },
    });
    console.log(`[x-card-render] ${itemId}: rendered ${payload.render_key} (${buf.byteLength}B) → ${publicUrl}`);
    return { ok: true, render_key: payload.render_key, url: publicUrl, cached: false };
  }
  return { ok: false, error: lastErr };
}
