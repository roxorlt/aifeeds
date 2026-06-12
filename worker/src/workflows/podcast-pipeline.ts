// AI 播客抓取链 Workflow(每个新 stub 一个 instance)。
//
// 设计文档：docs/plans/2026-06-09-ai-vendor-feeds-source-design.md §8.1 / §8.3 / §8.4。
// 模板对齐 worker/src/workflows/blog-pipeline.ts(同一套 feeds/ 库 + 成本契约)。
//
// 与 blog 的差异(§8.3)：
//   - 无「回原文抓全文」step(播客正文成本在音频，v1 不 ASR)；step3 改为「取原生文字稿」——
//     A 档 5 源解析 <podcast:transcript> 文件 / Substack 全文 / Lex show-page；B/C 档无稿(source='none')。
//   - 音频绝不迁 R2(§9.1)；step4 只迁封面(migrateCoverForPodcast)。
//   - eager 翻译 = shownotes_zh(classifyAndTranslateForFeeds)；transcript_text_zh 是 lazy / best-effort。
//
// 廉价 is_ai gate 仍在抓稿之前(§8.1)：高置信不相关早退；薄 shownotes / borderline 放行，
//   有 A 档文字稿则 step3 后用全文复判终判，无文字稿默认放行(收 > 漏)。
// 三种终态(relevant / irrelevant / dedup-suppressed)全部写 extra.workflow_completed_at；
//   隐藏靠业务 filter(relevant=1 + dedup_of IS NULL)，不靠不写 gate(§5.5 根因)。

import {
  WorkflowEntrypoint,
  WorkflowEvent,
  WorkflowStep,
} from 'cloudflare:workers';
import type { Env } from '../index';
import type { PodcastPipelineParams } from '../feeds/types';
import {
  isAiGate,
  reclassifyOnFulltext,
  classifyAndTranslateForFeeds,
  translateBodyMarkdown,
  classifySensitivityForFeeds,
} from '../feeds/classify-translate';
import {
  dedupL1,
  markIrrelevantCompleted,
  suppressDupCompleted,
  markCompleted,
} from '../feeds/dedup';
import { migrateCoverForPodcast, migrateAudioForPodcast } from '../feeds/media-r2';
import { fetchNativeTranscriptForPodcast } from '../podcast';

const RETRY = {
  retries: {
    limit: 3,
    delay: '10 seconds',
    backoff: 'exponential',
  },
  timeout: '5 minutes',
} as const;

export class PodcastPipelineWorkflow extends WorkflowEntrypoint<
  Env,
  PodcastPipelineParams
> {
  async run(event: WorkflowEvent<PodcastPipelineParams>, step: WorkflowStep) {
    const { itemId, hasNativeTranscript, lang } = event.payload;

    // Step 0：确保 shownotes 非空(gate 质量依赖它)。feed 多数已给；只有标题时从透传 RSS HTML 兜底(无网络)。
    await step.do('ensure-shownotes', RETRY, () =>
      ensureShownotesForPodcast(this.env, itemId),
    );

    // Step 1：廉价 is_ai gate(flash，title+shownotes)。Lex 这类大量非 AI 选题尤其需要。
    //   高置信不相关 → 落停止游标早退；高置信相关 → 写 is_relevant=1(供 step2 去重)；
    //   borderline / 低置信 → 不终判，放行到 step3 后复判(或无稿默认放行)。
    const cls = await step.do('quick-classify', RETRY, () =>
      quickClassifyForPodcast(this.env, itemId),
    );
    const highConfidentRelevant =
      cls.is_relevant === 1 && cls.confidence === 'high';
    if (cls.is_relevant === 0 && cls.confidence === 'high') {
      await step.do('mark-irrelevant-gate', RETRY, () =>
        markIrrelevantCompleted(this.env, itemId),
      );
      return { itemId, is_relevant: 0 as const, completed: true };
    }

    // Step 2：跨源去重(v1 仅 L1 url_hash 精确)。周报类播客与博客/GitHub 高度重叠，同 URL 命中即隐藏次源。
    //   dedupL1 内部要求 is_relevant=1，故只对「高置信相关」生效；borderline(is_relevant=NULL)早退跳过。
    const dd = await step.do('dedup', RETRY, () => dedupL1(this.env, itemId));
    if (dd.dup && dd.winner) {
      await step.do('suppress-dup', RETRY, () =>
        suppressDupCompleted(
          this.env,
          itemId,
          dd.winner as string,
          dd.reason || 'l1_same_url',
        ),
      );
      return {
        itemId,
        is_relevant: 1 as const,
        dedup_of: dd.winner,
        completed: true,
      };
    }

    // Step 3：取原生文字稿(A 档 5 源；文件 fetch + 解析 VTT/SRT/JSON / Substack 全文，**无 ASR**)。
    //   永不 throw(失败标 transcript_source 降级，gate 不受阻)；B/C 档不进此 step。
    if (hasNativeTranscript) {
      await step.do('fetch-transcript', RETRY, () =>
        fetchNativeTranscriptForPodcast(this.env, itemId),
      );
    }

    // borderline 复判：有 A 档文字稿 → 用全文终判 is_relevant；无文字稿 → 默认放行(收 > 漏)。
    if (!highConfidentRelevant) {
      if (hasNativeTranscript) {
        const recheck = await step.do('reclassify-fulltext', RETRY, () =>
          reclassifyOnFulltext(this.env, itemId, 'podcast'),
        );
        if (recheck.is_relevant !== 1) {
          await step.do('mark-irrelevant-fulltext', RETRY, () =>
            markIrrelevantCompleted(this.env, itemId),
          );
          return { itemId, is_relevant: 0 as const, completed: true };
        }
      } else {
        // 无原生文字稿的 borderline：默认放行(§8.3「收 > 漏」)。必须显式落 is_relevant=1，
        // 否则停留 NULL 会被 /api/items 的 relevant=1 过滤挡在 feed 外。
        await step.do('accept-borderline', RETRY, () =>
          acceptBorderlinePodcast(this.env, itemId),
        );
      }
    }

    // Step 4：fan-out 并行(各自 json_set 只动自己字段，防 lost-update)。
    //   - migrate-cover-r2：单集封面 + publisher logo 迁 R2(marker podcast_media_r2_at；音频绝不碰)
    //   - enrich-translate：合并 category + ai_summary_zh(ELI25) + title_zh + shownotes_zh，**不再判 is_relevant**
    //   - translate-transcript：lazy 全文 ELI25 翻译(仅 A 档有稿；best-effort，不阻塞 gate)
    const fan = await Promise.all([
      step.do('migrate-cover-r2', RETRY, () =>
        migrateCoverForPodcast(this.env, itemId),
      ),
      step.do('enrich-translate', RETRY, () =>
        classifyAndTranslateForFeeds(this.env, itemId, { lang, kind: 'podcast' }),
      ),
      hasNativeTranscript
        ? step.do('translate-transcript', RETRY, () =>
            translateBodyMarkdown(this.env, itemId, { lang, kind: 'podcast' }),
          )
        : Promise.resolve({ enrichFailed: false }),
      // 音频流式迁 R2(2026-06-12 #3,推翻原「绝不迁」决策):30-200MB 流式直传 R2,
      // /r/ 已支持 Range seek;无长度/超 250MB/失败 → 保留原 enclosure 直链兜底,不阻塞 gate。
      step.do('migrate-audio-r2', RETRY, () =>
        migrateAudioForPodcast(this.env, itemId),
      ),
      // 涉华敏感判定(2026-06-12 合规,**无条件每条必经**):此前只挂 borderline 复判,
      // 高置信 relevant 跳过 → 裸奔到手动回填(自测用例暴露)。全文/shownotes 依据。
      step.do('classify-cn-sensitive', RETRY, () =>
        classifySensitivityForFeeds(this.env, itemId, 'podcast'),
      ),
    ]);
    // ⚠️ 完整性 gate 条件 = enrich + eager(shownotes)翻译成功(fan[1])，**不是** transcript 翻译。
    // §8.3 代码字面 gate 在 transTrans(transcript 翻译)是 doc bug：§4 明确 transcript 是 lazy，
    // 其失败不应把单集挡出 feed(抽屉降级显原稿/原 shownotes)。对齐 blog-pipeline.ts + §4 语义。
    const enrich = fan[1];
    // 合规 gate(2026-06-12):cn_sensitive 判定失败(null)不放行(NULL 会被下发过滤
    // 当通过)。不 markCompleted → backfill 兜底重跑自愈。
    const sens = fan[4];

    // Step 5：完整性 gate(文字稿有无不是 gate 条件——无稿也能上 feed 显 shownotes)。
    const ok = !enrich.enrichFailed && sens.cn_sensitive !== null;
    if (ok) {
      await step.do('mark-completed', RETRY, () =>
        markCompleted(this.env, itemId),
      );
    }
    return {
      itemId,
      is_relevant: 1 as const,
      completed: ok,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// step 实现(podcast-pipeline 独占；消费 feeds/ 库 + podcast.ts)
// ─────────────────────────────────────────────────────────────────────────────

interface ItemRow {
  title: string | null;
  content: string | null;
  extra: Record<string, unknown>;
}

async function loadItem(env: Env, itemId: string): Promise<ItemRow> {
  const row = await env.DB.prepare(
    `SELECT title, content, extra FROM items WHERE id = ?`,
  )
    .bind(itemId)
    .first<{
      title: string | null;
      content: string | null;
      extra: string | null;
    }>();
  if (!row) throw new Error(`podcast-pipeline: item not found ${itemId}`);
  let extra: Record<string, unknown> = {};
  try {
    extra = row.extra ? (JSON.parse(row.extra) as Record<string, unknown>) : {};
  } catch {
    /* ignore */
  }
  return { title: row.title, content: row.content, extra };
}

/**
 * Step 0：保证 extra.shownotes 非空(gate 质量依赖它)。
 * feed 多数已在 stub 时给了 shownotes；只有标题的源从透传的 RSS 正文 HTML 兜底(无网络)。
 */
async function ensureShownotesForPodcast(
  env: Env,
  itemId: string,
): Promise<{ ok: boolean }> {
  const it = await loadItem(env, itemId);
  const existing = String(it.extra.shownotes || it.content || '').trim();
  if (existing) return { ok: true };

  const rawHtml = String(it.extra.rss_content_html || '');
  const derived = htmlToText(rawHtml).slice(0, 1200);
  if (derived) {
    await env.DB.prepare(
      `UPDATE items SET extra = json_set(coalesce(extra,'{}'), '$.shownotes', ?) WHERE id = ?`,
    )
      .bind(derived, itemId)
      .run();
  }
  return { ok: true };
}

/**
 * Step 1：廉价 is_ai gate。isAiGate 只返回判定(不落库)，故此处据判定落 is_relevant：
 *   高置信相关 → is_relevant=1(供 step2 去重)；其余(含高置信不相关 / borderline)交给上层 run() 决策。
 */
async function quickClassifyForPodcast(
  env: Env,
  itemId: string,
): Promise<{ is_relevant: 0 | 1; confidence: 'high' | 'low' }> {
  const it = await loadItem(env, itemId);
  const excerpt = String(it.extra.shownotes || it.content || '').slice(0, 4000);
  const cls = await isAiGate(env, {
    title: String(it.title || ''),
    excerpt,
    kind: 'podcast',
  });
  if (cls.is_relevant === 1 && cls.confidence === 'high') {
    await env.DB.prepare(`UPDATE items SET is_relevant = 1 WHERE id = ?`)
      .bind(itemId)
      .run();
  }
  console.log(
    `[podcast-pipeline:gate] ${itemId}: is_relevant=${cls.is_relevant} conf=${cls.confidence}`,
  );
  return cls;
}

/**
 * borderline 且无原生文字稿时的「默认放行」：显式落 is_relevant=1(否则停留 NULL 进不了 feed)。
 */
async function acceptBorderlinePodcast(
  env: Env,
  itemId: string,
): Promise<{ ok: boolean }> {
  await env.DB.prepare(`UPDATE items SET is_relevant = 1 WHERE id = ?`)
    .bind(itemId)
    .run();
  console.log(`[podcast-pipeline:accept-borderline] ${itemId}: is_relevant=1(收>漏)`);
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// 内部小工具
// ─────────────────────────────────────────────────────────────────────────────

/** HTML → 纯文本(ensure-shownotes 兜底用)。 */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
