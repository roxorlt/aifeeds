import { describe, test, expect } from 'vitest';

import { markdownToSafeHtml } from './markdown-html';

// ─────────────────────────────────────────────────────────────────────────────
// well-formedness 校验：栈式配对 open/close（忽略 void），断言「无坏标签」。
// 净化器输出的属性值一律转义 `<`/`>`，故用 [^>]* 提取标签是安全的。
// ─────────────────────────────────────────────────────────────────────────────
const VOID = new Set(['img', 'br', 'hr']);
function isWellFormed(html: string): boolean {
  const stack: string[] = [];
  const re = /<(\/?)([a-z0-9]+)[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const close = m[1] === '/';
    const name = m[2].toLowerCase();
    if (VOID.has(name)) continue;
    if (!close) stack.push(name);
    else if (stack.pop() !== name) return false;
  }
  if (stack.length !== 0) return false;
  // 尾部不得留裸 '<'（截断切坏）
  const lt = html.lastIndexOf('<');
  const gt = html.lastIndexOf('>');
  return lt <= gt;
}

describe('markdownToSafeHtml — 正常 markdown 渲染', () => {
  test('标题 → h1/h2', () => {
    const { html } = markdownToSafeHtml('# 标题一\n\n## 标题二');
    expect(html).toContain('<h1>标题一</h1>');
    expect(html).toContain('<h2>标题二</h2>');
  });

  test('无序列表 → ul/li', () => {
    const { html } = markdownToSafeHtml('- 甲\n- 乙');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>甲</li>');
    expect(html).toContain('<li>乙</li>');
  });

  test('有序列表 → ol/li', () => {
    const { html } = markdownToSafeHtml('1. 一\n2. 二');
    expect(html).toContain('<ol>');
    expect(html).toContain('<li>一</li>');
  });

  test('代码块 → pre/code（内容保留、无属性泄漏）', () => {
    const { html } = markdownToSafeHtml('```js\nconst a = 1;\n```');
    expect(html).toContain('<pre>');
    expect(html).toContain('<code>');
    expect(html).toContain('const a = 1;');
    // marked 会给 code 加 class="language-js"，净化后应剥掉
    expect(html).not.toContain('language-js');
  });

  test('表格 → table/thead/tbody/tr/th/td', () => {
    const md = '| A | B |\n|---|---|\n| 1 | 2 |';
    const { html } = markdownToSafeHtml(md);
    expect(html).toContain('<table>');
    expect(html).toContain('<thead>');
    expect(html).toContain('<tbody>');
    expect(html).toMatch(/<th[^>]*>A<\/th>/);
    expect(html).toMatch(/<td[^>]*>1<\/td>/);
  });

  test('图片(http/https) → img[src] 保留 + alt', () => {
    const { html } = markdownToSafeHtml('![替代文字](https://cdn.x.com/a.png)');
    expect(html).toMatch(/<img[^>]*src="https:\/\/cdn\.x\.com\/a\.png"/);
    expect(html).toContain('alt="替代文字"');
  });

  test('链接(http/https) → a[href] 保留', () => {
    const { html } = markdownToSafeHtml('[点我](https://ai-feeds.com/x)');
    expect(html).toMatch(/<a[^>]*href="https:\/\/ai-feeds\.com\/x"[^>]*>点我<\/a>/);
  });

  test('相对链接 / 锚点 → a[href] 保留', () => {
    const { html } = markdownToSafeHtml('[相对](/foo) [锚](#sec)');
    expect(html).toContain('href="/foo"');
    expect(html).toContain('href="#sec"');
  });

  test('强调 / 粗体 / 行内代码 / 引用 / 分割线', () => {
    const { html } = markdownToSafeHtml('**粗** *斜* `码`\n\n> 引用\n\n---');
    expect(html).toContain('<strong>粗</strong>');
    expect(html).toContain('<em>斜</em>');
    expect(html).toContain('<code>码</code>');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<hr>');
  });

  test('已转义实体不被二次转义（& 不变 &amp;amp;）', () => {
    const { html } = markdownToSafeHtml('A & B < C');
    expect(html).toContain('&amp;');
    expect(html).not.toContain('&amp;amp;');
  });
});

describe('markdownToSafeHtml — 净化 XSS 向量', () => {
  test('script 标签 + 内容整体剥除', () => {
    const { html } = markdownToSafeHtml('前\n\n<script>alert(1)</script>\n\n后');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('alert(1)');
    expect(html).toContain('前');
    expect(html).toContain('后');
  });

  test('img onerror 事件属性剥除（src 保留）', () => {
    const { html } = markdownToSafeHtml('<img src="https://x.com/a.png" onerror="alert(1)">');
    expect(html).not.toMatch(/onerror/i);
    expect(html).not.toContain('alert(1)');
    expect(html).toContain('src="https://x.com/a.png"');
  });

  test('img 无引号 onerror 剥除', () => {
    const { html } = markdownToSafeHtml('<img src=x onerror=alert(1)>');
    expect(html).not.toMatch(/onerror/i);
    expect(html).not.toContain('alert(1)');
  });

  test('链接 javascript: 协议剥除（文本保留）', () => {
    const { html } = markdownToSafeHtml('[点](javascript:alert(1))');
    expect(html.toLowerCase()).not.toContain('javascript:');
    expect(html).not.toContain('alert(1)');
    expect(html).toContain('点');
  });

  test('iframe 剥除（含内容）', () => {
    const { html } = markdownToSafeHtml('<iframe src="https://evil.com/x"></iframe>');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('evil.com');
  });

  test('a 同时含 javascript href 与 onclick → 都剥，文本留', () => {
    const { html } = markdownToSafeHtml('<a href="javascript:x()" onclick="y()">链</a>');
    expect(html.toLowerCase()).not.toContain('javascript:');
    expect(html).not.toMatch(/onclick/i);
    expect(html).toContain('链');
  });

  test('非 allowlist 标签(div) + 事件属性 → 标签与事件都剥，文本留', () => {
    const { html } = markdownToSafeHtml('<div onmouseover="hack()">内容</div>');
    expect(html).not.toContain('<div');
    expect(html).not.toMatch(/onmouseover/i);
    expect(html).toContain('内容');
  });

  test('style 标签 + 内容剥除', () => {
    const { html } = markdownToSafeHtml('<style>body{background:url(evilcss)}</style>正文');
    expect(html).not.toContain('<style');
    expect(html).not.toContain('evilcss');
    expect(html).toContain('正文');
  });

  test('data: 图片剥除', () => {
    const { html } = markdownToSafeHtml('<img src="data:text/html,PAYLOAD">');
    expect(html).not.toContain('data:');
    expect(html).not.toContain('PAYLOAD');
  });

  test('实体编码绕过 javascript: 剥除（不留可解码残留）', () => {
    const { html } = markdownToSafeHtml('<a href="&#106;avascript:alert(1)">x</a>');
    expect(html.toLowerCase()).not.toContain('javascript:');
    expect(html).not.toMatch(/&#106;avascript/i);
    expect(html).not.toContain('alert(1)');
  });

  test('scheme 内插入 Tab/换行 绕过 javascript: 剥除', () => {
    const { html } = markdownToSafeHtml('<a href="jav\tascri\npt:alert(1)">x</a>');
    expect(html.toLowerCase()).not.toContain('javascript:');
    expect(html).not.toContain('alert(1)');
  });

  test('大小写混淆 <ScRiPt> 剥除', () => {
    const { html } = markdownToSafeHtml('<ScRiPt>alert(1)</ScRiPt>');
    expect(html.toLowerCase()).not.toContain('<script');
    expect(html).not.toContain('alert(1)');
  });

  test('svg 内嵌 script 剥除', () => {
    const { html } = markdownToSafeHtml('<svg><script>alert(1)</script></svg>尾');
    expect(html).not.toContain('<svg');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('alert(1)');
  });

  test('svg 自闭合 + onload 不吞后文（后文保留、无存活 svg/事件）', () => {
    const { html } = markdownToSafeHtml('<svg/onload=alert(1)></svg>后面还有正文段落');
    expect(html).not.toMatch(/\son\w+\s*=/i); // 无存活事件属性
    expect(html).not.toMatch(/<svg[\s/>]/i); // 无存活 svg 元素（转义为可见文本的 &lt;svg 不算）
    expect(html).toContain('后面还有正文段落'); // self-close 未把后文一并吞掉
  });

  test('object / embed 剥除', () => {
    const { html } = markdownToSafeHtml('<object data="evilobj"></object><embed src="evilembed">');
    expect(html).not.toContain('<object');
    expect(html).not.toContain('<embed');
    expect(html).not.toContain('evilobj');
    expect(html).not.toContain('evilembed');
  });

  test('img src 为相对/协议相对 → 剥除（img 仅 http(s)）', () => {
    const rel = markdownToSafeHtml('<img src="/local.png" alt="a">');
    expect(rel.html).not.toContain('src="/local.png"');
    const proto = markdownToSafeHtml('<img src="//evil.com/x.png">');
    expect(proto.html).not.toContain('//evil.com');
  });
});

describe('markdownToSafeHtml — 安全不变量（净化后零可执行）', () => {
  const vectors = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '[x](javascript:alert(1))',
    '<iframe src="https://evil"></iframe>',
    '<a href="javascript:void(0)" onclick="e()">t</a>',
    '<svg/onload=alert(1)>',
    '<body onload=alert(1)>正文',
    '<div onmouseover=x>y</div>',
    '<a href=" javascript:alert(1)">t</a>',
    '<a href="jAvAsCrIpT:alert(1)">t</a>',
    '<STYLE>x</STYLE>',
    '<img src=`javascript:alert(1)`>',
    '<a href="vbscript:msgbox(1)">t</a>',
    '<a href="data:text/html,<script>alert(1)</script>">t</a>',
  ];
  for (const v of vectors) {
    test(`向量无存活可执行: ${v.slice(0, 34)}`, () => {
      const { html } = markdownToSafeHtml(v);
      // 不变量断言的是「存活可执行」而非「子串出现」：被净化器转义成可见文本的 &lt;script… /
      // <code>javascript:…</code> 是惰性的，不会执行；只需保证没有存活的危险元素 / 事件 / 协议属性。
      // 无存活危险元素（转义文本 &lt;script 不匹配）
      expect(html).not.toMatch(/<(?:script|iframe|style|object|embed|svg|math|form)[\s/>]/i);
      // 无存活事件属性（标签内 on*=）
      expect(html).not.toMatch(/\son\w+\s*=/i);
      // 危险协议绝不出现在 href/src 属性位（可见文本里的 javascript: 是惰性的）
      expect(html).not.toMatch(/(?:href|src)\s*=\s*["']?\s*(?:java|vb)script:/i);
      expect(html).not.toMatch(/(?:href|src)\s*=\s*["']?\s*data:/i);
    });
  }
});

describe('markdownToSafeHtml — maxChars 截断', () => {
  test('超长按边界截断 + truncated=true + 无坏标签', () => {
    const long = Array.from(
      { length: 60 },
      (_, i) => `这是第 ${i} 个段落，包含一些用于测试截断行为的中文内容与说明。`,
    ).join('\n\n');
    const { html, truncated } = markdownToSafeHtml(long, { maxChars: 200 });
    expect(truncated).toBe(true);
    expect(isWellFormed(html)).toBe(true);
    expect(html.endsWith('<')).toBe(false);
    // 只保留了前面一小部分（远小于全文渲染）
    expect(html.length).toBeLessThan(2000);
  });

  test('未超长 → truncated=false，完整渲染', () => {
    const { html, truncated } = markdownToSafeHtml('# 短标题', { maxChars: 1000 });
    expect(truncated).toBe(false);
    expect(html).toContain('<h1>短标题</h1>');
  });

  test('截断落在 code fence 内 → 仍良构 HTML', () => {
    const md = '正文段落一。\n\n正文段落二。\n\n```\n' + 'x'.repeat(600) + '\n```';
    const { html, truncated } = markdownToSafeHtml(md, { maxChars: 120 });
    expect(truncated).toBe(true);
    expect(isWellFormed(html)).toBe(true);
  });

  test('无 maxChars → 不截断', () => {
    const long = 'a'.repeat(5000);
    const { truncated } = markdownToSafeHtml(long);
    expect(truncated).toBe(false);
  });
});

describe('markdownToSafeHtml — 边界 / 降级', () => {
  test('空串 → 空 html 不崩', () => {
    expect(markdownToSafeHtml('')).toEqual({ html: '', truncated: false });
  });

  test('null / undefined → 空 html 不崩', () => {
    expect(markdownToSafeHtml(null as unknown as string)).toEqual({ html: '', truncated: false });
    expect(markdownToSafeHtml(undefined as unknown as string)).toEqual({ html: '', truncated: false });
  });

  test('纯空白 → 空 html', () => {
    const { html } = markdownToSafeHtml('   \n\n  ');
    expect(html.trim()).toBe('');
  });

  test('纯文本 → 内容保留', () => {
    const { html } = markdownToSafeHtml('就是一段普通文字');
    expect(html).toContain('就是一段普通文字');
  });
});
