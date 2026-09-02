import { beforeEach, expect, test, vi } from 'vitest';

import { deliverCriticalAlert, pushDeerAlert, pushDeerMessage } from './notifier';

beforeEach(() => {
  vi.restoreAllMocks();
});

test('product PushDeer message keeps the supplied title without alarm prefix', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ code: 0 }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));

  const result = await pushDeerMessage(
    { PUSHDEER_ADMIN_KEYS: 'key-one,key-two' } as never,
    'AI Feeds 今日行业要闻候选',
    '候选正文',
  );

  expect(result).toEqual({
    configured: 2, attempted: 2, succeeded: 2,
    http_failures: 0, provider_failures: 0, exceptions: 0,
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  const body = new URLSearchParams(String(fetchMock.mock.calls[0][1]?.body));
  expect(body.get('text')).toBe('AI Feeds 今日行业要闻候选');
  expect(body.get('text')).not.toContain('告警');
});

// ── deliverCriticalAlert:关键告警不许静默(2026-09-02 事故教训)──────────────────
// sendPushDeer 把每一种投递失败都吞掉、计数、返回;pushDeerAlert 又丢掉这个结果返回 void。
// 于是全仓所有告警调用点都无法区分「推成功」和「一条都没推出去」。deliverCriticalAlert
// 是关键告警的统一出口:检查 succeeded,零成功必须落 console.error 并返回 false。

test('deliverCriticalAlert 全部投递成功时返回 true,不打错误日志', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(
    JSON.stringify({ code: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } },
  ));
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

  const ok = await deliverCriticalAlert(
    { PUSHDEER_ADMIN_KEYS: 'key-one' } as never, 'unit', '阶段失败', '正文',
  );

  expect(ok).toBe(true);
  expect(errorLog).not.toHaveBeenCalled();
});

test('deliverCriticalAlert 打上 xList告警 前缀(与 pushDeerAlert 同一封路径)', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(
    JSON.stringify({ code: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } },
  ));

  await deliverCriticalAlert({ PUSHDEER_ADMIN_KEYS: 'key-one' } as never, 'unit', '阶段失败', '正文');

  const body = new URLSearchParams(String(fetchMock.mock.calls[0][1]?.body));
  expect(body.get('text')).toBe('xList告警 | 阶段失败');
});

test.each([
  ['PUSHDEER_ADMIN_KEYS 未配置', undefined, async () => new Response('{}', { status: 200 })],
  ['HTTP 非 2xx', 'key-one', async () => new Response('nope', { status: 502 })],
  ['provider code≠0', 'key-one', async () => new Response(
    JSON.stringify({ code: 1, error: 'bad pushkey' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )],
  ['fetch 抛异常', 'key-one', async () => { throw new Error('network down'); }],
])('deliverCriticalAlert 在「%s」时返回 false 并落错误日志', async (_case, keys, responder) => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(responder as never);
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  const ok = await deliverCriticalAlert(
    (keys ? { PUSHDEER_ADMIN_KEYS: keys } : {}) as never, 'stage-fail', '阶段失败', '正文摘要',
  );

  expect(ok).toBe(false);
  // 必须有一条明确指出「0 条送达」的日志,而不是静默。
  expect(errorLog.mock.calls.some((call) => String(call[0]).includes('[alert:stage-fail]')
    && String(call[0]).includes('delivered 0/'))).toBe(true);
});

// 变异验证:把 deliverCriticalAlert 退回成事故前的「丢结果 + 裸 catch」写法,
// 上面那组断言就再也测不出「一条都没推出去」—— 这正是 9/2 静默的形状。
test('变异验证:丢弃投递结果的旧写法无法区分成功与全失败', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('nope', { status: 502 }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const legacyStyle = async (env: never, title: string, body: string): Promise<void> => {
    await pushDeerAlert(env, title, body).catch(() => {});
  };

  // 旧写法返回 void:调用方拿不到任何可断言的失败信号。
  await expect(legacyStyle({ PUSHDEER_ADMIN_KEYS: 'key-one' } as never, '阶段失败', '正文'))
    .resolves.toBeUndefined();
  // 新写法在同样的全失败下明确返回 false。
  await expect(deliverCriticalAlert({ PUSHDEER_ADMIN_KEYS: 'key-one' } as never, 'unit', '阶段失败', '正文'))
    .resolves.toBe(false);
});
