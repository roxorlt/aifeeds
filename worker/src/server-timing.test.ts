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

import {
  formatServerTiming,
  resolveRequestId,
} from './server-timing';
import {
  handleItemById,
  handleItems,
  jsonResponse,
  type Env,
} from './index';

describe('formatServerTiming', () => {
  it('formats known metrics in a stable order', () => {
    expect(formatServerTiming({ d1: 223, map: 4, json: 2, total: 231 }))
      .toBe('d1;dur=223, map;dur=4, json;dur=2, total;dur=231');
  });

  it('drops invalid values and untrusted metric names', () => {
    expect(formatServerTiming({ d1: -1, total: Number.NaN })).toBe('');
    expect(formatServerTiming({
      d1: 2.3456,
      'evil;desc="injected"': 10,
      '__proto__': 8,
    })).toBe('d1;dur=2.346');
  });
});

describe('resolveRequestId', () => {
  const generated = 'generated_safe_id';
  const generate = () => generated;

  it('echoes only a valid incoming request id', () => {
    expect(resolveRequestId('nginx-Request_123', generate)).toBe('nginx-Request_123');
  });

  it('generates an id when the incoming value is missing or unsafe', () => {
    expect(resolveRequestId(null, generate)).toBe(generated);
    expect(resolveRequestId('bad\r\nX-Evil: yes', generate)).toBe(generated);
    expect(resolveRequestId('x'.repeat(65), generate)).toBe(generated);
    expect(resolveRequestId('', generate)).toBe(generated);
  });
});

function incrementalClock(step = 1): () => number {
  let value = 0;
  return () => {
    const current = value;
    value += step;
    return current;
  };
}

function metricValue(header: string, metric: string): number {
  const match = header.match(new RegExp(`(?:^|, )${metric};dur=([0-9.]+)(?:,|$)`));
  if (!match) throw new Error(`missing ${metric} in ${header}`);
  return Number(match[1]);
}

function listEnv(rows: Record<string, unknown>[] = []): Env {
  return {
    DB: {
      prepare: () => {
        const statement = {
          bind: () => statement,
          all: async () => ({ results: rows }),
        };
        return statement;
      },
    },
  } as unknown as Env;
}

describe('jsonResponse performance headers', () => {
  it('keeps the default caller response contract unchanged', async () => {
    const request = new Request('https://api.ai-feeds.com/api/health', {
      headers: { Origin: 'https://ai-feeds.com' },
    });
    const response = jsonResponse({ ok: true }, 200, request, {} as Env);

    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://ai-feeds.com');
    expect(response.headers.has('Server-Timing')).toBe(false);
    expect(response.headers.has('Timing-Allow-Origin')).toBe(false);
    expect(response.headers.get('X-Request-Id')).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it('measures serialization and total through response creation with safe merged headers', async () => {
    const request = new Request('https://api.ai-feeds.com/api/items', {
      headers: {
        Origin: 'https://staging.ai-feeds.com',
        'X-Request-Id': 'relay_123',
      },
    });
    const response = jsonResponse(
      { items: [] },
      200,
      request,
      {} as Env,
      {
        headers: {
          'Cache-Control': 'private, max-age=0',
          'Access-Control-Allow-Origin': 'https://evil.invalid',
        },
        timings: { d1: 4, map: 5, ignored: 999 },
        totalStartedAt: 0,
        now: (() => {
          const values = [10, 12, 31];
          return () => values.shift() ?? 31;
        })(),
      },
    );

    expect(await response.json()).toEqual({ items: [] });
    expect(response.headers.get('Server-Timing'))
      .toBe('d1;dur=4, map;dur=5, json;dur=2, total;dur=31');
    expect(response.headers.get('X-Request-Id')).toBe('relay_123');
    expect(response.headers.get('Timing-Allow-Origin')).toBe('https://staging.ai-feeds.com');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://staging.ai-feeds.com');
    expect(response.headers.get('Vary')).toContain('Origin');
    expect(response.headers.get('Cache-Control')).toBe('private, max-age=0');
  });

  it.each([
    [undefined, 'generated_1'],
    ['bad value,second-id', 'generated_2'],
    ['x'.repeat(65), 'generated_3'],
  ])('generates a safe response id for missing or invalid input', (requestId, generated) => {
    const headers = new Headers({ Origin: 'https://ai-feeds.com' });
    if (requestId !== undefined) headers.set('X-Request-Id', requestId);
    const response = jsonResponse(
      {},
      200,
      new Request('https://api.ai-feeds.com/api/items', { headers }),
      {} as Env,
      {
        timings: {},
        totalStartedAt: 0,
        now: () => 0,
        generateRequestId: () => generated,
      },
    );
    expect(response.headers.get('X-Request-Id')).toBe(generated);
  });

  it('never carries a custom Timing-Allow-Origin through for a disallowed origin', () => {
    const response = jsonResponse(
      {},
      200,
      new Request('https://api.ai-feeds.com/api/items', {
        headers: { Origin: 'https://evil.invalid' },
      }),
      {} as Env,
      {
        headers: { 'Timing-Allow-Origin': '*' },
        timings: {},
        totalStartedAt: 0,
        now: () => 0,
        generateRequestId: () => 'generated_safe_id',
      },
    );

    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('');
    expect(response.headers.has('Timing-Allow-Origin')).toBe(false);
  });
});

describe('GET /api/items list timing', () => {
  it.each([
    ['generic', ''],
    ['github', '?source_type=github'],
    ['clawhub', '?source_type=clawhub'],
    ['product hunt', '?source_type=product_hunt'],
    ['huodongxing', '?source_type=huodongxing'],
  ])('instruments the %s list handler with attributable finite phases', async (_name, query) => {
    const request = new Request(`https://api.ai-feeds.com/api/items${query}`, {
      headers: {
        Origin: 'https://ai-feeds.com',
        'X-Request-Id': 'nginx-list-1',
      },
    });
    const response = await handleItems(request, listEnv(), incrementalClock(1.23456));
    const payload = await response.json() as { query_time_ms: number };
    const header = response.headers.get('Server-Timing') || '';

    for (const metric of ['d1', 'map', 'json', 'total']) {
      expect(metricValue(header, metric)).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(metricValue(header, metric))).toBe(true);
    }
    expect(payload.query_time_ms).toBe(metricValue(header, 'd1'));
    expect(metricValue(header, 'total')).toBeGreaterThanOrEqual(
      metricValue(header, 'd1') + metricValue(header, 'json'),
    );
    expect(response.headers.get('X-Request-Id')).toBe('nginx-list-1');
    expect(response.headers.get('Timing-Allow-Origin')).toBe('https://ai-feeds.com');
  });

  it('keeps thread completion in map while query_time_ms stays the primary list D1 interval', async () => {
    let allCalls = 0;
    let time = 0;
    const now = () => time;
    const root = {
      id: 'x_list:root',
      source_type: 'x_list',
      scraped_at: '2026-01-01T00:00:00Z',
      extra: JSON.stringify({ thread_root_id: 'root' }),
    };
    const sibling = {
      id: 'x_list:sibling',
      source_type: 'x_list',
      scraped_at: '2026-01-01T00:00:00Z',
      extra: JSON.stringify({ thread_root_id: 'root' }),
    };
    const env = {
      DB: {
        prepare: () => {
          const statement = {
            bind: () => statement,
            all: async () => {
              const isPrimaryQuery = allCalls++ === 0;
              time += isPrimaryQuery ? 5 : 17;
              return { results: isPrimaryQuery ? [root] : [sibling] };
            },
          };
          return statement;
        },
      },
    } as unknown as Env;

    const response = await handleItems(
      new Request('https://api.ai-feeds.com/api/items?limit=1', {
        headers: { Origin: 'https://ai-feeds.com' },
      }),
      env,
      now,
    );
    const payload = await response.json() as { query_time_ms: number; items: unknown[] };
    const timing = response.headers.get('Server-Timing') || '';

    expect(allCalls).toBe(2);
    expect(payload.items).toHaveLength(2);
    expect(payload.query_time_ms).toBe(5);
    expect(metricValue(timing, 'd1')).toBe(5);
    expect(metricValue(timing, 'map')).toBe(17);
  });

  it('measures only the primary all() wait as d1, excluding prepare and bind', async () => {
    let time = 0;
    const now = () => time;
    const env = {
      DB: {
        prepare: () => {
          time += 11;
          const statement = {
            bind: () => {
              time += 13;
              return statement;
            },
            all: async () => {
              time += 7.12345;
              return { results: [] };
            },
          };
          return statement;
        },
      },
    } as unknown as Env;

    const response = await handleItems(
      new Request('https://api.ai-feeds.com/api/items', {
        headers: { Origin: 'https://ai-feeds.com' },
      }),
      env,
      now,
    );
    const payload = await response.json() as { query_time_ms: number };
    const timing = response.headers.get('Server-Timing') || '';

    expect(payload.query_time_ms).toBe(7.123);
    expect(metricValue(timing, 'd1')).toBe(7.123);
  });

  it('does not time or strip detail-only fields from /api/items/:id', async () => {
    const row = {
      id: 'x_list:detail',
      source_type: 'x_list',
      extra: JSON.stringify({ top_comments: [{ text: 'kept in detail' }] }),
    };
    const env = {
      DB: {
        prepare: () => {
          const statement = {
            bind: () => statement,
            first: async () => row,
          };
          return statement;
        },
      },
    } as unknown as Env;
    const response = await handleItemById(
      new Request('https://api.ai-feeds.com/api/items/x_list%3Adetail', {
        headers: { Origin: 'https://ai-feeds.com' },
      }),
      env,
      'x_list:detail',
    );
    const payload = await response.json() as { item: { extra: Record<string, unknown> } };

    expect(payload.item.extra.top_comments).toEqual([{ text: 'kept in detail' }]);
    expect(response.headers.has('Server-Timing')).toBe(false);
    expect(response.headers.has('Timing-Allow-Origin')).toBe(false);
  });
});
