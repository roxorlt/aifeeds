import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';

import type { Env } from '../index';
import { processManualNewsLeadWithEnv } from './manual-news-leads-runtime';
import { claimManualNewsLeadProcessing, failManualNewsLeadAfterExhaustion } from './manual-news-leads-store';

export interface ManualNewsLeadWorkflowParams {
  lead_id: string;
  processing_owner?: string;
}

const PROCESS_RETRY = {
  retries: { limit: 2, delay: '20 seconds', backoff: 'exponential' as const },
  timeout: '5 minutes',
} as const;

export async function runManualNewsLeadWorkflow(
  env: Env,
  params: ManualNewsLeadWorkflowParams,
  step: Pick<WorkflowStep, 'do'>,
): Promise<void> {
  const owner = params.processing_owner || `manual-news-workflow:${params.lead_id}`;
  let processingAttempt: number | null = null;
  try {
    await step.do('research-verify-score-lead', PROCESS_RETRY, async () => {
      const now = Date.now();
      processingAttempt = await claimManualNewsLeadProcessing(env, params.lead_id, owner, now);
      if (processingAttempt === null) {
        throw new Error('processing_lease_conflict');
      }
      await processManualNewsLeadWithEnv(env, params.lead_id, owner, processingAttempt);
    });
  } catch (error) {
    if (processingAttempt !== null) {
      await failManualNewsLeadAfterExhaustion(
        env, params.lead_id, owner, processingAttempt, error, Date.now(),
      );
    }
    throw error;
  }
}

export class ManualNewsLeadWorkflow extends WorkflowEntrypoint<Env, ManualNewsLeadWorkflowParams> {
  async run(event: WorkflowEvent<ManualNewsLeadWorkflowParams>, step: WorkflowStep): Promise<void> {
    await runManualNewsLeadWorkflow(this.env, event.payload, step);
  }
}
