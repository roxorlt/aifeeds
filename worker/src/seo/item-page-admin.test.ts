import { describe, expect, test, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class {
    env: unknown;
    ctx: unknown;

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import worker, { type Env } from '../index';

interface ItemSeed {
  id: string;
  is_relevant: number;
}

function makeEnv(seed?: ItemSeed): Env & { puts: string[]; dbCalls: string[] } {
  const puts: string[] = [];
  const dbCalls: string[] = [];
  const row = seed
    ? {
        id: seed.id,
        source_type: seed.id.slice(0, seed.id.indexOf(':')),
        is_relevant: seed.is_relevant,
        published_at: '2026-07-17T08:00:00Z',
        scraped_at: '2026-07-17T08:00:00Z',
        title: 'Fixture title',
        content: 'Fixture body',
        content_translated: 'Fixture translated body',
        author: 'Fixture author',
        handle: '@fixture',
        url: 'https://example.com/item',
        media: null,
        extra: JSON.stringify({ ai_summary: 'Fixture summary' }),
      }
    : null;

  const DB = {
    prepare(sql: string) {
      dbCalls.push(sql);
      let binds: unknown[] = [];
      const stmt = {
        bind(...values: unknown[]) {
          binds = values;
          return stmt;
        },
        async first<T>() {
          if (/SELECT \* FROM items WHERE id = \?/i.test(sql)) {
            return (row && binds[0] === row.id ? row : null) as T | null;
          }
          if (/SELECT status FROM item_pages/i.test(sql)) return null as T | null;
          return null as T | null;
        },
        async all<T>() {
          return { results: [] as T[] };
        },
        async run() {
          return { success: true };
        },
      };
      return stmt;
    },
  };

  return {
    SITE_BASE: 'https://ai-feeds.com',
    API_BASE: 'https://api.ai-feeds.com',
    INGEST_TOKEN: 'ingest-token',
    DB,
    READMES: {
      async put(key: string) {
        puts.push(key);
      },
    },
    puts,
    dbCalls,
  } as unknown as Env & { puts: string[]; dbCalls: string[] };
}

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

async function call(url: string, env: Env, authorized = true): Promise<Response> {
  const headers = new Headers({ 'User-Agent': 'Mozilla/5.0' });
  if (authorized) headers.set('Authorization', 'Bearer ingest-token');
  return worker.fetch(new Request(url, { method: 'POST', headers }), env, ctx);
}

describe('mode=item-page-regenerate', () => {
  test('复用 enrich Bearer 鉴权，未授权时零写', async () => {
    const env = makeEnv({ id: 'x_list:2061451225762046411', is_relevant: 1 });
    const response = await call(
      'https://api.ai-feeds.com/api/enrich/run?mode=item-page-regenerate&id=x_list%3A2061451225762046411',
      env,
      false,
    );

    expect(response.status).toBe(401);
    expect(env.puts).toHaveLength(0);
    expect(env.dbCalls).toHaveLength(0);
  });

  test.each([
    '',
    'https://example.com/i/x/1',
    'clawhub:unsupported',
    `x_list:${'a'.repeat(506)}`,
  ])('拒绝缺失、任意 URL、非出页源和超长 id：%s', async (id) => {
    const env = makeEnv();
    const response = await call(
      `https://api.ai-feeds.com/api/enrich/run?mode=item-page-regenerate&id=${encodeURIComponent(id)}`,
      env,
    );

    expect(response.status).toBe(400);
    expect(env.puts).toHaveLength(0);
    expect(env.dbCalls).toHaveLength(0);
  });

  test('合法 composite id 只重生该页并返回运维字段', async () => {
    const id = 'x_list:2061451225762046411';
    const env = makeEnv({ id, is_relevant: 1 });
    const response = await call(
      `https://api.ai-feeds.com/api/enrich/run?mode=item-page-regenerate&id=${encodeURIComponent(id)}`,
      env,
    );
    const body = await response.json<Record<string, unknown>>();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      mode: 'item-page-regenerate',
      item_id: id,
      skipped: false,
    });
    expect(body.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(env.puts).toHaveLength(1);
  });

  test('真实 not-relevant gate 不被重生入口绕过', async () => {
    const id = 'x_list:2061451225762046411';
    const env = makeEnv({ id, is_relevant: 0 });
    const response = await call(
      `https://api.ai-feeds.com/api/enrich/run?mode=item-page-regenerate&id=${encodeURIComponent(id)}`,
      env,
    );
    const body = await response.json<Record<string, unknown>>();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      item_id: id,
      skipped: true,
      reason: 'not-relevant',
    });
    expect(env.puts).toHaveLength(0);
  });
});
