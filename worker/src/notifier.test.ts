import { beforeEach, expect, test, vi } from 'vitest';

import { pushDeerMessage } from './notifier';

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
