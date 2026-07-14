import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { classifyGithubItemWithLlm, runGithubFetchTrending } from './github';

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

describe('GitHub workflow classification quality gate', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('invalid/null LLM result is recorded and thrown so Workflow retries instead of treating it as irrelevant', async () => {
    const writes: Array<{ sql: string; binds: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        let binds: unknown[] = [];
        const statement = {
          bind(...args: unknown[]) {
            binds = args;
            return statement;
          },
          async first<T>() {
            if (/SELECT extra FROM items/i.test(sql)) return { extra: '{}' } as T;
            return null as T | null;
          },
          async run() {
            writes.push({ sql, binds: [...binds] });
            return { success: true };
          },
        };
        return statement;
      },
    };

    await expect(classifyGithubItemWithLlm(
      { DB: db as unknown as D1Database },
      'github:owner/repo',
      {
        ownerRepo: 'owner/repo', owner: 'owner', repo: 'repo',
        description: 'AI repo', language: 'TypeScript', totalStars: 100,
        todayStars: 10, readme: '# repo', defaultBranch: 'main',
      },
    )).rejects.toThrow(/classification unresolved/);

    expect(writes).toHaveLength(1);
    expect(writes[0].sql).toContain('classification_failed_at');
    expect(writes[0].sql).toContain('classification_failure_count');
    expect(writes[0].sql).not.toContain('SET is_relevant');
  });

  test('a valid retry persists the classification and clears transient failure markers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      choices: [{ message: { content: JSON.stringify({
        is_ai: 1,
        ai_category: 'tool',
        ai_summary: '面向 AI 开发者的工具。',
      }) } }],
    })));
    const writes: Array<{ sql: string; binds: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        let binds: unknown[] = [];
        const statement = {
          bind(...args: unknown[]) { binds = args; return statement; },
          async first<T>() {
            return {
              extra: JSON.stringify({
                gh_pending: true,
                classification_failed_at: '2026-07-14T00:00:00.000Z',
                classification_failure_reason: 'llm_result_missing_or_invalid',
                classification_failure_count: 2,
              }),
            } as T;
          },
          async run() { writes.push({ sql, binds: [...binds] }); return { success: true }; },
        };
        return statement;
      },
    };

    const result = await classifyGithubItemWithLlm(
      { DB: db as unknown as D1Database, DEEPSEEK_API_KEY: 'test-key' },
      'github:owner/repo',
      {
        ownerRepo: 'owner/repo', owner: 'owner', repo: 'repo',
        description: 'AI repo', language: 'TypeScript', totalStars: 100,
        todayStars: 10, readme: '# repo', defaultBranch: 'main',
      },
    );

    expect(result).toEqual({ is_relevant: 1 });
    expect(writes).toHaveLength(1);
    expect(writes[0].binds[0]).toBe(1);
    const savedExtra = JSON.parse(String(writes[0].binds[1]));
    expect(savedExtra.gh_pending).toBe(false);
    expect(savedExtra.classification_failed_at).toBeUndefined();
    expect(savedExtra.classification_failure_reason).toBeUndefined();
    expect(savedExtra.classification_failure_count).toBe(2);
  });
});
