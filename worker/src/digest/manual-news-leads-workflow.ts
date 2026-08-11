import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';

import type { Env } from '../index';
import {
  MANUAL_NEWS_PROVIDER_TIMEOUT_MS,
  processManualNewsLeadWithEnv,
} from './manual-news-leads-runtime';
import { claimManualNewsLeadProcessing, failManualNewsLeadAfterExhaustion } from './manual-news-leads-store';

export interface ManualNewsLeadWorkflowParams {
  lead_id: string;
  processing_owner?: string;
}

export const MANUAL_NEWS_MAX_PROVIDER_CALLS_PER_STEP = 3;
export const MANUAL_NEWS_NON_PROVIDER_BUDGET_MS = 180_000;
export const MANUAL_NEWS_WORKFLOW_STEP_TIMEOUT_MS = 900_000;
export const MANUAL_NEWS_WORKFLOW_BUDGET_MS =
  MANUAL_NEWS_MAX_PROVIDER_CALLS_PER_STEP * MANUAL_NEWS_PROVIDER_TIMEOUT_MS
  + MANUAL_NEWS_NON_PROVIDER_BUDGET_MS;
export const MANUAL_NEWS_WORKFLOW_SAFETY_MARGIN_MS =
  MANUAL_NEWS_WORKFLOW_STEP_TIMEOUT_MS - MANUAL_NEWS_WORKFLOW_BUDGET_MS;

const PROCESS_RETRY = {
  retries: { limit: 2, delay: '20 seconds', backoff: 'exponential' as const },
  // Assessment + one schema-guided regeneration + independent verification:
  // 3 * 210s + 180s persistence/research = 810s, leaving 90s below this 900s step.
  timeout: '15 minutes',
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
