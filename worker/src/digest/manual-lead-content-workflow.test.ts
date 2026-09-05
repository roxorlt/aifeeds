import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('./manual-news-leads-store', () => ({
  setManualLeadContentStage: vi.fn(async () => undefined),
  touchManualLeadContentDeadline: vi.fn(async () => undefined),
}));
vi.mock('./manual-lead-content-entry', () => ({
  poolManualLeadContentEntry: vi.fn(async () => ({ pooled: true, stage: 'done', detail: '' })),
}));
vi.mock('./manual-lead-content-runtime', () => ({
  createManualLeadContentAdapters: vi.fn(() => ({
    fetchSource: vi.fn(async () => null),
    analyze: vi.fn(async () => null),
    search: vi.fn(async () => null),
    generate: vi.fn(async () => null),
  })),
}));

import { setManualLeadContentStage, touchManualLeadContentDeadline } from './manual-news-leads-store';
import { poolManualLeadContentEntry } from './manual-lead-content-entry';
import {
  MANUAL_LEAD_CONTENT_POOL_BUDGET_MS,
  MANUAL_LEAD_CONTENT_WORKFLOW_KIND,
  isManualLeadContentWorkflowParams,
  manualLeadContentWorkflowId,
  runManualLeadContentEntryWorkflow,
} from './manual-lead-content-workflow';
import type { ManualLeadContentAdapters } from './manual-lead-content';
import type { ManualEnrichmentMaterial } from './manual-lead-enrichment';

const PARAMS = {
  kind: MANUAL_LEAD_CONTENT_WORKFLOW_KIND,
  id: 'ml-20260905-abc123def456',
  review_date: '2026-09-05',
  input_url: 'https://openai.com/index/astra/',
  input_text: 'OpenAI 发布了企业级模型 Astra',
  note: '',
  submit_idempotency_key: 'entry-key',
  submitted_at: 1_700_000_000_000,
} as const;

function material(over: Partial<ManualEnrichmentMaterial> = {}): ManualEnrichmentMaterial {
  return {
    text: 'OpenAI 今天发布 Astra。', url: 'https://openai.com/index/astra/',
    publisher: 'openai.com', kind: 'document', ...over,
  };
}

function adapters(over: Partial<ManualLeadContentAdapters> = {}): ManualLeadContentAdapters {
  return {
    fetchSource: vi.fn(async () => material()),
    analyze: vi.fn(async () => ({ headline: 'OpenAI 发布 Astra', query: 'OpenAI Astra 企业模型' })),
    search: vi.fn(async () => material({
      text: '路透社报道：Astra 面向企业开放。', url: 'https://reuters.com/astra',
      publisher: 'reuters.com', kind: 'search+document',
    })),
    generate: vi.fn(async () => ({
      aiCategory: 'model-release' as const,
      titleZh: 'OpenAI 发布企业级模型 Astra',
      rawTitleZh: 'OpenAI 发布企业级模型 Astra',
      bodyZh: 'OpenAI 今日发布 Astra，面向企业客户开放。',
      aiSummaryZh: 'OpenAI 发布 Astra，把企业级推理能力做成可直接采购的产品。',
      rawGuests: undefined,
      grounding: { suspect: false, reason: '', bodySubjects: [], outputSubjects: [] },
    })),
    ...over,
  };
}

/**
 * 一个「会把产物记下来」的假 step：跑一次回调，把名字与产物存起来。
 *
 * 真 workflow 的关键性质就在这里被模拟：**每一步的产物都要能存下来**。存不下来的东西
 * （undefined、循环引用、超大正文）在生产上会让整条 workflow 挂掉。
 */
function recordingStep() {
  const calls: Array<{ name: string; config: unknown; output: unknown }> = [];
  return {
    calls,
    step: {
      do: async (name: string, config: unknown, callback: () => Promise<unknown>) => {
        const output = await callback();
        calls.push({ name, config, output });
        return output;
      },
    } as never,
  };
}

/** 一步彻底失败（重试也耗尽）时真 workflow 会抛出来；这个假 step 模拟那一刻。 */
function failingStep(failName: string) {
  const seen: string[] = [];
  return {
    seen,
    step: {
      do: async (name: string, _config: unknown, callback: () => Promise<unknown>) => {
        seen.push(name);
        if (name.includes(failName)) throw new Error(`step_exhausted:${name}`);
        return callback();
      },
    } as never,
  };
}

describe('一步录入的内容加工 workflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(poolManualLeadContentEntry).mockResolvedValue({
      pooled: true, stage: 'done', detail: '',
    } as never);
  });

  test('实例 id 与取证那条路的租约名不撞车', () => {
    expect(manualLeadContentWorkflowId('ml-20260905-abc123def456'))
      .toBe('content-ml-20260905-abc123def456');
    expect(manualLeadContentWorkflowId('ml-20260905-abc123def456'))
      .not.toContain('manual-news-ml-');
    expect(manualLeadContentWorkflowId('ml-20260905-abc123def456').length)
      .toBeLessThanOrEqual(64);
  });

  test('只有带 kind 标记的 payload 才走内容加工，取证那条路的 payload 不会被误接', () => {
    expect(isManualLeadContentWorkflowParams(PARAMS)).toBe(true);
    expect(isManualLeadContentWorkflowParams({
      lead_id: 'ml-20260905-abc123def456', processing_owner: 'manual-news-x-v1',
    })).toBe(false);
    expect(isManualLeadContentWorkflowParams(null)).toBe(false);
    expect(isManualLeadContentWorkflowParams({ kind: MANUAL_LEAD_CONTENT_WORKFLOW_KIND })).toBe(false);
  });

  test('四个加工阶段各是一个 durable step，入池是最后一个', async () => {
    const { calls, step } = recordingStep();
    await runManualLeadContentEntryWorkflow({} as never, PARAMS, step, { adapters: adapters() });

    expect(calls.map((call) => call.name)).toEqual([
      'manual-lead-content:fetch-source',
      'manual-lead-content:analyze',
      'manual-lead-content:search',
      'manual-lead-content:generate',
      'manual-lead-content:pool',
    ]);
    expect(poolManualLeadContentEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: PARAMS.id, submit_idempotency_key: 'entry-key' }),
      expect.objectContaining({
        drafted: expect.objectContaining({ title: 'OpenAI 发布企业级模型 Astra' }),
        materialTier: 'report',
      }),
      PARAMS.submitted_at,
    );
  });

  test('每一步的产物都存得下来：没有 undefined，也没有超出上限的正文', async () => {
    const { calls, step } = recordingStep();
    await runManualLeadContentEntryWorkflow({} as never, PARAMS, step, {
      adapters: adapters({ fetchSource: vi.fn(async () => material({ text: '甲'.repeat(50_000) })) }),
    });

    for (const call of calls) {
      expect(call.output).not.toBeUndefined();
      expect(() => JSON.stringify(call.output)).not.toThrow();
    }
    const fetched = calls[0].output as { text: string };
    expect(Array.from(fetched.text).length).toBeLessThanOrEqual(8_000);
  });

  test('每一步都带自己的超时与重试配置，超时严格大于这一步的时限', async () => {
    const { calls, step } = recordingStep();
    await runManualLeadContentEntryWorkflow({} as never, PARAMS, step, { adapters: adapters() });

    for (const call of calls) {
      expect(call.config).toMatchObject({
        retries: expect.objectContaining({ limit: expect.any(Number) }),
        timeout: expect.any(String),
      });
    }
    // 生成那一步的时限是 70s（模型调用本身允许 60s），step 超时必须比它长。
    const generate = calls.find((call) => call.name.endsWith('generate'))!;
    expect(Number(String((generate.config as { timeout: string }).timeout).split(' ')[0]))
      .toBeGreaterThan(70);
  });

  test('每进一步都续一次 content_deadline_at：workflow 还活着，兜底就不该抢着入池', async () => {
    const { step } = recordingStep();
    await runManualLeadContentEntryWorkflow({} as never, PARAMS, step, { adapters: adapters() });

    const stageCalls = vi.mocked(setManualLeadContentStage).mock.calls;
    expect(stageCalls.map((call) => call[2].stage)).toEqual([
      'fetching_source', 'analyzing', 'searching', 'drafting',
    ]);
    for (const call of stageCalls) {
      expect(Number(call[2].deadlineAt)).toBeGreaterThan(Date.now());
    }
  });

  test('一步彻底失败只作废这一步：后面的步骤照跑，入池照样发生', async () => {
    const { seen, step } = failingStep('fetch-source');
    const deps = adapters();
    await runManualLeadContentEntryWorkflow({} as never, PARAMS, step, { adapters: deps });

    // 抓正文那一步连重试都耗尽了，拟检索词、搜索与生成仍要跑 —— 一步失败不能连坐整轮。
    expect(seen).toEqual([
      'manual-lead-content:fetch-source',
      'manual-lead-content:analyze',
      'manual-lead-content:search',
      'manual-lead-content:generate',
      'manual-lead-content:pool',
    ]);
    expect(deps.search).toHaveBeenCalled();
    expect(poolManualLeadContentEntry).toHaveBeenCalledTimes(1);
  });

  test('生成那一步彻底失败时退回 owner 那句话入池，不带起草结果', async () => {
    const { step } = failingStep('generate');
    await runManualLeadContentEntryWorkflow({} as never, PARAMS, step, { adapters: adapters() });

    expect(poolManualLeadContentEntry).toHaveBeenCalledWith(
      expect.anything(), expect.anything(),
      expect.objectContaining({ drafted: null }), PARAMS.submitted_at,
    );
  });

  test('入池那一步也续一次期限：它自己重试的那两分钟里，兜底不该插进来抢', async () => {
    const { step } = recordingStep();
    await runManualLeadContentEntryWorkflow({} as never, PARAMS, step, { adapters: adapters() });

    expect(touchManualLeadContentDeadline).toHaveBeenCalledWith(
      expect.anything(), PARAMS.id, expect.any(Number), expect.any(Number),
    );
    const [, , deadlineAt] = vi.mocked(touchManualLeadContentDeadline).mock.calls[0];
    expect(Number(deadlineAt)).toBeGreaterThan(Date.now() + MANUAL_LEAD_CONTENT_POOL_BUDGET_MS);
  });

  test('入池那一步自己抛异常时往外抛，让 workflow 重试而不是当作已完成', async () => {
    vi.mocked(poolManualLeadContentEntry).mockRejectedValueOnce(new Error('d1_write_failed') as never);
    const { step } = recordingStep();

    await expect(runManualLeadContentEntryWorkflow(
      {} as never, PARAMS, step, { adapters: adapters() },
    )).rejects.toThrow(/d1_write_failed/);
  });
});
