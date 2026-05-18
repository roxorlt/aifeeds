// HuggingFace Daily Papers 抓取链 Workflow
//
// 触发:worker/src/scrapers/hf-paper.ts runHfDailyFetch 拉完每日 50 paper 后,
//      对每条新 paper create instance(每 paper 独立 instance,fan-out 跨 CF 节点)
//
// 设计文档:docs/plans/2026-05-18-hf-daily-papers-source-design.md §4
// Phase 0.5 报告:docs/plans/_research/2026-05-18-hf-discussion-internal-data-recon.md

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../index';

import {
  refreshPaperDetailForHf,
  fetchArxivCategoriesForHf,
} from '../hf-paper/api';
import {
  backfillMediaForHfPaper,
  refreshGhStarForHfPaper,
} from '../hf-paper/media';
import {
  fetchAr5ivAndExtractFigureForHf,
  translateAr5ivForHfPaper,
} from '../hf-paper/ar5iv';
import {
  fetchDiscussionForHfPaper,
  translateDiscussionCommentsForHfPaper,
} from '../hf-paper/discussion';
import {
  analyzeDimensionForHfPaper,
  translateTitleSummaryForHfPaper,
  mergeDeepAnalysisForHfPaper,
  ALL_DIMENSIONS,
  type DimensionResult,
} from '../hf-paper/deep-analyze';

interface HfPaperParams {
  itemId: string;          // 'hf_paper:2605.13301'
  arxivId: string;         // '2605.13301'
  hasGhRepo: boolean;
  hasProjectPage: boolean;
  hasDiscussionId: boolean;
  lang: 'zh' | 'en';
}

const RETRY = {
  retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
  timeout: '5 minutes',
} as const;

// pro reasoning 单段可能 60-180s,留 10min 余量
const RETRY_PRO_LONG = {
  retries: { limit: 2, delay: '15 seconds', backoff: 'exponential' },
  timeout: '10 minutes',
} as const;

export class HfPaperPipelineWorkflow extends WorkflowEntrypoint<Env, HfPaperParams> {
  async run(event: WorkflowEvent<HfPaperParams>, step: WorkflowStep) {
    const { itemId, arxivId, hasGhRepo, hasDiscussionId, lang } = event.payload;

    // ────────────────────────────────────────────────────────────────
    // Step 0:数据补全 + arxiv categories per-paper 兜底(NEW #2)
    // ────────────────────────────────────────────────────────────────
    await step.do('refresh-paper-detail', RETRY, () =>
      refreshPaperDetailForHf(this.env, itemId, arxivId),
    );
    await step.do('fetch-arxiv-categories', RETRY, () =>
      fetchArxivCategoriesForHf(this.env, itemId, arxivId),
    );

    // ────────────────────────────────────────────────────────────────
    // Step 1:fan-out 并行(4 项)
    // ────────────────────────────────────────────────────────────────
    const [, , ar5ivResult, discussionResult] = await Promise.all([
      // 媒体迁移(thumbnail + submitter avatar 兜底)
      step.do('backfill-media-r2', RETRY, () =>
        backfillMediaForHfPaper(this.env, itemId),
      ),
      // GH star refresh(若 hasGhRepo)
      hasGhRepo
        ? step.do('refresh-gh-star', RETRY, () =>
            refreshGhStarForHfPaper(this.env, itemId),
          )
        : Promise.resolve(null),
      // ar5iv 全文抓取 + 论文首图提取 + R2 迁移(NEW #1)
      step.do('fetch-ar5iv-and-extract-figure', RETRY, () =>
        fetchAr5ivAndExtractFigureForHf(this.env, itemId, arxivId),
      ),
      // 评论抓取(svelte_ssr,Phase 0.5 验证)
      hasDiscussionId
        ? step.do('fetch-discussion', RETRY, () =>
            fetchDiscussionForHfPaper(this.env, itemId, arxivId),
          )
        : Promise.resolve(null),
    ]);

    // ────────────────────────────────────────────────────────────────
    // Step 2:翻译 ar5iv 段落 + 评论翻译(flash,跟 Step 3 fan-out 并行不必要,因为
    // 都不阻塞 Step 3 — 但 deep_analysis 的 ar5iv_excerpt 用 EN 原文不用译,
    // 所以 Step 2 真的可以跟 Step 3 并行。这里串行只是为了 wall-clock 可观察)
    // ────────────────────────────────────────────────────────────────
    if (ar5ivResult?.fetched && (ar5ivResult.paragraphs_count ?? 0) > 0) {
      await step.do('translate-ar5iv', RETRY, () =>
        translateAr5ivForHfPaper(this.env, itemId, arxivId, { lang }),
      );
    }
    if (discussionResult?.fetched && (discussionResult.comments_count ?? 0) > 0) {
      await step.do('translate-discussion-comments', RETRY, () =>
        translateDiscussionCommentsForHfPaper(this.env, itemId),
      );
    }

    // 在 Step 2 后再跑一次 backfill-media-r2(评论已抓到,评论者 avatar 迁 R2)
    // 第一次跑没评论数据,这次跑会 patch in
    if (discussionResult?.fetched && (discussionResult.comments_count ?? 0) > 0) {
      await step.do('backfill-comment-avatars-r2', RETRY, () =>
        backfillMediaForHfPaper(this.env, itemId),
      );
    }

    // ────────────────────────────────────────────────────────────────
    // Step 3:C 方案 — 8 段独立 pro reasoning fan-out + 1 次 flash translate
    //   wall-clock = max(单段耗时)≈ 60-180s
    // ────────────────────────────────────────────────────────────────
    const [
      tldrResult,
      problemResult,
      keyInsightResult,
      methodResult,
      experimentsResult,
      industryImpactResult,
      codeStatusResult,
      limitationsAndNoveltyResult,
      titleSummaryResult,
    ] = await Promise.all([
      step.do('analyze-tldr', RETRY_PRO_LONG, () =>
        analyzeDimensionForHfPaper(this.env, itemId, arxivId, 'tldr'),
      ),
      step.do('analyze-problem', RETRY_PRO_LONG, () =>
        analyzeDimensionForHfPaper(this.env, itemId, arxivId, 'problem'),
      ),
      step.do('analyze-key-insight', RETRY_PRO_LONG, () =>
        analyzeDimensionForHfPaper(this.env, itemId, arxivId, 'key_insight'),
      ),
      step.do('analyze-method', RETRY_PRO_LONG, () =>
        analyzeDimensionForHfPaper(this.env, itemId, arxivId, 'method'),
      ),
      step.do('analyze-experiments', RETRY_PRO_LONG, () =>
        analyzeDimensionForHfPaper(this.env, itemId, arxivId, 'experiments'),
      ),
      step.do('analyze-industry-impact', RETRY_PRO_LONG, () =>
        analyzeDimensionForHfPaper(this.env, itemId, arxivId, 'industry_impact'),
      ),
      step.do('analyze-code-status', RETRY_PRO_LONG, () =>
        analyzeDimensionForHfPaper(this.env, itemId, arxivId, 'code_status'),
      ),
      step.do('analyze-limitations-novelty', RETRY_PRO_LONG, () =>
        analyzeDimensionForHfPaper(this.env, itemId, arxivId, 'limitations_and_novelty'),
      ),
      step.do('translate-title-summary', RETRY, () =>
        translateTitleSummaryForHfPaper(this.env, itemId),
      ),
    ]);

    const allDimensions: DimensionResult[] = [
      tldrResult, problemResult, keyInsightResult, methodResult,
      experimentsResult, industryImpactResult, codeStatusResult, limitationsAndNoveltyResult,
    ];

    // ────────────────────────────────────────────────────────────────
    // Step 3 合并:写入 extra.deep_analysis + title_zh/summary_zh/ai_summary_zh
    // ────────────────────────────────────────────────────────────────
    const mergeResult = await step.do('merge-deep-analysis', RETRY, () =>
      mergeDeepAnalysisForHfPaper(this.env, itemId, {
        dimensions: allDimensions,
        titleSummary: titleSummaryResult.data,
      }),
    );

    // ────────────────────────────────────────────────────────────────
    // Step 4:完整性 gate
    //   - title/summary 翻译失败 → 不写 workflow_completed_at,FE 看到半成品
    //   - 8 段允许 ≤2 段失败(deep_analysis 部分缺失可以接受)
    //   - 全失败 → 不写 completed,backfill cron 30min 后重 trigger
    // ────────────────────────────────────────────────────────────────
    const failedDims = mergeResult.failed_dimensions.length;
    const titleSummaryOk = !titleSummaryResult.failed && titleSummaryResult.data !== null;
    const isComplete = titleSummaryOk && failedDims <= 2;

    if (isComplete) {
      const nowIso = new Date().toISOString();
      await step.do('mark-completed', RETRY, async () => {
        await this.env.DB.prepare(
          `UPDATE items SET extra = json_set(coalesce(extra, '{}'), '$.workflow_completed_at', ?)
            WHERE id = ?`,
        ).bind(nowIso, itemId).run();
      });
    }

    return {
      itemId,
      arxivId,
      completed: isComplete,
      failed_dimensions: mergeResult.failed_dimensions,
      title_summary_ok: titleSummaryOk,
      total_dimensions: ALL_DIMENSIONS.length,
    };
  }
}
