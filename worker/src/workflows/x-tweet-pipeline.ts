// X 推文主链 Workflow(2026-05-17 重构)
// 设计:docs/plans/2026-05-17-x-workflow-redesign.html
// 落地计划:docs/plans/2026-05-17-x-workflow-rollout-plan.md
//
// 触发:worker/src/scrapebadger.ts runListPollIngest() 拉完 list 后对每条新 tweet
//      调 env.X_TWEET_PIPELINE_WORKFLOW.create({ params: { itemId, ... } })。
//
// 流程(2026-05-17 重构后):
//   step 0: backfill-truncated-text(治本 X DOM 140 字截断)
//   ↓
//   step 1 fan-out (并行): backfill-quote | backfill-reply | backfill-retweet | check-longform
//   ↓
//   step 2: longform-via-sb (条件)
//   ↓
//   step 3: classify-translate (1 次 DeepSeek JSON Mode 调用,合并判定 + 翻译 6 字段)
//   ↓
//   step 4: mark-completed (写 extra.workflow_completed_at 完整性 gate)
//
// 关键改造点:
// - 删了老 step 1 classify 早退(后置合并到 step 3 一次调用)
// - step 1 加 backfill-retweet(之前缺失 → retweet 显示转发者 bug 根源)
// - 老 step 4 翻译 6 字段(6 次 DeepSeek)合并成 step 3 一次 JSON Mode 调用(降本 ~87%)
// - 新加完整性 gate(/api/items 默认 SQL filter workflow_completed_at IS NOT NULL)

import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../index';
import {
  backfillQuoteForXTweet,
  backfillReplyForXTweet,
  backfillRetweetForXTweet,
  checkLongformForXTweet,
  fetchLongformViaScrapeBadger,
  backfillTruncatedTextForXTweet,
  backfillMediaForXTweet,
  backfillLinkCardForXTweet,
  backfillNestedXQuoteForXTweet,
  classifyAndTranslateForXTweet,
} from '../enrich';

interface XTweetParams {
  itemId: string;
  // Phase 1 ingest 时已知的提示信号（fan-out 时省 D1 re-read 决定条件）
  hasQuoteRef: boolean;
  hasReplyRef: boolean;
  hasLinkCard: boolean;
  hasRetweetRef: boolean;  // task #6 retweet snapshot 翻译覆盖
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

    // ─── Step 0: backfill truncated text via syndication ─────────
    // 2026-05-17 治本：SB list-poll mode 不返 full_text，ingest 时拿到 X list 页
    // DOM 140 字截断版（末尾 …）。classify / translate 看到截断内容时质量差，
    // feed 显示也是截断。在 classify 之前调 syndication API 补全完整 text，
    // downstream step 看到的就是 full content。
    // 异常（fetchTweet network 失败 etc）走 RETRY 兜底；syndication 404 标
    // fetch_error 不阻塞 pipeline（继续跑 classify 截断版聊胜于无）。
    await step.do('backfill-truncated-text', RETRY, () =>
      backfillTruncatedTextForXTweet(this.env, itemId),
    );

    const { hasQuoteRef, hasReplyRef, hasRetweetRef, lang } = event.payload;

    // ─── Step 1 fan-out (并行)：关联数据回填 + longform check ──
    // 2026-05-17 重构:删了老 step 1 classify 早退(后置合并到 step 3 一次 DeepSeek 调用)。
    // 不相关推文也跑 backfill(syndication 免费 API,latency 反而比老 workflow 短)。
    // hasXxxRef 信号控制条件跑,避免无谓 syndication traffic。
    // backfillQuote 同时会写 link_card(syndication API 同 response 顺便拿到)。
    // 新加 backfill-retweet:之前缺失导致 retweet 显示转发者而非原作者(2026-05-17 retweet bug 根源)。
    // 2026-05-17 加 backfill-media 第 5 并行 + backfill-link-card 第 6 并行 step:
    // user 反馈 X 有图片/视频但 aifeeds media=[] / 有外链但无 preview card。
    // - backfill-media:syndication API 返完整 mediaDetails(photo + video mp4)
    // - backfill-link-card:扫 content 内 t.co URL → redirect → 抓 OG meta 写 link_card
    // 两个 step 都无条件每条跑(各自标记防重复)。
    // 2026-05-18 加 backfill-nested-x-quote 第 7 并行 step:
    // 当正文里嵌 x.com URL(SB ingest 没识别为 quote)时,提取 status_id 写 quote_of_id
    // + inline 调 backfillQuote 拉完整原推数据(含 media + 翻译走 step 3)。
    const [, , , , , , longform] = await Promise.all([
      hasQuoteRef
        ? step.do('backfill-quote', RETRY, () => backfillQuoteForXTweet(this.env, itemId))
        : Promise.resolve(null),
      hasReplyRef
        ? step.do('backfill-reply', RETRY, () => backfillReplyForXTweet(this.env, itemId))
        : Promise.resolve(null),
      hasRetweetRef
        ? step.do('backfill-retweet', RETRY, () => backfillRetweetForXTweet(this.env, itemId))
        : Promise.resolve(null),
      step.do('backfill-media', RETRY, () => backfillMediaForXTweet(this.env, itemId)),
      step.do('backfill-link-card', RETRY, () => backfillLinkCardForXTweet(this.env, itemId)),
      step.do('backfill-nested-x-quote', RETRY, () => backfillNestedXQuoteForXTweet(this.env, itemId)),
      step.do('check-longform', RETRY, () => checkLongformForXTweet(this.env, itemId)),
    ]);

    // ─── Step 2: longform fetch via ScrapeBadger (条件) ──────────
    if (longform && (longform as { is_longform: boolean }).is_longform) {
      await step.do('longform-via-sb', RETRY, () =>
        fetchLongformViaScrapeBadger(this.env, itemId),
      );
    }

    // ─── Step 3: classify + translate 合并调用 (JSON Mode 1 次) ──
    // 2026-05-17 重构:合并 classifyXTweetWithLlm + translateXTweetField × 6 = 7 次调用 → 1 次。
    // is_relevant=0 时 DeepSeek 内部判断不返翻译,output token 节省。
    // 失败时函数内 retry 1 次,仍失败标 extra.translation_failed_at,不阻塞 workflow。
    const classifyTrans = await step.do('classify-translate', RETRY, () =>
      classifyAndTranslateForXTweet(this.env, itemId, { lang }),
    );

    // ─── Step 4: 完整性 gate ─────────────────────────────────────
    // 通过条件:classify-translate 未 failed(代表 is_relevant 已写入 +
    // 翻译已完成或源是中文 + 关联字段已 backfill)。failed=true 时不标 completed,
    // /api/items 默认 SQL filter `workflow_completed_at IS NOT NULL` 会过滤掉,
    // 等下次 retry(用户也可以点译文按钮触发 /api/items/:id/translate-now)。
    if (!classifyTrans.failed) {
      const nowIso = new Date().toISOString();
      await step.do('mark-completed', RETRY, async () => {
        await this.env.DB.prepare(
          `UPDATE items
              SET extra = json_set(coalesce(extra, '{}'), '$.workflow_completed_at', ?)
            WHERE id = ?`,
        ).bind(nowIso, itemId).run();
      });
    }

    return {
      itemId,
      is_relevant: classifyTrans.is_relevant,
      fields_translated: classifyTrans.fields_translated,
      completed: !classifyTrans.failed,
    };
  }
}

