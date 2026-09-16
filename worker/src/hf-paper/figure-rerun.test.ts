import { beforeEach, describe, expect, test, vi } from 'vitest';

// ar5iv 真跑会外呼 arxiv,这里换成可编排的桩:按 arxivId 决定重跑结果。
const outcomes = new Map<string, { fetched: boolean; source: string; r2_url?: string }>();
const rerunCalls: string[] = [];

vi.mock('./ar5iv', () => ({
  fetchAr5ivAndExtractFigureForHf: async (env: any, itemId: string, arxivId: string) => {
    rerunCalls.push(arxivId);
    const plan = outcomes.get(arxivId) || { fetched: true, source: 'none' };
    const row = env.__items.get(itemId);
    if (row) {
      const extra = JSON.parse(row.extra || '{}');
      extra.figure_image = { source: plan.source, r2_url: plan.r2_url, extracted_at: '2026-09-16T00:00:00.000Z' };
      row.extra = JSON.stringify(extra);
      if (plan.r2_url) row.media = JSON.stringify([{ type: 'image', url: plan.r2_url, role: 'figure' }]);
    }
    return { fetched: plan.fetched, has_figure: plan.source === 'arxiv-html', paragraphs_count: 0 };
  },
}));

import { bjtRangeToUtcBounds, runHfPaperFigureRerun } from './figure-rerun';

interface Row { id: string; scraped_at: string; extra: string | null; media: string | null }

/** 最小 fake DB:在内存里实现本模块用到的三条 SQL(选批 / 计数 / json_set 标记更新)。 */
function makeEnv(rows: Row[]) {
  const items = new Map(rows.map((r) => [r.id, { ...r }]));
  const figureSource = (r: Row): string | null => {
    const fig = JSON.parse(r.extra || '{}').figure_image;
    return fig && typeof fig === 'object' && fig.source !== undefined ? String(fig.source) : null;
  };
  const hasRerunMarker = (r: Row): boolean => JSON.parse(r.extra || '{}').figure_rerun_at !== undefined;
  const env: any = {
    __items: items,
    DB: {
      prepare(sql: string) {
        let binds: any[] = [];
        const stmt = {
          bind(...b: any[]) { binds = b; return stmt; },
          async all() {
            const list = select(sql, binds);
            return { results: list };
          },
          async first() {
            if (/COUNT\(\*\)/i.test(sql)) return { c: select(sql, binds, true).length };
            if (/SELECT extra, media FROM items WHERE id/i.test(sql)) {
              const r = items.get(String(binds[0]));
              return r ? { extra: r.extra, media: r.media } : null;
            }
            return null;
          },
          async run() {
            if (/json_set/i.test(sql)) {
              // 两条更新语句的 bind 顺序都是 (rerunAt, id)。
              const r = items.get(String(binds[binds.length - 1]));
              if (r) {
                const extra = JSON.parse(r.extra || '{}');
                if (/json_remove/i.test(sql)) {
                  delete extra.card_variant_version;
                  delete extra.card_variant_status;
                }
                extra.figure_rerun_at = binds[0];
                r.extra = JSON.stringify(extra);
              }
            }
            return { meta: { changes: 1 } };
          },
        };
        return stmt;
      },
    },
  };

  function select(sql: string, binds: any[], counting = false): any[] {
    const byIds = /id IN \(/.test(sql);
    const gated = /figure_image\.source'\) IS NOT 'arxiv-html'/.test(sql);
    const markerGated = /figure_rerun_at'\) IS NULL/.test(sql);
    let list = [...items.values()];
    if (byIds) {
      const n = binds.length - (counting ? 0 : 1);
      const wanted = new Set(binds.slice(0, n).map(String));
      list = list.filter((r) => wanted.has(r.id));
    } else {
      const [start, end] = binds as string[];
      list = list.filter((r) => r.scraped_at >= start && r.scraped_at < end);
    }
    if (gated) list = list.filter((r) => figureSource(r) !== 'arxiv-html');
    if (markerGated) list = list.filter((r) => !hasRerunMarker(r));
    list.sort((a, b) => a.scraped_at.localeCompare(b.scraped_at));
    if (counting) return list;
    const limit = Number(binds[binds.length - 1]) || list.length;
    return list.slice(0, limit).map((r) => ({ id: r.id, extra: r.extra, media: r.media }));
  }

  return env;
}

function paper(arxivId: string, scrapedAt: string, extra: Record<string, unknown> = {}): Row {
  return {
    id: `hf_paper:${arxivId}`,
    scraped_at: scrapedAt,
    extra: JSON.stringify(extra),
    media: JSON.stringify([{ type: 'image', url: 'https://cdn-thumbnails.huggingface.co/a.png' }]),
  };
}

beforeEach(() => {
  outcomes.clear();
  rerunCalls.length = 0;
});

describe('bjtRangeToUtcBounds', () => {
  test('days=1 → 该 BJT 日的 [前一日16:00Z, 当日16:00Z)', () => {
    expect(bjtRangeToUtcBounds('2026-09-16', 1)).toEqual({
      start: '2026-09-15T16:00:00.000Z',
      end: '2026-09-16T16:00:00.000Z',
    });
  });
  test('days=7 → 往前推 6 天', () => {
    expect(bjtRangeToUtcBounds('2026-09-16', 7).start).toBe('2026-09-09T16:00:00.000Z');
  });
});

describe('runHfPaperFigureRerun', () => {
  test('按日期范围挑候选:已经是 arxiv-html 的跳过,范围外的不动', async () => {
    const env = makeEnv([
      paper('a1', '2026-09-15T20:00:00.000Z'),                                       // BJT 9/16
      paper('a2', '2026-09-16T02:00:00.000Z', { figure_image: { source: 'arxiv-html' } }),
      paper('a3', '2026-09-16T03:00:00.000Z', { figure_image: { source: 'none' } }),
      paper('old', '2026-09-10T02:00:00.000Z'),                                      // 范围外
    ]);
    outcomes.set('a1', { fetched: true, source: 'arxiv-html', r2_url: '/r/hf/a1.png' });
    outcomes.set('a3', { fetched: true, source: 'arxiv-html', r2_url: '/r/hf/a3.png' });

    const res = await runHfPaperFigureRerun(env, { date: '2026-09-16', days: 1, limit: 10 });
    expect(rerunCalls).toEqual(['a1', 'a3']);
    expect(res.scanned).toBe(2);
    expect(res.figure_found).toBe(2);
    expect(res.remaining).toBe(0);
    expect(res.items).toEqual([
      { id: 'hf_paper:a1', source: 'arxiv-html', r2_url: '/r/hf/a1.png' },
      { id: 'hf_paper:a3', source: 'arxiv-html', r2_url: '/r/hf/a3.png' },
    ]);
  });

  test('取到插图后清掉 card_variant 游标,让卡片变体重生成', async () => {
    const env = makeEnv([paper('a1', '2026-09-15T20:00:00.000Z', {
      card_variant_version: 1, card_variant_status: 'done', keep_me: 1,
    })]);
    outcomes.set('a1', { fetched: true, source: 'arxiv-html', r2_url: '/r/hf/a1.png' });
    await runHfPaperFigureRerun(env, { date: '2026-09-16', days: 1 });
    const extra = JSON.parse(env.__items.get('hf_paper:a1').extra);
    expect(extra.card_variant_version).toBeUndefined();
    expect(extra.card_variant_status).toBeUndefined();
    expect(extra.keep_me).toBe(1);
  });

  test('只兜到缩略图 / 整条抓失败分别计数,且不清 card_variant', async () => {
    const env = makeEnv([
      paper('t1', '2026-09-15T20:00:00.000Z', { card_variant_version: 1 }),
      paper('f1', '2026-09-15T21:00:00.000Z'),
    ]);
    outcomes.set('t1', { fetched: true, source: 'hf_thumbnail', r2_url: '/r/hf/thumb.jpg' });
    outcomes.set('f1', { fetched: false, source: 'none' });

    const res = await runHfPaperFigureRerun(env, { date: '2026-09-16', days: 1 });
    expect(res.rerun).toBe(2);
    expect(res.thumbnail_only).toBe(1);
    expect(res.failed).toBe(1);
    expect(res.figure_found).toBe(0);
    expect(res.remaining).toBe(0);                       // 都没拿到网页版插图,但已打标记退出候选
    expect(JSON.parse(env.__items.get('hf_paper:t1').extra).card_variant_version).toBe(1);
    expect(typeof JSON.parse(env.__items.get('hf_paper:t1').extra).figure_rerun_at).toBe('string');
    expect(typeof JSON.parse(env.__items.get('hf_paper:f1').extra).figure_rerun_at).toBe('string');
  });

  test('ids 参数覆盖 date/days', async () => {
    const env = makeEnv([
      paper('a1', '2026-09-15T20:00:00.000Z'),
      paper('old', '2026-01-02T02:00:00.000Z'),
    ]);
    outcomes.set('old', { fetched: true, source: 'arxiv-html', r2_url: '/r/hf/old.png' });
    const res = await runHfPaperFigureRerun(env, { date: '2026-09-16', days: 1, ids: ['old'] });
    expect(rerunCalls).toEqual(['old']);
    expect(res.figure_found).toBe(1);
  });

  test('dry=1 只列将处理的条目,一条都不重跑', async () => {
    const env = makeEnv([paper('a1', '2026-09-15T20:00:00.000Z'), paper('a2', '2026-09-15T21:00:00.000Z')]);
    const res = await runHfPaperFigureRerun(env, { date: '2026-09-16', days: 1, dry: true });
    expect(rerunCalls).toEqual([]);
    expect(res.rerun).toBe(0);
    expect(res.scanned).toBe(2);
    expect(res.remaining).toBe(2);
    expect(res.items.map((i) => i.id)).toEqual(['hf_paper:a1', 'hf_paper:a2']);
    expect(res.items[0].source).toBe('none');
  });

  test('limit 封顶,按 scraped_at 升序先跑旧的', async () => {
    const env = makeEnv([
      paper('newer', '2026-09-16T05:00:00.000Z'),
      paper('older', '2026-09-15T20:00:00.000Z'),
    ]);
    const res = await runHfPaperFigureRerun(env, { date: '2026-09-16', days: 1, limit: 1 });
    expect(rerunCalls).toEqual(['older']);
    expect(res.scanned).toBe(1);
    expect(res.remaining).toBe(1);                       // 'older' 已打标记退出候选,只剩 'newer'
  });

  test('force=1 连已经有插图的也重跑', async () => {
    const env = makeEnv([paper('a2', '2026-09-16T02:00:00.000Z', { figure_image: { source: 'arxiv-html' } })]);
    outcomes.set('a2', { fetched: true, source: 'arxiv-html', r2_url: '/r/hf/a2.png' });
    const res = await runHfPaperFigureRerun(env, { date: '2026-09-16', days: 1, force: true });
    expect(rerunCalls).toEqual(['a2']);
    expect(res.figure_found).toBe(1);
  });

  test('每条处理后写 figure_rerun_at 标记:没有网页版的论文不再被非 force 反复选中,force 忽略标记', async () => {
    const env = makeEnv([
      paper('found', '2026-09-15T20:00:00.000Z'),
      paper('none', '2026-09-15T21:00:00.000Z'),
    ]);
    outcomes.set('found', { fetched: true, source: 'arxiv-html', r2_url: '/r/hf/found.png' });
    outcomes.set('none', { fetched: true, source: 'none' }); // 模拟「确实没有网页版」的论文

    const res1 = await runHfPaperFigureRerun(env, { date: '2026-09-16', days: 1 });
    expect(res1.remaining).toBe(0);

    const foundExtra = JSON.parse(env.__items.get('hf_paper:found').extra);
    const noneExtra = JSON.parse(env.__items.get('hf_paper:none').extra);
    expect(typeof foundExtra.figure_rerun_at).toBe('string');   // 成功找到插图的也打标记
    expect(typeof noneExtra.figure_rerun_at).toBe('string');    // 没找到插图(source 仍是 none)也打标记

    rerunCalls.length = 0;
    const res2 = await runHfPaperFigureRerun(env, { date: '2026-09-16', days: 1 });
    expect(rerunCalls).toEqual([]);                              // 非 force:两条都已标记,不再入选
    expect(res2.scanned).toBe(0);
    expect(res2.remaining).toBe(0);

    const res3 = await runHfPaperFigureRerun(env, { date: '2026-09-16', days: 1, force: true });
    expect([...rerunCalls].sort()).toEqual(['found', 'none']);   // force=1 忽略标记,两条都重新入选
    expect(res3.scanned).toBe(2);
  });
});
