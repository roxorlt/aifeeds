// 官方新闻（blog 厂商博客 + podcast AI 播客）分享海报 —— Content 区渲染。
//
// 设计：docs/plans/2026-06-09-ai-vendor-feeds-source-design.md §10.4
//      + mockup docs/plans/_mockups/2026-06-09-feeds-posters.html
//
// 本文件只画 **Content 区**（白卡内部）。Hero / Footer / QR / 香港规范域
// 由顶层 renderShareSvg 复用 renderHero/renderFooter 自动继承——本文件不碰。
//
// ⚠️ 香港 host-rewrite 铁律：renderXxxContent 内**禁止自拼任何对外 URL**。
//    所有资源（封面 / logo / 专辑 art）由 handlers.ts 预解析成 data URI 后传入，
//    本文件只把 data URI 塞进 <image href="...">，绝不构造 ai-feeds.com / api 域名。
//
// 来源 chip 颜色（由 worker-integration 在 handlers.ts 的 pickSourceMeta 配，
// 本文件不渲 chip，仅备注供接线核对）：
//   blog    → #bae6fd（sky 冷蓝，hue ~203°）
//   podcast → #f2c4ee（orchid 洋兰紫粉，hue ~305°）
//
// 与已有源差异：blog/podcast **均无互动数**（RSS 无 likes/stars），byline 用
// 阅读时长 / 节目时长替代 stats 行。
//
// 本文件**刻意自包含**（esc / wrapText / 估宽 / 媒体块 / 图标等都本地实现），
// 不依赖 svg-template.ts 导出私有 helper——避免与并行编辑该文件的 integration
// 互相耦合 / 编译互锁。integration 后续若想抽公共 util，可再重构。

// ─── 颜色 / 字体 token（与 svg-template.ts 的 C / FONT 同源，本地复制一份） ──
const C = {
  ink: '#111318',
  muted: '#687084',
  muted2: '#98a0af',
  line: 'rgba(15, 23, 42, .085)',
  mediaBg: '#fbfbfc',
  placeholder: '#1a1d24',
};
const FONT = '"Noto Sans SC", -apple-system, BlinkMacSystemFont, sans-serif';

// publisher / 节目 monogram 兜底背景池（hash 取色，深色 + 白字，brand-ish 不撞
// 但不写死任一厂商 → 无 logo data URI 时的优雅降级；有 logo 时永远优先 logo）
const MONO_BG_POOL = [
  '#0f766e', '#cc785c', '#b45309', '#9a2d12', '#2a1b54',
  '#7a221a', '#1f2937', '#3730a3', '#155e75', '#7c3aed',
];

// ─── 基础工具 ──────────────────────────────────────────────
function esc(s: string): string {
  return (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function hashStr(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) + s.charCodeAt(i);
    h = h | 0;
  }
  return Math.abs(h);
}

function monoColor(seed: string): string {
  return MONO_BG_POOL[hashStr(seed || 'x') % MONO_BG_POOL.length];
}

function clipId(prefix: string): string {
  return `bp-${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

// 估算字符串宽度（混合中英文，px）。CJK ≈ 1em，ASCII ≈ 0.55em，再乘 weightBoost。
function estimateTextWidth(s: string, fontSize: number, weightBoost = 1): number {
  let w = 0;
  for (const ch of s) {
    if (/[一-鿿　-〿]/.test(ch)) w += fontSize;
    else w += fontSize * 0.55;
  }
  return w * weightBoost;
}

// 超长单行截断 + 尾省略号（CJK 计 1，ASCII 计 0.6）。
function truncate(s: string, max: number): string {
  if (!s) return '';
  let w = 0;
  let out = '';
  for (const ch of s) {
    const cw = /[一-鿿　-〿]/.test(ch) ? 1 : 0.6;
    if (w + cw > max) return out + '…';
    out += ch;
    w += cw;
  }
  return out;
}

// MM-DD（北京时间视角），跟 svg-template formatXTime 同套 BJT 换算，去掉时分。
function formatMd(iso: string | undefined | null): string {
  if (!iso) return '';
  let d: Date;
  try {
    d = new Date(iso);
    if (isNaN(d.getTime())) return '';
  } catch {
    return '';
  }
  const bjt = new Date(d.getTime() + 8 * 3600 * 1000);
  const mm = String(bjt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(bjt.getUTCDate()).padStart(2, '0');
  return `${mm}-${dd}`;
}

// 秒 → 时长字符串：>=1h 用 H:MM:SS，否则 M:SS。
function formatDuration(sec: number | undefined | null): string {
  if (!sec || !Number.isFinite(sec) || sec <= 0) return '';
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// ─── 文本换行（自包含版，行为对齐 svg-template.ts 的 wrapText）─────────────
// word-aware：连续 ASCII 当一个不可分 token；CJK 单字断行；保留 \n 段落格式。
function wrapText(text: string, maxCharsPerLine: number, maxLines: number): string[] {
  const paragraphs = (text || '')
    .split(/\n+/)
    .map(p => p.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean);
  const allLines: string[] = [];
  for (let pi = 0; pi < paragraphs.length; pi++) {
    if (allLines.length >= maxLines) break;
    const pLines = wrapSingleParagraph(paragraphs[pi], maxCharsPerLine, maxLines - allLines.length);
    allLines.push(...pLines);
    if (pi < paragraphs.length - 1 && allLines.length < maxLines) allLines.push('');
  }
  const renderedChars = allLines.join('').length;
  const totalChars = paragraphs.join('').length;
  if (renderedChars < totalChars && allLines.length === maxLines) {
    const last = allLines[maxLines - 1];
    allLines[maxLines - 1] = last.slice(0, Math.max(0, last.length - 1)) + '…';
  }
  return allLines.slice(0, maxLines);
}

function wrapSingleParagraph(text: string, maxCharsPerLine: number, maxLines: number): string[] {
  const charWidth = (ch: string) => (/[一-鿿　-〿]/.test(ch) ? 1 : 0.55);
  const tokenWidth = (s: string) => {
    let w = 0;
    for (const ch of s) w += charWidth(ch);
    return w;
  };
  const tokens: string[] = [];
  let buf = '';
  for (const ch of text) {
    if (/[A-Za-z0-9._\-/'’"]/.test(ch)) {
      buf += ch;
    } else {
      if (buf) { tokens.push(buf); buf = ''; }
      tokens.push(ch);
    }
  }
  if (buf) tokens.push(buf);

  const lines: string[] = [];
  let current = '';
  let weight = 0;
  const flushLine = () => {
    if (current) lines.push(current.replace(/\s+$/, ''));
    current = '';
    weight = 0;
  };

  outer: for (const tok of tokens) {
    const tw = tokenWidth(tok);
    if (tw > maxCharsPerLine) {
      flushLine();
      if (lines.length >= maxLines) break;
      for (const ch of tok) {
        const cw = charWidth(ch);
        if (weight + cw > maxCharsPerLine) {
          flushLine();
          if (lines.length >= maxLines) break outer;
        }
        current += ch;
        weight += cw;
      }
      continue;
    }
    if (weight + tw > maxCharsPerLine && current) {
      flushLine();
      if (lines.length >= maxLines) break;
      if (tok === ' ') continue;
    }
    current += tok;
    weight += tw;
  }
  if (current && lines.length < maxLines) lines.push(current.replace(/\s+$/, ''));
  return lines;
}

// ─── SVG 原子 ──────────────────────────────────────────────
function text(
  x: number, y: number, fs: number, weight: number, fill: string, str: string,
  o?: { anchor?: 'middle' | 'start' | 'end'; ls?: number; opacity?: number; tabular?: boolean },
): string {
  const anchor = o?.anchor ? ` text-anchor="${o.anchor}"` : '';
  const ls = o?.ls != null ? ` letter-spacing="${o.ls}"` : '';
  const op = o?.opacity != null ? ` opacity="${o.opacity}"` : '';
  const tn = o?.tabular ? ` font-variant-numeric="tabular-nums"` : '';
  return `<text x="${x}" y="${y}" font-family='${FONT}' font-size="${fs}" font-weight="${weight}" fill="${fill}"${anchor}${ls}${op}${tn}>${esc(str)}</text>`;
}

// lucide clock（禁 ⏱ emoji；纯 SVG stroke icon，viewBox 24）
function clockIcon(x: number, y: number, size: number, color: string): string {
  const scale = size / 24;
  const sw = 2 / scale;
  return `<g transform="translate(${x} ${y}) scale(${scale})" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" fill="none"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></g>`;
}

// 视频/音频封面 play 叠加：半透明圆 + 白描边 + 白色实心三角（禁 ▶ emoji）。
// 几何与 svg-template.ts 的 playOverlay 一致。
function playOverlay(cx: number, cy: number, r = 44): string {
  const tW = r * 0.7;
  const tH = r * 0.85;
  const tx = cx - tW / 2 + r * 0.08;
  const ty = cy - tH / 2;
  return `
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="rgba(0,0,0,0.55)"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(255,255,255,0.6)" stroke-width="2"/>
    <path d="M ${tx} ${ty} L ${tx + tW} ${ty + tH / 2} L ${tx} ${ty + tH} Z" fill="white"/>`;
}

// 小方头像/缩略（monogram 兜底）：有 data URI 用 image（圆角矩形 clip），
// 否则 hash 取色块 + 白色首字。blog publisher logo / podcast 节目缩略共用。
function renderThumb(
  dataUri: string | undefined, seedName: string,
  x: number, y: number, size: number,
): string {
  const rx = Math.round(size * 0.25);
  if (dataUri) {
    const id = clipId('thumb');
    return `
      <defs><clipPath id="${id}"><rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${rx}"/></clipPath></defs>
      <rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${rx}" fill="${C.mediaBg}" stroke="rgba(15,23,42,0.08)" stroke-width="1"/>
      <image href="${dataUri}" x="${x}" y="${y}" width="${size}" height="${size}" clip-path="url(#${id})" preserveAspectRatio="xMidYMid slice"/>`;
  }
  const bg = monoColor(seedName);
  const initial = (seedName || '?').trim().charAt(0) || '?';
  const fs = Math.round(size * 0.5);
  return `
    <rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${rx}" fill="${bg}"/>
    <text x="${x + size / 2}" y="${y + size / 2 + fs * 0.36}" font-family='${FONT}' font-size="${fs}" font-weight="700" fill="#fff" text-anchor="middle">${esc(initial)}</text>`;
}

// blog 满宽封面块（og:image，按真实 AR 缩放、撑满 innerW、max-h 560、居中裁）。
function renderCoverBlock(
  dataUri: string, ar: number | undefined, x: number, w: number, y: number,
): { svg: string; height: number } {
  const aspect = ar && ar > 0 ? ar : 16 / 9;
  const h = Math.min(w / aspect, 560);
  const id = clipId('cover');
  const svg = `
    <defs><clipPath id="${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="28"/></clipPath></defs>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="28" fill="${C.mediaBg}" stroke="rgba(15,23,42,0.06)" stroke-width="1"/>
    <image href="${dataUri}" x="${x}" y="${y}" width="${w}" height="${h}" clip-path="url(#${id})" preserveAspectRatio="xMidYMid slice"/>`;
  return { svg, height: h };
}

// podcast 方形专辑封面（1:1）+ play 三角叠加。无封面 → 深色占位仍叠 play。
function renderSquareArt(dataUri: string | undefined, x: number, y: number, size: number): string {
  let base: string;
  if (dataUri) {
    const id = clipId('art');
    base = `
      <defs><clipPath id="${id}"><rect x="${x}" y="${y}" width="${size}" height="${size}" rx="30"/></clipPath></defs>
      <rect x="${x}" y="${y}" width="${size}" height="${size}" rx="30" fill="${C.mediaBg}" stroke="rgba(15,23,42,0.06)" stroke-width="1"/>
      <image href="${dataUri}" x="${x}" y="${y}" width="${size}" height="${size}" clip-path="url(#${id})" preserveAspectRatio="xMidYMid slice"/>`;
  } else {
    base = `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="30" fill="${C.placeholder}"/>`;
  }
  return base + playOverlay(x + size / 2, y + size / 2, 44);
}

// 行内左对齐布局：每个 chunk 是 (x) => {svg,w}，chunk 间留 gap。
type Chunk = ((x: number) => { svg: string; w: number }) | null;
function inlineRow(startX: number, gap: number, chunks: Chunk[]): string {
  let x = startX;
  let out = '';
  let first = true;
  for (const c of chunks) {
    if (!c) continue;
    if (!first) x += gap;
    const r = c(x);
    out += r.svg;
    x += r.w;
    first = false;
  }
  return out;
}

// ─── 对外契约（integration 在 renderShareSvg 里组装后传入；签名抄 renderGithubContent）──
export interface BlogContentOpts {
  x: number; y: number; w: number;
  title: string;                 // title_zh ‖ title
  body: string;                  // ai_summary_zh（ELI25）
  publisherName?: string;        // source_company ‖ blog_name（如 OpenAI）
  publisherLogoDataUri?: string; // publisher.icon（R2 → data URI），缺则 monogram 兜底
  readingMinutes?: number;       // reading_minutes → 「约 N 分钟」
  publishedAt?: string;          // ISO → MM-DD
  coverDataUri?: string;         // og:image（已过质量门控）；缺则跳过顶部封面块
  coverAspectRatio?: number;     // 封面真实宽高比
}

export interface PodcastContentOpts {
  x: number; y: number; w: number;
  showName?: string;             // show_name ‖ source_company（如 Latent Space）
  title: string;                 // title_zh ‖ title（单集标题）
  body: string;                  // ai_summary_zh（ELI25 shownotes）
  coverDataUri?: string;         // 方形专辑封面 data URI
  durationSec?: number;          // duration_sec → 「1:23:45」
  publishedAt?: string;          // ISO → MM-DD
}

// integration 调用约定兼容：renderXxxContent(opts) 单参（抄 renderGithubContent）
// 或 renderXxxContent(meta, opts) 双参（全队对接基准）。两者一律并集 merge 成一个对象，
// 字段并集（第二参覆盖第一参），保证无论哪种约定都拿到完整字段、不破编译。
function coalesce(a: any, b: any): any {
  if (b && typeof b === 'object') return { ...(a || {}), ...b };
  return a || {};
}

// ─── blog Content 渲染 ──────────────────────────────────────
// 满宽封面（conditional）→ 标题中译 → ELI25 body → byline（publisher + 约 N 分钟 · MM-DD），无 stats。
export function renderBlogContent(meta: any, opts?: any): { svg: string; height: number } {
  const o = coalesce(meta, opts) as BlogContentOpts;
  const padX = 36;
  const innerX = o.x + padX;
  const innerW = o.w - padX * 2;
  const hasCover = !!o.coverDataUri;
  // 无封面 → padTop 40 直接起标题；有封面 → padTop 36 留卡内顶边距再放封面（news-card 式）
  let cy = o.y + (hasCover ? 36 : 40);
  let svg = '';

  // 顶部满宽封面（og:image，质量门控未过则 integration 不传 → 跳过此块、不留灰底）
  if (hasCover) {
    const cover = renderCoverBlock(o.coverDataUri as string, o.coverAspectRatio, innerX, innerW, cy);
    svg += cover.svg;
    cy += cover.height + 30;
  }

  // 标题中译 48px / 800 / 2 行（letter-spacing -1，line-height 1.18）
  const titleSize = 48;
  const titleLineH = titleSize * 1.18;
  const titleLines = wrapText(o.title || '', 18, 2);
  svg += titleLines
    .map((ln, i) => text(innerX, cy + titleSize + i * titleLineH, titleSize, 800, C.ink, ln, { ls: -1 }))
    .join('');
  cy += titleLines.length * titleLineH + 22;

  // ELI25 body 30px / .82 opacity / 6 行 cap（与流内 / 抽屉同一段 ai_summary_zh）
  const bodySize = 30;
  const bodyLineH = bodySize * 1.5;
  const bodyLines = wrapText(o.body || '', 28, 6);
  svg += bodyLines
    .map((ln, i) => text(innerX, cy + bodySize + i * bodyLineH, bodySize, 400, C.ink, ln, { opacity: 0.82 }))
    .join('');
  cy += bodyLines.length * bodyLineH + 30;

  // byline 行（高 44）：publisher monogram/logo · 名 · 约 N 分钟（clock SVG）· MM-DD —— 无互动数
  const rowTop = cy;
  const fs = 27;
  const baselineY = rowTop + 31;
  const iconY = rowTop + (44 - 26) / 2;
  const pubName = truncate(o.publisherName || '', 16);
  const minutesVal = o.readingMinutes && o.readingMinutes > 0 ? `约 ${Math.round(o.readingMinutes)} 分钟` : '';
  const dateVal = formatMd(o.publishedAt);

  const sepChunk: Chunk = (x) => ({ svg: text(x, baselineY, fs, 400, C.muted2, '·'), w: estimateTextWidth('·', fs, 1) });
  const chunks: Chunk[] = [
    (x) => ({ svg: renderThumb(o.publisherLogoDataUri, o.publisherName || pubName || '?', x, rowTop, 44), w: 44 }),
    pubName ? (x) => ({ svg: text(x, baselineY, fs, 600, C.ink, pubName), w: estimateTextWidth(pubName, fs, 1.0) }) : null,
    minutesVal ? sepChunk : null,
    minutesVal
      ? (x) => {
          const iconSize = 26, gap = 8;
          const w = iconSize + gap + estimateTextWidth(minutesVal, fs, 0.95);
          return { svg: clockIcon(x, iconY, iconSize, C.muted) + text(x + iconSize + gap, baselineY, fs, 500, C.muted, minutesVal), w };
        }
      : null,
    dateVal ? sepChunk : null,
    dateVal ? (x) => ({ svg: text(x, baselineY, fs, 400, C.muted, dateVal, { tabular: true }), w: estimateTextWidth(dateVal, fs, 0.95) }) : null,
  ];
  svg += inlineRow(innerX, 16, chunks);
  cy = rowTop + 44 + 24;

  return { svg, height: cy - o.y };
}

// ─── podcast Content 渲染 ───────────────────────────────────
// 方形专辑封面 + play（左）/ 节目名 + 单集标题（右）→ ELI25 body（满宽）→ meta（节目缩略 · 名 · 时长 · MM-DD），无 stats。
export function renderPodcastContent(meta: any, opts?: any): { svg: string; height: number } {
  const o = coalesce(meta, opts) as PodcastContentOpts;
  const padX = 36;
  const innerX = o.x + padX;
  const innerW = o.w - padX * 2;
  let cy = o.y + 36;
  let svg = '';

  // 头部：左侧方形 art（264）+ play；右侧 节目名 + 单集标题中译
  const artSize = 264;
  const headTop = cy;
  svg += renderSquareArt(o.coverDataUri, innerX, headTop, artSize);

  const colX = innerX + artSize + 28;
  const colW = innerW - artSize - 28;
  let colY = headTop;
  // 节目名 27px / 600 / muted
  const showName = truncate(o.showName || '', 18);
  if (showName) {
    svg += text(colX, colY + 27, 27, 600, C.muted, showName);
    colY += 27 + 14;
  } else {
    colY += 8;
  }
  // 单集标题中译 42px / 800 / 3 行（在右窄列内排，letter-spacing -0.8，line-height 1.2）
  const titleSize = 42;
  const titleLineH = titleSize * 1.2;
  const titleMaxChars = Math.max(8, Math.floor(colW / titleSize)); // ~14 @ colW≈604
  const titleLines = wrapText(o.title || '', titleMaxChars, 3);
  svg += titleLines
    .map((ln, i) => text(colX, colY + titleSize + i * titleLineH, titleSize, 800, C.ink, ln, { ls: -0.8 }))
    .join('');
  const rightColH = (colY - headTop) + titleLines.length * titleLineH + 6;

  // 头部高度 = max(art, 右列)；body 从头部下方满宽起
  cy = headTop + Math.max(artSize, rightColH) + 28;

  // ELI25 shownotes body 30px / .82 / 4 行 cap（满宽）
  const bodySize = 30;
  const bodyLineH = bodySize * 1.5;
  const bodyLines = wrapText(o.body || '', 28, 4);
  svg += bodyLines
    .map((ln, i) => text(innerX, cy + bodySize + i * bodyLineH, bodySize, 400, C.ink, ln, { opacity: 0.82 }))
    .join('');
  cy += bodyLines.length * bodyLineH + 30;

  // meta 行（高 44）：节目缩略 · 节目名 · 时长（clock SVG + 1:23:45，禁 ⏱ emoji）· MM-DD —— 无互动数
  const rowTop = cy;
  const fs = 27;
  const baselineY = rowTop + 31;
  const iconY = rowTop + (44 - 26) / 2;
  const metaShowName = truncate(o.showName || '', 16);
  const durVal = formatDuration(o.durationSec);
  const dateVal = formatMd(o.publishedAt);

  const sepChunk: Chunk = (x) => ({ svg: text(x, baselineY, fs, 400, C.muted2, '·'), w: estimateTextWidth('·', fs, 1) });
  const chunks: Chunk[] = [
    (x) => ({ svg: renderThumb(o.coverDataUri, o.showName || metaShowName || '?', x, rowTop, 44), w: 44 }),
    metaShowName ? (x) => ({ svg: text(x, baselineY, fs, 600, C.ink, metaShowName), w: estimateTextWidth(metaShowName, fs, 1.0) }) : null,
    durVal ? sepChunk : null,
    durVal
      ? (x) => {
          const iconSize = 26, gap = 8;
          const w = iconSize + gap + estimateTextWidth(durVal, fs, 0.95);
          return { svg: clockIcon(x, iconY, iconSize, C.muted) + text(x + iconSize + gap, baselineY, fs, 500, C.muted, durVal, { tabular: true }), w };
        }
      : null,
    dateVal ? sepChunk : null,
    dateVal ? (x) => ({ svg: text(x, baselineY, fs, 400, C.muted, dateVal, { tabular: true }), w: estimateTextWidth(dateVal, fs, 0.95) }) : null,
  ];
  svg += inlineRow(innerX, 16, chunks);
  cy = rowTop + 44 + 24;

  return { svg, height: cy - o.y };
}
