// worker/src/seo/markdown-html.ts
//
// markdown → 安全 HTML（供 /i/ SSR 内容页渲染 gh README / 我们的分析等全文正文）。
//
// 输入是译文 / 第三方 markdown（可能内嵌裸 HTML，甚至恶意 <script>/on*=/javascript:），
// 输出用于 SSR 页直出 —— **净化是安全底线**：SSR 页零可执行 script。
//
// 管线：markdown ──marked──▶ HTML ──allowlist 净化──▶ 安全 HTML。
//   - md→HTML 用 marked（纯 JS、零运行时依赖，可进 worker bundle）。marked v5+ 已移除内建
//     sanitize，会把裸 <script> / javascript: href 原样透传 —— 故本模块的净化层是**必需**的。
//   - 净化用手写 allowlist tokenizer（worker 无 DOM / DOMPurify）：单遍扫描，识别标签边界，
//     保留白名单标签 + 白名单属性，剥 script/style/iframe 等危险元素**及其内容**，剥所有 on*=
//     事件属性，a[href] 仅放行 http(s)/相对/锚点，img[src] 仅放行 http(s)。
//   - 正则净化 HTML 有陷阱（大小写、实体绕过、scheme 内插空白、self-close 吞后文），本实现对
//     这些向量逐一防护，测试穷举覆盖（见 markdown-html.test.ts）。
//
// maxChars：在**转换前**按段落 / 词边界截断 markdown 源（marked 始终输出良构 HTML，故
//   截断后不产生未闭合坏标签），truncated 标记是否发生截断。
//
// 设计文档：docs/plans/2026-07-08-item-page-fulltext-plan.md Task 1

import { marked } from 'marked';

// ─────────────────────────────────────────────────────────────────────────────
// allowlist
// ─────────────────────────────────────────────────────────────────────────────

/** 保留的结构标签。 */
const ALLOWED_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li',
  'a', 'img',
  'strong', 'em', 'b', 'i', 'code', 'pre', 'blockquote',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'hr', 'br',
]);

/** 空元素（无闭合标签，输出后不入配对栈）。 */
const VOID_TAGS = new Set(['img', 'hr', 'br']);

/**
 * 危险容器元素：整段（开标签 → 匹配闭标签之间的内容）一并剥除。
 * 这些元素的内容要么可执行（script/style），要么可藏 XSS（svg/math 可含 <script>/foreignObject，
 * iframe/object/embed 可加载外部资源）。均为「有闭合标签」的容器（void 的 meta/link/base 不在此，
 * 走「非白名单标签→仅剥标签」分支，避免误吞到文末）。
 */
const FORBIDDEN_CONTAINERS = new Set([
  'script', 'style', 'iframe', 'object', 'embed',
  'svg', 'math', 'noscript', 'template', 'textarea',
  'xmp', 'noembed', 'noframes', 'title', 'applet',
]);

/** 每标签放行的属性白名单（其余属性一律剥；on*= 无条件剥）。 */
const ATTR_ALLOW: Record<string, Set<string>> = {
  a: new Set(['href']),
  img: new Set(['src', 'alt', 'title', 'width', 'height']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan', 'scope']),
};

// ─────────────────────────────────────────────────────────────────────────────
// 对外接口
// ─────────────────────────────────────────────────────────────────────────────

export function markdownToSafeHtml(
  md: string,
  opts?: { maxChars?: number },
): { html: string; truncated: boolean } {
  if (typeof md !== 'string' || md.length === 0) {
    return { html: '', truncated: false };
  }

  const maxChars = opts?.maxChars;
  const { text, truncated } = truncateMarkdown(md, maxChars);

  if (text.trim().length === 0) {
    return { html: '', truncated };
  }

  let rawHtml: string;
  try {
    // marked v5+ parse 同步返回 string（无 async 扩展时）。gfm 开启表格 / 删除线。
    rawHtml = marked.parse(text, { async: false, gfm: true, breaks: false }) as string;
  } catch {
    // 转换异常时优雅降级：纯文本转义包段落，绝不 throw / 泄漏原始 HTML。
    return { html: `<p>${escapeText(text)}</p>`, truncated };
  }

  return { html: sanitizeHtml(rawHtml).trim(), truncated };
}

// ─────────────────────────────────────────────────────────────────────────────
// 截断（转换前，按边界切 markdown 源）
// ─────────────────────────────────────────────────────────────────────────────

function truncateMarkdown(
  md: string,
  maxChars?: number,
): { text: string; truncated: boolean } {
  if (!maxChars || maxChars <= 0 || md.length <= maxChars) {
    return { text: md, truncated: false };
  }
  let cut = md.slice(0, maxChars);
  const floor = Math.floor(maxChars * 0.5);
  // 优先段落边界（\n\n），其次任意空白边界，都在下限之后才采用（避免切得过短）。
  const para = cut.lastIndexOf('\n\n');
  if (para > floor) {
    cut = cut.slice(0, para);
  } else {
    const ws = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('\n'));
    if (ws > floor) cut = cut.slice(0, ws);
  }
  cut = cut.replace(/\s+$/, '');
  // code fence 若被切成奇数个 ``` ，补一个闭合（marked 本会自动闭合，此举让输出更干净）。
  if ((cut.match(/```/g) || []).length % 2 === 1) {
    cut += '\n```';
  }
  return { text: cut, truncated: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// 净化 tokenizer（单遍扫描；worker 无 DOM）
// ─────────────────────────────────────────────────────────────────────────────

// <(/?)(tagname)(attrs)> —— attrs 字符类显式排除 > " ' 后再交替引号串，无二义 → 无灾难回溯。
const TAG_RE = /^<(\/?)([a-zA-Z][a-zA-Z0-9:_-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/;

function sanitizeHtml(html: string): string {
  const out: string[] = [];
  const n = html.length;
  let i = 0;

  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      out.push(html.slice(i)); // marked 输出的文本节点已转义，原样带上，避免二次转义
      break;
    }
    if (lt > i) out.push(html.slice(i, lt));

    // 注释 <!-- --> ：整段丢弃
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    // 声明 / CDATA / PI：<! 或 <? 到下一个 '>' 丢弃
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      const gt = html.indexOf('>', lt);
      i = gt < 0 ? n : gt + 1;
      continue;
    }

    const m = TAG_RE.exec(html.slice(lt));
    if (!m) {
      // 非合法标签起始的裸 '<' → 转义为可见文本（不当标签解析）
      out.push('&lt;');
      i = lt + 1;
      continue;
    }

    const isClose = m[1] === '/';
    const tag = m[2].toLowerCase();
    const attrStr = m[3] || '';
    const tagLen = m[0].length;
    // self-close 判定：'>' 前紧邻的 '/'（引号内的 '/' 不算，因其后是引号非 '>'）。
    const selfClose = m[0].slice(0, -1).replace(/\s+$/, '').endsWith('/');

    if (FORBIDDEN_CONTAINERS.has(tag)) {
      if (isClose || selfClose) {
        // 游离闭标签 / 自闭合危险元素：仅丢弃这一个标签，不吞后续内容
        i = lt + tagLen;
      } else {
        // 开标签：连同内容扫到匹配闭标签一并丢弃；无闭标签则丢到文末（安全优先）
        const closeRe = new RegExp(`</${escapeRe(tag)}(?:\\s[^>]*)?>`, 'i');
        const rest = html.slice(lt + tagLen);
        const cm = closeRe.exec(rest);
        i = cm ? lt + tagLen + cm.index + cm[0].length : n;
      }
      continue;
    }

    if (ALLOWED_TAGS.has(tag)) {
      if (isClose) {
        if (!VOID_TAGS.has(tag)) out.push(`</${tag}>`);
      } else {
        const safeAttrs = sanitizeAttrs(tag, attrStr);
        if (tag === 'img' && !safeAttrs.includes('src=')) {
          // img 无合法 src（相对 / data: / 缺失）→ 整个 img 丢弃（无意义且防残留）
        } else {
          out.push(`<${tag}${safeAttrs}>`);
        }
      }
      i = lt + tagLen;
      continue;
    }

    // 非白名单、非危险容器（div/span/section/font/…）：仅剥标签本身，保留其文本内容
    i = lt + tagLen;
  }

  return out.join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// 属性净化
// ─────────────────────────────────────────────────────────────────────────────

// name(=value)?  value 可为双引号 / 单引号 / 无引号（无引号排除空白与 " ' = < > `）。
const ATTR_RE =
  /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function sanitizeAttrs(tag: string, attrStr: string): string {
  const allow = ATTR_ALLOW[tag];
  if (!allow) return ''; // 该标签不放行任何属性
  const kept: string[] = [];
  let m: RegExpExecArray | null;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(attrStr)) !== null) {
    if (m[0] === '') {
      ATTR_RE.lastIndex++; // 空匹配保护，防死循环
      continue;
    }
    const name = m[1].toLowerCase();
    const rawValue = m[2] ?? m[3] ?? m[4] ?? '';
    if (name.startsWith('on')) continue; // 事件处理器一律剥
    if (!allow.has(name)) continue;

    if ((tag === 'a' && name === 'href') || (tag === 'img' && name === 'src')) {
      const allowRelative = tag === 'a'; // img 仅 http(s)；a 允许相对 / 锚点
      const url = sanitizeUrl(rawValue, allowRelative);
      if (url) kept.push(`${name}="${escapeAttr(url)}"`);
      continue;
    }
    // 其余放行属性（alt/title/width/height/colspan/…）：转义后原样保留
    kept.push(`${name}="${escapeAttr(decodeEntities(rawValue))}"`);
  }
  return kept.length ? ' ' + kept.join(' ') : '';
}

/**
 * URL 净化。返回可安全放入属性的值，或 null（拒绝）。
 * 防护：实体绕过（&#106;avascript: / 双重 &amp;#106;）、scheme 内插空白 / 控制字符
 * （jav<TAB>ascript:）、大小写混淆（jAvAsCrIpT:）。
 * - 先深度 decodeEntities，再剥所有空白 + 控制字符做 scheme 检测；
 * - 有 scheme 且非 http/https → 拒绝（javascript:/data:/vbscript:/file: 等全挡）；
 * - 无 scheme：allowRelative=true 放行（相对 / 锚点 / 协议相对），false 拒绝（img 只要 http(s)）。
 */
function sanitizeUrl(raw: string, allowRelative: boolean): string | null {
  if (!raw) return null;
  const decoded = decodeEntitiesDeep(raw).trim();
  if (!decoded) return null;
  // scheme 检测：剥一切空白 + 控制字符（浏览器解析 URL 会忽略 \t\n\r 等），再看开头协议。
  const forScheme = stripControl(decoded, false);
  const schemeMatch = forScheme.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') return null;
  } else if (!allowRelative) {
    return null;
  }
  // 输出剥控制字符（保留普通空格），避免浏览器解码后重组危险 scheme。
  const cleaned = stripControl(decoded, true);
  return cleaned || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 低层工具
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 剥除控制 / 空白字符（码点 ≤ 0x20 或 == 0x7F）。keepSpace=true 时保留普通空格 (0x20)。
 * 用码点判断而非含控制字符的正则字面量，避免源码里出现裸控制字节。
 */
function stripControl(s: string, keepSpace: boolean): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x7f) continue;
    if (c <= 0x20) {
      if (keepSpace && c === 0x20) out += ' ';
      continue;
    }
    out += s[i];
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 文本节点转义（仅用于降级路径 / 裸 '<'；marked 正常输出已转义，不走此函数以免二次转义）。 */
function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 属性值转义（含引号与尖括号，防属性 / 标签越界）。 */
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 反复 decodeEntities 至稳定（≤5 次），拆穿双重 / 多重编码绕过。 */
function decodeEntitiesDeep(s: string): string {
  let prev = s;
  for (let k = 0; k < 5; k++) {
    const next = decodeEntities(prev);
    if (next === prev) return next;
    prev = next;
  }
  return prev;
}

/** HTML 实体解码（数值 + 常见命名实体）；用于 URL scheme 检测与非 URL 属性归一。 */
function decodeEntities(s: string): string {
  return s
    .replace(/&#[xX]([0-9a-fA-F]+);?/g, (_, h) => {
      const code = parseInt(h, 16);
      return Number.isFinite(code) ? safeFromCodePoint(code) : _;
    })
    .replace(/&#(\d+);?/g, (_, d) => {
      const code = parseInt(d, 10);
      return Number.isFinite(code) ? safeFromCodePoint(code) : _;
    })
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&Tab;/gi, '\t')
    .replace(/&NewLine;/gi, '\n')
    .replace(/&colon;/gi, ':')
    .replace(/&nbsp;/gi, ' ');
}

function safeFromCodePoint(code: number): string {
  try {
    if (code < 0 || code > 0x10ffff) return '';
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}
