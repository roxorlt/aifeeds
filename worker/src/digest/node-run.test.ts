import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class {},
  WorkflowEvent: class {},
  WorkflowStep: class {},
}));

vi.mock('./codex-push', () => ({
  getDailyStageState: vi.fn(),
  pushDailyStageToCodex: vi.fn(),
  pushDailyToCodex: vi.fn(),
}));

vi.mock('./pool-rebuild', () => ({
  rebuildDigestPoolSource: vi.fn(),
  rebuildDigestPoolStage: vi.fn(),
  rebuildDigestPoolSubject: vi.fn(),
}));

vi.mock('./daily-page-monitor', () => ({ runDailyPagePhase: vi.fn() }));
vi.mock('../notifier', () => ({ pushDeerAlert: vi.fn(async () => undefined) }));
vi.mock('./news-review', () => ({
  freezeNewsReviewBatchFromPool: vi.fn(),
  notifyNewsReviewBatch: vi.fn(),
}));

import type { Env } from '../index';
import {
  getDailyStageState,
  pushDailyStageToCodex,
  pushDailyToCodex,
} from './codex-push';
import {
  rebuildDigestPoolSource,
  rebuildDigestPoolStage,
  rebuildDigestPoolSubject,
} from './pool-rebuild';
import { runDailyPagePhase } from './daily-page-monitor';
import { pushDeerAlert } from '../notifier';
import { freezeNewsReviewBatchFromPool, notifyNewsReviewBatch } from './news-review';
import {
  routeDigestCronWorkflows,
  runDigestNodeWorkflow,
} from './node-run';

function makeStep() {
  return {
    do: vi.fn(async (...args: unknown[]) => {
      const fn = args.find((value) => typeof value === 'function') as () => Promise<unknown>;
      return fn();
    }),
  };
}

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    DAILY_STAGED_PUSH_ENABLED: '1',
    DAILY_PUSH_ENABLED: '1',
    DB: {
      prepare: vi.fn(() => ({
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({ results: [] }),
      })),
    },
    DIGEST_DELIVER_WORKFLOW: { create: vi.fn() },
    ...overrides,
  } as unknown as Env;
}

describe('staged daily cron routing', () => {
  test('routes BJT 06:30, 07:50 and 08:00 to date+stage workflow ids', () => {
    expect(routeDigestCronWorkflows(Date.parse('2026-07-20T22:30:00Z'), true)).toEqual([{
      id: 'digest-node-2026-07-21-08-foundation',
      params: { slotHourBjt: 8, date: '2026-07-21', dailyStage: 'foundation' },
    }]);
    expect(routeDigestCronWorkflows(Date.parse('2026-07-20T23:50:00Z'), true)).toEqual([{
      id: 'digest-node-2026-07-21-08-editorial',
      params: { slotHourBjt: 8, date: '2026-07-21', dailyStage: 'editorial' },
    }]);
    expect(routeDigestCronWorkflows(Date.parse('2026-07-21T00:00:00Z'), true)).toEqual([{
      id: 'digest-node-2026-07-21-08-papers',
      params: { slotHourBjt: 8, date: '2026-07-21', dailyStage: 'papers' },
    }]);
  });

  test('keeps legacy 08:00/12:00/17:00 nodes and suppresses early stages when staged mode is off', () => {
    expect(routeDigestCronWorkflows(Date.parse('2026-07-20T22:30:00Z'), false)).toEqual([]);
    expect(routeDigestCronWorkflows(Date.parse('2026-07-21T00:00:00Z'), false)).toEqual([{
      id: 'digest-node-2026-07-21-08',
      params: { slotHourBjt: 8, date: '2026-07-21' },
    }]);
    expect(routeDigestCronWorkflows(Date.parse('2026-07-21T04:00:00Z'), true)[0].params.slotHourBjt).toBe(12);
    expect(routeDigestCronWorkflows(Date.parse('2026-07-21T09:00:00Z'), true)[0].params.slotHourBjt).toBe(17);
  });
});

describe('staged 08:00 node run', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(rebuildDigestPoolStage).mockResolvedValue({
      slotKey: '2026-07-21-08', date: '2026-07-21', slotHourBjt: 8, stage: 'papers', sources: [], subject: '标题',
    } as never);
    vi.mocked(rebuildDigestPoolSource).mockResolvedValue({ candidates: 1 } as never);
    vi.mocked(rebuildDigestPoolSubject).mockResolvedValue('标题');
    vi.mocked(pushDailyStageToCodex).mockResolvedValue({ ok: true } as never);
    vi.mocked(pushDailyToCodex).mockResolvedValue({ ok: true } as never);
    vi.mocked(freezeNewsReviewBatchFromPool).mockResolvedValue({
      created: true,
      superseded_batch_id: null,
      batch: { batch_id: 'nr-20260721-abcdef123456' },
    } as never);
    vi.mocked(notifyNewsReviewBatch).mockResolvedValue({ notified: true, review_url: 'https://example.test/review' });
  });

  test('07:50 freezes and notifies the top ten before pushing the default editorial stage', async () => {
    const env = makeEnv({ DAILY_NEWS_REVIEW_ENABLED: '1' });

    await runDigestNodeWorkflow(
      env,
      { slotHourBjt: 8, date: '2026-07-21', dailyStage: 'editorial' },
      makeStep() as never,
    );

    expect(freezeNewsReviewBatchFromPool).toHaveBeenCalledWith(env, '2026-07-21');
    expect(notifyNewsReviewBatch).toHaveBeenCalledWith(env, expect.objectContaining({
      batch_id: 'nr-20260721-abcdef123456',
    }));
    expect(vi.mocked(notifyNewsReviewBatch).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(pushDailyStageToCodex).mock.invocationCallOrder[0]);
  });

  test('uses locked foundation/editorial snapshots and rebuilds papers only', async () => {
    vi.mocked(getDailyStageState).mockImplementation(async (_env, _date, stage) => ({
      stage,
      revision: 1,
      content_hash: `sha256:${stage}`,
      pushed_at: 123,
    } as never));

    await runDigestNodeWorkflow(
      makeEnv(),
      { slotHourBjt: 8, date: '2026-07-21', dailyStage: 'papers' },
      makeStep() as never,
    );

    expect(rebuildDigestPoolStage).toHaveBeenCalledTimes(1);
    expect(rebuildDigestPoolStage).toHaveBeenCalledWith(expect.anything(), {
      date: '2026-07-21', stage: 'papers',
    });
    expect(rebuildDigestPoolSource).not.toHaveBeenCalled();
    expect(pushDailyStageToCodex).toHaveBeenCalledTimes(2);
    expect(vi.mocked(pushDailyStageToCodex).mock.calls.map((call) => call[1])).toEqual(['papers', 'finalize']);
    expect(pushDailyToCodex).not.toHaveBeenCalled();
  });

  test('08:00 scheduled finalize surfaces a stale locked manual editorial snapshot and retries fail closed', async () => {
    vi.mocked(getDailyStageState).mockImplementation(async (_env, _date, stage) => ({
      stage, revision: 1, content_hash: `sha256:${stage}`, pushed_at: 123,
    } as never));
    vi.mocked(pushDailyStageToCodex).mockImplementation(async (_env, stage) => (
      stage === 'finalize'
        ? { ok: false, stage, error: 'manual_news_finalize_snapshot_stale' }
        : { ok: true, stage }
    ) as never);

    await expect(runDigestNodeWorkflow(
      makeEnv(),
      { slotHourBjt: 8, date: '2026-07-21', dailyStage: 'papers' },
      makeStep() as never,
    )).rejects.toThrow('daily_stage_push_failed:finalize:manual_news_finalize_snapshot_stale');
    expect(vi.mocked(pushDailyStageToCodex).mock.calls.map((call) => call[1])).toEqual(['papers', 'finalize']);
  });

  test('actively rebuilds and pushes a missing prior batch before papers/finalize', async () => {
    vi.mocked(getDailyStageState).mockImplementation(async (_env, _date, stage) => (
      stage === 'foundation'
        ? null
        : { stage, revision: 1, content_hash: `sha256:${stage}`, pushed_at: 123 } as never
    ));

    await runDigestNodeWorkflow(
      makeEnv(),
      { slotHourBjt: 8, date: '2026-07-21', dailyStage: 'papers' },
      makeStep() as never,
    );

    expect(vi.mocked(rebuildDigestPoolStage).mock.calls.map((call) => call[1].stage)).toEqual([
      'foundation', 'papers',
    ]);
    expect(vi.mocked(pushDailyStageToCodex).mock.calls.map((call) => call[1])).toEqual([
      'foundation', 'papers', 'finalize',
    ]);
  });

  test('retains the legacy full rebuild and v1 push while staged mode is disabled', async () => {
    await runDigestNodeWorkflow(
      makeEnv({ DAILY_STAGED_PUSH_ENABLED: '0' }),
      { slotHourBjt: 8, date: '2026-07-21' },
      makeStep() as never,
    );

    expect(rebuildDigestPoolStage).not.toHaveBeenCalled();
    expect(rebuildDigestPoolSource).toHaveBeenCalled();
    expect(pushDailyToCodex).toHaveBeenCalledWith(expect.anything(), 8, '2026-07-21');
    expect(pushDailyStageToCodex).not.toHaveBeenCalled();
  });

  test('a queued early-stage workflow becomes a no-op if the staged rollout flag was disabled', async () => {
    const result = await runDigestNodeWorkflow(
      makeEnv({ DAILY_STAGED_PUSH_ENABLED: '0' }),
      { slotHourBjt: 8, date: '2026-07-21', dailyStage: 'foundation' },
      makeStep() as never,
    );

    expect(result.skipped).toBe('staged_disabled');
    expect(rebuildDigestPoolStage).not.toHaveBeenCalled();
    expect(rebuildDigestPoolSource).not.toHaveBeenCalled();
    expect(pushDailyToCodex).not.toHaveBeenCalled();
  });

  test('finishes email and SEO phases before surfacing an exhausted staged push failure', async () => {
    vi.mocked(getDailyStageState).mockResolvedValue(null);
    vi.mocked(pushDailyStageToCodex).mockResolvedValue({ ok: false, error: 'hk unavailable' } as never);
    const deliverCreate = vi.fn();
    const env = makeEnv({
      DAILY_PAGE_ENABLED: '1',
      DB: {
        prepare: vi.fn(() => ({
          bind: vi.fn().mockReturnThis(),
          all: vi.fn().mockResolvedValue({ results: [{ id: 7 }] }),
        })),
      },
      DIGEST_DELIVER_WORKFLOW: { create: deliverCreate },
    });

    await expect(runDigestNodeWorkflow(
      env,
      { slotHourBjt: 8, date: '2026-07-21', dailyStage: 'papers' },
      makeStep() as never,
    )).rejects.toThrow('daily_stage_push_failed:foundation');

    expect(deliverCreate).toHaveBeenCalled();
    expect(runDailyPagePhase).toHaveBeenCalledWith(env, '2026-07-21');
    expect(pushDeerAlert).toHaveBeenCalledWith(
      env,
      '分批日报 Workflow 失败',
      expect.stringContaining('2026-07-21 papers'),
    );
  });

  test('keeps legacy v1 push failure non-blocking for rollback compatibility', async () => {
    vi.mocked(pushDailyToCodex).mockResolvedValue({ ok: false, error: 'legacy endpoint down' });
    const env = makeEnv({ DAILY_STAGED_PUSH_ENABLED: '0', DAILY_PAGE_ENABLED: '1' });

    await expect(runDigestNodeWorkflow(
      env,
      { slotHourBjt: 8, date: '2026-07-21' },
      makeStep() as never,
    )).resolves.toMatchObject({ slotKey: '2026-07-21-08' });
    expect(runDailyPagePhase).toHaveBeenCalledWith(env, '2026-07-21');
  });
});
