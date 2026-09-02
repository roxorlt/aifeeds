// 分批日报阶段看门狗测试(2026-09-02 事故第二道防线)。
//
// 这道防线存在的唯一理由:node-run 里所有告警都活在**发生故障那次 workflow 自己的 isolate**里,
// 一旦故障不是可捕获的 Promise rejection(CPU 时间超限 / isolate 被回收 / OOM),
// 那些 catch 一行都不会跑,告警一条都发不出来 —— 9/2 六连败零告警就是这个形状。
// 看门狗跑在 cron 侧,不依赖任何失败路径能跑到。

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('./codex-push', () => ({ getDailyStageState: vi.fn() }));
vi.mock('../notifier', () => ({ deliverCriticalAlert: vi.fn(async () => true) }));

import type { Env } from '../index';
import { getDailyStageState } from './codex-push';
import { deliverCriticalAlert } from '../notifier';
import { checkStagedDailyStages, STAGED_STAGE_DEADLINES } from './staged-stage-monitor';

/** BJT 时刻 → UTC epoch ms(BJT = UTC+8)。 */
function bjt(dateIso: string, hour: number, minute: number): number {
  return Date.parse(`${dateIso}T00:00:00.000Z`) + (hour * 60 + minute - 8 * 60) * 60_000;
}

const DATE = '2026-09-02';
const AT_0800 = bjt(DATE, 8, 0);   // editorial 已过 due(07:50)+grace(10)
const AT_0750 = bjt(DATE, 7, 50);  // editorial 刚到点,还在宽限期内

function makeKv(store = new Map<string, string>()) {
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
  };
}

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    DAILY_STAGED_PUSH_ENABLED: '1',
    DAILY_PUSH_ENABLED: '1',
    AUTH_KV: makeKv(),
    ...overrides,
  } as unknown as Env;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(deliverCriticalAlert).mockReset().mockResolvedValue(true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('窗口与开关', () => {
  test('staged 模式关闭时直接跳过,不读 D1', async () => {
    const result = await checkStagedDailyStages(
      makeEnv({ DAILY_STAGED_PUSH_ENABLED: '0' }), AT_0800,
    );
    expect(result.skipped).toBe('staged_disabled');
    expect(getDailyStageState).not.toHaveBeenCalled();
  });

  test('阶段计划时刻 + 宽限期未到时不查也不告警', async () => {
    const result = await checkStagedDailyStages(makeEnv(), AT_0750);
    // 07:50 时 foundation(06:30+15)已到期,editorial(07:50+10)还没到。
    expect(result.checks.map((check) => check.stage)).toEqual(['foundation']);
  });

  test('窗口尾巴过去后不再反复查同一天', async () => {
    // BJT 14:00 距 finalize(08:25)已超过 240 分钟尾巴。
    const result = await checkStagedDailyStages(makeEnv(), bjt(DATE, 14, 0));
    expect(result.skipped).toBe('outside_window');
    expect(getDailyStageState).not.toHaveBeenCalled();
  });

  test('四个阶段的计划时刻与 routeDigestCronWorkflows 一致', () => {
    expect(STAGED_STAGE_DEADLINES.map((entry) => [entry.stage, entry.dueMinuteBjt])).toEqual([
      ['foundation', 6 * 60 + 30],
      ['editorial', 7 * 60 + 50],
      ['papers', 8 * 60],
      ['finalize', 8 * 60],
    ]);
  });
});

describe('缺失检测与告警', () => {
  test('editorial 快照缺失(9/2 的形状)→ BJT 08:00 就告警', async () => {
    vi.mocked(getDailyStageState).mockImplementation(async (_env, _date, stage) => (
      stage === 'editorial'
        ? null
        : { stage, revision: 1, content_hash: `sha256:${stage}`, pushed_at: 1 } as never
    ));

    const result = await checkStagedDailyStages(makeEnv(), AT_0800);

    const editorial = result.checks.find((check) => check.stage === 'editorial');
    expect(editorial).toMatchObject({ healthy: false, reason: 'missing_snapshot', alerted: true });
    expect(result.alerted).toBe(1);
    const call = vi.mocked(deliverCriticalAlert).mock.calls[0];
    expect(String(call[2])).toBe('今日 editorial 阶段未按时完成');
    expect(String(call[3])).toContain(DATE);
    expect(String(call[3])).toContain('BJT 07:50');
  });

  test('快照在但 pushed_at 为空 → 报「未成功推送」', async () => {
    vi.mocked(getDailyStageState).mockImplementation(async (_env, _date, stage) => (
      { stage, revision: 1, content_hash: `sha256:${stage}`, pushed_at: stage === 'editorial' ? null : 1 } as never
    ));

    const result = await checkStagedDailyStages(makeEnv(), AT_0800);

    expect(result.checks.find((check) => check.stage === 'editorial'))
      .toMatchObject({ healthy: false, reason: 'missing_push', alerted: true });
  });

  test('DAILY_PUSH_ENABLED 未开时不因缺 pushed_at 误告警', async () => {
    vi.mocked(getDailyStageState).mockImplementation(async (_env, _date, stage) => (
      { stage, revision: 1, content_hash: `sha256:${stage}` } as never
    ));

    const result = await checkStagedDailyStages(makeEnv({ DAILY_PUSH_ENABLED: '0' }), AT_0800);

    expect(result.alerted).toBe(0);
    expect(result.checks.filter((check) => check.stage !== 'finalize').every((check) => check.healthy)).toBe(true);
  });

  test('同一 (日期, 阶段) 每天只告一次', async () => {
    vi.mocked(getDailyStageState).mockResolvedValue(null);
    const env = makeEnv();

    const first = await checkStagedDailyStages(env, AT_0800);
    const second = await checkStagedDailyStages(env, AT_0800 + 5 * 60_000);

    expect(first.alerted).toBeGreaterThan(0);
    expect(second.alerted).toBe(0);
    expect(second.checks.every((check) => check.reason === 'already_alerted')).toBe(true);
  });

  test('KV 故障只影响去重,不吞掉告警本身', async () => {
    vi.mocked(getDailyStageState).mockResolvedValue(null);
    const env = makeEnv({
      AUTH_KV: { get: vi.fn(async () => { throw new Error('kv down'); }), put: vi.fn() },
    });

    const result = await checkStagedDailyStages(env, AT_0800);

    expect(result.alerted).toBeGreaterThan(0);
    expect(deliverCriticalAlert).toHaveBeenCalled();
  });

  test('读状态本身失败时记 read_failed,不冒充「阶段失败」也不静默', async () => {
    vi.mocked(getDailyStageState).mockRejectedValue(new Error('D1 timeout'));

    const result = await checkStagedDailyStages(makeEnv(), AT_0800);

    expect(result.checks.every((check) => check.reason === 'read_failed')).toBe(true);
    expect(result.alerted).toBe(0);
    expect(console.error).toHaveBeenCalled();
  });

  test('全部阶段健康时静默', async () => {
    vi.mocked(getDailyStageState).mockImplementation(async (_env, _date, stage) => (
      { stage, revision: 1, content_hash: `sha256:${stage}`, pushed_at: 1 } as never
    ));

    const result = await checkStagedDailyStages(makeEnv(), bjt(DATE, 8, 30));

    expect(result.alerted).toBe(0);
    expect(result.checks.every((check) => check.healthy)).toBe(true);
    expect(deliverCriticalAlert).not.toHaveBeenCalled();
  });

  test('9/2 重演:仅凭 D1 状态就能在 BJT 08:00 报出来,不需要 workflow 侧跑过任何代码', async () => {
    // 事故形状:07:50 与 08:00 两次 workflow 都没能留下 editorial 快照。
    // 看门狗的全部输入就是 getDailyStageState 的返回值 —— 与 workflow 是否跑到 catch 无关,
    // 因此 isolate 被 CPU 超限直接掐死(workflow 内所有告警都发不出)时它照样能报。
    vi.mocked(getDailyStageState).mockImplementation(async (_env, _date, stage) => (
      stage === 'editorial' ? null : { stage, revision: 1, content_hash: 'h', pushed_at: 1 } as never
    ));

    const result = await checkStagedDailyStages(makeEnv(), AT_0800);

    expect(result.alerted).toBe(1);
    // 08:00 就报 —— 事故当天 owner 是 08:45 自己发现的,提前 45 分钟。
    expect(result.checks.find((check) => check.stage === 'editorial')?.reason).toBe('missing_snapshot');
  });

  test('变异验证:把 editorial 的宽限期放宽到 30 分钟,BJT 08:00 这一刻就报不出来了', async () => {
    vi.mocked(getDailyStageState).mockResolvedValue(null);
    const editorial = STAGED_STAGE_DEADLINES.find((entry) => entry.stage === 'editorial')!;
    // 当前配置:07:50 + 10 分钟宽限 → 08:00 整点这一 tick 恰好开始检查。
    expect(editorial.dueMinuteBjt + editorial.graceMinutes).toBe(8 * 60);
    const at0800 = await checkStagedDailyStages(makeEnv(), AT_0800);
    expect(at0800.checks.map((check) => check.stage)).toContain('editorial');

    // 变异体:宽限期若放宽到 30 分钟(= 08:20 才检查),08:00 这一刻 editorial 不在检查范围内,
    // 告警要推迟 20 分钟 —— 断言据此必红。
    const mutatedFrom = editorial.dueMinuteBjt + 30;
    const minuteAt0800 = 8 * 60;
    expect(minuteAt0800 >= mutatedFrom).toBe(false);
  });
});
