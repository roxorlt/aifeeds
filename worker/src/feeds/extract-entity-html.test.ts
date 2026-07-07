import { describe, test, expect } from 'vitest';
import {
  htmlToMarkdown,
  decodeEntityEncodedHtml,
  looksLikeStructuralHtml,
} from './extract';

// Task 1（2026-07-06）：RSSHub 源（jiqizhixin / weibo-hot-tech）正文在 RSS description 里是
// 实体编码（甚至双重 &amp;lt;）的 HTML，htmlToMarkdown 的 tag 正则按字面 <...> 匹配全空转，
// 末尾 decodeEntities 把 &lt;p&gt; 还原成字面 <p> 泄漏进正文。修法：进转换管线前检测「实体
// 编码 HTML」并先解码一次，再走既有转换。其他源（CDATA 真 HTML / 纯文本）零影响。
const BASE = 'https://jiqizhixin.com/articles/1';

describe('decodeEntityEncodedHtml — 实体编码 HTML 检测 + 单次解码', () => {
  test('双重实体编码结构标签 → 解码成真 HTML', () => {
    const input = '&amp;lt;p&amp;gt;正文&amp;lt;/p&amp;gt;';
    const out = decodeEntityEncodedHtml(input);
    expect(out).toBe('<p>正文</p>');
  });

  test('单层实体编码结构标签 → 解码成真 HTML', () => {
    const input = '&lt;p&gt;正文&lt;/p&gt;';
    expect(decodeEntityEncodedHtml(input)).toBe('<p>正文</p>');
  });

  test('已是真 HTML（含裸结构标签）→ 原样返回，不误解码', () => {
    const input = '<p>正文 &amp; 更多</p>';
    expect(decodeEntityEncodedHtml(input)).toBe(input);
  });

  test('含字面 &lt; 但非结构标签的纯文本 → 原样返回（不误判为 HTML）', () => {
    const input = 'x &lt; y 的比较，a &gt; b';
    expect(decodeEntityEncodedHtml(input)).toBe(input);
  });

  test('looksLikeStructuralHtml：真标签 / 实体标签 命中，纯文本不命中', () => {
    expect(looksLikeStructuralHtml('<p>x</p>')).toBe(true);
    expect(looksLikeStructuralHtml('&lt;img src="a">')).toBe(true);
    expect(looksLikeStructuralHtml('&amp;lt;p&amp;gt;x')).toBe(true);
    expect(looksLikeStructuralHtml('x &lt; y 的比较')).toBe(false);
    expect(looksLikeStructuralHtml('普通中文正文，没有标签')).toBe(false);
  });
});

describe('htmlToMarkdown — 实体编码 HTML 正确转换（Task 1 主修）', () => {
  test('双重实体编码 <p> + <img> → 正常段落 + markdown 图，无字面 <p> / &lt;p&gt;', () => {
    const input =
      '&amp;lt;p&amp;gt;正文&amp;lt;/p&amp;gt;&amp;lt;img src="x"&amp;gt;';
    const { markdown } = htmlToMarkdown(input, BASE);
    expect(markdown).toContain('正文');
    // markdown 图（img 转成 ![](...)，src 解析为绝对 URL 含 x）
    expect(markdown).toMatch(/!\[\]\([^)]*x[^)]*\)/);
    // 不含字面标签泄漏
    expect(markdown).not.toContain('<p>');
    expect(markdown).not.toContain('<img');
    expect(markdown).not.toContain('&lt;p&gt;');
    expect(markdown).not.toContain('&amp;lt;');
  });

  test('单层实体编码 <p></p> → 正常段落文本，无字面标签', () => {
    const input = '&lt;p&gt;第一段&lt;/p&gt;&lt;p&gt;第二段&lt;/p&gt;';
    const { markdown } = htmlToMarkdown(input, BASE);
    expect(markdown).toContain('第一段');
    expect(markdown).toContain('第二段');
    expect(markdown).not.toContain('<p>');
    expect(markdown).not.toContain('&lt;');
  });

  test('实体编码 <strong> → markdown 加粗，不泄漏标签', () => {
    const input =
      '&amp;lt;p&amp;gt;看&amp;lt;strong&amp;gt;重点&amp;lt;/strong&amp;gt;这里&amp;lt;/p&amp;gt;';
    const { markdown } = htmlToMarkdown(input, BASE);
    expect(markdown).toContain('**重点**');
    expect(markdown).not.toContain('<strong>');
    expect(markdown).not.toContain('&lt;strong');
  });

  test('回归锁：CDATA 真 HTML 源 → 输出与既有转换逐字节一致（不受实体检测影响）', () => {
    const input = '<p>Hello <strong>world</strong></p><p>Second</p>';
    const { markdown } = htmlToMarkdown(input, 'https://ex.com/a');
    expect(markdown).toBe('Hello **world**\n\nSecond');
  });

  test('回归锁：CDATA 包真 HTML（含 <img>）→ 正常转 markdown 图', () => {
    const input =
      '<![CDATA[<p>图注</p><img src="https://cdn.example/hero.png" alt="hero">]]>';
    const { markdown } = htmlToMarkdown(input, 'https://ex.com/a');
    expect(markdown).toContain('图注');
    expect(markdown).toContain('![hero](https://cdn.example/hero.png)');
  });

  test('回归锁：纯文本含 &lt; → 只解码实体，不当 HTML 处理（内容不被破坏）', () => {
    const input = 'x &lt; y 的比较';
    const { markdown } = htmlToMarkdown(input, 'https://ex.com/a');
    expect(markdown).toBe('x < y 的比较');
  });
});
