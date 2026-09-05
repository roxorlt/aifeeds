/**
 * 手工补录线索的正文补充（enrichment）。
 *
 * owner 直接录入（`owner_asserted_v1`）让线索绕过取证一步入池，代价是口播词只有 owner
 * 写的那一句话 —— 标题与证据文本取的是同一句陈述，模型没有别的素材可写。这个模块在
 * **入池之后**去补一段背景素材：有链接就抓那条链接的正文，没链接就拿文字线索去搜。
 *
 * 三条不可动的边界（`docs/plans/2026-09-04-manual-lead-enrichment-spec.md` 第 1 节）：
 *
 * 1. **入池不得被它阻塞**。补充是入池之后的异步增强，抓取失败、模型失败、网关超时都只
 *    意味着「这条候选保持只有陈述的状态」，与补充上线之前的行为一模一样。所以这里的每
 *    个失败路径都收敛成 `null`，从不往外抛。
 * 2. **不碰被正式新闻门绑定的字段**。`items` 的 title / content / content_translated /
 *    author / url / published_at 与 `extra.event_fingerprint` 跟签名投影逐字绑定，补充
 *    只写 `extra.manual_evidence_text` 与 `extra.manual_evidence_source` 这两个新键。
 * 3. **不覆盖 `extra.ai_summary_zh`**。那是卡片与静态页显示的那句话，也是 owner 自己写
 *    的主张；补充素材是口播的**补充证据**，不是替换品。
 */
import type { Env } from '../index';

/** 补充素材的长度上限（code point）。口播只要背景，不要整篇正文。 */
export const MANUAL_EVIDENCE_TEXT_MAX_CODE_POINTS = 400;
/** 单条线索的取材总预算。超时就放弃，候选保持原样。 */
export const MANUAL_LEAD_ENRICHMENT_BUDGET_MS = 60_000;
/** 网关 `/v1/plain-text` 的 query 上限（UTF-16 长度）。超了整个请求会被 400 掉。 */
export const MANUAL_LEAD_ENRICHMENT_QUERY_MAX_LENGTH = 200;

export type ManualEvidenceKind = 'tweet' | 'document' | 'search+document';

/** 取证网关轻量入口回来的原始素材（未压缩）。 */
export interface ManualEnrichmentMaterial {
  text: string;
  url: string;
  publisher: string;
  kind: ManualEvidenceKind;
  /** 合并进这份正文的每一份素材的出处；网关只取到一份时可以没有。 */
  sources?: ManualEvidenceMaterialSource[];
}

/**
 * 发给网关的取材请求。**有链接时 url 与 query 一起发**（2026-09-04 owner 纠正）：
 * 链接给的是这条消息本身，描述是找同一件事其他报道的依据，写口播词要的是两者合起来的
 * 背景。上一版二选一，给了链接就不搜，素材常常薄到只够复述 owner 的那一句话。
 */
export interface ManualEnrichmentRequest {
  url?: string;
  query?: string;
}

/** 一份素材的出处。网关合并了「链接正文 + 搜索素材」时会逐份列出来。 */
export interface ManualEvidenceMaterialSource {
  url: string;
  publisher: string;
  kind: ManualEvidenceKind;
}

/**
 * 落进 `extra.manual_evidence_source` 的来源记录，供排查与在审核卡片上标注来源。
 *
 * 顶层三个字段说的是主来源（有链接时就是 owner 给的那条链接）。`sources` 只在网关真的
 * 合并了不止一份素材时才写：单份素材的形状与补充上线之初逐字一致，读老行的地方不用改。
 * 写进 extra 的键始终只有 `manual_evidence_text` 与 `manual_evidence_source` 两个。
 */
export interface ManualEvidenceSource {
  url: string;
  publisher: string;
  fetched_at: string;
  kind: ManualEvidenceKind;
  sources?: ManualEvidenceMaterialSource[];
}

export interface ManualLeadEnrichmentResult {
  text: string;
  source: ManualEvidenceSource;
}

export interface ManualLeadEnrichmentAdapters {
  /**
   * 一次调用覆盖全部取材路径：带 `url` 就抓那一条（X status 链接由网关自己转推文接口），
   * 带 `query` 就按描述搜索，两者都带就两路并发、网关合并后回一份。抓不到回 `null`。
   */
  fetchPlainText(input: ManualEnrichmentRequest): Promise<ManualEnrichmentMaterial | null>;
  /** 把正文压成 2–4 句中文背景。压不出来回 `null`。 */
  compress(material: ManualEnrichmentMaterial): Promise<string | null>;
}

export function clampEnrichmentText(value: unknown): string {
  const collapsed = String(value ?? '').replace(/\s+/g, ' ').trim();
  return Array.from(collapsed).slice(0, MANUAL_EVIDENCE_TEXT_MAX_CODE_POINTS).join('');
}

/**
 * 组装发给网关的取材请求：有什么给什么，两样都没有回 `null`。
 *
 * 描述按网关的 200 上限截断 —— owner 的陈述常常比这长，整条请求被 400 掉的话这条线索
 * 就一份素材都拿不到，截断至少还能搜到东西。
 */
export function manualLeadEnrichmentRequest(
  clue: { url?: string | null; text?: string | null },
): ManualEnrichmentRequest | null {
  const url = String(clue.url || '').trim();
  const collapsed = String(clue.text || '').replace(/\s+/g, ' ').trim();
  let query = '';
  for (const char of collapsed) {
    if (query.length + char.length > MANUAL_LEAD_ENRICHMENT_QUERY_MAX_LENGTH) break;
    query += char;
  }
  if (!url && !query) return null;
  return { ...(url ? { url } : {}), ...(query ? { query } : {}) };
}

/**
 * 已有签名证据的线索（`llm_verified` / `source_support_v1` / 有证据的 `owner_vouched_v1`）
 * 不触发补充：它们的 `ai_summary_zh` 本来就是核验过的正文摘要，再补一段只会重复。
 */
export function manualLeadNeedsEnrichment(lead: { evidence?: readonly unknown[] }): boolean {
  return (lead.evidence?.length || 0) === 0;
}

/** 让整轮取材受一个总预算约束。超时不是错误，是「这次不补」。 */
function withBudget<T>(work: Promise<T>, budgetMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), budgetMs);
  });
  return Promise.race([work, expiry]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * 取一段背景素材。**任何失败都回 `null`** —— 调用方据此什么都不写。
 */
export async function collectManualLeadEnrichment(
  clue: { url: string | null; text: string },
  adapters: ManualLeadEnrichmentAdapters,
  opts: { now?: number; budgetMs?: number } = {},
): Promise<ManualLeadEnrichmentResult | null> {
  const now = opts.now ?? Date.now();
  const budgetMs = opts.budgetMs ?? MANUAL_LEAD_ENRICHMENT_BUDGET_MS;
  const url = String(clue.url || '').trim();
  // 既没链接也没文字就没有任何取材依据，连网关都不必打扰。
  const request = manualLeadEnrichmentRequest(clue);
  if (!request) return null;

  const work = (async (): Promise<ManualLeadEnrichmentResult | null> => {
    const material = await adapters.fetchPlainText(request);
    if (!material || !String(material.text || '').trim()) return null;
    const compressed = clampEnrichmentText(await adapters.compress(material));
    if (!compressed) return null;
    // 只有真的合并了不止一份素材才记 sources：一份素材时留着这个键，只会让「来源」看起来
    // 比实际丰富，也让老行与新行的形状白白分叉。
    const materialSources = Array.isArray(material.sources) ? material.sources : [];
    return {
      text: compressed,
      source: {
        url: String(material.url || url || ''),
        publisher: String(material.publisher || '').trim() || '未知来源',
        fetched_at: new Date(now).toISOString(),
        kind: material.kind,
        ...(materialSources.length > 1 ? { sources: materialSources } : {}),
      },
    };
  })();

  try {
    return await withBudget(work.catch((error) => {
      console.warn('[manual-lead-enrichment] collect failed:', String((error as Error)?.message || error).slice(0, 200));
      return null;
    }), budgetMs);
  } catch {
    return null;
  }
}

export type ManualLeadEnrichmentOutcome = 'skipped' | 'written' | 'empty' | 'failed';

/**
 * 幂等地把补充素材写进候选对应的 items 行。
 *
 * `json_set` 只改这两个键，其余 `extra` 内容与所有被门禁绑定的列一字不动；WHERE 上的
 * `manual_evidence_text IS NULL` 保证重复触发不会覆盖已有素材（幂等的第二道，第一道是
 * 取材之前的那次读）。
 */
export async function runManualLeadEnrichment(
  env: Env,
  input: { leadId: string; itemId: string; url: string | null; text: string },
  adapters: ManualLeadEnrichmentAdapters,
  opts: { now?: number; budgetMs?: number } = {},
): Promise<ManualLeadEnrichmentOutcome> {
  try {
    const row = await env.DB.prepare(
      `/* manual_lead:enrichment_existing */ SELECT extra FROM items WHERE id = ?`,
    ).bind(input.itemId).first<{ extra: string | null }>();
    if (!row) return 'skipped';
    if (existingEnrichmentText(row.extra)) return 'skipped';

    const collected = await collectManualLeadEnrichment(input, adapters, opts);
    if (!collected) return 'empty';

    await env.DB.prepare(
      `/* manual_lead:enrichment_write */ UPDATE items
       SET extra = json_set(
         CASE WHEN extra IS NOT NULL AND json_valid(extra) = 1 THEN extra ELSE '{}' END,
         '$.manual_evidence_text', ?,
         '$.manual_evidence_source', json(?))
       WHERE id = ?
         AND json_extract(
           CASE WHEN extra IS NOT NULL AND json_valid(extra) = 1 THEN extra ELSE '{}' END,
           '$.manual_evidence_text') IS NULL`,
    ).bind(collected.text, JSON.stringify(collected.source), input.itemId).run();
    return 'written';
  } catch (error) {
    // 入池已经完成了。补充失败只是少一段背景，绝不能变成 owner 那次确认的失败。
    console.warn(
      `[manual-lead-enrichment] lead=${input.leadId} failed:`,
      String((error as Error)?.message || error).slice(0, 200),
    );
    return 'failed';
  }
}

function existingEnrichmentText(extra: string | null): boolean {
  if (!extra) return false;
  try {
    const parsed = JSON.parse(extra) as Record<string, unknown>;
    return typeof parsed?.manual_evidence_text === 'string' && parsed.manual_evidence_text.trim() !== '';
  } catch {
    return false;
  }
}

/** 补取一轮最多并发几条。网关那台机器的抓取有自己的队列，压太狠只会互相排队。 */
export const MANUAL_LEAD_BACKFILL_CONCURRENCY = 3;
/** 补取一轮的总预算。到点就停，剩下的候选保持只有陈述的状态。 */
export const MANUAL_LEAD_BACKFILL_BUDGET_MS = 60_000;
/** 单条线索在补取里的预算。比提交时那次短：出片等不起。 */
export const MANUAL_LEAD_BACKFILL_LEAD_BUDGET_MS = 20_000;
/** 一天的手工候选本来就有上限，这里再兜一道，防一次扫描拉回一整年的行。 */
export const MANUAL_LEAD_BACKFILL_MAX_LEADS = 50;

export interface ManualLeadBackfillStats {
  scanned: number;
  written: number;
  empty: number;
  failed: number;
  skipped: number;
}

/**
 * 出片之前把当天还空着的手工候选再取一遍素材。
 *
 * **为什么需要它**：提交时那次取材是 `ctx.waitUntil` 顺手做的，失败就没有第二次机会 ——
 * 等到写口播词那一步，模型手上还是只有 owner 的一句话。补取在真正组装 payload 之前跑，
 * 把「素材必须在写口播词之前备齐」这件事落到实处。
 *
 * **它伤不到任何东西**：只看当天已确认、零证据、还没有 `manual_evidence_text` 的候选；
 * 写入仍走 `runManualLeadEnrichment`，也就是仍然只写那两个 extra 键；整个函数不抛异常，
 * 数据库读失败也只是回一份零统计 —— 补取失败绝不能变成出片失败。
 */
export async function backfillManualLeadEnrichment(
  env: Env,
  date: string,
  adapters: ManualLeadEnrichmentAdapters,
  opts: {
    now?: () => number;
    budgetMs?: number;
    leadBudgetMs?: number;
    concurrency?: number;
    maxLeads?: number;
  } = {},
): Promise<ManualLeadBackfillStats> {
  const stats: ManualLeadBackfillStats = { scanned: 0, written: 0, empty: 0, failed: 0, skipped: 0 };
  const now = opts.now ?? (() => Date.now());
  const deadline = now() + (opts.budgetMs ?? MANUAL_LEAD_BACKFILL_BUDGET_MS);
  const leadBudgetMs = opts.leadBudgetMs ?? MANUAL_LEAD_BACKFILL_LEAD_BUDGET_MS;
  const concurrency = Math.max(1, opts.concurrency ?? MANUAL_LEAD_BACKFILL_CONCURRENCY);
  const maxLeads = Math.max(1, opts.maxLeads ?? MANUAL_LEAD_BACKFILL_MAX_LEADS);

  let pending: Array<{ lead_id: string; input_url: string | null; input_text: string | null }>;
  try {
    // 候选行按主键与 l.id 拼出来的常量取，走的是 items 的主键与 manual_news_leads 的
    // review_date 索引；json_extract 只在连上之后的那一行上判断，不参与选行。
    const rows = await env.DB.prepare(
      `/* manual_lead:enrichment_backfill_scan */ SELECT
         l.id AS lead_id, l.input_url AS input_url, l.input_text AS input_text
       FROM manual_news_leads l
       JOIN items i ON i.id = 'blog:manual:' || l.id
       WHERE l.review_date = ?
         AND l.confirmed_at IS NOT NULL
         AND json_extract(
           CASE WHEN i.extra IS NOT NULL AND json_valid(i.extra) = 1 THEN i.extra ELSE '{}' END,
           '$.manual_evidence_text') IS NULL
         AND NOT EXISTS (SELECT 1 FROM manual_news_evidence e WHERE e.lead_id = l.id)
       ORDER BY l.id ASC
       LIMIT ?`,
    ).bind(date, maxLeads).all<{ lead_id: string; input_url: string | null; input_text: string | null }>();
    pending = rows.results || [];
  } catch (error) {
    console.warn('[manual-lead-enrichment] backfill scan failed:',
      String((error as Error)?.message || error).slice(0, 200));
    return stats;
  }

  stats.scanned = pending.length;
  if (!pending.length) return stats;

  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < pending.length) {
      if (now() >= deadline) return;
      const row = pending[cursor++];
      const outcome = await runManualLeadEnrichment(env, {
        leadId: row.lead_id,
        itemId: `blog:manual:${row.lead_id}`,
        url: row.input_url || null,
        text: row.input_text || '',
      }, adapters, { now: now(), budgetMs: leadBudgetMs });
      stats[outcome] += 1;
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, () => worker()));
  } catch (error) {
    // runManualLeadEnrichment 自己就把失败收敛成返回值了，走到这里只可能是意料之外的东西。
    console.warn('[manual-lead-enrichment] backfill failed:',
      String((error as Error)?.message || error).slice(0, 200));
  }
  return stats;
}
