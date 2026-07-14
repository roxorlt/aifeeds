import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('./selection', () => ({
  selectTopForSource: vi.fn(),
  selectNewsByScoreWithAudit: vi.fn(),
  excludeAlreadyPushed: vi.fn(),
}));
vi.mock('./llm-curate', () => ({
  curateSource: vi.fn(),
}));

import { rebuildDigestPoolSnapshot, rebuildDigestPoolSource } from './pool-rebuild';
import { selectTopForSource, selectNewsByScoreWithAudit, excludeAlreadyPushed } from './selection';
import { curateSource } from './llm-curate';

interface PoolRow {
  slot: string;
  source: string;
  density: string;
  ids: string[];
  meta: Record<string, unknown> | null;
}

function makeEnv() {
  const pools = new Map<string, PoolRow>();
  const rows = new Map<string, Record<string, unknown>>();
  for (const source of ['news', 'ph', 'gh', 'hf-paper', 'x']) {
    for (let i = 1; i <= 8; i++) {
      const id = `${source}-${i}`;
      rows.set(id, {
        id,
        title: `${source} 标题 ${i}`,
        content: `${source} 正文 ${i}`,
        content_translated: `${source} 中文正文 ${i}`,
        author: `${source}-author`,
        handle: `${source}-handle`,
        extra: '{}',
      });
    }
  }
  const DB = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async run() {
          if (/INSERT INTO digest_pool/i.test(sql)) {
            const [slot, source, density, itemIds, itemsMeta] = binds;
            pools.set(`${slot}|${source}|${density}`, {
              slot: String(slot),
              source: String(source),
              density: String(density),
              ids: JSON.parse(String(itemIds)),
              meta: itemsMeta ? JSON.parse(String(itemsMeta)) : null,
            });
          }
          return { success: true };
        },
        async all<T>() {
          if (/FROM digest_pool/i.test(sql)) {
            const slot = String(binds[0]);
            return {
              results: [...pools.values()]
                .filter((row) => row.slot === slot && row.density === 'curated')
                .map((row) => ({ item_ids: JSON.stringify(row.ids) })) as T[],
            };
          }
          if (/FROM items/i.test(sql)) {
            return { results: binds.map((id) => rows.get(String(id))).filter(Boolean) as T[] };
          }
          return { results: [] as T[] };
        },
      };
      return stmt;
    },
  };
  return { env: { DB } as never, pools };
}

describe('digest pool safe rescore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(selectNewsByScoreWithAudit).mockResolvedValue({
      ids: Array.from({ length: 8 }, (_, i) => `news-${i + 1}`),
      audit: { clustered_count: 8 },
    } as never);
    vi.mocked(selectTopForSource).mockImplementation(async (_env, source) => (
      Array.from({ length: 8 }, (_, i) => `${source}-${i + 1}`)
    ));
    vi.mocked(excludeAlreadyPushed).mockImplementation(async (_env, ids) => ids);
    vi.mocked(curateSource).mockImplementation(async (_env, _source, candidates, n) => (
      candidates.slice(0, n).map((candidate) => candidate.id)
    ));
  });

  test('rebuilds the same normal/curated pools used by the workflow without delivery side effects', async () => {
    const { env, pools } = makeEnv();
    const result = await rebuildDigestPoolSnapshot(env, { date: '2026-07-14', slotHourBjt: 8 });

    expect(result.slotKey).toBe('2026-07-14-08');
    expect(result.sources.map((row) => row.source)).toEqual(['news', 'ph', 'gh', 'hf-paper', 'x']);
    expect(pools.get('2026-07-14-08|news|normal')?.ids).toEqual([
      'news-1', 'news-2', 'news-3', 'news-4', 'news-5',
    ]);
    expect(pools.get('2026-07-14-08|news|curated')?.ids).toEqual(['news-1', 'news-2', 'news-3']);
    expect(pools.get('2026-07-14-08|gh|normal')?.ids).toHaveLength(5);
    expect(pools.get('2026-07-14-08|hf-paper|normal')?.ids).toHaveLength(5);
    expect(pools.has('2026-07-14-08|clawhub|normal')).toBe(false);
    expect(pools.get('2026-07-14-08|_subject|meta')?.meta?.subject).toBeTruthy();
    expect(selectNewsByScoreWithAudit).toHaveBeenCalledWith(
      env,
      30,
      { strictCrossDayEventDedup: true, editorialReview: true },
    );
  });

  test('preserves the workflow empty-after-dedup fallback so a source does not disappear', async () => {
    const { env, pools } = makeEnv();
    vi.mocked(selectTopForSource).mockResolvedValue(['gh-1', 'gh-2']);
    vi.mocked(excludeAlreadyPushed).mockResolvedValue([]);

    const result = await rebuildDigestPoolSource(env, '2026-07-14-08', 'gh');

    expect(result.candidates).toBe(2);
    expect(pools.get('2026-07-14-08|gh|normal')?.ids).toEqual(['gh-1', 'gh-2']);
  });
});
