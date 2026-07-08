// AI 厂商博客抓取链 Workflow(每个新 stub 一个 instance)。
//
// 设计文档：docs/plans/2026-06-09-ai-vendor-feeds-source-design.md §8.1 / §8.2 / §8.4。
// 模板对齐 worker/src/workflows/github-pipeline.ts + hf-paper-pipeline.ts。
//
// 核心成本契约(§8.1)：blog 全文抓取昂贵，所以「廉价 is_ai gate 在抓全文之前」——
//   step1 只用 title+excerpt 判 is_relevant，高置信不相关直接早退(不抓全文/不翻译/不渲染)；
//   薄摘要 / 低置信 borderline 放行，抓到全文后用全文复判终判(防薄摘要永久误杀好源)。
//
// 三种终态(relevant / irrelevant / dedup-suppressed)全部写 extra.workflow_completed_at
//   (与现网 X x-tweet-pipeline.ts:236 一致，gate 只看 !failed)；隐藏靠业务 filter
//   (relevant=1 + dedup_of IS NULL)，不靠不写 gate(§5.5 根因)。
//
// 每 step RETRY 3×10s 指数 + 5min timeout。

import {
  WorkflowEntrypoint,
  WorkflowEvent,
  WorkflowStep,
} from 'cloudflare:workers';
import type { Env } from '../index';
import type {
  BlogPipelineParams,
  FeedBodyMeta,
  FeedDef,
  FetchStrategy,
} from '../feeds/types';
import { getFeedDefByKey } from '../feeds/registry';
import { extractFullText, buildBlogPageMetaPatch } from '../feeds/extract';
import {
  isAiGate,
  reclassifyOnFulltext,
  classifyAndTranslateForFeeds,
  generateEventFingerprintForFeeds,
  translateBodyMarkdown,
  classifySensitivityForFeeds,
} from '../feeds/classify-translate';
import {
  dedupL1,
  markIrrelevantCompleted,
  suppressDupCompleted,
  markCompleted,
} from '../feeds/dedup';
import { migrateMediaForBlog } from '../feeds/media-r2';
import { syncItemPageOnEnrichDone } from '../seo/item-page-hook';

const RETRY = {
  retries: {
    limit: 3,
    delay: '10 seconds',
    backoff: 'exponential',
  },
  timeout: '5 minutes',
} as const;

export class BlogPipelineWorkflow extends WorkflowEntrypoint<
  Env,
  BlogPipelineParams
> {
  async run(event: WorkflowEvent<BlogPipelineParams>, step: WorkflowStep) {
    const { itemId, feedKey, fetchStrategy, lang, skipCnSensitive } = event.payload;

    // Step 0：确保至少有 title + excerpt(feed 多数已给；只有 title 时从 RSS 正文 HTML 兜底，无网络)。
    await step.do('ensure-excerpt', RETRY, () =>
      ensureExcerptForBlog(this.env, itemId),
    );

    // Step 1：廉价 is_ai gate(flash，只判 is_relevant + confidence，输入 title+excerpt)。
    //   只有「高置信不相关」才落停止游标早退；「高置信相关」写 is_relevant=1(供 step2 去重)；
    //   borderline / 低置信 → 不终判，放行到 step3 抓全文后复判。
    const cls = await step.do('quick-classify', RETRY, () =>
      quickClassifyForBlog(this.env, itemId),
    );
    const highConfidentRelevant =
      cls.is_relevant === 1 && cls.confidence === 'high';
    if (cls.is_relevant === 0 && cls.confidence === 'high') {
      await step.do('mark-irrelevant-gate', RETRY, () =>
        markIrrelevantCompleted(this.env, itemId),
      );
      await step.do('sync-item-page-gone', RETRY, () =>
        syncItemPageOnEnrichDone(this.env, itemId, false),
      );
      return { itemId, is_relevant: 0 as const, completed: true };
    }

    // Step 2：跨源去重(v1 仅 L1 url_hash 精确)。dedupL1 内部要求 is_relevant=1，
    //   故只对「高置信相关」(step1 已写 is_relevant=1)生效；borderline 此刻 is_relevant=NULL → 早退跳过。
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
      // dedup 次源被隐藏（relevant=1 但 dedup_of 非空）→ 不出独立页，下架兜底（非阻塞）。
      await step.do('sync-item-page-gone', RETRY, () =>
        syncItemPageOnEnrichDone(this.env, itemId, false),
      );
      return {
        itemId,
        is_relevant: 1 as const,
        dedup_of: dd.winner,
        completed: true,
      };
    }

    // Step 3：正文抓取(B5 升级阶梯；内部永不 throw，失败降级 RSS 摘要)+ 收集 assets(供 step4 迁 R2)。
    await step.do('fetch-body', RETRY, () =>
      fetchBodyForBlog(this.env, itemId, feedKey, fetchStrategy),
    );
    // step1 没给「高置信相关」→ 用抓到的全文终判 is_relevant(reclassifyOnFulltext 落库)。
    if (!highConfidentRelevant) {
      const recheck = await step.do('reclassify-fulltext', RETRY, () =>
        reclassifyOnFulltext(this.env, itemId, 'blog'),
      );
      if (recheck.is_relevant !== 1) {
        await step.do('mark-irrelevant-fulltext', RETRY, () =>
          markIrrelevantCompleted(this.env, itemId),
        );
        await step.do('sync-item-page-gone', RETRY, () =>
          syncItemPageOnEnrichDone(this.env, itemId, false),
        );
        return { itemId, is_relevant: 0 as const, completed: true };
      }
    }

    // Step 4：fan-out 并行(各自 json_set 只动自己字段，防 lost-update)。
    //   - migrate-media-r2：封面无条件 backfill + 正文图迁 R2(marker blog_media_r2_at)
    //   - enrich-translate：合并 category + ai_summary_zh(ELI25) + title_zh + excerpt_zh，**不再判 is_relevant**
    //   - translate-body：lazy 全文 ELI25 翻译(抓到 body 才有内容；best-effort，不阻塞 gate)
    const fan = await Promise.all([
      step.do('migrate-media-r2', RETRY, () =>
        migrateMediaForBlog(this.env, itemId),
      ),
      step.do('enrich-translate', RETRY, () =>
        classifyAndTranslateForFeeds(this.env, itemId, { lang, kind: 'blog' }),
      ),
      step.do('translate-body', RETRY, () =>
        translateBodyMarkdown(this.env, itemId, { lang, kind: 'blog' }),
      ),
      skipCnSensitive
        ? step.do('force-cn-sensitive-safe', RETRY, () =>
            forceCnSensitiveSafe(this.env, itemId),
          )
        : step.do('classify-cn-sensitive', RETRY, () =>
            classifySensitivityForFeeds(this.env, itemId, 'blog'),
          ),
      step.do('event-fingerprint', RETRY, () =>
        generateEventFingerprintForFeeds(this.env, itemId, { kind: 'blog' }),
      ),
    ]);
    // 完整性 gate 条件 = enrich + eager 翻译成功(§4「relevant 在 enrich + eager 翻译 done 后写」)；
    // 正文全文翻译是 lazy / best-effort，其失败不阻塞 item 上 feed(抽屉降级显原文)。
    const enrich = fan[1];
    // 合规 gate(2026-06-12):cn_sensitive 判定失败(null)不放行 —— 下发过滤把
    // NULL 当通过,放行即裸奔。不 markCompleted → backfill 兜底重跑自愈。
    const sens = fan[3];

    // Step 5：完整性 gate(正文完整度不是 gate 条件——抓不到全文也能上 feed 显摘要)。
    const ok = !enrich.enrichFailed && sens.cn_sensitive !== null;
    if (ok) {
      await step.do('mark-completed', RETRY, () =>
        markCompleted(this.env, itemId),
      );
      // 内容最终态（relevant + enrich/翻译/合规 gate 齐）→ 生成/覆盖 item 静态页（非阻塞容错）。
      // gate 未过（!ok，半成品）不出页，等 backfill 兜底。
      await step.do('sync-item-page', RETRY, () =>
        syncItemPageOnEnrichDone(this.env, itemId, true),
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
// step 实现(blog-pipeline 独占；消费 feeds/ 库)
// ─────────────────────────────────────────────────────────────────────────────

interface ItemRow {
  title: string | null;
  content: string | null;
  url: string | null;
  extra: Record<string, unknown>;
}

async function loadItem(env: Env, itemId: string): Promise<ItemRow> {
  const row = await env.DB.prepare(
    `SELECT title, content, url, extra FROM items WHERE id = ?`,
  )
    .bind(itemId)
    .first<{
      title: string | null;
      content: string | null;
      url: string | null;
      extra: string | null;
    }>();
  if (!row) throw new Error(`blog-pipeline: item not found ${itemId}`);
  let extra: Record<string, unknown> = {};
  try {
    extra = row.extra ? (JSON.parse(row.extra) as Record<string, unknown>) : {};
  } catch {
    /* ignore */
  }
  return { title: row.title, content: row.content, url: row.url, extra };
}

/**
 * Step 0：保证 extra.excerpt 非空(gate 质量依赖它)。
 * feed 多数已在 stub 时给了 excerpt；只有 title 的源从透传的 RSS 正文 HTML 兜底(无网络)。
 */
async function ensureExcerptForBlog(
  env: Env,
  itemId: string,
): Promise<{ ok: boolean }> {
  const it = await loadItem(env, itemId);
  const existing = String(it.extra.excerpt || it.content || '').trim();
  if (existing) return { ok: true };

  const rawHtml = String(it.extra.rss_content_html || '');
  const derived = htmlToText(rawHtml).slice(0, 600);
  if (derived) {
    await env.DB.prepare(
      `UPDATE items SET extra = json_set(coalesce(extra,'{}'), '$.excerpt', ?) WHERE id = ?`,
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
async function quickClassifyForBlog(
  env: Env,
  itemId: string,
): Promise<{ is_relevant: 0 | 1; confidence: 'high' | 'low' }> {
  const it = await loadItem(env, itemId);
  const excerpt = String(it.extra.excerpt || it.content || '').slice(0, 4000);
  const cls = await isAiGate(env, {
    title: String(it.title || ''),
    excerpt,
    kind: 'blog',
  });
  if (cls.is_relevant === 1 && cls.confidence === 'high') {
    await env.DB.prepare(`UPDATE items SET is_relevant = 1 WHERE id = ?`)
      .bind(itemId)
      .run();
  }
  console.log(
    `[blog-pipeline:gate] ${itemId}: is_relevant=${cls.is_relevant} conf=${cls.confidence}`,
  );
  return cls;
}

/**
 * Step 3：抓全文(extractFullText 永不 throw)+ 落 body_markdown / body meta(assets)/ reading_minutes，
 * 并清除透传的 rss_content_html(已被消费，避免 extra 膨胀)。本函数自身亦不 throw(失败留旧值，gate 不受阻)。
 */
async function fetchBodyForBlog(
  env: Env,
  itemId: string,
  feedKey: string,
  fetchStrategy: FetchStrategy,
): Promise<{ ok: boolean; source: FeedBodyMeta['source'] | 'skip' }> {
  try {
    const it = await loadItem(env, itemId);
    const canonicalUrl = String(it.extra.canonical_url || it.url || '');
    if (!canonicalUrl) return { ok: false, source: 'skip' };

    const feed: FeedDef =
      getFeedDefByKey('blog', feedKey) ?? synthFeed(feedKey, fetchStrategy, canonicalUrl);
    const rssContentHtml = it.extra.rss_content_html
      ? String(it.extra.rss_content_html)
      : undefined;

    const res = await extractFullText(env, {
      canonicalUrl,
      feed,
      fetchStrategy,
      rssContentHtml,
    });

    const bodyMeta: FeedBodyMeta = {
      source: res.source,
      extracted_at: new Date().toISOString(),
      assets: res.assets,
    };
    const readingMin = estimateReadingMinutes(
      res.body_markdown || String(it.extra.excerpt || ''),
    );

    // 写 body_markdown + body meta + reading_minutes，并删除已消费的 rss_content_html。
    await env.DB.prepare(
      `UPDATE items
          SET extra = json_remove(
                        json_set(coalesce(extra,'{}'),
                          '$.body_markdown', ?,
                          '$.body', json(?),
                          '$.reading_minutes', ?),
                        '$.rss_content_html')
        WHERE id = ?`,
    )
      .bind(res.body_markdown || '', JSON.stringify(bodyMeta), readingMin, itemId)
      .run();

    // 用详情页 og: 元数据补 cover（全部 blog 源，Fix 1）+ page-scrape 补 title / published_at。
    // 封面：native 源（如 The Verge）此前把抓到的 og:image 又丢弃，导致回退到「正文首图」
    //   （常是作者署名头像）——buildBlogPageMetaPatch 把 og:image 采用放开到所有策略（幂等，
    //   不覆盖已有合格 cover_image；随后 step4 migrateMediaForBlog 过质量门迁 R2）。
    if (res.meta) {
      const { sets, binds } = buildBlogPageMetaPatch(fetchStrategy, res.meta);
      if (sets.length > 0) {
        binds.push(itemId);
        try {
          await env.DB.prepare(`UPDATE items SET ${sets.join(', ')} WHERE id = ?`)
            .bind(...binds)
            .run();
        } catch (e) {
          console.error(`[blog-pipeline:body] ${itemId} page-meta update error`, e);
        }
      }
    }

    console.log(
      `[blog-pipeline:body] ${itemId}: source=${res.source} len=${(res.body_markdown || '').length} assets=${res.assets.length}`,
    );
    return { ok: true, source: res.source };
  } catch (e) {
    // 抓全文失败不阻塞 pipeline(降级摘要也能上 feed)。
    console.error(`[blog-pipeline:body] ${itemId}: error`, e);
    return { ok: false, source: 'skip' };
  }
}

async function forceCnSensitiveSafe(
  env: Env,
  itemId: string,
): Promise<{ cn_sensitive: 0 }> {
  await env.DB.prepare(
    `UPDATE items SET extra = json_set(coalesce(extra,'{}'), '$.cn_sensitive', 0) WHERE id = ?`,
  )
    .bind(itemId)
    .run();
  return { cn_sensitive: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// 内部小工具
// ─────────────────────────────────────────────────────────────────────────────

/** registry 查不到时(理论上不应发生)合成最小 FeedDef，只为给 extractFullText 提供 site_base/format。 */
function synthFeed(
  feedKey: string,
  fetchStrategy: FetchStrategy,
  canonicalUrl: string,
): FeedDef {
  let siteBase: string | undefined;
  try {
    siteBase = new URL(canonicalUrl).origin;
  } catch {
    siteBase = undefined;
  }
  return {
    id: `blog:${feedKey}`,
    key: feedKey,
    kind: 'blog',
    format: 'rss',
    source_company: '',
    name: '',
    region: 'foreign',
    via: 'native',
    feed_url: '',
    cadence_hours: 2,
    fetch_strategy: fetchStrategy,
    site_base: siteBase,
  };
}

/** HTML → 纯文本(ensure-excerpt 兜底用)。 */
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

/** 估算阅读时长(分钟)：CJK ~300 字/min + 拉丁 ~200 词/min；卡片 meta 用，替代缺失的互动数。 */
function estimateReadingMinutes(md: string): number {
  if (!md) return 1;
  const stripped = md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*`|!\[\]()_~-]/g, ' ');
  const cjk = (stripped.match(/[一-鿿]/g) || []).length;
  const words = (
    stripped.replace(/[一-鿿]/g, ' ').match(/[A-Za-z0-9]+/g) || []
  ).length;
  return Math.max(1, Math.round(cjk / 300 + words / 200));
}
