// HuggingFace Daily Papers 抓取
//
// Phase 2:fetch handler(daily cron BJT 08:00 = UTC 00:00)
//   1. GET https://huggingface.co/api/daily_papers(返 50 条)
//   2. GET https://huggingface.co/api/papers/<arxiv_id>(per paper detail,补 githubRepo / githubStars)
//   3. arxiv.org Atom API batch 抓 categories(NEW #2,50 个 1 次拿)
//   4. INSERT items stub + extra.arxiv_categories / submitted_by / discussion_id / ... 信号位
//   5. trigger HF_PAPER_PIPELINE_WORKFLOW(Phase 3 实现 class,Phase 2 留 binding-missing fallback)
//   6. append metrics_snapshots_hf_paper
//
// 设计文档:docs/plans/2026-05-18-hf-daily-papers-source-design.md
// SOP 模板:docs/source-integration-sop.md §1.5 / §3 Phase 2

import type { Env } from '../index';
import { ingestItems, type ItemInput } from '../index';

const HF_API_BASE = 'https://huggingface.co/api';
const ARXIV_API_BASE = 'https://export.arxiv.org/api/query';
const SENTINEL_KEY_PREFIX = 'hf-daily-fetch:';
const SENTINEL_TTL = 7 * 24 * 3600; // 7 天足够防 1 天内重复跑

// 1 次 cron 触发的执行结果(传给 notifyCronSummary)
export interface HfDailyFetchResult {
  mode: 'hf-daily-fetch';
  date?: string;                          // BJT 日期 YYYY-MM-DD
  list_size?: number;                     // /api/daily_papers 返了多少
  fetched_details?: number;               // paper detail 抓成功数
  fetched_categories?: number;            // arxiv categories 抓到的 paper 数
  ingested?: { inserted: number; updated: number; errors: number };
  triggered?: number;                     // workflow trigger 成功数
  skipped?: 'sentinel' | 'no_token' | 'list_empty';
  duration_ms: number;
}

// HF API response shapes(只保留 BE 用到的字段,完整 sample 见
// docs/plans/_research/2026-05-18-hf-daily-papers-sample/)
interface HfPaperAuthor {
  _id: string;
  name: string;
  hidden?: boolean;
}

interface HfSubmitter {
  _id: string;
  avatarUrl?: string;
  user: string;
  fullname?: string;
  isPro?: boolean;
  name?: string;
  type?: string;
}

interface HfPaperListEntry {
  paper: {
    id: string;                           // arxiv id
    authors: HfPaperAuthor[];
    publishedAt: string;
    submittedOnDailyAt: string;
    title: string;
    submittedOnDailyBy: HfSubmitter;
    summary: string;
    upvotes: number;
    discussionId: string;
    projectPage: string | null;
    ai_summary?: string;
    ai_keywords?: string[];
  };
  thumbnail: string;                      // social-thumbnail URL(兜底卡片图)
  numComments: number;
  submittedBy: HfSubmitter;
  isAuthorParticipating?: boolean;
}

interface HfPaperDetail {
  id: string;
  authors: HfPaperAuthor[];
  publishedAt: string;
  submittedOnDailyAt: string;
  title: string;
  submittedOnDailyBy: HfSubmitter;
  summary: string;
  upvotes: number;
  discussionId: string;
  projectPage: string | null;
  githubRepo?: string;                    // HF 已抓的 GH repo
  githubRepoAddedBy?: string;
  githubStars?: number;                   // HF 已抓的 stars
  ai_summary?: string;
  ai_keywords?: string[];
  organization?: string;
}

/**
 * Main entry — cron 调或 admin POST /api/admin/hf-fetch-now 调
 *
 * opts:
 *   force=true 跳过 sentinel,允许同日多次跑(debug 用)
 *   date=YYYY-MM-DD 指定 BJT 日期(默认今天)
 */
export async function runHfDailyFetch(
  env: Env,
  opts: { force?: boolean; date?: string } = {},
): Promise<HfDailyFetchResult> {
  const t0 = Date.now();
  const date = opts.date ?? bjtToday();
  const sentinelKey = `${SENTINEL_KEY_PREFIX}${date}`;

  // sentinel 防同一天重复跑(cron 一天 1 次,sentinel 失效再加 admin force 覆盖)
  if (!opts.force) {
    const exists = await env.AUTH_KV.get(sentinelKey);
    if (exists) {
      return { mode: 'hf-daily-fetch', date, skipped: 'sentinel', duration_ms: Date.now() - t0 };
    }
  }

  if (!env.HF_READ) {
    return { mode: 'hf-daily-fetch', date, skipped: 'no_token', duration_ms: Date.now() - t0 };
  }

  // 1. 拉 daily_papers listing
  const listing = await fetchDailyPapersList(env);
  if (!listing || listing.length === 0) {
    console.warn(`[hf-paper] daily_papers list empty for ${date}`);
    return { mode: 'hf-daily-fetch', date, skipped: 'list_empty', duration_ms: Date.now() - t0 };
  }
  console.log(`[hf-paper] daily_papers list size: ${listing.length}`);

  // 2. Per-paper detail(并行 50 个,拿 githubRepo / githubStars)
  //    单次 ~50 subrequests,远低于 CF Workers paid 1000/invocation cap
  const detailResults = await Promise.all(
    listing.map((entry) => fetchPaperDetail(env, entry.paper.id)),
  );
  let detailsOk = 0;
  const arxivIds: string[] = [];
  for (const d of detailResults) {
    if (d) {
      detailsOk++;
      arxivIds.push(d.id);
    }
  }
  console.log(`[hf-paper] details fetched: ${detailsOk}/${listing.length}`);

  // 3. arxiv.org Atom API batch 抓 categories(NEW #2)
  //    单次 1 个请求拿 50 个,远比 workflow 内 single fetch 快
  //    workflow step 0 fetch-arxiv-categories 单 paper 兜底(Phase 3 实现)
  const categoriesMap = await fetchArxivCategoriesBatch(arxivIds);
  console.log(`[hf-paper] arxiv categories fetched: ${categoriesMap.size}/${arxivIds.length}`);

  // 4. 映射到 ItemInput shape
  const items: ItemInput[] = [];
  const scrapedAtIso = new Date().toISOString();
  for (let i = 0; i < listing.length; i++) {
    const entry = listing[i];
    const detail = detailResults[i];
    if (!detail) continue;                // detail 抓失败 skip 整条
    const categories = categoriesMap.get(detail.id) ?? [];
    items.push(transformToItemInput(entry, detail, categories, scrapedAtIso));
  }

  // 5. ingest 到 D1
  const ingestResult = await ingestItems(env, items);
  console.log(
    `[hf-paper] ingest: inserted=${ingestResult.inserted} errors=${ingestResult.errors.length}`,
  );

  // 6. trigger workflow per new paper(workflow_completed_at IS NULL 的)
  //    binding-missing fallback:Phase 3 加 class 前 trigger 返 'binding_missing',
  //    Phase 2 commit 不阻断,只 log skip
  let triggered = 0;
  if (items.length > 0) {
    const sourceIds = items.map((i) => i.source_id);
    const placeholders = sourceIds.map(() => '?').join(',');
    const needsWorkflow = await env.DB.prepare(
      `SELECT id, extra FROM items
        WHERE source_type='hf_paper'
          AND source_id IN (${placeholders})
          AND deleted_at IS NULL
          AND json_extract(extra, '$.workflow_completed_at') IS NULL`,
    ).bind(...sourceIds).all<{ id: string; extra: string | null }>();
    for (const r of needsWorkflow.results) {
      const extraObj = r.extra ? JSON.parse(r.extra) : {};
      const arxivId = String(r.id).replace(/^hf_paper:/, '');
      const res = await triggerHfPaperWorkflowForItem(env, r.id, arxivId, {
        hasGhRepo: !!extraObj.github_repo,
        hasProjectPage: !!extraObj.project_page,
        hasDiscussionId: !!extraObj.discussion_id,
      });
      if (res === 'triggered') triggered++;
    }
    console.log(`[hf-paper] workflows_triggered=${triggered}/${needsWorkflow.results.length}`);
  }

  // 7. append metrics_snapshots_hf_paper
  await appendMetricsSnapshots(env, items);

  // 8. 设 KV sentinel
  await env.AUTH_KV.put(sentinelKey, '1', { expirationTtl: SENTINEL_TTL });

  return {
    mode: 'hf-daily-fetch',
    date,
    list_size: listing.length,
    fetched_details: detailsOk,
    fetched_categories: categoriesMap.size,
    ingested: {
      inserted: ingestResult.inserted,
      updated: 0,                          // ingestItems 不区分 insert/update(UPSERT)
      errors: ingestResult.errors.length,
    },
    triggered,
    duration_ms: Date.now() - t0,
  };
}

// ────────────────────────────────────────────────────────────────────
// HF API client helpers
// ────────────────────────────────────────────────────────────────────

async function fetchDailyPapersList(env: Env): Promise<HfPaperListEntry[] | null> {
  try {
    const r = await fetch(`${HF_API_BASE}/daily_papers`, {
      headers: { 'Authorization': `Bearer ${env.HF_READ}` },
    });
    if (!r.ok) {
      console.error(`[hf-paper] /api/daily_papers HTTP ${r.status}`);
      return null;
    }
    return (await r.json()) as HfPaperListEntry[];
  } catch (e) {
    console.error('[hf-paper] /api/daily_papers fetch exception', e);
    return null;
  }
}

async function fetchPaperDetail(env: Env, arxivId: string): Promise<HfPaperDetail | null> {
  try {
    const r = await fetch(`${HF_API_BASE}/papers/${arxivId}`, {
      headers: { 'Authorization': `Bearer ${env.HF_READ}` },
    });
    if (!r.ok) {
      console.warn(`[hf-paper] /api/papers/${arxivId} HTTP ${r.status}`);
      return null;
    }
    return (await r.json()) as HfPaperDetail;
  } catch (e) {
    console.error(`[hf-paper] /api/papers/${arxivId} fetch exception`, e);
    return null;
  }
}

/**
 * arxiv.org Atom API batch 抓 categories(NEW #2)
 *
 * arxiv.org API:
 *   GET http://export.arxiv.org/api/query?id_list=<id1>,<id2>,...&max_results=N
 *   返 Atom XML,每个 entry 含 <arxiv:primary_category term="cs.LG"/> + <category term="cs.LG"/>
 *
 * Rate limit:3 sec/query(arxiv.org 推荐),但 batch 单次拿 50 远低于;无 token 需求。
 *
 * 失败容错:整个 batch 失败返空 Map,workflow step 0 单 paper 兜底(Phase 3 实现)
 */
async function fetchArxivCategoriesBatch(
  arxivIds: string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (arxivIds.length === 0) return result;

  // ⚠️ 2026-05-18 Phase 2 staging verify:CF Workers IP 段被 arxiv.org WAF 拦
  // (3 次 retry 全 HTTP 429,retry-after=0 即直接 ban,跟 §10 风险 #6 一致)。
  // Batch 50 个 1 次拿在 CF 侧不可行。
  //
  // 解决路径:Phase 3 workflow step 0 改 **per-paper 单独 fetch**,
  // 50 paper 分散到 wall-clock 几小时间隔(workflow fan-out instance 跨节点 +
  // CF schedule jitter 自然降 RPS),触发 ban 风险低。
  //
  // Phase 2 暂行:1 attempt + 失败 fallback 返空 Map,不阻断 ingest;Phase 3 上线
  // 后 categories 字段会逐步填上。FE 列头 dropdown 暂时显有限 categories(已抓到的)。
  const idList = arxivIds.join(',');
  const url = `${ARXIV_API_BASE}?id_list=${idList}&max_results=${arxivIds.length}`;

  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; aifeeds-bot/1.0)' },
    });
    if (r.status === 429) {
      console.warn(`[hf-paper] arxiv categories HTTP 429(CF IP banned by arxiv WAF),Phase 3 step 0 兜底`);
      return result;
    }
    if (!r.ok) {
      console.error(`[hf-paper] arxiv categories HTTP ${r.status}`);
      return result;
    }
    const xml = await r.text();
    parseArxivCategoriesXml(xml, result);
    console.log(`[hf-paper] arxiv categories OK: ${result.size}/${arxivIds.length}`);
  } catch (e) {
    console.error('[hf-paper] arxiv categories fetch exception', e);
  }
  return result;
}

/**
 * 极简 XML parse — 不引依赖,只用正则提关键字段。
 *
 * Atom feed 结构:
 *   <entry>
 *     <id>http://arxiv.org/abs/2605.13301v1</id>
 *     <arxiv:primary_category term="cs.LG" scheme="..."/>
 *     <category term="cs.LG" scheme="..."/>
 *     <category term="cs.CL" scheme="..."/>
 *   </entry>
 *
 * primary_category 放 [0],其他 categories append。
 */
function parseArxivCategoriesXml(xml: string, out: Map<string, string[]>): void {
  // split by <entry>...</entry>
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xml)) !== null) {
    const entry = m[1];
    // 提 arxiv id:<id>http://arxiv.org/abs/2605.13301v1</id> → 2605.13301
    const idMatch = entry.match(/<id>http:\/\/arxiv\.org\/abs\/([\d.]+)(?:v\d+)?<\/id>/);
    if (!idMatch) continue;
    const arxivId = idMatch[1];

    // primary_category(放 [0])
    const primaryMatch = entry.match(/<arxiv:primary_category\s+term="([^"]+)"/);
    const primary = primaryMatch ? primaryMatch[1] : null;

    // 所有 categories(顺序保留)
    const categories: string[] = [];
    const catRe = /<category\s+term="([^"]+)"/g;
    let cm: RegExpExecArray | null;
    while ((cm = catRe.exec(entry)) !== null) {
      categories.push(cm[1]);
    }

    // primary 放 [0],其他 append(避免重复)
    const ordered: string[] = [];
    if (primary) ordered.push(primary);
    for (const c of categories) {
      if (!ordered.includes(c)) ordered.push(c);
    }
    if (ordered.length > 0) out.set(arxivId, ordered);
  }
}

// ────────────────────────────────────────────────────────────────────
// ItemInput 映射(参考 §3.1 / §3.2)
// ────────────────────────────────────────────────────────────────────

function transformToItemInput(
  entry: HfPaperListEntry,
  detail: HfPaperDetail,
  categories: string[],
  scrapedAtIso: string,
): ItemInput {
  const p = detail;                       // detail 比 listing 字段更全,优先用
  const author0 = p.authors[0]?.name ?? '';
  const submitterUser = p.submittedOnDailyBy?.user ?? '';
  const ghRepoFull = p.githubRepo
    ? (p.githubRepo.startsWith('http') ? p.githubRepo : `https://github.com/${p.githubRepo}`)
    : null;

  const extra: Record<string, unknown> = {
    submitted_on_daily_at: p.submittedOnDailyAt,
    submitted_by: {
      user: p.submittedOnDailyBy?.user,
      fullname: p.submittedOnDailyBy?.fullname,
      avatar_url: p.submittedOnDailyBy?.avatarUrl,
      raw_avatar_url: p.submittedOnDailyBy?.avatarUrl,
      is_pro: p.submittedOnDailyBy?.isPro ?? false,
    },
    discussion_id: p.discussionId,
    project_page: p.projectPage,
    github_repo: ghRepoFull,
    github_stars: p.githubStars ?? null,
    github_repo_added_by: p.githubRepoAddedBy ?? null,
    ai_summary_en: p.ai_summary ?? null,
    ai_keywords: p.ai_keywords ?? [],
    arxiv_categories: categories,         // NEW #2(可能空数组,workflow step 0 兜底)
    paper_authors: (p.authors || []).map((a) => ({ name: a.name })),  // PM 反馈 #2:完整 author list
    is_author_participating: entry.isAuthorParticipating ?? false,
    // 所有 _zh / deep_analysis / ar5iv_* / discussion_comments / figure_image
    // workflow step 完成后填,Phase 2 不写
  };

  const media = [{ type: 'image', url: entry.thumbnail }];

  const metrics = {
    upvotes: p.upvotes,
    num_comments: entry.numComments,
    github_stars: p.githubStars ?? null,
  };

  return {
    source_type: 'hf_paper',
    source_id: p.id,                      // arxiv id,id = 'hf_paper:<arxiv_id>'
    title: p.title,
    content: p.summary,
    author: author0,
    handle: submitterUser,
    url: `https://huggingface.co/papers/${p.id}`,
    media,
    metrics,
    published_at: p.publishedAt,
    scraped_at: scrapedAtIso,
    is_relevant: 1,                        // HF Daily 已策展,无 LLM judge
    lang: 'en',
    extra,
  };
}

// ────────────────────────────────────────────────────────────────────
// metrics_snapshots_hf_paper append
// ────────────────────────────────────────────────────────────────────

async function appendMetricsSnapshots(env: Env, items: ItemInput[]): Promise<void> {
  if (items.length === 0) return;
  const capturedAt = Math.floor(Date.now() / 1000);
  const stmts = items.map((item) => {
    const m = item.metrics as { upvotes?: number; num_comments?: number; github_stars?: number | null };
    return env.DB.prepare(
      `INSERT INTO metrics_snapshots_hf_paper (item_id, captured_at, upvotes, num_comments, github_stars)
        VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      `hf_paper:${item.source_id}`,
      capturedAt,
      m.upvotes ?? null,
      m.num_comments ?? null,
      m.github_stars ?? null,
    );
  });
  try {
    await env.DB.batch(stmts);
  } catch (e) {
    console.error('[hf-paper] appendMetricsSnapshots batch fail', e);
  }
}

// ────────────────────────────────────────────────────────────────────
// triggerHfPaperWorkflowForItem(参考 SOP §1.5 + ph.ts 模板)
// ────────────────────────────────────────────────────────────────────

export interface HfPaperWorkflowSignals {
  hasGhRepo: boolean;
  hasProjectPage: boolean;
  hasDiscussionId: boolean;
}

export async function triggerHfPaperWorkflowForItem(
  env: { DB: D1Database; HF_PAPER_PIPELINE_WORKFLOW?: Workflow },
  itemId: string,
  arxivId: string,
  signals: HfPaperWorkflowSignals,
): Promise<'triggered' | 'already_exists' | 'binding_missing' | 'failed'> {
  // Phase 2 / Phase 3 cutover 期:binding 还没加(class 还没写),返 binding_missing
  // 静默,fetch handler 跑批 log 显示 triggered=0,正常
  if (!env.HF_PAPER_PIPELINE_WORKFLOW) return 'binding_missing';

  const nowUnix = Math.floor(Date.now() / 1000);

  // 写 marker 防 30min 内重复 trigger
  try {
    await env.DB.prepare(
      `UPDATE items SET extra = json_set(coalesce(extra, '{}'), '$.workflow_triggered_at', ?) WHERE id = ?`,
    ).bind(nowUnix, itemId).run();
  } catch (e) {
    console.error(`[hf-paper-trigger] mark failed for ${itemId}:`, e);
  }

  // hour-bucket suffix(防 stuck instance 永远阻塞,SOP §1.5 N fix)
  const hourBucket = new Date().toISOString().slice(0, 13).replace('T', '-');
  // arxivId 含 . 字符,instance id 校验只允许 [a-zA-Z0-9-],把 . 换 -
  const safeArxiv = arxivId.replace(/[^a-zA-Z0-9-]/g, '-');
  const instanceId = `hf-paper-${safeArxiv}-${hourBucket}`;

  try {
    await env.HF_PAPER_PIPELINE_WORKFLOW.create({
      id: instanceId,
      params: {
        itemId,
        arxivId,
        hasGhRepo: signals.hasGhRepo,
        hasProjectPage: signals.hasProjectPage,
        hasDiscussionId: signals.hasDiscussionId,
        lang: 'zh' as const,
      },
    });
    return 'triggered';
  } catch (e) {
    if (String(e).toLowerCase().includes('already exists')) return 'already_exists';
    console.error(`[hf-paper-trigger] create failed for ${itemId}:`, e);
    return 'failed';
  }
}

// ────────────────────────────────────────────────────────────────────
// 时区 helper(BJT 日期)
// ────────────────────────────────────────────────────────────────────

function bjtToday(): string {
  // BJT = UTC+8
  const nowMs = Date.now() + 8 * 3600 * 1000;
  return new Date(nowMs).toISOString().slice(0, 10);
}
