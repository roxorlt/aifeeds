import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';

import type { Env } from '../index';
import {
  MANUAL_NEWS_PROVIDER_TIMEOUT_MS,
  processManualNewsLeadWithEnv,
} from './manual-news-leads-runtime';
import { claimManualNewsLeadProcessing, failManualNewsLeadAfterExhaustion } from './manual-news-leads-store';
import {
  isManualLeadContentWorkflowParams,
  runManualLeadContentEntryWorkflow,
  type ManualLeadContentWorkflowParams,
  type ManualLeadContentWorkflowStep,
} from './manual-lead-content-workflow';

export interface ManualNewsLeadWorkflowParams {
  lead_id: string;
  processing_owner?: string;
}

/**
 * 这个绑定上跑着两条互不相干的路，靠 payload 分流。
 *
 * - 取证那条（`{ lead_id }`）：搜索取证 → 事实核验 → 评分，要占 `processing_owner` 租约，
 *   失败要回写 `error_code`；它决定线索能不能入池。
 * - 一步录入的内容加工那条（`{ kind: 'manual_lead_content_entry', … }`）：抓正文 → 拟检索词
 *   → 搜索 → 生成 → 入池，一个租约都不占。
 *
 * 复用同一个绑定是为了不新增 Cloudflare 侧资源；两条路的实例 id 前缀不同
 * （`manual-news-…` 对 `content-…`），不会互相覆盖。
 */
export type ManualNewsLeadWorkflowPayload =
  | ManualNewsLeadWorkflowParams
  | ManualLeadContentWorkflowParams;

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

export class ManualNewsLeadWorkflow extends WorkflowEntrypoint<Env, ManualNewsLeadWorkflowPayload> {
  async run(event: WorkflowEvent<ManualNewsLeadWorkflowPayload>, step: WorkflowStep): Promise<void> {
    if (isManualLeadContentWorkflowParams(event.payload)) {
      // `WorkflowStep.do` 的泛型带 `Rpc.Serializable` 约束，而内容加工那条路的每一步返回的
      // 是普通 JSON 对象（素材、起草结果），形状对得上但类型层面套不进那个约束。
      await runManualLeadContentEntryWorkflow(
        this.env, event.payload, step as unknown as ManualLeadContentWorkflowStep,
      );
      return;
    }
    await runManualNewsLeadWorkflow(this.env, event.payload as ManualNewsLeadWorkflowParams, step);
  }
}
