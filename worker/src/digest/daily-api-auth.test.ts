import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('./news-source-policy', () => ({
  authorizeFormalNewsSet: vi.fn(),
}));

import type { Env } from '../index';
import { handleDigestDaily } from './daily-api';
import { authorizeFormalNewsSet } from './news-source-policy';

function makeEnv() {
  const pools = new Map([
    ['normal', JSON.stringify(['blog:openai:allowed', 'generic-radar'])],
    ['curated', JSON.stringify(['generic-radar', 'blog:openai:allowed'])],
  ]);
  const rows = new Map([
    ['blog:openai:allowed', {
      id: 'blog:openai:allowed', title: 'Allowed', content: 'Allowed content', content_translated: null,
      author: 'OpenAI', handle: null, url: 'https://openai.com/news/allowed', media: null,
      extra: JSON.stringify({ feed_id: 'blog:openai', feed_key: 'openai' }), metrics: null, published_at: 1,
    }],
    ['generic-radar', {
      id: 'generic-radar', title: 'Radar', content: 'Radar content', content_translated: null,
      author: 'Radar', handle: null, url: 'https://example.com/radar', media: null,
      extra: JSON.stringify({ feed_id: 'blog:weibo-hot-tech' }), metrics: null, published_at: 2,
    }],
  ]);
  const DB = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...values: unknown[]) { binds = values; return stmt; },
        async first<T>() {
          if (/FROM digest_pool/i.test(sql)) return { item_ids: pools.get(String(binds[2])) || '[]' } as T;
          return null as T | null;
        },
        async all<T>() {
          if (/FROM items/i.test(sql)) {
            return { results: binds.map((id) => rows.get(String(id))).filter(Boolean) as T[] };
          }
          return { results: [] as T[] };
        },
      };
      return stmt;
    },
  };
  return {
    DB,
    DIGEST_API_KEY: 'test-key',
    API_BASE: 'https://api.test',
    SITE_BASE: 'https://site.test',
  } as unknown as Env;
}

beforeEach(() => {
  vi.mocked(authorizeFormalNewsSet).mockImplementation(async (_env, _date, ids) => ({
    allowed_ids: ids.filter((id) => id === 'blog:openai:allowed'),
    decisions: ids.map((id) => id === 'blog:openai:allowed'
      ? { item_id: id, allowed: true, code: 'ALLOW_SCHEDULED_FORMAL' as const }
      : { item_id: id, allowed: false, code: 'DENY_EXPLICIT_ITEM_RADAR' as const }),
  }));
});

describe('daily API snapshot current formal-news authorization', () => {
  test.each([
    ['normal', false],
    ['curated', false],
    ['both', false],
    ['both', true],
  ])('%s verbose=%s filters the same current-denied news ID without rewriting the pool', async (density, verbose) => {
    const response = await handleDigestDaily(new Request(
      `https://api.test/api/digest/daily?mode=snapshot&date=2026-08-27&sources=news&density=${density}${verbose ? '&verbose=1' : ''}`,
      { headers: { Authorization: 'Bearer test-key' } },
    ), makeEnv());
    const body = await response.json() as {
      sections: Record<string, Array<{ items: Array<{ item_id: string; raw?: unknown }> }>>;
    };
    for (const sections of Object.values(body.sections)) {
      expect(sections.flatMap((section) => section.items.map((item) => item.item_id))).toEqual(['blog:openai:allowed']);
      if (verbose) expect(sections[0].items[0].raw).toBeDefined();
    }
    expect(authorizeFormalNewsSet).toHaveBeenCalled();
  });

  test('final projection drops an item that becomes radar after its early snapshot read', async () => {
    let calls = 0;
    vi.mocked(authorizeFormalNewsSet).mockImplementation(async (_env, _date, ids) => {
      calls += 1;
      const allowed = calls === 1 ? [...ids] : [];
      return {
        allowed_ids: allowed,
        decisions: ids.map((id) => ({
          item_id: id,
          allowed: calls === 1,
          code: calls === 1 ? 'ALLOW_SCHEDULED_FORMAL' as const : 'DENY_SOURCE_RADAR' as const,
        })),
      };
    });

    const response = await handleDigestDaily(new Request(
      'https://api.test/api/digest/daily?mode=snapshot&date=2026-08-27&sources=news&density=normal',
      { headers: { Authorization: 'Bearer test-key' } },
    ), makeEnv());
    const body = await response.json() as { sections: { normal: unknown[] } };

    expect(calls).toBe(2);
    expect(body.sections.normal).toEqual([]);
  });
});
