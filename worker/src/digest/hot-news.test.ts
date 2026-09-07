import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('./selection', () => ({
  selectNewsByScoreWithAudit: vi.fn(),
}));

import {
  computeHotNewsSnapshot,
  readHotNewsSnapshot,
  runHotNewsSnapshot,
  storeHotNewsSnapshot,
  HOT_NEWS_KV_KEY,
  type HotNewsSnapshot,
} from './hot-news';
import { selectNewsByScoreWithAudit } from './selection';

/** D1 单条语句的绑参上限（本仓多处记着的 100）。按条数展开绑定会随榜长突然崩。 */
const D1_MAX_BOUND_PARAMETERS = 100;

interface PreparedCall {
  sql: string;
  binds: unknown[];
}

function makeEnv(options: {
  items?: Array<Record<string, unknown>>;
  kv?: string | null;
  d1Snapshot?: string | null;
  kvPutFails?: boolean;
} = {}) {
  const calls: PreparedCall[] = [];
  const kvStore = new Map<string, string>();
  if (options.kv) kvStore.set(HOT_NEWS_KV_KEY, options.kv);
  const inserted: unknown[][] = [];
  const env = {
    AUTH_KV: {
      async get(key: string) { return kvStore.get(key) ?? null; },
      async put(key: string, value: string) {
        if (options.kvPutFails) throw new Error('kv unavailable');
        kvStore.set(key, value);
      },
    },
    DB: {
      prepare(sql: string) {
        const call: PreparedCall = { sql, binds: [] };
        calls.push(call);
        return {
          bind(...binds: unknown[]) { call.binds = binds; return this; },
          async all() {
            return { results: /hot_news:materialize/.test(sql) ? (options.items || []) : [] };
          },
          async first() {
            if (!/hot_news_snapshots/.test(sql)) return null;
            return options.d1Snapshot ? { payload_json: options.d1Snapshot } : null;
          },
          async run() { inserted.push(call.binds); return { success: true }; },
        };
      },
    },
  } as never;
  return { env, calls, inserted, kvStore };
}

function auditEntry(index: number) {
  return {
    rank: index + 1,
    id: `blog:anthropic:pool-${index + 1}`,
    title: `Pool ${index + 1}`,
    title_zh: `候选${index + 1}`,
    source_company: 'Anthropic',
    source_key: 'anthropic',
    ai_category: 'model',
    published_at: '2026-09-07T01:00:00Z',
    selectable: true,
    selected: true,
    base_score: 90 - index,
    adjusted_score: 100 - index,
    source_rank: 1,
    event_source_count: index === 0 ? 3 : 1,
    related_source_companies: [],
  };
}

function itemRow(index: number) {
  return {
    id: `blog:anthropic:pool-${index + 1}`,
    title: `Pool ${index + 1}`,
    url: `https://www.anthropic.com/news/pool-${index + 1}`,
    published_at: '2026-09-07T01:00:00Z',
    title_zh: `候选${index + 1}`,
    ai_summary_zh: `摘要${index + 1}`,
    summary_zh: null,
    source_company: 'Anthropic',
  };
}

function mockSelection(count: number) {
  const ids = Array.from({ length: count }, (_, index) => `blog:anthropic:pool-${index + 1}`);
  vi.mocked(selectNewsByScoreWithAudit).mockResolvedValue({
    ids,
    audit: {
      selected_ids: ids,
      candidates: Array.from({ length: count }, (_, index) => auditEntry(index)),
    },
  } as never);
  return ids;
}

describe('hot news snapshot computation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  test('selects twenty by the pure scoring layer, with no editorial LLM pass and no date anchor', async () => {
    mockSelection(20);
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const { env, calls } = makeEnv({ items: Array.from({ length: 20 }, (_, i) => itemRow(i)) });

    const snapshot = await computeHotNewsSnapshot(env, Date.parse('2026-09-07T02:00:00.000Z'));

    expect(selectNewsByScoreWithAudit).toHaveBeenCalledWith(env, 20, {
      editorialReview: false,
      strictCrossDayEventDedup: true,
    });
    // asOfDate 缺省 = 「此刻往前 3 天」，与正式批次的候选窗口逐字相同。
    expect(vi.mocked(selectNewsByScoreWithAudit).mock.calls[0][2]).not.toHaveProperty('asOfDate');
    // 热榜这条路一次大模型都不调。
    expect(upstream).not.toHaveBeenCalled();
    expect(snapshot).toMatchObject({
      version: 1,
      computed_at: '2026-09-07T02:00:00.000Z',
      window_hours: 72,
      limit: 20,
      item_count: 20,
    });
    expect(snapshot.items).toHaveLength(20);
    expect(snapshot.items[0]).toEqual({
      rank: 1,
      id: 'blog:anthropic:pool-1',
      title_zh: '候选1',
      summary_zh: '摘要1',
      source: 'Anthropic',
      url: 'https://www.anthropic.com/news/pool-1',
      published_at: '2026-09-07T01:00:00Z',
      score: 100,
      event_source_count: 3,
    });
    expect(snapshot.items.map((item) => item.rank)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
    const materialize = calls.find((call) => /hot_news:materialize/.test(call.sql));
    expect(materialize).toBeDefined();
    // 一次往返、一个绑参：json_each(?) 而不是按条数展开占位符。
    expect(materialize!.sql).toContain('json_each(?)');
    expect(materialize!.binds).toHaveLength(1);
    expect(materialize!.binds.length).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
    expect(JSON.parse(String(materialize!.binds[0]))).toHaveLength(20);
  });

  test('publishes as-is when an item was deleted after selection, without backfilling', async () => {
    mockSelection(20);
    const rows = Array.from({ length: 20 }, (_, index) => itemRow(index))
      .filter((row) => row.id !== 'blog:anthropic:pool-3');
    const { env } = makeEnv({ items: rows });

    const snapshot = await computeHotNewsSnapshot(env, Date.parse('2026-09-07T02:00:00.000Z'));

    expect(snapshot.item_count).toBe(19);
    expect(snapshot.items).toHaveLength(19);
    expect(snapshot.items.map((item) => item.id)).not.toContain('blog:anthropic:pool-3');
    // 不补位：第 21 名不会被拉上来顶替。
    expect(snapshot.items.map((item) => item.id)).not.toContain('blog:anthropic:pool-21');
    expect(snapshot.items.map((item) => item.rank)).toEqual(
      Array.from({ length: 19 }, (_, index) => index + 1),
    );
  });

  test('falls back to the audit and raw title when the item row has no Chinese fields', async () => {
    mockSelection(1);
    const { env } = makeEnv({
      items: [{
        id: 'blog:anthropic:pool-1',
        title: 'Pool 1',
        url: null,
        published_at: null,
        title_zh: null,
        ai_summary_zh: null,
        summary_zh: '备用摘要',
        source_company: null,
      }],
    });

    const snapshot = await computeHotNewsSnapshot(env, Date.parse('2026-09-07T02:00:00.000Z'));

    expect(snapshot.items[0]).toMatchObject({
      title_zh: '候选1',
      summary_zh: '备用摘要',
      source: 'Anthropic',
      url: '',
      published_at: '2026-09-07T01:00:00Z',
    });
  });
});

describe('hot news snapshot storage and reads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  test('overwrites the single row per window and mirrors the payload into KV', async () => {
    mockSelection(2);
    const { env, calls, inserted, kvStore } = makeEnv({
      items: [itemRow(0), itemRow(1)],
    });

    const result = await runHotNewsSnapshot(env, Date.parse('2026-09-07T02:30:00.000Z'));

    expect(result).toEqual({
      ok: true,
      window_hours: 72,
      computed_at: '2026-09-07T02:30:00.000Z',
      item_count: 2,
      kv_written: true,
    });
    const write = calls.find((call) => /INSERT INTO hot_news_snapshots/.test(call.sql));
    expect(write).toBeDefined();
    expect(write!.sql).toContain('ON CONFLICT(window_hours) DO UPDATE SET');
    expect(inserted[0]?.slice(0, 2)).toEqual([72, '2026-09-07T02:30:00.000Z']);
    const stored = JSON.parse(String(kvStore.get(HOT_NEWS_KV_KEY))) as HotNewsSnapshot;
    expect(stored.items).toHaveLength(2);
    expect(JSON.parse(String(inserted[0]?.[2]))).toEqual(stored);
  });

  test('keeps the D1 copy authoritative when the KV write fails', async () => {
    mockSelection(1);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { env, inserted } = makeEnv({ items: [itemRow(0)], kvPutFails: true });
    try {
      const result = await runHotNewsSnapshot(env, Date.parse('2026-09-07T03:00:00.000Z'));
      expect(result.kv_written).toBe(false);
      expect(result.item_count).toBe(1);
      expect(inserted).toHaveLength(1);
    } finally {
      errors.mockRestore();
    }
  });

  test('reads KV first and only falls back to D1 when KV is empty', async () => {
    const snapshot: HotNewsSnapshot = {
      version: 1,
      computed_at: '2026-09-07T02:00:00.000Z',
      window_hours: 72,
      limit: 20,
      item_count: 0,
      items: [],
    };
    const cached = makeEnv({ kv: JSON.stringify(snapshot) });
    await expect(readHotNewsSnapshot(cached.env)).resolves.toEqual(snapshot);
    expect(cached.calls).toHaveLength(0);

    const durable = makeEnv({ kv: null, d1Snapshot: JSON.stringify(snapshot) });
    await expect(readHotNewsSnapshot(durable.env)).resolves.toEqual(snapshot);
    expect(durable.calls.some((call) => /hot_news_snapshots/.test(call.sql))).toBe(true);

    const empty = makeEnv({ kv: null, d1Snapshot: null });
    await expect(readHotNewsSnapshot(empty.env)).resolves.toBeNull();
  });

  test('treats a corrupt KV payload as a miss instead of serving garbage', async () => {
    const { env } = makeEnv({ kv: '{not json', d1Snapshot: null });
    await expect(readHotNewsSnapshot(env)).resolves.toBeNull();
  });

  test('storeHotNewsSnapshot writes the exact payload it was handed', async () => {
    const snapshot: HotNewsSnapshot = {
      version: 1,
      computed_at: '2026-09-07T04:00:00.000Z',
      window_hours: 72,
      limit: 20,
      item_count: 1,
      items: [{
        rank: 1,
        id: 'blog:openai:1',
        title_zh: '标题',
        summary_zh: '摘要',
        source: 'OpenAI',
        url: 'https://example.test/1',
        published_at: '2026-09-07T03:00:00Z',
        score: 88,
        event_source_count: 2,
      }],
    };
    const { env, inserted, kvStore } = makeEnv();
    await expect(storeHotNewsSnapshot(env, snapshot)).resolves.toEqual({ kv_written: true });
    expect(JSON.parse(String(inserted[0]?.[2]))).toEqual(snapshot);
    expect(inserted[0]?.[3]).toBe(1);
    expect(JSON.parse(String(kvStore.get(HOT_NEWS_KV_KEY)))).toEqual(snapshot);
  });
});
