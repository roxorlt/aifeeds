import { describe, test, expect } from 'vitest';

import { renderItemBody, itemIndexableText } from './item-body';
import type { Env } from '../index';
import type { RenderRow } from '../digest/render';
import type { DigestSource } from '../digest/config';

const SITE = 'https://ai-feeds.com';
const API = 'https://api.ai-feeds.com';

function env(): Env {
  return { SITE_BASE: SITE, API_BASE: API } as unknown as Env;
}

// 最小 RenderRow；各测按源覆盖 id/extra/content。
function mkRow(over: Partial<RenderRow> & Record<string, unknown> = {}): RenderRow {
  return {
    id: 'x_list:1',
    title: null,
    content: null,
    content_translated: null,
    author: null,
    handle: null,
    url: null,
    media: null,
    extra: null,
    ...over,
  } as RenderRow;
}

function body(source: DigestSource, over: Partial<RenderRow> & Record<string, unknown>): string {
  return renderItemBody(source, mkRow(over), env());
}

describe('renderItemBody — gh（全文 README）', () => {
  const README = [
    '# My Project',
    '',
    'A cool tool for AI.',
    '',
    '## Install',
    '',
    '```bash',
    'npm i my-project',
    '```',
    '',
    '![hero](docs/hero.png)',
    '',
    '![badge](https://img.shields.io/badge/x-y.svg)',
  ].join('\n');

  test('渲染 README 的 HTML（标题/代码/图片），且页面无 h1（README 标题降级）', () => {
    const html = body('gh', {
      id: 'github:acme/tool',
      url: 'https://github.com/acme/tool',
      extra: JSON.stringify({ ai_summary: '这是我们的项目摘要。', readme_translated: README, default_branch: 'main' }),
    });
    // 我们的摘要前置。
    expect(html).toContain('这是我们的项目摘要。');
    // README 标题、代码、图片都渲染成 HTML 标签。
    expect(html).toMatch(/<h[2-6][^>]*>/); // README 的 # → 降级后的标题
    expect(html).toContain('<pre>');
    expect(html).toContain('<code');
    expect(html).toContain('<img');
    // README 的 # My Project 不得产出第二个 <h1>（页面 h1 唯一由外层框架保证）。
    expect(html).not.toContain('<h1');
    // 相对图片 resolve 到 raw.githubusercontent；img 补 loading=lazy。
    expect(html).toContain('https://raw.githubusercontent.com/acme/tool/main/docs/hero.png');
    expect(html).toMatch(/<img[^>]*loading="lazy"/);
  });

  test('README 超 40KB → 截断 + 「在 GitHub 查看完整 README」原文链', () => {
    const huge = '# Big\n\n' + 'lorem ipsum dolor sit amet. '.repeat(3000); // 远超 40000 字符
    const html = body('gh', {
      id: 'github:acme/tool',
      url: 'https://github.com/acme/tool',
      extra: JSON.stringify({ readme_translated: huge }),
    });
    expect(html).toContain('在 GitHub 查看完整 README');
    expect(html).toMatch(/href="https:\/\/github\.com\/acme\/tool"[^>]*rel="noopener nofollow"/);
    // 渲染 HTML 明显小于源（截断生效）。
    expect(html.length).toBeLessThan(huge.length);
  });

  test('README 含 <script>/onerror → 净化后无可执行脚本', () => {
    const evil = '# T\n\nhi <script>alert(1)</script> <img src=x onerror=alert(2)>\n\n<iframe src=javascript:alert(3)></iframe>';
    const html = body('gh', {
      id: 'github:acme/tool',
      url: 'https://github.com/acme/tool',
      extra: JSON.stringify({ readme_translated: evil }),
    });
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('javascript:');
  });
});

describe('renderItemBody — hf（deep_analysis 全文）', () => {
  test('渲染 abstract 中译 + deep_analysis 各维', () => {
    const html = body('hf-paper', {
      id: 'hf_paper:2501.1',
      extra: JSON.stringify({
        summary_zh: '这是论文摘要的中文翻译，讲清楚研究背景。',
        deep_analysis: {
          tldr: '一句话精华。',
          problem: '现有方法的问题在于泛化差。',
          key_insight: ['洞察一：稀疏注意力', '洞察二：课程学习'],
          method: '提出一种新的训练范式。',
          experiments: { datasets: ['A'], key_metrics: [], compute: '8xH100', narrative: '在多个基准上验证。' },
          industry_impact: '可用于推理加速。',
          limitations: ['仅在英文数据验证', '算力需求高'],
          novelty_rating: 4,
        },
      }),
    });
    expect(html).toContain('这是论文摘要的中文翻译');
    expect(html).toContain('论文精读');
    expect(html).toContain('TL;DR');
    expect(html).toContain('核心洞察');
    expect(html).toContain('洞察一：稀疏注意力');
    expect(html).toContain('局限');
    expect(html).toContain('仅在英文数据验证');
  });
});

describe('renderItemBody — ph（maker + 评论全文）', () => {
  test('渲染 ai_summary + maker post + 结构化热门评论', () => {
    const html = body('ph', {
      id: 'product_hunt:cool:2026-07-08',
      content_translated: '一句话产品 tagline。',
      extra: JSON.stringify({
        ai_summary: '这是我们对产品的 AI 解读。',
        maker_post_translated: 'Maker 的自述内容，第一段。\n\n第二段说明。',
        top_comments: [
          { author_name: 'Alice', translated: '很棒的产品！' },
          { author_name: 'Bob', text: 'Congrats on the launch.' },
        ],
      }),
    });
    expect(html).toContain('这是我们对产品的 AI 解读。');
    expect(html).toContain('Maker 说');
    expect(html).toContain('Maker 的自述内容，第一段。');
    expect(html).toContain('热门评论');
    expect(html).toContain('Alice');
    expect(html).toContain('很棒的产品！');
    expect(html).toContain('Congrats on the launch.');
  });
});

describe('renderItemBody — x（推文串 + 引用）', () => {
  test('单条 row → 主推为推文串；quote_of 渲染引用块', () => {
    const html = body('x', {
      id: 'x_list:1890',
      author: 'Sam',
      handle: '@sama',
      content_translated: '这是主推文的中文翻译内容。',
      extra: JSON.stringify({
        quote_of: { author: '被引用者', content_translated: '这是被引用推文的译文。' },
      }),
    });
    expect(html).toContain('tweet-thread');
    expect(html).toContain('这是主推文的中文翻译内容。');
    expect(html).toContain('quote-tweet');
    expect(html).toContain('被引用者');
    expect(html).toContain('这是被引用推文的译文。');
  });

  test('extra.thread 预聚合数组 → 逐条渲染整串', () => {
    const html = body('x', {
      id: 'x_list:1890',
      author: 'Sam',
      extra: JSON.stringify({
        thread: [
          { content_translated: '推文串第 1 条。' },
          { content_translated: '推文串第 2 条。' },
          { content_translated: '推文串第 3 条。' },
        ],
      }),
    });
    expect(html).toContain('推文串第 1 条。');
    expect(html).toContain('推文串第 2 条。');
    expect(html).toContain('推文串第 3 条。');
    expect((html.match(/tweet-card/g) || []).length).toBe(3);
  });
});

describe('renderItemBody — blog（半文源，仅摘录，非全文）', () => {
  const SENTINEL = '【尾部独有标记不应出现在页面】';
  // 长正文：前段是正常句子（~3400 字，远超 800 摘录窗口），SENTINEL 放在尾部。
  const LONG_BODY =
    '这是文章正文的第一句话，介绍主题。'.repeat(200) +
    SENTINEL +
    '这是结尾。';

  test('只渲染首 ~800 字摘录 + 阅读原文链，绝不含 body 全文尾部', () => {
    const html = body('news', {
      id: 'blog:hash',
      url: 'https://theverge.com/a/1',
      extra: JSON.stringify({
        ai_summary_zh: '这是我们的一句话概览。',
        excerpt_zh: '这是原文摘要的中译要点。',
        body_markdown_zh: LONG_BODY,
      }),
    });
    // 我们的摘要 + 要点。
    expect(html).toContain('这是我们的一句话概览。');
    expect(html).toContain('这是原文摘要的中译要点。');
    // 正文摘录标题在，但**不含**全文尾部 SENTINEL（证明非整篇照译）。
    expect(html).toContain('正文摘录');
    expect(html).not.toContain(SENTINEL);
    // 摘录长度受限（不接近全文体量）。
    expect(html.length).toBeLessThan(LONG_BODY.length);
    // 显著阅读原文出处链。
    expect(html).toContain('阅读原文（theverge.com）');
    expect(html).toMatch(/href="https:\/\/theverge\.com\/a\/1"/);
  });

  test('缺 body → 优雅降级为摘要 + 原文链，无正文摘录段', () => {
    const html = body('news', {
      id: 'blog:hash',
      url: 'https://theverge.com/a/2',
      extra: JSON.stringify({ ai_summary_zh: '仅有概览。' }),
    });
    expect(html).toContain('仅有概览。');
    expect(html).not.toContain('正文摘录');
    expect(html).toContain('阅读原文');
  });
});

describe('renderItemBody — podcast（半文源，不含 transcript 全文）', () => {
  const TRANSCRIPT_SENTINEL = '【逐字稿内容绝不应出现】';
  test('渲染摘要 + 章节时间戳 + shownotes 摘录，绝不含 transcript', () => {
    const html = body('news', {
      id: 'podcast:ep1',
      url: 'https://xyzfm.link/ep/1',
      extra: JSON.stringify({
        show_key: 'lex-fridman', // 标记为 podcast
        ai_summary_zh: '本期播客的中文概览。',
        chapters: [
          { start_sec: 0, title: '开场介绍' },
          { start_sec: 90, title: '核心讨论' },
          { start_sec: 3725, title: '收尾' },
        ],
        shownotes_zh: '<p>这是节目简介的 HTML 段落。</p>',
        transcript_text_zh: TRANSCRIPT_SENTINEL.repeat(50),
        transcript_text: TRANSCRIPT_SENTINEL.repeat(50),
      }),
    });
    expect(html).toContain('本期播客的中文概览。');
    expect(html).toContain('章节');
    expect(html).toContain('开场介绍');
    expect(html).toContain('00:00');
    expect(html).toContain('01:30');
    expect(html).toContain('1:02:05'); // 3725s → h:mm:ss
    expect(html).toContain('节目简介');
    // shownotes 的 HTML 标签被剥成纯文本（不出现裸标签）。
    expect(html).toContain('这是节目简介的 HTML 段落。');
    // transcript 全文绝不渲染。
    expect(html).not.toContain(TRANSCRIPT_SENTINEL);
  });
});

describe('renderItemBody — 净化接线（任一源）', () => {
  test('blog 纯文本字段含 <script> → 转义，无可执行脚本', () => {
    const html = body('news', {
      id: 'blog:hash',
      url: 'https://x.com/a',
      extra: JSON.stringify({
        ai_summary_zh: '正常摘要 <script>alert(1)</script> 结束',
        body_markdown_zh: '正文 <img src=x onerror=alert(2)> 内容。',
      }),
    });
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror=');
    expect(html).toContain('&lt;'); // 已转义
  });

  test('缺全部字段 → 空串（不崩）', () => {
    expect(body('gh', { id: 'github:a/b' })).toBe('');
    expect(body('x', { id: 'x_list:1' })).toBe('');
  });
});

describe('itemIndexableText — articleBody 可安全索引文本', () => {
  test('blog：只含我们的摘要+要点，不含照译全文', () => {
    const SENTINEL = '尾部照译全文标记';
    const t = itemIndexableText(
      'news',
      mkRow({
        id: 'blog:hash',
        extra: JSON.stringify({
          ai_summary_zh: '我们的概览。',
          excerpt_zh: '我们的要点。',
          body_markdown_zh: '整篇照译' + SENTINEL,
        }),
      }),
      env(),
    );
    expect(t).toContain('我们的概览。');
    expect(t).toContain('我们的要点。');
    expect(t).not.toContain(SENTINEL);
  });

  test('gh：含 ai_summary', () => {
    const t = itemIndexableText('gh', mkRow({ id: 'github:a/b', extra: JSON.stringify({ ai_summary: '仓库摘要文本。' }) }), env());
    expect(t).toContain('仓库摘要文本。');
  });
});
