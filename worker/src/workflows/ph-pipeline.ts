// Product Hunt 抓取链 Workflow — 替换 ph-enrich + ph-r2-migrate + fill-translations
// PH 字段 3 个 preempt cron。设计：docs/plans/2026-05-16-ph-clawhub-workflow-design.md
//
// 触发：worker/src/scrapers/ph.ts runPhDailyFetch 拉完 PT yesterday 后对每条新
// post create instance（throttleSec 不需要 — PH GraphQL API 无激进 rate limit）。
//
// 流程：
//   step 1: classify-with-llm  (DeepSeek is_relevant + ai_category + ai_summary)
//   ↓ is_relevant=0 早退
//   step 2: r2-migrate         (logo + gallery + maker_avatar + video → R2)
//   step 3: translate-fields   (DeepSeek tagline + maker_post + top_comments[])

import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../index';
import {
  classifyPhItemWithLlm,
  translatePhFieldsForItem,
} from '../scrapers/ph';
import { r2MigratePhItemById } from '../ph-r2';
import { syncItemPageOnEnrichDone } from '../seo/item-page-hook';

interface PhPipelineParams {
  itemId: string;
}

const RETRY = {
  retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
  timeout: '5 minutes',
} as const;

export class PhPipelineWorkflow extends WorkflowEntrypoint<Env, PhPipelineParams> {
  async run(event: WorkflowEvent<PhPipelineParams>, step: WorkflowStep) {
    const { itemId } = event.payload;

    // Step 1: DeepSeek 分类
    const cls = await step.do('classify-with-llm', RETRY, () =>
      classifyPhItemWithLlm(this.env, itemId),
    );
    if (cls.is_relevant !== 1) {
      // 改判/不相关 → 下架 item 页（无行则 no-op；非阻塞）。
      await step.do('sync-item-page-gone', RETRY, () =>
        syncItemPageOnEnrichDone(this.env, itemId, false),
      );
      return { itemId, classified: 'irrelevant' as const };
    }

    // Step 2: R2 资源迁移（logo + gallery + maker_avatar + video）
    await step.do('r2-migrate', RETRY, () =>
      r2MigratePhItemById(this.env, itemId),
    );

    // Step 3: 翻译 tagline + maker_post + top_comments[]
    await step.do('translate-fields', RETRY, () =>
      translatePhFieldsForItem(this.env, itemId),
    );

    // Step 4: 统一 workflow 完整性 gate(2026-05-21)
    // /api/items?source_type=product_hunt 在 WORKFLOW_COMPLETED_FILTER='true' 时滤掉
    // workflow_completed_at IS NULL 的半成品(workflow 未完成/失败的 item)。
    // is_relevant=0 早退路径不 mark — 那些项天然不在 feed(is_relevant=1 filter)。
    await step.do('mark-completed', RETRY, async () => {
      await this.env.DB.prepare(
        `UPDATE items SET extra = json_set(coalesce(extra,'{}'), '$.workflow_completed_at', ?) WHERE id = ?`,
      ).bind(new Date().toISOString(), itemId).run();
    });

    // Step 5: 内容最终态（relevant + 翻译/封面/gate 齐）→ 生成/覆盖 item 静态页（非阻塞容错）。
    await step.do('sync-item-page', RETRY, () =>
      syncItemPageOnEnrichDone(this.env, itemId, true),
    );

    return { itemId, classified: 'relevant' as const };
  }
}
