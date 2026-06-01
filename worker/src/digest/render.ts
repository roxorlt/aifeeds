// digest 渲染共享纯函数:把 items 行按源转成对外 JSON 条目(rank + cover + 中文 title/summary)。
// 供 daily-api 实时渲染用。逻辑与 deliver.ts toDigestItem 对齐(clawhub 用 summary_translated);
// cover 取值对齐前端流内卡片:ph=媒体logo / gh=owner头像 / hf=社交缩略图 / x=推文附图 / clawhub=无。
// (deliver.ts 暂保留自己的私有副本,不在本次重构,避免动邮件链路。)

import type { DigestSource } from './config';

export interface RenderRow {
  id: string;
  title: string | null;
  content: string | null;
  content_translated: string | null;
  author: string | null;
  handle: string | null;
  url: string | null;
  media: string | null; // JSON string
  extra: string | null; // JSON string
}

export interface RenderedItem {
  rank: number; // 该源热度排名(1-based)
  item_id: string;
  source: DigestSource;
  title: string;
  summary: string; // 截断到 ~180,跟邮件一致
  summary_full: string; // 完整(静态页可用更长)
  url: string;
  deep_link: string; // 站内抽屉深链
  author: string;
  cover: string | null; // 封面图,相对路径已拼 apiBase;无图 null
}

export function cleanText(s: string): string {
  return (s || '').replace(/[#*`>_~]/g, '').replace(/\s+/g, ' ').trim();
}

export function clampSentences(s: string, maxLen = 180): string {
  const clean = cleanText(s);
  if (clean.length <= maxLen) return clean;
  const slice = clean.slice(0, maxLen);
  const lastPunct = Math.max(
    slice.lastIndexOf('。'),
    slice.lastIndexOf('！'),
    slice.lastIndexOf('？'),
    slice.lastIndexOf('；'),
  );
  return lastPunct > maxLen * 0.5 ? slice.slice(0, lastPunct + 1) : slice + '…';
}

export function deepLinkPath(itemId: string): string {
  const idx = itemId.indexOf(':');
  if (idx < 0) return '/';
  const st = itemId.slice(0, idx);
  const sid = itemId.slice(idx + 1);
  switch (st) {
    case 'x_list':
      return `/t/${encodeURIComponent(sid)}`;
    case 'github': {
      const [o, r] = sid.split('/');
      return o && r ? `/g/${encodeURIComponent(o)}/${encodeURIComponent(r)}` : '/';
    }
    case 'product_hunt': {
      const [slug, date] = sid.split(':');
      return slug && date ? `/ph/${encodeURIComponent(slug)}/${encodeURIComponent(date)}` : '/';
    }
    case 'clawhub':
      return `/c/${encodeURIComponent(sid)}`;
    case 'hf_paper':
      return `/h/${encodeURIComponent(sid)}`;
    default:
      return '/';
  }
}

function ghRepoName(itemId: string): string {
  const idx = itemId.indexOf(':');
  const sid = idx >= 0 ? itemId.slice(idx + 1) : itemId;
  const slash = sid.lastIndexOf('/');
  return slash >= 0 ? sid.slice(slash + 1) : sid;
}

function ghOwner(itemId: string): string {
  const idx = itemId.indexOf(':');
  const sid = idx >= 0 ? itemId.slice(idx + 1) : itemId;
  return sid.split('/')[0] || '';
}

function safeParse(s: string | null): Record<string, unknown> {
  try {
    return JSON.parse(s || '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

// 封面图(对齐前端流内卡片 + 用户规则:gh/hf/ph 取真图,x 仅推文附图,clawhub 不取头像)
function pickCover(source: DigestSource, row: RenderRow, ex: Record<string, unknown>, apiBase: string): string | null {
  const abs = (u: string | null | undefined): string | null =>
    !u ? null : u.startsWith('http') ? u : `${apiBase}${u}`;
  let media: unknown = null;
  try {
    media = JSON.parse(row.media || 'null');
  } catch {
    /* ignore */
  }
  const imgs = Array.isArray(media)
    ? (media as Array<Record<string, unknown>>).filter((m) => m && m.type === 'image' && m.url)
    : [];
  switch (source) {
    case 'ph': {
      const logo = imgs.find((m) => m.role === 'logo') || imgs[0];
      if (logo) return abs(logo.url as string);
      return (ex.cover_image as string) || (ex.video_thumbnail as string) || null;
    }
    case 'gh':
      return `https://avatars.githubusercontent.com/${ghOwner(row.id)}`;
    case 'hf-paper': {
      if (imgs.length) return abs(imgs[0].url as string);
      const fig = ex.figure_image as Record<string, unknown> | undefined;
      if (fig && typeof fig === 'object' && fig.r2_url) return abs(fig.r2_url as string);
      return null;
    }
    case 'x':
      return imgs.length ? abs(imgs[0].url as string) : null; // 仅推文附图,无图不用头像
    case 'clawhub':
      return null; // 不用作者头像
    default:
      return null;
  }
}

export function renderItem(source: DigestSource, row: RenderRow, rank: number, apiBase: string): RenderedItem {
  const ex = safeParse(row.extra);
  const ct = row.content_translated || '';
  const body = ct || row.content || '';
  let title: string;
  let summary: string;
  switch (source) {
    case 'gh':
      title = ghRepoName(row.id);
      summary = (ex.ai_summary as string) || ct;
      break;
    case 'ph':
      title = row.title || '';
      summary = (ex.ai_summary as string) || ct;
      break;
    case 'hf-paper':
      title = (ex.ai_summary_zh as string) || row.title || '';
      summary = (ex.summary_zh as string) || (ex.ai_summary_zh as string) || '';
      break;
    case 'x':
      title = (ex.ai_summary as string) || body.slice(0, 60);
      summary = ct || row.content || '';
      break;
    case 'clawhub':
      title = row.title || '';
      summary = (ex.summary_translated as string) || (ex.summary_en as string) || ct;
      break;
    default:
      title = row.title || body.slice(0, 60);
      summary = body;
  }
  return {
    rank,
    item_id: row.id,
    source,
    title: cleanText(title || '(无标题)').slice(0, 120),
    summary: clampSentences(summary),
    summary_full: cleanText(summary),
    url: row.url || '',
    deep_link: deepLinkPath(row.id),
    author: row.author || row.handle || '',
    cover: pickCover(source, row, ex, apiBase),
  };
}
