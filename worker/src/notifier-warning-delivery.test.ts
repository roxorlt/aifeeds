import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { Env } from './index';
import { pushDeerWarning, sendDailyWarningDigest, type WarningEntry } from './notifier';

const WARNING_BUFFER_KEY = 'PUSHDEER_WARNING_BUFFER';

class FakeKv {
  readonly values = new Map<string, string>();
  failPut = false;
  deleteCalls = 0;

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    if (this.failPut) throw new Error('kv put rejected');
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.deleteCalls++;
    this.values.delete(key);
  }
}

function env(kv?: FakeKv, keys = 'push-key'): Env {
  return {
    AUTH_KV: kv as unknown as KVNamespace,
    PUSHDEER_ADMIN_KEYS: keys,
  } as Env;
}

function seedWarning(kv: FakeKv): void {
  const entry: WarningEntry = {
    title: '博客 workflow 自愈重试耗尽',
    body: 'fixture warning',
    at: '2026-08-27T09:00:00.000Z',
  };
  kv.values.set(WARNING_BUFFER_KEY, JSON.stringify([entry]));
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('warning without KV is not reported as durably queued', async () => {
  await expect(pushDeerWarning(env(undefined), 'title', 'body')).resolves.toBe(false);
});

test('KV put rejection is retryable and not reported as durably queued', async () => {
  const kv = new FakeKv();
  kv.failPut = true;

  await expect(pushDeerWarning(env(kv), 'title', 'body')).resolves.toBe(false);
  expect(kv.values.has(WARNING_BUFFER_KEY)).toBe(false);
});

test.each([
  ['HTTP 500', async () => new Response('failed', { status: 500 })],
  ['fetch exception', async () => { throw new Error('network unavailable'); }],
])('daily warning digest keeps its outbox after %s', async (_label, implementation) => {
  const kv = new FakeKv();
  seedWarning(kv);
  vi.mocked(fetch).mockImplementation(implementation);

  const result = await sendDailyWarningDigest(env(kv));

  expect(result).toEqual({ warnings: 1, pushed: false, reason: 'delivery_failed' });
  expect(kv.values.has(WARNING_BUFFER_KEY)).toBe(true);
  expect(kv.deleteCalls).toBe(0);
});

test('daily warning digest deletes its outbox after at least one destination succeeds', async () => {
  const kv = new FakeKv();
  seedWarning(kv);
  vi.mocked(fetch)
    .mockResolvedValueOnce(new Response('failed', { status: 500 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

  const result = await sendDailyWarningDigest(env(kv, 'failed-key,successful-key'));

  expect(result).toEqual({ warnings: 1, pushed: true });
  expect(kv.values.has(WARNING_BUFFER_KEY)).toBe(false);
  expect(kv.deleteCalls).toBe(1);
});
