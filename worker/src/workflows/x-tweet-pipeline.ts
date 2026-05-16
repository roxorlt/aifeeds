// X 推文主链 Workflow — 替换 6 个 preempt cron mode（classify-pending /
// fill-translations / backfill-quotes / backfill-replies / detect-longform /
// longform-via-sb）。设计：docs/plans/2026-05-16-x-main-pipeline-workflows-design.md
//
// 触发：worker/src/scrapebadger.ts runListPollIngest() 拉完 list 后对每条
//       新 tweet 调 env.X_TWEET_PIPELINE_WORKFLOW.create({ params: { itemId, ... } })。
//
// 流程（按设计 doc）：
//   step 1: classify-with-llm
//   ↓ is_relevant=0 早退
//   step 2 fan-out (并行): backfill-quote | backfill-reply | check-longform
//   ↓
//   step 3: longform-via-sb (条件)
//   ↓
//   step 4 fan-out (并行): translate-content | translate-quote | translate-link-card |
//                          translate-reply | translate-retweet
//
// 当前实施状态（增量交付）：
//   ✅ step 1 classify
//   ⏳ step 2-5 待补（next PR turns）

import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../index';
import {
  classifyXTweetWithLlm,
  backfillQuoteForXTweet,
  backfillReplyForXTweet,
  checkLongformForXTweet,
  fetchLongformViaScrapeBadger,
} from '../enrich';

interface XTweetParams {
  itemId: string;
  // Phase 1 ingest 时已知的提示信号（fan-out 时省 D1 re-read 决定条件）
  hasQuoteRef: boolean;
  hasReplyRef: boolean;
  hasLinkCard: boolean;
  // i18n 友好（task #7）：暂硬编码 'zh'，未来扩多语言时不改 schema
  lang: 'zh' | 'en' | 'ja';
}

const RETRY = {
  retries: {
    limit: 3,
    delay: '10 seconds',
    backoff: 'exponential',
  },
  timeout: '5 minutes',
} as const;

export class XTweetPipelineWorkflow extends WorkflowEntrypoint<Env, XTweetParams> {
  async run(event: WorkflowEvent<XTweetParams>, step: WorkflowStep) {
    const { itemId } = event.payload;

    // ─── Step 1: classify ────────────────────────────────────────
    const cls = await step.do('classify-with-llm', RETRY, async () => {
      return await classifyXTweetWithLlm(this.env, itemId);
    });

    if (cls.is_relevant !== 1) {
      return { itemId, classified: 'irrelevant' as const };
    }

    const { hasQuoteRef, hasReplyRef } = event.payload;

    // ─── Step 2 fan-out (并行)：backfill quote / reply + check longform ──
    // backfillQuote 同时会写 link_card（syndication API 同 response 顺便拿到）。
    // hasQuoteRef / hasReplyRef 是 Phase 1 ingest 时的 SB API 信号；hasQuoteRef
    // 为 false 时跳过 syndication 调用，避免无谓 traffic。check-longform 始终跑。
    const [, , longform] = await Promise.all([
      hasQuoteRef
        ? step.do('backfill-quote', RETRY, () => backfillQuoteForXTweet(this.env, itemId))
        : Promise.resolve(null),
      hasReplyRef
        ? step.do('backfill-reply', RETRY, () => backfillReplyForXTweet(this.env, itemId))
        : Promise.resolve(null),
      step.do('check-longform', RETRY, () => checkLongformForXTweet(this.env, itemId)),
    ]);

    // ─── Step 3: longform fetch via ScrapeBadger (条件) ──────────
    if (longform && longform.is_longform) {
      await step.do('longform-via-sb', RETRY, () =>
        fetchLongformViaScrapeBadger(this.env, itemId),
      );
    }

    // ⏳ TODO step 4 fan-out (translate content / quote / link_card / reply / retweet)
    // 当前只实现 step 1-3，部 staging 验证 longform 条件路径。

    return { itemId, classified: 'relevant' as const };
  }
}
