// item 页生成编排（Task 4 交付）—— 单条内容 SSR 静态页的「渲染 → R2 落盘 → D1 索引」编排层。
// 结构照搬日报页编排 daily-page-run.ts（R2 put + item_pages upsert + 分批 / 存在性游标 / dry）。
// 设计:docs/plans/2026-07-08-item-ssr-pages-design.md §4.2 / §4.3 / §4.4
//
// 关键契约（务必与 Task 3 伺服层 item-routes.ts 对齐，否则伺服读不到）：
// - R2 key 一律用 render.ts 的 itemPageR2Key(id)（不自己拼 key）；PH 用含 date 的整 composite id 算 key
// - item_pages.source 存 DigestSource 口径（x|gh|ph|hf-paper|news），与 R2 前缀（x/gh/ph/paper/news）
//   是两命名空间：item_pages 表按 item_id 存、R2 按 itemPageR2Key 算 —— 别混用
//
// 出页 5 类源（x/gh/ph/hf-paper/news）且 is_relevant=1 才出页；clawhub / huodongxing / 未知源
// 与非 relevant 一律 skipped 零写（itemPageR2Key 对不可出页源返回 null，即生成层的源 gate）。

import type { Env } from '../index';
import type { DigestSource } from '../digest/config';
import type { RenderRow, RenderedItem } from '../digest/render';
import { getBases } from '../digest/lib';
import { fetchItemRow } from '../digest/item-fetch';
import { itemPageR2Key, itemPagePath, renderItem } from '../digest/render';
import { renderItemPageHtml } from './item-page';

export interface ItemPageRunResult {
  itemId: string;
  skipped: boolean;
  reason?: string;
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

// extra.dedup_of 非空 → 该 item 是 dedup 次源（被主源隐藏，见 feeds/dedup.ts），不出独立页。
// 口径同 feeds/dedup.ts 的 json_extract(extra,'$.dedup_of')：非空（非 null 非空串）即次源。
function isDedupSuppressed(extra: string | null | undefined): boolean {
  if (!extra) return false;
  try {
    const d = (JSON.parse(extra) as { dedup_of?: unknown }).dedup_of;
    return d != null && d !== '';
  } catch {
    return false;
  }
}

// 同源近期相关内链（3-5 条）：同 source_type、relevant、非 dedup 次源、排除自身、按发布时间倒序取 6 条，
// 各自 renderItem 成 RenderedItem 传给渲染器（渲染器只用 item_id + title 织 /i/ 内链）。
// dedup 次源排除（I2）：避免织出指向被隐藏次源 /i/ 页的软 404 内链 / 触发按需生成。
async function fetchRelated(env: Env, mainId: string, source: DigestSource): Promise<RenderedItem[]> {
  const sts = SOURCE_TYPES[source];
  if (!sts.length) return [];
  const ph = sts.map(() => '?').join(',');
  const rows = await env.DB.prepare(
    `SELECT * FROM items
      WHERE source_type IN (${ph}) AND id != ? AND is_relevant = 1
        AND json_extract(extra, '$.dedup_of') IS NULL
      ORDER BY published_at DESC
      LIMIT 6`,
  )
    .bind(...sts, mainId)
    .all<RenderRow>();
  const { apiBase } = getBases(env);
  return (rows.results || [])
    .slice(0, 5)
    .map((r, i) => renderItem(source, r, i + 1, apiBase));
}

// 单条内容静态页生成。fetchItemRow → is_relevant!=1 或源∉五源 → skipped 零写；
// 否则查同源相关 3-5 条 → renderItemPageHtml → R2 put(itemPageR2Key) → item_pages upsert(status=live)。
// 幂等：同 id 二次生成 UPSERT 覆盖（R2 同 key 覆盖 + item_pages 不新增行）；dry 零写不调 R2/D1 写。
export async function generateItemPage(
  env: Env,
  id: string,
  opts: { dry?: boolean } = {},
): Promise<ItemPageRunResult> {
  const row = (await fetchItemRow(env, id)) as (RenderRow & { is_relevant?: number }) | null;
  if (!row) return { itemId: id, skipped: true, reason: 'not-found' };
  if (Number(row.is_relevant) !== 1) return { itemId: id, skipped: true, reason: 'not-relevant' };

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

  const related = await fetchRelated(env, id, source);
  const html = renderItemPageHtml(row, env, related);
  await env.READMES!.put(key, html, {
    httpMetadata: { contentType: 'text/html; charset=utf-8' },
  });
  await env.DB.prepare(
    `INSERT INTO item_pages (item_id, source, url_path, generated_at, status)
     VALUES (?, ?, ?, ?, 'live')
     ON CONFLICT(item_id) DO UPDATE SET
       source = excluded.source, url_path = excluded.url_path,
       generated_at = excluded.generated_at, status = 'live'`,
  )
    .bind(id, source, urlPath, new Date().toISOString())
    .run();

  return { itemId: id, skipped: false };
}

// 下架：把 item_pages.status 置 'gone'（伺服层转 410 + noindex，sitemap 排除）。
// is_relevant 被改判 0 或 item 删除时调用（enrich 收尾 / 下架 mode）。R2 快照可留（伺服按 status gate）。
export async function markItemPageGone(env: Env, id: string): Promise<void> {
  await env.DB.prepare(`UPDATE item_pages SET status = 'gone' WHERE item_id = ?`).bind(id).run();
}

// 存量分源回填：按 source 扫 is_relevant=1 且未在 item_pages 的 item → generateItemPage。
// 分批（默认 300）；item_pages 存在性即退出游标（生成即入表，下批天然排除，游标单调）；
// dry 零写（不写 → 游标不推进，remaining 反映全量待办）。经香港 60s 提断按行数核对（同 daily backfill 教训）。
export async function backfillItemPages(
  env: Env,
  source: OutSource,
  opts: { limit?: number; dry?: boolean } = {},
): Promise<{ scanned: number; generated: number; remaining: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 300, 1), 1000);
  const dry = !!opts.dry;
  const sts = SOURCE_TYPES[source];
  const ph = sts.map(() => '?').join(',');

  // 选取本批：该源、relevant、非 dedup 次源、尚未生成（NOT EXISTS item_pages）。发布时间倒序（新内容优先收录）。
  // dedup 谓词（C1）：json_extract(i.extra,'$.dedup_of') IS NULL，让 dedup 次源不算「待办」（否则永远 scanned 不收敛）。
  const rows = await env.DB.prepare(
    `SELECT i.id FROM items i
      WHERE i.source_type IN (${ph}) AND i.is_relevant = 1
        AND json_extract(i.extra, '$.dedup_of') IS NULL
        AND NOT EXISTS (SELECT 1 FROM item_pages p WHERE p.item_id = i.id)
      ORDER BY i.published_at DESC
      LIMIT ?`,
  )
    .bind(...sts, limit)
    .all<{ id: string }>();
  const ids = (rows.results || []).map((r) => r.id);

  let generated = 0;
  for (const id of ids) {
    const r = await generateItemPage(env, id, { dry });
    if (!r.skipped) generated++;
  }

  // remaining：重新计数仍未生成的（存在性即游标）。real 模式已入表 → 递减；dry 未写 → 不变。
  const cnt = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM items i
      WHERE i.source_type IN (${ph}) AND i.is_relevant = 1
        AND json_extract(i.extra, '$.dedup_of') IS NULL
        AND NOT EXISTS (SELECT 1 FROM item_pages p WHERE p.item_id = i.id)`,
  )
    .bind(...sts)
    .first<{ n: number }>();

  return { scanned: ids.length, generated, remaining: Number(cnt?.n ?? 0) };
}
