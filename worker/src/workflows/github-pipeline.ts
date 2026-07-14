// GitHub 抓取链 Workflow — 替换原 3 个 preempt cron mode（enrich / r2-migrate /
// readme-translate）。设计文档：docs/plans/2026-05-16-github-pipeline-workflows-design.md
//
// 触发：worker/src/github.ts runGithubFetchTrending() 解析 trending HTML 后，
//       对每个新 repo 调用 env.GITHUB_PIPELINE_WORKFLOW.create({ params: { itemId } })。
//
// 流程：每个 instance 走 4-5 step pipeline。每步 retry 3 × 10s exp。is_relevant=0
//       时早退（不跑 step 3-5）。每步完成立即写 D1，保留 dashboard 看部分进度的 UX。

import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../index';
import {
  fetchAndPersistGithubMetadata,
  classifyGithubItemWithLlm,
  r2MigrateGithubItemById,
  translateGithubReadmeForItem,
  recomputeGithubDailyRank,
} from '../github';
import { syncItemPageOnEnrichDone } from '../seo/item-page-hook';

interface GithubPipelineParams {
  itemId: string;
}

const RETRY = {
  retries: {
    limit: 3,
    delay: '10 seconds',
    backoff: 'exponential',
  },
  timeout: '5 minutes',
} as const;

export class GithubPipelineWorkflow extends WorkflowEntrypoint<Env, GithubPipelineParams> {
  async run(event: WorkflowEvent<GithubPipelineParams>, step: WorkflowStep) {
    const { itemId } = event.payload;

    // Step 1: GH API metadata + README 拉取（不调 LLM）
    const meta = await step.do('enrich-metadata', RETRY, async () => {
      return await fetchAndPersistGithubMetadata(this.env, itemId);
    });

    // Step 2: DeepSeek LLM 分类 + ai_summary
    const llm = await step.do('classify-with-llm', RETRY, async () => {
      return await classifyGithubItemWithLlm(this.env, itemId, meta);
    });

    // classifyGithubItemWithLlm 对 null 会抛错触发 step retry；这里再做防御，避免未来
    // helper 契约回归时把“未知”误当成“不相关”并让 Workflow 假成功。
    if (llm.is_relevant !== 0 && llm.is_relevant !== 1) {
      throw new Error(`github classification unresolved after quality gate: ${itemId}`);
    }

    // is_relevant=0 早退，省 step 3-5
    if (llm.is_relevant === 0) {
      // 改判/不相关 → 下架 item 页（无行则 no-op；非阻塞）。
      await step.do('sync-item-page-gone', RETRY, () =>
        syncItemPageOnEnrichDone(this.env, itemId, false),
      );
      return { itemId, classified: 'irrelevant' as const };
    }

    // Step 3: README 内 inline 图/视频迁 R2
    await step.do('r2-migrate-assets', RETRY, async () => {
      return await r2MigrateGithubItemById(this.env, itemId);
    });

    // Step 4: DeepSeek 翻译 README（仅 readme_lang != 'zh' 时实际跑）
    await step.do('translate-readme', RETRY, async () => {
      return await translateGithubReadmeForItem(this.env, itemId);
    });

    // Step 5: 重算 daily_rank（包含当前 item 在内的当天所有 is_relevant=1 / 非 sponsor 行）
    await step.do('recompute-daily-rank', RETRY, async () => {
      return await recomputeGithubDailyRank(this.env);
    });

    // Step 6: 统一 workflow 完整性 gate(2026-05-21)
    // /api/items?source_type=github feed 在 WORKFLOW_COMPLETED_FILTER='true' 时滤掉
    // workflow_completed_at IS NULL 的半成品。is_relevant=0 早退不 mark。
    await step.do('mark-completed', RETRY, async () => {
      await this.env.DB.prepare(
        `UPDATE items SET extra = json_set(coalesce(extra,'{}'), '$.workflow_completed_at', ?) WHERE id = ?`,
      ).bind(new Date().toISOString(), itemId).run();
    });

    // Step 7: 内容最终态（relevant + 翻译/封面/rank 齐）→ 生成/覆盖 item 静态页（非阻塞容错）。
    await step.do('sync-item-page', RETRY, () =>
      syncItemPageOnEnrichDone(this.env, itemId, true),
    );

    return { itemId, classified: 'relevant' as const };
  }
}
