import { readFileSync } from 'node:fs';
import { fileURLToPath, URL as NodeURL } from 'node:url';
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

import worker, { type Env } from './index';
import { HOT_NEWS_KV_KEY, type HotNewsSnapshot } from './digest/hot-news';

const wranglerConfig = readFileSync(
  fileURLToPath(new NodeURL('../wrangler.toml', import.meta.url)),
  'utf8',
);

const snapshot: HotNewsSnapshot = {
  version: 1,
  computed_at: '2026-09-07T02:00:00.000Z',
  window_hours: 72,
  limit: 20,
  item_count: 2,
  items: [
    {
      rank: 1,
      id: 'blog:openai:1',
      title_zh: 'OpenAI 发布新模型',
      summary_zh: '摘要一',
      source: 'OpenAI',
      url: 'https://example.test/1',
      published_at: '2026-09-07T01:00:00Z',
      score: 91.5,
      event_source_count: 3,
    },
    {
      rank: 2,
      id: 'blog:anthropic:2',
      title_zh: 'Anthropic 更新文档',
      summary_zh: '摘要二',
      source: 'Anthropic',
      url: 'https://example.test/2',
      published_at: '2026-09-07T00:30:00Z',
      score: 80,
      event_source_count: 1,
    },
  ],
};

/** KV / D1 都能按需置空，用来验证「都缺就 503」这条硬规矩。 */
function makeEnv(options: {
  kv?: HotNewsSnapshot | null;
  d1?: HotNewsSnapshot | null;
  originSecret?: string;
} = {}): { env: Env; d1Calls: string[] } {
  const d1Calls: string[] = [];
  const env = {
    ORIGIN_SECRET: options.originSecret,
    AUTH_KV: {
      async get(key: string) {
        expect(key).toBe(HOT_NEWS_KV_KEY);
        return options.kv === undefined || options.kv === null ? null : JSON.stringify(options.kv);
      },
      async put() { /* 读路径不写 KV */ },
    },
    DB: {
      prepare(sql: string) {
        d1Calls.push(sql);
        return {
          bind() { return this; },
          async first() {
            if (!/hot_news_snapshots/.test(sql)) return null;
            return options.d1 ? { payload_json: JSON.stringify(options.d1) } : null;
          },
          async all() { return { results: [] }; },
          async run() { return { success: true }; },
        };
      },
    },
  } as unknown as Env;
  return { env, d1Calls };
}

async function fetchHot(url: string, env: Env, init?: RequestInit): Promise<Response> {
  return worker.fetch(new Request(url, init), env, {} as ExecutionContext);
}

describe('public hot news endpoint', () => {
  test('serves the same snapshot on the hot host root, /news and /api/hot/news', async () => {
    const { env } = makeEnv({ kv: snapshot });
    for (const url of [
      'https://hot.ai-feeds.com/',
      'https://hot.ai-feeds.com/news',
      'https://hot.ai-feeds.com/api/hot/news',
      'https://api.ai-feeds.com/api/hot/news',
    ]) {
      const response = await fetchHot(url, env);
      expect(response.status).toBe(200);
      const body = await response.json() as HotNewsSnapshot;
      expect(body.computed_at).toBe(snapshot.computed_at);
      expect(body.window_hours).toBe(72);
      expect(body.items.map((item) => item.id)).toEqual(['blog:openai:1', 'blog:anthropic:2']);
    }
  });

  test('answers cross-origin reads with a wildcard CORS header and edge cache hints', async () => {
    const { env } = makeEnv({ kv: snapshot });
    const response = await fetchHot('https://hot.ai-feeds.com/news', env, {
      headers: { Origin: 'https://someone-elses-site.test' },
    });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=60, s-maxage=300');

    const preflight = await fetchHot('https://hot.ai-feeds.com/api/hot/news', env, {
      method: 'OPTIONS',
      headers: { Origin: 'https://someone-elses-site.test' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  test('passes the production origin gate without the relay secret', async () => {
    const { env } = makeEnv({ kv: snapshot, originSecret: 'relay-secret' });
    const allowed = await fetchHot('https://hot.ai-feeds.com/news', env);
    expect(allowed.status).toBe(200);

    // 同一 host 的其它路径不豁免:直连没有 X-Origin-Secret 照旧 403。
    const blocked = await fetchHot('https://hot.ai-feeds.com/api/items', env);
    expect(blocked.status).toBe(403);
  });

  test('lets non-browser user agents through the bot gate', async () => {
    const { env } = makeEnv({ kv: snapshot });
    for (const ua of ['curl/8.7.1', 'python-requests/2.32.3', 'GPTBot/1.0']) {
      const response = await fetchHot('https://hot.ai-feeds.com/news', env, {
        headers: { 'User-Agent': ua },
      });
      expect(response.status).toBe(200);
    }
  });

  test('caps limit at the snapshot length and never exceeds twenty', async () => {
    const { env } = makeEnv({ kv: snapshot });
    const one = await fetchHot('https://hot.ai-feeds.com/news?limit=1', env);
    const body = await one.json() as HotNewsSnapshot;
    expect(body.limit).toBe(1);
    expect(body.item_count).toBe(1);
    expect(body.items).toHaveLength(1);

    const huge = await fetchHot('https://hot.ai-feeds.com/news?limit=500', env);
    expect((await huge.json() as HotNewsSnapshot).limit).toBe(20);
  });

  test('falls back to the D1 copy when KV is empty', async () => {
    const { env, d1Calls } = makeEnv({ kv: null, d1: snapshot });
    const response = await fetchHot('https://hot.ai-feeds.com/news', env);
    expect(response.status).toBe(200);
    expect((await response.json() as HotNewsSnapshot).item_count).toBe(2);
    expect(d1Calls.some((sql) => /hot_news_snapshots/.test(sql))).toBe(true);
  });

  test('returns 503 with Retry-After when both KV and D1 are empty, and never computes inline', async () => {
    const { env, d1Calls } = makeEnv({ kv: null, d1: null });
    const response = await fetchHot('https://hot.ai-feeds.com/news', env);
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(await response.json()).toEqual({ ok: false, error: 'snapshot_unavailable' });
    // 读路径只查快照那一行，不碰 items / 打分查询。
    expect(d1Calls.every((sql) => /hot_news_snapshots/.test(sql))).toBe(true);
  });

  test('rejects writes and unsupported windows without touching storage', async () => {
    const { env } = makeEnv({ kv: snapshot });
    const post = await fetchHot('https://hot.ai-feeds.com/news', env, { method: 'POST' });
    expect(post.status).toBe(405);
    const badWindow = await fetchHot('https://hot.ai-feeds.com/news?window_hours=24', env);
    expect(badWindow.status).toBe(400);
    expect(await badWindow.json()).toMatchObject({ error: 'unsupported_window' });
  });

  test('production registers the hot custom domain and staging does not', () => {
    const productionConfig = wranglerConfig.split('[env.staging]')[0];
    expect(productionConfig).toMatch(
      /\[\[routes\]\]\s+pattern = "hot\.ai-feeds\.com"\s+custom_domain = true/,
    );
    expect(wranglerConfig.split('[env.staging]')[1] || '').not.toContain('hot.ai-feeds.com');
  });
});
