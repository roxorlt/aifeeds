// worker/src/scrapers/ph-description-translate.ts
//
// Task 3（2026-07-06）：Product Hunt item 的 extra.description（英文，均值 317 字）翻译为中文
// 写入 extra.description_zh，供 daily 静态页 SEO 展示（Task 4 消费；无译文时回退 ai_summary）。
//
// 存量回填 admin mode（mode=ph-description-translate&limit=N[&dry=1]，Bearer INGEST_TOKEN）。
// 新入库 PH 走 ph-pipeline workflow 的 translate-fields step（translatePhFieldsForItem）自动翻，
// 两条路径复用同一个 translatePhBatch 封装（./ph-translate，无 index.ts 依赖，可单测）。
//
// 幂等 / 游标单调：谓词 = product_hunt 且 description 非空且 description_zh 空。写了 description_zh
// 就退出谓词，天然不重译。翻译失败（DeepSeek 挂/缺 key）保留空、不写坏值，下轮重头。dry 零写、
// 不调 DeepSeek（只预览选中面）。已是中文的 description 直通写回（罕见，防无限重扫）。

import type { Env } from '../index';
import { translatePhBatch, isLikelyChinesePh } from './ph-translate';

// 谓词：PH + description 非空 + description_zh 尚未生成。
const PH_DESC_PREDICATE = `
  source_type = 'product_hunt'
  AND json_extract(extra, '$.description') IS NOT NULL
  AND json_extract(extra, '$.description') != ''
  AND json_extract(extra, '$.description_zh') IS NULL`;

interface PhDescRow {
  id: string;
  extra: string | null;
}

export interface PhDescriptionTranslateResult {
  scanned: number;
  translated: number;
  remaining: number;
}

async function countRemaining(env: Env): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM items WHERE ${PH_DESC_PREDICATE}`,
  ).first<{ c: number }>();
  return row?.c ?? 0;
}

/**
 * 分页扫 PH items 中 description 有英文原文但无 description_zh 的行，翻译写回 extra.description_zh。
 * 返回 {scanned, translated, remaining}。scanned = 本轮选中的候选数；translated = 实际写入的条数；
 * remaining = 处理后仍待翻译的总数。dry=true 时零写、不调 DeepSeek，remaining 保持满值。
 */
export async function runPhDescriptionTranslate(
  env: Env,
  opts: { limit: number; dry: boolean },
): Promise<PhDescriptionTranslateResult> {
  const batch = await env.DB.prepare(
    `SELECT id, extra FROM items WHERE ${PH_DESC_PREDICATE} LIMIT ?`,
  )
    .bind(opts.limit)
    .all<PhDescRow>();

  const rows = batch.results || [];
  const scanned = rows.length;

  // dry：只预览选中面，不烧 DeepSeek、不写库。
  if (opts.dry) {
    return { scanned, translated: 0, remaining: await countRemaining(env) };
  }

  // 解析候选，分流：已是中文 → 直通写回（passthrough）；英文 → 送 DeepSeek。
  interface Cand {
    id: string;
    extra: Record<string, unknown>;
    text: string;
    passthrough: boolean;
    trIdx: number; // 在 toTranslate 中的下标，passthrough 时为 -1
  }
  const cands: Cand[] = [];
  const translateTexts: string[] = [];
  for (const r of rows) {
    let extra: Record<string, unknown> = {};
    try {
      extra = r.extra ? (JSON.parse(r.extra) as Record<string, unknown>) : {};
    } catch {
      extra = {};
    }
    const text = typeof extra.description === 'string' ? extra.description : '';
    if (!text) continue; // 谓词已挡空，冗余守卫
    const passthrough = isLikelyChinesePh(text);
    const trIdx = passthrough ? -1 : translateTexts.length;
    if (!passthrough) translateTexts.push(text);
    cands.push({ id: r.id, extra, text, passthrough, trIdx });
  }

  // 只在有英文待翻且拿到 key 时调 DeepSeek；缺 key → 英文条目本轮不写（留待下轮）。
  const trMap =
    translateTexts.length > 0 && env.DEEPSEEK_API_KEY
      ? await translatePhBatch(env.DEEPSEEK_API_KEY, translateTexts)
      : new Map<number, string>();

  let translated = 0;
  for (const c of cands) {
    const zh = c.passthrough ? c.text : trMap.get(c.trIdx) ?? null;
    if (!zh) continue; // 翻译失败 → 保留空，不写坏值
    await env.DB.prepare(
      `UPDATE items SET extra = json_set(COALESCE(extra, '{}'), '$.description_zh', ?) WHERE id = ?`,
    )
      .bind(zh, c.id)
      .run();
    translated++;
  }

  return { scanned, translated, remaining: await countRemaining(env) };
}
