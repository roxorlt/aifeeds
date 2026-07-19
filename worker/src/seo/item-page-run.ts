// item 页生成编排（Task 4 交付）—— 单条内容 SSR 静态页的「渲染 → R2 落盘 → D1 索引」编排层。
// 结构照搬日报页编排 daily-page-run.ts（R2 put + item_pages upsert + 分批 / 存在性游标 / dry）。
// 设计:docs/plans/2026-07-08-item-ssr-pages-design.md §4.2 / §4.3 / §4.4
//
// 关键契约（务必与 Task 3 伺服层 item-routes.ts 对齐，否则伺服读不到）：
// - R2 key 一律用 render.ts 的 itemPageR2Key(id)（不自己拼 key）；PH 用含 date 的整 composite id 算 key
// - item_pages.source 存 DigestSource 口径（x|gh|ph|hf-paper|news），与 R2 前缀（x/gh/ph/paper/news）
//   是两命名空间：item_pages 表按 item_id 存、R2 按 itemPageR2Key 算 —— 别混用
//
// 出页 5 类源（x/gh/ph/hf-paper/news）且 is_relevant=1、cn_sensitive!=1 才出页；
// clawhub / huodongxing / 未知源、非 relevant 与涉华敏感条目一律 skipped 零写
//（itemPageR2Key 对不可出页源返回 null，即生成层的源 gate）。

import type { Env } from '../index';
import type { DigestSource } from '../digest/config';
import type { RenderRow, RenderedItem } from '../digest/render';
import { getBases } from '../digest/lib';
import { fetchItemRow } from '../digest/item-fetch';
import { itemPageR2Key, itemPagePath, renderItem } from '../digest/render';
import { renderItemPageHtml } from './item-page';
import {
  itemCnNotSensitiveSql,
  itemCnSensitiveSql,
  itemDedupedSql,
  itemNotDedupedSql,
  isCnSensitive,
  isDedupSuppressed,
} from './item-page-policy';

export interface ItemPageRunResult {
  itemId: string;
  skipped: boolean;
  reason?: string;
  // 仅 !skipped 的实写路径有值：本次生成是否让页面「转入 live」（状态实质变化）——
  //   true  = 页面此前不是 live：item_pages 无该行（首次收录），或 status='gone'（复活，此前 410）；
  //   false = 页面此前已是 live：re-enrich / metrics 刷新 / 重译，仅覆盖写、状态未变。
  // enrich hook 据此「只对转入 live 的页 ping IndexNow」：首次收录 + gone→live 复活都通知
  // 搜索引擎（复活尤其关键——此前 410 已告知搜索引擎删除，不 ping 它可能永不回来抓）；live→live
  // 不重推已收录 URL。dry / skipped 路径不置此字段（undefined → hook 视作不 ping）。
  becameLive?: boolean;
}

// 出页 5 类源（+ clawhub 占位满足类型）→ items.source_type 列表（反向于 selection.SOURCE_TYPE）。
// news 是 blog+podcast 合并虚拟源；backfill 与相关内链查询共用此谓词表。
type OutSource = 'x' | 'gh' | 'ph' | 'hf-paper' | 'news';
const SOURCE_TYPES: Record<DigestSource, string[]> = {
  x: ['x_list'],
  gh: ['github'],
  ph: ['product_hunt'],
  'hf-paper': ['hf_paper'],
  news: ['blog', 'podcast'],
  clawhub: ['clawhub'], // 占位：不出页，但让映射类型完整
};

const ITEM_CN_NOT_SENSITIVE_SQL = itemCnNotSensitiveSql('i.extra');
const ITEM_CN_SENSITIVE_SQL = itemCnSensitiveSql('i.extra');
const ITEM_NOT_DEDUPED_SQL = itemNotDedupedSql('i.extra');
const ITEM_DEDUPED_SQL = itemDedupedSql('i.extra');

// composite id 的 source_type 前缀 → DigestSource（与 item-page.ts digestSourceForId 同口径）。
// 出页 5 类返回对应 DigestSource；clawhub 返回 'clawhub'（后续被 itemPageR2Key null gate 挡）；
// huodongxing / 未知前缀 → null。
function digestSourceForId(itemId: string): DigestSource | null {
  const idx = itemId.indexOf(':');
  const st = idx >= 0 ? itemId.slice(0, idx) : itemId;
  switch (st) {
    case 'x_list':
      return 'x';
    case 'github':
      return 'gh';
    case 'product_hunt':
      return 'ph';
    case 'hf_paper':
      return 'hf-paper';
    case 'blog':
    case 'podcast':
      return 'news';
    case 'clawhub':
      return 'clawhub';
    default:
      return null;
  }
}

// 同源稳定时间邻居：按 (published_at 回退 scraped_at DESC, id DESC) 的主时间线，取当前项前后各 3 条。
// 只织入已经 live 且仍 relevant/未软删/非 dedup/非涉华敏感的页面，避免历史页长期指向
// “全站最新 5 条”而形成不稳定链接图，也避免链接到 gone/404。
async function fetchRelated(
  env: Env,
  main: RenderRow & { published_at?: string | null; scraped_at?: string | null },
  source: DigestSource,
): Promise<RenderedItem[]> {
  const sts = SOURCE_TYPES[source];
  const effectiveAt = String(main.published_at || main.scraped_at || '').trim();
  if (!sts.length || !effectiveAt) return [];
  const ph = sts.map(() => '?').join(',');
  const candidateTime = "COALESCE(NULLIF(i.published_at, ''), i.scraped_at)";
  const gates = `p.status = 'live'
        AND i.is_relevant = 1
        AND i.deleted_at IS NULL
        AND ${ITEM_NOT_DEDUPED_SQL}
        AND ${ITEM_CN_NOT_SENSITIVE_SQL}`;
  const newer = await env.DB.prepare(
    `SELECT i.* FROM items i
      JOIN item_pages p ON p.item_id = i.id
      WHERE i.source_type IN (${ph}) AND ${gates}
        AND (${candidateTime} > ? OR (${candidateTime} = ? AND i.id > ?))
      ORDER BY ${candidateTime} ASC, i.id ASC
      LIMIT 3`,
  )
    .bind(...sts, effectiveAt, effectiveAt, main.id)
    .all<RenderRow>();
  const older = await env.DB.prepare(
    `SELECT i.* FROM items i
      JOIN item_pages p ON p.item_id = i.id
      WHERE i.source_type IN (${ph}) AND ${gates}
        AND (${candidateTime} < ? OR (${candidateTime} = ? AND i.id < ?))
      ORDER BY ${candidateTime} DESC, i.id DESC
      LIMIT 3`,
  )
    .bind(...sts, effectiveAt, effectiveAt, main.id)
    .all<RenderRow>();
  const { apiBase } = getBases(env);
  return [...(newer.results || []).reverse(), ...(older.results || [])]
    .map((r, i) => renderItem(source, r, i + 1, apiBase));
}

// 单条内容静态页生成。fetchItemRow → is_relevant!=1、cn_sensitive=1 或源∉五源 → skipped 零写；
// 否则查同源相关 3-5 条 → renderItemPageHtml → R2 put(itemPageR2Key) → item_pages upsert(status=live)。
// 幂等：同 id 二次生成 UPSERT 覆盖（R2 同 key 覆盖 + item_pages 不新增行）；dry 零写不调 R2/D1 写。
//
// force：本函数本就是「覆盖写」语义（无「已存在则跳过」判断，每次都重渲染 + upsert），故 force 在此层
// 不改变行为，仅作为 API 对称位（backfill 透传下来，语义显式化）。关键：dedup 门(C1) + is_relevant 门
// 是 force 之前的无条件早退，force 永不绕过它们（次源/非 relevant 在 force 下仍 skipped 零写）。
export async function generateItemPage(
  env: Env,
  id: string,
  opts: { dry?: boolean; force?: boolean } = {},
): Promise<ItemPageRunResult> {
  const row = (await fetchItemRow(env, id)) as (RenderRow & { is_relevant?: number }) | null;
  if (!row) return { itemId: id, skipped: true, reason: 'not-found' };
  if (Number(row.is_relevant) !== 1) return { itemId: id, skipped: true, reason: 'not-relevant' };
  if (isCnSensitive(row.extra)) {
    return { itemId: id, skipped: true, reason: 'cn-sensitive' };
  }

  // dedup 门（C1，一处堵三路）：extra.dedup_of 非空 → 是被主源隐藏的 dedup 次源，零写跳过。
  // 主源亦是 backfill / 按需兜底 / 相关内链引导 三路调用的公共出口，此处堵死避免重复内容页侵蚀 SEO。
  if (isDedupSuppressed(row.extra)) {
    return { itemId: id, skipped: true, reason: 'dedup-suppressed' };
  }

  // 源 gate：itemPageR2Key / itemPagePath 对不可出页源（clawhub / huodongxing / 未知）返回 null。
  const key = itemPageR2Key(id);
  const urlPath = itemPagePath(id);
  const source = digestSourceForId(id);
  if (!key || !urlPath || !source || source === 'clawhub') {
    return { itemId: id, skipped: true, reason: 'unsupported-source' };
  }

  if (opts.dry) return { itemId: id, skipped: false, reason: 'dry' };

  const related = await fetchRelated(env, row, source);
  const html = renderItemPageHtml(row, env, related);
  await env.READMES!.put(key, html, {
    httpMetadata: { contentType: 'text/html; charset=utf-8' },
  });
  // 「转入 live」判定（供 enrich hook 决定是否 ping IndexNow）：UPSERT 前查 item_pages 现状——
  //   无行 = 首次生成；status='gone' = 复活（此前 410）；两者都算「转入 live」→ 需通知搜索引擎。
  //   已 live = re-enrich / metrics 刷新 / 重译，仅覆盖写、状态未变 → 不重推已收录 URL。
  // status 仅两值：'live'（本函数 UPSERT）/ 'gone'（markItemPageGone），故 !== 'live' 即 gone 复活。
  // 与 backfill 无关：backfill 不经 hook，force 重灌 3.2 万即便逐条 becameLive 也不 ping（本函数不 ping）。
  const prior = await env.DB.prepare(`SELECT status FROM item_pages WHERE item_id = ?`)
    .bind(id)
    .first<{ status: string }>();
  const becameLive = !prior || prior.status !== 'live';
  await env.DB.prepare(
    `INSERT INTO item_pages (item_id, source, url_path, generated_at, status)
     VALUES (?, ?, ?, ?, 'live')
     ON CONFLICT(item_id) DO UPDATE SET
       source = excluded.source, url_path = excluded.url_path,
       generated_at = excluded.generated_at, status = 'live'`,
  )
    .bind(id, source, urlPath, new Date().toISOString())
    .run();

  return { itemId: id, skipped: false, becameLive };
}

// 下架：把 item_pages.status 置 'gone'（伺服层转 410 + noindex，sitemap 排除）。
// is_relevant 被改判 0 或 item 删除时调用（enrich 收尾 / 下架 mode）。R2 快照可留（伺服按 status gate）。
export async function markItemPageGone(env: Env, id: string): Promise<void> {
  await env.DB.prepare(`UPDATE item_pages SET status = 'gone' WHERE item_id = ?`).bind(id).run();
}

// 存量分源回填：按 source 扫 is_relevant=1、cn_sensitive!=1 且未在 item_pages 的 item
// → generateItemPage。
// 分批（默认 300）；item_pages 存在性即退出游标（生成即入表，下批天然排除，游标单调）；
// dry 零写（不写 → 游标不推进，remaining 反映全量待办）。经香港 60s 提断按行数核对（同 daily backfill 教训）。
//
// force（升级存量薄页 = gh222/ph500）：谓词去掉「NOT EXISTS 任意页」，改为「NOT EXISTS 本轮已重灌页」——
// 即选中「无页 OR 页 generated_at < cutoff」。cutoff = 本轮 campaign 起点(ISO)，全程固定：重灌把该行
// generated_at 推到 >= cutoff → 永久退出候选 → 游标自推进、单调收敛、可重入不无限循环（机制同非 force 的
// NOT EXISTS，只是「已处理」判据从「存在页」换成「存在本轮之后重灌的页」）。dedup(C1)+is_relevant 门保留。
// 跨 HTTP 续跑：调用方须回传上轮返回的 cutoff（否则每次重取 now 会让已重灌行重新入选 → 抖动不收敛）。
export async function backfillItemPages(
  env: Env,
  source: OutSource,
  opts: { limit?: number; dry?: boolean; force?: boolean; cutoff?: string } = {},
): Promise<{ scanned: number; generated: number; remaining: number; cutoff?: string }> {
  const limit = Math.min(Math.max(opts.limit ?? 300, 1), 1000);
  const dry = !!opts.dry;
  const force = !!opts.force;
  const sts = SOURCE_TYPES[source];
  const ph = sts.map(() => '?').join(',');

  // 「已处理」判据：非 force = 存在任意页；force = 存在「本轮 cutoff 之后重灌的页」（generated_at >= cutoff）。
  // 后者让已生成薄页（generated_at < cutoff）重新算「待办」被重灌，重灌后 generated_at>=cutoff 退出候选。
  const doneClause = force
    ? `NOT EXISTS (SELECT 1 FROM item_pages p WHERE p.item_id = i.id AND p.generated_at >= ?)`
    : `NOT EXISTS (SELECT 1 FROM item_pages p WHERE p.item_id = i.id)`;
  const cutoff = force ? opts.cutoff ?? new Date().toISOString() : undefined;
  // force 谓词多一个 cutoff 绑定，插在 sts 之后、limit 之前（COUNT 无 limit）。
  const selectExtra: unknown[] = force ? [cutoff] : [];

  // 选取本批：该源、relevant、非 dedup 次源、按 doneClause 未处理。发布时间倒序（新内容优先收录）。
  // dedup 谓词（C1）：共享 policy 让 dedup 次源不算「待办」（force 下亦然，不收敛问题）。
  const rows = await env.DB.prepare(
    `SELECT i.id FROM items i
      WHERE i.source_type IN (${ph}) AND i.is_relevant = 1
        AND ${ITEM_NOT_DEDUPED_SQL}
        AND ${ITEM_CN_NOT_SENSITIVE_SQL}
        AND ${doneClause}
      ORDER BY i.published_at DESC
      LIMIT ?`,
  )
    .bind(...sts, ...selectExtra, limit)
    .all<{ id: string }>();
  const ids = (rows.results || []).map((r) => r.id);

  let generated = 0;
  for (const id of ids) {
    const r = await generateItemPage(env, id, { dry, force });
    if (!r.skipped) generated++;
  }

  // remaining：重新计数仍未处理的（doneClause 即游标）。real 模式已推进 generated_at → 递减；dry 未写 → 不变。
  const cnt = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM items i
      WHERE i.source_type IN (${ph}) AND i.is_relevant = 1
        AND ${ITEM_NOT_DEDUPED_SQL}
        AND ${ITEM_CN_NOT_SENSITIVE_SQL}
        AND ${doneClause}`,
  )
    .bind(...sts, ...selectExtra)
    .first<{ n: number }>();

  const result: { scanned: number; generated: number; remaining: number; cutoff?: string } = {
    scanned: ids.length,
    generated,
    remaining: Number(cnt?.n ?? 0),
  };
  if (force) result.cutoff = cutoff; // 供调用方跨批续传，维持同一 campaign
  return result;
}

const LIVE_PAGE_COMPLIANCE_VIOLATION = `p.status = 'live'
        AND (
          ${ITEM_CN_SENSITIVE_SQL}
          OR COALESCE(i.is_relevant, 0) != 1
          OR i.deleted_at IS NOT NULL
          OR ${ITEM_DEDUPED_SQL}
        )`;

// 存量合规 reconciliation：把已经 live、但当前已涉华敏感/不相关/软删/dedup 的页面置 gone。
// dry 只扫描不写；remaining 始终在本轮动作之后重算，便于管理员按批次运行直至收敛到 0。
export async function reconcileItemPageCompliance(
  env: Env,
  opts: { limit?: number; dry?: boolean } = {},
): Promise<{ scanned: number; markedGone: number; remaining: number }> {
  const rawLimit = opts.limit;
  const normalizedLimit =
    rawLimit == null || !Number.isFinite(rawLimit) ? 300 : Math.trunc(rawLimit);
  const limit = Math.min(Math.max(normalizedLimit, 1), 1000);
  const candidateSql = `SELECT p.item_id
     FROM item_pages p
     JOIN items i ON i.id = p.item_id
     WHERE ${LIVE_PAGE_COMPLIANCE_VIOLATION}
     ORDER BY p.item_id ASC
     LIMIT ?`;

  let scanned = 0;
  let markedGone = 0;
  if (opts.dry) {
    const selected = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM (${candidateSql}) candidates`,
    )
      .bind(limit)
      .first<{ n: number }>();
    scanned = Number(selected?.n ?? 0);
  } else {
    const updated = await env.DB.prepare(
      `UPDATE item_pages
       SET status = 'gone'
       WHERE status = 'live'
         AND item_id IN (${candidateSql})`,
    )
      .bind(limit)
      .run();
    markedGone = Number(updated.meta?.changes ?? 0);
    scanned = markedGone;
  }

  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS n
     FROM item_pages p
     JOIN items i ON i.id = p.item_id
     WHERE ${LIVE_PAGE_COMPLIANCE_VIOLATION}`,
  ).first<{ n: number }>();

  return {
    scanned,
    markedGone,
    remaining: Number(count?.n ?? 0),
  };
}
