import { describe, expect, test, vi } from 'vitest';

import type { Env } from '../index';
import {
  MANUAL_LEAD_ENRICHMENT_PROMPT_MAX_CHARS,
  createManualLeadEnrichmentAdapters,
  manualLeadEnrichmentBackgroundPrompt,
  parseManualLeadEnrichmentMaterial,
} from './manual-lead-enrichment-runtime';

const GATEWAY_ENV = {
  MANUAL_NEWS_RESEARCH_ORIGIN: 'https://gateway.example/',
  MANUAL_NEWS_RESEARCH_TOKEN: 'gateway-token-value',
} as unknown as Env;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('parseManualLeadEnrichmentMaterial', () => {
  test('接受形状完整的素材', () => {
    expect(parseManualLeadEnrichmentMaterial({
      text: ' 正文 ', url: 'https://a.example/x', publisher: 'A', kind: 'document',
    })).toEqual({ text: '正文', url: 'https://a.example/x', publisher: 'A', kind: 'document' });
  });

  test.each([
    ['正文为空', { text: '   ', url: '', publisher: '', kind: 'document' }],
    ['kind 不认识', { text: '正文', url: '', publisher: '', kind: 'screenshot' }],
    ['kind 缺失', { text: '正文', url: '', publisher: '' }],
    ['正文不是字符串', { text: 42, kind: 'document' }],
    ['整体是数组', []],
    ['整体是 null', null],
  ])('%s 时当没抓到', (_name, payload) => {
    expect(parseManualLeadEnrichmentMaterial(payload)).toBeNull();
  });

  test('url / publisher 类型不对时降级成空串,不带脏值进库', () => {
    expect(parseManualLeadEnrichmentMaterial({
      text: '正文', url: 7, publisher: {}, kind: 'tweet',
    })).toEqual({ text: '正文', url: '', publisher: '', kind: 'tweet' });
  });
});

describe('manualLeadEnrichmentBackgroundPrompt', () => {
  test('正文过长时截断,不把整篇文章塞给模型', () => {
    const prompt = manualLeadEnrichmentBackgroundPrompt({
      text: '字'.repeat(MANUAL_LEAD_ENRICHMENT_PROMPT_MAX_CHARS + 500),
      url: 'https://a.example/x', publisher: 'A', kind: 'document',
    });
    const body = (JSON.parse(prompt.user) as { body: string }).body;
    expect([...body]).toHaveLength(MANUAL_LEAD_ENRICHMENT_PROMPT_MAX_CHARS);
  });

  test('要求模型只写原文里的事实,并给出写不出来时的空值出口', () => {
    const prompt = manualLeadEnrichmentBackgroundPrompt({
      text: '正文', url: '', publisher: '', kind: 'document',
    });
    expect(prompt.system).toContain('不补充原文没有的信息');
    expect(prompt.system).toContain('{"background": ""}');
  });
});

describe('createManualLeadEnrichmentAdapters.fetchPlainText', () => {
  test('有链接时把链接发给网关的轻量入口,带 bearer 鉴权', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      text: '正文', url: 'https://techcrunch.com/a', publisher: 'TechCrunch', kind: 'document',
    }));
    const adapters = createManualLeadEnrichmentAdapters(GATEWAY_ENV, { fetcher });

    await expect(adapters.fetchPlainText({ url: 'https://techcrunch.com/a' })).resolves.toEqual({
      text: '正文', url: 'https://techcrunch.com/a', publisher: 'TechCrunch', kind: 'document',
    });
    const [target, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    // 末尾斜杠不能重复,否则网关侧路由匹配不上。
    expect(target).toBe('https://gateway.example/v1/plain-text');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer gateway-token-value');
    expect(JSON.parse(String(init.body))).toEqual({ url: 'https://techcrunch.com/a' });
  });

  test('没有链接时把文字线索当查询发过去', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      text: '正文', url: 'https://a.example/x', publisher: 'A', kind: 'search+document',
    }));
    const adapters = createManualLeadEnrichmentAdapters(GATEWAY_ENV, { fetcher });

    await expect(adapters.fetchPlainText({ query: 'OpenAI 发布 Astra' }))
      .resolves.toMatchObject({ kind: 'search+document' });
    expect(JSON.parse(String((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body)))
      .toEqual({ query: 'OpenAI 发布 Astra' });
  });

  test('网关没配置时直接跳过,不发请求', async () => {
    const fetcher = vi.fn(async () => jsonResponse({}));
    const adapters = createManualLeadEnrichmentAdapters({} as Env, { fetcher });
    await expect(adapters.fetchPlainText({ url: 'https://a.example/x' })).resolves.toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  test('网关回非 200 时当没抓到', async () => {
    // 状态码是唯一能挡住它的东西:body 本身是一份形状完整的素材(网关 502 时代理层
    // 可能塞回上一次的缓存),所以这一条只有 response.ok 那道判断能拦。
    const fetcher = vi.fn(async () => jsonResponse({
      text: '不该被采信的正文', url: 'https://a.example/x', publisher: 'A', kind: 'document',
    }, 502));
    const adapters = createManualLeadEnrichmentAdapters(GATEWAY_ENV, { fetcher });
    await expect(adapters.fetchPlainText({ url: 'https://a.example/x' })).resolves.toBeNull();
  });

  test('网关抛异常时当没抓到,异常不外泄', async () => {
    const fetcher = vi.fn(async () => { throw new Error('connect ECONNREFUSED'); });
    const adapters = createManualLeadEnrichmentAdapters(GATEWAY_ENV, { fetcher });
    await expect(adapters.fetchPlainText({ url: 'https://a.example/x' })).resolves.toBeNull();
  });

  test('日志里不出现网关 token 与完整链接', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const fetcher = vi.fn(async () => {
        throw new Error('failed to reach https://gateway.example/v1/plain-text with gateway-token-value');
      });
      await createManualLeadEnrichmentAdapters(GATEWAY_ENV, { fetcher })
        .fetchPlainText({ url: 'https://a.example/x' });
      const logged = warn.mock.calls.flat().join(' ');
      expect(logged).not.toContain('gateway-token-value');
      expect(logged).not.toContain('https://gateway.example');
    } finally {
      warn.mockRestore();
    }
  });

  test('请求带 abort signal,慢网关不会把补充吊死', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ text: '正文', kind: 'document', url: '', publisher: '' }));
    await createManualLeadEnrichmentAdapters(GATEWAY_ENV, { fetcher }).fetchPlainText({ url: 'https://a.example/x' });
    expect((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].signal).toBeInstanceOf(AbortSignal);
  });
});

describe('createManualLeadEnrichmentAdapters.compress', () => {
  const material = { text: '正文', url: 'https://a.example/x', publisher: 'A', kind: 'document' as const };

  test('没有模型密钥时不压缩', async () => {
    await expect(createManualLeadEnrichmentAdapters({} as Env).compress(material)).resolves.toBeNull();
  });

  test('用 flash 压缩并取回 background 字段', async () => {
    const llm = await import('../hf-paper/llm');
    const spy = vi.spyOn(llm, 'callDeepSeekJson').mockResolvedValue({ data: { background: '背景。' } });
    try {
      const env = { DEEPSEEK_API_KEY: 'key' } as unknown as Env;
      await expect(createManualLeadEnrichmentAdapters(env).compress(material)).resolves.toBe('背景。');
      expect(spy.mock.calls[0][1]).toBe('deepseek-v4-flash');
    } finally {
      spy.mockRestore();
    }
  });

  test('模型没回 JSON 时回 null', async () => {
    const llm = await import('../hf-paper/llm');
    const spy = vi.spyOn(llm, 'callDeepSeekJson').mockResolvedValue({ data: null, error: 'no_text' });
    try {
      const env = { DEEPSEEK_API_KEY: 'key' } as unknown as Env;
      await expect(createManualLeadEnrichmentAdapters(env).compress(material)).resolves.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  test('background 不是字符串时回 null', async () => {
    const llm = await import('../hf-paper/llm');
    const spy = vi.spyOn(llm, 'callDeepSeekJson').mockResolvedValue({ data: { background: ['背景'] } });
    try {
      const env = { DEEPSEEK_API_KEY: 'key' } as unknown as Env;
      await expect(createManualLeadEnrichmentAdapters(env).compress(material)).resolves.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
