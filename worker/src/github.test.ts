import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { runGithubFetchTrending } from './github';

const TRENDING_HTML = `
  <article class="Box-row">
    <h2><a href="/owner/repo">owner / repo</a></h2>
    <p class="col-9">An AI repo</p>
    <span itemprop="programmingLanguage">TypeScript</span>
    <a class="Link--muted" href="/owner/repo/stargazers">1,234</a>
    <a class="Link--muted" href="/owner/repo/forks">56</a>
    <span class="float-sm-right">78 stars today</span>
  </article>`;

describe('runGithubFetchTrending re-trending', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-14T05:00:00.000Z'));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(TRENDING_HTML, { status: 200 })));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test('keeps original scraped_at and refreshes explicit last_seen_on_trending_at for an existing repo', async () => {
    const captured: Array<{ sql: string; binds: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        const entry = { sql, binds: [] as unknown[] };
        captured.push(entry);
        const statement = {
          bind(...binds: unknown[]) {
            entry.binds = binds;
            return statement;
          },
          async all<T>() {
            if (sql.includes('SELECT id FROM items WHERE id IN')) {
              return { results: [{ id: 'github:owner/repo' }] as T[] };
            }
            return { results: [] as T[] };
          },
        };
        return statement;
      },
      async batch(statements: unknown[]) {
        return statements.map(() => ({ meta: { changes: 1 } }));
      },
    };

    const result = await runGithubFetchTrending({ DB: db as unknown as D1Database });

    const upsert = captured.find((entry) => entry.sql.includes('ON CONFLICT(id) DO UPDATE'));
    expect(upsert).toBeDefined();
    expect(upsert?.sql).toContain("'$.last_seen_on_trending_at', ?");
    expect(upsert?.sql).not.toMatch(/scraped_at\s*=\s*excluded\.scraped_at/);
    expect(upsert?.binds.at(-2)).toBe(1_784_005_200);
    expect(result).toMatchObject({ parsed: 1, inserted: 0, updated_seen: 1, errors: 0 });
  });
});
