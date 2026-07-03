// AI 厂商博客源 — 拉取 (Phase 1) + workflow trigger + backfill。
//
// 设计文档：docs/plans/2026-06-09-ai-vendor-feeds-source-design.md §5.5 / §7.2 / §7.4 / §8。
// 架构镜像 worker/src/github.ts(runGithubFetchTrending / triggerGhWorkflowForItem)
// + worker/src/enrich.ts(runListPollIngestCursorDriven 的 catch-up + pending_workflow 平摊)。
//
// 三段职责：
//   runBlogFetch(env)              — cron :20(hour%2===0)调度入口：对每个 blog feed
//                                    fetchFeedXml+parseFeed → INSERT OR IGNORE stub
//                                    → catch-up 分流(immediate trigger / 余 pending_workflow=1)
//                                    → 整轮成功推进 sources.cursor(seen-set)+ last_success_at。
//   triggerBlogWorkflowForItem     — 镜像 triggerGhWorkflowForItem：写 workflow_triggered_at
//                                    + BLOG_PIPELINE_WORKFLOW.create(hour-bucket instance id)。
//   runBlogBackfill(env, mode)     — SOP §1.6 兜底：扫 workflow_completed_at IS NULL 重 trigger。
//
// 不变量：
//   - items 大一统表不加业务列，blog 特异字段全进 extra JSON(BlogExtra 形态)。
//   - stub 走 INSERT OR IGNORE(不走 ingestItems)：同 guid 不重入，天然不擦 workflow 写的 enrich 字段。
//   - is_relevant 入库为 NULL(stub)，workflow step 才落 0/1(stop 游标语义，§5.5)。
//   - seen-set 复用 x-list-cursor 的 parseSeenSet 读；写按 registry FEED_SEEN_SET_MAX_SIZE=20 截断
//     (serializeSeenSet 硬编码 10，故此处自行 slice)。RSS 无排序契约 → skip-seen 全窗扫描，
//     权威「已入库」集是 items 表存在性，seen-set 只作冷启动检测 + 可观测。

import type { Env } from './index';
import type {
  BlogExtra,
  BlogTriggerSignals,
  FeedDef,
  ParsedFeedItem,
  TriggerResult,
} from './feeds/types';
import {
  COLD_START_WINDOW_DAYS,
  FEED_SEEN_SET_MAX_SIZE,
  ensureFeedSources,
  feedsByKind,
} from './feeds/registry';
import {
  WeiboCookieInvalidError,
  WeiboCookieMissingError,
  fetchFeedXml,
  parseFeed,
} from './feeds/parse';
import { discoverPageIndex, hasPageIndexConfig } from './feeds/page-index';
import { canonicalize, idHashOf, urlHashOf } from './feeds/extract';
import { parseSeenSet } from './x-list-cursor';
import { partitionForCatchup } from './x-list-cursor';
import { notifyWeiboCookieInvalid } from './notifier';

/** blog catch-up 分流阈值：最新 N 条立即 trigger，其余 pending_workflow=1 平摊(§5.5)。 */
const BLOG_CATCHUP_THRESHOLD = 50;
/** feed 自带全文判定门槛(纯文本字符数)，决定 hasNativeFulltext 信号。 */
const NATIVE_FULLTEXT_MIN_CHARS = 800;
/** 批量查已入库 id 的分块大小(沿用 D1 ~50 stmt/call 约束)。 */
const EXISTING_ID_CHUNK = 50;

// ─────────────────────────────────────────────────────────────────────────────
// runBlogFetch — cron 调度入口
// ─────────────────────────────────────────────────────────────────────────────

export async function runBlogFetch(
  env: Env,
  opts: { feedKeys?: string[] } = {},
): Promise<{ feeds: number; inserted: number; triggered: number; pending: number }> {
  // 幂等把 FEED_REGISTRY upsert 进 sources(只覆盖 name/config，保留运行时游标)。
  try {
    await ensureFeedSources(env);
  } catch (e) {
    console.error('[blog-fetch] ensureFeedSources error:', e);
  }

  const feedKeySet = opts.feedKeys ? new Set(opts.feedKeys) : null;
  const feeds = feedsByKind('blog').filter((feed) => !feedKeySet || feedKeySet.has(feed.key));
  let inserted = 0;
  let triggered = 0;
  let pending = 0;

  for (const feed of feeds) {
    try {
      const r = await ingestOneBlogFeed(env, feed);
      inserted += r.inserted;
      triggered += r.triggered;
      pending += r.pending;
      console.log(
        `[blog-fetch] ${feed.id}: parsed=${r.parsed} new=${r.inserted} trig=${r.triggered} pending=${r.pending} cold=${r.coldStart}`,
      );
    } catch (e) {
      if (isWeiboCookieError(e)) {
        await notifyWeiboCookieInvalid(env, String(e));
      }
      // 单 feed 失败不影响其它(整轮其它 feed 照跑)；该 feed 不推进 cursor，下轮重头。
      console.error(`[blog-fetch] feed ${feed.id} error:`, e);
    }
  }

  const out = { feeds: feeds.length, inserted, triggered, pending };
  console.log(`[blog-fetch] ${JSON.stringify(out)}`);
  return out;
}

interface IngestOneResult {
  parsed: number;
  inserted: number;
  triggered: number;
  pending: number;
  coldStart: boolean;
}

async function ingestOneBlogFeed(
  env: Env,
  feed: FeedDef,
): Promise<IngestOneResult> {
  // 1. 读 sources.cursor → seen-set(空=冷启动)
  const srcRow = await env.DB.prepare(`SELECT cursor FROM sources WHERE id = ?`)
    .bind(feed.id)
    .first<{ cursor: string | null }>();
  const seenSet = parseSeenSet(srcRow?.cursor ?? null);
  const isColdStart = seenSet.size === 0;

  // 2. fetch + parse(reverse-chrono 不保证)
  //    fetchFeedXml 只结构化读 env.RSSHUB_BASE/RSSHUB_TOKEN(运行时由 worker-integration
  //    在 wrangler.toml [vars] + Env 提供)。窄化转型到其入参形态，避免依赖 worker-integration
  //    是否已把这两字段补进 Env 类型(并行构建顺序无关；纯编译期，零运行时变化)。
  // Phase 3 page-scrape:无 RSS 的源走 sitemap 列表发现(discoverPageIndex),产出
  // 与 parseFeed 同构的 ParsedFeedItem[];其余走 RSS/Atom(fetchFeedXml + parseFeed)。
  let parsedItems: ParsedFeedItem[];
  if (feed.fetch_strategy === 'page-scrape' && hasPageIndexConfig(feed.key)) {
    parsedItems = await discoverPageIndex(feed);
  } else {
    const xml = await fetchFeedXml(
      env as { RSSHUB_BASE?: string; RSSHUB_TOKEN?: string; WEIBO_COOKIES?: string },
      feed,
    );
    parsedItems = parseFeed(xml, feed);
  }
  if (parsedItems.length === 0) {
    return { parsed: 0, inserted: 0, triggered: 0, pending: 0, coldStart: isColdStart };
  }

  // 3. 算复合 id / canonical / url_hash
  const nowIso = new Date().toISOString();
  const enriched = parsedItems.map((p) => {
    const guid = (p.guid || p.link || '').trim();
    const canonicalUrl = canonicalize(p.link || guid);
    const publishedAt = p.published_at || (feed.key === 'weibo-hot-tech' ? nowIso : undefined);
    const idHash = idHashOf(guid);
    return {
      p,
      publishedAt,
      guid,
      canonicalUrl,
      urlHash: urlHashOf(canonicalUrl),
      idHash,
      id: `blog:${feed.key}:${idHash}`,
    };
  });

  // 4. 权威「已入库」集 = items 表存在性(skip-seen 全窗扫描，不照搬 X「命中即停」)
  const existing = await selectExistingIds(env, enriched.map((e) => e.id));
  let newOnes = enriched.filter((e) => !existing.has(e.id));

  // 冷启动限深(D10)：首跑只 enrich「最近 COLD_START_WINDOW_DAYS 天内发布」的;**窗口外的
  // 真历史旧文仍入库占位**(标 workflow_completed_at + cold_start_skipped,不 enrich 不展示)。
  // 否则它们不在 items,第二轮 isColdStart=false 不再限深 → 全窗历史旧文涌入
  // (2026-06-11 staging A1 用例实测:blog 102→408 / podcast 110→631)。
  // 2026-06-24:由「最近 N 条」改「最近 N 天发布」—— 旧的 count 上限对高产源(OpenAI/NVIDIA)
  // 会把 30 天显示窗内该展示的新文也压成历史(实测误伤 OpenAI 35 条);改发布日期窗后窗口内
  // 全放行、只压窗口外真历史(防几年老文涌入)。无发布日期/无法解析的当「新」放行(宁多 enrich
  // 不误伤,catch-up 分流兜量)。items 存在性防重,占位即永久排除,零新增游标状态(设计 §5.5)。
  let coldOverflow: typeof newOnes = [];
  if (isColdStart) {
    const coldCutoffMs = Date.now() - COLD_START_WINDOW_DAYS * 86400_000;
    const isOldBacklog = (e: (typeof newOnes)[number]): boolean => {
      const t = e.p.published_at ? Date.parse(e.p.published_at) : NaN;
      return !Number.isNaN(t) && t < coldCutoffMs; // 有发布日期且早于窗口 → 真历史,压占位
    };
    coldOverflow = newOnes.filter(isOldBacklog);
    newOnes = newOnes.filter((e) => !isOldBacklog(e));
  }
  if (coldOverflow.length > 0) {
    const lang0 = feed.region === 'domestic' ? 'zh' : 'en';
    const stmts = coldOverflow.map((e) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO items
           (id, source_type, source_id, title, content, author, url,
            metrics, published_at, scraped_at, is_relevant, lang, extra)
         VALUES (?, 'blog', ?, ?, '', NULL, ?, '{}', ?, ?, NULL, ?, ?)`,
      ).bind(
        e.id,
        `${feed.key}:${e.idHash}`,
        e.p.title || '',
        e.canonicalUrl || e.p.link || null,
        e.publishedAt || null,
        nowIso,
        lang0,
        JSON.stringify({
          feed_id: feed.id,
          feed_key: feed.key,
          guid: e.guid,
          canonical_url: e.canonicalUrl,
          url_hash: e.urlHash,
          workflow_completed_at: nowIso,
          cold_start_skipped: 1,
        }),
      ),
    );
    try {
      await env.DB.batch(stmts);
    } catch (err) {
      console.error(`[blog-fetch] ${feed.id} cold-overflow batch error:`, err);
      throw err; // 占位失败不推进 cursor,下轮重头(否则旧文下轮仍会涌入)
    }
  }

  // 5. INSERT OR IGNORE stub(is_relevant=NULL，立即可被 workflow 接走)
  let insertedCount = 0;
  if (newOnes.length > 0) {
    const lang = feed.region === 'domestic' ? 'zh' : 'en';
    const publisherDomain = hostOf(feed.site_base || feed.feed_url);
    const stmts = newOnes.map((e) => {
      const extra: BlogExtra & { rss_content_html?: string } = {
        feed_id: feed.id,
        feed_key: feed.key,
        source_company: feed.source_company,
        blog_name: feed.name,
        feed_url: feed.feed_url,
        fetch_strategy: feed.fetch_strategy,
        skip_cn_sensitive: feed.skip_cn_sensitive || undefined,
        guid: e.guid,
        canonical_url: e.canonicalUrl,
        url_hash: e.urlHash,
        cover_image: e.p.cover_url || undefined, // 原始域名 URL，step4 再迁 R2
        excerpt: e.p.summary || undefined,
        publisher: { name: feed.source_company, domain: publisherDomain },
        tags: e.p.tags,
        // 透传 RSS 正文 HTML 给 step3 extractFullText 的 ①RSS-full 快路径；step3 消费后删除
        rss_content_html: e.p.content_html || undefined,
      };
      return env.DB.prepare(
        `INSERT OR IGNORE INTO items
           (id, source_type, source_id, title, content, author, url,
            metrics, published_at, scraped_at, is_relevant, lang, extra)
         VALUES (?, 'blog', ?, ?, ?, ?, ?, '{}', ?, ?, NULL, ?, ?)`,
      ).bind(
        e.id,
        `${feed.key}:${e.idHash}`,
        e.p.title || '',
        e.p.summary || '',
        e.p.author || null,
        e.canonicalUrl || e.p.link || null,
        e.publishedAt || null,
        nowIso,
        lang,
        JSON.stringify(extra),
      );
    });
    try {
      const results = await env.DB.batch(stmts);
      for (const res of results) {
        if (res.meta?.changes && res.meta.changes > 0) insertedCount++;
      }
    } catch (e) {
      console.error(`[blog-fetch] ${feed.id} stub batch error:`, e);
      throw e; // 不推进 cursor(下轮重头)
    }
  }

  // 6. catch-up 分流：immediate 立即 trigger，pending 标 pending_workflow=1
  //    入参按 published_at desc 排序(RSS 无序，re-sort 防御)
  newOnes.sort((a, b) =>
    (b.p.published_at ?? '').localeCompare(a.p.published_at ?? ''),
  );
  const partition = partitionForCatchup(newOnes, BLOG_CATCHUP_THRESHOLD);

  let triggeredCount = 0;
  for (const e of partition.immediate) {
    const signals: BlogTriggerSignals = {
      fetchStrategy: feed.fetch_strategy,
      hasNativeFulltext: isFullEnoughHtml(e.p.content_html),
      skipCnSensitive: feed.skip_cn_sensitive === true,
    };
    const res = await triggerBlogWorkflowForItem(env, e.id, signals);
    if (res === 'triggered') triggeredCount++;
  }

  let pendingCount = 0;
  if (partition.pending.length > 0) {
    pendingCount = partition.pending.length;
    const stmts = partition.pending.map((e) =>
      env.DB.prepare(`UPDATE items SET pending_workflow=1 WHERE id=?`).bind(e.id),
    );
    try {
      await env.DB.batch(stmts);
    } catch (e) {
      console.error(`[blog-fetch] ${feed.id} pending mark error:`, e);
    }
  }

  // 7. 整轮成功才推进 cursor(seen-set = 当前窗口顶端 N 个 id)+ last_success_at
  const topIds = enriched.slice(0, FEED_SEEN_SET_MAX_SIZE).map((e) => e.id);
  if (topIds.length > 0) {
    try {
      await env.DB.prepare(
        `UPDATE sources SET cursor=?, last_success_at=? WHERE id=?`,
      )
        .bind(JSON.stringify(topIds), nowIso, feed.id)
        .run();
    } catch (e) {
      console.error(`[blog-fetch] ${feed.id} cursor update error:`, e);
    }
  }

  return {
    parsed: parsedItems.length,
    inserted: insertedCount,
    triggered: triggeredCount,
    pending: pendingCount,
    coldStart: isColdStart,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// triggerBlogWorkflowForItem — 镜像 triggerGhWorkflowForItem(hour-bucket instance id)
// ─────────────────────────────────────────────────────────────────────────────

export async function triggerBlogWorkflowForItem(
  env: { DB: D1Database; BLOG_PIPELINE_WORKFLOW?: Workflow },
  itemId: string,
  signals: BlogTriggerSignals,
): Promise<TriggerResult> {
  if (!env.BLOG_PIPELINE_WORKFLOW) return 'binding_missing';

  const nowUnix = Math.floor(Date.now() / 1000);
  try {
    await env.DB.prepare(
      `UPDATE items SET extra = json_set(coalesce(extra, '{}'), '$.workflow_triggered_at', ?) WHERE id = ?`,
    )
      .bind(nowUnix, itemId)
      .run();
  } catch (e) {
    console.error(`[blog-trigger] mark failed for ${itemId}:`, e);
  }

  // feed_key 从复合 id 取(blog:<feed_key>:<idHash>，feed_key 只含 [a-z0-9-] 无冒号)
  const feedKey = itemId.split(':')[1] || '';
  // hour-bucket suffix：同 item 每小时可重 trigger(防 stuck old instance 永久阻塞，2026-05-17 同病)
  const hourBucket = new Date().toISOString().slice(0, 13).replace('T', '-');
  const instanceId = `blog-${itemId.replace(/[^a-zA-Z0-9-]/g, '-')}-${hourBucket}`;
  try {
    await env.BLOG_PIPELINE_WORKFLOW.create({
      id: instanceId,
      params: {
        itemId,
        feedKey,
        fetchStrategy: signals.fetchStrategy,
        lang: 'zh' as const,
        hasNativeFulltext: signals.hasNativeFulltext,
        skipCnSensitive: signals.skipCnSensitive,
      },
    });
    return 'triggered';
  } catch (e) {
    if (String(e).toLowerCase().includes('already exists')) {
      return 'already_exists';
    }
    console.error(`[blog-trigger] create failed for ${itemId}:`, e);
    return 'failed';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// runBlogBackfill — SOP §1.6 兜底 / Phase3 占位
// ─────────────────────────────────────────────────────────────────────────────

export async function runBlogBackfill(
  env: Env,
  mode: 'stuck-workflow' | 'backfill-blog-body',
): Promise<{ retriggered: number }> {
  if (mode === 'backfill-blog-body') {
    // Phase 3 才实现(扫 body 缺失重抓全文)；v1 空实现。
    return { retriggered: 0 };
  }

  // stuck-workflow：workflow_completed_at IS NULL 的 blog 行被当 stuck，重 trigger。
  // 已 triggered 但卡住的(hour-bucket 让新 instance 可重入)；未 trigger 的(binding 当时缺)也兜。
  const rows = await env.DB.prepare(
    `SELECT id, extra FROM items
      WHERE source_type='blog'
        AND deleted_at IS NULL
        AND json_extract(extra, '$.workflow_completed_at') IS NULL
      ORDER BY scraped_at ASC
      LIMIT 50`,
  ).all<{ id: string; extra: string | null }>();

  let retriggered = 0;
  for (const r of rows.results) {
    let extraObj: Record<string, unknown> = {};
    try {
      extraObj = JSON.parse(r.extra || '{}') as Record<string, unknown>;
    } catch {
      /* ignore */
    }
    const fetchStrategy =
      (extraObj.fetch_strategy as BlogTriggerSignals['fetchStrategy']) || 'native';
    const res = await triggerBlogWorkflowForItem(env, r.id, {
      fetchStrategy,
      hasNativeFulltext: isFullEnoughHtml(
        (extraObj.rss_content_html as string | undefined) ||
          (extraObj.body_markdown as string | undefined),
      ),
      skipCnSensitive: extraObj.skip_cn_sensitive === true,
    });
    if (res === 'triggered') retriggered++;
  }

  console.log(`[blog-backfill:stuck-workflow] retriggered=${retriggered}/${rows.results.length}`);
  return { retriggered };
}

// ─────────────────────────────────────────────────────────────────────────────
// 内部小工具
// ─────────────────────────────────────────────────────────────────────────────

/** 批量查已入库 id(分块，返回 Set)。 */
async function selectExistingIds(env: Env, ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += EXISTING_ID_CHUNK) {
    const chunk = ids.slice(i, i + EXISTING_ID_CHUNK);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => '?').join(',');
    const rows = await env.DB.prepare(
      `SELECT id FROM items WHERE id IN (${placeholders})`,
    )
      .bind(...chunk)
      .all<{ id: string }>();
    for (const r of rows.results) out.add(r.id);
  }
  return out;
}

/** RSS 正文 HTML 是否「自带全文」(纯文本 ≥800 字)，决定 hasNativeFulltext 信号。
 *  export 给 podcast.ts 的无音频文字项改判 blog 复用(单一真相，避免两处门槛漂移)。 */
export function isFullEnoughHtml(html: string | undefined): boolean {
  if (!html) return false;
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length >= NATIVE_FULLTEXT_MIN_CHARS;
}

/** 取 URL host(失败返 undefined)。 */
function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function isWeiboCookieError(e: unknown): boolean {
  return (
    e instanceof WeiboCookieMissingError ||
    e instanceof WeiboCookieInvalidError ||
    String((e as { name?: string })?.name || '').startsWith('WeiboCookie') ||
    String((e as { code?: string })?.code || '').startsWith('WEIBO_COOKIE_')
  );
}
