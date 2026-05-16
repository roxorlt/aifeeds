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

    // is_relevant=0 早退，省 step 3-5
    if (llm.is_relevant !== 1) {
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

    return { itemId, classified: 'relevant' as const };
  }
}
