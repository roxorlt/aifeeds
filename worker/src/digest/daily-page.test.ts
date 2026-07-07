import { describe, test, expect, vi, beforeEach } from 'vitest';

// selection.ts 的评分选品在单测里整体 mock —— build 层的截断/空源/顺序逻辑与真实 SQL 解耦验证。
vi.mock('./selection', () => ({
  selectTopForSource: vi.fn(async () => [] as string[]),
}));

import {
  buildDailyPageData,
  renderDailyPageHtml,
  type DailyPageData,
  type DailyPageSection,
} from './daily-page';
import { selectTopForSource } from './selection';
import type { Env } from '../index';
import { DAILY_PAGE_INTRO_MAX, type DigestSource } from './config';
import { clampSentences, type RenderedItem, type RenderRow } from './render';

const SITE = 'https://ai-feeds.com';
const API = 'https://api.ai-feeds.com';

function envFixture(): Env {
  return { SITE_BASE: SITE, API_BASE: API } as unknown as Env;
}

// ── 渲染层 fixture:直接自造 RenderedItem,不依赖 DB / renderItem ──
function mkItem(over: Partial<RenderedItem> = {}): RenderedItem {
  return {
    rank: 1,
    item_id: 'x_list:1890',
    source: 'x',
    title: '默认标题',
    summary: '一句话摘要。',
    summary_full: '一句话摘要。完整版还有更多内容。',
    url: 'https://x.com/u/status/1890',
    deep_link: '/t/1890',
    author: '@someone',
    cover: null,
    logo: null,
    media: [],
    ...over,
  };
}

function mkData(over: Partial<DailyPageData> = {}): DailyPageData {
  return {
    date: '2026-07-06',
    subject: 'MiniMax 发布语音模型、OpenAI 推出 Daybreak',
    sections: [{ source: 'x', label: '动态', items: [mkItem()] }],
    prevDate: null,
    nextDate: null,
    ...over,
  };
}

function fullSections(): DailyPageSection[] {
  return [
    { source: 'news', label: '行业新闻', items: [mkItem({ source: 'news', item_id: 'blog:e1', deep_link: '/o/blog%3Ae1', title: '新闻一' })] },
    { source: 'ph', label: '热门产品', items: [mkItem({ source: 'ph', item_id: 'product_hunt:p:2026-07-06', deep_link: '/ph/p/2026-07-06', title: '产品一' })] },
    { source: 'gh', label: '开源项目', items: [mkItem({ source: 'gh', item_id: 'github:o/r', deep_link: '/g/o/r', title: 'repo-one' })] },
    { source: 'hf-paper', label: '论文', items: [mkItem({ source: 'hf-paper', item_id: 'hf_paper:42', deep_link: '/h/42', title: '论文一' })] },
    { source: 'x', label: '动态', items: [mkItem({ source: 'x', item_id: 'x_list:1890', deep_link: '/t/1890', title: '动态一' })] },
  ];
}

// JSON-LD 数据岛是唯一允许的 <script>(非可执行);剥掉它后应零 script。
function stripJsonLd(html: string): string {
  return html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, '');
}
function extractJsonLd(html: string): any {
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no JSON-LD block found');
  return JSON.parse(m[1]);
}
// JSON-LD 已改 @graph 数组组织(WebSite + Organization + CollectionPage);取其中 CollectionPage 节点。
function collectionPageOf(ld: any): any {
  const graph = ld['@graph'];
  if (Array.isArray(graph)) return graph.find((n: any) => n['@type'] === 'CollectionPage');
  return ld;
}

describe('renderDailyPageHtml', () => {
  test('title / canonical / og:url 含正确日期与 SITE_BASE', () => {
    const html = renderDailyPageHtml(mkData(), envFixture());
    expect(html).toContain('<html lang="zh-CN">');
    expect(html).toContain('<title>AI 日报 2026-07-06 · MiniMax 发布语音模型、OpenAI 推出 Daybreak | AI Feeds</title>');
    expect(html).toContain(`<link rel="canonical" href="${SITE}/daily/2026-07-06">`);
    expect(html).toContain(`<meta property="og:url" content="${SITE}/daily/2026-07-06">`);
    expect(html).toContain('<meta name="description" content="MiniMax 发布语音模型、OpenAI 推出 Daybreak">');
    expect(html).toContain('<meta property="og:type" content="article">');
  });

  test('og:image 取首条有 cover 的 item,缺失兜底 og-default.png', () => {
    const withCover = renderDailyPageHtml(
      mkData({
        sections: [
          { source: 'news', label: '行业新闻', items: [mkItem({ source: 'news', cover: null })] },
          { source: 'x', label: '动态', items: [mkItem({ cover: `${API}/r/x/pic.jpg` })] },
        ],
      }),
      envFixture(),
    );
    expect(withCover).toContain(`<meta property="og:image" content="${API}/r/x/pic.jpg">`);

    const noCover = renderDailyPageHtml(mkData(), envFixture());
    expect(noCover).toContain(`<meta property="og:image" content="${SITE}/og-default.png">`);
  });

  test('JSON-LD @graph 含 WebSite+Organization+CollectionPage,可 JSON.parse,ItemList 条数 = fixture 总条数', () => {
    const sections: DailyPageSection[] = [
      { source: 'news', label: '行业新闻', items: [mkItem({ title: 'A' }), mkItem({ title: 'B' })] },
      { source: 'x', label: '动态', items: [mkItem({ title: 'C', deep_link: '/t/9' })] },
    ];
    const html = renderDailyPageHtml(mkData({ sections }), envFixture());
    const ld = extractJsonLd(html);
    expect(ld['@context']).toBe('https://schema.org');
    // @graph 三类型齐全
    const types = ld['@graph'].map((n: any) => n['@type']);
    expect(types).toContain('WebSite');
    expect(types).toContain('Organization');
    expect(types).toContain('CollectionPage');
    const website = ld['@graph'].find((n: any) => n['@type'] === 'WebSite');
    expect(website.name).toBe('AI Feeds');
    expect(website.url).toBe(`${SITE}/`);
    const org = ld['@graph'].find((n: any) => n['@type'] === 'Organization');
    expect(org.name).toBe('AI Feeds');
    expect(org.logo).toBe(`${SITE}/og-default.png`);
    // CollectionPage + ItemList 条数不变
    const cp = collectionPageOf(ld);
    expect(cp.mainEntity['@type']).toBe('ItemList');
    expect(cp.mainEntity.itemListElement.length).toBe(3); // 2 + 1
    expect(cp.mainEntity.itemListElement[0].name).toBe('A');
    // url 为深链绝对 URL
    expect(cp.mainEntity.itemListElement[2].url).toBe(`${SITE}/t/9`);
  });

  test('五源 section 按序齐全,渲染 <h2> 标签顺序正确', () => {
    const html = renderDailyPageHtml(mkData({ sections: fullSections() }), envFixture());
    const labels = [...html.matchAll(/<h2[^>]*>([^<]+)<\/h2>/g)].map((m) => m[1]);
    expect(labels).toEqual(['行业新闻', '热门产品', '开源项目', '论文', '动态']);
  });

  // ── #7 SEO 语义层级:单个 h1,层级 h1→h2→h3 ──

  test('页面含且仅含一个 <h1>,层级 h1→h2→h3 顺序正确', () => {
    const html = renderDailyPageHtml(mkData({ sections: fullSections() }), envFixture());
    const h1s = [...html.matchAll(/<h1[^>]*>/g)];
    expect(h1s.length).toBe(1);
    const iH1 = html.indexOf('<h1');
    const iH2 = html.indexOf('<h2');
    const iH3 = html.indexOf('<h3');
    expect(iH1).toBeGreaterThan(-1);
    expect(iH1).toBeLessThan(iH2); // h1 在首个 h2 之前
    expect(iH2).toBeLessThan(iH3); // h2 在首个 h3 之前
  });

  test('h1 含当日日期 + 主题(SEO 主题相关性)', () => {
    const html = renderDailyPageHtml(mkData(), envFixture());
    expect(html).toMatch(/<h1[^>]*>AI 日报 2026-07-06 · MiniMax 发布语音模型、OpenAI 推出 Daybreak<\/h1>/);
  });

  test('h1 在 <header> 内(位于 brand 之后、nav 之前)', () => {
    const html = renderDailyPageHtml(mkData(), envFixture());
    const header = html.slice(html.indexOf('<header>'), html.indexOf('</header>'));
    expect(header).toContain('<h1>');
    expect(header.indexOf('class="brand"')).toBeLessThan(header.indexOf('<h1>'));
    expect(header.indexOf('<h1>')).toBeLessThan(header.indexOf('class="nav"'));
  });

  test('subject 为空时 h1 只含日期,不出现悬空分隔符', () => {
    const html = renderDailyPageHtml(mkData({ subject: '' }), envFixture());
    expect(html).toMatch(/<h1[^>]*>AI 日报 2026-07-06<\/h1>/);
    expect(html).not.toContain('AI 日报 2026-07-06 · </h1>');
  });

  test('只渲染 data.sections 里的源,缺省源不出现(空源已由 build 层剔除)', () => {
    const sections = fullSections().filter((s) => s.source === 'news' || s.source === 'gh');
    const html = renderDailyPageHtml(mkData({ sections }), envFixture());
    const labels = [...html.matchAll(/<h2[^>]*>([^<]+)<\/h2>/g)].map((m) => m[1]);
    expect(labels).toEqual(['行业新闻', '开源项目']);
    expect(html).not.toContain('热门产品');
    expect(html).not.toContain('论文');
    expect(html).not.toContain('动态');
  });

  test('深链为绝对 URL(https://ai-feeds.com/t/...)', () => {
    const html = renderDailyPageHtml(
      mkData({ sections: [{ source: 'x', label: '动态', items: [mkItem({ deep_link: '/t/1890', title: '标题X' })] }] }),
      envFixture(),
    );
    expect(html).toContain(`<a href="${SITE}/t/1890">`);
  });

  test('原文外链带 target=_blank rel=noopener,封面 loading=lazy', () => {
    const html = renderDailyPageHtml(
      mkData({ sections: [{ source: 'x', label: '动态', items: [mkItem({ url: 'https://x.com/s/1', cover: `${API}/r/x/c.jpg` })] }] }),
      envFixture(),
    );
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener"');
    expect(html).toMatch(/<img[^>]*loading="lazy"/);
  });

  test('输出不含可执行 <script>(仅允许 JSON-LD 数据岛)', () => {
    const html = renderDailyPageHtml(mkData({ sections: fullSections() }), envFixture());
    // 剥掉 ld+json 数据岛后,不应再有任何 <script
    expect(stripJsonLd(html)).not.toContain('<script');
    // 且 ld+json 数据岛恰好一个
    expect((html.match(/<script/g) || []).length).toBe(1);
  });

  test('nextDate=null 时「后一日」href 指向归档 /daily/', () => {
    const html = renderDailyPageHtml(mkData({ nextDate: null }), envFixture());
    expect(html).toContain(`href="${SITE}/daily/"`);
    // 不应生成 /daily/null 之类
    expect(html).not.toContain('/daily/null');
  });

  test('nextDate 有值时「后一日」href 指向该日', () => {
    const html = renderDailyPageHtml(mkData({ nextDate: '2026-07-07' }), envFixture());
    expect(html).toContain(`href="${SITE}/daily/2026-07-07"`);
  });

  test('prevDate=null 时不渲染前一日链接;有值时渲染', () => {
    const noPrev = renderDailyPageHtml(mkData({ prevDate: null }), envFixture());
    expect(noPrev).not.toContain('前一日');
    const withPrev = renderDailyPageHtml(mkData({ prevDate: '2026-07-05' }), envFixture());
    expect(withPrev).toContain(`href="${SITE}/daily/2026-07-05"`);
    expect(withPrev).toContain('前一日');
  });

  test('footer 含订阅 / 进站 / 归档三个入口(绝对 URL)', () => {
    const html = renderDailyPageHtml(mkData(), envFixture());
    expect(html).toContain(`href="${SITE}/subscribe"`);
    expect(html).toContain(`href="${SITE}/"`);
    expect(html).toContain(`href="${SITE}/daily/"`);
  });

  test('HTML 特殊字符转义(标题含 < & 不破坏结构)', () => {
    const html = renderDailyPageHtml(
      mkData({ subject: 'A & B <tag>', sections: [{ source: 'x', label: '动态', items: [mkItem({ title: '危险</script><b>' })] }] }),
      envFixture(),
    );
    // 剥掉合法 ld+json 后仍无越权 <script(标题里的 </script> 被转义)
    expect(stripJsonLd(html)).not.toContain('<script');
    expect(html).toContain('&amp;');
    // JSON-LD 仍可解析,标题原文保留
    const cp = collectionPageOf(extractJsonLd(html));
    expect(cp.mainEntity.itemListElement[0].name).toBe('危险</script><b>');
  });

  test('header 含显著「订阅」按钮(subscribe-btn class + 绝对 URL)', () => {
    const html = renderDailyPageHtml(mkData(), envFixture());
    expect(html).toContain('class="subscribe-btn"');
    expect(html).toContain(`<a href="${SITE}/subscribe" class="subscribe-btn">订阅日报</a>`);
    // 订阅按钮在 header 内(nav 之后、</header> 之前)
    const header = html.slice(html.indexOf('<header>'), html.indexOf('</header>'));
    expect(header).toContain('subscribe-btn');
    // 零可执行 script 约束不变
    expect(stripJsonLd(html)).not.toContain('<script');
  });

  test('cover 为空的条目不渲染空 <img>', () => {
    const html = renderDailyPageHtml(
      mkData({ sections: [{ source: 'news', label: '行业新闻', items: [mkItem({ source: 'news', cover: null })] }] }),
      envFixture(),
    );
    expect(html).not.toContain('<img class="cover"');
  });

  // ── Task 4:扩展摘要段(<p class="summary-full">)──

  test('item.intro 存在且与一句话 summary 不同 → 渲染 <p class="summary-full">', () => {
    const html = renderDailyPageHtml(
      mkData({
        sections: [{ source: 'news', label: '行业新闻', items: [mkItem({
          source: 'news', summary: '一句话摘要。', summary_full: '一句话摘要。',
          intro: '这是更完整的扩展摘要，包含更多背景信息与细节。',
        })] }],
      }),
      envFixture(),
    );
    expect(html).toContain('<p class="summary-full">这是更完整的扩展摘要，包含更多背景信息与细节。</p>');
  });

  test('item.intro 缺失 → 不渲染空的 <p class="summary-full">(CSS 选择器不算)', () => {
    const html = renderDailyPageHtml(
      mkData({ sections: [{ source: 'x', label: '动态', items: [mkItem({ intro: undefined })] }] }),
      envFixture(),
    );
    expect(html).not.toContain('<p class="summary-full">');
  });

  test('summary-full 段位于一句话 summary 之后、meta 之前', () => {
    const html = renderDailyPageHtml(
      mkData({ sections: [{ source: 'news', label: '行业新闻', items: [mkItem({
        source: 'news', summary: '短句。', summary_full: '短句。', intro: '加长段落，补充更多内容。', author: '作者', url: 'https://e.com/1',
      })] }] }),
      envFixture(),
    );
    const iSummary = html.indexOf('<p class="summary">');
    const iFull = html.indexOf('<p class="summary-full">');
    const iMeta = html.indexOf('<div class="meta">');
    expect(iSummary).toBeGreaterThan(-1);
    expect(iFull).toBeGreaterThan(iSummary);
    expect(iMeta).toBeGreaterThan(iFull);
  });

  test('item.intro 超 500 字 → clamp 到 500 且按句截断', () => {
    const long = '一段完整的句子。'.repeat(120); // 960 字
    const html = renderDailyPageHtml(
      mkData({ sections: [{ source: 'hf-paper', label: '论文', items: [mkItem({ source: 'hf-paper', summary: '短', summary_full: '短', intro: long })] }] }),
      envFixture(),
    );
    const m = html.match(/<p class="summary-full">([\s\S]*?)<\/p>/);
    expect(m).not.toBeNull();
    expect(m![1].length).toBeLessThanOrEqual(500);
    expect(m![1].endsWith('。')).toBe(true); // 按句截断,非硬切
  });

  test('扩展摘要含 < & " 被 HTML 转义,不破坏结构且剥 JSON-LD 后零可执行 script', () => {
    const html = renderDailyPageHtml(
      mkData({ sections: [{ source: 'news', label: '行业新闻', items: [mkItem({
        source: 'news', summary: '短', summary_full: '短', intro: '危险 <script>alert("x")</script> & 更多文本',
      })] }] }),
      envFixture(),
    );
    // cleanText 先剥 `>` 等 markdown 字符,escapeHtml 再把 `<` / `"` / `&` 转实体 → 无可执行 script
    expect(stripJsonLd(html)).not.toContain('<script');
    expect(html).toContain('&lt;script'); // `<` 已转义
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;');
  });

  test('extended 与一句话 summary 完全相同 → 不重复渲染 summary-full(gh 短摘要场景)', () => {
    const html = renderDailyPageHtml(
      mkData({ sections: [{ source: 'gh', label: '开源项目', items: [mkItem({
        source: 'gh', summary: '同一段摘要。', summary_full: '同一段摘要。', intro: '同一段摘要。',
      })] }] }),
      envFixture(),
    );
    expect(html).not.toContain('<p class="summary-full">');
  });

  test('JSON-LD 每条含 description(加长文本 SEO 增强)且仍可 JSON.parse', () => {
    const html = renderDailyPageHtml(
      mkData({ sections: [{ source: 'news', label: '行业新闻', items: [mkItem({
        source: 'news', title: '标题N', summary: '短', summary_full: '短', intro: '扩展摘要文本供爬虫抓取。',
      })] }] }),
      envFixture(),
    );
    const cp = collectionPageOf(extractJsonLd(html));
    expect(cp.mainEntity.itemListElement[0].name).toBe('标题N');
    expect(cp.mainEntity.itemListElement[0].description).toBe('扩展摘要文本供爬虫抓取。');
  });

  test('.summary-full 有内联样式(字号/颜色对齐摘要段)', () => {
    const html = renderDailyPageHtml(mkData(), envFixture());
    expect(html).toContain('.summary-full{');
  });

  // ── Task 4 审查修复:同源前缀 collapse(一句话 summary 是扩展摘要的逐字前缀 → 只渲一段更长的)──

  function countOccurrences(hay: string, needle: string): number {
    let n = 0;
    let i = 0;
    for (;;) {
      const j = hay.indexOf(needle, i);
      if (j < 0) break;
      n++;
      i = j + needle.length;
    }
    return n;
  }

  test('同源前缀(hf:summary_zh 同喂一句话与扩展)→ collapse 成一段(=扩展 500 版),前缀不重复', () => {
    const head = '这是论文的详细中文摘要第一句。';
    const sameLong = head + '这是补充说明使正文超过一百八十字的第二句内容更长一些。'.repeat(20);
    const html = renderDailyPageHtml(
      mkData({ sections: [{ source: 'hf-paper', label: '论文', items: [mkItem({
        source: 'hf-paper', summary: head, summary_full: sameLong, intro: sameLong,
      })] }] }),
      envFixture(),
    );
    const body = stripJsonLd(html);
    // collapse 后只一段:无独立的扩展 summary-full 段
    expect(body).not.toContain('<p class="summary-full">');
    // 保留下来的那段 = 扩展 500 版(更长),占据一句话 summary 的位置/样式层级(.summary)
    const extended = clampSentences(sameLong, DAILY_PAGE_INTRO_MAX);
    const oneLiner = clampSentences(sameLong, 180);
    expect(extended.length).toBeGreaterThan(oneLiner.length); // 确保测的是严格前缀而非相等
    expect(body).toContain(`<p class="summary">${extended}</p>`);
    // 文本开头在正文里只出现一次(不再「180 段 + 前缀重复的扩展段」两处)
    expect(countOccurrences(body, head)).toBe(1);
  });

  test('长推文 content_translated 前缀重叠(summary_full 与 intro 同源)→ collapse 一段', () => {
    const head = '这条推文讲了一个关于模型发布的重要更新。';
    const sameLong = head + '随后作者补充了大量上下文让正文远超一句话摘要的长度。'.repeat(18);
    const html = renderDailyPageHtml(
      mkData({ sections: [{ source: 'x', label: '动态', items: [mkItem({
        source: 'x', summary: head, summary_full: sameLong, intro: sameLong,
      })] }] }),
      envFixture(),
    );
    const body = stripJsonLd(html);
    expect(body).not.toContain('<p class="summary-full">');
    expect(body).toContain(`<p class="summary">${clampSentences(sameLong, DAILY_PAGE_INTRO_MAX)}</p>`);
    expect(countOccurrences(body, head)).toBe(1);
  });

  test('异源(blog:summary≠excerpt_zh)→ 不 collapse,保留两段(一句话 .summary + 扩展 .summary-full)', () => {
    const html = renderDailyPageHtml(
      mkData({ sections: [{ source: 'news', label: '行业新闻', items: [mkItem({
        source: 'news', summary: '一句话新闻摘要。', summary_full: '一句话新闻摘要。',
        intro: '完全不同的图文扩展简介正文，与一句话摘要并非同一字段来源。',
      })] }] }),
      envFixture(),
    );
    expect(html).toContain('<p class="summary">一句话新闻摘要。</p>');
    expect(html).toContain('<p class="summary-full">完全不同的图文扩展简介正文，与一句话摘要并非同一字段来源。</p>');
  });
});

// ── build 层:mock 选品 + mock env.DB ──

interface StmtState {
  sql: string;
  args: unknown[];
}

function makeDbMock(opts: {
  rowsById?: Map<string, RenderRow>;
  subject?: string;
  prevDate?: string | null;
  nextDate?: string | null;
}) {
  const rowsById = opts.rowsById ?? new Map<string, RenderRow>();
  return {
    prepare(sql: string) {
      const state: StmtState = { sql, args: [] };
      const stmt = {
        bind(...args: unknown[]) {
          state.args = args;
          return stmt;
        },
        async all<T>() {
          if (/FROM items/i.test(state.sql)) {
            const results = state.args
              .map((id) => rowsById.get(String(id)))
              .filter((r): r is RenderRow => !!r);
            return { results: results as unknown as T[] };
          }
          return { results: [] as T[] };
        },
        async first<T>() {
          if (/_subject/.test(state.sql)) {
            return (opts.subject ? { items_meta: JSON.stringify({ subject: opts.subject }) } : null) as T | null;
          }
          if (/daily_pages/i.test(state.sql)) {
            // date < ?  → prevDate ; date > ? → nextDate
            if (/date <\s*\?/.test(state.sql)) return (opts.prevDate ? { date: opts.prevDate } : null) as T | null;
            if (/date >\s*\?/.test(state.sql)) return (opts.nextDate ? { date: opts.nextDate } : null) as T | null;
          }
          return null as T | null;
        },
      };
      return stmt;
    },
  };
}

function envWithDb(db: ReturnType<typeof makeDbMock>): Env {
  return { SITE_BASE: SITE, API_BASE: API, DB: db } as unknown as Env;
}

function mkRow(id: string, i: number): RenderRow {
  return {
    id,
    title: `标题 ${i}`,
    content: `body ${i}`,
    content_translated: `正文 ${i}`,
    author: `作者${i}`,
    handle: `@u${i}`,
    url: `https://example.com/${i}`,
    media: null,
    extra: JSON.stringify({ ai_summary: `摘要${i}`, title_zh: `中文标题${i}`, ai_summary_zh: `新闻摘要${i}`, summary_zh: `论文摘要${i}` }),
  };
}

function setSelection(map: Partial<Record<DigestSource, string[]>>) {
  vi.mocked(selectTopForSource).mockImplementation(async (_env, source: DigestSource) => map[source] ?? []);
}

describe('buildDailyPageData', () => {
  beforeEach(() => {
    vi.mocked(selectTopForSource).mockReset();
    vi.mocked(selectTopForSource).mockResolvedValue([]);
  });

  test('某源选品返回 25 条时,build 层截断到 20 条', async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `x_list:${i}`);
    const rowsById = new Map(ids.map((id, i) => [id, mkRow(id, i)]));
    setSelection({ x: ids });
    const env = envWithDb(makeDbMock({ rowsById }));

    const data = await buildDailyPageData(env, '2026-07-06');
    expect(data).not.toBeNull();
    const xSec = data!.sections.find((s) => s.source === 'x');
    expect(xSec).toBeDefined();
    expect(xSec!.items.length).toBe(20); // 25 → 截断 20
    // rank 连续 1..20
    expect(xSec!.items[0].rank).toBe(1);
    expect(xSec!.items[19].rank).toBe(20);
  });

  test('空源被剔除,section 顺序沿用 news→ph→gh→hf-paper→x', async () => {
    const newsIds = ['blog:n1', 'blog:n2'];
    const ghIds = ['github:o/r'];
    const xIds = ['x_list:1'];
    const rowsById = new Map<string, RenderRow>();
    [...newsIds, ...ghIds, ...xIds].forEach((id, i) => rowsById.set(id, mkRow(id, i)));
    setSelection({ news: newsIds, ph: [], gh: ghIds, 'hf-paper': [], x: xIds });
    const env = envWithDb(makeDbMock({ rowsById }));

    const data = await buildDailyPageData(env, '2026-07-06');
    expect(data!.sections.map((s) => s.source)).toEqual(['news', 'gh', 'x']);
    expect(data!.sections[0].label).toBe('行业新闻');
  });

  test('clawhub 不参与日报页(即使选品返回也不出现)', async () => {
    setSelection({ clawhub: ['clawhub:c1'], x: ['x_list:1'] });
    const rowsById = new Map<string, RenderRow>([['x_list:1', mkRow('x_list:1', 1)]]);
    const env = envWithDb(makeDbMock({ rowsById }));
    const data = await buildDailyPageData(env, '2026-07-06');
    expect(data!.sections.some((s) => s.source === 'clawhub')).toBe(false);
    // selectTopForSource 不应对 clawhub 调用
    const calledSources = vi.mocked(selectTopForSource).mock.calls.map((c) => c[1]);
    expect(calledSources).not.toContain('clawhub');
  });

  test('五源全空返回 null(调用方跳过生成)', async () => {
    setSelection({});
    const env = envWithDb(makeDbMock({}));
    const data = await buildDailyPageData(env, '2026-07-06');
    expect(data).toBeNull();
  });

  test('subject 取 digest_pool _subject meta 行,缺失时回落 fallback', async () => {
    const xIds = ['x_list:1'];
    const rowsById = new Map<string, RenderRow>([['x_list:1', mkRow('x_list:1', 1)]]);
    setSelection({ x: xIds });

    const withSubject = await buildDailyPageData(
      envWithDb(makeDbMock({ rowsById, subject: '今日重磅主题' })),
      '2026-07-06',
    );
    expect(withSubject!.subject).toBe('今日重磅主题');

    const noSubject = await buildDailyPageData(envWithDb(makeDbMock({ rowsById })), '2026-07-06');
    expect(noSubject!.subject).toBeTruthy(); // fallback 非空
    expect(noSubject!.subject).not.toBe('');
  });

  test('prevDate / nextDate 从 daily_pages 相邻行读取', async () => {
    const xIds = ['x_list:1'];
    const rowsById = new Map<string, RenderRow>([['x_list:1', mkRow('x_list:1', 1)]]);
    setSelection({ x: xIds });
    const data = await buildDailyPageData(
      envWithDb(makeDbMock({ rowsById, prevDate: '2026-07-05', nextDate: '2026-07-07' })),
      '2026-07-06',
    );
    expect(data!.prevDate).toBe('2026-07-05');
    expect(data!.nextDate).toBe('2026-07-07');

    const noNeighbors = await buildDailyPageData(envWithDb(makeDbMock({ rowsById })), '2026-07-06');
    expect(noNeighbors!.prevDate).toBeNull();
    expect(noNeighbors!.nextDate).toBeNull();
  });

  test('build → render 端到端:生成含日期与深链的合法 HTML', async () => {
    const xIds = ['x_list:1890'];
    const rowsById = new Map<string, RenderRow>([['x_list:1890', mkRow('x_list:1890', 1)]]);
    setSelection({ x: xIds });
    const env = envWithDb(makeDbMock({ rowsById, subject: '端到端主题' }));
    const data = await buildDailyPageData(env, '2026-07-06');
    const html = renderDailyPageHtml(data!, env);
    expect(html).toContain('AI 日报 2026-07-06');
    expect(html).toContain(`${SITE}/t/1890`);
    expect(stripJsonLd(html)).not.toContain('<script');
  });

  // ── 去重口径:news 源当日自然路径带跨天事件去重,锚定路径不带(账本锚当下,历史日期语义不成立)──

  test('当日自然路径:news 源带 strictCrossDayEventDedup、非 news 源不带任何选项', async () => {
    setSelection({ news: ['blog:n1'], x: ['x_list:1'] });
    const rowsById = new Map<string, RenderRow>([
      ['blog:n1', mkRow('blog:n1', 1)],
      ['x_list:1', mkRow('x_list:1', 2)],
    ]);
    const env = envWithDb(makeDbMock({ rowsById }));

    await buildDailyPageData(env, '2026-07-06'); // 不锚定 = 当日自然路径
    const calls = vi.mocked(selectTopForSource).mock.calls;
    const newsOpts = calls.find((c) => c[1] === 'news')?.[3];
    const xOpts = calls.find((c) => c[1] === 'x')?.[3];
    // news 与邮件 Phase 1(node-run.ts:167-175)同款传参
    expect(newsOpts).toEqual({ strictCrossDayEventDedup: true });
    // 非 news 源不带跨天去重,也不带 asOfDate
    expect(xOpts).toEqual({});
  });

  test('锚定路径(anchorToDate):news 源改传 asOfDate,不带 strictCrossDayEventDedup', async () => {
    setSelection({ news: ['blog:n1'] });
    const rowsById = new Map<string, RenderRow>([['blog:n1', mkRow('blog:n1', 1)]]);
    const env = envWithDb(makeDbMock({ rowsById }));

    await buildDailyPageData(env, '2026-07-01', { anchorToDate: true });
    const newsOpts = vi.mocked(selectTopForSource).mock.calls.find((c) => c[1] === 'news')?.[3];
    // 账本(digest_pool + 今日 BJT 0 点边界)锚的是当下,对回填历史日期语义不成立 → 只传 asOfDate
    expect(newsOpts).toEqual({ asOfDate: '2026-07-01' });
    expect(newsOpts).not.toHaveProperty('strictCrossDayEventDedup');
  });

  // ── Task 4:daily-page 传 extendedIntro → 各源扩展摘要按最优字段渲染 ──
  test('build→render 端到端:blog/ph/hf 扩展摘要各取最优加长字段', async () => {
    const row = (id: string, extra: Record<string, unknown>, over: Partial<RenderRow> = {}): RenderRow => ({
      id, title: '标题', content: null, content_translated: null, author: null, handle: null,
      url: `https://e.com/${id}`, media: null, extra: JSON.stringify(extra), ...over,
    });
    const rowsById = new Map<string, RenderRow>([
      ['blog:n1', row('blog:n1', { title_zh: '新闻标题', ai_summary_zh: '一句话新闻摘要。', excerpt_zh: '图文扩展简介，超过一句话摘要的正文内容。' })],
      ['product_hunt:p:2026-07-06', row('product_hunt:p:2026-07-06', { ai_summary: '短产品摘要', description_zh: 'PH 中文长描述，供日报 SEO 抓取使用。' })],
      ['hf_paper:42', row('hf_paper:42', { title_zh: '论文标题', summary_zh: '论文详细中文摘要，长度可观供检索。' })],
    ]);
    setSelection({ news: ['blog:n1'], ph: ['product_hunt:p:2026-07-06'], 'hf-paper': ['hf_paper:42'] });
    const env = envWithDb(makeDbMock({ rowsById }));
    const data = await buildDailyPageData(env, '2026-07-06');
    const html = renderDailyPageHtml(data!, env);
    expect(html).toContain('图文扩展简介，超过一句话摘要的正文内容。'); // blog → excerpt_zh
    expect(html).toContain('PH 中文长描述，供日报 SEO 抓取使用。');       // ph → description_zh
    expect(html).toContain('论文详细中文摘要，长度可观供检索。');         // hf → summary_zh(此例落在一句话段)
  });
});
