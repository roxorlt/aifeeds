// 日报静态页生成编排:选品(daily-page.ts)→ 渲染 HTML → R2 落盘 → D1 daily_pages 索引 →
// 前日重渲染(补链) → IndexNow ping。node-run 早 8 点 Phase 4 与 admin mode=daily-page 共用。
//
// 容错自闭:pingIndexNow 永不抛错;generateDailyPage 主流程可抛(由 node-run Phase 4 的
// try/catch 兜底,失败只记日志、不影响邮件)。绝对 URL 一律走 env.SITE_BASE(getBases)。
// 设计:docs/plans/2026-07-06-daily-static-page-seo-design.md §4.1 / §4.3 / §4.4 / §4.9

import type { Env } from '../index';
import { buildDailyPageData, renderDailyPageHtml, type DailyPageData } from './daily-page';
import { getBases, bjtDateStr } from './lib';
import { authorizeFormalNewsSet } from './news-source-policy';
import { canonicalBusinessRevision } from './publication-canonical';
import { reserveAppendOnlyPublication } from './publication-storage';
import {
  assertCurrentDailyReleaseAuthorization,
  assertCurrentDailyReleaseSetAuthorization,
  loadCurrentDailyReleaseForBuild,
  materializeAppendOnlyPublication,
  projectAuthorizedDailyPageCompatibility,
  promoteDailyRelease,
} from './publication-release';

const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';

export interface DailyPageRunResult {
  date: string;
  itemCount: number;
  skipped: boolean;
  reason?: string;
}

// 页面 <title> 同源(与 daily-page.ts renderDailyPageHtml 保持一致):AI 日报 YYYY-MM-DD · {主题} | AI Feeds
function pageTitle(date: string, subject: string): string {
  return `AI 日报 ${date} · ${subject} | AI Feeds`;
}

function countItems(data: DailyPageData): number {
  return data.sections.reduce((n, s) => n + s.items.length, 0);
}

function assertPublicationGates(env: Env): void {
  const reservation = env.DAILY_PUBLICATION_RESERVATION_ENABLED === '1';
  const put = env.DAILY_PUBLICATION_PUT_ENABLED === '1';
  const promotion = env.DAILY_PUBLICATION_PROMOTION_ENABLED === '1';
  if (put && !reservation) throw new Error('invalid_daily_publication_gates:put_without_reservation');
  if (promotion && (!reservation || !put)) throw new Error('invalid_daily_publication_gates:promotion_without_dependencies');
  if (!reservation || !put || !promotion) throw new Error('daily_publication_disabled');
}

// Append-only private object + exact D1 release-head promotion. Legacy daily_pages
// remains an audit/compatibility projection and is never an outward authority.
async function persistPage(
  env: Env,
  data: DailyPageData,
): Promise<{ itemCount: number; release: Awaited<ReturnType<typeof promoteDailyRelease>> }> {
  assertPublicationGates(env);
  if (!env.READMES) throw new Error('daily_publication_r2_missing');
  const itemCount = countItems(data);
  const current = await loadCurrentDailyReleaseForBuild(env, data.date);
  const video = current?.video || null;
  const html = renderDailyPageHtml(data, env, video);
  const bytes = new TextEncoder().encode(html);
  const authorization = await authorizeFormalNewsSet(
    env, data.date, data.formalNewsItemIds, 'daily_page_reservation',
  );
  if (JSON.stringify(authorization.allowed_ids) !== JSON.stringify(data.formalNewsItemIds)) {
    throw new Error('daily_page_formal_authorization_stale');
  }
  const head = current?.head || null;
  const videoMode = head?.video_publication_id ? 'reuse_current' as const : 'none' as const;
  const businessRevisionId = await canonicalBusinessRevision({
    schema_version: 1,
    kind: 'daily_page',
    date: data.date,
    html,
    formal_news_item_ids: data.formalNewsItemIds,
    review_batch: data.reviewBatch,
    base_release_generation: Number(head?.release_generation || 0),
    base_page_publication_id: head?.page_publication_id || null,
    base_video_publication_id: head?.video_publication_id || null,
    base_video_digest: head?.video_manifest_digest || null,
    video_mode: videoMode,
  });
  const reserved = await reserveAppendOnlyPublication({ DB: env.DB }, {
    publication_date: data.date,
    publication_type: 'page',
    business_revision_id: businessRevisionId,
    objects: [{ object_role: 'html', mime: 'text/html; charset=utf-8', bytes }],
    metadata: { title: pageTitle(data.date, data.subject), item_count: itemCount, subject: data.subject },
    formal_news_item_ids: data.formalNewsItemIds,
    formal_guard_expected: JSON.parse(authorization.final_guard?.expected_json || '[]') as unknown[],
    review_batch: data.reviewBatch,
    release_binding: {
      video_mode: videoMode,
      bound_video_publication_id: head?.video_publication_id || null,
      bound_video_digest: head?.video_manifest_digest || null,
      base_release_generation: Number(head?.release_generation || 0),
      base_page_publication_id: head?.page_publication_id || null,
      base_video_publication_id: head?.video_publication_id || null,
      base_video_digest: head?.video_manifest_digest || null,
    },
  });
  await materializeAppendOnlyPublication(env, reserved.reservation, { html: bytes });
  const release = await promoteDailyRelease(env, reserved.reservation.publication_id);
  const now = new Date().toISOString();
  await projectAuthorizedDailyPageCompatibility(env, { ...release, date: data.date }, {
    title: pageTitle(data.date, data.subject), item_count: itemCount, generated_at: now, lastmod: now,
  });
  return { itemCount, release };
}

// 生成单日日报静态页。历史日期(非今日 BJT)自动锚定候选窗口到该日,避免回填时选出"当下"的 top N。
export async function generateDailyPage(
  env: Env,
  date: string,
  opts: { dry?: boolean; skipIndexNow?: boolean; skipPrevRerender?: boolean } = {},
): Promise<DailyPageRunResult> {
  const anchorToDate = date !== bjtDateStr();
  const data = await buildDailyPageData(env, date, { anchorToDate });
  if (!data) {
    console.log(`[daily-page] ${date} 选品为空,跳过生成`);
    return { date, itemCount: 0, skipped: true, reason: 'empty_pool' };
  }

  const itemCount = countItems(data);
  if (opts.dry) return { date, itemCount, skipped: false, reason: 'dry' };

  const persisted = await persistPage(env, data);

  // 前日重渲染:本日行已 UPSERT 进 daily_pages,重跑前一已生成日期的页面,其「后一日」导航即解析到本日,
  // 保证历史页链式互链完整。递归调用带 skipPrevRerender 防继续向前;skipIndexNow 不为补链再 ping。
  if (!opts.skipPrevRerender && data.prevDate) {
    try {
      await generateDailyPage(env, data.prevDate, { skipPrevRerender: true, skipIndexNow: true });
    } catch (e) {
      console.error(`[daily-page] 前日重渲染失败 ${data.prevDate}: ${String(e).slice(0, 200)}`);
    }
  }

  if (!opts.skipIndexNow) {
    await assertCurrentDailyReleaseAuthorization(env, date, persisted.release);
    const { siteBase } = getBases(env);
    await pingIndexNow(env, [
      `${siteBase}/daily/${date}`,
      `${siteBase}/daily/`,
      `${siteBase}/sitemap.xml`,
    ]);
  }

  return { date, itemCount, skipped: false };
}

// digest_pool 中有 normal 档快照的全部历史日期(升序)→ 逐日串行生成(避免 R2/D1 写放大);
// 单页不 ping,收尾一次性批量 ping 全部生成页 + 归档 + sitemap(IndexNow 单批上限 1 万 URL)。
export async function backfillDailyPages(
  env: Env,
  opts: { dry?: boolean } = {},
): Promise<DailyPageRunResult[]> {
  const rows = await env.DB.prepare(
    `SELECT DISTINCT substr(slot_key, 1, 10) AS date
       FROM digest_pool
      WHERE density = 'normal' AND item_ids IS NOT NULL AND item_ids != '[]'
      ORDER BY date ASC`,
  ).all<{ date: string }>();
  const dates = (rows.results || []).map((r) => r.date).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));

  const results: DailyPageRunResult[] = [];
  const generatedUrls: string[] = [];
  const { siteBase } = getBases(env);
  for (const date of dates) {
    const r = await generateDailyPage(env, date, { dry: opts.dry, skipIndexNow: true });
    results.push(r);
    if (!r.skipped && !opts.dry) generatedUrls.push(`${siteBase}/daily/${date}`);
  }

  if (!opts.dry && generatedUrls.length) {
    const generatedDates = results.filter((result) => !result.skipped).map((result) => result.date);
    await assertCurrentDailyReleaseSetAuthorization(env, generatedDates);
    // Deliberately no await between the collection guard returning and fetch
    // being started inside pingIndexNow.
    await pingIndexNow(env, [...generatedUrls, `${siteBase}/daily/`, `${siteBase}/sitemap.xml`]);
  }
  return results;
}

// IndexNow 提交(SEO 快速收录)。INDEXNOW_KEY 未配置→静默跳过;网络错/非 2xx 仅 console.error,永不抛错。
// opts.tag:日志来源标签(默认 'daily-page' 保持既有调用行为不变;/i/ 内容页 hook 传 'item-page',
// 便于 wrangler tail 分辨 ping 是日报页还是内容页发的)。仅影响日志前缀,不改任何提交逻辑。
export async function pingIndexNow(
  env: Env,
  urls: string[],
  opts: { tag?: string } = {},
): Promise<void> {
  const tag = opts.tag ?? 'daily-page';
  if (!env.INDEXNOW_KEY) {
    console.log(`[${tag}] IndexNow 跳过:未配置 INDEXNOW_KEY`);
    return;
  }
  if (!urls.length) return;
  const { siteBase } = getBases(env);
  let host = 'ai-feeds.com';
  try {
    host = new URL(siteBase).host;
  } catch {
    /* 回落默认 host */
  }
  try {
    const res = await fetch(INDEXNOW_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host, key: env.INDEXNOW_KEY, urlList: urls }),
    });
    if (!res.ok) {
      console.error(`[${tag}] IndexNow 非 2xx: ${res.status}`);
    } else {
      console.log(`[${tag}] IndexNow 提交 ${urls.length} 个 URL,status=${res.status}`);
    }
  } catch (e) {
    console.error(`[${tag}] IndexNow 请求异常: ${String(e).slice(0, 200)}`);
  }
}
