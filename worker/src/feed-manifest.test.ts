import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

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

import { buildFeedManifest } from './feed-manifest';
import { handleFeedManifest, type Env } from './index';

const FIXED_NOW = new Date('2026-07-10T00:00:00.000Z');
const PUBLIC_SOURCE_TYPES = [
  'x_list',
  'blog',
  'podcast',
  'product_hunt',
  'github',
  'hf_paper',
  'huodongxing',
  'clawhub',
  'youtube',
] as const;

function manifestDb(rows: Array<{ source_type: string }>) {
  const preparedSql: string[] = [];
  const boundValues: unknown[][] = [];
  let allCalls = 0;
  const db = {
    prepare(sql: string) {
      preparedSql.push(sql);
      const statement = {
        bind(...values: unknown[]) {
          boundValues.push(values);
          return statement;
        },
        async all() {
          allCalls += 1;
          return { results: rows };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  return {
    db,
    preparedSql,
    boundValues,
    allCalls: () => allCalls,
  };
}

describe('buildFeedManifest', () => {
  it('returns only live source types, user-visible labels, and generation time', async () => {
    const harness = manifestDb([
      { source_type: 'x_list' },
      { source_type: 'blog' },
      { source_type: 'podcast' },
      { source_type: 'arxiv' },
      { source_type: 'unknown_internal_source' },
    ]);

    const manifest = await buildFeedManifest(harness.db, () => FIXED_NOW);

    expect(manifest).toEqual({
      live_source_types: ['x_list', 'blog', 'podcast'],
      labels: {
        x_list: '动态',
        blog: '新闻',
        podcast: '播客',
      },
      generated_at: '2026-07-10T00:00:00.000Z',
    });
    expect(JSON.stringify(manifest)).not.toMatch(/cursor|config|topic|source_ref|item_count/);
  });

  it('uses one grouped live-items query instead of correlated per-source counts', async () => {
    const harness = manifestDb([{ source_type: 'x_list' }]);

    await buildFeedManifest(harness.db, () => FIXED_NOW);

    expect(harness.preparedSql).toHaveLength(1);
    expect(harness.allCalls()).toBe(1);
    expect(harness.preparedSql[0]).toMatch(/GROUP BY\s+source_type/i);
    expect(harness.preparedSql[0]).toMatch(/is_relevant\s*=\s*1/i);
    expect(harness.preparedSql[0]).toMatch(/deleted_at\s+IS\s+NULL/i);
    expect(harness.preparedSql[0]).toMatch(/source_type\s+IN\s*\(/i);
    expect(harness.preparedSql[0]).not.toMatch(/SELECT\s+COUNT|\(\s*SELECT/i);
    expect(harness.boundValues).toEqual([[...PUBLIC_SOURCE_TYPES]]);
  });
});

describe('GET /api/feed-manifest', () => {
  it('serves a cacheable payload under 2 KiB without leaking source metadata', async () => {
    const internalSourceTypes = [
      'arxiv',
      'admin_only',
      ...Array.from({ length: 200 }, (_, index) => `unknown_internal_source_${index}_${'x'.repeat(40)}`),
    ];
    const harness = manifestDb(
      [...PUBLIC_SOURCE_TYPES, ...internalSourceTypes].map((source_type) => ({ source_type })),
    );
    const request = new Request('https://api.ai-feeds.com/api/feed-manifest', {
      headers: { Origin: 'https://ai-feeds.com' },
    });

    const response = await handleFeedManifest(
      request,
      { DB: harness.db } as Env,
      () => FIXED_NOW,
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=60, s-maxage=300');
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://ai-feeds.com');
    expect(new TextEncoder().encode(body).byteLength).toBeLessThan(2 * 1024);
    expect(body).not.toMatch(/cursor|config|topic|source_ref|item_count/);
    const payload = JSON.parse(body) as {
      live_source_types: string[];
      labels: Record<string, string>;
      generated_at: string;
    };
    expect(payload).toMatchObject({
      live_source_types: [...PUBLIC_SOURCE_TYPES],
      generated_at: FIXED_NOW.toISOString(),
    });
    expect(Object.keys(payload.labels)).toEqual([...PUBLIC_SOURCE_TYPES]);
    expect(payload.live_source_types).not.toContain('arxiv');
    expect(payload.live_source_types.every((sourceType) => PUBLIC_SOURCE_TYPES.includes(sourceType as never))).toBe(true);
    for (const internalSourceType of internalSourceTypes) {
      expect(body).not.toContain(internalSourceType);
    }
  });

  it('keeps the compatibility routes and wires the new public GET route', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf8');

    expect(source).toMatch(/path === '\/api\/feed-manifest'\s*&&\s*request\.method === 'GET'/);
    expect(source).toMatch(/path === '\/api\/sources'\s*&&\s*request\.method === 'GET'/);
    expect(source).toMatch(/path === '\/api\/stats'\s*&&\s*request\.method === 'GET'/);
    expect(source).toMatch(/path === '\/api\/items' \|\| path === '\/api\/feed-manifest'/);
  });
});
