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
// 流程（按设计 doc）：
//   step 0: step.sleep(throttleSec)        — 跨 instance 节流
//   step 1: ensure-cookies                  — KV cache (10min TTL) + warm-up if missing
//   step 2: fetch-and-parse-detail          — HTTP GET detail page + parseDetail
//   step 3: persist                         — UPDATE D1 (active/historical 判断)

import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../index';
import {
  ensureHdxSessionCookies,
  fetchAndParseHdxDetail,
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

    // Step 1: 拿 cookies（KV cache 10min TTL）
    const cookies = await step.do('ensure-cookies', RETRY, () =>
      ensureHdxSessionCookies(this.env),
    );

    // Step 2: fetch detail + parse
    const parsed = await step.do('fetch-and-parse-detail', RETRY, () =>
      fetchAndParseHdxDetail(this.env, itemId, cookies),
    );
    if (!parsed) {
      // 404 / 已删 / parse 失败 — 不 retry，返回 parse-failed
      return { itemId, status: 'parse-failed' as const };
    }

    // Step 3: 写 D1（含 historical 判断）
    const result = await step.do('persist', RETRY, () =>
      persistHdxDetail(this.env, itemId, parsed),
    );

    return { itemId, status: result.status };
  }
}
