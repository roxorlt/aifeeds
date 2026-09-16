// 存量论文插图重跑(管理模式 hf-paper-figure-rerun,2026-09-16)
//
// 背景:arxiv 约 2026-08-10 起新渲染的网页版改用原始文件名,老逻辑拼 x1.png 全 404,
// 8/10 之后入库的论文 figure_image.source 基本都是 'none'。figure-arxiv-html.ts 改成
// 解析网页版 HTML 之后,这个模式按日期范围把存量论文重跑一遍。
//
// 每条走 fetchAr5ivAndExtractFigureForHf(env, itemId, arxivId):它会重新抓 arxiv 网页版、
// 重写 extra.figure_image 与 media[0];实在取不到插图时把 HF 缩略图迁进 R2 兜底。
// 取到插图的那些清掉 card_variant_version / card_variant_status,让现有
// card-image-variant-backfill 模式按新的 figure_image.raw_url 重新生成卡片变体。
//
// 串行执行(每条要抓整页 HTML + 若干张图,并发会撞 worker 子请求限额)。
// 写法抄 feeds/media-r2.ts 的 runCoverQualitySweep:谓词单独抽出来,batch 与 remaining 共用。

import type { Env } from '../index';
import { bjtDateStr } from '../digest/lib';
import { fetchAr5ivAndExtractFigureForHf } from './ar5iv';

export const FIGURE_RERUN_DEFAULT_LIMIT = 10;
export const FIGURE_RERUN_MAX_LIMIT = 30;
export const FIGURE_RERUN_MAX_DAYS = 14;

export interface FigureRerunOptions {
  date?: string;          // BJT YYYY-MM-DD,默认今天
  days?: number;          // 往前几天,默认 1,范围 [date-days+1, date]
  ids?: string[];         // arxiv id 列表;给了就忽略 date/days
  limit?: number;         // 默认 10,上限 30
  dry?: boolean;
  force?: boolean;        // 不看 figure_image.source,已经有插图的也重跑
}

export interface FigureRerunItem {
  id: string;
  source: string;         // figure_image.source:arxiv-html / hf_thumbnail / none
  r2_url: string | null;
}

export interface FigureRerunResult {
  scanned: number;
  rerun: number;
  figure_found: number;
  thumbnail_only: number;
  failed: number;
  remaining: number;
  items: FigureRerunItem[];
}

interface RerunRow {
  id: string;
  extra: string | null;
  media: string | null;
}

/**
 * BJT 日期区间 [date-days+1, date] 对应的 UTC 边界(左闭右开)。
 * scraped_at 存的是 ISO UTC 串,字典序即时间序,直接字符串比较即可,不依赖 SQLite 的时区函数。
 */
export function bjtRangeToUtcBounds(date: string, days: number): { start: string; end: string } {
  const dayMs = 86_400_000;
  const bjtMidnightUtcMs = Date.parse(`${date}T00:00:00Z`) - 8 * 3600 * 1000;
  const start = new Date(bjtMidnightUtcMs - (days - 1) * dayMs).toISOString();
  const end = new Date(bjtMidnightUtcMs + dayMs).toISOString();
  return { start, end };
}

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** 从一行的 extra / media 读当前插图状态(source + 站内地址)。 */
function readFigureState(row: { extra: string | null; media: string | null }): { source: string; r2_url: string | null } {
  const extra = safeParse<Record<string, unknown>>(row.extra, {});
  const fig = (extra.figure_image as Record<string, unknown> | undefined) || undefined;
  const source = fig && typeof fig === 'object' ? String(fig.source || 'none') : 'none';
  let r2 = fig && typeof fig.r2_url === 'string' ? fig.r2_url : null;
  if (!r2) {
    const media = safeParse<Array<Record<string, unknown>>>(row.media, []);
    const head = Array.isArray(media) ? media.find((m) => typeof m?.url === 'string' && String(m.url).startsWith('/r/')) : undefined;
    r2 = head ? String(head.url) : null;
  }
  return { source, r2_url: r2 };
}

export async function runHfPaperFigureRerun(
  env: Env,
  opts: FigureRerunOptions,
): Promise<FigureRerunResult> {
  const limit = Math.min(Math.max(opts.limit ?? FIGURE_RERUN_DEFAULT_LIMIT, 1), FIGURE_RERUN_MAX_LIMIT);
  const ids = (opts.ids || []).filter(Boolean).slice(0, limit);
  const force = !!opts.force;

  // 谓词(batch 与 remaining 共用)。非 force 时只挑还没拿到网页版插图的,
  // 重跑成功即退出候选 → remaining 单调递减。
  const figureGate = force ? '' : ` AND json_extract(extra, '$.figure_image.source') IS NOT 'arxiv-html'`;
  let where: string;
  let whereBinds: unknown[];
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    where = `source_type = 'hf_paper' AND id IN (${placeholders})${figureGate}`;
    whereBinds = ids.map((a) => `hf_paper:${a}`);
  } else {
    const days = Math.min(Math.max(opts.days ?? 1, 1), FIGURE_RERUN_MAX_DAYS);
    const date = opts.date || bjtDateStr();
    const { start, end } = bjtRangeToUtcBounds(date, days);
    where = `source_type = 'hf_paper' AND scraped_at >= ? AND scraped_at < ?${figureGate}`;
    whereBinds = [start, end];
  }

  const batch = await env.DB.prepare(
    `SELECT id, extra, media FROM items WHERE ${where} ORDER BY scraped_at ASC LIMIT ?`,
  )
    .bind(...whereBinds, limit)
    .all<RerunRow>();
  const rows = batch.results || [];

  const countRemaining = async (): Promise<number> => {
    const r = await env.DB.prepare(`SELECT COUNT(*) AS c FROM items WHERE ${where}`)
      .bind(...whereBinds)
      .first<{ c: number }>();
    return r?.c ?? 0;
  };

  if (opts.dry) {
    return {
      scanned: rows.length,
      rerun: 0,
      figure_found: 0,
      thumbnail_only: 0,
      failed: 0,
      remaining: await countRemaining(),
      items: rows.map((row) => ({ id: row.id, ...readFigureState(row) })),
    };
  }

  let rerun = 0;
  let figureFound = 0;
  let thumbnailOnly = 0;
  let failed = 0;
  const items: FigureRerunItem[] = [];

  for (const row of rows) {
    const arxivId = row.id.replace(/^hf_paper:/, '');
    rerun++;
    let fetched = false;
    try {
      const res = await fetchAr5ivAndExtractFigureForHf(env, row.id, arxivId);
      fetched = res.fetched;
    } catch (e) {
      console.error(`[hf-paper:figure-rerun] ${row.id} exception`, e);
    }

    const after = await env.DB.prepare(`SELECT extra, media FROM items WHERE id = ?`)
      .bind(row.id)
      .first<{ extra: string | null; media: string | null }>();
    const state = readFigureState(after || { extra: null, media: null });

    if (state.source === 'arxiv-html') {
      figureFound++;
      // 卡片变体按 figure_image.raw_url 生成,插图换了就要重生成:清游标让
      // card-image-variant-backfill 重新收这条。
      await env.DB.prepare(
        `UPDATE items SET extra = json_remove(extra, '$.card_variant_version', '$.card_variant_status') WHERE id = ?`,
      ).bind(row.id).run();
    } else if (fetched) {
      thumbnailOnly++;
    } else {
      failed++;
    }
    items.push({ id: row.id, source: state.source, r2_url: state.r2_url });
    console.log(`[hf-paper:figure-rerun] ${row.id} source=${state.source} r2=${state.r2_url ?? '-'}`);
  }

  return {
    scanned: rows.length,
    rerun,
    figure_found: figureFound,
    thumbnail_only: thumbnailOnly,
    failed,
    remaining: await countRemaining(),
    items,
  };
}
