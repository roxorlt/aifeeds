// X 卡片渲染 P2(拼 payload)+ P3(调 Codex 渲染 API → 转存 R2)。
// 设计:docs/plans/2026-06-04-x-card-render-api.md
//
// 流程:itemId → 从 D1 拼扁平 payload(媒体/头像走 P0 的 R2 稳定链接)→ render_key(tweet_id+内容哈希)
//   → 查我侧 R2 缓存命中则直接返;否则 POST Codex(Bearer token,Accept image/png)→ 收 PNG 字节
//   → put 到 R2 `x-card/<render_key>.png` → 返 https://<apiBase>/r/x-card/<render_key>.png
//
// Codex 约定(2026-06-05 确认):
//   - 端点 POST http://${CN_RENDER_HOST}/aifeeds/api/render/x-card,成功 200 image/png(Header X-Render-Key)
//   - 失败 JSON {error,message};401/400/413/500;4xx 不重试,5xx/网络超时重试 1 次
//   - 限流保守:uncached 并发 1、3-5s/张;render_key 幂等(Codex 侧也缓存)
//   - v1 只处理 media type=image;纯视频发 poster 当 image;固定 1080x1440

import type { Env } from './index';
import { getBases } from './digest/lib';
import { migrateXMediaForItem } from './x-media-r2';
import { sbTweetToIngestItem, type SbTweet } from './scrapebadger';
import { triggerXWorkflowForItem } from './enrich';

// 2026-06-05 Codex 切到 HTTPS 域名端点(避免 token 明文 + 绕开 Worker 调 IP literal 触发的网络层拦截)。
// 旧 http://${CN_RENDER_HOST} 端点 Worker 调会 403(疑似腾讯云/宝塔全局 IP 黑名单,请求没进 nginx)。
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
      const body = await resp.json<{ error?: string; message?: string }>().catch(() => ({}) as { error?: string; message?: string });
      return { ok: false, error: body.error || lastErr, status: resp.status };
    }
    if (!resp.ok) {
      // 4xx:不重试,记录校验问题。
      const body = await resp.json<{ error?: string; message?: string }>().catch(() => ({}) as { error?: string; message?: string });
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

// ─── 渲染队列 drain（cron tick + enrich mode 共用）────────────────
// 设计:docs/plans/2026-06-05-x-card-ops-render-design.md §3。
// 取 pending,逐条渲染(串行,天然符合 Codex 并发1/3-5s)。渲染前确认 enrich 完成
// (有中文译文或本就中文 + 媒体已迁 R2),否则跳过等下轮,不渲半成品。
const MAX_RENDER_ATTEMPTS = 3;

export async function runDrainXCardRenders(
  env: Env,
  limit = 2,
): Promise<{ picked: number; rendered: number; skipped_not_ready: number; failed: number; pending_left: number }> {
  const counts = { picked: 0, rendered: 0, skipped_not_ready: 0, failed: 0, pending_left: 0 };
  if (!env.X_CARD_SHARED_TOKEN || !env.READMES) return counts;

  const rows = await env.DB.prepare(
    `SELECT item_id, attempts FROM x_card_renders WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?`,
  ).bind(Math.min(Math.max(limit, 1), 10)).all<{ item_id: string; attempts: number }>();

  for (const r of rows.results || []) {
    counts.picked++;
    // enrich 就绪检查
    const it = await env.DB.prepare(
      `SELECT content_translated, lang, json_extract(extra,'$.x_media_r2_at') AS r2 FROM items WHERE id = ? AND source_type = 'x_list'`,
    ).bind(r.item_id).first<{ content_translated: string | null; lang: string | null; r2: string | null }>();
    if (!it) {
      await env.DB.prepare(`UPDATE x_card_renders SET status='failed', error='item_gone' WHERE item_id=?`).bind(r.item_id).run();
      counts.failed++;
      continue;
    }
    const isZh = it.lang === 'zh' || it.lang === 'zh-cn' || it.lang === 'zh-tw';
    const ready = (isZh || !!it.content_translated) && !!it.r2;
    if (!ready) { counts.skipped_not_ready++; continue; } // 留 pending,等下轮

    await env.DB.prepare(`UPDATE x_card_renders SET status='rendering' WHERE item_id=?`).bind(r.item_id).run();
    const res = await renderXCardViaCodex(env, r.item_id);
    const now = Math.floor(Date.now() / 1000);
    if (res.ok) {
      await env.DB.prepare(
        `UPDATE x_card_renders SET status='ok', image_url=?, render_key=?, rendered_at=?, error=NULL WHERE item_id=?`,
      ).bind(res.url || null, res.render_key || null, now, r.item_id).run();
      counts.rendered++;
    } else {
      const nextAttempts = r.attempts + 1;
      const nextStatus = nextAttempts >= MAX_RENDER_ATTEMPTS ? 'failed' : 'pending';
      await env.DB.prepare(
        `UPDATE x_card_renders SET status=?, error=?, attempts=? WHERE item_id=?`,
      ).bind(nextStatus, res.error || 'render_failed', nextAttempts, r.item_id).run();
      counts.failed++;
    }
  }

  const left = await env.DB.prepare(`SELECT COUNT(*) AS n FROM x_card_renders WHERE status='pending'`).first<{ n: number }>();
  counts.pending_left = left?.n ?? 0;
  return counts;
}

// ─── 手动添加(Phase D):解析 URL → 不在库则抓取入库 → 入队 ────────
// 支持 x.com/twitter.com/.../status/<id>、ai-feeds.com(/staging)/t/<id>、裸数字 id。
const TWEET_ID_RES: RegExp[] = [
  /(?:x\.com|twitter\.com)\/[^/]+\/status\/(\d+)/i,
  /\/t\/(\d+)/, // aifeeds 抽屉深链
  /^(\d{8,25})$/, // 裸 tweet id
];
function parseTweetId(raw: string): string | null {
  const s = (raw || '').trim();
  for (const re of TWEET_ID_RES) {
    const m = s.match(re);
    if (m) return m[1];
  }
  return null;
}

async function fetchSbTweetById(env: Env, id: string): Promise<SbTweet | null> {
  if (!env.SCRAPEBADGER_API_KEY) return null;
  try {
    const r = await fetch(`https://scrapebadger.com/v1/twitter/tweets/?tweets=${id}`, {
      headers: { 'x-api-key': env.SCRAPEBADGER_API_KEY, Accept: 'application/json' },
    });
    if (!r.ok) return null;
    const body = (await r.json()) as { data?: SbTweet[] };
    return body.data?.[0] || null;
  } catch (e) {
    console.error(`[x-card-manual] SB fetch ${id}:`, e);
    return null;
  }
}

export async function addManualXCardRender(
  env: Env,
  url: string,
): Promise<{ ok: boolean; item_id?: string; tweet_id?: string; ingested?: boolean; status?: string; error?: string }> {
  const tweetId = parseTweetId(url);
  if (!tweetId) return { ok: false, error: 'bad_url' };
  const itemId = `x_list:${tweetId}`;

  const existing = await env.DB.prepare(
    `SELECT 1 AS x FROM items WHERE id = ? AND source_type = 'x_list'`,
  ).bind(itemId).first<{ x: number }>();

  let ingested = false;
  if (!existing) {
    const t = await fetchSbTweetById(env, tweetId);
    if (!t) return { ok: false, error: 'tweet_not_found' };
    const item = sbTweetToIngestItem(t);
    if (!item) return { ok: false, error: 'ingest_failed' };
    // 手动添加 = operator 主动选,强制 is_relevant=1 让 workflow 翻译它(否则 classify
    // 可能判 0 → 不翻译 → 渲染就绪检查永远等不到译文)。
    await env.DB.prepare(`
      INSERT INTO items (id, source_type, source_id, title, content,
        content_translated, author, handle, url, media, metrics, published_at,
        scraped_at, is_relevant, matched_by, lang, extra)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).bind(
      itemId, item.source_type, item.source_id, item.title, item.content,
      item.content_translated, item.author, item.handle, item.url, item.media, item.metrics,
      item.published_at, item.scraped_at, 'x-card-manual', item.lang, item.extra,
    ).run();

    await triggerXWorkflowForItem(env, itemId, {
      hasQuoteRef: !!t.quoted_status_id,
      hasReplyRef: !!t.in_reply_to_status_id,
      hasLinkCard: !!t.has_card,
      hasRetweetRef: !!(t.is_retweet || t.retweeted_status_id),
    });
    ingested = true;
  }

  await enqueueXCardRender(env, itemId, 'manual');
  return { ok: true, item_id: itemId, tweet_id: tweetId, ingested, status: 'pending' };
}

// 入队 helper(detect 自动 + 手动添加共用)。
export async function enqueueXCardRender(env: Env, itemId: string, source: 'pool-auto' | 'manual'): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  // manual 重新入队 → 覆盖重置;pool-auto 已存在则不动(避免重复入队)。
  if (source === 'manual') {
    await env.DB.prepare(
      `INSERT INTO x_card_renders (item_id, status, source, attempts, created_at)
       VALUES (?, 'pending', 'manual', 0, ?)
       ON CONFLICT(item_id) DO UPDATE SET status='pending', source='manual', attempts=0, error=NULL, created_at=?`,
    ).bind(itemId, now, now).run();
  } else {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO x_card_renders (item_id, status, source, attempts, created_at)
       VALUES (?, 'pending', 'pool-auto', 0, ?)`,
    ).bind(itemId, now).run();
  }
}
