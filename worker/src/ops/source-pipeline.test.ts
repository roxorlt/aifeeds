import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

const { triggerHfPaperWorkflowForItem } = vi.hoisted(() => ({
  triggerHfPaperWorkflowForItem: vi.fn(),
}));

vi.mock('../scrapers/hf-paper', () => ({ triggerHfPaperWorkflowForItem }));

import {
  drainGithubPending,
  drainHfPending,
  GITHUB_ELIGIBLE_READY_EXPR,
  GITHUB_STUCK_EXPR,
  HF_ELIGIBLE_READY_EXPR,
  getSourceReadiness,
} from './source-pipeline';
import { GITHUB_CANDIDATE_TIME_EXPR } from '../digest/selection';

type PendingRow = { id: string; extra: string | null };

function makeDb(input: {
  githubRows?: PendingRow[];
  hfRows?: PendingRow[];
  githubSummary?: Record<string, unknown>;
  hfSummary?: Record<string, unknown>;
}) {
  const captures: Array<{ sql: string; binds: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      const capture = { sql, binds: [] as unknown[] };
      captures.push(capture);
      const statement = {
        bind(...binds: unknown[]) {
          capture.binds = binds;
          return statement;
        },
        async all<T>() {
          const rows = sql.includes("source_type='github'")
            ? input.githubRows ?? []
            : input.hfRows ?? [];
          return { results: rows as T[] };
        },
        async first<T>() {
          const summary = sql.includes("source_type='github'")
            ? input.githubSummary
            : input.hfSummary;
          return (summary ?? null) as T | null;
        },
        async run() {
          return { meta: { changes: 1 } };
        },
      };
      return statement;
    },
  };
  return { db: db as unknown as D1Database, captures };
}

describe('bounded source workflow drains', () => {
  beforeEach(() => {
    triggerHfPaperWorkflowForItem.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test.each([
    {
      label: 'gh_pending=true',
      isRelevant: 1,
      extra: { gh_pending: true, workflow_completed_at: 'done', readme_excerpt: null },
      selected: true,
    },
    {
      label: 'legacy is_relevant NULL after gh_pending was cleared',
      isRelevant: null,
      extra: { gh_pending: false },
      selected: true,
    },
    {
      label: 'relevant README translation missing',
      isRelevant: 1,
      extra: { gh_pending: false, readme_excerpt: 'README', readme_lang: 'en', r2_migrated_at: 1 },
      selected: true,
    },
    {
      label: 'relevant README R2 migration missing',
      isRelevant: 1,
      extra: { gh_pending: false, readme_excerpt: 'README', readme_lang: 'zh' },
      selected: true,
    },
    {
      label: 'irrelevant terminal with missing README work',
      isRelevant: 0,
      extra: { gh_pending: false, readme_excerpt: 'README', readme_lang: 'en' },
      selected: false,
    },
  ])('GH stuck predicate selects $label = $selected', ({ isRelevant, extra, selected }) => {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec('CREATE TABLE items (id TEXT PRIMARY KEY, is_relevant INTEGER, extra TEXT)');
    sqlite.prepare('INSERT INTO items (id, is_relevant, extra) VALUES (?, ?, ?)')
      .run('github:test/repo', isRelevant, JSON.stringify(extra));

    const row = sqlite.prepare(`SELECT id FROM items WHERE ${GITHUB_STUCK_EXPR}`).get();

    expect(!!row).toBe(selected);
    sqlite.close();
  });

  test('uses the same expanded GH stuck predicate for readiness and picking', async () => {
    const { db, captures } = makeDb({
      githubRows: [],
      githubSummary: { pending: 0, ready: 0, oldest_scraped_at: null },
    });

    await drainGithubPending({ DB: db }, { limit: 1 });

    const summary = captures.find((entry) => entry.sql.includes(' AS pending'));
    const pick = captures.find((entry) => entry.sql.includes('ORDER BY'));
    expect(summary?.sql).toContain(GITHUB_STUCK_EXPR);
    expect(summary?.sql).toContain(`NOT ${GITHUB_STUCK_EXPR}`);
    expect(pick?.sql).toContain(GITHUB_STUCK_EXPR);
  });

  test.each([
    {
      label: 'expired GH completion',
      expression: () => GITHUB_ELIGIBLE_READY_EXPR,
      scrapedAt: '2000-01-01T00:00:00.000Z',
      isRelevant: 1,
      extra: {
        gh_pending: false,
        workflow_completed_at: '2000-01-01T01:00:00.000Z',
        last_seen_on_trending_at: 946_684_800,
      },
      expected: false,
    },
    {
      label: 'current GH completion',
      expression: () => GITHUB_ELIGIBLE_READY_EXPR,
      scrapedAt: new Date().toISOString(),
      isRelevant: 1,
      extra: {
        gh_pending: false,
        workflow_completed_at: new Date().toISOString(),
        last_seen_on_trending_at: Math.floor(Date.now() / 1000),
      },
      expected: true,
    },
    {
      label: 'expired HF completion',
      expression: () => HF_ELIGIBLE_READY_EXPR,
      scrapedAt: '2000-01-01T00:00:00.000Z',
      isRelevant: 1,
      extra: { workflow_completed_at: '2000-01-01T01:00:00.000Z', ai_summary_zh: '摘要' },
      expected: false,
    },
    {
      label: 'current HF completion',
      expression: () => HF_ELIGIBLE_READY_EXPR,
      scrapedAt: new Date().toISOString(),
      isRelevant: 1,
      extra: { workflow_completed_at: new Date().toISOString(), ai_summary_zh: '摘要' },
      expected: true,
    },
  ])('$label contributes to eligible ready = $expected', ({ expression, scrapedAt, isRelevant, extra, expected }) => {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(`CREATE TABLE items (
      id TEXT PRIMARY KEY,
      scraped_at TEXT,
      is_relevant INTEGER,
      extra TEXT
    )`);
    sqlite.prepare('INSERT INTO items (id, scraped_at, is_relevant, extra) VALUES (?, ?, ?, ?)')
      .run('item:test', scrapedAt, isRelevant, JSON.stringify(extra));

    const row = sqlite.prepare(`SELECT id FROM items WHERE ${expression()}`).get();

    expect(!!row).toBe(expected);
    sqlite.close();
  });

  test('readiness SQL reuses digest GH time and exposes eligible ready for both sources', async () => {
    const { db, captures } = makeDb({
      githubSummary: { pending: 0, ready: 0, oldest_scraped_at: null },
      hfSummary: { pending: 0, ready: 0, oldest_scraped_at: null },
    });

    const readiness = await getSourceReadiness({ DB: db });

    const ghSummary = captures.find((entry) => entry.sql.includes("source_type='github'"));
    const hfSummary = captures.find((entry) => entry.sql.includes("source_type='hf_paper'"));
    expect(GITHUB_ELIGIBLE_READY_EXPR).toContain(GITHUB_CANDIDATE_TIME_EXPR);
    expect(ghSummary?.sql).toContain(GITHUB_ELIGIBLE_READY_EXPR);
    expect(hfSummary?.sql).toContain(HF_ELIGIBLE_READY_EXPR);
    expect(readiness.github).toMatchObject({ ready: 0, eligibleReady: 0 });
    expect(readiness.hfPaper).toMatchObject({ ready: 0, eligibleReady: 0 });
  });

  test('drains GitHub gh_pending oldest-first, bounded, and leaves failed rows retryable', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-14T00:00:00.000Z'));
    const { db, captures } = makeDb({
      githubRows: [
        { id: 'github:old/repo', extra: '{"gh_pending":true}' },
        { id: 'github:new/repo', extra: '{"gh_pending":true}' },
      ],
      githubSummary: {
        pending: 3,
        ready: 7,
        oldest_scraped_at: '2026-07-12T00:00:00.000Z',
      },
    });
    const create = vi.fn(async ({ params }: { params: { itemId: string } }) => {
      if (params.itemId === 'github:old/repo') throw new Error('temporary create failure');
      return { id: params.itemId };
    });

    const result = await drainGithubPending(
      { DB: db, GITHUB_PIPELINE_WORKFLOW: { create } as unknown as Workflow },
      { limit: 2, retryAfterSeconds: 1 },
    );

    const pick = captures.find((entry) => entry.sql.includes('ORDER BY'));
    expect(pick?.sql).toContain("COALESCE(json_extract(extra, '$.gh_pending'), 0) IN (1, 'true')");
    expect(pick?.sql).toContain('ORDER BY datetime(scraped_at) ASC, id ASC');
    expect(pick?.binds[0]).toBe(1_783_983_600);
    expect(pick?.binds.at(-1)).toBe(2);
    expect(create.mock.calls.map(([arg]) => arg.params.itemId)).toEqual([
      'github:old/repo',
      'github:new/repo',
    ]);
    expect(result).toEqual({
      source: 'github',
      picked: 2,
      started: 1,
      skipped: 0,
      alreadyExists: 0,
      retryable: 1,
      failed: 1,
      pending: 3,
      ready: 7,
      eligibleReady: 7,
      oldestAge: 172_800,
    });
    expect(captures.some((entry) => /gh_pending[^\n]*false/.test(entry.sql))).toBe(false);
  });

  test('does not treat already_exists as complete and retries GH with a new hour generation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-14T00:10:00.000Z'));
    const { db } = makeDb({
      githubRows: [{ id: 'github:stuck/repo', extra: '{"gh_pending":true}' }],
      githubSummary: { pending: 1, ready: 0, oldest_scraped_at: '2026-07-13T00:00:00.000Z' },
    });
    const instanceIds: string[] = [];
    const create = vi.fn(async ({ id }: { id: string }) => {
      instanceIds.push(id);
      if (instanceIds.length === 1) throw new Error('instance already exists');
      return { id };
    });
    const env = { DB: db, GITHUB_PIPELINE_WORKFLOW: { create } as unknown as Workflow };

    const collision = await drainGithubPending(env, { limit: 1 });
    expect(collision).toMatchObject({
      picked: 1,
      started: 0,
      skipped: 1,
      alreadyExists: 1,
      retryable: 1,
      failed: 0,
      pending: 1,
      ready: 0,
    });

    vi.setSystemTime(new Date('2026-07-14T01:10:00.000Z'));
    const retried = await drainGithubPending(env, { limit: 1 });
    expect(retried).toMatchObject({ started: 1, alreadyExists: 0, retryable: 0 });
    expect(instanceIds).toEqual([
      'gh-github-stuck-repo-2026-07-14-00',
      'gh-github-stuck-repo-2026-07-14-01',
    ]);
  });

  test('drains HF workflow_completed_at NULL oldest-first and reuses row signals', async () => {
    const { db, captures } = makeDb({
      hfRows: [{
        id: 'hf_paper:2607.00001',
        extra: JSON.stringify({ github_repo: 'a/b', project_page: 'https://p', discussion_id: 'd1' }),
      }],
      hfSummary: { pending: 1, ready: 11, oldest_scraped_at: null },
    });
    triggerHfPaperWorkflowForItem.mockResolvedValue('triggered');

    const result = await drainHfPending(
      { DB: db, HF_PAPER_PIPELINE_WORKFLOW: {} as Workflow },
      { limit: 1 },
    );

    const pick = captures.find((entry) => entry.sql.includes('ORDER BY'));
    expect(pick?.sql).toContain("json_extract(extra, '$.workflow_completed_at') IS NULL");
    expect(pick?.sql).toContain('ORDER BY datetime(scraped_at) ASC, id ASC');
    expect(triggerHfPaperWorkflowForItem).toHaveBeenCalledWith(
      expect.objectContaining({ DB: db }),
      'hf_paper:2607.00001',
      '2607.00001',
      expect.objectContaining({
        hasGhRepo: true,
        hasProjectPage: true,
        hasDiscussionId: true,
      }),
    );
    expect(result).toMatchObject({ source: 'hf-paper', picked: 1, started: 1, failed: 0, ready: 11 });
    expect(captures.some((entry) => /UPDATE items[\s\S]*workflow_completed_at/.test(entry.sql))).toBe(false);
  });

  test('reports HF already_exists as incomplete and retryable, not started or ready', async () => {
    const { db } = makeDb({
      hfRows: [{ id: 'hf_paper:2607.00002', extra: '{}' }],
      hfSummary: { pending: 1, ready: 0, oldest_scraped_at: null },
    });
    triggerHfPaperWorkflowForItem.mockResolvedValue('already_exists');

    const result = await drainHfPending(
      { DB: db, HF_PAPER_PIPELINE_WORKFLOW: {} as Workflow },
      { limit: 1 },
    );

    expect(result).toMatchObject({
      picked: 1,
      started: 0,
      skipped: 1,
      alreadyExists: 1,
      retryable: 1,
      failed: 0,
      pending: 1,
      ready: 0,
    });
  });

  test('returns a pre-digest readiness snapshot without triggering workflows', async () => {
    const { db, captures } = makeDb({
      githubSummary: { pending: 2, ready: 8, oldest_scraped_at: '2026-07-13T22:00:00.000Z' },
      hfSummary: { pending: 4, ready: 20, oldest_scraped_at: '2026-07-13T20:00:00.000Z' },
    });

    const snapshot = await getSourceReadiness(
      { DB: db },
      new Date('2026-07-14T00:00:00.000Z'),
    );

    expect(snapshot).toEqual({
      github: { pending: 2, ready: 8, eligibleReady: 8, oldestAge: 7_200 },
      hfPaper: { pending: 4, ready: 20, eligibleReady: 20, oldestAge: 14_400 },
    });
    expect(captures).toHaveLength(2);
  });
});
