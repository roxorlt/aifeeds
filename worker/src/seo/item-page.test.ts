import { describe, test, expect } from 'vitest';

import { renderItemPageHtml } from './item-page';
import type { Env } from '../index';
import type { RenderRow, RenderedItem } from '../digest/render';
import { ccItemPageProfile } from '../cc-mirror/profile';

const SITE = 'https://ai-feeds.com';
const API = 'https://api.ai-feeds.com';

function envFixture(): Env {
  return { SITE_BASE: SITE, API_BASE: API } as unknown as Env;
}

// fixture RenderRow：不依赖 DB / SELECT。published_at 等 SELECT * 才有的列以额外属性挂上（运行期存在）。
function mkRow(over: Partial<RenderRow> & Record<string, unknown> = {}): RenderRow {
  return {
    id: 'x_list:1890',
    title: null,
    content: null,
    content_translated: '这是一条推文的完整中文翻译，包含足够的正文内容供检索抓取。',
    author: '@someone',
    handle: '@someone',
    url: 'https://x.com/u/status/1890',
    media: null,
    extra: JSON.stringify({ ai_summary: '推文要点标题' }),
    published_at: '2026-07-01T08:00:00Z',
    ...over,
  } as RenderRow;
}

function mkRelated(id: string, title: string): RenderedItem {
  return {
    rank: 1, item_id: id, source: 'x', title,
    summary: '', summary_full: '', url: '', deep_link: '',
    author: '', cover: null, logo: null, media: [],
  };
}

function stripJsonLd(html: string): string {
  return html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, '');
}
function extractJsonLd(html: string): { '@graph': Array<Record<string, unknown>> } {
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no JSON-LD block found');
  return JSON.parse(m[1]);
}
function graphTypes(html: string): string[] {
  return extractJsonLd(html)['@graph'].map((g) => String(g['@type']));
}
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, out);
  } else if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) collectStrings(entry, out);
  }
  return out;
}
function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      i++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe('renderItemPageHtml', () => {
  test('description 的 150 code point 边界保留完整 emoji', () => {
    const summary = 'a'.repeat(149) + '🔥' + 'tail';
    const html = renderItemPageHtml(
      mkRow({ content_translated: summary, extra: JSON.stringify({ ai_summary: '标题' }) }),
      envFixture(),
    );
    const article = extractJsonLd(html)['@graph'].find((g) => g['@type'] === 'Article')!;

    expect(article.description).toBe('a'.repeat(149) + '🔥…');
    expect(hasLoneSurrogate(String(article.description))).toBe(false);
  });

  test('JSON-LD 边界修复任意上游孤立 surrogate，并安全转义内联脚本字符', () => {
    const html = renderItemPageHtml(
      mkRow({
        author: '作者\ud83d\u2028\u2029',
        content_translated: '正文内容',
        extra: JSON.stringify({ ai_summary: '标题</script>\udc00' }),
      }),
      envFixture(),
    );
    const jsonText = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1];
    const jsonLd = extractJsonLd(html);

    expect(collectStrings(jsonLd).some(hasLoneSurrogate)).toBe(false);
    expect(collectStrings(jsonLd).join(' ')).toContain('\ufffd');
    expect(jsonText).not.toContain('</script>');
    expect(jsonText).toContain('\\u003c');
    expect(jsonText).toContain('\\u2028');
    expect(jsonText).toContain('\\u2029');
  });

  test('唯一 h1 + canonical 为 /i/ self + JSON-LD @graph 含 Article/BreadcrumbList/Organization', () => {
    const html = renderItemPageHtml(mkRow(), envFixture());
    expect((html.match(/<h1[\s>]/g) || []).length).toBe(1);
    expect(html).toContain(`<link rel="canonical" href="${SITE}/i/x/1890">`);
    const types = graphTypes(html);
    expect(types).toContain('Article');
    expect(types).toContain('BreadcrumbList');
    expect(types).toContain('Organization');
    // JSON-LD 可解析（extractJsonLd 已 JSON.parse）
    expect(() => extractJsonLd(html)).not.toThrow();
  });

  test('title = {中文标题} | AI Feeds；og:type=article；self-canonical 也是 og:url', () => {
    const html = renderItemPageHtml(mkRow(), envFixture());
    expect(html).toContain('<title>推文要点标题 | AI Feeds</title>');
    expect(html).toContain('<meta property="og:type" content="article">');
    expect(html).toContain(`<meta property="og:url" content="${SITE}/i/x/1890">`);
  });

  test('Article 含 inLanguage=zh-CN / mainEntityOfPage=canonical / datePublished', () => {
    const html = renderItemPageHtml(mkRow(), envFixture());
    const article = extractJsonLd(html)['@graph'].find((g) => g['@type'] === 'Article')!;
    expect(article.inLanguage).toBe('zh-CN');
    expect(article.mainEntityOfPage).toBe(`${SITE}/i/x/1890`);
    expect(article.datePublished).toBe('2026-07-01T08:00:00Z');
  });

  test('CTA「打开互动版」指 SPA 深链（deepLinkPath）；相关内链指 /i/ 路径', () => {
    const related = [mkRelated('x_list:2000', '相关推文一'), mkRelated('github:acme/tool', '相关仓库')];
    const html = renderItemPageHtml(mkRow(), envFixture(), related);
    // CTA = SPA 深链 /t/
    expect(html).toContain('打开互动版');
    expect(html).toContain(`href="${SITE}/t/1890"`);
    // 相关内链走 /i/ 静态页
    expect(html).toContain('相关内容');
    expect(html).toContain(`${SITE}/i/x/2000`);
    expect(html).toContain(`${SITE}/i/gh/acme/tool`);
    // 相关内链不得错配成 SPA 深链
    expect(html).not.toContain(`${SITE}/t/2000`);
    expect(html).not.toContain(`${SITE}/g/acme/tool`);
  });

  test('related 为空时不渲染相关内容区', () => {
    const html = renderItemPageHtml(mkRow(), envFixture(), []);
    expect(html).not.toContain('相关内容');
  });

  test('原文外链带 target=_blank rel="noopener nofollow"；封面 loading=lazy', () => {
    const row = mkRow({ media: JSON.stringify([{ type: 'image', url: `${API}/r/x/pic.jpg` }]) });
    const html = renderItemPageHtml(row, envFixture());
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener nofollow"');
    expect(html).toMatch(/<img[^>]*loading="lazy"/);
  });

  test('剥 JSON-LD 岛后无 <script；外部文本 < & " 被 HTML 转义（XSS fixture）', () => {
    const row = mkRow({
      id: 'blog:hash1',
      content_translated: null,
      extra: JSON.stringify({
        title_zh: '危险 <script>alert("x")</script> & 标题',
        ai_summary_zh: '摘要 <b> & "引号"',
        excerpt_zh: '正文段落 <img> & "更多文本"，与摘要不同源。',
      }),
    });
    const html = renderItemPageHtml(row, envFixture());
    // 剥掉合法 JSON-LD 数据岛后不应再有任何 <script（标题里的 </script> 被转义）
    expect(stripJsonLd(html)).not.toContain('<script');
    expect(html).toContain('&lt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;');
    // 数据岛仍可解析
    expect(() => extractJsonLd(html)).not.toThrow();
    // 恰好一个 <script（JSON-LD 岛）
    expect((html.match(/<script/g) || []).length).toBe(1);
  });

  test('PH row（product_hunt:slug:date）→ canonical=/i/ph/slug（无 date），CTA 深链保留 date', () => {
    const row = mkRow({
      id: 'product_hunt:coolslug:2026-07-08',
      title: 'Cool Product',
      content_translated: null,
      extra: JSON.stringify({ ai_summary: '产品摘要', description_zh: '详细的产品中文描述内容供检索。' }),
    });
    const html = renderItemPageHtml(row, envFixture());
    expect(html).toContain(`<link rel="canonical" href="${SITE}/i/ph/coolslug">`);
    expect(html).not.toContain('/i/ph/coolslug/2026-07-08');
    // 「打开互动版」CTA 走 SPA 深链，仍保留 date
    expect(html).toContain(`href="${SITE}/ph/coolslug/2026-07-08"`);
    expect(html).toContain('<title>Cool Product | AI Feeds</title>');
  });

  test('gh row → canonical /i/gh/owner/repo；标题取 repo 名', () => {
    const row = mkRow({ id: 'github:acme/tool', content_translated: null, extra: JSON.stringify({ ai_summary: '仓库摘要' }) });
    const html = renderItemPageHtml(row, envFixture());
    expect(html).toContain(`<link rel="canonical" href="${SITE}/i/gh/acme/tool">`);
    expect(html).toContain('<title>tool | AI Feeds</title>');
  });

  test('blog（半文源）：我们的摘要 + 要点 + 显著阅读原文链（正文区改由 renderItemBody 出）', () => {
    const row = mkRow({
      id: 'blog:hash2',
      url: 'https://openai.com/blog/some-post',
      content_translated: null,
      extra: JSON.stringify({
        title_zh: '新闻标题',
        ai_summary_zh: '一句话新闻摘要。',
        excerpt_zh: '完全不同的图文扩展正文内容，与一句话摘要并非同源。',
      }),
    });
    const html = renderItemPageHtml(row, envFixture());
    // 我们的摘要作引导段（.summary-full），excerpt 作要点段（.summary）。
    expect(html).toContain('一句话新闻摘要。');
    expect(html).toContain('完全不同的图文扩展正文内容，与一句话摘要并非同源。');
    // 半文源必有显著「阅读原文」出处链（带域名署名）。
    expect(html).toContain('阅读原文（openai.com）');
    expect(html).toMatch(/href="https:\/\/openai\.com\/blog\/some-post"[^>]*rel="noopener nofollow"/);
  });

  test('绝对 URL 一律用 env.SITE_BASE（footer 订阅/首页/归档）', () => {
    const html = renderItemPageHtml(mkRow(), envFixture());
    expect(html).toContain(`href="${SITE}/subscribe"`);
    expect(html).toContain(`href="${SITE}/"`);
    expect(html).toContain(`href="${SITE}/daily/"`);
    expect(html).toContain(`href="${SITE}/archive/"`);
  });

  test('item 页和 JSON-LD 面包屑链接到 SSR source/month archive，不再指向 SPA query', () => {
    const html = renderItemPageHtml(mkRow(), envFixture());
    expect(html).toContain(`href="${SITE}/archive/x/"`);
    expect(html).toContain(`href="${SITE}/archive/x/2026-07/"`);
    expect(html).not.toContain(`${SITE}/?source=x`);

    const breadcrumb = extractJsonLd(html)['@graph'].find(
      (entry) => entry['@type'] === 'BreadcrumbList',
    )!;
    const items = breadcrumb.itemListElement as Array<Record<string, unknown>>;
    expect(items[1].item).toBe(`${SITE}/archive/x/`);
  });

  test('hf-paper archive 的公开路径使用 /archive/paper/', () => {
    const html = renderItemPageHtml(
      mkRow({
        id: 'hf_paper:2607.12345',
        extra: JSON.stringify({ title_zh: '论文标题', summary_zh: '论文摘要' }),
      }),
      envFixture(),
    );
    expect(html).toContain(`${SITE}/archive/paper/`);
  });

  test('.cc profile 自 canonical、站内相关链接留在 .cc，CTA 由用户点击前往 .com 并带 UTM', () => {
    const ccEnv = {
      SITE_BASE: SITE,
      CC_SITE_BASE: 'https://www.ai-feeds.cc/',
      API_BASE: API,
    } as Env;
    const html = renderItemPageHtml(
      mkRow(),
      ccEnv,
      [mkRelated('github:acme/tool', '相关仓库')],
      ccItemPageProfile(ccEnv),
    );
    const jsonLd = extractJsonLd(html);
    const strings = collectStrings(jsonLd);

    expect(html).toContain('<title>推文要点标题 | AI源信</title>');
    expect(html).toContain('<div class="brand"><a href="https://www.ai-feeds.cc/">AI源信</a></div>');
    expect(html).toContain('<link rel="canonical" href="https://www.ai-feeds.cc/i/x/1890">');
    expect(html).toContain('<meta property="og:url" content="https://www.ai-feeds.cc/i/x/1890">');
    expect(strings).toContain('https://www.ai-feeds.cc/i/x/1890');
    expect(strings).toContain('https://www.ai-feeds.cc/archive/x/');
    expect(html).toContain('https://www.ai-feeds.cc/i/gh/acme/tool');
    expect(html).toMatch(
      /href="https:\/\/ai-feeds\.com\/t\/1890\?utm_source=ai-feeds\.cc&amp;utm_medium=referral&amp;utm_campaign=cc_content_mirror"/,
    );
    expect(stripJsonLd(html)).not.toMatch(
      /<meta[^>]+http-equiv=["']?refresh|window\.location|location\.(?:href|replace|assign)/i,
    );
    expect((html.match(/<script/g) || []).length).toBe(1);
  });

  test('.cc profile 固定展示备案、法律与联系信息，原文 URL 保持来源站', () => {
    const ccEnv = { SITE_BASE: SITE, API_BASE: API } as Env;
    const html = renderItemPageHtml(
      mkRow({ url: 'https://publisher.example/original-story' }),
      ccEnv,
      [],
      ccItemPageProfile(ccEnv),
    );

    expect(html).toContain('京ICP备2025123594号-2');
    expect(html).toContain('京公网安备11010802048455号');
    expect(html).toContain('support@ai-feeds.cc');
    expect(html).toContain('href="https://ai-feeds.cc/privacy.html"');
    expect(html).toContain('href="https://ai-feeds.cc/terms.html"');
    expect(html).toContain('href="https://ai-feeds.cc/contact.html"');
    expect(html).toContain('href="https://publisher.example/original-story"');
  });

  test('.cc blog JSON-LD articleBody 只来自已审核可见短文本，不泄露可见截断后的敏感尾段', () => {
    const hiddenMarker = 'BLOG_AFTER_VISIBLE_SUMMARY_SENSITIVE_MARKER';
    const row = mkRow({
      id: 'blog:hash-cc',
      title: 'raw title',
      content_translated: null,
      url: 'https://theverge.com/ai/story',
      extra: JSON.stringify({
        feed_key: 'the-verge',
        title_zh: '新闻标题',
        ai_summary_zh: '中性 AI 新闻摘要。',
        excerpt_zh: `${'可见编辑要点。'.repeat(70)}${hiddenMarker}`,
      }),
    });
    const html = renderItemPageHtml(row, envFixture(), [], ccItemPageProfile(envFixture()));
    const article = extractJsonLd(html)['@graph'].find((g) => g['@type'] === 'Article')!;

    expect(html).toContain('中性 AI 新闻摘要。');
    expect(html).not.toContain(hiddenMarker);
    expect(String(article.articleBody)).not.toContain(hiddenMarker);
  });

  test('.cc podcast 页面与 JSON-LD 都不包含 transcript；默认 .com 行为仍保留 AI Feeds profile', () => {
    const transcriptMarker = 'PODCAST_TRANSCRIPT_SENSITIVE_MARKER';
    const row = mkRow({
      id: 'podcast:episode-cc',
      title: 'Podcast',
      content_translated: null,
      extra: JSON.stringify({
        show_key: 'practical-ai',
        title_zh: '播客标题',
        ai_summary_zh: '中性播客摘要。',
        shownotes_zh: '<p>节目简介短摘录。</p>',
        transcript_text_zh: transcriptMarker,
      }),
    });
    const ccHtml = renderItemPageHtml(row, envFixture(), [], ccItemPageProfile(envFixture()));
    const comHtml = renderItemPageHtml(mkRow(), envFixture());
    const article = extractJsonLd(ccHtml)['@graph'].find((g) => g['@type'] === 'Article')!;

    expect(ccHtml).toContain('节目简介短摘录');
    expect(ccHtml).not.toContain(transcriptMarker);
    expect(String(article.articleBody)).not.toContain(transcriptMarker);
    expect(comHtml).toContain('<title>推文要点标题 | AI Feeds</title>');
    expect(comHtml).toContain('<div class="brand"><a href="https://ai-feeds.com/">AI Feeds</a></div>');
    expect(comHtml).not.toContain('cc_content_mirror');
  });
});
