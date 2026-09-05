import { describe, expect, test, vi } from 'vitest';

import type { Env } from '../index';
import {
  createManualLeadContentAdapters,
  manualLeadContentAnalysisPrompt,
  parseManualLeadContentAnalysis,
} from './manual-lead-content-runtime';
import { MANUAL_LEAD_ENRICHMENT_QUERY_MAX_LENGTH } from './manual-lead-enrichment';
import { MANUAL_LEAD_CONTENT_CJK_QUERY_MAX_CHARS } from './manual-lead-content';

const ENV = {
  MANUAL_NEWS_RESEARCH_ORIGIN: 'https://gateway.example/',
  MANUAL_NEWS_RESEARCH_TOKEN: 'gateway-token-value',
  DEEPSEEK_API_KEY: 'deepseek-key',
} as unknown as Env;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const MATERIAL = {
  text: 'OpenAI 今天发布 Astra。', url: 'https://openai.com/index/astra/',
  publisher: 'openai.com', kind: 'document' as const,
};

describe('parseManualLeadContentAnalysis', () => {
  test('形状完整时收下，两个字段都折叠空白', () => {
    expect(parseManualLeadContentAnalysis({ headline: '  OpenAI 发布 Astra ', query: 'OpenAI\nAstra' }))
      .toEqual({ headline: 'OpenAI 发布 Astra', query: 'OpenAI Astra' });
  });

  test('检索词按网关的 200 上限截断，整条请求不会被 400 掉', () => {
    const parsed = parseManualLeadContentAnalysis({ headline: '标题', query: '甲'.repeat(400) });
    expect(parsed?.query.length).toBe(MANUAL_LEAD_ENRICHMENT_QUERY_MAX_LENGTH);
  });

  test.each([
    ['检索词为空', { headline: '标题', query: '   ' }],
    ['整体是数组', []],
    ['整体是 null', null],
    ['字段类型不对', { headline: 1, query: 2 }],
  ])('%s 时当没分析出来', (_label, payload) => {
    expect(parseManualLeadContentAnalysis(payload)).toBeNull();
  });

  test('只有检索词没有标题也收下：标题只是锦上添花，检索词才是这一步的产物', () => {
    expect(parseManualLeadContentAnalysis({ query: 'OpenAI Astra' }))
      .toEqual({ headline: '', query: 'OpenAI Astra' });
  });
});

describe('分析提示词', () => {
  test('线索、出处与正文一起交给模型，正文按上限压过', () => {
    const prompt = manualLeadContentAnalysisPrompt({
      clue: 'OpenAI 发布了 Astra', material: { ...MATERIAL, text: '甲'.repeat(20_000) },
    });
    const user = JSON.parse(prompt.user) as Record<string, string>;
    expect(user.clue).toBe('OpenAI 发布了 Astra');
    expect(user.publisher).toBe('openai.com');
    expect(user.body.length).toBeLessThanOrEqual(8_000);
    expect(prompt.system).toContain('检索词');
  });

  // 规格第 10.3 节：没有链接时这一步的活儿是「把那句话压成几个关键词」，不是读正文。
  test('没有正文时只把那句话交给模型，并要求压成 3 到 6 个关键词', () => {
    const prompt = manualLeadContentAnalysisPrompt({
      clue: '英伟达确认以 129 亿美元收购 Hugging Face', material: null,
    });
    const user = JSON.parse(prompt.user) as Record<string, string>;
    expect(user).toEqual({ clue: '英伟达确认以 129 亿美元收购 Hugging Face' });
    expect(prompt.system).toContain('关键词');
    // 中文检索式的长度上限要写进提示词 —— 长中文检索式在 ScrapeBadger 上必 502。
    expect(prompt.system).toContain(String(MANUAL_LEAD_CONTENT_CJK_QUERY_MAX_CHARS));
    // 没有正文就没有「原文标题」这回事，别让模型顺着那句话编一个。
    expect(prompt.system).toContain('headline');
  });
});

describe('createManualLeadContentAdapters', () => {
  test('抓正文只发 url，不夹带描述 —— 这一步要的是这条消息本身', async () => {
    const bodies: unknown[] = [];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body || '{}')));
      return jsonResponse(MATERIAL);
    });
    const adapters = createManualLeadContentAdapters(ENV, { fetcher });

    await expect(adapters.fetchSource('https://openai.com/index/astra/', '2026-09-05'))
      .resolves.toMatchObject({ url: 'https://openai.com/index/astra/' });
    expect(bodies).toEqual([{ url: 'https://openai.com/index/astra/', date: '2026-09-05' }]);
  });

  test('搜索只发 query 与 date —— 少了 date 网关就抛 Invalid time value', async () => {
    const bodies: unknown[] = [];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body || '{}')));
      return jsonResponse({ ...MATERIAL, kind: 'search+document' });
    });
    const adapters = createManualLeadContentAdapters(ENV, { fetcher });

    await adapters.search('OpenAI Astra 企业模型', '2026-09-05');
    expect(bodies).toEqual([{ query: 'OpenAI Astra 企业模型', date: '2026-09-05' }]);
  });

  test('检索词过长时截到网关上限再发', async () => {
    const bodies: Record<string, string>[] = [];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body || '{}')));
      return jsonResponse({ ...MATERIAL, kind: 'search+document' });
    });
    const adapters = createManualLeadContentAdapters(ENV, { fetcher });

    await adapters.search('甲'.repeat(400), '2026-09-05');
    expect(bodies[0].query.length).toBe(MANUAL_LEAD_ENRICHMENT_QUERY_MAX_LENGTH);
  });

  test('检索词是空白时根本不打扰网关', async () => {
    const fetcher = vi.fn(async () => jsonResponse(MATERIAL));
    const adapters = createManualLeadContentAdapters(ENV, { fetcher });
    await expect(adapters.search('   ', '2026-09-05')).resolves.toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  test('网关回非 200 时当没取到，不抛', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ error: 'boom' }, 502));
    const adapters = createManualLeadContentAdapters(ENV, { fetcher });
    await expect(adapters.fetchSource('https://a.example/x', '2026-09-05')).resolves.toBeNull();
  });

  test('网关没配置时不发请求，安静回 null', async () => {
    const fetcher = vi.fn(async () => jsonResponse(MATERIAL));
    const adapters = createManualLeadContentAdapters({} as Env, { fetcher });
    await expect(adapters.fetchSource('https://a.example/x', '2026-09-05')).resolves.toBeNull();
    await expect(adapters.search('查询', '2026-09-05')).resolves.toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  test('分析走 DeepSeek，模型没配置时安静回 null', async () => {
    const adapters = createManualLeadContentAdapters(
      { MANUAL_NEWS_RESEARCH_ORIGIN: 'https://g', MANUAL_NEWS_RESEARCH_TOKEN: 't' } as Env,
      { fetcher: vi.fn(async () => jsonResponse(MATERIAL)) },
    );
    await expect(adapters.analyze({ clue: '线索', material: MATERIAL })).resolves.toBeNull();
    await expect(adapters.analyze({ clue: '线索', material: null })).resolves.toBeNull();
  });
});
