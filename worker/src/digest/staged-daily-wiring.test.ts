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

  test('manual v1 and staged repush routes only delegate to final-guarded build/push helpers', () => {
    const v1 = indexSource.slice(
      indexSource.indexOf("mode === 'daily-codex-push'"),
      indexSource.indexOf("mode === 'daily-codex-stage'"),
    );
    expect(v1).toContain('buildDailyCodexPayload(env, 8, dateParam)');
    expect(v1).toContain('pushDailyToCodex(env, 8, dateParam)');
    expect(v1).not.toContain('fetch(');

    const stagedStart = indexSource.indexOf("mode === 'daily-codex-stage'");
    const stagedEnd = indexSource.indexOf('\n  if (mode ===', stagedStart + 1);
    const staged = indexSource.slice(stagedStart, stagedEnd);
    expect(staged).toContain('buildStagedDailyCodexPayload(env, stage, { date })');
    expect(staged).toContain('pushDailyStageToCodex(env, stage, date');
    expect(staged).not.toContain('fetch(');
  });

  test('HK review proxy has a dedicated authenticated API route', () => {
    expect(indexSource).toContain("path === '/api/digest/daily-news-review'");
    expect(indexSource).toContain('handleDailyNewsReviewApi(request, env)');
    expect(indexSource).toContain('DAILY_NEWS_REVIEW_SECRET');
  });

  test('rescore auto-repair pushes tag their origin from the frozen batch review state', () => {
    const rescore = indexSource.slice(
      indexSource.indexOf("mode === 'daily-digest-rescore'"),
      indexSource.indexOf("mode === 'backfill-hf-paper-workflow'"),
    );
    expect(rescore).toContain("frozen.batch.human_reviewed ? 'review' as const : 'auto' as const");
    expect(rescore).toContain("pushDailyStageToCodex(env, 'editorial', date, { origin })");
    expect(rescore).toContain("pushDailyStageToCodex(env, 'finalize', date, { origin })");
  });
});
