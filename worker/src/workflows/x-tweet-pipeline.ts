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
  resolveTcoLinksForXTweet,
  fetchXArticlesForXTweet,
  fetchXArticleBodiesForXTweet,
  translateXArticlesForXTweet,
  classifyAndTranslateForXTweet,
} from '../enrich';
import { migrateXMediaForItem } from '../x-media-r2';

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

// 2026-05-18 step callback wrapper:永不 throw,避免 CF runtime 标 outcome=exception。
// step.do RETRY 内 callback throw → CF 报 worker outcome=exception(每 retry attempt 一次)。
// 即使 caller Promise.allSettled wrap,attempt-level exception 仍计入 OPS 错误率。
// safeStep 让 callback return null on error,step.do 拿到 success → 永不 throw。
async function safeStep<T>(
  name: string,
  itemId: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    console.warn(`[step-safe:${name}] ${itemId}: caught ${String(e).slice(0, 200)}`);
    return null;
  }
}

export class XTweetPipelineWorkflow extends WorkflowEntrypoint<Env, XTweetParams> {
  async run(event: WorkflowEvent<XTweetParams>, step: WorkflowStep) {
    const { itemId } = event.payload;

    // 2026-05-18 outer try wrap whole run() body:终极兜底防 CF 标 instance "exception"。
    // 任何内部 step 即使 RETRY 用尽 throw,outer catch 后 return 成功 result,
    // CF Workflow instance outcome = "ok",worker scriptThrewException 不计入。
    // 该失败的字段已经被各 backfill 函数 + try wrap 内 log + 跳过,数据缺失不阻塞 workflow。
    try {
      return await this.runInner(event, step);
    } catch (e) {
      console.error(`[x-workflow] uncaught at run() level for ${itemId}: ${String(e).slice(0, 500)}`);
      return {
        itemId,
        is_relevant: 0 as const,
        fields_translated: [] as string[],
        completed: false,
        uncaught_error: String(e).slice(0, 200),
      };
    }
  }

  async runInner(event: WorkflowEvent<XTweetParams>, step: WorkflowStep) {
    const { itemId } = event.payload;

    // ─── Step 0: backfill truncated text via syndication ─────────
    // 2026-05-17 治本：SB list-poll mode 不返 full_text，ingest 时拿到 X list 页
    // DOM 140 字截断版（末尾 …）。classify / translate 看到截断内容时质量差，
    // feed 显示也是截断。在 classify 之前调 syndication API 补全完整 text，
    // downstream step 看到的就是 full content。
    // 异常（fetchTweet network 失败 etc）走 RETRY 兜底；syndication 404 标
    // fetch_error 不阻塞 pipeline（继续跑 classify 截断版聊胜于无）。
    await step.do('backfill-truncated-text', RETRY, () =>
      safeStep('backfill-truncated-text', itemId, () => backfillTruncatedTextForXTweet(this.env, itemId)),
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
    // 2026-05-18 fix uncaught exception:Promise.all → Promise.allSettled
    // 之前任一 step throw → Promise.all reject → workflow run() uncaught exception
    // → CF 报 scriptThrewException(67% error rate)。
    // allSettled 让每个 step 独立结果,某个 fail 不影响其他 + 不阻塞 workflow 整体 completion。
    const results = await Promise.allSettled([
      hasQuoteRef
        ? step.do('backfill-quote', RETRY, () => safeStep('backfill-quote', itemId, () => backfillQuoteForXTweet(this.env, itemId)))
        : Promise.resolve(null),
      hasReplyRef
        ? step.do('backfill-reply', RETRY, () => safeStep('backfill-reply', itemId, () => backfillReplyForXTweet(this.env, itemId)))
        : Promise.resolve(null),
      hasRetweetRef
        ? step.do('backfill-retweet', RETRY, () => safeStep('backfill-retweet', itemId, () => backfillRetweetForXTweet(this.env, itemId)))
        : Promise.resolve(null),
      step.do('backfill-media', RETRY, () => safeStep('backfill-media', itemId, () => backfillMediaForXTweet(this.env, itemId))),
      step.do('backfill-link-card', RETRY, () => safeStep('backfill-link-card', itemId, () => backfillLinkCardForXTweet(this.env, itemId))),
      step.do('backfill-nested-x-quote', RETRY, () => safeStep('backfill-nested-x-quote', itemId, () => backfillNestedXQuoteForXTweet(this.env, itemId))),
      step.do('check-longform', RETRY, () => safeStep('check-longform', itemId, () => checkLongformForXTweet(this.env, itemId))),
    ]);
    // log fail step 便于排查,但不阻塞继续
    for (const [idx, r] of results.entries()) {
      if (r.status === 'rejected') {
        const stepNames = ['backfill-quote', 'backfill-reply', 'backfill-retweet', 'backfill-media', 'backfill-link-card', 'backfill-nested-x-quote', 'check-longform'];
        console.warn(`[x-workflow:${stepNames[idx]}] ${itemId}: step rejected after RETRY: ${String(r.reason).slice(0, 200)}`);
      }
    }
    // check-longform 是 index 6,只在它 fulfilled 时取值
    const longformResult = results[6];
    const longform = longformResult.status === 'fulfilled' ? longformResult.value : null;

    // ─── Step 1.5: resolve t.co shortlinks ───────────────────────
    // 2026-05-21:fan-out 之后跑,确保 quote_of / reply_of / retweet_of 已写入。
    // 扫 L1/L2/L3 共 6 个 path 哪些 content 是裸 t.co,HEAD resolve 写
    // content_resolved_url。failed 也标 failed_at 防重试。
    await step.do('resolve-tco-links', RETRY, () =>
      safeStep('resolve-tco-links', itemId, () => resolveTcoLinksForXTweet(this.env, itemId)),
    );

    // ─── Step 1.6: fetch X article content (PR5) ────────────────
    // 2026-05-21:跟 1.5 串行,扫 6 path 哪些 content_resolved_url 是 /i/article/<id>,
    // 调 SB 拿 article detail + author search,写 extra.{path}.x_article。
    // 失败 graceful:写 fetch_failed_at,FE 降级 link card。
    // 老 article(SB 反索引)detail null 但 author 仍可拿。
    await step.do('fetch-x-articles', RETRY, () =>
      safeStep('fetch-x-articles', itemId, () => fetchXArticlesForXTweet(this.env, itemId)),
    );

    // ─── Step 1.65: fetch X article body (PR6, 2026-05-22) ──────
    // 走 X GraphQL TweetResultByRestId 拉 article.plain_text(login-gated)。
    // 风控:cookie 失效/rate limit/日 cap 撞顶 → graceful return,不阻塞 1.7 翻译。
    // 没 cookie / KV 未配 → 静默 skip,workflow 继续。
    // 6 path 都跑(日 cap 50 vs 日新 ~10-30 article tweet × ~1-2 path 平均 = 余量大)。
    await step.do('fetch-x-article-bodies', RETRY, () =>
      safeStep('fetch-x-article-bodies', itemId, () => fetchXArticleBodiesForXTweet(this.env, itemId)),
    );

    // ─── Step 1.7: translate X article fields (PR5/6 follow-up) ────
    // 2026-05-21:1.6 抓到的 article title / excerpt 大多英文,翻成中文供 FE
    // Rich card 显示一致体验。
    // 2026-05-22 PR6:加翻 body 字段。单 task 单 DeepSeek call,max_tokens 8000。
    // 失败 graceful:写 translate_failed_at,FE 渲染时降级到原文。
    await step.do('translate-x-articles', RETRY, () =>
      safeStep('translate-x-articles', itemId, () => translateXArticlesForXTweet(this.env, itemId)),
    );

    // ─── Step 2: longform fetch via ScrapeBadger (条件) ──────────
    // 2026-05-18 fix:longform fetch 也包 try 防 throw 阻塞 step 3
    if (longform && (longform as { is_longform: boolean }).is_longform) {
      await step.do('longform-via-sb', RETRY, () =>
        safeStep('longform-via-sb', itemId, () => fetchLongformViaScrapeBadger(this.env, itemId)),
      );
    }

    // ─── Step 2.5: X 媒体 → R2 缓存 ──────────────────────────────
    // 2026-06-04 P0(docs/plans/2026-06-04-x-card-render-api.md):fan-out + longform 之后,
    // 头像/媒体/嵌套(quote_of/retweet_of)字段都已 backfill 完整,把 twimg 资源缓存进 R2、
    // 就地改写为 /r/x/...。
    // 位置考究:① 放 classify-translate(step3)之前 —— step3 是 extra 整体读改写,
    // 串行 await 保证它读到的是已改写成 /r/ 的 extra,不会覆盖回 twimg;
    // ② 放 mark-completed(step4)之前 —— 下发时媒体已是稳定 https 链接,不会先露 twimg 死链。
    // 幂等:migrateXMediaForItem 见 x_media_r2_at 已设则早退,retry 安全。
    await step.do('x-media-r2', RETRY, () =>
      safeStep('x-media-r2', itemId, () => migrateXMediaForItem(this.env, itemId)),
    );

    // ─── Step 3: classify + translate 合并调用 (JSON Mode 1 次) ──
    // 2026-05-17 重构:合并 classifyXTweetWithLlm + translateXTweetField × 6 = 7 次调用 → 1 次。
    // is_relevant=0 时 DeepSeek 内部判断不返翻译,output token 节省。
    // 失败时函数内 retry 1 次,仍失败标 extra.translation_failed_at,不阻塞 workflow。
    // 2026-05-18 fix:外层 try wrap 防 step.do RETRY 用完 throw 阻塞 step 4
    const classifyTransResult = await step.do('classify-translate', RETRY, () =>
      safeStep('classify-translate', itemId, () => classifyAndTranslateForXTweet(this.env, itemId, { lang })),
    );
    const classifyTrans: { is_relevant: 0 | 1; fields_translated: string[]; attempts: number; failed?: string } =
      classifyTransResult || { is_relevant: 0, fields_translated: [], attempts: 0, failed: 'http' };

    // ─── Step 4: 完整性 gate ─────────────────────────────────────
    // 通过条件:classify-translate 未 failed(代表 is_relevant 已写入 +
    // 翻译已完成或源是中文 + 关联字段已 backfill)。failed=true 时不标 completed,
    // /api/items 默认 SQL filter `workflow_completed_at IS NOT NULL` 会过滤掉,
    // 等下次 retry(用户也可以点译文按钮触发 /api/items/:id/translate-now)。
    // 2026-05-18 fix:mark-completed 也 try 防 D1 偶发 throw 阻塞 return
    if (!classifyTrans.failed) {
      const nowIso = new Date().toISOString();
      await step.do('mark-completed', RETRY, () =>
        safeStep('mark-completed', itemId, async () => {
          await this.env.DB.prepare(
            `UPDATE items
                SET extra = json_set(coalesce(extra, '{}'), '$.workflow_completed_at', ?)
              WHERE id = ?`,
          ).bind(nowIso, itemId).run();
        }),
      );
    }

    return {
      itemId,
      is_relevant: classifyTrans.is_relevant,
      fields_translated: classifyTrans.fields_translated,
      completed: !classifyTrans.failed,
    };
  }
}

