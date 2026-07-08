import { describe, test, expect, vi, beforeEach } from 'vitest';

// 各源 enrich 收尾统一调 syncItemPageOnEnrichDone（六源共用的可测挂载函数——pipeline
// 因 import 'cloudflare:workers' 无法在 vitest 直接跑，故把挂载逻辑抽到本函数）。
// mock 掉 Task 4 的 generateItemPage / markItemPageGone，断言收尾据 relevant 分流 + 异常不冒泡。
vi.mock('./item-page-run', () => ({
  generateItemPage: vi.fn(async () => ({ itemId: '', skipped: false })),
  markItemPageGone: vi.fn(async () => {}),
}));

import { generateItemPage, markItemPageGone } from './item-page-run';
import { syncItemPageOnEnrichDone } from './item-page-hook';
import type { Env } from '../index';

const env = {} as Env;

beforeEach(() => {
  vi.clearAllMocks();
});

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
