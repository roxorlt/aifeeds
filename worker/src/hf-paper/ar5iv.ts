// Step 1 helper:fetch-arxiv-html-and-extract-figure(NEW #1)
// Step 2 helper:translate-ar5iv(段落级 flash 翻译;字段名保留 ar5iv 兼容 DB schema)
//
// **2026-05-18 改:从 ar5iv 切到 arxiv.org/html**
//   原因:ar5iv.labs.arxiv.org 是社区项目,mirror 滞后几周;新论文(本月发表)只返 stub。
//        arxiv.org/html/<id> 是 arxiv 官方 2024+ 提供的 HTML 服务,实时 LaTeXML 渲染,
//        几乎所有新论文都有完整 HTML + figure。
//   实测 2605.* 5 月新论文 arxiv.org/html 全有完整 HTML(几百 KB - 2 MB),
//        ar5iv 全是 47 KB stub。figure 命中率从 1/50 预期升到 30-90%。
//
// - fetch HTML: https://arxiv.org/html/<arxiv_id>(自动 redirect 到最新 v 版本)
// - extract first qualifying figure(arxiv chrome 排除 + magic-bytes dimensions 探测 +
//   aspect ratio 0.25-4 + density ≥ 0.05 + max dim ≥ 300)→ 迁 R2 → 写 media[0] + extra.figure_image
// - parse paragraphs(<p> 内文本,strip tags + decode entities)→ store as R2 JSON
//   (避免 D1 行爆 1MB cap)→ flash 批量翻译

import type { Env } from '../index';
import { callDeepSeek, DEEPSEEK_FLASH } from './llm';
import { buildAr5ivParagraphPrompt } from './prompts';

const ARXIV_HTML_BASE = 'https://arxiv.org/html';
const AR5IV_BASE = 'https://ar5iv.labs.arxiv.org/html';   // fallback for figure(CF IP ban arxiv.org img)
const R2_KEY_PREFIX_FIGURE = 'hf';
const R2_KEY_PREFIX_AR5IV = 'hf-paper-ar5iv';

// 论文 figure 提取的排除规则
// `/static/browse/*` 是 arxiv chrome(Cornell logo / arxiv logo / license icon 等)
// static.arxiv.org 也是 chrome 资源域
const ARXIV_CHROME_PATH_RE = /\/static\/browse\//i;
const ARXIV_CHROME_HOSTS = new Set(['static.arxiv.org']);

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
  // 1. fetch arxiv.org/html(自动 redirect 到最新 v 版本)
  let html: string | null = null;
  let finalUrl: string = `${ARXIV_HTML_BASE}/${arxivId}`;
  try {
    const r = await fetch(`${ARXIV_HTML_BASE}/${arxivId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; aifeeds-bot/1.0)' },
    });
    if (!r.ok) {
      console.warn(`[hf-paper:arxiv-html] ${arxivId} HTTP ${r.status}`);
      return { fetched: false, has_figure: false, paragraphs_count: 0 };
    }
    finalUrl = r.url;  // arxiv redirect 到 v1/v2 后的 URL,figure src 相对路径要用这个 resolve
    html = await r.text();
  } catch (e) {
    console.error(`[hf-paper:arxiv-html] ${arxivId} fetch exception`, e);
    return { fetched: false, has_figure: false, paragraphs_count: 0 };
  }

  // 2. extract first qualifying figure
  //    arxiv.org/html 在 CF Workers 上 img src 全替换 placeholder data: URL,
  //    extract 后多半 0 个 candidate。这时 fallback 拿 ar5iv 真实 figure URL。
  let figureUrls = extractFigureCandidates(html, finalUrl);
  if (figureUrls.length === 0) {
    console.log(`[hf-paper:arxiv-html] ${arxivId} arxiv.org 0 figure candidate(CF IP placeholder?), fallback ar5iv`);
    figureUrls = await fetchFigureCandidatesFromAr5iv(arxivId);
  }
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
 * 从 arxiv.org/html HTML 提取 candidate figure URLs
 *
 * 排除规则:
 * - /static/browse/* (arxiv chrome:logo / Cornell logo / license icon 等)
 * - host 是 static.arxiv.org(chrome 资源域)
 * - svg(可能是公式 / 图标,不是 figure)
 *
 * arxiv.org/html 论文 figure 一般是相对路径 "2605.15298v1/x1.png",
 * resolve base 是 fetch response 的 final URL(redirect 后的 arxiv.org/html/<id>v<N>)
 */
function extractFigureCandidates(html: string, baseUrl: string): string[] {
  const candidates: string[] = [];
  // 确保 baseUrl 末尾有 / 让相对路径 resolve 进 base 目录
  const baseWithSlash = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
  const imgRe = /<img\s+[^>]*src="([^"]+)"[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = imgRe.exec(html)) !== null) {
    const src = m[1];
    // 排除 data: URL(arxiv.org 对 CF Workers 出口 IP 替换 img src 为 11x14 px
    // placeholder data:image/png;base64,...,真 figure URL 看不到。anti-scraping。
    // ar5iv fallback 拿真 URL)
    if (src.startsWith('data:')) continue;
    if (ARXIV_CHROME_PATH_RE.test(src)) continue;
    if (src.endsWith('.svg')) continue;
    let abs: string;
    try {
      abs = new URL(src, baseWithSlash).toString();
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

/**
 * Fallback:fetch ar5iv HTML 拿 figure 候选(arxiv.org 在 CF Workers 被替换 placeholder
 * 时用)。ar5iv 滞后但 figure URL 真实可抓;老 paper(arxiv id 月份 < 当月)走得通。
 */
async function fetchFigureCandidatesFromAr5iv(arxivId: string): Promise<string[]> {
  try {
    const r = await fetch(`${AR5IV_BASE}/${arxivId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; aifeeds-bot/1.0)' },
    });
    if (!r.ok) {
      console.warn(`[hf-paper:figure-fallback-ar5iv] ${arxivId} HTTP ${r.status}`);
      return [];
    }
    const html = await r.text();
    return extractFigureCandidates(html, r.url);
  } catch (e) {
    console.error(`[hf-paper:figure-fallback-ar5iv] ${arxivId} exception`, e);
    return [];
  }
}

/**
 * 质量门控 + R2 迁移
 *
 * 双门控(抄 GH 分享海报 worker/src/share/handlers.ts:validateAndEncode):
 *   1. aspect ratio:0.25 < ar < 4(排除 banner / 长条 / 极扁高)
 *   2. byte density(file_size / pixel_count)≥ 0.05(排除大块纯色 placeholder / 标题卡)
 *   3. max dim ≥ 300(排除 icon / button)
 *
 * 关键:**通过 magic bytes parse PNG/JPEG/GIF 自己读 dimensions**,
 *      不依赖 CF Workers 不存在的 image decode API。
 */
async function migrateFigureToR2(
  env: Env,
  url: string,
): Promise<{ r2_url: string; width: number; height: number } | null> {
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

    // ─── 质量门控:aspect ratio + density + max dim ───
    const dim = probeImageDimensions(buf);
    if (!dim) {
      console.warn(`[hf-paper:figure-migrate] ${url} 无法 probe dimensions(可能是 webp 或损坏文件)`);
      return null;
    }
    const ar = dim.width / dim.height;
    if (ar > 4 || ar < 0.25) {
      console.log(`[hf-paper:figure-migrate] reject ${url}: aspect ${ar.toFixed(2)} (${dim.width}x${dim.height})`);
      return null;
    }
    const density = buf.byteLength / (dim.width * dim.height);
    if (density < 0.05) {
      console.log(`[hf-paper:figure-migrate] reject ${url}: density ${density.toFixed(3)} (${dim.width}x${dim.height})`);
      return null;
    }
    const maxDim = Math.max(dim.width, dim.height);
    if (maxDim < 300) {
      console.log(`[hf-paper:figure-migrate] reject ${url}: too small ${dim.width}x${dim.height}`);
      return null;
    }
    // ─── 通过门控,迁 R2 ───

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
    return { r2_url: `/r/${key}`, width: dim.width, height: dim.height };
  } catch (e) {
    console.error(`[hf-paper:figure-migrate] ${url}`, e);
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────
// 图片 magic bytes 解析(PNG/JPEG/GIF),抄自 worker/src/share/handlers.ts
// CF Workers 无原生 image decode API,只能自己 parse binary header 读 dimensions
// ────────────────────────────────────────────────────────────────────

function probeImageDimensions(buf: ArrayBuffer): { width: number; height: number } | undefined {
  const png = probePngDimensions(buf);
  if (png) return png;
  if (buf.byteLength < 4) return undefined;
  const v = new DataView(buf);
  // JPEG: walk segments (FF Mn LL LL ...) 找 SOF (C0-CF except C4/C8/CC)
  if (v.getUint8(0) === 0xFF && v.getUint8(1) === 0xD8) {
    let i = 2;
    while (i < buf.byteLength - 1) {
      if (v.getUint8(i) !== 0xFF) return undefined;
      const marker = v.getUint8(i + 1);
      i += 2;
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
        if (i + 7 > buf.byteLength) return undefined;
        const height = v.getUint16(i + 3);
        const width = v.getUint16(i + 5);
        if (!width || !height) return undefined;
        return { width, height };
      }
      if (i + 2 > buf.byteLength) return undefined;
      const segLen = v.getUint16(i);
      i += segLen;
    }
    return undefined;
  }
  // GIF: 47 49 46 38 ... 6,7=width(LE) 8,9=height(LE)
  if (v.getUint32(0) === 0x47494638 && buf.byteLength >= 10) {
    return { width: v.getUint16(6, true), height: v.getUint16(8, true) };
  }
  return undefined;
}

function probePngDimensions(buf: ArrayBuffer): { width: number; height: number } | undefined {
  // PNG: 89 50 4E 47 0D 0A 1A 0A,IHDR chunk @ offset 16: width (BE) + height (BE)
  if (buf.byteLength < 24) return undefined;
  const v = new DataView(buf);
  if (v.getUint8(0) !== 0x89 || v.getUint8(1) !== 0x50 || v.getUint8(2) !== 0x4E || v.getUint8(3) !== 0x47) {
    return undefined;
  }
  const width = v.getUint32(16);
  const height = v.getUint32(20);
  if (!width || !height) return undefined;
  return { width, height };
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
