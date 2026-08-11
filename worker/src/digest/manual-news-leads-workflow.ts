import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';

import type { Env } from '../index';
import { processManualNewsLeadWithEnv } from './manual-news-leads-runtime';

export interface ManualNewsLeadWorkflowParams {
  lead_id: string;
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
  await step.do('research-verify-score-lead', PROCESS_RETRY, () =>
    processManualNewsLeadWithEnv(env, params.lead_id));
}

export class ManualNewsLeadWorkflow extends WorkflowEntrypoint<Env, ManualNewsLeadWorkflowParams> {
  async run(event: WorkflowEvent<ManualNewsLeadWorkflowParams>, step: WorkflowStep): Promise<void> {
    await runManualNewsLeadWorkflow(this.env, event.payload, step);
  }
}
