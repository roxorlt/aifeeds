// 日报内容推送 Codex 渲染机:早 8 点 digest_pool 快照(normal 档,ph/gh/hf-paper 三源)
// → 复用 renderItem 产出完整条目(cover + media + 全字段)→ POST Codex daily/ingest。
// 设计:docs/plans/2026-06-05-daily-codex-push-design.md
//
// 非阻塞:任何失败都只 PushDeer 告警 + 返回结果,绝不抛错(不影响订阅邮件投递)。
// token 复用 X_CARD_SHARED_TOKEN,绝不进 payload / log / 前端。

import type { Env } from '../index';
import { type DigestSource } from './config';
import { slotKey, bjtDateStr, getBases } from './lib';
import { renderItem, type RenderRow, type RenderedItem } from './render';
import { SOURCE_LABELS } from './templates';
import { pushDeerAlert } from '../notifier';

const DEFAULT_DAILY_ENDPOINT = 'https://ai-feeds.cc/aifeeds/api/daily/ingest';
const PUSH_TIMEOUT_MS = 30_000;
// Codex 当前只渲这 3 源(X/clawhub 暂不打包,等模板扩展)
const PUSH_SOURCES: DigestSource[] = ['ph', 'gh', 'hf-paper'];

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Codex item:cover 顶层 + media/logo 进 raw(满足 Codex「多图从 raw.media[] 收集」规则)
interface CodexItem {
  rank: number;
  source: DigestSource;
  title: string;
  summary: string;
  summary_full: string;
  url: string;
  deep_link: string;
  author: string;
  cover: string | null;
  item_id: string;
  raw: { media: RenderedItem['media']; logo: string | null };
}

function toCodexItem(r: RenderedItem): CodexItem {
  return {
    rank: r.rank,
    source: r.source,
    title: r.title,
    summary: r.summary,
    summary_full: r.summary_full,
    url: r.url,
    deep_link: r.deep_link,
    author: r.author,
    cover: r.cover,
    item_id: r.item_id,
    raw: { media: r.media, logo: r.logo },
  };
}

async function fetchRows(env: Env, ids: string[]): Promise<Map<string, RenderRow>> {
  if (!ids.length) return new Map();
  const ph = ids.map(() => '?').join(',');
  const r = await env.DB.prepare(
    `SELECT id, title, content, content_translated, author, handle, url, media, extra
     FROM items WHERE id IN (${ph})`,
  )
    .bind(...ids)
    .all<RenderRow>();
  return new Map((r.results || []).map((row) => [row.id, row]));
}

function safeIds(s: string | null): string[] {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

export interface DailyCodexPayload {
  render_key: string;
  date: string;
  density: 'normal';
  title: string;
  source: string;
  digest: {
    meta: {
      generated_at: string;
      density: 'normal';
      source_order: DigestSource[];
      source_labels: Record<string, string>;
    };
    sections: {
      normal: Array<{ source: DigestSource; source_label: string; count: number; items: CodexItem[] }>;
    };
  };
}

// 读 8 点 digest_pool 快照(= 当天邮件用的同一份内容)→ 复用 renderItem → 组 Codex payload。
export async function buildDailyCodexPayload(
  env: Env,
  slotHourBjt = 8,
): Promise<DailyCodexPayload> {
  const sk = slotKey(slotHourBjt);
  const date = bjtDateStr();
  const { apiBase } = getBases(env);

  const sections: DailyCodexPayload['digest']['sections']['normal'] = [];
  const hashParts: string[] = [];

  for (const source of PUSH_SOURCES) {
    const pool = await env.DB.prepare(
      `SELECT item_ids FROM digest_pool WHERE slot_key = ? AND source = ? AND density = 'normal'`,
    )
      .bind(sk, source)
      .first<{ item_ids: string }>();
    const ids = safeIds(pool?.item_ids ?? null);
    if (!ids.length) continue;
    const rows = await fetchRows(env, ids);
    const items: CodexItem[] = [];
    ids.forEach((id, i) => {
      const row = rows.get(id);
      if (!row) return;
      const rendered = renderItem(source, row, i + 1, apiBase);
      items.push(toCodexItem(rendered));
      hashParts.push(`${id}|${rendered.title}`);
    });
    if (!items.length) continue;
    sections.push({ source, source_label: SOURCE_LABELS[source] || source, count: items.length, items });
  }

  // 内容指纹幂等:item_ids + title 变了才换 render_key(Codex 命中同 key 不重复生成)
  const hash8 = (await sha256Hex(hashParts.join('\n'))).slice(0, 8);
  const generatedAt =
    new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' (BJT)';

  return {
    render_key: `daily-${date}-normal-${hash8}`,
    date,
    density: 'normal',
    title: `AI Feeds ${date} 日报`,
    source: 'cloudflare-daily',
    digest: {
      meta: {
        generated_at: generatedAt,
        density: 'normal',
        source_order: PUSH_SOURCES,
        source_labels: Object.fromEntries(PUSH_SOURCES.map((s) => [s, SOURCE_LABELS[s] || s])),
      },
      sections: { normal: sections },
    },
  };
}

export interface DailyPushResult {
  ok: boolean;
  skipped?: string;
  render_key?: string;
  total_items?: number;
  codex_id?: string;
  codex_status?: string;
  error?: string;
}

// 构造 payload + POST Codex。内部对 5xx/网络错重试一次。永不抛错(非阻塞)。
export async function pushDailyToCodex(env: Env, slotHourBjt = 8): Promise<DailyPushResult> {
  if (!env.X_CARD_SHARED_TOKEN) return { ok: false, skipped: 'no_token' };

  let payload: DailyCodexPayload;
  try {
    payload = await buildDailyCodexPayload(env, slotHourBjt);
  } catch (e) {
    const error = String(e).slice(0, 200);
    await pushDeerAlert(env, '日报推 Codex 失败', `构造 payload 异常: ${error}`).catch(() => {});
    return { ok: false, error };
  }

  const total = payload.digest.sections.normal.reduce((n, s) => n + s.count, 0);
  if (!total) return { ok: false, skipped: 'empty_pool', render_key: payload.render_key };

  const endpoint = env.DAILY_PUSH_ENDPOINT || DEFAULT_DAILY_ENDPOINT;
  const body = JSON.stringify(payload);

  const attempt = async (): Promise<Response> => {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);
    try {
      return await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.X_CARD_SHARED_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(tid);
    }
  };

  let res: Response;
  try {
    res = await attempt();
    if (res.status >= 500) res = await attempt(); // 5xx 重试一次
  } catch (e) {
    // 网络/超时:重试一次
    try {
      res = await attempt();
    } catch (e2) {
      const error = `network: ${String(e2).slice(0, 160)}`;
      await pushDeerAlert(env, '日报推 Codex 失败', `${payload.render_key}: ${error}`).catch(() => {});
      return { ok: false, error, render_key: payload.render_key, total_items: total };
    }
  }

  if (!res.ok) {
    const txt = (await res.text().catch(() => '')).slice(0, 200);
    const error = `http_${res.status}: ${txt}`;
    await pushDeerAlert(env, '日报推 Codex 失败', `${payload.render_key}: ${error}`).catch(() => {});
    return { ok: false, error, render_key: payload.render_key, total_items: total };
  }

  // Codex 返回 202 { id, status, ... }
  const data = (await res.json().catch(() => ({}))) as { id?: string; status?: string };
  console.log(`[daily-codex-push] ${payload.render_key} items=${total} → id=${data.id} status=${data.status}`);
  return {
    ok: true,
    render_key: payload.render_key,
    total_items: total,
    codex_id: data.id,
    codex_status: data.status,
  };
}
