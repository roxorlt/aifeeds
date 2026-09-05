/**
 * `generateFeedEnrichment` 是从 {@link classifyAndTranslateForFeeds} 里抽出来的纯生成
 * 部分（读库与写库留在原处）。补录线索要用同一套提示词写标题与摘要，才谈得上「文字质量
 * 与非补录内容一致」。
 *
 * **这个文件的真正职责是守住「常规新闻那条路逐字不变」**：
 * `__fixtures__/enrich-request-*.json` 是抽函数**之前**从真实调用里抓下来的请求原文
 * （model / temperature / max_tokens / response_format / system / user 全在里面）。两条
 * 路径发出去的请求都必须与它逐字节相同 —— 提示词、参数、拼接顺序动了任何一个字，这里
 * 立刻红。
 */
import { describe, expect, test } from 'vitest';
import {
  classifyAndTranslateForFeeds,
  generateFeedEnrichment,
} from './classify-translate';
import type { Env } from '../index';
import blogRequestFixture from './__fixtures__/enrich-request-blog.json';
import podcastRequestFixture from './__fixtures__/enrich-request-podcast.json';

const ITEM_TITLE = 'Anthropic ships Claude Sonnet 5';
const ITEM_CONTENT = 'body text '.repeat(20);
const ITEM_EXTRA = { source_company: 'Anthropic', hosts: ['Chris'] };

const MODEL_OUTPUT = {
  ai_category: 'model-release',
  title_zh: '【AINews】Anthropic 发布 Claude Sonnet 5',
  excerpt_zh: '博客摘要中译。',
  shownotes_zh: '播客摘要中译。',
  ai_summary_zh: '一句话解读。',
  guests: ['Sarah Guo', 'Chris', 'Sarah Guo', ''],
};

interface Capture {
  requests: string[];
  writes: Array<{ sql: string; binds: unknown[] }>;
}

function stubEnv(capture: Capture, opts: { llmOk?: boolean } = {}): Env {
  return {
    DEEPSEEK_API_KEY: 'k',
    DB: {
      prepare(sql: string) {
        return {
          bind(...binds: unknown[]) {
            return {
              first: async () => (sql.includes('SELECT title') ? {
                title: ITEM_TITLE,
                content: ITEM_CONTENT,
                extra: JSON.stringify(ITEM_EXTRA),
                is_relevant: 1,
              } : null),
              run: async () => {
                capture.writes.push({ sql, binds });
                return {};
              },
            };
          },
        };
      },
    },
    __llmOk: opts.llmOk !== false,
  } as unknown as Env;
}

async function withStubbedLlm<T>(
  capture: Capture,
  work: () => Promise<T>,
  opts: { ok?: boolean } = {},
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capture.requests.push(String(init?.body || ''));
    if (opts.ok === false) return new Response('nope', { status: 500 });
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(MODEL_OUTPUT) } }],
    }), { headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  try {
    return await work();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function enrichInput(kind: 'blog' | 'podcast') {
  return {
    title: ITEM_TITLE,
    // 与 selectEnrichExcerptForFeeds 对同一条 item 的选取结果一致（extra 里没有正文
    // 候选键，两种 kind 都会退到 content）。
    excerpt: ITEM_CONTENT.slice(0, 4000),
    sourceCompany: 'Anthropic',
    lang: 'zh' as const,
    kind,
  };
}

describe('generateFeedEnrichment 与常规新闻共用同一次调用', () => {
  test.each([
    ['blog', blogRequestFixture],
    ['podcast', podcastRequestFixture],
  ] as const)('%s：抽函数之后发出去的请求与抽之前逐字节相同', async (kind, fixture) => {
    const viaPipeline: Capture = { requests: [], writes: [] };
    await withStubbedLlm(viaPipeline, () => classifyAndTranslateForFeeds(
      stubEnv(viaPipeline), 'blog:x:1', { lang: 'zh', kind },
    ));

    const viaExtracted: Capture = { requests: [], writes: [] };
    await withStubbedLlm(viaExtracted, () => generateFeedEnrichment(
      stubEnv(viaExtracted), enrichInput(kind),
    ));

    // 三方两两相等：老口径的存档、走完整流程、单独调抽出来的函数。
    expect(JSON.parse(viaPipeline.requests[0])).toEqual(fixture);
    expect(viaExtracted.requests[0]).toBe(viaPipeline.requests[0]);
  });

  test('返回值把模型输出收口成落库要用的形状', async () => {
    const capture: Capture = { requests: [], writes: [] };
    const result = await withStubbedLlm(capture, () => generateFeedEnrichment(
      stubEnv(capture), enrichInput('blog'),
    ));

    expect(result).not.toBeNull();
    // 标签前缀在这一层就剥掉：常规新闻落库前也是先 stripLabelPrefix 再写。
    expect(result!.titleZh).toBe('Anthropic 发布 Claude Sonnet 5');
    expect(result!.aiCategory).toBe('model-release');
    expect(result!.bodyZh).toBe('博客摘要中译。');
    expect(result!.aiSummaryZh).toBe('一句话解读。');
    // 主持人过滤要看 item 的 extra.hosts，属于读库那一半，留在调用方。
    expect(result!.rawGuests).toEqual(['Sarah Guo', 'Chris', 'Sarah Guo', '']);
    expect(result!.grounding.suspect).toBe(false);
  });

  test('播客拿 shownotes_zh 当正文中译，博客拿 excerpt_zh', async () => {
    const capture: Capture = { requests: [], writes: [] };
    const podcast = await withStubbedLlm(capture, () => generateFeedEnrichment(
      stubEnv(capture), enrichInput('podcast'),
    ));
    expect(podcast!.bodyZh).toBe('播客摘要中译。');
  });

  test('模型这一轮没回东西时返回 null，由调用方决定怎么记失败', async () => {
    const capture: Capture = { requests: [], writes: [] };
    const result = await withStubbedLlm(
      capture,
      () => generateFeedEnrichment(stubEnv(capture), enrichInput('blog')),
      { ok: false },
    );
    expect(result).toBeNull();
  });

  test('常规新闻那条路的落库补丁不因抽函数而改变', async () => {
    const capture: Capture = { requests: [], writes: [] };
    await withStubbedLlm(capture, () => classifyAndTranslateForFeeds(
      stubEnv(capture), 'blog:x:1', { lang: 'zh', kind: 'blog' },
    ));
    const write = capture.writes.find((entry) => entry.sql.includes('json_set'));
    expect(write).toBeDefined();
    const paths = write!.binds.filter((_value, index) => index % 2 === 0 && index < write!.binds.length - 1);
    expect(paths).toEqual([
      '$.ai_category', '$.title_zh', '$.excerpt_zh', '$.ai_summary_zh',
      '$.llm_model', '$.llm_called_at', '$.suspect_enrich', '$.suspect_enrich_reason',
    ]);
  });
});
