import { describe, test, expect } from 'vitest';
import { selectTopForSource } from './selection';
import type { Env } from '../index';
import type { DigestSource } from './config';

// Controller Amendment 验证:selectTopForSource 增加可选日期锚点 asOfDate。
// 核心约束——不传 asOfDate 时生成的 SQL/绑定参数与改动前逐字节一致(Phase 1 邮件路径零影响)。

interface Captured {
  sql: string;
  binds: unknown[];
}

function makeCapturingDb() {
  const captures: Captured[] = [];
  const db = {
    prepare(sql: string) {
      const cap: Captured = { sql, binds: [] };
      captures.push(cap);
      const stmt = {
        bind(...args: unknown[]) {
          cap.binds = args;
          return stmt;
        },
        async all<T>() {
          return { results: [] as T[] };
        },
        async first<T>() {
          return null as T | null;
        },
      };
      return stmt;
    },
  };
  return { db, captures };
}

function env(db: unknown): Env {
  return { DB: db } as unknown as Env;
}

async function capture(source: DigestSource, options?: { asOfDate?: string }) {
  const { db, captures } = makeCapturingDb();
  await selectTopForSource(env(db), source, 20, options);
  return captures;
}

describe('selectTopForSource asOfDate 锚点', () => {
  // ── 默认路径逐字节一致(改动前后不变)──

  test('gh 默认不传 asOfDate:SQL 窗口用 now,binds = [sourceType, limit]', async () => {
    const caps = await capture('gh');
    const c = caps[caps.length - 1];
    expect(c.sql).toContain("AND datetime(scraped_at) >= datetime('now','-1 day')");
    expect(c.sql).not.toContain("'+1 day'");
    expect(c.sql).not.toContain('datetime(?,');
    expect(c.binds).toEqual(['github', 20]);
  });

  test('gh 默认 SQL 与改动前逐字节一致(整串比对)', async () => {
    const caps = await capture('gh');
    const c = caps[caps.length - 1];
    // 改动前 selectTopForSource 对 gh 产出的原始 SQL(windowDays=1、extraWhere=AND is_relevant=1、
    // wcGate 空 → `${extraWhere} ${wcGate}` 末尾有一个尾随空格)。逐字节复刻。
    const expected =
      'SELECT id FROM items\n' +
      '    WHERE source_type = ?\n' +
      "      AND datetime(scraped_at) >= datetime('now','-1 day')\n" +
      '      AND deleted_at IS NULL AND is_relevant = 1 \n' +
      "    ORDER BY CAST(json_extract(metrics,'$.today_stars') AS INTEGER) DESC\n" +
      '    LIMIT ?';
    expect(c.sql).toBe(expected);
    expect(c.binds).toEqual(['github', 20]);
  });

  test('x 默认不传 asOfDate:窗口用 now,binds = [x_list, limit]', async () => {
    const caps = await capture('x');
    const c = caps[caps.length - 1];
    expect(c.sql).toContain("AND datetime(scraped_at) >= datetime('now','-1 day')");
    expect(c.sql).not.toContain("'+1 day'");
    expect(c.binds).toEqual(['x_list', 20]);
  });

  test('news 默认不传 asOfDate:窗口用 now,无日期 bind', async () => {
    const caps = await capture('news');
    const c = caps[0];
    expect(c.sql).toContain("AND datetime(scraped_at) >= datetime('now','-3 day')");
    expect(c.sql).not.toContain("'+1 day'");
    expect(c.binds).toEqual([]);
  });

  // ── asOfDate 锚点路径 ──

  test('gh 传 asOfDate:窗口锚到该日晨自然跑窗口(上界 datetime(?) 无 +1 day / 下界回退 windowDays),binds 带日期', async () => {
    const caps = await capture('gh', { asOfDate: '2026-07-01' });
    const c = caps[caps.length - 1];
    expect(c.sql).toContain("datetime(scraped_at) < datetime(?)");
    expect(c.sql).toContain("datetime(scraped_at) >= datetime(?, '-1 day')");
    expect(c.sql).not.toContain("'+1 day'");
    expect(c.sql).not.toContain("datetime('now'");
    expect(c.binds).toEqual(['github', '2026-07-01', '2026-07-01', 20]);
  });

  test('hf-paper 传 asOfDate:下界用 windowDays=3、上界无 +1 day', async () => {
    const caps = await capture('hf-paper', { asOfDate: '2026-07-01' });
    const c = caps[caps.length - 1];
    expect(c.sql).toContain("datetime(scraped_at) >= datetime(?, '-3 day')");
    expect(c.sql).toContain("datetime(scraped_at) < datetime(?)");
    expect(c.sql).not.toContain("'+1 day'");
    expect(c.binds).toEqual(['hf_paper', '2026-07-01', '2026-07-01', 20]);
  });

  test('news 传 asOfDate:窗口锚到该日晨自然跑窗口 + 日期 bind', async () => {
    const caps = await capture('news', { asOfDate: '2026-07-01' });
    const c = caps[0];
    expect(c.sql).toContain("datetime(scraped_at) >= datetime(?, '-3 day')");
    expect(c.sql).toContain("datetime(scraped_at) < datetime(?)");
    expect(c.sql).not.toContain("'+1 day'");
    expect(c.sql).not.toContain("datetime('now'");
    expect(c.binds).toEqual(['2026-07-01', '2026-07-01']);
  });

  // ── 语义级不变式:anchored(D) 必须等于 D 日晨自然跑窗口 ──
  // 自然跑在 D 日 08:00 BJT(= D 日 00:00 UTC)时默认窗口为 [datetime('now','-N day'), now],
  // now≈D 日 0 点 UTC。锚定路径必须复刻同一窗口:上界恰为 datetime(?)(= datetime(D)=D 日 0 点 UTC,
  // 绝不带 '+1 day' —— 否则整窗后移一天,前日补链把昨日页重选成今日内容、backfill 历史页整体错位一天),
  // 下界回退偏移 '-N day' 与默认路径 datetime('now','-N day') 的 '-N day' 逐字一致。此测试锁死该不变式,
  // 防止历史页错位一天回归。
  test('anchored(D) ≡ D 日晨自然跑窗口:上界无 +1 day、下界偏移与默认路径 -N day 逐字一致', async () => {
    const cases: Array<[DigestSource, number]> = [
      ['gh', 1],
      ['hf-paper', 3],
      ['news', 3],
    ];
    for (const [source, windowDays] of cases) {
      const anchoredCaps = await capture(source, { asOfDate: '2026-07-01' });
      const defaultCaps = await capture(source);
      // news 走 selectNewsByScore(主查询 = caps[0]);其余源单条查询 = caps[last]。
      const anchoredSql = source === 'news' ? anchoredCaps[0].sql : anchoredCaps[anchoredCaps.length - 1].sql;
      const defaultSql = source === 'news' ? defaultCaps[0].sql : defaultCaps[defaultCaps.length - 1].sql;
      // 上界恰为 datetime(?),绝不带 '+1 day'
      expect(anchoredSql).toContain('datetime(scraped_at) < datetime(?)');
      expect(anchoredSql).not.toContain("'+1 day'");
      // 下界偏移 '-N day' 锚定路径与默认路径逐字一致(仅锚点由 ? / 'now' 不同)
      expect(anchoredSql).toContain(`datetime(scraped_at) >= datetime(?, '-${windowDays} day')`);
      expect(defaultSql).toContain(`datetime(scraped_at) >= datetime('now','-${windowDays} day')`);
    }
  });
});
