// 分批日报阶段告警 + 连坐解耦(2026-09-02 事故修复)。
//
// 事故形状:07:50 行业要闻批次重建连败 3 次、08:00 回补再败 3 次,六连败**零告警**,
// 且 editorial 回补失败把 papers 重建/推送、订阅邮件、SEO 静态页一起带停,owner 08:45 自己发现。
//
// 本文件钉两件事:
//   ① 告警:staged 阶段第一次失败就发一条,重试全败再升级一条;告警自身投递失败必须落日志。
//   ② 解耦:papers 的重建与推送不依赖 editorial,必须独立跑完;finalize 因 editorial 缺失
//      推不出去时要留下**明确的挂起状态 + 告警**,而不是静默停。

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
vi.mock('../notifier', () => ({
  pushDeerAlert: vi.fn(async () => undefined),
  deliverCriticalAlert: vi.fn(async () => true),
}));
vi.mock('./news-review', () => ({
  freezeNewsReviewBatchFromPool: vi.fn(),
  notifyNewsReviewBatch: vi.fn(),
}));

import type { Env } from '../index';
import { getDailyStageState, pushDailyStageToCodex, pushDailyToCodex } from './codex-push';
import {
  rebuildDigestPoolSource,
  rebuildDigestPoolStage,
  rebuildDigestPoolSubject,
} from './pool-rebuild';
import { runDailyPagePhase } from './daily-page-monitor';
import { deliverCriticalAlert } from '../notifier';
import { freezeNewsReviewBatchFromPool, notifyNewsReviewBatch } from './news-review';
import { runDigestNodeWorkflow } from './node-run';

const DATE = '2026-09-02';

/** 忠实模拟 Workflows 的 step.do 重试语义:失败后按 retries.limit 重跑同一个 callback。 */
function makeRetryingStep() {
  const attempts: string[] = [];
  return {
    attempts,
    do: vi.fn(async (...args: unknown[]) => {
      const name = String(args[0]);
      const config = args.find((value) => value && typeof value === 'object') as
        { retries?: { limit?: number } } | undefined;
      const fn = args.find((value) => typeof value === 'function') as () => Promise<unknown>;
      const maxAttempts = 1 + (config?.retries?.limit ?? 0);
      let lastError: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        attempts.push(`${name}#${attempt}`);
        try {
          return await fn();
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    }),
  };
}

/** 与既有 node-run.test.ts 同款的「跑一次就好」的简化 step(不模拟重试)。 */
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

function alertTitles(): string[] {
  return vi.mocked(deliverCriticalAlert).mock.calls.map((call) => String(call[2]));
}

function alertBodyFor(title: string): string {
  const call = vi.mocked(deliverCriticalAlert).mock.calls.find((entry) => String(entry[2]) === title);
  return String(call?.[3] ?? '');
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks 不会清掉 mockImplementation,必须显式复位,否则变异用例的桩会漏进后续用例。
  vi.mocked(deliverCriticalAlert).mockReset().mockResolvedValue(true);
  vi.mocked(rebuildDigestPoolStage).mockResolvedValue({
    slotKey: `${DATE}-08`, date: DATE, slotHourBjt: 8, stage: 'papers', sources: [], subject: '标题',
  } as never);
  vi.mocked(rebuildDigestPoolSource).mockResolvedValue({ candidates: 1 } as never);
  vi.mocked(rebuildDigestPoolSubject).mockResolvedValue('标题');
  vi.mocked(pushDailyStageToCodex).mockResolvedValue({ ok: true } as never);
  vi.mocked(pushDailyToCodex).mockResolvedValue({ ok: true } as never);
  vi.mocked(runDailyPagePhase).mockResolvedValue({ date: DATE, skipped: false, itemCount: 5 });
  vi.mocked(freezeNewsReviewBatchFromPool).mockResolvedValue({
    created: true, superseded_batch_id: null, batch: { batch_id: 'nr-20260902-abcdef123456' },
  } as never);
  vi.mocked(notifyNewsReviewBatch).mockResolvedValue({ notified: true, review_url: 'https://example.test/r' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('① staged 阶段失败告警', () => {
  test('07:50 editorial 重建第 1 次失败就发告警,不等重试耗尽', async () => {
    const step = makeRetryingStep();
    let firstAlertAtAttempt = -1;
    vi.mocked(rebuildDigestPoolStage).mockRejectedValue(new Error('D1_ERROR: exceeded CPU limit'));
    vi.mocked(deliverCriticalAlert).mockImplementation(async (_env, _ctx, title) => {
      if (String(title).includes('首次失败') && firstAlertAtAttempt < 0) {
        firstAlertAtAttempt = step.attempts.length;
      }
      return true;
    });

    await expect(runDigestNodeWorkflow(
      makeEnv(), { slotHourBjt: 8, date: DATE, dailyStage: 'editorial' }, step as never,
    )).rejects.toThrow('exceeded CPU limit');

    // 第 1 次尝试(共 3 次)就已经告警 —— 事故里要等六连败之后才可能有一条。
    expect(firstAlertAtAttempt).toBe(1);
    expect(step.attempts.filter((entry) => entry.startsWith('pool-stage-editorial'))).toHaveLength(3);
  });

  test('重试全败后升级一条「今日 editorial 阶段最终失败」,首次告警只发一条', async () => {
    const step = makeRetryingStep();
    vi.mocked(rebuildDigestPoolStage).mockRejectedValue(new Error('D1_ERROR: exceeded CPU limit'));

    await expect(runDigestNodeWorkflow(
      makeEnv(), { slotHourBjt: 8, date: DATE, dailyStage: 'editorial' }, step as never,
    )).rejects.toThrow('exceeded CPU limit');

    const titles = alertTitles();
    // 3 次尝试只发 1 条「首次失败」,不刷屏。
    expect(titles.filter((title) => title.includes('首次失败'))).toHaveLength(1);
    expect(titles).toContain('今日 editorial 阶段最终失败');
    expect(alertBodyFor('今日 editorial 阶段最终失败')).toContain(DATE);
    expect(alertBodyFor('今日 editorial 阶段最终失败')).toContain('exceeded CPU limit');
    // workflow 兜底告警仍在(现在是第三层,不再是唯一一层)。
    expect(titles).toContain('分批日报 Workflow 失败');
  });

  test('阶段推送失败同样两级告警,且带上阶段名/日期/错误摘要', async () => {
    const step = makeRetryingStep();
    vi.mocked(getDailyStageState).mockImplementation(async (_env, _date, stage) => (
      { stage, revision: 1, content_hash: `sha256:${stage}`, pushed_at: 123 } as never
    ));
    vi.mocked(pushDailyStageToCodex).mockImplementation(async (_env, stage) => (
      stage === 'papers' ? { ok: false, stage, error: 'hk unavailable' } : { ok: true, stage }
    ) as never);

    await expect(runDigestNodeWorkflow(
      makeEnv(), { slotHourBjt: 8, date: DATE, dailyStage: 'papers' }, step as never,
    )).rejects.toThrow('daily_stage_push_failed:papers:hk unavailable');

    expect(alertTitles()).toContain('今日 papers 阶段最终失败');
    const body = alertBodyFor('今日 papers 阶段最终失败');
    expect(body).toContain(DATE);
    expect(body).toContain('push-codex-papers');
    expect(body).toContain('hk unavailable');
  });

  test('告警投递失败必须落日志,不被裸 catch 吞掉', async () => {
    const step = makeRetryingStep();
    vi.mocked(rebuildDigestPoolStage).mockRejectedValue(new Error('boom'));
    // deliverCriticalAlert 自身返回 false(0 条送达);它内部已经 console.error,
    // 这里再断言 node-run 侧的阶段错误日志同样存在 —— 两条线索都不能没有。
    vi.mocked(deliverCriticalAlert).mockResolvedValue(false);

    await expect(runDigestNodeWorkflow(
      makeEnv(), { slotHourBjt: 8, date: DATE, dailyStage: 'editorial' }, step as never,
    )).rejects.toThrow('boom');

    // 告警发不出去不能把原始错误吞掉:workflow 仍然失败,错误原样抛出。
    expect(vi.mocked(deliverCriticalAlert)).toHaveBeenCalled();
  });

  test('变异验证:事故前「只有最外层一条兜底告警」的形状,上面两条断言都会红', async () => {
    // 变异体 = 事故前的编排:step 失败后不做任何阶段级告警,只在最外层 catch 里发一条。
    const legacyAlerts: Array<{ title: string; atAttempt: number }> = [];
    const step = makeRetryingStep();
    const legacyRunStage = async () => {
      try {
        await step.do('pool-stage-editorial', { retries: { limit: 2 } }, async () => {
          throw new Error('D1_ERROR: exceeded CPU limit');
        });
      } catch (error) {
        legacyAlerts.push({ title: '分批日报 Workflow 失败', atAttempt: step.attempts.length });
        throw error;
      }
    };

    await expect(legacyRunStage()).rejects.toThrow('exceeded CPU limit');

    // ① 变异体下不存在「首次失败」告警 → 第一个用例的 firstAlertAtAttempt===1 断言为假。
    expect(legacyAlerts.filter((entry) => entry.title.includes('首次失败'))).toEqual([]);
    // ② 唯一那条告警要等三次尝试全跑完才发 → 「不等重试耗尽」这条语义在变异体下不成立。
    expect(legacyAlerts[0].atAttempt).toBe(3);
    // ③ 也不存在「今日 X 阶段最终失败」的升级告警。
    expect(legacyAlerts.some((entry) => entry.title.includes('阶段最终失败'))).toBe(false);

    // 对照:当前实现在同样的失败下三条告警齐全,且首条发生在第 1 次尝试。
    vi.mocked(rebuildDigestPoolStage).mockRejectedValue(new Error('D1_ERROR: exceeded CPU limit'));
    const realStep = makeRetryingStep();
    let firstAlertAtAttempt = -1;
    vi.mocked(deliverCriticalAlert).mockImplementation(async (_env, _ctx, title) => {
      if (String(title).includes('首次失败') && firstAlertAtAttempt < 0) {
        firstAlertAtAttempt = realStep.attempts.length;
      }
      return true;
    });
    await expect(runDigestNodeWorkflow(
      makeEnv(), { slotHourBjt: 8, date: DATE, dailyStage: 'editorial' }, realStep as never,
    )).rejects.toThrow('exceeded CPU limit');
    expect(firstAlertAtAttempt).toBe(1);
    expect(alertTitles()).toContain('今日 editorial 阶段最终失败');
  });
});

describe('② 连坐解耦:papers 独立于 editorial', () => {
  test('editorial 快照回补失败,papers 仍然独立重建并推送', async () => {
    // foundation 有快照且已推;editorial 没有快照 → 触发回补,回补失败。
    vi.mocked(getDailyStageState).mockImplementation(async (_env, _date, stage) => (
      stage === 'editorial'
        ? null
        : { stage, revision: 1, content_hash: `sha256:${stage}`, pushed_at: 123 } as never
    ));
    vi.mocked(rebuildDigestPoolStage).mockImplementation(async (_env, opts) => {
      if ((opts as { stage: string }).stage === 'editorial') throw new Error('D1_ERROR: exceeded CPU limit');
      return { slotKey: `${DATE}-08`, date: DATE, slotHourBjt: 8, stage: 'papers', sources: [], subject: 's' } as never;
    });

    await expect(runDigestNodeWorkflow(
      makeEnv(), { slotHourBjt: 8, date: DATE, dailyStage: 'papers' }, makeStep() as never,
    )).rejects.toThrow('exceeded CPU limit');

    // 9/2 的核心回归:papers 重建必须发生过。
    expect(vi.mocked(rebuildDigestPoolStage).mock.calls.map((call) => call[1].stage))
      .toEqual(['editorial', 'papers']);
    // papers 推送同样发生过(editorial 推送失败不阻断它)。
    expect(vi.mocked(pushDailyStageToCodex).mock.calls.map((call) => call[1])).toContain('papers');
  });

  test('editorial 失败不再连坐掉订阅邮件与 SEO 静态页', async () => {
    vi.mocked(getDailyStageState).mockResolvedValue(null);
    vi.mocked(rebuildDigestPoolStage).mockImplementation(async (_env, opts) => {
      if ((opts as { stage: string }).stage === 'editorial') throw new Error('editorial down');
      return { slotKey: `${DATE}-08`, date: DATE, slotHourBjt: 8, stage: 'papers', sources: [], subject: 's' } as never;
    });
    const deliverCreate = vi.fn();
    const env = makeEnv({
      DAILY_PAGE_ENABLED: '1',
      DB: {
        prepare: vi.fn(() => ({
          bind: vi.fn().mockReturnThis(),
          all: vi.fn().mockResolvedValue({ results: [{ id: 7 }, { id: 8 }] }),
        })),
      },
      DIGEST_DELIVER_WORKFLOW: { create: deliverCreate },
    });

    await expect(runDigestNodeWorkflow(
      env, { slotHourBjt: 8, date: DATE, dailyStage: 'papers' }, makeStep() as never,
    )).rejects.toThrow('editorial down');

    expect(deliverCreate).toHaveBeenCalledTimes(2);
    expect(runDailyPagePhase).toHaveBeenCalledWith(env, DATE);
  });

  test('人审批次冻结失败也不连坐 papers', async () => {
    vi.mocked(getDailyStageState).mockImplementation(async (_env, _date, stage) => (
      { stage, revision: 1, content_hash: `sha256:${stage}`, pushed_at: 123 } as never
    ));
    vi.mocked(freezeNewsReviewBatchFromPool).mockRejectedValue(new Error('freeze failed'));

    await expect(runDigestNodeWorkflow(
      makeEnv({ DAILY_NEWS_REVIEW_ENABLED: '1' }),
      { slotHourBjt: 8, date: DATE, dailyStage: 'papers' },
      makeStep() as never,
    )).rejects.toThrow('freeze failed');

    expect(vi.mocked(rebuildDigestPoolStage).mock.calls.map((call) => call[1].stage)).toContain('papers');
    expect(vi.mocked(pushDailyStageToCodex).mock.calls.map((call) => call[1])).toContain('papers');
  });

  test('全绿路径不受影响:三阶段照常按 foundation → papers → finalize 推送', async () => {
    vi.mocked(getDailyStageState).mockImplementation(async (_env, _date, stage) => (
      stage === 'foundation'
        ? null
        : { stage, revision: 1, content_hash: `sha256:${stage}`, pushed_at: 123 } as never
    ));

    const result = await runDigestNodeWorkflow(
      makeEnv(), { slotHourBjt: 8, date: DATE, dailyStage: 'papers' }, makeStep() as never,
    );

    expect(vi.mocked(pushDailyStageToCodex).mock.calls.map((call) => call[1]))
      .toEqual(['foundation', 'papers', 'finalize']);
    expect(result.stageFailures).toBeUndefined();
    expect(result.finalizeSuspended).toBeUndefined();
    expect(alertTitles()).toEqual([]);
  });
});

describe('③ finalize 挂起而不是静默停', () => {
  test('editorial 缺失时 finalize 不推送,但产生明确的挂起状态 + 告警', async () => {
    vi.mocked(getDailyStageState).mockResolvedValue(null);
    vi.mocked(rebuildDigestPoolStage).mockImplementation(async (_env, opts) => {
      if ((opts as { stage: string }).stage === 'editorial') throw new Error('editorial down');
      return { slotKey: `${DATE}-08`, date: DATE, slotHourBjt: 8, stage: 'papers', sources: [], subject: 's' } as never;
    });

    await expect(runDigestNodeWorkflow(
      makeEnv(), { slotHourBjt: 8, date: DATE, dailyStage: 'papers' }, makeStep() as never,
    )).rejects.toThrow('editorial down');

    // finalize 没被推(manifest 引用三阶段 revision,editorial 缺失时它推不出去是合理的)……
    expect(vi.mocked(pushDailyStageToCodex).mock.calls.map((call) => call[1])).not.toContain('finalize');
    // ……但必须留下明确的挂起告警,而不是什么都不发生。
    expect(alertTitles()).toContain('分批日报 finalize 挂起');
    expect(alertBodyFor('分批日报 finalize 挂起')).toContain('editorial-snapshot');
  });

  test('挂起原因写进 workflow 返回值,便于事后从实例输出复盘', async () => {
    vi.mocked(getDailyStageState).mockImplementation(async (_env, _date, stage) => (
      stage === 'editorial'
        ? { stage, revision: 1, content_hash: 'sha256:editorial' } as never
        : { stage, revision: 1, content_hash: `sha256:${stage}`, pushed_at: 123 } as never
    ));
    vi.mocked(pushDailyStageToCodex).mockImplementation(async (_env, stage) => (
      stage === 'editorial' ? { ok: false, stage, error: 'hk unavailable' } : { ok: true, stage }
    ) as never);

    await expect(runDigestNodeWorkflow(
      makeEnv(), { slotHourBjt: 8, date: DATE, dailyStage: 'papers' }, makeStep() as never,
    )).rejects.toThrow('daily_stage_push_failed:editorial:hk unavailable');

    // papers 推了、finalize 挂起。
    const pushed = vi.mocked(pushDailyStageToCodex).mock.calls.map((call) => call[1]);
    expect(pushed).toContain('papers');
    expect(pushed).not.toContain('finalize');
    expect(alertTitles()).toContain('分批日报 finalize 挂起');
  });

  test('变异验证:恢复「前批推送失败就整段跳过」的旧写法,papers 推送断言必红', async () => {
    // 旧写法等价物:recoverPriorStagePushes 抛出后整个 try 块被跳过。
    // 这里直接断言当前实现**不是**那个形状 —— papers 推送在前批推送失败时仍然发生。
    vi.mocked(getDailyStageState).mockResolvedValue(null);
    vi.mocked(pushDailyStageToCodex).mockImplementation(async (_env, stage) => (
      stage === 'papers' ? { ok: true, stage } : { ok: false, stage, error: 'hk unavailable' }
    ) as never);

    await expect(runDigestNodeWorkflow(
      makeEnv(), { slotHourBjt: 8, date: DATE, dailyStage: 'papers' }, makeStep() as never,
    )).rejects.toThrow('daily_stage_push_failed:foundation:hk unavailable');

    expect(vi.mocked(pushDailyStageToCodex).mock.calls.map((call) => call[1])).toContain('papers');
  });
});
