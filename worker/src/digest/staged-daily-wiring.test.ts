import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const indexSource = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../index.ts'), 'utf8');

describe('staged daily worker wiring', () => {
  test('scheduled handler delegates digest timing to the staged cron router', () => {
    expect(indexSource).toContain('routeDigestCronWorkflows');
    expect(indexSource).toContain('DAILY_STAGED_PUSH_ENABLED');
  });

  test('exposes a separate manual stage replay mode while retaining daily-codex-push', () => {
    expect(indexSource).toContain("mode === 'daily-codex-stage'");
    expect(indexSource).toContain("mode === 'daily-codex-push'");
  });

  test('HK review proxy has a dedicated authenticated API route', () => {
    expect(indexSource).toContain("path === '/api/digest/daily-news-review'");
    expect(indexSource).toContain('handleDailyNewsReviewApi(request, env)');
    expect(indexSource).toContain('DAILY_NEWS_REVIEW_SECRET');
  });
});
