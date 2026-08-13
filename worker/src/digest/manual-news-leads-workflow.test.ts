import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ WorkflowEntrypoint: class {} }));
vi.mock('./manual-news-leads-runtime', () => ({
  processManualNewsLeadWithEnv: vi.fn(async () => undefined),
  MANUAL_NEWS_PROVIDER_TIMEOUT_MS: 210_000,
}));
vi.mock('./manual-news-leads-store', () => ({
  claimManualNewsLeadProcessing: vi.fn(async () => 1),
  failManualNewsLeadAfterExhaustion: vi.fn(async () => true),
}));

import { processManualNewsLeadWithEnv } from './manual-news-leads-runtime';
import { claimManualNewsLeadProcessing, failManualNewsLeadAfterExhaustion } from './manual-news-leads-store';
import {
  MANUAL_NEWS_MAX_PROVIDER_CALLS_PER_STEP,
  MANUAL_NEWS_NON_PROVIDER_BUDGET_MS,
  MANUAL_NEWS_WORKFLOW_BUDGET_MS,
  MANUAL_NEWS_WORKFLOW_SAFETY_MARGIN_MS,
  MANUAL_NEWS_WORKFLOW_STEP_TIMEOUT_MS,
  runManualNewsLeadWorkflow,
} from './manual-news-leads-workflow';
import { MANUAL_NEWS_PROVIDER_TIMEOUT_MS } from './manual-news-leads-runtime';
import { ManualNewsProviderError } from './manual-news-provider';

describe('manual news lead workflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(claimManualNewsLeadProcessing).mockResolvedValue(1);
  });
  test('keeps the complete provider budget strictly below the durable step timeout', () => {
    expect(MANUAL_NEWS_MAX_PROVIDER_CALLS_PER_STEP).toBe(3);
    expect(MANUAL_NEWS_NON_PROVIDER_BUDGET_MS).toBe(180_000);
    expect(MANUAL_NEWS_WORKFLOW_BUDGET_MS).toBe(810_000);
    expect(MANUAL_NEWS_WORKFLOW_STEP_TIMEOUT_MS).toBe(900_000);
    expect(MANUAL_NEWS_WORKFLOW_SAFETY_MARGIN_MS).toBe(90_000);
    expect(MANUAL_NEWS_PROVIDER_TIMEOUT_MS).toBeLessThan(MANUAL_NEWS_WORKFLOW_STEP_TIMEOUT_MS);
    expect(MANUAL_NEWS_WORKFLOW_BUDGET_MS).toBeLessThan(MANUAL_NEWS_WORKFLOW_STEP_TIMEOUT_MS);
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
      expect.objectContaining({
        timeout: '15 minutes',
        retries: { limit: 2, delay: '20 seconds', backoff: 'exponential' },
      }),
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

  test('retries a finish-reason output exhaustion three times and preserves its terminal code', async () => {
    vi.mocked(claimManualNewsLeadProcessing)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(3);
    const failure = new ManualNewsProviderError({
      stage: 'assessment', provider_error_code: 'provider_output_exhausted',
      metrics: {
        stage: 'assessment', request_id: 'ml-20260811-abc123def456:p3:assessment:1',
        system_chars: 4_083, user_chars: 6_086, evidence_count: 1, attempt: 3,
      },
      provider_diagnostics: {
        finish_reason: 'length', content_chars: 11, reasoning_chars: 12_000,
        usage: { completion_tokens: 12_000, reasoning_tokens: 12_000 },
      },
    });
    vi.mocked(processManualNewsLeadWithEnv).mockRejectedValue(failure);
    const step = {
      do: vi.fn(async (_name, options, callback: () => Promise<void>) => {
        let lastError;
        for (let attempt = 0; attempt <= options.retries.limit; attempt++) {
          try { return await callback(); } catch (error) { lastError = error; }
        }
        throw lastError;
      }),
    };

    await expect(runManualNewsLeadWorkflow({} as never, {
      lead_id: 'ml-20260811-abc123def456', processing_owner: 'workflow-finish-reason',
    }, step as never)).rejects.toMatchObject({
      provider_error_code: 'provider_output_exhausted',
    });

    expect(processManualNewsLeadWithEnv).toHaveBeenCalledTimes(3);
    expect(failManualNewsLeadAfterExhaustion).toHaveBeenCalledWith(
      expect.anything(), 'ml-20260811-abc123def456', 'workflow-finish-reason', 3,
      expect.objectContaining({ provider_error_code: 'provider_output_exhausted' }),
      expect.any(Number),
    );
  });
});
