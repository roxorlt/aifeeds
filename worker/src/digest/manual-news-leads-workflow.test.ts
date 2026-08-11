import { describe, expect, test, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ WorkflowEntrypoint: class {} }));
vi.mock('./manual-news-leads-runtime', () => ({
  processManualNewsLeadWithEnv: vi.fn(async () => undefined),
}));

import { processManualNewsLeadWithEnv } from './manual-news-leads-runtime';
import { runManualNewsLeadWorkflow } from './manual-news-leads-workflow';

describe('manual news lead workflow', () => {
  test('runs lead processing inside a durable retried step', async () => {
    const step = {
      do: vi.fn(async (_name, _options, callback: () => Promise<void>) => callback()),
    };
    const env = {} as never;

    await runManualNewsLeadWorkflow(env, { lead_id: 'ml-20260811-abc123def456' }, step as never);

    expect(step.do).toHaveBeenCalledWith(
      'research-verify-score-lead',
      expect.objectContaining({ timeout: '5 minutes', retries: expect.objectContaining({ limit: 2 }) }),
      expect.any(Function),
    );
    expect(processManualNewsLeadWithEnv).toHaveBeenCalledWith(env, 'ml-20260811-abc123def456');
  });
});
