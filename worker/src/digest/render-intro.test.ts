import { describe, test, expect } from 'vitest';

// Task 4（2026-07-06）:静态日报页加长摘要。renderItem 的 intro 字段在 opts.extendedIntro=true 时
// 为「非 news 源」也填「每源最优加长字段」;默认(codex-push / daily-api 路径)不传 → 非 news 源无 intro,
// 输出逐字节不变(隔离锁)。news 源 intro 始终为 excerpt_zh/shownotes_zh,与 flag 无关。

import { renderItem, type RenderRow } from './render';

const API = 'https://api.ai-feeds.com';

function mkRow(over: Partial<RenderRow> & { id: string }): RenderRow {
  return {
    title: null,
    content: null,
    content_translated: null,
    author: null,
    handle: null,
    url: null,
    media: null,
    extra: null,
    ...over,
  };
}

describe('renderItem extendedIntro 隔离', () => {
  test('默认(不传 opts):非 news 源不产出 intro（codex/daily-api 零回归）', () => {
    const gh = renderItem('gh', mkRow({ id: 'github:o/r', extra: JSON.stringify({ ai_summary: 'GH 中文摘要，够长的一段说明文字。' }) }), 1, API);
    const ph = renderItem('ph', mkRow({ id: 'product_hunt:slug:2026-07-06', title: 'P', extra: JSON.stringify({ ai_summary: '短摘要', description_zh: 'PH 中文长描述。' }) }), 1, API);
    const hf = renderItem('hf-paper', mkRow({ id: 'hf_paper:42', extra: JSON.stringify({ title_zh: 'T', summary_zh: '论文长摘要正文。' }) }), 1, API);
    const x = renderItem('x', mkRow({ id: 'x_list:1', content_translated: '推文全文译文。' }), 1, API);
    // 关键:default 路径 intro 必须 undefined（不出现在 payload → codex 输出不变）
    expect(gh.intro).toBeUndefined();
    expect(ph.intro).toBeUndefined();
    expect(hf.intro).toBeUndefined();
    expect(x.intro).toBeUndefined();
  });

  test('extendedIntro=true:每源 intro 映射到最优加长字段', () => {
    const gh = renderItem('gh', mkRow({ id: 'github:o/r', extra: JSON.stringify({ ai_summary: 'GH 中文摘要，够长的一段说明文字。' }) }), 1, API, { extendedIntro: true });
    const hf = renderItem('hf-paper', mkRow({ id: 'hf_paper:42', extra: JSON.stringify({ title_zh: 'T', summary_zh: '论文长摘要正文，足够展开细节。' }) }), 1, API, { extendedIntro: true });
    const x = renderItem('x', mkRow({ id: 'x_list:1', content_translated: '推文全文译文，比一句话摘要更完整。' }), 1, API, { extendedIntro: true });
    expect(gh.intro).toBe('GH 中文摘要，够长的一段说明文字。');
    expect(hf.intro).toBe('论文长摘要正文，足够展开细节。');
    expect(x.intro).toBe('推文全文译文，比一句话摘要更完整。');
  });

  test('extendedIntro=true:ph 优先 description_zh、缺失回退 ai_summary', () => {
    const withDesc = renderItem('ph', mkRow({ id: 'product_hunt:a:2026-07-06', title: 'P', extra: JSON.stringify({ ai_summary: '短中文摘要', description_zh: 'PH 中文长描述，Task 3 产出。' }) }), 1, API, { extendedIntro: true });
    const noDesc = renderItem('ph', mkRow({ id: 'product_hunt:b:2026-07-06', title: 'P', extra: JSON.stringify({ ai_summary: '仅有短中文摘要' }) }), 1, API, { extendedIntro: true });
    expect(withDesc.intro).toBe('PH 中文长描述，Task 3 产出。');
    expect(noDesc.intro).toBe('仅有短中文摘要');
  });

  test('news 源 intro=excerpt_zh/shownotes_zh，与 extendedIntro flag 无关（news 不受隔离影响）', () => {
    const blogRow = mkRow({ id: 'blog:e1', extra: JSON.stringify({ title_zh: 'T', ai_summary_zh: '一句话新闻摘要。', excerpt_zh: '图文正文简介，比一句话更完整。' }) });
    const podRow = mkRow({ id: 'podcast:s1', extra: JSON.stringify({ title_zh: 'T', ai_summary_zh: '一句话。', show_key: 'sk', shownotes_zh: '播客 shownotes 简介。' }) });
    // 不传 flag
    expect(renderItem('news', blogRow, 1, API).intro).toBe('图文正文简介，比一句话更完整。');
    expect(renderItem('news', podRow, 1, API).intro).toBe('播客 shownotes 简介。');
    // 传 flag：仍是同一字段（news 分支不变）
    expect(renderItem('news', blogRow, 1, API, { extendedIntro: true }).intro).toBe('图文正文简介，比一句话更完整。');
    expect(renderItem('news', podRow, 1, API, { extendedIntro: true }).intro).toBe('播客 shownotes 简介。');
  });

  test('extendedIntro=true:字段为空时 intro 仍 undefined（不产出空段）', () => {
    const gh = renderItem('gh', mkRow({ id: 'github:o/r', extra: JSON.stringify({}) }), 1, API, { extendedIntro: true });
    expect(gh.intro).toBeUndefined();
  });

  test('extendedIntro=true:超长字段按句 clamp 到 800（render 层）', () => {
    const long = '句子。'.repeat(400); // 1200 字
    const hf = renderItem('hf-paper', mkRow({ id: 'hf_paper:9', extra: JSON.stringify({ title_zh: 'T', summary_zh: long }) }), 1, API, { extendedIntro: true });
    expect(hf.intro).toBeDefined();
    expect(hf.intro!.length).toBeLessThanOrEqual(800);
    // 按句截断:末尾是句号，不是硬切
    expect(hf.intro!.endsWith('。')).toBe(true);
  });
});
