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
  d1DurationMs,
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
  it('formats only measurable D1 I/O metrics in a stable order', () => {
    expect(formatServerTiming({
      d1: 223,
      thread_d1: 17,
      map: 4,
      json: 2,
      total: 231,
    })).toBe('d1;dur=223, thread_d1;dur=17');
  });

  it('drops invalid values and untrusted metric names', () => {
    expect(formatServerTiming({ d1: -1, thread_d1: Number.NaN })).toBe('');
    expect(formatServerTiming({
      d1: 2.3456,
      thread_d1: 1.2345,
      'evil;desc="injected"': 10,
      '__proto__': 8,
    })).toBe('d1;dur=2.346, thread_d1;dur=1.234');
  });
});

describe('d1DurationMs', () => {
  it('prefers D1 sql_duration_ms and normalizes it to the header precision', () => {
    expect(d1DurationMs({
      meta: {
        timings: { sql_duration_ms: 7.12345 },
        duration: 99,
      },
    })).toBe(7.123);
  });

  it('falls back to legacy meta.duration when the precise value is absent or invalid', () => {
    expect(d1DurationMs({ meta: { duration: 8.76549 } })).toBe(8.765);
    expect(d1DurationMs({
      meta: {
        timings: { sql_duration_ms: Number.NaN },
        duration: 6.25,
      },
    })).toBe(6.25);
  });

  it('returns a finite non-negative fallback for missing or invalid metadata', () => {
    for (const result of [
      {},
      { meta: {} },
      { meta: { timings: { sql_duration_ms: -1 }, duration: -2 } },
      { meta: { timings: { sql_duration_ms: '4' }, duration: Number.POSITIVE_INFINITY } },
      null,
    ]) {
      expect(d1DurationMs(result)).toBe(0);
    }
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

function metricValue(header: string, metric: string): number {
  const match = header.match(new RegExp(`(?:^|, )${metric};dur=([0-9.]+)(?:,|$)`));
  if (!match) throw new Error(`missing ${metric} in ${header}`);
  return Number(match[1]);
}

type D1MockResult = {
  rows: Record<string, unknown>[];
  meta?: unknown;
};

function d1Harness(mockResults: D1MockResult[]) {
  let allCalls = 0;
  const env = {
    DB: {
      prepare: () => {
        const statement = {
          bind: () => statement,
          all: async () => {
            const result = mockResults[allCalls++] ?? { rows: [] };
            return { results: result.rows, meta: result.meta };
          },
        };
        return statement;
      },
    },
  } as unknown as Env;
  return { env, allCalls: () => allCalls };
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

  it('publishes only supplied I/O timings and safely merges CORS/custom headers', async () => {
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
        timings: {
          d1: 4,
          thread_d1: 5,
          map: 999,
          json: 999,
          total: 999,
        },
      },
    );

    expect(await response.json()).toEqual({ items: [] });
    expect(response.headers.get('Server-Timing')).toBe('d1;dur=4, thread_d1;dur=5');
    expect(response.headers.get('Server-Timing')).not.toMatch(/map|json|total/);
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
  ])('reports only the %s SQL duration from D1 result metadata', async (_name, query) => {
    const harness = d1Harness([{
      rows: [],
      meta: { timings: { sql_duration_ms: 12.3456 }, duration: 99 },
    }]);
    const request = new Request(`https://api.ai-feeds.com/api/items${query}`, {
      headers: {
        Origin: 'https://ai-feeds.com',
        'X-Request-Id': 'nginx-list-1',
      },
    });
    const response = await handleItems(request, harness.env);
    const payload = await response.json() as { query_time_ms: number };
    const header = response.headers.get('Server-Timing') || '';

    expect(harness.allCalls()).toBe(1);
    expect(header).toBe('d1;dur=12.346');
    expect(header).not.toMatch(/thread_d1|map|json|total/);
    expect(payload.query_time_ms).toBe(metricValue(header, 'd1'));
    expect(response.headers.get('X-Request-Id')).toBe('nginx-list-1');
    expect(response.headers.get('Timing-Allow-Origin')).toBe('https://ai-feeds.com');
  });

  it('reports the optional thread query as thread_d1 without changing query_time_ms', async () => {
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
    const harness = d1Harness([
      { rows: [root], meta: { timings: { sql_duration_ms: 5 }, duration: 55 } },
      { rows: [sibling], meta: { timings: { sql_duration_ms: 17 }, duration: 77 } },
    ]);

    const response = await handleItems(
      new Request('https://api.ai-feeds.com/api/items?limit=1', {
        headers: { Origin: 'https://ai-feeds.com' },
      }),
      harness.env,
    );
    const payload = await response.json() as { query_time_ms: number; items: unknown[] };

    expect(harness.allCalls()).toBe(2);
    expect(payload.items).toHaveLength(2);
    expect(payload.query_time_ms).toBe(5);
    expect(response.headers.get('Server-Timing')).toBe('d1;dur=5, thread_d1;dur=17');
  });

  it.each([
    ['legacy fallback', { duration: 6.7894 }, 6.789],
    ['missing metadata', undefined, 0],
    ['invalid metadata', { timings: { sql_duration_ms: -1 }, duration: Number.NaN }, 0],
  ])('keeps query_time_ms and d1 safely aligned for %s', async (_name, meta, expected) => {
    const harness = d1Harness([{ rows: [], meta }]);
    const response = await handleItems(
      new Request('https://api.ai-feeds.com/api/items', {
        headers: { Origin: 'https://ai-feeds.com' },
      }),
      harness.env,
    );
    const payload = await response.json() as { query_time_ms: number };

    expect(payload.query_time_ms).toBe(expected);
    expect(response.headers.get('Server-Timing')).toBe(`d1;dur=${expected}`);
  });

  it('does not consult the Worker JS clock for D1 attribution', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(123456);
    const harness = d1Harness([{
      rows: [],
      meta: { timings: { sql_duration_ms: 4.5 }, duration: 99 },
    }]);

    try {
      const response = await handleItems(
        new Request('https://api.ai-feeds.com/api/items', {
          headers: { Origin: 'https://ai-feeds.com' },
        }),
        harness.env,
      );
      expect(response.headers.get('Server-Timing')).toBe('d1;dur=4.5');
      expect(clock).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
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
