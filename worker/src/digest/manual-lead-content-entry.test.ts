import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('./manual-news-leads-store', () => ({
  assertManualNewsLeadCandidate: vi.fn(async () => ({ ok: true })),
  setManualLeadContentStage: vi.fn(async () => undefined),
  touchManualLeadContentDeadline: vi.fn(async () => undefined),
}));

import { assertManualNewsLeadCandidate, setManualLeadContentStage } from './manual-news-leads-store';
import { createDirectStepRunner, runManualLeadContentPipeline } from './manual-lead-content';
import { poolManualLeadContentEntry } from './manual-lead-content-entry';

beforeEach(() => vi.clearAllMocks());

test('AMD 微信墙回退保留原 owner 线索及授权入口，不写墙 evidence/body，完成进度携带原因', async () => {
  const lead = {
    id: 'ml-20260929-amd', review_date: '2026-09-29',
    input_url: 'https://mp.weixin.qq.com/s/amd-world-labs', input_text: 'AMD 收购 World Labs',
    note: 'owner note', submit_idempotency_key: 'owner-entry-key',
  };
  const deps = {
    fetchSource: vi.fn(async () => ({
      url: 'https://mp.weixin.qq.com/mp/wappoc_appmsgcaptcha',
      text: '环境异常，请完成验证', publisher: '微信', kind: 'document' as const,
    })),
    analyze: vi.fn(async () => null), search: vi.fn(async () => null), generate: vi.fn(async () => null),
  };
  const content = await runManualLeadContentPipeline(
    { url: lead.input_url, text: lead.input_text, date: lead.review_date }, deps,
    createDirectStepRunner({ onStage: () => undefined }),
  );
  const prepare = vi.fn();
  const env = { DB: { prepare } } as never;
  const now = 1_790_000_000_000;
  const outcome = await poolManualLeadContentEntry(env, lead, content, now);
  expect(assertManualNewsLeadCandidate).toHaveBeenCalledExactlyOnceWith(env, {
    date: lead.review_date, text: lead.input_text, url: lead.input_url, note: lead.note,
  }, lead.submit_idempotency_key, now);
  expect(content).toMatchObject({ materialTier: 'none', materials: [], materialExcerpt: '', excerptZh: '' });
  expect(prepare).not.toHaveBeenCalled();
  expect(outcome).toEqual({ pooled: true, stage: 'done', detail: content.detail });
  expect(content.detail).toContain('指定链接返回验证页面');
  expect(setManualLeadContentStage).toHaveBeenCalledExactlyOnceWith(env, lead.id, {
    stage: 'done', detail: content.detail,
  }, expect.any(Number));
});
