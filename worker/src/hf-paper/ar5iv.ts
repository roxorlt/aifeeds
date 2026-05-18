// Step 1 helper:fetch-ar5iv-and-extract-figure(NEW #1)
// Step 2 helper:translate-ar5iv(段落级 flash 翻译)
//
// - fetch ar5iv HTML: https://ar5iv.labs.arxiv.org/html/<arxiv_id>
// - extract first qualifying figure(arxiv chrome 排除 + dimensions ≥ 300×200 +
//   aspect ratio 1:4 ~ 4:1)→ 迁 R2 → 写 media[0] + extra.figure_image
// - parse paragraphs(<p> inside <div class="ltx_para"> 等)→ store as R2 JSON
//   (避免 D1 行爆 1MB cap)→ flash 批量翻译

import type { Env } from '../index';
import { callDeepSeek, DEEPSEEK_FLASH } from './llm';
import { buildAr5ivParagraphPrompt } from './prompts';

const AR5IV_BASE = 'https://ar5iv.labs.arxiv.org/html';
const R2_KEY_PREFIX_FIGURE = 'hf';
const R2_KEY_PREFIX_AR5IV = 'hf-paper-ar5iv';

// 论文 figure 提取的排除规则
const ARXIV_CHROME_PATH_RE = /\/static\/browse\//i;
const ARXIV_CHROME_HOSTS = new Set(['arxiv.org', 'static.arxiv.org']);

const MIN_FIGURE_DIM = 200;        // 最小 width 或 height
const FIGURE_MAX_BYTES = 2 * 1024 * 1024;  // 2 MB cap

const ALLOWED_IMG_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
]);

// ────────────────────────────────────────────────────────────────────
// fetch ar5iv HTML + extract first figure
// ────────────────────────────────────────────────────────────────────

interface ItemAr5ivRow {
  extra: string | null;
  media: string | null;
}

interface MediaItem {
  type?: string;
  url?: string;
  role?: string;
}

interface FigureInfo {
  source: 'ar5iv' | 'hf_thumbnail' | 'none';
  raw_url?: string;
  r2_url?: string;
  width?: number;
  height?: number;
  extracted_at: string;
}

export async function fetchAr5ivAndExtractFigureForHf(
  env: Env,
  itemId: string,
  arxivId: string,
): Promise<{ fetched: boolean; has_figure: boolean; paragraphs_count: number }> {
  // 1. fetch ar5iv HTML
  let html: string | null = null;
  try {
    const r = await fetch(`${AR5IV_BASE}/${arxivId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; aifeeds-bot/1.0)' },
    });
    if (!r.ok) {
      console.warn(`[hf-paper:ar5iv] ${arxivId} HTTP ${r.status}`);
      return { fetched: false, has_figure: false, paragraphs_count: 0 };
    }
    html = await r.text();
  } catch (e) {
    console.error(`[hf-paper:ar5iv] ${arxivId} fetch exception`, e);
    return { fetched: false, has_figure: false, paragraphs_count: 0 };
  }

  // 2. extract first qualifying figure(尝试,可能 0 个)
  const figureUrls = extractFigureCandidates(html, arxivId);
  let figureInfo: FigureInfo = {
    source: 'none',
    extracted_at: new Date().toISOString(),
  };
  for (const candidate of figureUrls) {
    const migrated = await migrateFigureToR2(env, candidate);
    if (migrated) {
      figureInfo = {
        source: 'ar5iv',
        raw_url: candidate,
        r2_url: migrated.r2_url,
        width: migrated.width,
        height: migrated.height,
        extracted_at: new Date().toISOString(),
      };
      break;
    }
  }

  // 3. parse paragraphs → R2 JSON
  const paragraphs = extractParagraphs(html);
  let paragraphsStored = 0;
  if (paragraphs.length > 0 && env.READMES) {
    const key = `${R2_KEY_PREFIX_AR5IV}/${arxivId}.json`;
    try {
      const payload = {
        arxiv_id: arxivId,
        total_paragraphs: paragraphs.length,
        paragraphs: paragraphs.map((en, idx) => ({
          segment_id: `p${idx}`,
          en,
          zh: null as string | null,
          failed_at: null as string | null,
        })),
        fetched_at: new Date().toISOString(),
      };
      await env.READMES.put(key, JSON.stringify(payload), {
        httpMetadata: { contentType: 'application/json; charset=utf-8' },
        customMetadata: { 'arxiv-id': arxivId, 'source': 'hf' },
      });
      paragraphsStored = paragraphs.length;
    } catch (e) {
      console.error(`[hf-paper:ar5iv] ${arxivId} R2 write fail`, e);
    }
  }

  // 4. 更新 items.extra + media(若 figure 抓到)
  const row = await env.DB.prepare(
    `SELECT extra, media FROM items WHERE id = ?`,
  ).bind(itemId).first<ItemAr5ivRow>();
  if (!row) return { fetched: true, has_figure: figureInfo.source === 'ar5iv', paragraphs_count: paragraphsStored };

  const extra = row.extra ? JSON.parse(row.extra) : {};
  const media: MediaItem[] = row.media ? JSON.parse(row.media) : [];

  const newExtra = {
    ...extra,
    ar5iv_fetched_at: new Date().toISOString(),
    ar5iv_paragraphs_count: paragraphsStored,
    figure_image: figureInfo,
  };

  // media[0] 替换为论文 figure(若抓到),HF thumbnail 降级到 media[1] 兜底
  let newMedia = media;
  if (figureInfo.source === 'ar5iv' && figureInfo.r2_url) {
    const thumbnailItem = media.find((m) => m.role === 'thumbnail' || m.type === 'image') || media[0];
    newMedia = [
      { type: 'image', url: figureInfo.r2_url, role: 'figure' },
      ...(thumbnailItem
        ? [{ type: thumbnailItem.type ?? 'image', url: thumbnailItem.url, role: 'thumbnail_fallback' }]
        : []),
    ];
  }

  await env.DB.prepare(
    `UPDATE items SET extra = ?, media = ? WHERE id = ?`,
  ).bind(JSON.stringify(newExtra), JSON.stringify(newMedia), itemId).run();

  return {
    fetched: true,
    has_figure: figureInfo.source === 'ar5iv',
    paragraphs_count: paragraphsStored,
  };
}

/**
 * 从 ar5iv HTML 提取 candidate figure URLs(顺序排序,优先级高的在前)
 *
 * 排除规则:
 * - /static/browse/* (arxiv chrome:logo / Cornell logo / license icon 等)
 * - host 是 arxiv.org / static.arxiv.org(同上)
 * - svg(可能是公式 / 图标,不是 figure)
 *
 * ar5iv 论文 figure 一般在 https://ar5iv.labs.arxiv.org/html/<arxiv_id>/x1.png 这种
 * 相对路径,需要 absolutize
 */
function extractFigureCandidates(html: string, arxivId: string): string[] {
  const candidates: string[] = [];
  const imgRe = /<img\s+[^>]*src="([^"]+)"[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = imgRe.exec(html)) !== null) {
    const src = m[1];
    if (ARXIV_CHROME_PATH_RE.test(src)) continue;
    if (src.endsWith('.svg')) continue;
    let abs: string;
    try {
      abs = new URL(src, `${AR5IV_BASE}/${arxivId}/`).toString();
    } catch {
      continue;
    }
    let host: string;
    try {
      host = new URL(abs).hostname;
    } catch {
      continue;
    }
    if (ARXIV_CHROME_HOSTS.has(host)) continue;
    candidates.push(abs);
  }
  return candidates;
}

async function migrateFigureToR2(
  env: Env,
  url: string,
): Promise<{ r2_url: string; width?: number; height?: number } | null> {
  if (!env.READMES) return null;
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; aifeeds-bot/1.0)' },
    });
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') || '';
    const ctLower = ct.toLowerCase().split(';')[0].trim();
    if (!ALLOWED_IMG_TYPES.has(ctLower)) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength > FIGURE_MAX_BYTES) return null;
    // 注意:CF Workers 没有原生 image decode API,无法 check dimensions
    // 这里只用 file size 作启发(< 5KB 通常是 icon/badge)
    if (buf.byteLength < 5 * 1024) return null;

    const hash = await sha256Hex(buf);
    const ext = ctLower === 'image/jpeg' ? 'jpg' :
                ctLower === 'image/png' ? 'png' :
                ctLower === 'image/webp' ? 'webp' :
                ctLower === 'image/gif' ? 'gif' : 'bin';
    const key = `${R2_KEY_PREFIX_FIGURE}/${hash}.${ext}`;

    await env.READMES.put(key, buf, {
      httpMetadata: { contentType: ctLower },
      customMetadata: { 'src-url': url, 'source': 'hf-figure' },
    });
    return { r2_url: `/r/${key}` };
  } catch (e) {
    console.error(`[hf-paper:figure-migrate] ${url}`, e);
    return null;
  }
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', buf);
  const bytes = new Uint8Array(hash);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/**
 * 从 ar5iv HTML 抽取段落(<p>...</p> 内文本)
 *
 * 简化策略:正则提 <p> 内容(strip tags),保留段落级粒度。
 * 上限 200 段(单论文最多)。
 */
function extractParagraphs(html: string): string[] {
  const result: string[] = [];
  const pRe = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m: RegExpExecArray | null;
  while ((m = pRe.exec(html)) !== null && result.length < 200) {
    const raw = m[1];
    // strip tags + decode entities(简化:只处理常见的)
    const stripped = raw
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (stripped.length > 30) {              // 太短的(navigation / 标题)跳
      result.push(stripped);
    }
  }
  return result;
}

// ────────────────────────────────────────────────────────────────────
// translate-ar5iv: 段落级 flash 批量翻译,写回 R2 JSON
// ────────────────────────────────────────────────────────────────────

export async function translateAr5ivForHfPaper(
  env: Env,
  itemId: string,
  arxivId: string,
  opts: { lang?: string } = {},
): Promise<{ translated: number; failed: number; skipped?: string }> {
  if (!env.READMES || !env.DEEPSEEK_API_KEY) {
    return { translated: 0, failed: 0, skipped: 'missing_deps' };
  }
  const key = `${R2_KEY_PREFIX_AR5IV}/${arxivId}.json`;
  const obj = await env.READMES.get(key);
  if (!obj) return { translated: 0, failed: 0, skipped: 'r2_not_found' };

  const data = (await obj.json()) as {
    paragraphs: Array<{ segment_id: string; en: string; zh: string | null; failed_at: string | null }>;
    arxiv_id: string;
    total_paragraphs: number;
    fetched_at: string;
  };

  // 拿 paper title + keywords(给 prompt 用)
  const row = await env.DB.prepare(
    `SELECT title, json_extract(extra, '$.ai_keywords') AS kw FROM items WHERE id = ?`,
  ).bind(itemId).first<{ title: string | null; kw: string | null }>();
  const paperTitle = row?.title || '';
  const paperKeywords = row?.kw ? (JSON.parse(row.kw) as string[]) : [];

  // 只翻未翻的(zh IS NULL)+ 不超 200 段(防超长论文耗费)
  // 串行调(并行可能触发 DeepSeek rate limit)
  let translated = 0;
  let failed = 0;
  for (const p of data.paragraphs.slice(0, 200)) {
    if (p.zh !== null) continue;
    const prompt = buildAr5ivParagraphPrompt({
      segment_text: p.en,
      paper_title: paperTitle,
      paper_keywords: paperKeywords,
    });
    const r = await callDeepSeek(env.DEEPSEEK_API_KEY, DEEPSEEK_FLASH, prompt, {
      maxTokens: 2000,
      temperature: 0.2,
      timeoutMs: 60_000,
    });
    if (r.text) {
      p.zh = r.text;
      translated++;
    } else {
      p.failed_at = new Date().toISOString();
      failed++;
    }
  }

  // 写回 R2
  try {
    await env.READMES.put(key, JSON.stringify(data), {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
      customMetadata: { 'arxiv-id': arxivId, 'source': 'hf' },
    });
  } catch (e) {
    console.error(`[hf-paper:ar5iv-translate] ${arxivId} R2 write fail`, e);
  }

  // 更新 items.extra.ar5iv_translated_at
  await env.DB.prepare(
    `UPDATE items SET extra = json_set(coalesce(extra, '{}'), '$.ar5iv_translated_at', ?) WHERE id = ?`,
  ).bind(new Date().toISOString(), itemId).run();

  console.log(`[hf-paper:ar5iv-translate] ${arxivId} translated=${translated} failed=${failed}`);
  return { translated, failed };
}
