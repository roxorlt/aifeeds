// HF paper figure 主路径:解析 arxiv.org/html 网页版 <figure class="ltx_figure"> 内的 <img> + gate
//
// 2026-05-19 取代 PDF XRef parser 主路径(figure-pdf.ts 弃用)。
// 实测 59 paper × x1-x10 stats(/tmp/hf-figure-stats.tsv):
//   - 51/59(86%)paper 有 x1.png(剩 8 个 arxiv 没 LaTeXML 渲染,纯文本类)
//   - gate 跑下来 51/51 paper 全选对 Figure 1(包括 2605.15824 淘宝 logo / 2605.15963 多 icon 起头)
//   - arxiv 不带 v 自动 resolve latest,无需 HF API 取版本号
//
// 2026-09-16 主路径改为「解析 HTML 拿真实图片地址」,拼 xN.png 降级为兜底:
//   arxiv 约 2026-08-10 起新渲染的网页版保留原始文件名(`<id>v1/figures/<name>.png`,
//   也可能是 .jpg),x1.png 一律 404 → 老逻辑对新论文 100% 取不到图。
//   现在 ar5iv.ts 把已抓到的整页 HTML 传进来(opts.html),从 <figure class="ltx_figure">
//   里抽 <img src>,按 figcaption "Figure N" 排序;HTML 里一张候选都没有(纯文本论文 /
//   没网页版)才回落到 x1..x10 猜测循环。
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
// 不需要 ImageMagick 或 fflate 之外的 lib:dimensions 自己 parse PNG/JPEG/GIF 头,
// palette 自己读 PNG PLTE chunk(纯位运算)。

const ARXIV_HTML_BASE = 'https://arxiv.org/html';
// 网页版 figure 的 src 是相对 arxiv.org/html/ 的路径(如 "2609.11412v1/figures/fig_radar.png"),
// 按这个 base resolve 即得可直取的绝对地址。
const ARXIV_HTML_RESOLVE_BASE = 'https://arxiv.org/html/';
const ARXIV_FIGURE_HOST = 'arxiv.org';
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
  palette_size: number | null;  // null = 非 paletted PNG / JPEG / GIF
  picked_index: number;          // 候选序号(1 起);guess 模式下等于 xN 的 N
  extracted_at: string;
}

/** HTML 里抽出的一个 figure 候选(未下载,只有指针与声明尺寸)。 */
export interface FigureCandidateRef {
  url: string;                   // 已 resolve 的绝对地址(host 必为 arxiv.org)
  order: number;                 // 文档顺序,1 起
  figureNumber: number | null;   // figcaption "Figure N" 的 N,取不到为 null
  declaredWidth: number | null;  // <img width> 属性
  declaredHeight: number | null; // <img height> 属性
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

type ImageExt = 'png' | 'jpg' | 'gif';

interface FigureCandidate {
  url: string;
  bytes: Uint8Array;
  verdict: { width: number; height: number; palette_size: number | null };
  picked_index: number;
  label: string;                 // 日志用:guess 模式 "xN",html 模式 "cN"
  ext: ImageExt;
  score: number;
}

const LOOKAHEAD_MIN_CANDIDATES = 3;          // 至少收集 3 张通过 gate 再选(给 score 排序留余地)
const EARLY_STOP_IDEAL_SCORE = 100;          // 一旦拿到 score 100 立即停(理想 wide hero)

// ────────────────────────────────────────────────────────────────────
// HTML → figure 候选指针
// ────────────────────────────────────────────────────────────────────

interface FigureBlock {
  innerStart: number;
  innerEnd: number;
  isTable: boolean;
  isFigure: boolean;
  figureNumber: number | null;
}

/** 深度感知地切出所有 <figure>…</figure> 块(LaTeXML 的子图会嵌套)。 */
function parseFigureBlocks(html: string): FigureBlock[] {
  const blocks: FigureBlock[] = [];
  const stack: Array<{ innerStart: number; cls: string }> = [];
  const re = /<figure\b([^>]*)>|<\/figure\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[0][1] === '/') {
      const open = stack.pop();
      if (!open) continue;
      const inner = html.slice(open.innerStart, m.index);
      blocks.push({
        innerStart: open.innerStart,
        innerEnd: m.index,
        isTable: /(^|\s)ltx_table(\s|$)/.test(open.cls),
        isFigure: /(^|\s)ltx_figure(\s|$)/.test(open.cls),
        figureNumber: figureNumberFromCaptions(inner),
      });
    } else {
      stack.push({ innerStart: m.index + m[0].length, cls: readAttr(m[1], 'class') });
    }
  }
  return blocks.sort((a, b) => a.innerStart - b.innerStart);
}

/** figcaption 文本首个匹配 /^\s*Figure\s+(\d+)/i 的编号;子图的 "(a) …" 不匹配,自然跳过。 */
function figureNumberFromCaptions(inner: string): number | null {
  const re = /<figcaption\b[^>]*>([\s\S]*?)<\/figcaption\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) {
    const text = stripTags(m[1]);
    const hit = /^\s*Figure\s+(\d+)/i.exec(text);
    if (hit) {
      const n = parseInt(hit[1], 10);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 从一段 tag 属性文本里读某个属性值(支持双引号/单引号/裸值)。 */
function readAttr(attrs: string, name: string): string {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = re.exec(attrs);
  if (!m) return '';
  return (m[1] ?? m[2] ?? m[3] ?? '')
    .replace(/&amp;/g, '&')
    .trim();
}

function readIntAttr(attrs: string, name: string): number | null {
  const raw = readAttr(attrs, name);
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * figure 图片 src → 绝对地址;不可用返 null。
 * 跳过:空 src、data: URI、.svg、路径含 /static/(arxiv chrome:logo / 基金会 logo 等)、
 *       非 http(s)、host 不是 arxiv.org。
 */
function resolveArxivFigureUrl(src: string): string | null {
  const s = src.trim();
  if (!s) return null;
  if (/^data:/i.test(s)) return null;
  if (s.includes('/static/')) return null;
  let u: URL;
  try {
    u = new URL(s, ARXIV_HTML_RESOLVE_BASE);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.hostname.toLowerCase() !== ARXIV_FIGURE_HOST) return null;
  if (u.pathname.includes('/static/')) return null;
  if (/\.svg$/i.test(u.pathname)) return null;
  return u.toString();
}

/**
 * 从 arxiv.org/html 整页 HTML 抽 figure 候选。
 *
 * - 只认 class 含 ltx_figure 的 <figure> 块;class 含 ltx_table 的块(及其内部图片)整块排除
 * - 块内优先取 class 含 ltx_graphics 的 <img>,没有才退回块内全部 <img>
 * - 同一 URL 去重(嵌套子图会让外层块重复看到同一张,保留先出现的那条 = 外层的 Figure N)
 * - 返回按 (figureNumber ?? +∞, 文档顺序) 排序;order 字段始终是文档顺序(1 起)
 */
export function extractArxivFigureCandidates(html: string): FigureCandidateRef[] {
  if (!html) return [];
  const blocks = parseFigureBlocks(html);
  const tableBlocks = blocks.filter((b) => b.isTable);
  const figureBlocks = blocks.filter(
    (b) => b.isFigure && !b.isTable && !tableBlocks.some((t) => b.innerStart >= t.innerStart && b.innerEnd <= t.innerEnd),
  );
  if (figureBlocks.length === 0) return [];

  const imgs: Array<{ index: number; attrs: string }> = [];
  const imgRe = /<img\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = imgRe.exec(html)) !== null) imgs.push({ index: m.index, attrs: m[1] });
  if (imgs.length === 0) return [];

  const insideTable = (i: number): boolean =>
    tableBlocks.some((t) => i >= t.innerStart && i < t.innerEnd);

  const picked = new Map<string, FigureCandidateRef & { docPos: number }>();
  for (const block of figureBlocks) {
    const within = imgs.filter(
      (im) => im.index >= block.innerStart && im.index < block.innerEnd && !insideTable(im.index),
    );
    if (within.length === 0) continue;
    const graphics = within.filter((im) => /(^|\s)ltx_graphics(\s|$)/.test(readAttr(im.attrs, 'class')));
    const chosen = graphics.length > 0 ? graphics : within;
    for (const im of chosen) {
      const url = resolveArxivFigureUrl(readAttr(im.attrs, 'src'));
      if (!url || picked.has(url)) continue;
      picked.set(url, {
        url,
        order: 0,
        docPos: im.index,
        figureNumber: block.figureNumber,
        declaredWidth: readIntAttr(im.attrs, 'width'),
        declaredHeight: readIntAttr(im.attrs, 'height'),
      });
    }
  }

  const byDoc = [...picked.values()].sort((a, b) => a.docPos - b.docPos);
  byDoc.forEach((c, i) => { c.order = i + 1; });
  return byDoc
    .slice()
    .sort(
      (a, b) =>
        (a.figureNumber ?? Number.POSITIVE_INFINITY) - (b.figureNumber ?? Number.POSITIVE_INFINITY)
        || a.order - b.order,
    )
    .map(({ url, order, figureNumber, declaredWidth, declaredHeight }) => ({
      url, order, figureNumber, declaredWidth, declaredHeight,
    }));
}

/**
 * 主入口:
 *   - opts.html 给了且能抽到候选 → mode=html,按候选逐张下载 + gate
 *   - 抽不到候选(纯文本论文 / 没网页版) → mode=guess,回落 x1..x10 猜测循环(404 即停)
 * 两种模式共用 gate + aspect score 排序 + early stop,选出最佳后迁 R2。
 *
 * 跟 user 2026-05-19 讨论后改:不再 first-pass-take(2605.15138 全 paper 纵向 figure 仍取
 * 纵向,但若 paper 内同时有横向 alternative,prefer 横向 wider)。
 */
export async function fetchFirstFigureFromArxivHtml(
  env: { READMES?: R2Bucket },
  arxivId: string,
  opts: { html?: string; fetcher?: typeof fetch } = {},
): Promise<ArxivHtmlFigure | null> {
  if (!env.READMES) return null;
  const fetcher = opts.fetcher ?? fetch;

  const refs = opts.html
    ? extractArxivFigureCandidates(opts.html).slice(0, MAX_FIGURES_PER_PAPER)
    : [];
  const mode: 'html' | 'guess' = refs.length > 0 ? 'html' : 'guess';

  const candidates: FigureCandidate[] = [];

  /** gate + 收集;返回 true 表示可以停止继续 fetch。 */
  const consider = (
    url: string,
    label: string,
    pickedIndex: number,
    bytes: Uint8Array,
    contentType: string | null,
  ): boolean => {
    if (bytes.byteLength > FIGURE_MAX_BYTES) {
      console.log(`[hf-paper:figure-arxiv-html] ${arxivId} ${label} too large (${bytes.byteLength}B), skip`);
      return false;
    }
    const verdict = inspectAndGate(bytes);
    if (!verdict.pass) {
      console.log(`[hf-paper:figure-arxiv-html] ${arxivId} ${label} gate fail: ${verdict.reason} (w=${verdict.width} h=${verdict.height} palette=${verdict.palette_size})`);
      return false;
    }
    const aspect = verdict.width / verdict.height;
    const score = scoreAspect(aspect);
    candidates.push({
      url, bytes,
      verdict: { width: verdict.width, height: verdict.height, palette_size: verdict.palette_size },
      picked_index: pickedIndex,
      label,
      ext: sniffImageExt(bytes, contentType),
      score,
    });
    // early stop:已经有理想 wide hero(score=100)→ 直接停,不浪费 fetch
    if (score >= EARLY_STOP_IDEAL_SCORE) return true;
    // 收集够 3 张通过 gate 的 candidate 也停(避免 paper figure 多导致全部 fetch)
    return candidates.length >= LOOKAHEAD_MIN_CANDIDATES;
  };

  if (mode === 'html') {
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i];
      const label = `c${i + 1}`;
      const fetched = await fetchWithRetry(ref.url, fetcher);
      if (!fetched) {
        console.log(`[hf-paper:figure-arxiv-html] ${arxivId} ${label} 404 ${ref.url}, skip`);
        continue;                                    // HTML 指的图可能单张失效,不代表后面都没有
      }
      if (fetched.kind === 'network_error') {
        console.warn(`[hf-paper:figure-arxiv-html] ${arxivId} ${label} network error, skip`);
        continue;
      }
      if (consider(ref.url, label, i + 1, fetched.bytes, fetched.contentType)) break;
    }
  } else {
    for (let n = 1; n <= MAX_FIGURES_PER_PAPER; n++) {
      const url = `${ARXIV_HTML_BASE}/${arxivId}/x${n}.png`;
      const fetched = await fetchWithRetry(url, fetcher);
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
      if (consider(url, `x${n}`, n, fetched.bytes, fetched.contentType)) break;
    }
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
  const key = `${R2_KEY_PREFIX_FIGURE}/${hash}.${best.ext}`;
  try {
    await env.READMES.put(key, best.bytes, {
      httpMetadata: { contentType: contentTypeForExt(best.ext) },
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
  console.log(`[hf-paper:figure-arxiv-html] ${arxivId} ✅ ${best.label} score=${best.score} (w=${best.verdict.width} h=${best.verdict.height} ar=${aspect.toFixed(2)} palette=${best.verdict.palette_size}) candidates=${candidates.length} mode=${mode} → ${key}`);

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
  | { kind: 'ok'; bytes: Uint8Array; contentType: string | null }
  | { kind: 'network_error' };

async function fetchWithRetry(url: string, fetcher: typeof fetch = fetch): Promise<FetchResult | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), FIGURE_FETCH_TIMEOUT_MS);
      const r = await fetcher(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; aifeeds-bot/1.0)' },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (r.status === 404) return null;                           // 真 404
      if (!r.ok) {
        if (attempt === 0) continue;
        return { kind: 'network_error' };
      }
      const buf = new Uint8Array(await r.arrayBuffer());
      const ct = (r.headers?.get('content-type') || '').toLowerCase().split(';')[0].trim();
      return { kind: 'ok', bytes: buf, contentType: ct || null };
    } catch {
      if (attempt === 0) continue;
      return { kind: 'network_error' };
    }
  }
  return { kind: 'network_error' };
}

function sniffImageExt(bytes: Uint8Array, contentType: string | null): ImageExt {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif';
  if (contentType === 'image/jpeg' || contentType === 'image/jpg') return 'jpg';
  if (contentType === 'image/gif') return 'gif';
  return 'png';
}

function contentTypeForExt(ext: ImageExt): string {
  return ext === 'jpg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : 'image/png';
}

// ────────────────────────────────────────────────────────────────────
// 图片 inspection:dimensions(PNG/JPEG/GIF)+ palette + gate
// CF Workers 无原生 image decode API,只能自己 parse binary header 读 dimensions
// ────────────────────────────────────────────────────────────────────

interface InspectResult {
  pass: boolean;
  reason?: string;
  width: number;
  height: number;
  palette_size: number | null;
}

function inspectAndGate(bytes: Uint8Array): InspectResult {
  const dim = probeImageDimensions(bytes);
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
 * magic bytes 探测 PNG / JPEG / GIF 尺寸。paletteSize 只有 paletted PNG 有值,其余 null。
 * 本项目唯一一份实现:ar5iv.ts 的副本已删除,改 import 本函数。
 */
export function probeImageDimensions(
  bytes: Uint8Array,
): { width: number; height: number; paletteSize: number | null } | null {
  const png = probePngDimensions(bytes);
  if (png) return png;
  const jpeg = probeJpegDimensions(bytes);
  if (jpeg) return { ...jpeg, paletteSize: null };
  const gif = probeGifDimensions(bytes);
  if (gif) return { ...gif, paletteSize: null };
  return null;
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

/** JPEG: walk segments (FF Mn LL LL ...) 找 SOF (C0-CF except C4/C8/CC) */
function probeJpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint8(0) !== 0xff || v.getUint8(1) !== 0xd8) return null;
  let i = 2;
  while (i < bytes.length - 1) {
    if (v.getUint8(i) !== 0xff) return null;
    const marker = v.getUint8(i + 1);
    i += 2;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 7 > bytes.length) return null;
      const height = v.getUint16(i + 3);
      const width = v.getUint16(i + 5);
      if (!width || !height) return null;
      return { width, height };
    }
    if (i + 2 > bytes.length) return null;
    const segLen = v.getUint16(i);
    if (segLen < 2) return null;
    i += segLen;
  }
  return null;
}

/** GIF: 47 49 46 38 ... 6,7=width(LE) 8,9=height(LE) */
function probeGifDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 10) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint32(0) !== 0x47494638) return null;
  const width = v.getUint16(6, true);
  const height = v.getUint16(8, true);
  if (!width || !height) return null;
  return { width, height };
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
