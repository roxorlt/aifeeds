// 活动行 (huodongxing) detail 抓取 Workflow — 替换原 preempt cron
// runHuodongxingDetailEnrich。设计：docs/plans/2026-05-16-huodongxing-workflow-design.md
//
// 触发：worker/src/scrapers/huodongxing.ts runHuodongxingFetchList() 拉完 list
// 后对每条新事件调 env.HUODONGXING_DETAIL_WORKFLOW.create({ params: { itemId,
// throttleSec } })。
//
// throttleSec = 同 batch 内 index × 5 秒，用 step.sleep 跨 instance 错开 detail
// 请求避免触发 site rate limit (~12 detail/min 阈值)。
//
// 流程（403 修复后简化）：
//   step 0: step.sleep(throttleSec)              — 跨 instance 节流
//   step 1: warmup-and-fetch-and-parse-detail    — 同节点 warm-up + detail + parse
//   step 2: persist                              — UPDATE D1 (active/historical 判断)
//
// 设计修订（2026-05-16）：原 ensure-cookies KV cache 模式遭遇 site WAF 403 (cookies
// 跨 IP 不匹配)。改成 warm-up 跟 detail 在同 step.do 跑（同 worker invocation
// = 同节点 IP），看起来像正常用户浏览 (listing → detail) 流程。

import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../index';
import {
  fetchHdxDetailWithWarmup,
  persistHdxDetail,
} from '../scrapers/huodongxing';

interface HdxDetailParams {
  itemId: string;
  throttleSec: number;  // 0..N×5，同 batch 内按顺序错开
}

const RETRY = {
  retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
  timeout: '2 minutes',
} as const;

export class HuodongxingDetailWorkflow extends WorkflowEntrypoint<Env, HdxDetailParams> {
  async run(event: WorkflowEvent<HdxDetailParams>, step: WorkflowStep) {
    const { itemId, throttleSec } = event.payload;

    // Step 0: 节流（跨 instance 错开请求）— step.sleep 不消 CPU 时间
    if (throttleSec > 0) {
      await step.sleep('throttle', `${throttleSec} seconds`);
    }

    // Step 1: warm-up + detail fetch + parse 合并（同节点 IP 同时发出 2 请求）
    const parsed = await step.do('warmup-and-fetch-detail', RETRY, () =>
      fetchHdxDetailWithWarmup(this.env, itemId),
    );
    if (!parsed) {
      // 404 / 已删 / parse 失败 — 不 retry，返回 parse-failed
      return { itemId, status: 'parse-failed' as const };
    }

    // Step 2: 写 D1（含 historical 判断）
    const result = await step.do('persist', RETRY, () =>
      persistHdxDetail(this.env, itemId, parsed),
    );

    // Step 3: 统一 workflow 完整性 gate(2026-05-21) — persist 成功才 mark
    // /api/items?source_type=huodongxing 在 WORKFLOW_COMPLETED_FILTER='true' 时滤掉
    // workflow_completed_at IS NULL 的半成品。parse-failed 早退不 mark。
    await step.do('mark-completed', RETRY, async () => {
      await this.env.DB.prepare(
        `UPDATE items SET extra = json_set(coalesce(extra,'{}'), '$.workflow_completed_at', ?) WHERE id = ?`,
      ).bind(new Date().toISOString(), itemId).run();
    });

    return { itemId, status: result.status };
  }
}
