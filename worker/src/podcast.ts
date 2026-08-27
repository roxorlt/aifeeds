// AI 播客源 — 拉取 (Phase 1) + workflow trigger + 原生文字稿抓取 + backfill。
//
// 设计文档：docs/plans/2026-06-09-ai-vendor-feeds-source-design.md §5.5 / §7.2 / §8.3 / §9.1。
// 架构镜像 worker/src/blog.ts（同一套 feeds/ 库 + x-list-cursor 游标 + catch-up 平摊），
// 仅在「单集音频 / 原生文字稿」处与 blog 分叉。
//
// 三段职责：
//   runPodcastFetch(env)              — cron :50(hour∈{1,7,13,19})调度入口：对每个 podcast feed
//                                       fetchFeedXml+parseFeed → INSERT OR IGNORE stub
//                                       → catch-up 分流(immediate trigger / 余 pending_workflow=1)
//                                       → 整轮成功推进 sources.cursor(seen-set)+ last_success_at。
//   triggerPodcastWorkflowForItem     — 镜像 triggerBlogWorkflowForItem：写 workflow_triggered_at
//                                       + PODCAST_PIPELINE_WORKFLOW.create(hour-bucket instance id)。
//   fetchNativeTranscriptForPodcast   — workflow step3：A 档 5 源取原生文字稿 —— <podcast:transcript>
//                                       文件(VTT/SRT/JSON) / Substack 全文 / Lex show-page；**无 ASR(v1)**。
//   runPodcastBackfill(env, mode)     — SOP §1.6 兜底：扫 workflow_completed_at IS NULL 重 trigger。
//
// 不变量（与 blog 完全一致）：
//   - items 大一统表不加业务列，podcast 特异字段全进 extra JSON(PodcastExtra 形态)。
//   - 音频原始 enclosure 直链入 extra.audio_url，**绝不迁 R2、绝不走 /r/**(§9.1)；前端 <audio> 直吃。
//   - stub 走 INSERT OR IGNORE：同 guid 不重入，天然不擦 workflow 写的 enrich 字段。
//   - is_relevant 入库为 NULL(stub)，workflow step 才落 0/1(stop 游标语义，§5.5)。
//   - seen-set 复用 x-list-cursor 的 parseSeenSet 读；写按 registry FEED_SEEN_SET_MAX_SIZE=20 截断。
//     RSS 无排序契约 → skip-seen 全窗扫描，权威「已入库」集是 items 表存在性。

import type { Env } from './index';
import type {
  BlogExtra,
  BlogTriggerSignals,
  FeedDef,
  PodcastExtra,
  PodcastTriggerSignals,
  TranscriptSource,
  TriggerResult,
} from './feeds/types';
import {
  COLD_START_WINDOW_DAYS,
  FEED_SEEN_SET_MAX_SIZE,
  ensureFeedSources,
  feedsByKind,
} from './feeds/registry';
import { fetchFeedXml, parseFeed } from './feeds/parse';
import { canonicalize, idHashOf, urlHashOf } from './feeds/extract';
import { parseSeenSet, partitionForCatchup } from './x-list-cursor';
// 无音频文字项改判 blog：复用 blog 管线的 trigger + 全文门槛(同一套 BlogPipeline 产 excerpt_zh)。
import { triggerBlogWorkflowForItem, isFullEnoughHtml } from './blog';
import {
  markWorkflowPending,
  markWorkflowTriggered,
  runFeedWorkflowRecovery,
  type FeedWorkflowRecoveryResult,
} from './feeds/dedup';
import { pushDeerWarning } from './notifier';
import {
  produceWorkflowRetryExhaustedWarnings,
  readWarningCanonicalReadiness,
  releaseWarningOutboxLegacyBridgeReservations,
  resolveWarningOutboxLegacyBridge,
  type WarningOutboxBridgeResult,
  type WarningOutboxProducerResult,
} from './ops/warning-outbox';

/** podcast catch-up 分流阈值：最新 N 条立即 trigger，其余 pending_workflow=1 平摊(§5.5)。 */
const PODCAST_CATCHUP_THRESHOLD = 50;
/** 批量查已入库 id 的分块大小(沿用 D1 ~50 stmt/call 约束)。 */
const EXISTING_ID_CHUNK = 50;
/** 文字稿全文存储上限(防 2h 长集 VTT 把 extra 撑爆)。 */
const TRANSCRIPT_MAX_CHARS = 200_000;
/** Substack 全文当文字稿的最小纯文本字符门槛(低于此视作普通 shownotes，不当 transcript)。 */
const SUBSTACK_FULLTEXT_MIN_CHARS = 2_000;
/** 单次文字稿文件 fetch 超时。 */
const TRANSCRIPT_FETCH_TIMEOUT_MS = 20_000;
const USER_AGENT =
  'Mozilla/5.0 (compatible; ai-feeds-bot/1.0; +https://ai-feeds.com)';

// ─────────────────────────────────────────────────────────────────────────────
// runPodcastFetch — cron 调度入口
// ─────────────────────────────────────────────────────────────────────────────

export async function runPodcastFetch(
  env: Env,
): Promise<{ feeds: number; inserted: number; triggered: number; pending: number }> {
  // 幂等把 FEED_REGISTRY upsert 进 sources(只覆盖 name/config，保留运行时游标)。
  try {
    await ensureFeedSources(env);
  } catch (e) {
    console.error('[podcast-fetch] ensureFeedSources error:', e);
  }

  const feeds = feedsByKind('podcast');
  let inserted = 0;
  let triggered = 0;
  let pending = 0;

  for (const feed of feeds) {
    try {
      const r = await ingestOnePodcastFeed(env, feed);
      inserted += r.inserted;
      triggered += r.triggered;
      pending += r.pending;
      console.log(
        `[podcast-fetch] ${feed.id}: parsed=${r.parsed} new=${r.inserted} trig=${r.triggered} pending=${r.pending} cold=${r.coldStart}`,
      );
    } catch (e) {
      // 单 feed 失败不影响其它；该 feed 不推进 cursor，下轮重头。
      console.error(`[podcast-fetch] feed ${feed.id} error:`, e);
    }
  }

  const out = { feeds: feeds.length, inserted, triggered, pending };
  console.log(`[podcast-fetch] ${JSON.stringify(out)}`);
  return out;
}

interface IngestOneResult {
  parsed: number;
  inserted: number;
  triggered: number;
  pending: number;
  coldStart: boolean;
}

async function ingestOnePodcastFeed(
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
  //    注入 Env)；此处 cast 让本文件在 Env 尚未加该 binding 时也能独立编译(对齐 blog.ts)。
  const xml = await fetchFeedXml(
    env as { RSSHUB_BASE?: string; RSSHUB_TOKEN?: string },
    feed,
  );
  const parsedItems = parseFeed(xml, feed);
  if (parsedItems.length === 0) {
    return { parsed: 0, inserted: 0, triggered: 0, pending: 0, coldStart: isColdStart };
  }

  // 3. 算复合 id / canonical / url_hash
  const nowIso = new Date().toISOString();
  const enriched = parsedItems.map((p) => {
    const guid = (p.guid || p.link || '').trim();
    const canonicalUrl = canonicalize(p.link || guid);
    const idHash = idHashOf(guid);
    return {
      p,
      guid,
      canonicalUrl,
      urlHash: urlHashOf(canonicalUrl),
      idHash,
      id: `podcast:${feed.key}:${idHash}`,
    };
  });

  // 4. 权威「已入库」集 = items 表存在性(skip-seen 全窗扫描，不照搬 X「命中即停」)
  const existing = await selectExistingIds(env, enriched.map((e) => e.id));
  let newOnes = enriched.filter((e) => !existing.has(e.id));

  // 冷启动限深(D10)：首跑只 enrich「最近 COLD_START_WINDOW_DAYS 天内发布」的单集;**窗口外
  // 的历史单集仍入库占位**(标 workflow_completed_at + cold_start_skipped,不 enrich 不展示)——
  // 否则第二轮 isColdStart=false 不再限深,Lex/MLST 这类几百集 feed 全窗涌入
  // (2026-06-11 staging A1/A2 用例实测 podcast 110→631)。2026-06-24 由「最近 N 集」改「最近
  // N 天发布」,同 blog.ts:窗口内全放行不误伤,只压窗口外真历史;无日期当「新」放行。占位游标同前。
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
         VALUES (?, 'podcast', ?, ?, '', NULL, ?, '{}', ?, ?, NULL, ?, ?)`,
      ).bind(
        e.id,
        `${feed.key}:${e.idHash}`,
        e.p.title || '',
        e.canonicalUrl || e.p.link || null,
        e.p.published_at || null,
        nowIso,
        lang0,
        JSON.stringify({
          feed_id: feed.id,
          feed_key: feed.key,
          editorial_type: feed.editorial_type,
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
      console.error(`[podcast-fetch] ${feed.id} cold-overflow batch error:`, err);
      throw err; // 占位失败不推进 cursor,下轮重头
    }
  }

  // 5. INSERT OR IGNORE stub(is_relevant=NULL，立即可被 workflow 接走)。按是否有音频分流：
  //    - 有 <enclosure type="audio/*"> → 真播客单集，podcast 形状 extra（原逻辑不变）。
  //    - 无音频(纯文字新闻帖：latent-space / last-week-in-ai 这类 Substack 混发的 AINews
  //      日报，URL 形如 latent.space/p/ainews-...) → 本是图文不是播客，改判 source_type='blog'
  //      + blog 形状 extra，让前端 BlogCard 渲染（不再误当「音频播客卡片」）。id 仍保
  //      `podcast:${feed.key}:${idHash}` 前缀作来源痕迹（不断分享链 / 防重存在性检查靠它），
  //      只换 source_type + extra 形状（不写 show_key/audio_url/transcript_tier）。
  const audioOnes = newOnes.filter((e) => !!e.p.enclosure_url);
  const textOnes = newOnes.filter((e) => !e.p.enclosure_url);
  const lang = feed.region === 'domestic' ? 'zh' : 'en';
  const publisherDomain = hostOf(feed.site_base || feed.feed_url);

  let insertedCount = 0;

  // 5a. 有音频：podcast stub。
  if (audioOnes.length > 0) {
    const stmts = audioOnes.map((e) => {
      const extra: PodcastExtra & { rss_content_html?: string } = {
        feed_id: feed.id,
        show_key: feed.key,
        source_company: feed.source_company,
        editorial_type: feed.editorial_type,
        show_name: feed.name,
        feed_url: feed.feed_url,
        fetch_strategy: feed.fetch_strategy,
        guid: e.guid,
        canonical_url: e.canonicalUrl,
        url_hash: e.urlHash,
        // ⚠️ 音频原始直链：绝不迁 R2、绝不走 /r/(§9.1)；前端 <audio> 直吃。
        audio_url: e.p.enclosure_url || undefined,
        audio_type: e.p.enclosure_type || undefined,
        audio_bytes: e.p.enclosure_bytes,
        duration_sec: e.p.duration_sec,
        episode_no: e.p.episode_no,
        episode_type: e.p.episode_type || undefined,
        hosts: e.p.hosts,    // <podcast:person role=host>(部分 feed),海报增信息量
        guests: e.p.guests,  // <podcast:person role=guest>
        cover_image: e.p.cover_url || undefined, // 原始域名 URL，step4 migrateCoverForPodcast 再迁 R2
        shownotes: e.p.summary || undefined,
        transcript_tier: feed.transcript_tier,
        transcript_url: e.p.transcript_url || undefined,
        transcript_type: e.p.transcript_type || undefined,
        publisher: { name: feed.source_company, domain: publisherDomain },
        // 透传 RSS 正文 HTML：A 档 Substack 全文当文字稿 / step0 shownotes 兜底；step3 消费后删除。
        rss_content_html: e.p.content_html || undefined,
      };
      return env.DB.prepare(
        `INSERT OR IGNORE INTO items
           (id, source_type, source_id, title, content, author, url,
            metrics, published_at, scraped_at, is_relevant, lang, extra)
         VALUES (?, 'podcast', ?, ?, ?, ?, ?, '{}', ?, ?, NULL, ?, ?)`,
      ).bind(
        e.id,
        `${feed.key}:${e.idHash}`,
        e.p.title || '',
        e.p.summary || '',
        e.p.author || null,
        e.canonicalUrl || e.p.link || null,
        e.p.published_at || null,
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
      console.error(`[podcast-fetch] ${feed.id} stub batch error:`, e);
      throw e; // 不推进 cursor(下轮重头)
    }
  }

  // 5b. 无音频：改判 blog stub（blog 形状 extra；source_type='blog'；id 仍是 podcast:...）。
  if (textOnes.length > 0) {
    const stmts = textOnes.map((e) => {
      const extra: BlogExtra & { rss_content_html?: string } = {
        feed_id: feed.id,
        feed_key: feed.key,
        source_company: feed.source_company,
        editorial_type: feed.editorial_type,
        blog_name: feed.name,
        feed_url: feed.feed_url,
        fetch_strategy: feed.fetch_strategy,
        guid: e.guid,
        canonical_url: e.canonicalUrl,
        url_hash: e.urlHash,
        cover_image: e.p.cover_url || undefined, // 原始域名 URL，BlogPipeline step4 再迁 R2
        excerpt: e.p.summary || undefined,
        publisher: { name: feed.source_company, domain: publisherDomain },
        tags: e.p.tags,
        // 透传 RSS 正文 HTML 给 BlogPipeline step3 extractFullText 的 ①RSS-full 快路径；消费后删除。
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
        e.p.published_at || null,
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
      console.error(`[podcast-fetch] ${feed.id} blog-stub batch error:`, e);
      throw e; // 不推进 cursor(下轮重头)
    }
  }

  // 6. 触发 workflow。
  let triggeredCount = 0;
  let pendingCount = 0;

  // 6a. 有音频：catch-up 分流(immediate 立即 trigger podcast / 余 pending_workflow=1 平摊)。
  //     入参按 published_at desc 排序(RSS 无序，re-sort 防御)。
  audioOnes.sort((a, b) =>
    (b.p.published_at ?? '').localeCompare(a.p.published_at ?? ''),
  );
  const partition = partitionForCatchup(audioOnes, PODCAST_CATCHUP_THRESHOLD);
  for (const e of partition.immediate) {
    const signals: PodcastTriggerSignals = {
      hasNativeTranscript: feed.has_native_transcript === true,
    };
    const res = await triggerPodcastWorkflowForItem(env, e.id, signals);
    if (res === 'triggered') triggeredCount++;
  }
  if (partition.pending.length > 0) {
    pendingCount = partition.pending.length;
    const stmts = partition.pending.map((e) =>
      env.DB.prepare(`UPDATE items SET pending_workflow=1 WHERE id=?`).bind(e.id),
    );
    try {
      await env.DB.batch(stmts);
    } catch (e) {
      console.error(`[podcast-fetch] ${feed.id} pending mark error:`, e);
    }
  }

  // 6b. 无音频文字项：量小（Substack 偶发文字日报），一律立即 trigger blog workflow，跳过
  //     catch-up/pending。原因：drainPendingWorkflowQueue 只认 source_type='x_list'，
  //     blog/podcast 的 pending 无 cron 自动 drain（只能 OPS backfill 兜底），故文字项不进
  //     pending 队列，直接 trigger 最稳。blog 形状 → BlogPipeline 产 excerpt_zh/body/reading。
  textOnes.sort((a, b) =>
    (b.p.published_at ?? '').localeCompare(a.p.published_at ?? ''),
  );
  for (const e of textOnes) {
    const signals: BlogTriggerSignals = {
      fetchStrategy: feed.fetch_strategy,
      hasNativeFulltext: isFullEnoughHtml(e.p.content_html),
    };
    const res = await triggerBlogWorkflowForItem(env, e.id, signals);
    if (res === 'triggered') triggeredCount++;
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
      console.error(`[podcast-fetch] ${feed.id} cursor update error:`, e);
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
// triggerPodcastWorkflowForItem — 镜像 triggerBlogWorkflowForItem(hour-bucket instance id)
// ─────────────────────────────────────────────────────────────────────────────

export async function triggerPodcastWorkflowForItem(
  env: { DB: D1Database; PODCAST_PIPELINE_WORKFLOW?: Workflow },
  itemId: string,
  signals: PodcastTriggerSignals,
): Promise<TriggerResult> {
  if (!env.PODCAST_PIPELINE_WORKFLOW) {
    await markWorkflowPending(env, itemId, 'WORKFLOW_BINDING_MISSING');
    return 'binding_missing';
  }

  const nowUnix = Math.floor(Date.now() / 1000);
  try {
    await env.DB.prepare(
      `UPDATE items SET extra = json_set(coalesce(extra, '{}'), '$.workflow_triggered_at', ?) WHERE id = ?`,
    )
      .bind(nowUnix, itemId)
      .run();
  } catch (e) {
    console.error(`[podcast-trigger] mark failed for ${itemId}:`, e);
  }

  // show_key 从复合 id 取(podcast:<show_key>:<idHash>，show_key 只含 [a-z0-9-] 无冒号)
  const showKey = itemId.split(':')[1] || '';
  // hour-bucket suffix：同 item 每小时可重 trigger(防 stuck old instance 永久阻塞)
  const hourBucket = new Date().toISOString().slice(0, 13).replace('T', '-');
  const instanceId = `podcast-${itemId.replace(/[^a-zA-Z0-9-]/g, '-')}-${hourBucket}`;
  try {
    await env.PODCAST_PIPELINE_WORKFLOW.create({
      id: instanceId,
      params: {
        itemId,
        showKey,
        hasNativeTranscript: signals.hasNativeTranscript,
        lang: 'zh' as const,
      },
    });
    await markWorkflowTriggered(env, itemId);
    return 'triggered';
  } catch (e) {
    if (String(e).toLowerCase().includes('already exists')) {
      await markWorkflowTriggered(env, itemId);
      return 'already_exists';
    }
    console.error(`[podcast-trigger] create failed for ${itemId}:`, e);
    await markWorkflowPending(env, itemId, 'WORKFLOW_CREATE_FAILED');
    return 'failed';
  }
}

export type PodcastWorkflowRecoveryResult = FeedWorkflowRecoveryResult & {
  warning_mode: 'legacy' | 'bridge' | 'outbox';
  warning_bridge?: WarningOutboxBridgeResult;
  warning_outbox?: WarningOutboxProducerResult;
};

/** 每小时独立恢复至少 30 分钟仍未完成的 podcast workflow。 */
export async function runPodcastWorkflowRecovery(env: Env): Promise<PodcastWorkflowRecoveryResult> {
  const producerEnabled = env.WARNING_OUTBOX_PRODUCER_ENABLED === '1';
  const drainEnabled = env.WARNING_OUTBOX_DRAIN_ENABLED === '1';
  const canonicalReady = producerEnabled && drainEnabled
    ? (await readWarningCanonicalReadiness(env, 'podcast')).ready
    : false;
  const targetAuthority = producerEnabled && drainEnabled && canonicalReady;
  const legacyAuthority = !producerEnabled || (producerEnabled && drainEnabled && !canonicalReady);
  let bridgeResult: WarningOutboxBridgeResult = {
    status: 'ok', suppressed_ids: [], legacy_ids: [], alert_legacy_owned: 0,
    alert_bridge_suppressed: 0, bridge_duplicate_possible: 0,
  };
  let bridgeError: unknown;
  const recovery = await runFeedWorkflowRecovery(env, {
    sourceType: 'podcast',
    trigger: (itemId, extra) => triggerPodcastWorkflowForItem(env, itemId, {
      hasNativeTranscript: Boolean(extra.transcript_url) || extra.transcript_tier === 'A',
    }),
    ...(legacyAuthority ? { onExhausted: async ({ itemIds, attempts, alertPeriod }: {
      itemIds: string[]; attempts: number; alertPeriod: string;
    }) => {
      let legacyIds = itemIds;
      if (drainEnabled) {
        try {
          bridgeResult = await resolveWarningOutboxLegacyBridge(env, 'podcast', itemIds, alertPeriod);
          legacyIds = bridgeResult.legacy_ids;
        } catch (error) {
          bridgeError = error;
          return false;
        }
      }
      if (legacyIds.length === 0) return true;
      const delivered = await pushDeerWarning(
        env, '播客 workflow 自愈重试耗尽',
        `${legacyIds.length} 条播客项已达到 ${attempts} 次自动重试上限（UTC ${alertPeriod}）：${legacyIds.slice(0, 10).join(', ')}`,
      );
      if (!delivered && drainEnabled) {
        try {
          await releaseWarningOutboxLegacyBridgeReservations(env, 'podcast', legacyIds, alertPeriod);
        } catch (error) {
          bridgeError = error;
        }
      }
      return delivered;
    } } : {}),
  });
  if (bridgeError) {
    throw new Error(`warning_outbox_bridge_lookup_failed: ${String(bridgeError)}`);
  }
  if (!producerEnabled) {
    return drainEnabled
      ? { ...recovery, warning_mode: 'bridge', warning_bridge: bridgeResult }
      : { ...recovery, warning_mode: 'legacy' };
  }
  const outbox = await produceWorkflowRetryExhaustedWarnings(env, 'podcast');
  if (!targetAuthority) {
    return {
      ...recovery,
      warning_mode: drainEnabled ? 'bridge' : 'outbox',
      ...(drainEnabled ? { warning_bridge: bridgeResult } : {}),
      warning_outbox: outbox,
    };
  }
  return {
    ...recovery,
    exhausted_alerts: outbox.alert_enqueued,
    warning_mode: 'outbox',
    warning_outbox: outbox,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// fetchNativeTranscriptForPodcast — workflow step3(A 档 5 源；无 ASR，v1)
//
// 三条来源分支(§3.1 / §8.3)：
//   ① <podcast:transcript> 文件(Practical AI / MS Research)：fetch + 解析 VTT/SRT/JSON。
//   ② Substack 全文(Latent Space / Last Week in AI)：无 transcript 文件，正文 HTML 即全文。
//   ③ Lex show-page：transcript 在 description 提到的 HTML 页，v1 不抓 → 标 'show-page' 留外链。
// 取不到任何文字稿 → transcript_source='none'(B/C 档)。永不 throw(失败降级，gate 不受阻)。
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchNativeTranscriptForPodcast(
  env: Env,
  itemId: string,
): Promise<{ ok: boolean }> {
  try {
    const row = await env.DB.prepare(
      `SELECT extra FROM items WHERE id = ? AND source_type='podcast'`,
    )
      .bind(itemId)
      .first<{ extra: string | null }>();
    if (!row) return { ok: false };

    let extra: Record<string, unknown> = {};
    try {
      extra = row.extra ? (JSON.parse(row.extra) as Record<string, unknown>) : {};
    } catch {
      /* ignore */
    }

    const transcriptUrl = String(extra.transcript_url || '').trim();
    const transcriptType = String(extra.transcript_type || '').toLowerCase();

    // ① <podcast:transcript> 真文件(VTT/SRT/JSON/纯文本)
    if (transcriptUrl && looksLikeTranscriptFile(transcriptUrl, transcriptType)) {
      const text = await fetchAndParseTranscript(transcriptUrl, transcriptType);
      if (text && text.length > 40) {
        await writeTranscript(env, itemId, text, 'podcast:transcript');
        console.log(`[podcast-transcript] ${itemId}: podcast:transcript ${text.length}c`);
        return { ok: true };
      }
    }

    // ② Substack 全文当文字稿(透传的 rss_content_html 纯文本 ≥ 门槛)
    const fullText = htmlToReadableText(String(extra.rss_content_html || ''));
    if (fullText.length >= SUBSTACK_FULLTEXT_MIN_CHARS) {
      await writeTranscript(env, itemId, fullText, 'substack-fulltext');
      console.log(`[podcast-transcript] ${itemId}: substack-fulltext ${fullText.length}c`);
      return { ok: true };
    }

    // ③ transcript URL 是 HTML show-page(Lex)→ 标 show-page；否则 none。consume rss_content_html。
    const source: TranscriptSource = transcriptUrl ? 'show-page' : 'none';
    await markTranscriptSource(env, itemId, source);
    console.log(`[podcast-transcript] ${itemId}: ${source}(no native text)`);
    return { ok: false };
  } catch (e) {
    console.error(`[podcast-transcript] ${itemId}: error`, e);
    // 失败也标 none + 清 rss_content_html(避免 stuck 重判时反复抓)
    try {
      await markTranscriptSource(env, itemId, 'none');
    } catch {
      /* ignore */
    }
    return { ok: false };
  }
}

/** 写 transcript_text + transcript_source，并删除已消费的 rss_content_html(防 extra 膨胀)。 */
async function writeTranscript(
  env: Env,
  itemId: string,
  text: string,
  source: TranscriptSource,
): Promise<void> {
  const capped = text.length > TRANSCRIPT_MAX_CHARS ? text.slice(0, TRANSCRIPT_MAX_CHARS) : text;
  await env.DB.prepare(
    `UPDATE items
        SET extra = json_remove(
                      json_set(coalesce(extra,'{}'),
                        '$.transcript_text', ?,
                        '$.transcript_source', ?),
                      '$.rss_content_html')
      WHERE id = ?`,
  )
    .bind(capped, source, itemId)
    .run();
}

/** 只标 transcript_source(无全文场景)，并删除 rss_content_html。 */
async function markTranscriptSource(
  env: Env,
  itemId: string,
  source: TranscriptSource,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE items
        SET extra = json_remove(
                      json_set(coalesce(extra,'{}'), '$.transcript_source', ?),
                      '$.rss_content_html')
      WHERE id = ?`,
  )
    .bind(source, itemId)
    .run();
}

// ─────────────────────────────────────────────────────────────────────────────
// runPodcastBackfill — SOP §1.6 兜底 / Phase3 占位
// ─────────────────────────────────────────────────────────────────────────────

export async function runPodcastBackfill(
  env: Env,
  mode: 'stuck-workflow' | 'backfill-podcast-transcript',
): Promise<{ retriggered: number }> {
  if (mode === 'backfill-podcast-transcript') {
    // Phase 3 才实现(B/C 档 ASR 补全)；v1 空实现(§13 D5)。
    return { retriggered: 0 };
  }

  // stuck-workflow：workflow_completed_at IS NULL 的 podcast 行被当 stuck，重 trigger。
  const rows = await env.DB.prepare(
    `SELECT id, extra FROM items
      WHERE source_type='podcast'
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
    // hasNativeTranscript 信号：优先 extra.transcript_url(<podcast:transcript> 存在) /
    // transcript_tier==='A'，否则 false。
    const hasNativeTranscript =
      Boolean(extraObj.transcript_url) || extraObj.transcript_tier === 'A';
    const res = await triggerPodcastWorkflowForItem(env, r.id, {
      hasNativeTranscript,
    });
    if (res === 'triggered') retriggered++;
  }

  console.log(
    `[podcast-backfill:stuck-workflow] retriggered=${retriggered}/${rows.results.length}`,
  );
  return { retriggered };
}

// ─────────────────────────────────────────────────────────────────────────────
// 文字稿文件解析(无 DOM 库，纯正则)
// ─────────────────────────────────────────────────────────────────────────────

/** transcript_url 是否指向真文字稿文件(VTT/SRT/JSON/纯文本)，而非 HTML show-page。 */
function looksLikeTranscriptFile(url: string, type: string): boolean {
  if (/\b(text\/vtt|application\/(x-subrip|srt)|application\/json|text\/plain)\b/i.test(type)) {
    return true;
  }
  if (/\.(vtt|srt|json|txt)(\?|#|$)/i.test(url)) return true;
  // 明确是 HTML 页 → 不是文件(Lex 这类)
  if (/text\/html/i.test(type) || /\.html?(\?|#|$)/i.test(url)) return false;
  // type 缺失且无扩展名：保守当文件试一次(内容嗅探兜底)
  return type === '' && !/\.[a-z0-9]{2,5}(\?|#|$)/i.test(url);
}

async function fetchAndParseTranscript(url: string, type: string): Promise<string> {
  let body: string;
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/vtt, application/json, text/plain, */*;q=0.5',
      },
      signal: AbortSignal.timeout(TRANSCRIPT_FETCH_TIMEOUT_MS),
    });
    if (!r.ok) return '';
    body = await r.text();
  } catch (e) {
    console.warn(`[podcast-transcript] fetch fail ${url}:`, e);
    return '';
  }
  if (!body) return '';

  const head = body.trimStart().slice(0, 16);
  const isJson =
    /json/i.test(type) || /\.json(\?|#|$)/i.test(url) || head.startsWith('{') || head.startsWith('[');
  if (isJson) {
    const t = parseTranscriptJson(body);
    if (t) return t;
  }
  // VTT / SRT 共用解析(都跳过序号行 + 时间轴行)
  if (/^WEBVTT/i.test(body.trimStart()) || /-->/.test(body)) {
    const t = parseCueLines(body);
    if (t) return t;
  }
  // 纯文本兜底
  return collapseWhitespace(body);
}

/** VTT / SRT：跳 WEBVTT 头 / NOTE / 序号行 / 时间轴行，剥 <v>/<c> 标签，去连续重复行。 */
function parseCueLines(raw: string): string {
  const out: string[] = [];
  let prev = '';
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (/^WEBVTT/i.test(t)) continue;
    if (/^(NOTE|STYLE|REGION)\b/i.test(t)) continue;
    if (t.includes('-->')) continue; // 时间轴
    if (/^\d+$/.test(t)) continue; // SRT 序号 / VTT cue id
    const clean = t
      .replace(/<[^>]+>/g, '') // <v Speaker> <c> 等
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&#39;/gi, "'")
      .replace(/&quot;/gi, '"')
      .trim();
    if (!clean) continue;
    if (clean === prev) continue; // VTT 常逐字重复滚动，去连续重复
    out.push(clean);
    prev = clean;
  }
  return out.join('\n');
}

/** podcastindex / AWS 等常见 transcript JSON shape → 纯文本。 */
function parseTranscriptJson(raw: string): string {
  try {
    const j = JSON.parse(raw) as unknown;
    const segs = (j as { segments?: unknown }).segments;
    if (Array.isArray(segs)) {
      return collapseWhitespace(
        segs
          .map((s) => String((s as { body?: unknown; text?: unknown })?.body ?? (s as { text?: unknown })?.text ?? ''))
          .filter(Boolean)
          .join(' '),
      );
    }
    if (Array.isArray(j)) {
      return collapseWhitespace(
        j
          .map((s) =>
            typeof s === 'string'
              ? s
              : String((s as { body?: unknown; text?: unknown })?.body ?? (s as { text?: unknown })?.text ?? ''),
          )
          .filter(Boolean)
          .join(' '),
      );
    }
    const aws = (j as { results?: { transcripts?: { transcript?: unknown }[] } })?.results
      ?.transcripts?.[0]?.transcript;
    if (typeof aws === 'string') return collapseWhitespace(aws);
    return '';
  } catch {
    return '';
  }
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

/** 取 URL host(失败返 undefined)。 */
function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/** HTML 正文 → 可读纯文本(保段落换行)：Substack 全文当文字稿用。 */
function htmlToReadableText(html: string): string {
  if (!html) return '';
  return decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<li\b[^>]*>/gi, '\n- ')
      .replace(/<br\s*\/?>(?=)/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|blockquote|tr|ul|ol)>/gi, '\n\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function collapseWhitespace(s: string): string {
  return s.replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = parseInt(n, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    });
}
