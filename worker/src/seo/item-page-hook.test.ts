import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// 各源 enrich 收尾统一调 syncItemPageOnEnrichDone（六源共用的可测挂载函数——pipeline
// 因 import 'cloudflare:workers' 无法在 vitest 直接跑，故把挂载逻辑抽到本函数）。
// mock 掉 Task 4 的 generateItemPage / markItemPageGone，断言收尾据 relevant 分流 + 异常不冒泡。
// pingIndexNow 用真身（daily-page-run.ts，不含 cloudflare:workers），只 mock 全局 fetch 观测/拦截 ping。
vi.mock('./item-page-run', () => ({
  generateItemPage: vi.fn(async () => ({ itemId: '', skipped: false })),
  markItemPageGone: vi.fn(async () => {}),
}));

import { generateItemPage, markItemPageGone } from './item-page-run';
import { syncItemPageOnEnrichDone } from './item-page-hook';
import { itemPagePath } from '../digest/render';
import type { Env } from '../index';

const env = {} as Env;
// ping 路径专用 env：SITE_BASE 拼绝对 URL（走 env 域，非 request host）；INDEXNOW_KEY 已配，
// 否则 pingIndexNow 静默跳过。default 分流测试用 `env`（不 ping），ping 测试用 `pingEnv`。
const pingEnv = { SITE_BASE: 'https://ai-feeds.com', INDEXNOW_KEY: 'inx-test-key' } as Env;

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  // 兜底 mock fetch：任何 IndexNow ping 都打到这里，绝不触网（默认 200）。
  fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

// 只数打到 IndexNow endpoint 的 fetch（隔离其它潜在 fetch）。
const indexNowCalls = () =>
  fetchMock.mock.calls.filter(([url]) => String(url).includes('api.indexnow.org'));

describe('syncItemPageOnEnrichDone', () => {
  test('relevant → 调 generateItemPage(env,id 正确)，不下架（github 代表源）', async () => {
    const id = 'github:acme/tool';
    await syncItemPageOnEnrichDone(env, id, true);
    expect(generateItemPage).toHaveBeenCalledTimes(1);
    expect(generateItemPage).toHaveBeenCalledWith(env, id);
    expect(markItemPageGone).not.toHaveBeenCalled();
  });

  test('not relevant → 调 markItemPageGone(env,id 正确) 下架，不生成（ph 代表源）', async () => {
    const id = 'product_hunt:coolslug:2026-07-08';
    await syncItemPageOnEnrichDone(env, id, false);
    expect(markItemPageGone).toHaveBeenCalledTimes(1);
    expect(markItemPageGone).toHaveBeenCalledWith(env, id);
    expect(generateItemPage).not.toHaveBeenCalled();
  });

  test('生成异常不冒泡：generateItemPage throw → 收尾函数 resolve（enrich 主流程不断）', async () => {
    vi.mocked(generateItemPage).mockRejectedValueOnce(new Error('R2 down'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      syncItemPageOnEnrichDone(env, 'github:x/y', true),
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  test('下架异常不冒泡：markItemPageGone throw → 收尾函数 resolve', async () => {
    vi.mocked(markItemPageGone).mockRejectedValueOnce(new Error('D1 down'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      syncItemPageOnEnrichDone(env, 'x_list:1', false),
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe('syncItemPageOnEnrichDone → IndexNow ping（首次 live 新页加速 Bing/Yandex 收录）', () => {
  test('转入 live 新页（becameLive=true）→ ping 一次，urlList = [siteBase + itemPagePath]，绝对 URL', async () => {
    const id = 'github:acme/tool';
    vi.mocked(generateItemPage).mockResolvedValueOnce({ itemId: id, skipped: false, becameLive: true });
    await syncItemPageOnEnrichDone(pingEnv, id, true);

    const calls = indexNowCalls();
    expect(calls).toHaveLength(1);
    const [endpoint, init] = calls[0] as unknown as [string, RequestInit];
    expect(endpoint).toBe('https://api.indexnow.org/indexnow');
    const body = JSON.parse(String(init.body));
    const expectedUrl = `https://ai-feeds.com${itemPagePath(id)}`;
    expect(body.urlList).toEqual([expectedUrl]);
    expect(/^https:\/\//.test(expectedUrl)).toBe(true); // 绝对 URL（env 域，非 request host）
    expect(body.host).toBe('ai-feeds.com');
    expect(body.key).toBe('inx-test-key');
  });

  test('已 live 行再 enrich（becameLive=false，re-enrich / metrics 刷新 / 重译）→ 不 ping', async () => {
    vi.mocked(generateItemPage).mockResolvedValueOnce({ itemId: 'x_list:1', skipped: false, becameLive: false });
    await syncItemPageOnEnrichDone(pingEnv, 'x_list:1', true);
    expect(indexNowCalls()).toHaveLength(0);
  });

  test('relevant=false → 走 markItemPageGone 下架分支，不 ping', async () => {
    await syncItemPageOnEnrichDone(pingEnv, 'product_hunt:slug:2026-07-08', false);
    expect(markItemPageGone).toHaveBeenCalledTimes(1);
    expect(generateItemPage).not.toHaveBeenCalled();
    expect(indexNowCalls()).toHaveLength(0);
  });

  test('generateItemPage skipped（被 dedup 门 / is_relevant 门拦下）→ 不 ping', async () => {
    vi.mocked(generateItemPage).mockResolvedValueOnce({
      itemId: 'x_list:dup',
      skipped: true,
      reason: 'dedup-suppressed',
      becameLive: false,
    });
    await syncItemPageOnEnrichDone(pingEnv, 'x_list:dup', true);
    expect(indexNowCalls()).toHaveLength(0);
  });

  test('itemPagePath 返回 null（不支持源，防御分支）→ 不 ping、不崩', async () => {
    const id = 'clawhub:x';
    expect(itemPagePath(id)).toBeNull();
    // 构造一个「!skipped 且 becameLive」但 path 为 null 的反常返回，验证 hook 的 path 空守卫。
    vi.mocked(generateItemPage).mockResolvedValueOnce({ itemId: id, skipped: false, becameLive: true });
    await expect(syncItemPageOnEnrichDone(pingEnv, id, true)).resolves.toBeUndefined();
    expect(indexNowCalls()).toHaveLength(0);
  });

  test('INDEXNOW_KEY 未配置 → pingIndexNow 静默跳过（零 fetch）、不抛错', async () => {
    const id = 'github:acme/tool';
    vi.mocked(generateItemPage).mockResolvedValueOnce({ itemId: id, skipped: false, becameLive: true });
    const noKeyEnv = { SITE_BASE: 'https://ai-feeds.com' } as Env; // 无 INDEXNOW_KEY
    await expect(syncItemPageOnEnrichDone(noKeyEnv, id, true)).resolves.toBeUndefined();
    expect(indexNowCalls()).toHaveLength(0);
  });

  test('ping 返回非 2xx（500）→ 收尾函数仍 resolve（不阻塞 enrich）', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));
    const id = 'github:acme/tool';
    vi.mocked(generateItemPage).mockResolvedValueOnce({ itemId: id, skipped: false, becameLive: true });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(syncItemPageOnEnrichDone(pingEnv, id, true)).resolves.toBeUndefined();
    expect(indexNowCalls()).toHaveLength(1); // 仍发起了 ping，只是 pingIndexNow 内部吞掉非 2xx
    errSpy.mockRestore();
  });

  test('ping fetch 抛异常（网络错）→ 收尾函数仍 resolve（不阻塞 enrich）', async () => {
    fetchMock.mockRejectedValueOnce(new Error('IndexNow unreachable'));
    const id = 'github:acme/tool';
    vi.mocked(generateItemPage).mockResolvedValueOnce({ itemId: id, skipped: false, becameLive: true });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(syncItemPageOnEnrichDone(pingEnv, id, true)).resolves.toBeUndefined();
    errSpy.mockRestore();
  });
});
