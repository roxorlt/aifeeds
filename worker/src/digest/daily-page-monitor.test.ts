import { describe, test, expect, vi, beforeEach } from 'vitest';

// generateDailyPage 整体 mock —— 精确控制 skipped / 正常 / 抛错三条路径,验证告警封装。
vi.mock('./daily-page-run', () => ({
  generateDailyPage: vi.fn(),
}));
// notifier 整体 mock —— 断言 pushDeerAlert 调用/未调用 + 标题/正文内容。
vi.mock('../notifier', () => ({
  pushDeerAlert: vi.fn(async () => {}),
}));
vi.mock('./publication-release', () => ({
  loadCurrentDailyReleaseForBuild: vi.fn(),
}));

import { runDailyPagePhase, checkDailyPageFreshness } from './daily-page-monitor';
import { generateDailyPage } from './daily-page-run';
import { pushDeerAlert } from '../notifier';
import { loadCurrentDailyReleaseForBuild } from './publication-release';
import { bjtDateStr } from './lib';
import type { Env } from '../index';

const genMock = vi.mocked(generateDailyPage);
const alertMock = vi.mocked(pushDeerAlert);
const releaseMock = vi.mocked(loadCurrentDailyReleaseForBuild);

function baseEnv(over: Partial<Env> = {}): Env {
  return { PUSHDEER_ADMIN_KEYS: 'k1' } as unknown as Env;
}

describe('runDailyPagePhase(#4 Phase 4 告警)', () => {
  beforeEach(() => {
    genMock.mockReset();
    alertMock.mockReset();
    alertMock.mockResolvedValue(undefined);
  });

  test('正常生成 → 不发告警,返回 itemCount', async () => {
    genMock.mockResolvedValue({ date: '2026-07-07', itemCount: 12, skipped: false });
    const res = await runDailyPagePhase(baseEnv(), '2026-07-07');
    expect(res).toEqual({ date: '2026-07-07', skipped: false, itemCount: 12 });
    expect(alertMock).not.toHaveBeenCalled();
  });

  test('skipped(选品空)→ 发「跳过」告警一条', async () => {
    genMock.mockResolvedValue({ date: '2026-07-07', itemCount: 0, skipped: true, reason: 'empty_pool' });
    const res = await runDailyPagePhase(baseEnv(), '2026-07-07');
    expect(res.skipped).toBe(true);
    expect(alertMock).toHaveBeenCalledTimes(1);
    const [, title, body] = alertMock.mock.calls[0];
    expect(title).toContain('[SEO]');
    expect(title).toContain('跳过');
    expect(body).toContain('2026-07-07');
    expect(body).toContain('empty_pool');
  });

  test('generateDailyPage 抛错 → 发「生成失败」告警 + 返回 { error },不冒泡', async () => {
    genMock.mockRejectedValue(new Error('R2 put failed boom'));
    const res = await runDailyPagePhase(baseEnv(), '2026-07-07');
    expect(res.error).toContain('R2 put failed boom');
    expect(res.skipped).toBeUndefined();
    expect(alertMock).toHaveBeenCalledTimes(1);
    const [, title, body] = alertMock.mock.calls[0];
    expect(title).toContain('[SEO]');
    expect(title).toContain('生成失败');
    expect(body).toContain('2026-07-07');
    expect(body).toContain('R2 put failed boom');
  });
});

// ── 缺页兜底检查 ──

function makeKv() {
  const store = new Map<string, string>();
  return {
    _store: store,
    async get(k: string) { return store.get(k) ?? null; },
    async put(k: string, v: string) { store.set(k, v); },
    async delete(k: string) { store.delete(k); },
  };
}

function envFresh(db: unknown, kv: unknown): Env {
  return { DB: db, AUTH_KV: kv, PUSHDEER_ADMIN_KEYS: 'k1' } as unknown as Env;
}

describe('checkDailyPageFreshness(#4 缺页兜底)', () => {
  beforeEach(() => {
    alertMock.mockReset();
    alertMock.mockResolvedValue(undefined);
    releaseMock.mockReset();
  });

  test('今天有经当前 guard 验证的新鲜 release head → fresh,不告警', async () => {
    const kv = makeKv();
    const promotedAt = Date.now();
    releaseMock.mockResolvedValue({ head: { promoted_at_ms: promotedAt } } as never);
    const res = await checkDailyPageFreshness(envFresh({} as never, kv));
    expect(res.fresh).toBe(true);
    expect(res.generatedAt).toBe(new Date(promotedAt).toISOString());
    expect(res.reason).toBe('fresh');
    expect(res.alerted).toBe(false);
    expect(alertMock).not.toHaveBeenCalled();
  });

  test('今天无行 → 告警(reason=missing),且当天只告一次', async () => {
    const kv = makeKv();
    releaseMock.mockResolvedValue(null);
    const env = envFresh({} as never, kv);

    const first = await checkDailyPageFreshness(env);
    expect(first.reason).toBe('missing');
    expect(first.alerted).toBe(true);
    expect(alertMock).toHaveBeenCalledTimes(1);
    const [, title] = alertMock.mock.calls[0];
    expect(title).toContain('[SEO]');
    expect(title).toContain('未生成');
    // KV 标记已写
    expect(kv._store.has(`DAILY_PAGE_MISSING_ALERTED_${bjtDateStr()}`)).toBe(true);

    // 第二次同一天:命中标记 → 不再告警
    const second = await checkDailyPageFreshness(env);
    expect(second.reason).toBe('already_alerted');
    expect(second.alerted).toBe(false);
    expect(alertMock).toHaveBeenCalledTimes(1); // 仍是 1 次
  });

  test('陈旧 release head(promoted_at=远早于今天 UTC 0 点)→ 告警(reason=stale)', async () => {
    const kv = makeKv();
    const stale = new Date(Date.UTC(2000, 0, 1)).toISOString();
    releaseMock.mockResolvedValue({ head: { promoted_at_ms: Date.parse(stale) } } as never);
    const res = await checkDailyPageFreshness(envFresh({} as never, kv));
    expect(res.fresh).toBe(false);
    expect(res.reason).toBe('stale');
    expect(res.alerted).toBe(true);
    expect(alertMock).toHaveBeenCalledTimes(1);
  });

  test('裸 daily_pages 即使存在，当前 release guard 拒绝也按 missing fail-closed 告警', async () => {
    const kv = makeKv();
    releaseMock.mockRejectedValue(new Error('FORMAL_NEWS_FINAL_GUARD_FAILED'));
    const res = await checkDailyPageFreshness(envFresh({
      prepare() { throw new Error('must not read bare daily_pages'); },
    }, kv));
    expect(res).toMatchObject({ fresh: false, generatedAt: null, alerted: true, reason: 'missing' });
    expect(alertMock).toHaveBeenCalledTimes(1);
  });
});
