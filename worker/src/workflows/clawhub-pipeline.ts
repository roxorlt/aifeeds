// ClawHub 抓取链 Workflow — 替换 clawhub-enrich preempt cron。
// 设计：docs/plans/2026-05-16-ph-clawhub-workflow-design.md
//
// 触发：worker/src/clawhub.ts runClawhubFetchList 拉完 list 后对每条新 skill
// create instance（CH 无 rate limit 风险 — Convex 公开 API）。
//
// 流程（简化版 — 1 step，CH 无条件分支，3 件并行做完一起 UPDATE）：
//   step 1: enrich-and-translate (Promise.all 内 3 件并行: summary translate +
//                                  LLM finding translate + readme fetch+translate
//                                  + 最终一次 D1 UPDATE)
//
// 注：CH 默认 is_relevant=1（marketplace 已优选），无 classify step。

import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../index';
import { enrichAndTranslateChItem } from '../clawhub';

interface ChPipelineParams {
  itemId: string;
}

const RETRY = {
  retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
  timeout: '5 minutes',
} as const;

export class ClawhubPipelineWorkflow extends WorkflowEntrypoint<Env, ChPipelineParams> {
  async run(event: WorkflowEvent<ChPipelineParams>, step: WorkflowStep) {
    const { itemId } = event.payload;

    // Step 1: enrich + 3 件并行 + UPDATE D1（combined for atomicity）
    const result = await step.do('enrich-and-translate', RETRY, () =>
      enrichAndTranslateChItem(this.env, itemId),
    );

    // Step 2: 统一 workflow 完整性 gate(2026-05-21) — 仅 enrich 成功才 mark
    // /api/items?source_type=clawhub 在 WORKFLOW_COMPLETED_FILTER='true' 时滤掉
    // workflow_completed_at IS NULL 的半成品(enrich 失败的 item 没 mark)。
    if (result.ok) {
      await step.do('mark-completed', RETRY, async () => {
        await this.env.DB.prepare(
          `UPDATE items SET extra = json_set(coalesce(extra,'{}'), '$.workflow_completed_at', ?) WHERE id = ?`,
        ).bind(new Date().toISOString(), itemId).run();
      });
    }

    return { itemId, status: result.ok ? 'enriched' : 'failed' as const };
  }
}
