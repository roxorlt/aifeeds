import { describe, expect, test } from 'vitest';

import {
  MANUAL_CANDIDATE_VERIFY_CONCURRENCY,
  settleWithConcurrency,
} from './news-review';

/** 到齐 count 个调用才一起放行；串行发起时永远到不齐。 */
function meetingPoint(count: number) {
  let markReached!: () => void;
  const reached = new Promise<void>((resolve) => { markReached = resolve; });
  let arrived = 0;
  return {
    reached,
    async wait(): Promise<number> {
      arrived += 1;
      const seat = arrived;
      if (arrived >= count) markReached();
      await reached;
      return seat;
    },
  };
}

function raceWithDeadline<T>(promise: Promise<T>, fallback: T, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => { setTimeout(() => resolve(fallback), ms); }),
  ]);
}

describe('settleWithConcurrency', () => {
  test('同时发起多个任务：三个任务必须都进来才放行', async () => {
    const gate = meetingPoint(3);
    const settling = settleWithConcurrency(
      [0, 1, 2].map((index) => async () => `${index}:${await gate.wait()}`),
      MANUAL_CANDIDATE_VERIFY_CONCURRENCY,
    );

    const arrival = await raceWithDeadline(
      gate.reached.then(() => 'concurrent' as const), 'serial' as const, 1_000,
    );
    const results = await settling;

    expect(arrival).toBe('concurrent');
    expect(results.map((entry) => (entry.ok ? entry.value.split(':')[0] : 'error')))
      .toEqual(['0', '1', '2']);
  });

  test('结果按任务下标返回，与完成先后无关', async () => {
    const results = await settleWithConcurrency(
      [30, 10, 20].map((delay, index) => () => new Promise<number>((resolve) => {
        setTimeout(() => resolve(index), delay);
      })),
      MANUAL_CANDIDATE_VERIFY_CONCURRENCY,
    );

    expect(results).toEqual([
      { ok: true, value: 0 }, { ok: true, value: 1 }, { ok: true, value: 2 },
    ]);
  });

  test('并发上限封顶，不会一次把所有任务全打出去', async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await settleWithConcurrency(
      Array.from({ length: 20 }, (_, index) => async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => { setTimeout(resolve, 1); });
        inFlight -= 1;
        return index;
      }),
      MANUAL_CANDIDATE_VERIFY_CONCURRENCY,
    );

    expect(peak).toBe(MANUAL_CANDIDATE_VERIFY_CONCURRENCY);
    expect(results.map((entry) => (entry.ok ? entry.value : -1)))
      .toEqual(Array.from({ length: 20 }, (_, index) => index));
  });

  test('单个任务失败只落在它自己的下标上，其余照常返回', async () => {
    const boom = new Error('lookup_failed');
    const results = await settleWithConcurrency(
      [
        async () => 'a',
        async () => { throw boom; },
        async () => 'c',
      ],
      MANUAL_CANDIDATE_VERIFY_CONCURRENCY,
    );

    expect(results).toEqual([
      { ok: true, value: 'a' }, { ok: false, error: boom }, { ok: true, value: 'c' },
    ]);
  });

  test('空任务表直接返回空结果', async () => {
    await expect(settleWithConcurrency([], MANUAL_CANDIDATE_VERIFY_CONCURRENCY))
      .resolves.toEqual([]);
  });

  test('并发上限锁定为 8', () => {
    expect(MANUAL_CANDIDATE_VERIFY_CONCURRENCY).toBe(8);
  });
});
