import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { runPhDescriptionTranslate } from './ph-description-translate';
import type { Env } from '../index';

// Task 3（2026-07-06）：PH item 的 extra.description（英文）→ extra.description_zh（DeepSeek flash）
// 存量回填 mode。谓词 = product_hunt 且 description 非空且 description_zh 空；游标单调（写了
// description_zh 就退出谓词）；dry 零写不调 DeepSeek；翻译失败保留空不写坏值。
// mock DB 忠实解释谓词与 json_set 写入；mock fetch 冒充 DeepSeek。

interface FakeItem {
  id: string;
  source_type: string;
  extra: Record<string, unknown>;
}

// 回填谓词：PH + description 非空 + description_zh 为空。
function actionable(it: FakeItem): boolean {
  if (it.source_type !== 'product_hunt') return false;
  const desc = it.extra.description;
  if (typeof desc !== 'string' || desc === '') return false;
  return it.extra.description_zh == null;
}

function makeEnv(items: FakeItem[], apiKey: string | undefined = 'test-key') {
  const updates: Array<{ sql: string; binds: unknown[] }> = [];
  const byId = new Map(items.map((it) => [it.id, it]));
  const DB = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...b: unknown[]) {
          bound = b;
          return stmt;
        },
        async all<T>() {
          if (/SELECT id, extra FROM items/i.test(sql)) {
            const limit = Number(bound[0]) || 1000;
            const rows = items
              .filter(actionable)
              .slice(0, limit)
              .map((it) => ({ id: it.id, extra: JSON.stringify(it.extra) }));
            return { results: rows as unknown as T[] };
          }
          return { results: [] as T[] };
        },
        async first<T>() {
          if (/COUNT\(\*\)/i.test(sql)) {
            return { c: items.filter(actionable).length } as unknown as T;
          }
          return null;
        },
        async run() {
          updates.push({ sql, binds: bound });
          if (/UPDATE items SET extra = json_set/i.test(sql)) {
            // binds = [description_zh, id]
            const zh = bound[0];
            const id = String(bound[bound.length - 1]);
            const it = byId.get(id);
            if (it) it.extra.description_zh = zh;
          }
          return { success: true };
        },
      };
      return stmt;
    },
  };
  return { env: { DB, DEEPSEEK_API_KEY: apiKey } as unknown as Env, updates };
}

// mock DeepSeek：把 prompt 里每条 numbered 输入映射成一行中文译文。
function mockFetchOk(): ReturnType<typeof vi.fn> {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { messages: Array<{ content: string }> };
    const prompt = body.messages[0].content;
    // chunk 内 0-based 编号，取每行 '^\d+:'
    const idxs: number[] = [];
    for (const line of prompt.split('\n')) {
      const m = line.match(/^(\d+):/);
      if (m) idxs.push(parseInt(m[1], 10));
    }
    const content = idxs.map((i) => `${i}:【中文】译文${i}`).join('\n');
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content } }] }),
    } as unknown as Response;
  });
}

describe('runPhDescriptionTranslate', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  test('PH 有英文 description 无 description_zh → 翻译写入中文', async () => {
    const fetchMock = mockFetchOk();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const items: FakeItem[] = [
      {
        id: 'ph:1',
        source_type: 'product_hunt',
        extra: { description: 'An AI-powered agent that writes code for you.' },
      },
    ];
    const { env, updates } = makeEnv(items);
    const res = await runPhDescriptionTranslate(env, { limit: 50, dry: false });
    expect(res.scanned).toBe(1);
    expect(res.translated).toBe(1);
    expect(res.remaining).toBe(0);
    expect(String(items[0].extra.description_zh)).toContain('中文');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 只写 description_zh，SQL 走 json_set 单字段
    expect(updates.length).toBe(1);
    expect(updates[0].sql).toMatch(/\$\.description_zh/);
  });

  test('已有 description_zh → 不选中、不重译', async () => {
    const fetchMock = mockFetchOk();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const items: FakeItem[] = [
      {
        id: 'ph:done',
        source_type: 'product_hunt',
        extra: { description: 'English desc', description_zh: '已有译文' },
      },
    ];
    const { env, updates } = makeEnv(items);
    const res = await runPhDescriptionTranslate(env, { limit: 50, dry: false });
    expect(res.scanned).toBe(0);
    expect(res.translated).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updates.length).toBe(0);
    expect(items[0].extra.description_zh).toBe('已有译文'); // 未被覆盖
  });

  test('description 空 / 缺失 → 跳过', async () => {
    const fetchMock = mockFetchOk();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const items: FakeItem[] = [
      { id: 'ph:empty', source_type: 'product_hunt', extra: { description: '' } },
      { id: 'ph:missing', source_type: 'product_hunt', extra: {} },
    ];
    const { env, updates } = makeEnv(items);
    const res = await runPhDescriptionTranslate(env, { limit: 50, dry: false });
    expect(res.scanned).toBe(0);
    expect(res.translated).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updates.length).toBe(0);
  });

  test('翻译返回空/失败 → 不写坏值，仍留在谓词内待重试', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as unknown as Response));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const items: FakeItem[] = [
      { id: 'ph:fail', source_type: 'product_hunt', extra: { description: 'English desc to fail' } },
    ];
    const { env, updates } = makeEnv(items);
    const res = await runPhDescriptionTranslate(env, { limit: 50, dry: false });
    expect(res.scanned).toBe(1);
    expect(res.translated).toBe(0);
    expect(updates.length).toBe(0); // 零写
    expect(items[0].extra.description_zh).toBeUndefined(); // 不写坏值
    expect(res.remaining).toBe(1); // 仍待处理
  });

  test('dry=1 → 零写、不调 DeepSeek，remaining 保持满值', async () => {
    const fetchMock = mockFetchOk();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const items: FakeItem[] = [
      { id: 'ph:a', source_type: 'product_hunt', extra: { description: 'desc a' } },
      { id: 'ph:b', source_type: 'product_hunt', extra: { description: 'desc b' } },
    ];
    const { env, updates } = makeEnv(items);
    const res = await runPhDescriptionTranslate(env, { limit: 50, dry: true });
    expect(res.scanned).toBe(2);
    expect(res.translated).toBe(0);
    expect(res.remaining).toBe(2); // 未推进
    expect(updates.length).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled(); // dry 不烧钱
    expect(items[0].extra.description_zh).toBeUndefined();
  });

  test('谓词选中面：非 PH 源 / 已是中文 description 不受影响', async () => {
    const fetchMock = mockFetchOk();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const items: FakeItem[] = [
      { id: 'gh:1', source_type: 'github', extra: { description: 'A GitHub repo desc' } }, // 非 PH
      { id: 'blog:1', source_type: 'blog', extra: { description: 'blog desc' } }, // 非 PH
      { id: 'ph:zh', source_type: 'product_hunt', extra: { description: '这是一段已经是中文的产品描述介绍内容' } },
      { id: 'ph:en', source_type: 'product_hunt', extra: { description: 'English product description here' } },
    ];
    const { env, updates } = makeEnv(items);
    const res = await runPhDescriptionTranslate(env, { limit: 50, dry: false });
    // 仅 ph:en 和 ph:zh 进谓词（都 PH + 非空 desc + 无 zh）；ph:zh 已是中文 → 直通写回，不调翻译
    expect(res.scanned).toBe(2);
    // gh/blog 未被选中
    expect(items.find((i) => i.id === 'gh:1')!.extra.description_zh).toBeUndefined();
    expect(items.find((i) => i.id === 'blog:1')!.extra.description_zh).toBeUndefined();
    // 只有 ph:en 走 DeepSeek（ph:zh 是中文直通）
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 两条 PH 都写了 description_zh（ph:zh 直通原文，ph:en 译文）
    expect(items.find((i) => i.id === 'ph:en')!.extra.description_zh).toContain('中文');
    expect(items.find((i) => i.id === 'ph:zh')!.extra.description_zh).toBe('这是一段已经是中文的产品描述介绍内容');
    expect(res.translated).toBe(2);
    expect(updates.length).toBe(2);
  });

  test('limit 约束批量大小，remaining 反映剩余', async () => {
    const fetchMock = mockFetchOk();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const items: FakeItem[] = Array.from({ length: 5 }, (_, i) => ({
      id: `ph:${i}`,
      source_type: 'product_hunt',
      extra: { description: `English description number ${i}` },
    }));
    const { env } = makeEnv(items);
    const res = await runPhDescriptionTranslate(env, { limit: 2, dry: false });
    expect(res.scanned).toBe(2);
    expect(res.translated).toBe(2);
    expect(res.remaining).toBe(3); // 5 - 2 已翻
  });
});
