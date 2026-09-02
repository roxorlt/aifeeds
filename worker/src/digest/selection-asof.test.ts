import { describe, test, expect } from 'vitest';
import { selectTopForSource } from './selection';
import type { Env } from '../index';
import type { DigestSource } from './config';

// Controller Amendment 验证:selectTopForSource 增加可选日期锚点 asOfDate。
// GH 再次上榜不会改写首次入库 scraped_at，因此时间锚点必须优先读取
// last_seen_on_trending_at；其它源仍保持 scraped_at 窗口语义。

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
  // ── 默认路径 ──

  test('gh 默认不传 asOfDate:SQL 窗口用 now,binds = [sourceType, limit]', async () => {
    const caps = await capture('gh');
    const c = caps[caps.length - 1];
    expect(c.sql).toContain("json_extract(extra,'$.last_seen_on_trending_at')");
    expect(c.sql).toContain("datetime(json_extract(extra,'$.trending_date_str'))");
    expect(c.sql).toContain("datetime(scraped_at)");
    expect(c.sql).toContain(">= datetime('now','-1 day')");
    expect(c.sql).not.toContain("'+1 day'");
    expect(c.sql).not.toContain('datetime(?,');
    expect(c.binds).toEqual(['github', 20]);
  });

  test('gh 默认 SQL 使用 current-trending 时间表达式且其它排序/过滤不变', async () => {
    const caps = await capture('gh');
    const c = caps[caps.length - 1];
    expect(c.sql).toContain('COALESCE(');
    expect(c.sql).toContain("datetime(CAST(json_extract(extra,'$.last_seen_on_trending_at') AS INTEGER), 'unixepoch')");
    expect(c.sql).toContain('AND deleted_at IS NULL AND is_relevant = 1');
    expect(c.sql).toContain("ORDER BY CAST(json_extract(metrics,'$.today_stars') AS INTEGER) DESC");
    expect(c.binds).toEqual(['github', 20]);
  });

  test('x 默认不传 asOfDate:窗口用 now,binds = [x_list, limit]', async () => {
    const caps = await capture('x');
    const c = caps[caps.length - 1];
    expect(c.sql).toContain("AND datetime(scraped_at) >= datetime('now','-1 day')");
    expect(c.sql).not.toContain("'+1 day'");
    expect(c.binds).toEqual(['x_list', 20]);
  });

  // news 走两阶段(2026-09-02 D1 CPU 事故修复):caps[0] = 阶段一候选发现(纯 items 查询,
  // 时间边界改为 JS 算好的裸串绑参,列上不再套 datetime() —— 否则时间索引永久失效)。
  test('news 默认不传 asOfDate:阶段一窗口下界为 now-3day 的裸串绑参,无上界', async () => {
    const before = Date.now();
    const caps = await capture('news');
    const after = Date.now();
    const c = caps[0];
    expect(c.sql).toContain('news_selection:candidate_discovery');
    expect(c.sql).toContain('i.scraped_at >= ?');
    expect(c.sql).not.toContain('i.scraped_at < ?');
    expect(c.sql).not.toContain('datetime(i.scraped_at)');
    expect(c.sql).not.toContain("'+1 day'");
    // binds = [since, cap]
    expect(c.binds).toHaveLength(2);
    const since = Date.parse(String(c.binds[0]));
    expect(String(c.binds[0])).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
    expect(since).toBeGreaterThanOrEqual(before - 3 * 86400_000 - 1000);
    expect(since).toBeLessThanOrEqual(after - 3 * 86400_000);
    expect(typeof c.binds[1]).toBe('number');
  });

  // ── asOfDate 锚点路径 ──

  test('gh 传 asOfDate:窗口锚到该日晨自然跑窗口(上界 datetime(?) 无 +1 day / 下界回退 windowDays),binds 带日期', async () => {
    const caps = await capture('gh', { asOfDate: '2026-07-01' });
    const c = caps[caps.length - 1];
    expect(c.sql).toContain("json_extract(extra,'$.last_seen_on_trending_at')");
    expect(c.sql).toContain(") < datetime(?)");
    expect(c.sql).toContain(") >= datetime(?, '-1 day')");
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

  test('news 传 asOfDate:阶段一窗口锚到该日晨自然跑窗口(上界 = 当日 0 点 UTC,不加一天)', async () => {
    const caps = await capture('news', { asOfDate: '2026-07-01' });
    const c = caps[0];
    expect(c.sql).toContain('news_selection:candidate_discovery');
    expect(c.sql).toContain('i.scraped_at >= ? AND i.scraped_at < ?');
    expect(c.sql).not.toContain('datetime(i.scraped_at)');
    expect(c.sql).not.toContain("'+1 day'");
    expect(c.sql).not.toContain("datetime('now'");
    // binds = [since, until, cap];上界恰为 datetime('2026-07-01') = 该日 0 点 UTC。
    expect(c.binds).toHaveLength(3);
    expect(c.binds[0]).toBe('2026-06-28T00:00:00.000Z');
    expect(c.binds[1]).toBe('2026-07-01T00:00:00.000Z');
    expect(typeof c.binds[2]).toBe('number');
  });

  test('news 非法 asOfDate 与事故前同样 fail closed(选不出任何候选)', async () => {
    const caps = await capture('news', { asOfDate: 'not-a-date' });
    const c = caps[0];
    expect(c.binds[0]).toBe('9999-12-31T23:59:59.999Z');
    expect(c.binds[1]).toBe('9999-12-31T23:59:59.999Z');
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
    ];
    for (const [source, windowDays] of cases) {
      const anchoredCaps = await capture(source, { asOfDate: '2026-07-01' });
      const defaultCaps = await capture(source);
      const anchoredSql = anchoredCaps[anchoredCaps.length - 1].sql;
      const defaultSql = defaultCaps[defaultCaps.length - 1].sql;
      const timeExprTail = source === 'gh' ? ')' : 'datetime(scraped_at)';
      // 上界恰为 datetime(?),绝不带 '+1 day'
      expect(anchoredSql).toContain(`${timeExprTail} < datetime(?)`);
      expect(anchoredSql).not.toContain("'+1 day'");
      // 下界偏移 '-N day' 锚定路径与默认路径逐字一致(仅锚点由 ? / 'now' 不同)
      expect(anchoredSql).toContain(`${timeExprTail} >= datetime(?, '-${windowDays} day')`);
      expect(defaultSql).toContain(`${timeExprTail} >= datetime('now','-${windowDays} day')`);
    }
  });

  // news 的时间窗从 SQL 表达式改成 JS 算好的绑参(两阶段拆分),同一个不变式改为直接
  // 断言边界值本身 —— 比断言 SQL 文本更强:上界必须恰好是 D 日 0 点 UTC(不加一天),
  // 下界必须恰好回退 3 天。加一天会让历史页回填整体错位一天。
  test('news anchored(D) ≡ D 日晨自然跑窗口:上界恰为当日 0 点 UTC、下界恰回退 3 天', async () => {
    for (const date of ['2026-07-01', '2026-01-01', '2026-03-01', '2026-12-31']) {
      const caps = await capture('news', { asOfDate: date });
      const [since, until] = caps[0].binds as [string, string];
      expect(until).toBe(`${date}T00:00:00.000Z`);
      expect(Date.parse(until) - Date.parse(since)).toBe(3 * 86400_000);
    }
  });
});
