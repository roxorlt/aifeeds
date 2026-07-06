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

  test('gh 传 asOfDate:窗口锚到该日(+1 day 上界 / windowDays 下界),binds 带日期', async () => {
    const caps = await capture('gh', { asOfDate: '2026-07-01' });
    const c = caps[caps.length - 1];
    expect(c.sql).toContain("datetime(scraped_at) < datetime(?, '+1 day')");
    expect(c.sql).toContain("datetime(scraped_at) >= datetime(?, '+1 day', '-1 day')");
    expect(c.sql).not.toContain("datetime('now'");
    expect(c.binds).toEqual(['github', '2026-07-01', '2026-07-01', 20]);
  });

  test('hf-paper 传 asOfDate:下界用 windowDays=3', async () => {
    const caps = await capture('hf-paper', { asOfDate: '2026-07-01' });
    const c = caps[caps.length - 1];
    expect(c.sql).toContain("datetime(scraped_at) >= datetime(?, '+1 day', '-3 day')");
    expect(c.sql).toContain("datetime(scraped_at) < datetime(?, '+1 day')");
    expect(c.binds).toEqual(['hf_paper', '2026-07-01', '2026-07-01', 20]);
  });

  test('news 传 asOfDate:窗口锚到该日 + 日期 bind', async () => {
    const caps = await capture('news', { asOfDate: '2026-07-01' });
    const c = caps[0];
    expect(c.sql).toContain("datetime(scraped_at) >= datetime(?, '+1 day', '-3 day')");
    expect(c.sql).toContain("datetime(scraped_at) < datetime(?, '+1 day')");
    expect(c.sql).not.toContain("datetime('now'");
    expect(c.binds).toEqual(['2026-07-01', '2026-07-01']);
  });
});
