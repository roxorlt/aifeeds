// HF paper figure 主路径:arxiv.org/html/<id>/x{N}.png URL construct + gate
//
// 2026-05-19 取代 PDF XRef parser 主路径(figure-pdf.ts 弃用)。
// 实测 59 paper × x1-x10 stats(/tmp/hf-figure-stats.tsv):
//   - 51/59(86%)paper 有 x1.png(剩 8 个 arxiv 没 LaTeXML 渲染,纯文本类)
//   - gate 跑下来 51/51 paper 全选对 Figure 1(包括 2605.15824 淘宝 logo / 2605.15963 多 icon 起头)
//   - arxiv 不带 v 自动 resolve latest,无需 HF API 取版本号
//
// Gate(基于 stats P5/P95 分布定):
//   - max(w,h) < 300                     → skip(icon block)
//   - min(w,h) < 150                     → skip(banner / 分割线)
//   - palette_size < 100 AND area > 50k  → skip(大尺寸纯色 logo;非 paletted PNG 跳过此 gate)
//   - bytes < 10240                      → skip(过简单图)
//   - aspect ∉ [0.25, 5]                 → skip(极端长宽,banner)
//
// 命中后 → fetch bytes → sha256 hash key → R2 put(prefix 'hf/')
//
// 不需要 ImageMagick 或 fflate 之外的 lib:dimensions 自己 parse PNG/JPEG/WebP 头,
// palette 自己读 PNG PLTE chunk(纯位运算)。

const ARXIV_HTML_BASE = 'https://arxiv.org/html';
const R2_KEY_PREFIX_FIGURE = 'hf';
const MAX_FIGURES_PER_PAPER = 10;
const FIGURE_FETCH_TIMEOUT_MS = 15000;
const FIGURE_MAX_BYTES = 5 * 1024 * 1024;

const GATE = {
  maxDimFloor: 300,            // max(w,h) < 此值 → icon
  minDimFloor: 150,            // min(w,h) < 此值 → banner
  paletteLogoThreshold: 100,   // palette 色数 < 此值 + 大尺寸 → 纯色 logo
  largeAreaFloor: 50_000,      // palette gate 触发面积阈值
  bytesFloor: 10_240,          // 过小 byte 不是 figure
  aspectMin: 0.25,
  aspectMax: 5,
} as const;

export interface ArxivHtmlFigure {
  source: 'arxiv-html';
  raw_url: string;
  r2_url: string;
  width: number;
  height: number;
  bytes: number;
  palette_size: number | null;  // null = 非 paletted PNG / JPEG
  picked_index: number;          // x1 / x2 / ...,debug 用
  extracted_at: string;
}

interface R2BindingMin {
  put: (key: string, value: ArrayBuffer | Uint8Array, opts?: unknown) => Promise<unknown>;
}

/**
 * Aspect 偏好打分(score 高优先):
 *   1.2 ≤ aspect ≤ 3.0 → 100(理想 hero,横向 multi-panel)
 *   1.0 ≤ aspect < 1.2 → 60(近正方形偏横,可接受)
 *   0.7 ≤ aspect < 1.0 → 30(近正方形偏纵)
 *   3.0 < aspect ≤ 5.0 → 25(过宽 banner-like)
 *   aspect < 0.7        → 10(纵向 GUI/screenshot,迫不得已)
 *
 * 同 score 按 picked_index 优先小(优先 paper Figure 1)。
 */
function scoreAspect(aspect: number): number {
  if (aspect >= 1.2 && aspect <= 3.0) return 100;
  if (aspect >= 1.0 && aspect < 1.2) return 60;
  if (aspect >= 0.7 && aspect < 1.0) return 30;
  if (aspect > 3.0 && aspect <= 5.0) return 25;
  return 10;
}

interface FigureCandidate {
  url: string;
  bytes: Uint8Array;
  verdict: { width: number; height: number; palette_size: number | null };
  picked_index: number;
  score: number;
}

const LOOKAHEAD_MIN_CANDIDATES = 3;          // 至少收集 3 张通过 gate 再选(给 score 排序留余地)
const EARLY_STOP_IDEAL_SCORE = 100;          // 一旦拿到 score 100 立即停(理想 wide hero)

/**
 * 主入口:loop x1-x10 收集通过 gate 的 candidate,按 aspect 偏好 score 排序选最佳,迁 R2
 *
 * 跟 user 2026-05-19 讨论后改:不再 first-pass-take(2605.15138 全 paper 纵向 figure 仍取
 * 纵向,但若 paper 内同时有横向 alternative,prefer 横向 wider)。
 */
export async function fetchFirstFigureFromArxivHtml(
  env: { READMES?: R2BindingMin },
  arxivId: string,
): Promise<ArxivHtmlFigure | null> {
  if (!env.READMES) return null;

  const candidates: FigureCandidate[] = [];

  for (let n = 1; n <= MAX_FIGURES_PER_PAPER; n++) {
    const url = `${ARXIV_HTML_BASE}/${arxivId}/x${n}.png`;
    const fetched = await fetchWithRetry(url);
    if (!fetched) {
      if (n === 1 && candidates.length === 0) {
        console.log(`[hf-paper:figure-arxiv-html] ${arxivId} x1 404, no HTML rendering`);
      }
      break;                                       // 404 → 后面也不会有
    }
    if (fetched.kind === 'network_error') {
      console.warn(`[hf-paper:figure-arxiv-html] ${arxivId} x${n} network error, skip`);
      continue;
    }

    const bytes = fetched.bytes;
    if (bytes.byteLength > FIGURE_MAX_BYTES) {
      console.log(`[hf-paper:figure-arxiv-html] ${arxivId} x${n} too large (${bytes.byteLength}B), skip`);
      continue;
    }

    const verdict = inspectAndGate(bytes);
    if (!verdict.pass) {
      console.log(`[hf-paper:figure-arxiv-html] ${arxivId} x${n} gate fail: ${verdict.reason} (w=${verdict.width} h=${verdict.height} palette=${verdict.palette_size})`);
      continue;
    }

    const aspect = verdict.width / verdict.height;
    const score = scoreAspect(aspect);
    candidates.push({
      url, bytes,
      verdict: { width: verdict.width, height: verdict.height, palette_size: verdict.palette_size },
      picked_index: n,
      score,
    });

    // early stop:已经有理想 wide hero(score=100)→ 直接停,不浪费 fetch
    if (score >= EARLY_STOP_IDEAL_SCORE) break;
    // 收集够 3 张通过 gate 的 candidate 也停(避免 paper figure 多导致全部 fetch)
    if (candidates.length >= LOOKAHEAD_MIN_CANDIDATES) break;
  }

  if (candidates.length === 0) {
    console.log(`[hf-paper:figure-arxiv-html] ${arxivId} 0 candidates passed gate`);
    return null;
  }

  // 排序:score 优先(高分先),同分 picked_index 优先小(paper Figure 1 优先)
  candidates.sort((a, b) => b.score - a.score || a.picked_index - b.picked_index);
  const best = candidates[0];

  // R2 put
  const hash = await sha256Hex(best.bytes);
  const key = `${R2_KEY_PREFIX_FIGURE}/${hash}.png`;
  try {
    await env.READMES.put(key, best.bytes, {
      httpMetadata: { contentType: 'image/png' },
      customMetadata: {
        'src-arxiv-id': arxivId,
        'source': 'hf-figure-arxiv-html',
        'picked-index': String(best.picked_index),
      },
    });
  } catch (e) {
    console.error(`[hf-paper:figure-arxiv-html] ${arxivId} R2 put fail ${key}`, e);
    return null;
  }
  const aspect = best.verdict.width / best.verdict.height;
  console.log(`[hf-paper:figure-arxiv-html] ${arxivId} ✅ x${best.picked_index} score=${best.score} (w=${best.verdict.width} h=${best.verdict.height} ar=${aspect.toFixed(2)} palette=${best.verdict.palette_size}) candidates=${candidates.length} → ${key}`);

  return {
    source: 'arxiv-html',
    raw_url: best.url,
    r2_url: `/r/${key}`,
    width: best.verdict.width,
    height: best.verdict.height,
    bytes: best.bytes.byteLength,
    palette_size: best.verdict.palette_size,
    picked_index: best.picked_index,
    extracted_at: new Date().toISOString(),
  };
}

// ────────────────────────────────────────────────────────────────────
// fetch helper
// ────────────────────────────────────────────────────────────────────

type FetchResult =
  | { kind: 'ok'; bytes: Uint8Array }
  | { kind: 'network_error' };

async function fetchWithRetry(url: string): Promise<FetchResult | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), FIGURE_FETCH_TIMEOUT_MS);
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; aifeeds-bot/1.0)' },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (r.status === 404) return null;                           // 真 404 → 后面也不会有
      if (!r.ok) {
        if (attempt === 0) continue;
        return { kind: 'network_error' };
      }
      const buf = new Uint8Array(await r.arrayBuffer());
      return { kind: 'ok', bytes: buf };
    } catch {
      if (attempt === 0) continue;
      return { kind: 'network_error' };
    }
  }
  return { kind: 'network_error' };
}

// ────────────────────────────────────────────────────────────────────
// PNG inspection:dimensions + palette + gate
// ────────────────────────────────────────────────────────────────────

interface InspectResult {
  pass: boolean;
  reason?: string;
  width: number;
  height: number;
  palette_size: number | null;
}

function inspectAndGate(bytes: Uint8Array): InspectResult {
  const dim = probePngDimensions(bytes);
  if (!dim) {
    return { pass: false, reason: 'png_parse_fail', width: 0, height: 0, palette_size: null };
  }
  const { width, height, paletteSize } = dim;
  const area = width * height;
  const maxDim = Math.max(width, height);
  const minDim = Math.min(width, height);
  const aspect = width / height;

  if (maxDim < GATE.maxDimFloor) {
    return { pass: false, reason: 'dim_too_small', width, height, palette_size: paletteSize };
  }
  if (minDim < GATE.minDimFloor) {
    return { pass: false, reason: 'dim_too_thin', width, height, palette_size: paletteSize };
  }
  if (paletteSize !== null && paletteSize < GATE.paletteLogoThreshold && area > GATE.largeAreaFloor) {
    return { pass: false, reason: 'palette_too_few', width, height, palette_size: paletteSize };
  }
  if (bytes.byteLength < GATE.bytesFloor) {
    return { pass: false, reason: 'bytes_too_few', width, height, palette_size: paletteSize };
  }
  if (aspect < GATE.aspectMin || aspect > GATE.aspectMax) {
    return { pass: false, reason: 'aspect_extreme', width, height, palette_size: paletteSize };
  }

  return { pass: true, width, height, palette_size: paletteSize };
}

/**
 * Parse PNG header chunks → IHDR (w/h/color_type) + PLTE size(若是 paletted PNG)
 * 返回 null = 不是合法 PNG
 */
function probePngDimensions(bytes: Uint8Array): { width: number; height: number; paletteSize: number | null } | null {
  // PNG signature 8 bytes: 89 50 4E 47 0D 0A 1A 0A
  if (bytes.length < 24) return null;
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null;

  // 第一个 chunk 必须是 IHDR(13 bytes data)
  // pos 8:length(4 bytes BE),12:type "IHDR",16:width(4 BE),20:height(4 BE),24:bitdepth,25:color_type,...
  const width = readBE32(bytes, 16);
  const height = readBE32(bytes, 20);
  if (!width || !height) return null;
  const colorType = bytes[25];                                     // 0 gray / 2 RGB / 3 indexed / 4 gray+a / 6 RGBA

  // 只 paletted(color_type=3)有 PLTE chunk;否则 paletteSize = null
  if (colorType !== 3) {
    return { width, height, paletteSize: null };
  }

  // 遍历后续 chunks 找 PLTE(必须出现在 IDAT 之前)
  let pos = 8 + 4 + 4 + 13 + 4;                                    // skip signature + IHDR chunk
  while (pos + 8 <= bytes.length) {
    const chunkLen = readBE32(bytes, pos);
    const t0 = bytes[pos + 4];
    const t1 = bytes[pos + 5];
    const t2 = bytes[pos + 6];
    const t3 = bytes[pos + 7];
    const isPLTE = t0 === 0x50 && t1 === 0x4c && t2 === 0x54 && t3 === 0x45;
    const isIDAT = t0 === 0x49 && t1 === 0x44 && t2 === 0x41 && t3 === 0x54;
    if (isPLTE) {
      return { width, height, paletteSize: Math.floor(chunkLen / 3) };
    }
    if (isIDAT) break;                                             // PLTE 必须 IDAT 之前
    pos += 4 + 4 + chunkLen + 4;                                   // length + type + data + crc
  }
  // paletted PNG 但没找到 PLTE(理论不该发生),保守返 null
  return { width, height, paletteSize: null };
}

function readBE32(bytes: Uint8Array, off: number): number {
  return ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0;
}

async function sha256Hex(buf: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', buf);
  const arr = new Uint8Array(hash);
  let out = '';
  for (const b of arr) out += b.toString(16).padStart(2, '0');
  return out;
}
