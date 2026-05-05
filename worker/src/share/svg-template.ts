// PR5 share poster SVG 模板
// 设计：docs/mocks/2026-05-04-share-poster-v7.html（HTML mockup）→ 1:1 翻译成 SVG
//
// 输出 1080 宽，高度按变体固定（X-no-media / GH / PH 各自有 base 高度）。
// 文本超长在源头截断（chars-per-line × max-lines），不做精确测量；
// resvg 用 Noto Sans SC Medium 渲染，按字号近似换行。
//
// v1 简化：
// - footer 头像不抓图，渲染纯色圆 + 昵称首字（v2 再接 R2 缓存的真实头像）
// - X chart preview / PH thumbs 暂不画（has_media 仅影响 body 是否截短）
// - hero 弧线用 <clipPath> ellipse 还原 CSS mask 效果

import QRCode from 'qrcode';

// ─── 颜色 / 字体 token（与 v7 mockup 保持一致） ──────────────
const C = {
  posterBg: '#f6f7fa',
  ink: '#111318',
  muted: '#687084',
  muted2: '#98a0af',
  line: 'rgba(15, 23, 42, .085)',
  card: '#ffffff',
  // source chip + pill 配色
  purple: '#6d4bd8',
  purpleSoft: '#f3eeff',
  purpleInk: '#5d3ed0',
  green: '#2da866',
  greenSoft: 'rgba(46,170,104,.10)',
  blue: '#397cff',
  blueSoft: 'rgba(59,124,255,.10)',
  orange: '#ff653f',
  orangeSoft: '#fff0eb',
  orangeInk: '#f0542e',
  // hero
  heroBg1: '#050505',
  heroBg2: '#0c0c10',
  heroPurple: 'rgba(111,99,255,.34)',
  // GH meta
  trophy: '#f59e0b',
};

const FONT = '"Noto Sans SC", -apple-system, BlinkMacSystemFont, sans-serif';

// ─── 默认头像 / 昵称（与 dashboard/src/lib/defaultProfile.ts 同源） ────
const NICKNAME_POOL = [
  '数字游民', '夜猫子', '冲浪选手', '产品猎人', '探险家', '观察者',
  '思考者', '设计师', '工程师', '创作者', '收藏家', '行者',
  '匠人', '诗人', '观星人', '潜水员', '飞行员', '攀登者',
  '骑手', '航海家', '极客', '咖啡因', '云游者', '听风者',
  '拾荒者', '种树人', '记录者', '编织者', '远行者', '守夜人',
  '逐光人', '解谜人',
];

// 头像背景色池（30 个柔和 pastel，跟头像 PNG 数量对齐）
const AVATAR_BG_POOL = [
  '#fde68a', '#fca5a5', '#a7f3d0', '#bfdbfe', '#ddd6fe', '#fbcfe8',
  '#fed7aa', '#a5f3fc', '#fde2e4', '#d9f99d', '#c7d2fe', '#fecaca',
  '#bbf7d0', '#e9d5ff', '#fef08a', '#bae6fd', '#fda4af', '#86efac',
  '#fbbf24', '#67e8f9', '#f0abfc', '#a7f3d0', '#facc15', '#fb7185',
  '#22d3ee', '#84cc16', '#f97316', '#a78bfa', '#34d399', '#f472b6',
];

function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) + s.charCodeAt(i);
    h = h | 0;
  }
  return Math.abs(h);
}

export function defaultNickname(seed: string): string {
  const h = hash(seed);
  return NICKNAME_POOL[h % NICKNAME_POOL.length] + ((h % 9000) + 1000);
}

function avatarBg(seed: string): string {
  const h = hash(seed + ':avatar');
  return AVATAR_BG_POOL[h % AVATAR_BG_POOL.length];
}

// ─── XML 转义 ──────────────────────────────────────────────
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// 超长文本按"每行 N 字 × M 行"硬截断，第 M 行超长加省略号。
// 中文字宽 ≈ 1em，英文字符 ≈ 0.55em，按混合估算。
function wrapText(text: string, maxCharsPerLine: number, maxLines: number): string[] {
  const lines: string[] = [];
  const cleaned = text.replace(/\s+/g, ' ').trim();
  let current = '';
  let weight = 0; // 累计字符宽度（中文=1，英文=0.55）

  for (const ch of cleaned) {
    const w = /[一-鿿A-Z　-〿]/.test(ch) ? 1 : 0.55;
    if (weight + w > maxCharsPerLine && current) {
      lines.push(current);
      current = '';
      weight = 0;
      if (lines.length >= maxLines) break;
    }
    current += ch;
    weight += w;
  }
  if (current && lines.length < maxLines) lines.push(current);

  // 若内容还有剩余 → 尾行加省略号
  const used = lines.join('').length;
  if (used < cleaned.length && lines.length === maxLines) {
    const last = lines[maxLines - 1];
    lines[maxLines - 1] = last.slice(0, Math.max(0, last.length - 1)) + '…';
  }
  return lines;
}

// ─── icons（24×24 X icons、16×16 octicons、24×24 trophy） ─────
const ICON = {
  // X 互动
  reply: 'M1.751 10c0-4.42 3.584-8 8.005-8h4.366c4.49 0 8.129 3.64 8.129 8.13 0 2.96-1.607 5.68-4.196 7.11l-8.054 4.46v-3.69h-.067c-4.49.1-8.183-3.51-8.183-8.01z',
  retweet: 'M4.5 3.88l4.432 4.14-1.364 1.46L5.5 7.55V16c0 1.1.896 2 2 2H13v2H7.5c-2.209 0-4-1.79-4-4V7.55L1.432 9.48.068 8.02 4.5 3.88zM16.5 6H11V4h5.5c2.209 0 4 1.79 4 4v8.45l2.068-1.93 1.364 1.46-4.432 4.14-4.432-4.14 1.364-1.46 2.068 1.93V8c0-1.1-.896-2-2-2z',
  heart: 'M16.697 5.5c-1.222-.06-2.679.51-3.89 2.16l-.805 1.09-.806-1.09C9.984 6.01 8.526 5.44 7.304 5.5c-1.243.07-2.349.78-2.91 1.91-.552 1.12-.633 2.78.479 4.82 1.074 1.97 3.257 4.27 7.129 6.61 3.87-2.34 6.052-4.64 7.126-6.61 1.111-2.04 1.03-3.7.477-4.82-.561-1.13-1.666-1.84-2.908-1.91zm4.187 7.69c-1.351 2.48-4.001 5.12-8.379 7.67l-.503.3-.504-.3c-4.379-2.55-7.029-5.19-8.382-7.67-1.36-2.5-1.41-4.86-.514-6.67.887-1.79 2.647-2.91 4.601-3.01 1.651-.09 3.368.56 4.798 2.01 1.429-1.45 3.146-2.1 4.796-2.01 1.954.1 3.714 1.22 4.601 3.01.896 1.81.846 4.17-.514 6.67z',
  eye: 'M8.75 21V3h2v18h-2zM18 21V8.5h2V21h-2zM4 21l.004-10h2L6 21H4zm9.248 0v-7h2v7h-2z',
  // GH octicons
  star: 'M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z',
  fork: 'M5 5.372v.878c0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75v-.878a2.25 2.25 0 1 1 1.5 0v.878a2.25 2.25 0 0 1-2.25 2.25h-1.5v2.128a2.251 2.251 0 1 1-1.5 0V8.5h-1.5A2.25 2.25 0 0 1 3.5 6.25v-.878a2.25 2.25 0 1 1 1.5 0ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Zm6.75.75a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm-3 8.75a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z',
  watching: 'M8 2c1.981 0 3.671.992 4.933 2.078 1.27 1.091 2.187 2.345 2.637 3.023a1.62 1.62 0 0 1 0 1.798c-.45.678-1.367 1.932-2.637 3.023C11.67 13.008 9.981 14 8 14c-1.981 0-3.671-.992-4.933-2.078C1.797 10.83.88 9.576.43 8.898a1.62 1.62 0 0 1 0-1.798c.45-.677 1.367-1.931 2.637-3.022C4.33 2.992 6.019 2 8 2ZM1.679 7.932a.12.12 0 0 0 0 .136c.411.622 1.241 1.75 2.366 2.717C5.176 11.758 6.527 12.5 8 12.5c1.473 0 2.825-.742 3.955-1.715 1.124-.967 1.954-2.096 2.366-2.717a.12.12 0 0 0 0-.136c-.412-.621-1.242-1.75-2.366-2.717C10.824 4.242 9.473 3.5 8 3.5c-1.473 0-2.825.742-3.955 1.715-1.124.967-1.954 2.096-2.366 2.717ZM8 10a2 2 0 1 1-.001-3.999A2 2 0 0 1 8 10Z',
};

// trophy 是 stroke-only path，单独给 paths 数组
const TROPHY_PATHS = [
  'M6 9H4.5a2.5 2.5 0 0 1 0-5H6',
  'M18 9h1.5a2.5 2.5 0 0 0 0-5H18',
  'M4 22h16',
  'M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22',
  'M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22',
  'M18 2H6v7a6 6 0 0 0 12 0V2Z',
];

// ─── 模块化绘制 helpers（坐标系：父 group origin） ────────────

// 24×24 viewBox icon → translate + scale 到目标尺寸
function fillIcon(pathD: string, x: number, y: number, size: number, color: string, viewBox = 24): string {
  const scale = size / viewBox;
  return `<g transform="translate(${x} ${y}) scale(${scale})"><path d="${pathD}" fill="${color}"/></g>`;
}

function strokeIcon(paths: string[], x: number, y: number, size: number, color: string, strokeWidth = 2, viewBox = 24): string {
  const scale = size / viewBox;
  const sw = strokeWidth / scale;
  const ps = paths.map(d => `<path d="${d}" stroke-width="${sw}" />`).join('');
  return `<g transform="translate(${x} ${y}) scale(${scale})" stroke="${color}" stroke-linecap="round" stroke-linejoin="round" fill="none">${ps}</g>`;
}

// AI-Feeds logo（square_bw_night 同款）：base64 SVG → 直接 data URL <image>
const AI_FEEDS_LOGO_DATA_URL =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNTYiIGhlaWdodD0iMjU2IiB2aWV3Qm94PSIwIDAgNTEyIDUxMiI+PGcgZmlsbD0ibm9uZSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNNTQgMzQwIEw0MDUgOTQiIHN0cm9rZT0iI0YzRjRGNiIgc3Ryb2tlLXdpZHRoPSIxOCIvPjxwYXRoIGQ9Ik03MCAzMzEgTDM5NCAxMDQiIHN0cm9rZT0iIzBCMEYxNCIgc3Ryb2tlLXdpZHRoPSI1IiBvcGFjaXR5PSIwLjkyIi8+PGVsbGlwc2UgY3g9IjU1IiBjeT0iMzQwIiByeD0iOS41IiByeT0iMTIuNSIgdHJhbnNmb3JtPSJyb3RhdGUoLTU1IDU1IDM0MCkiIGZpbGw9IiMwQjBGMTQiIHN0cm9rZT0iI0YzRjRGNiIgc3Ryb2tlLXdpZHRoPSI2Ii8+PHBhdGggZD0iTTE1MCAyNzYgQzE1NCAyNjcgMTYzIDI2NyAxNjYgMjc0IiBzdHJva2U9IiNGM0Y0RjYiIHN0cm9rZS13aWR0aD0iNSIvPjxwYXRoIGQ9Ik0yNzYgMTg4IEMyODEgMTc4IDI5MSAxODAgMjkyIDE4OCIgc3Ryb2tlPSIjRjNGNEY2IiBzdHJva2Utd2lkdGg9IjUiLz48L2c+PGcgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjRjNGNEY2IiBzdHJva2Utd2lkdGg9IjUuNSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMzk4IDEwMCBDMzg2IDg4IDM5MCA3NiA0MDMgODMgQzQxNCA5MCA0MTEgMTAyIDM5OCAxMDBaIi8+PHBhdGggZD0iTTQwNSA5OSBDNDIzIDgzIDQzNiA4NCA0MzcgOTMgQzQzOCAxMDMgNDIwIDEwNiA0MDUgOTlaIi8+PHBhdGggZD0iTTQwNCAxMDAgQzM5MiAxMTMgMzgzIDEyMCAzNzcgMTE1Ii8+PHBhdGggZD0iTTQwNyAxMDIgQzQyMCAxMTUgNDI5IDEyMiA0MzUgMTE2Ii8+PC9nPjxwYXRoIGQ9Ik00MDUgMTAzIEw0MDUgMjQxIiBmaWxsPSJub25lIiBzdHJva2U9IiNGM0Y0RjYiIHN0cm9rZS13aWR0aD0iNS41IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48ZyBmaWxsPSJub25lIiBzdHJva2U9IiM4REREM0QiIHN0cm9rZS13aWR0aD0iNi41IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxwYXRoIGQ9Ik00MDUgMjQ2IEw0MDUgMTc4Ii8+PHBhdGggZD0iTTQwNSAyMTQgTDM4NCAxOTMiLz48cGF0aCBkPSJNNDA1IDIxMCBMNDMwIDE4NyIvPjxwYXRoIGQ9Ik00MDYgMjI5IEwzNzEgMjE4Ii8+PHBhdGggZD0iTTQwNyAyMjUgTDQ0NCAyMTgiLz48cGF0aCBkPSJNNDAxIDIzMyBMMzgyIDI0NiIvPjxwYXRoIGQ9Ik00MTAgMjM1IEw0MzcgMjQ4Ii8+PHBhdGggZD0iTTQwNSAxOTAgTDM5NCAxNzkiLz48cGF0aCBkPSJNNDA1IDE5OCBMNDE4IDE4NCIvPjxwYXRoIGQ9Ik0zODQgMTkzIEwzNzAgMTkwIi8+PHBhdGggZD0iTTM4NCAxOTMgTDM4MSAxNzkiLz48cGF0aCBkPSJNNDMwIDE4NyBMNDQzIDE4NCIvPjxwYXRoIGQ9Ik00MzAgMTg3IEw0MzIgMTcyIi8+PHBhdGggZD0iTTM3MSAyMTggTDM1OCAyMTUiLz48cGF0aCBkPSJNMzcxIDIxOCBMMzY1IDIwNSIvPjxwYXRoIGQ9Ik00NDQgMjE4IEw0NTggMjE4Ii8+PHBhdGggZD0iTTQ0NCAyMTggTDQ1MiAyMDUiLz48L2c+PGcgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMzgyIDI0OSBDMzY1IDI4MSAzNjUgMzUzIDM5MCA0NDQgQzM5MiA0NTIgNDAxIDQ1MiA0MDQgNDQ0IEM0MzEgMzUzIDQyOSAyODAgNDEzIDI0OSBDNDA1IDIzNyAzOTAgMjM3IDM4MiAyNDlaIiBmaWxsPSIjRkY5QTFBIiBzdHJva2U9IiNGM0Y0RjYiIHN0cm9rZS13aWR0aD0iOCIvPjxwYXRoIGQ9Ik0zODEgMjkxIEMzOTQgMjk5IDQwNyAzMDAgNDIxIDI5NCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjRkZEMDhBIiBzdHJva2Utd2lkdGg9IjQuNSIgb3BhY2l0eT0iMC45Ii8+PHBhdGggZD0iTTM3NiAzMzEgQzM5MSAzMzkgNDA1IDM0MCA0MjMgMzMzIiBmaWxsPSJub25lIiBzdHJva2U9IiNGRkQwOEEiIHN0cm9rZS13aWR0aD0iNC41IiBvcGFjaXR5PSIwLjkiLz48cGF0aCBkPSJNMzg0IDM3OCBDMzk3IDM4NCA0MTAgMzg0IDQyMCAzNzkiIGZpbGw9Im5vbmUiIHN0cm9rZT0iI0ZGRDA4QSIgc3Ryb2tlLXdpZHRoPSI0LjUiIG9wYWNpdHk9IjAuOSIvPjxwYXRoIGQ9Ik0zOTAgNDE0IEMzOTggNDE5IDQwNyA0MTkgNDE0IDQxNSIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjRkZEMDhBIiBzdHJva2Utd2lkdGg9IjQuNSIgb3BhY2l0eT0iMC45Ii8+PC9nPjxnIGZpbGw9Im5vbmUiIHN0cm9rZT0iI0YzRjRGNiIgc3Ryb2tlLXdpZHRoPSI2IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxwYXRoIGQ9Ik00MDQgMjQ3IEMzODUgMjI2IDM1OSAyMzEgMzY5IDI1MCBDMzc4IDI2OCAzOTIgMjYwIDQwNCAyNDdaIi8+PHBhdGggZD0iTTQwNiAyNDcgQzQyOCAyMjQgNDUyIDIzMiA0NDIgMjUxIEM0MzIgMjY4IDQxOCAyNjEgNDA2IDI0N1oiLz48cGF0aCBkPSJNNDA0IDI0OCBDMzk4IDI1OSAzOTIgMjY3IDM4NSAyNzMiLz48cGF0aCBkPSJNNDA3IDI0OCBDNDE1IDI2MCA0MjEgMjY4IDQyOSAyNzMiLz48L2c+PC9zdmc+';

// ─── HERO 区（0..360） ──────────────────────────────────────
function renderHero(sourceLabel: string, sourceChipColor: string): string {
  // 弧线效果：用一条 path 画 hero shape，底边用 quadratic bezier 凹进去
  // path: 顶左 → 顶右 → 右下 → 用 Q 曲到左下，Z 闭合
  // 控制点 (540, 220) → 中心凹陷约 70px，比 220 略浅（贝塞尔实际曲线在控制点和端点中间）
  // 直接渲染 hero shape，不依赖 clipPath（resvg clipPath path 兼容性差）
  const heroPath = 'M 0 0 L 1080 0 L 1080 360 Q 540 220 0 360 Z';
  const heroBg = `
    <path d="${heroPath}" fill="url(#hero-grad)"/>
    <path d="${heroPath}" fill="url(#hero-purple-glow)"/>`;

  // hero 内容：左侧 logo + 文字，右侧 source chip
  const logoX = 70, logoY = 60, logoSize = 104;
  const brandX = logoX + logoSize + 30; // 70+104+30=204
  const brandY = logoY + 4; // 略下移让基线对齐
  const heroBrand = `
    <image href="${AI_FEEDS_LOGO_DATA_URL}" x="${logoX}" y="${logoY}" width="${logoSize}" height="${logoSize}"/>
    <text x="${brandX}" y="${brandY + 56}" font-family='${FONT}' font-size="62" font-weight="900" fill="#fff" letter-spacing="-2.5">AI-Feeds</text>
    <text x="${brandX}" y="${brandY + 56 + 42}" font-family='${FONT}' font-size="28" font-weight="600" fill="rgba(255,255,255,0.66)" letter-spacing="1.1">专注 AI 领域资讯聚合</text>`;

  // source chip：右上角胶囊 backdrop-blur 半透明
  // 估宽：「来源 · X」(28+24+24)：约 220 宽
  // 「来源 · GitHub」：约 290；「来源 · Product Hunt」：约 380
  const chipText = sourceLabel;
  const chipPadX = 32;
  const chipFontSize = 32;
  const chipPrefixSize = 24;
  // 估宽：prefix「来源」24*1*2 + gap 14 + label chipFontSize*0.55*ascii 或 *1*chinese
  const labelWidth = estimateTextWidth(chipText, chipFontSize, 0.85);
  const prefixWidth = estimateTextWidth('来源', chipPrefixSize, 1);
  const chipInnerWidth = prefixWidth + 14 + labelWidth;
  const chipWidth = chipPadX * 2 + chipInnerWidth;
  const chipHeight = 76;
  const chipX = 1080 - 70 - chipWidth;
  const chipY = 60 + 20; // 跟 hero-source margin-top:20 对齐

  const heroSource = `
    <g>
      <rect x="${chipX}" y="${chipY}" width="${chipWidth}" height="${chipHeight}" rx="${chipHeight / 2}"
            fill="rgba(255,255,255,0.10)" stroke="rgba(255,255,255,0.18)" stroke-width="1"/>
      <text x="${chipX + chipPadX}" y="${chipY + chipHeight / 2 + 9}" font-family='${FONT}' font-size="${chipPrefixSize}" font-weight="600" fill="rgba(255,255,255,0.65)">来源</text>
      <text x="${chipX + chipPadX + prefixWidth + 14}" y="${chipY + chipHeight / 2 + 11}" font-family='${FONT}' font-size="${chipFontSize}" font-weight="850" fill="${sourceChipColor}">${esc(chipText)}</text>
    </g>`;

  return heroBg + heroBrand + heroSource;
}

// 估算字符串宽度（混合中英文，px）
function estimateTextWidth(s: string, fontSize: number, weightBoost = 1): number {
  let w = 0;
  for (const ch of s) {
    if (/[一-鿿　-〿]/.test(ch)) w += fontSize;
    else w += fontSize * 0.55;
  }
  return w * weightBoost;
}

// ─── 内容卡片背景（rounded rect with shadow） ───────────────
function renderCardBg(x: number, y: number, w: number, h: number, rx = 48): string {
  // shadow filter 由顶层 defs 提供（renderShareSvg 注入），避免每张 card 重复 defs
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" ry="${rx}"
          fill="${C.card}" stroke="rgba(15,23,42,0.06)" stroke-width="1"
          filter="url(#card-shadow)"/>`;
}

// 全局 defs（hero 渐变 + card shadow），由 renderShareSvg 注入到顶层 <svg>
function topLevelDefs(): string {
  return `
    <defs>
      <linearGradient id="hero-grad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${C.heroBg1}"/>
        <stop offset="100%" stop-color="${C.heroBg2}"/>
      </linearGradient>
      <radialGradient id="hero-purple-glow" cx="0.82" cy="0.22" r="0.30">
        <stop offset="0%" stop-color="${C.heroPurple}"/>
        <stop offset="100%" stop-color="${C.heroPurple}" stop-opacity="0"/>
      </radialGradient>
      <filter id="card-shadow" x="-10%" y="-10%" width="120%" height="120%">
        <feGaussianBlur in="SourceAlpha" stdDeviation="18"/>
        <feOffset dx="0" dy="18" result="off"/>
        <feComponentTransfer><feFuncA type="linear" slope="0.14"/></feComponentTransfer>
        <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>`;
}

// ─── Footer 区（avatar + nickname + QR） ─────────────────────
async function renderFooter(
  ctx: { seed: string; nickname: string; avatarDataUri?: string; qrUrl: string },
  x: number, y: number, w: number, h: number,
): Promise<string> {
  const innerCard = renderCardBg(x, y, w, h, 40);

  // Sharer 区（左侧）：avatar 120 + meta，整块在 footer 内垂直居中
  const padX = 44;
  const avatarSize = 120;
  const avatarX = x + padX;
  // 整体（avatar + meta 两行）高度 ≈ avatarSize；以 footer 中心对齐
  const avatarY = y + (h - avatarSize) / 2;
  const initial = ctx.nickname.charAt(0);
  const bg = avatarBg(ctx.seed);
  let sharerAvatar: string;
  if (ctx.avatarDataUri) {
    // 真实头像：圆形 clip + image
    const clipId = `sharer-clip-${ctx.seed.replace(/[^A-Za-z0-9]/g, '')}`;
    sharerAvatar = `
      <defs><clipPath id="${clipId}"><circle cx="${avatarX + avatarSize / 2}" cy="${avatarY + avatarSize / 2}" r="${avatarSize / 2}"/></clipPath></defs>
      <image href="${ctx.avatarDataUri}" x="${avatarX}" y="${avatarY}" width="${avatarSize}" height="${avatarSize}" clip-path="url(#${clipId})" preserveAspectRatio="xMidYMid slice"/>`;
  } else {
    // 兜底：色块圆 + 首字母
    sharerAvatar = `
      <circle cx="${avatarX + avatarSize / 2}" cy="${avatarY + avatarSize / 2}" r="${avatarSize / 2}" fill="${bg}"/>
      <text x="${avatarX + avatarSize / 2}" y="${avatarY + avatarSize / 2 + 22}"
            font-family='${FONT}' font-size="60" font-weight="700" fill="${C.ink}"
            text-anchor="middle">${esc(initial)}</text>`;
  }

  const metaX = avatarX + avatarSize + 28;
  // meta 两行：「分享自」(26px) + nickname (36px)，总高约 26+14+36 = 76
  // 以 avatar 中心对齐
  const metaCenterY = avatarY + avatarSize / 2;
  const metaTopY = metaCenterY - 76 / 2;
  const sharerMeta = `
    <text x="${metaX}" y="${metaTopY + 22}" font-family='${FONT}' font-size="26" fill="${C.muted}">分享自</text>
    <text x="${metaX}" y="${metaTopY + 22 + 50}" font-family='${FONT}' font-size="36" font-weight="500" fill="${C.ink}">${esc(ctx.nickname)}</text>`;

  // QR 区（右侧）：QR + hint 作为一个整体在 footer 内垂直居中
  // 整组高 = qrSize + gap(14) + hintFontSize(22) = 204
  const qrSize = 168;
  const hintGap = 14;
  const hintSize = 22;
  const qrGroupH = qrSize + hintGap + hintSize;
  const qrX = x + w - padX - qrSize;
  const qrY = y + (h - qrGroupH) / 2;
  let qrSvgInner = '';
  try {
    // qrcode lib 输出 <svg viewBox="0 0 N N">...<path d="M0 0h1v1h-1z"/></svg>
    // 提取 viewBox 维度 + inner，外层 <g> 用 translate + scale 把 N×N 缩到 qrSize
    const fullSvg = await QRCode.toString(ctx.qrUrl, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 1, // 留 1 模块白边，扫码软件更稳
      color: { dark: '#111', light: '#fff' },
    });
    const viewBoxMatch = fullSvg.match(/viewBox="0\s+0\s+(\d+)\s+(\d+)"/);
    const inner = fullSvg.match(/<svg[^>]*>([\s\S]*?)<\/svg>/)?.[1] ?? '';
    const vbW = viewBoxMatch ? parseInt(viewBoxMatch[1], 10) : qrSize;
    const scale = qrSize / vbW;
    // 白色底（防止 1px 漏出）+ scale 后的 inner
    qrSvgInner = `
      <rect x="${qrX}" y="${qrY}" width="${qrSize}" height="${qrSize}" fill="#fff" rx="18" ry="18"/>
      <g transform="translate(${qrX} ${qrY}) scale(${scale})">${inner}</g>
      <rect x="${qrX}" y="${qrY}" width="${qrSize}" height="${qrSize}" fill="none" stroke="rgba(15,23,42,0.08)" stroke-width="1" rx="18" ry="18"/>`;
  } catch {
    // 兜底：方块 placeholder
    qrSvgInner = `<rect x="${qrX}" y="${qrY}" width="${qrSize}" height="${qrSize}" fill="#fff" stroke="rgba(15,23,42,0.08)" stroke-width="1"/>`;
  }

  // 「微信扫码查看」hint：以 QR 中心左右居中，QR 下方紧贴
  const hintX = qrX + qrSize / 2;
  const hintY = qrY + qrSize + hintGap + hintSize - 4; // baseline ≈ top + size - descender
  const hint = `<text x="${hintX}" y="${hintY}" font-family='${FONT}' font-size="${hintSize}" fill="${C.muted2}" text-anchor="middle">微信扫码查看</text>`;

  return innerCard + sharerAvatar + sharerMeta + qrSvgInner + hint;
}

// ─── X 变体 内容渲染 ────────────────────────────────────────
function renderXContent(opts: {
  x: number; y: number; w: number;
  authorName: string;
  authorHandle: string;
  body: string;
  metrics?: { replies?: number; retweets?: number; likes?: number; views?: number };
}): { svg: string; height: number } {
  const padX = 36;       // 56→36：让 body 宽度更接近 v7 mockup 期望
  const padTop = 56;
  const innerX = opts.x + padX;
  const innerW = opts.w - padX * 2;

  let cy = opts.y + padTop;

  // top-line: avatar 112 + name + handle（avatar 改圆形 — X 平台头像本来就是圆）
  const avatarSize = 112;
  const avatarBgColor = avatarBg(opts.authorHandle || opts.authorName);
  const initial = (opts.authorName || '?').charAt(0);
  const topLine = `
    <circle cx="${innerX + avatarSize / 2}" cy="${cy + avatarSize / 2}" r="${avatarSize / 2}" fill="${avatarBgColor}"/>
    <text x="${innerX + avatarSize / 2}" y="${cy + avatarSize / 2 + 20}"
          font-family='${FONT}' font-size="56" font-weight="700" fill="${C.ink}" text-anchor="middle">${esc(initial)}</text>
    <text x="${innerX + avatarSize + 24}" y="${cy + 50}" font-family='${FONT}' font-size="52" font-weight="900" fill="${C.ink}" letter-spacing="-1.5">${esc(truncate(opts.authorName, 16))}</text>
    <text x="${innerX + avatarSize + 24}" y="${cy + 50 + 50}" font-family='${FONT}' font-size="36" fill="${C.muted}">${esc(truncate(opts.authorHandle || '', 28))}</text>`;
  cy += avatarSize + 30;

  // body：38px / line-height 1.52；innerW=1008（38px ≈ 1em 中文，max 22 字 = 836px 还有富余）
  const lines = wrapText(opts.body, 24, 8);
  const bodySize = 38;
  const bodyLine = bodySize * 1.52;
  const body = lines
    .map((line, i) => `<text x="${innerX}" y="${cy + bodySize + i * bodyLine}" font-family='${FONT}' font-size="${bodySize}" font-weight="500" fill="${C.ink}" letter-spacing="-0.6">${esc(line)}</text>`)
    .join('');
  cy += lines.length * bodyLine + 30;

  // engagement: top border + 4 columns (reply/retweet/heart/eye)
  const engY = cy;
  const engHeight = 100;
  const engCols = 4;
  const engColW = innerW / engCols;
  const engCenterY = engY + engHeight / 2 + 4;
  const m = opts.metrics || {};
  const engagementValues = [
    formatStat(m.replies),
    formatStat(m.retweets),
    formatStat(m.likes),
    formatStat(m.views),
  ];
  const engagementIcons = [ICON.reply, ICON.retweet, ICON.heart, ICON.eye];
  let engagementSvg = `<line x1="${innerX}" y1="${engY + 4}" x2="${innerX + innerW}" y2="${engY + 4}" stroke="${C.line}" stroke-width="1"/>`;
  for (let i = 0; i < engCols; i++) {
    const colCx = innerX + engColW * i + engColW / 2;
    const iconSize = 36;
    const valueText = engagementValues[i];
    const valueWidth = estimateTextWidth(valueText, 30, 0.8);
    const totalW = iconSize + 12 + valueWidth;
    const startX = colCx - totalW / 2;
    engagementSvg += fillIcon(engagementIcons[i], startX, engCenterY - iconSize / 2 - 6, iconSize, C.muted);
    engagementSvg += `<text x="${startX + iconSize + 12}" y="${engCenterY + 10}" font-family='${FONT}' font-size="30" fill="${C.muted}">${esc(valueText)}</text>`;
    if (i < engCols - 1) {
      engagementSvg += `<line x1="${colCx + engColW / 2}" y1="${engY + 26}" x2="${colCx + engColW / 2}" y2="${engY + engHeight - 18}" stroke="rgba(15,23,42,0.08)" stroke-width="1"/>`;
    }
  }
  cy = engY + engHeight;

  const totalH = cy - opts.y + 42; // 42 padding-bottom
  return { svg: topLine + body + engagementSvg, height: totalH };
}

// owner/repo 优先按 / 分两行，再各自截断到 maxChars 字符
function splitRepoFullName(name: string, maxChars: number): string[] {
  if (!name) return [''];
  const slash = name.indexOf('/');
  if (slash > 0 && slash < name.length - 1) {
    const owner = name.slice(0, slash);
    const repo = name.slice(slash + 1);
    return [truncate(owner + '/', maxChars), truncate(repo, maxChars)];
  }
  return [truncate(name, maxChars)];
}

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

function formatStat(n: number | string | undefined | null): string {
  if (n === undefined || n === null || n === '') return '0';
  const num = typeof n === 'string' ? parseInt(n, 10) : n;
  if (!Number.isFinite(num)) return String(n);
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (num >= 1_000) return (num / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(num);
}

// ─── GitHub 变体 内容渲染 ───────────────────────────────────
function renderGithubContent(opts: {
  x: number; y: number; w: number;
  repoFullName: string;
  tag: string;
  stars: number | string;
  forks: number | string;
  watchers: number | string;
  rankLabel: string;
  contributors?: string;
  body: string;
  mediaImageDataUri?: string;
  mediaAspectRatio?: number;
}): { svg: string; height: number } {
  const padX = 36, padTop = 56;
  const innerX = opts.x + padX;
  const innerW = opts.w - padX * 2;
  let cy = opts.y + padTop;

  // repo logo（dot pattern）
  const logoX = innerX, logoY = cy;
  const logoSize = 128;
  const logoBg = `<circle cx="${logoX + logoSize / 2}" cy="${logoY + logoSize / 2}" r="${logoSize / 2}" fill="#08090a"/>`;
  // 7×7 dot grid
  const dotPattern = (() => {
    const on = new Set([2, 3, 4, 8, 9, 10, 11, 12, 17, 24, 31, 38, 45, 16, 23, 30, 37, 44, 15, 22, 29, 36, 43]);
    const dotSize = 8;
    const gap = 5;
    const gridSize = 7 * dotSize + 6 * gap;
    const startX = logoX + (logoSize - gridSize) / 2;
    const startY = logoY + (logoSize - gridSize) / 2;
    let dots = '';
    for (let i = 0; i < 49; i++) {
      const r = Math.floor(i / 7), c = i % 7;
      const cx = startX + c * (dotSize + gap) + dotSize / 2;
      const cy_ = startY + r * (dotSize + gap) + dotSize / 2;
      const fill = on.has(i) ? '#12b981' : 'rgba(18,185,129,0.22)';
      dots += `<circle cx="${cx}" cy="${cy_}" r="${dotSize / 2}" fill="${fill}"/>`;
    }
    return dots;
  })();

  // repo name + tag。owner/repo 优先按 / 分两行（owner 一行、repo 一行），单段超长再 wrap
  const nameX = logoX + logoSize + 34;
  const nameMaxLines = splitRepoFullName(opts.repoFullName, 18);
  const repoTitleSize = 66;
  const repoTitleLineH = repoTitleSize * 1.08;
  const titleSvg = nameMaxLines
    .map((line, i) => `<text x="${nameX}" y="${cy + repoTitleSize + i * repoTitleLineH}" font-family='${FONT}' font-size="${repoTitleSize}" font-weight="900" fill="${C.ink}" letter-spacing="-3">${esc(line)}</text>`)
    .join('');
  const tagY = cy + repoTitleSize + nameMaxLines.length * repoTitleLineH - repoTitleLineH + 20 + 28;
  const tagText = opts.tag;
  const tagW = estimateTextWidth(tagText, 28, 0.85) + 40;
  const tagSvg = `
    <rect x="${nameX}" y="${tagY - 30}" width="${tagW}" height="46" rx="23" fill="${C.purpleSoft}"/>
    <text x="${nameX + tagW / 2}" y="${tagY + 1}" font-family='${FONT}' font-size="28" font-weight="850" fill="${C.purpleInk}" text-anchor="middle">${esc(tagText)}</text>`;

  cy += Math.max(logoSize, repoTitleLineH * nameMaxLines.length + 62);
  cy += 16;

  // metrics row (stars/forks/watchers, 3 cols)
  const metRowY = cy;
  const metricsArr = [
    { icon: ICON.star, value: formatStat(opts.stars), label: 'Stars', viewBox: 16 },
    { icon: ICON.fork, value: formatStat(opts.forks), label: 'Forks', viewBox: 16 },
    { icon: ICON.watching, value: formatStat(opts.watchers), label: 'Watchers', viewBox: 16 },
  ];
  const metColW = innerW / 3;
  let metricsSvg = '';
  // 每列：[icon + 数字] 同一水平行居中；下方一行 label
  // 列高 96，icon+数字这一行 baseline 在 metRowY+44，label baseline 在 metRowY+82
  metricsArr.forEach((m, i) => {
    const cx = innerX + metColW * i + metColW / 2;
    const iconSize = 30;
    const numberSize = 34;
    const numberValueText = m.value;
    const numberW = estimateTextWidth(numberValueText, numberSize, 0.85);
    const groupW = iconSize + 12 + numberW;
    const groupX = cx - groupW / 2;
    const iconY = metRowY + 44 - iconSize + 4; // icon 顶 baseline 微调对齐
    metricsSvg += fillIcon(m.icon, groupX, iconY, iconSize, C.muted, m.viewBox);
    metricsSvg += `<text x="${groupX + iconSize + 12}" y="${metRowY + 44}" font-family='${FONT}' font-size="${numberSize}" font-weight="700" fill="${C.ink}">${esc(numberValueText)}</text>`;
    metricsSvg += `<text x="${cx}" y="${metRowY + 82}" font-family='${FONT}' font-size="24" font-weight="500" fill="${C.muted2}" text-anchor="middle">${esc(m.label)}</text>`;
    if (i < 2) {
      metricsSvg += `<line x1="${cx + metColW / 2}" y1="${metRowY + 8}" x2="${cx + metColW / 2}" y2="${metRowY + 88}" stroke="${C.line}" stroke-width="1"/>`;
    }
  });
  metricsSvg += `<line x1="${innerX}" y1="${metRowY + 110}" x2="${innerX + innerW}" y2="${metRowY + 110}" stroke="${C.line}" stroke-width="1"/>`;
  cy += 130;

  // meta row: trophy + rank (左)，contributors（右）
  // trophy 24×24 viewBox，渲到 32×32；让 icon 视觉中心 = text baseline 上方 ~10px
  const metaLineY = cy + 22; // text baseline
  const trophySize = 32;
  const trophyY = metaLineY - trophySize + 5;
  const trophySvg = strokeIcon(TROPHY_PATHS, innerX, trophyY, trophySize, C.trophy, 2.5);
  const rankX = innerX + trophySize + 14;
  const rankSvg = `<text x="${rankX}" y="${metaLineY}" font-family='${FONT}' font-size="30" fill="${C.muted}">${esc(opts.rankLabel)}</text>`;
  let contribSvg = '';
  if (opts.contributors) {
    const contribText = opts.contributors;
    const contribTextW = estimateTextWidth(contribText, 30);
    const contribTextX = innerX + innerW - contribTextW;
    contribSvg = `<text x="${contribTextX}" y="${metaLineY}" font-family='${FONT}' font-size="30" fill="${C.muted}">${esc(contribText)}</text>`;
  }
  metricsSvg += trophySvg + rankSvg + contribSvg;
  metricsSvg += `<line x1="${innerX}" y1="${metaLineY + 24}" x2="${innerX + innerW}" y2="${metaLineY + 24}" stroke="${C.line}" stroke-width="1"/>`;
  cy = metaLineY + 44;

  // body 36px / 1.48 / clamp 5
  const bodySize = 36;
  const bodyLine = bodySize * 1.48;
  const bodyLines = wrapText(opts.body, 24, 5);
  const bodySvg = bodyLines
    .map((line, i) => `<text x="${innerX}" y="${cy + bodySize + i * bodyLine}" font-family='${FONT}' font-size="${bodySize}" font-weight="500" fill="${C.ink}" letter-spacing="-0.5">${esc(line)}</text>`)
    .join('');
  cy += bodyLines.length * bodyLine + 30;

  // 有媒体：body 之后再放第一张 README 图（按比例缩放占满 innerW，最大高 480）
  let mediaSvg = '';
  if (opts.mediaImageDataUri) {
    const ar = opts.mediaAspectRatio && opts.mediaAspectRatio > 0 ? opts.mediaAspectRatio : 16 / 9;
    const mediaH = Math.min(innerW / ar, 520);
    const mediaW = mediaH * ar;
    const mediaX = innerX + (innerW - mediaW) / 2;
    const mediaY = cy;
    const clipId = `gh-media-clip-${Math.random().toString(36).slice(2, 8)}`;
    mediaSvg = `
      <defs><clipPath id="${clipId}"><rect x="${mediaX}" y="${mediaY}" width="${mediaW}" height="${mediaH}" rx="28"/></clipPath></defs>
      <rect x="${mediaX}" y="${mediaY}" width="${mediaW}" height="${mediaH}" rx="28" fill="#fbfbfc" stroke="rgba(15,23,42,0.06)" stroke-width="1"/>
      <image href="${opts.mediaImageDataUri}" x="${mediaX}" y="${mediaY}" width="${mediaW}" height="${mediaH}" clip-path="url(#${clipId})" preserveAspectRatio="xMidYMid slice"/>`;
    cy += mediaH + 16;
  }
  cy += 12; // 卡片底部内边距收尾

  const totalH = cy - opts.y;
  return { svg: logoBg + dotPattern + titleSvg + tagSvg + metricsSvg + bodySvg + mediaSvg, height: totalH };
}

// ─── Product Hunt 变体 内容渲染 ────────────────────────────
function renderPhContent(opts: {
  x: number; y: number; w: number;
  productName: string;
  rank: string;
  tag: string;
  body: string;
  stats?: { comments?: number | string; rating?: string; followers?: number | string };
  mediaImageDataUri?: string;
  mediaAspectRatio?: number;
}): { svg: string; height: number } {
  const padX = 36, padTop = 56;
  const innerX = opts.x + padX;
  const innerW = opts.w - padX * 2;
  let cy = opts.y + padTop;

  // product header: logo 128 + product name + rank + tag
  const logoSize = 128;
  const logoX = innerX, logoY = cy;
  const logoBg = `<rect x="${logoX}" y="${logoY}" width="${logoSize}" height="${logoSize}" rx="30" fill="#fbfbfc" stroke="rgba(15,23,42,0.08)" stroke-width="1"/>`;
  // 简化产品 logo：渐变方块
  const phLogoInner = `
    <text x="${logoX + logoSize / 2}" y="${logoY + logoSize / 2 + 28}"
          font-family='${FONT}' font-size="68" font-weight="900" fill="${C.orangeInk}" text-anchor="middle">${esc((opts.productName || '?').charAt(0))}</text>`;

  // product title row
  const nameX = logoX + logoSize + 34;
  const productTitle = truncate(opts.productName, 14);
  const productTitleSize = 92;
  const productTitleY = cy + productTitleSize - 8;
  const titleSvg = `<text x="${nameX}" y="${productTitleY}" font-family='${FONT}' font-size="${productTitleSize}" font-weight="950" fill="${C.ink}" letter-spacing="-4">${esc(productTitle)}</text>`;
  // rank（灰）紧跟 title 右侧，baseline 对齐
  // 英文 title 用 0.95 boost（接近实际渲染宽，避免 rank 跟 title 贴一起）；中文用 1
  const isEnTitle = /^[\x00-\x7F\s]+$/.test(productTitle);
  const titleW = estimateTextWidth(productTitle, productTitleSize, isEnTitle ? 0.95 : 1);
  const rankX = nameX + titleW + 32;
  const rankSvg = `<text x="${rankX}" y="${productTitleY}" font-family='${FONT}' font-size="54" font-weight="900" fill="${C.muted}">${esc(opts.rank)}</text>`;

  // tag pill (orange)
  const tagY = cy + productTitleSize + 22;
  const tagText = opts.tag;
  const tagW = estimateTextWidth(tagText, 28, 0.85) + 40;
  const tagSvg = `
    <rect x="${nameX}" y="${tagY}" width="${tagW}" height="46" rx="23" fill="${C.orangeSoft}"/>
    <text x="${nameX + tagW / 2}" y="${tagY + 32}" font-family='${FONT}' font-size="28" font-weight="850" fill="${C.orangeInk}" text-anchor="middle">${esc(tagText)}</text>`;

  cy += Math.max(logoSize, productTitleSize + 80) + 16;

  // body 36 / 1.48 / 5 lines
  const bodySize = 36;
  const bodyLine = bodySize * 1.48;
  const bodyLines = wrapText(opts.body, 24, 5);
  const bodySvg = bodyLines
    .map((line, i) => `<text x="${innerX}" y="${cy + bodySize + i * bodyLine}" font-family='${FONT}' font-size="${bodySize}" font-weight="500" fill="${C.ink}" letter-spacing="-0.5">${esc(line)}</text>`)
    .join('');
  cy += bodyLines.length * bodyLine + 30;

  // ph-stats: 3 cols
  const statRowY = cy;
  const statRowH = 100;
  const m = opts.stats || {};
  const statsArr = [
    { value: formatStat(m.comments), label: 'comments' },
    { value: m.rating || '—', label: 'reviews' },
    { value: formatStat(m.followers), label: 'followers' },
  ];
  const statColW = innerW / 3;
  let statsSvg = `<line x1="${innerX}" y1="${statRowY}" x2="${innerX + innerW}" y2="${statRowY}" stroke="${C.line}" stroke-width="1"/>`;
  statsArr.forEach((s, i) => {
    const cx = innerX + statColW * i + statColW / 2;
    statsSvg += `<text x="${cx}" y="${statRowY + 50}" font-family='${FONT}' font-size="34" font-weight="700" fill="${C.ink}" text-anchor="middle">${esc(s.value)}</text>`;
    statsSvg += `<text x="${cx}" y="${statRowY + 86}" font-family='${FONT}' font-size="24" font-weight="500" fill="${C.muted2}" text-anchor="middle">${esc(s.label)}</text>`;
    if (i < 2) {
      statsSvg += `<line x1="${cx + statColW / 2}" y1="${statRowY + 8}" x2="${cx + statColW / 2}" y2="${statRowY + statRowH - 10}" stroke="${C.line}" stroke-width="1"/>`;
    }
  });
  statsSvg += `<line x1="${innerX}" y1="${statRowY + statRowH + 8}" x2="${innerX + innerW}" y2="${statRowY + statRowH + 8}" stroke="${C.line}" stroke-width="1"/>`;
  cy = statRowY + statRowH + 24;

  // 有媒体：stats 之后放第一张 gallery 图（按比例缩放占满 innerW，最大高 520）
  let mediaSvg = '';
  if (opts.mediaImageDataUri) {
    const ar = opts.mediaAspectRatio && opts.mediaAspectRatio > 0 ? opts.mediaAspectRatio : 16 / 9;
    const mediaH = Math.min(innerW / ar, 520);
    const mediaW = mediaH * ar;
    const mediaX = innerX + (innerW - mediaW) / 2;
    const mediaY = cy;
    const clipId = `ph-media-clip-${Math.random().toString(36).slice(2, 8)}`;
    mediaSvg = `
      <defs><clipPath id="${clipId}"><rect x="${mediaX}" y="${mediaY}" width="${mediaW}" height="${mediaH}" rx="28"/></clipPath></defs>
      <rect x="${mediaX}" y="${mediaY}" width="${mediaW}" height="${mediaH}" rx="28" fill="#fbfbfc" stroke="rgba(15,23,42,0.06)" stroke-width="1"/>
      <image href="${opts.mediaImageDataUri}" x="${mediaX}" y="${mediaY}" width="${mediaW}" height="${mediaH}" clip-path="url(#${clipId})" preserveAspectRatio="xMidYMid slice"/>`;
    cy += mediaH + 16;
  }
  cy += 12;

  const totalH = cy - opts.y;
  return { svg: logoBg + phLogoInner + titleSvg + rankSvg + tagSvg + bodySvg + statsSvg + mediaSvg, height: totalH };
}

// ─── 顶层入口：renderShareSvg ──────────────────────────────
export interface PosterItem {
  id: string;
  source_type: 'x_list' | 'github' | 'product_hunt' | string;
  // X 字段
  author?: string;
  handle?: string;
  // 通用
  content?: string;
  content_translated?: string;
  title?: string;
  // GitHub 字段（来自 items.metrics + items.extra）
  metrics?: Record<string, unknown> | null;
  extra?: Record<string, unknown> | null;
  // 媒体图（worker 端 fetch 后传入 base64 data URI）
  // GH = readme_excerpt 第一张非 SVG 图；PH = media JSON 第一张 role=gallery
  // 有 → 渲 "有媒体" 排版（介于 header 和 body 之间）；无 → 排版同 v1
  mediaImageDataUri?: string;
  // 媒体图原始宽高比（fetched 后传入），用于按比缩放避免变形
  mediaAspectRatio?: number;
}

export interface PosterShareCtx {
  /** share_relations.token，作 hash fallback seed + clipPath id 唯一性 */
  token: string;
  /** 落地短链：https://ai-feeds.com/s/<token> — QR 内容 */
  shareUrl: string;
  /** 真实分享人昵称；缺失则按 from_uid hash fallback */
  sharerName?: string;
  /** 真实头像 data URI（worker fetch + base64 后传入）；缺失则色块 + 首字母 */
  sharerAvatarDataUri?: string;
  /** sharer hash seed（fallback 头像背景色 + 默认昵称用），通常传 from_uid */
  sharerSeed: string;
}

export async function renderShareSvg(item: PosterItem, ctx: PosterShareCtx): Promise<string> {
  const sourceMeta = pickSourceMeta(item.source_type);
  const cardX = 56, cardW = 1080 - 56 * 2;
  const cardOverlap = 130; // -130 from hero bottom
  const cardY = 360 - cardOverlap;

  let contentSvg = '';
  let contentH = 0;
  if (sourceMeta.kind === 'github') {
    const repo = (item.title || item.id.replace(/^github:/, '')) ?? '';
    const tag = pickGithubTag(item);
    const m = item.metrics || {};
    const extra = item.extra || {};
    const r = renderGithubContent({
      x: cardX, y: cardY, w: cardW,
      repoFullName: repo,
      tag,
      stars: (m.stars as number) ?? (m.total_stars as number) ?? 0,
      forks: (m.forks as number) ?? 0,
      watchers: (m.watchers as number) ?? 0,
      rankLabel: extra.daily_rank ? `GitHub 热榜 ${ordinal(Number(extra.daily_rank))}` : 'GitHub 热榜',
      contributors: extra.contributors_count ? `${extra.contributors_count} contributors` : undefined,
      body: bodyText(item),
      mediaImageDataUri: item.mediaImageDataUri,
      mediaAspectRatio: item.mediaAspectRatio,
    });
    contentSvg = r.svg;
    contentH = r.height;
  } else if (sourceMeta.kind === 'ph') {
    const m = item.metrics || {};
    const extra = item.extra || {};
    const r = renderPhContent({
      x: cardX, y: cardY, w: cardW,
      productName: item.title || 'Product',
      rank: extra.daily_rank ? `#${extra.daily_rank}` : (extra.rank ? `#${extra.rank}` : ''),
      tag: pickPhTag(item),
      body: bodyText(item),
      mediaImageDataUri: item.mediaImageDataUri,
      mediaAspectRatio: item.mediaAspectRatio,
      stats: {
        comments: m.comments as number | undefined,
        rating: m.rating ? String(m.rating) : undefined,
        followers: m.followers as number | undefined,
      },
    });
    contentSvg = r.svg;
    contentH = r.height;
  } else {
    // X / X List 默认走 X 模板
    const r = renderXContent({
      x: cardX, y: cardY, w: cardW,
      authorName: item.author || '?',
      authorHandle: item.handle || '',
      body: bodyText(item),
      metrics: {
        replies: Number((item.metrics as { replies?: number | string })?.replies) || 0,
        retweets: Number((item.metrics as { retweets?: number | string })?.retweets) || 0,
        likes: Number((item.metrics as { likes?: number | string })?.likes) || 0,
        views: Number((item.metrics as { views?: number | string })?.views) || 0,
      },
    });
    contentSvg = r.svg;
    contentH = r.height;
  }

  // Footer 区
  const footerH = 264; // QR(168) + gap(14) + hint(22) + 上下各 30 留白
  const footerMargin = 48;
  const footerX = 56;
  const footerY = cardY + contentH + footerMargin;
  const footerW = 1080 - 56 * 2;
  const footerSvg = await renderFooter(
    {
      seed: ctx.sharerSeed,
      nickname: ctx.sharerName?.trim() || defaultNickname(ctx.sharerSeed),
      avatarDataUri: ctx.sharerAvatarDataUri,
      qrUrl: ctx.shareUrl,
    },
    footerX, footerY, footerW, footerH,
  );

  const totalH = footerY + footerH + 96; // 底部留白 56 → 96

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="${totalH}" viewBox="0 0 1080 ${totalH}">
    ${topLevelDefs()}
    <rect width="1080" height="${totalH}" fill="${C.posterBg}"/>
    ${renderHero(sourceMeta.label, sourceMeta.chipColor)}
    ${renderCardBg(cardX, cardY, cardW, contentH)}
    ${contentSvg}
    ${footerSvg}
  </svg>`;
}

// ─── helpers: source meta / tag / body ────────────────────
function pickSourceMeta(sourceType: string): { kind: 'x' | 'github' | 'ph'; label: string; chipColor: string } {
  if (sourceType === 'github') return { kind: 'github', label: 'GitHub', chipColor: '#c1f0d8' };
  if (sourceType === 'product_hunt' || sourceType === 'ph') return { kind: 'ph', label: 'Product Hunt', chipColor: '#ffd1c1' };
  return { kind: 'x', label: 'X', chipColor: '#ffffff' };
}

function pickGithubTag(item: PosterItem): string {
  const extra = item.extra || {};
  // dashboard GithubCard 用 extra.ai_category；旧 / 兜底走 category / topic / 'project'
  return (extra.ai_category as string)
    || (extra.category as string)
    || (extra.topic as string)
    || 'project';
}

function pickPhTag(item: PosterItem): string {
  const extra = item.extra || {};
  // dashboard PhCard 也用 ai_category；categories[] 取首项作进一步兜底
  if (extra.ai_category) return String(extra.ai_category);
  if (Array.isArray(extra.categories) && extra.categories.length > 0) return String(extra.categories[0]);
  return 'product';
}

function bodyText(item: PosterItem): string {
  // GH / PH 优先用 extra.ai_summary（dashboard 抽屉「AI 解读亮点」即此字段）；
  // X 走 content_translated || content（推文正文本身就是要展示的主体）。
  const extra = item.extra || {};
  const aiSummary = typeof extra.ai_summary === 'string' ? extra.ai_summary.trim() : '';
  if ((item.source_type === 'github' || item.source_type === 'product_hunt') && aiSummary) {
    return aiSummary;
  }
  return item.content_translated || item.content || aiSummary || item.title || '';
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
