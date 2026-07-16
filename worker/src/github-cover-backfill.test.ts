import fs from 'node:fs';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { describe, expect, test } from 'vitest';

import { runGithubCoverBackfill, type GithubEnv } from './github';

type Call = { sql: string; bound: unknown[] };

function fakeEnv(
  rows: Array<Record<string, unknown>>,
  remaining = rows.length,
  writeChanges = 1,
): {
  env: GithubEnv;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    env: {
      DB: {
        prepare(sql: string) {
          const call: Call = { sql, bound: [] };
          calls.push(call);
          const statement = {
            bind: (...bound: unknown[]) => {
              call.bound = bound;
              return statement;
            },
            all: async () => ({ results: rows }),
            first: async () => ({ n: remaining }),
            run: async () => ({ success: true, meta: { changes: writeChanges } }),
          };
          return statement;
        },
      },
    } as unknown as GithubEnv,
    calls,
  };
}

const candidates = [
  {
    id: 'github:octo/with-cover',
    source_id: 'octo/with-cover',
    title: 'octo/with-cover',
    default_branch: 'main',
    readme_excerpt: '# Demo\n![hero](./docs/hero.png)',
    original_extra: '{"workflow_completed_at":1}',
    cover_url: null,
  },
  {
    id: 'github:octo/no-cover',
    source_id: 'octo/no-cover',
    title: 'octo/no-cover',
    default_branch: 'main',
    readme_excerpt: '# Text only',
    original_extra: '{"workflow_completed_at":1}',
    cover_url: null,
  },
];

describe('GitHub cover backfill', () => {
  test('dry-run reports cover/none decisions and performs no writes', async () => {
    const { env, calls } = fakeEnv(candidates);
    const result = await runGithubCoverBackfill(env, {
      dryRun: true,
      limit: 50,
      afterId: 'github:cursor',
    });

    expect(result).toMatchObject({
      dry_run: true,
      candidates: 2,
      covers: 1,
      none: 1,
      would_update: 2,
      updated: 0,
      conflicts: 0,
      errors: 0,
      remaining: 2,
      complete: false,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0].sql).toMatch(/cover_url/);
    expect(calls[0].sql).toMatch(/cover_status/);
    expect(calls[0].sql).toMatch(/workflow_completed_at/);
    expect(calls[0].sql).toMatch(/\$\.sponsor/);
    expect(calls[0].bound).toEqual(['github:cursor', 50]);
  });

  test('approved write mode stores a cover URL or an explicit none marker', async () => {
    const { env, calls } = fakeEnv(candidates, 1);
    const result = await runGithubCoverBackfill(env, {
      dryRun: false,
      limit: 2,
    });

    expect(result).toMatchObject({
      dry_run: false,
      candidates: 2,
      covers: 1,
      none: 1,
      would_update: 2,
      updated: 2,
      conflicts: 0,
      errors: 0,
      remaining: 1,
      complete: false,
      next_cursor: 'github:octo/no-cover',
    });
    expect(calls).toHaveLength(4);
    expect(calls[1].sql).toMatch(/\$\.cover_url/);
    expect(calls[1].bound[0]).toBe(
      'https://raw.githubusercontent.com/octo/with-cover/main/docs/hero.png',
    );
    expect(calls[2].sql).toMatch(/\$\.cover_status/);
    expect(calls[2].bound).toEqual([
      'github:octo/no-cover',
      '{"workflow_completed_at":1}',
    ]);
  });

  test('an empty batch is the coverage-complete gate', async () => {
    const { env } = fakeEnv([], 0);
    const result = await runGithubCoverBackfill(env, { dryRun: true, limit: 25 });

    expect(result.complete).toBe(true);
    expect(result.next_cursor).toBeNull();
  });

  test('an invalid legacy cover is revalidated and falls back to README', async () => {
    const legacy = [{
      ...candidates[0],
      cover_url: 'javascript:alert(1)',
    }];
    const { env } = fakeEnv(legacy, 1);
    const result = await runGithubCoverBackfill(env, { dryRun: true, limit: 50 });

    expect(result.covers).toBe(1);
    expect(result.none).toBe(0);
  });

  test('a compare-and-swap conflict cannot advance the cursor or claim completion', async () => {
    const { env } = fakeEnv([candidates[0]], 1, 0);
    const result = await runGithubCoverBackfill(env, { dryRun: false, limit: 1 });

    expect(result.updated).toBe(0);
    expect(result.conflicts).toBe(1);
    expect(result.complete).toBe(false);
    expect(result.next_cursor).toBeNull();
  });

  test('on-demand refresh patches JSON fields instead of replacing concurrent cover state', () => {
    const source = fs.readFileSync(fileURLToPath(new NodeURL('./github.ts', import.meta.url)), 'utf8');
    const start = source.indexOf('export async function refreshGithubItem');
    const end = source.indexOf('export async function countGithubPending');
    const refresh = source.slice(start, end);

    expect(refresh).toMatch(/metrics\s*=\s*json_set/);
    expect(refresh).toMatch(/extra\s*=\s*json_set/);
    expect(refresh).not.toMatch(/SET metrics = \?, extra = \?/);
  });
});
