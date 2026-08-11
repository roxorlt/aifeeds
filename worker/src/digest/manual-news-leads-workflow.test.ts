import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ WorkflowEntrypoint: class {} }));
vi.mock('./manual-news-leads-runtime', () => ({
  processManualNewsLeadWithEnv: vi.fn(async () => undefined),
}));
vi.mock('./manual-news-leads-store', () => ({
  claimManualNewsLeadProcessing: vi.fn(async () => 1),
  failManualNewsLeadAfterExhaustion: vi.fn(async () => true),
}));

import { processManualNewsLeadWithEnv } from './manual-news-leads-runtime';
import { claimManualNewsLeadProcessing, failManualNewsLeadAfterExhaustion } from './manual-news-leads-store';
import { runManualNewsLeadWorkflow } from './manual-news-leads-workflow';

describe('manual news lead workflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(claimManualNewsLeadProcessing).mockResolvedValue(1);
  });
  test('a permanent pipeline result completes in one attempt without exhaustion handling', async () => {
    const step = { do: vi.fn(async (_name, _options, callback: () => Promise<void>) => callback()) };
    const env = {} as never;

    await runManualNewsLeadWorkflow(env, {
      lead_id: 'ml-20260811-abc123def456', processing_owner: 'workflow-permanent-result',
    }, step as never);

    expect(processManualNewsLeadWithEnv).toHaveBeenCalledTimes(1);
    expect(failManualNewsLeadAfterExhaustion).not.toHaveBeenCalled();
  });

  test('lets the durable step retry two transient failures before succeeding', async () => {
    vi.mocked(claimManualNewsLeadProcessing)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(3);
    vi.mocked(processManualNewsLeadWithEnv)
      .mockRejectedValueOnce(new Error('gateway_timeout'))
      .mockRejectedValueOnce(new Error('trusted_gateway_http_503'))
      .mockResolvedValueOnce(undefined);
    const step = {
      do: vi.fn(async (_name, options, callback: () => Promise<void>) => {
        let lastError;
        for (let attempt = 0; attempt <= options.retries.limit; attempt++) {
          try { return await callback(); } catch (error) { lastError = error; }
        }
        throw lastError;
      }),
    };
    const env = {} as never;

    await runManualNewsLeadWorkflow(env, {
      lead_id: 'ml-20260811-abc123def456', processing_owner: 'workflow-1',
    }, step as never);

    expect(step.do).toHaveBeenCalledWith(
      'research-verify-score-lead',
      expect.objectContaining({ timeout: '5 minutes', retries: expect.objectContaining({ limit: 2 }) }),
      expect.any(Function),
    );
    expect(processManualNewsLeadWithEnv).toHaveBeenCalledTimes(3);
    expect(processManualNewsLeadWithEnv).toHaveBeenNthCalledWith(
      1, env, 'ml-20260811-abc123def456', 'workflow-1', 1,
    );
    expect(processManualNewsLeadWithEnv).toHaveBeenNthCalledWith(
      2, env, 'ml-20260811-abc123def456', 'workflow-1', 2,
    );
    expect(processManualNewsLeadWithEnv).toHaveBeenNthCalledWith(
      3, env, 'ml-20260811-abc123def456', 'workflow-1', 3,
    );
    expect(claimManualNewsLeadProcessing).toHaveBeenCalledTimes(3);
    expect(failManualNewsLeadAfterExhaustion).not.toHaveBeenCalled();
  });

  test('marks a still-owned lead failed only after durable retry exhaustion', async () => {
    vi.mocked(claimManualNewsLeadProcessing)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(3);
    vi.mocked(processManualNewsLeadWithEnv).mockRejectedValue(new Error('model_gateway_503'));
    const step = {
      do: vi.fn(async (_name, options, callback: () => Promise<void>) => {
        let lastError;
        for (let attempt = 0; attempt <= options.retries.limit; attempt++) {
          try { return await callback(); } catch (error) { lastError = error; }
        }
        throw lastError;
      }),
    };
    const env = {} as never;
    await expect(runManualNewsLeadWorkflow(env, {
      lead_id: 'ml-20260811-abc123def456', processing_owner: 'workflow-exhausted',
    }, step as never)).rejects.toThrow(/model_gateway_503/);

    expect(processManualNewsLeadWithEnv).toHaveBeenCalledTimes(3);
    expect(failManualNewsLeadAfterExhaustion).toHaveBeenCalledWith(
      env, 'ml-20260811-abc123def456', 'workflow-exhausted', 3,
      expect.any(Error), expect.any(Number),
    );
  });
});
