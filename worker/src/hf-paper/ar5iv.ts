// Step 1 helper:fetch-arxiv-html-and-extract-figure
//
// 2026-05-19 切换 figure 主路径:**arxiv.org/html/<id>/x{N}.png URL construct + gate**
//   原 PDF XRef parser(figure-pdf.ts)弃用,理由:
//   - 取 PDF 内 image 顺序跟 paper 内"Figure 1"语义不一致(常误抓 logo / mascot)
//   - x1.png 是 LaTeXML 编号过的 figure,语义对齐 paper 真正 Figure N
//   - stats 实测 59 paper:51 paper 有 x1.png(86%);剩 8 个是纯文本 paper(arxiv 不渲染 HTML)
//   - gate 跑下来 51/51 全选对(2605.15824 淘宝 logo → x1 fashion try-on / 2605.15963 → 跳到 x3)
//   完整 stats + gate 阈值见 figure-arxiv-html.ts 注释。
//
// - fetch HTML: https://arxiv.org/html/<arxiv_id>(自动 redirect 到最新 v 版本)→ 取段落给 deep_analysis 用
// - figure 走独立路径:fetchFirstFigureFromArxivHtml(loop x1-x10 + dim/palette/aspect gate)→ R2
// - 无 figure 兜底:HF thumbnail(API 给的);仍无 → media[0] 缺,FE drawer 隐藏 hero 区
// - parse paragraphs(<p> 内文本,strip tags + decode entities)→ R2 JSON 给 deep_analysis ar5iv_excerpt 用

import type { Env } from '../index';
import { fetchFirstFigureFromArxivHtml } from './figure-arxiv-html';

const ARXIV_HTML_BASE = 'https://arxiv.org/html';
const R2_KEY_PREFIX_AR5IV = 'hf-paper-ar5iv';
const R2_KEY_PREFIX_FIGURE = 'hf';
const FIGURE_MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED_IMG_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

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
  source: 'arxiv-html' | 'hf_thumbnail' | 'none';
  raw_url?: string;
  r2_url?: string;
  width?: number;
  height?: number;
  picked_index?: number;       // x1 / x2 / ... arxiv-html 来源时记
  palette_size?: number | null;
  extracted_at: string;
}

export async function fetchAr5ivAndExtractFigureForHf(
  env: Env,
  itemId: string,
  arxivId: string,
): Promise<{ fetched: boolean; has_figure: boolean; paragraphs_count: number }> {
  // 1. fetch arxiv.org/html(自动 redirect 到最新 v 版本)→ 给 paragraph 抽取用
  let html: string | null = null;
  try {
    const r = await fetch(`${ARXIV_HTML_BASE}/${arxivId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; aifeeds-bot/1.0)' },
    });
    if (!r.ok) {
      console.warn(`[hf-paper:arxiv-html] ${arxivId} HTTP ${r.status}`);
      return { fetched: false, has_figure: false, paragraphs_count: 0 };
    }
    html = await r.text();
  } catch (e) {
    console.error(`[hf-paper:arxiv-html] ${arxivId} fetch exception`, e);
    return { fetched: false, has_figure: false, paragraphs_count: 0 };
  }

  // 2. extract first qualifying figure
  //    主路径:loop /html/<id>/x{N}.png + dim/palette/aspect gate
  //    无图兜底:HF API thumbnail(thumbnailUrl 字段;若无则 figureInfo.source='none',FE 隐藏 hero)
  let figureInfo: FigureInfo = {
    source: 'none',
    extracted_at: new Date().toISOString(),
  };
  const arxivFig = await fetchFirstFigureFromArxivHtml(env, arxivId);
  if (arxivFig) {
    figureInfo = {
      source: 'arxiv-html',
      raw_url: arxivFig.raw_url,
      r2_url: arxivFig.r2_url,
      width: arxivFig.width,
      height: arxivFig.height,
      picked_index: arxivFig.picked_index,
      palette_size: arxivFig.palette_size,
      extracted_at: arxivFig.extracted_at,
    };
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
  if (!row) return { fetched: true, has_figure: figureInfo.source === 'arxiv-html', paragraphs_count: paragraphsStored };

  const extra = row.extra ? JSON.parse(row.extra) : {};
  const media: MediaItem[] = row.media ? JSON.parse(row.media) : [];

  const newExtra = {
    ...extra,
    ar5iv_fetched_at: new Date().toISOString(),
    ar5iv_paragraphs_count: paragraphsStored,
    figure_image: figureInfo,
  };

  // media[0] 处理(强保证 FE 始终拿到 R2 path,不出现 raw URL):
  //   - figure 抓到(source='pdf' / 'ar5iv') → media[0] = figure R2 path
  //     原 thumbnail 降级到 media[1] role=thumbnail_fallback(也 ensure R2 path)
  //   - figure 没抓到(source='none') → media[0] = HF thumbnail R2 path
  //     如果原 media[0] 还是 raw HF URL,显式 migrate + replace
  let newMedia = media;
  if (figureInfo.source === 'arxiv-html' && figureInfo.r2_url) {
    const thumbnailItem = media.find((m) => m.role === 'thumbnail' || m.type === 'image') || media[0];
    const thumbR2 = thumbnailItem?.url
      ? await ensureR2Url(env, thumbnailItem.url, MAX_THUMBNAIL_BYTES)
      : null;
    newMedia = [
      { type: 'image', url: figureInfo.r2_url, role: 'figure' },
      ...(thumbR2 ? [{ type: thumbnailItem?.type ?? 'image', url: thumbR2, role: 'thumbnail_fallback' }] : []),
    ];
  } else {
    // source='none':figure 没抓到,ensure media[0] 是 R2 path
    const head = media[0];
    if (head?.url && !head.url.startsWith('/r/')) {
      const r2 = await ensureR2Url(env, head.url, MAX_THUMBNAIL_BYTES);
      if (r2) {
        newMedia = [{ ...head, url: r2 }, ...media.slice(1)];
      }
    }
  }

  await env.DB.prepare(
    `UPDATE items SET extra = ?, media = ? WHERE id = ?`,
  ).bind(JSON.stringify(newExtra), JSON.stringify(newMedia), itemId).run();

  return {
    fetched: true,
    has_figure: figureInfo.source === 'arxiv-html',
    paragraphs_count: paragraphsStored,
  };
}

const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;
const ALLOWED_THUMB_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/**
 * 显式 fetch raw URL → 迁 R2 → return `/r/<key>` path
 * 用于 figure step 兜底 media[0] R2 path(防 FE 拿到 raw HF URL)
 */
async function ensureR2Url(env: Env, url: string, maxBytes: number): Promise<string | null> {
  if (!env.READMES) return null;
  if (url.startsWith('/r/')) return url;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; aifeeds-bot/1.0)' } });
    if (!r.ok) return null;
    const ct = (r.headers.get('content-type') || '').toLowerCase().split(';')[0].trim();
    if (!ALLOWED_THUMB_MIME.has(ct)) return null;
    const lenStr = r.headers.get('content-length');
    if (lenStr && parseInt(lenStr, 10) > maxBytes) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength > maxBytes) return null;
    const hash = await sha256Hex(buf);
    const ext = ct === 'image/jpeg' ? 'jpg' : ct === 'image/png' ? 'png' :
                ct === 'image/webp' ? 'webp' : ct === 'image/gif' ? 'gif' : 'bin';
    const key = `${R2_KEY_PREFIX_FIGURE}/${hash}.${ext}`;
    await env.READMES.put(key, buf, {
      httpMetadata: { contentType: ct },
      customMetadata: { 'src-url': url, 'source': 'hf-thumbnail-fallback' },
    });
    return `/r/${key}`;
  } catch (e) {
    console.error(`[hf-paper:ensure-r2] ${url}`, e);
    return null;
  }
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

// ar5iv 段落级翻译已弃用(2026-05-19 PM 决策方案 E):FE drawer iframe
// arxiv.org/html 让用户用浏览器翻译插件(沉浸式翻译等)实时翻。BE 不再做。
// extractParagraphs 仍保留(给 deep_analysis prompt 的 ar5iv_excerpt 用,英文 raw)
