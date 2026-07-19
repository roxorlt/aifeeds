import { describe, expect, test } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import type { Env } from '../index';
import { reconcileItemPageCompliance } from './item-page-run';

interface SqliteD1Options {
  beforeUpdate?: (db: DatabaseSync) => void;
}

function sqliteD1(db: DatabaseSync, options: SqliteD1Options = {}) {
  let beforeUpdateCalled = false;
  return {
    prepare(sql: string) {
      let bindings: SQLInputValue[] = [];
      const statement = {
        bind(...values: unknown[]) {
          if (values.length > 100) {
            throw new Error(`D1 bind limit exceeded: ${values.length}`);
          }
          bindings = values as SQLInputValue[];
          return statement;
        },
        async all<T>() {
          return {
            results: db.prepare(sql).all(...bindings) as unknown as T[],
          };
        },
        async first<T>() {
          return (db.prepare(sql).get(...bindings) ?? null) as T | null;
        },
        async run() {
          if (
            !beforeUpdateCalled &&
            options.beforeUpdate &&
            /UPDATE\s+item_pages\s+SET\s+status\s*=\s*'gone'/i.test(sql)
          ) {
            beforeUpdateCalled = true;
            options.beforeUpdate(db);
          }
          const result = db.prepare(sql).run(...bindings);
          return {
            success: true,
            meta: { changes: Number(result.changes) },
          };
        },
      };
      return statement;
    },
  };
}

function makeFixture(violationCount: number, eligibleCount = 1) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE items (
      id TEXT PRIMARY KEY,
      is_relevant INTEGER,
      deleted_at TEXT,
      extra TEXT
    );
    CREATE TABLE item_pages (
      item_id TEXT PRIMARY KEY,
      source TEXT,
      url_path TEXT,
      generated_at TEXT,
      status TEXT
    );
  `);
  const insertItem = db.prepare(
    `INSERT INTO items (id, is_relevant, deleted_at, extra) VALUES (?, 1, NULL, ?)`,
  );
  const insertPage = db.prepare(
    `INSERT INTO item_pages (item_id, source, url_path, generated_at, status)
     VALUES (?, 'news', ?, '2026-07-20T00:00:00Z', 'live')`,
  );

  for (let index = 0; index < violationCount; index++) {
    const id = `blog:sensitive-${String(index).padStart(4, '0')}`;
    insertItem.run(id, '{"cn_sensitive":1}');
    insertPage.run(id, `/i/news/${encodeURIComponent(id)}`);
  }
  for (let index = 0; index < eligibleCount; index++) {
    const id = `blog:eligible-${String(index).padStart(4, '0')}`;
    insertItem.run(id, '{"cn_sensitive":0}');
    insertPage.run(id, `/i/news/${encodeURIComponent(id)}`);
  }
  return db;
}

function makeEnv(db: DatabaseSync, options?: SqliteD1Options): Env {
  return { DB: sqliteD1(db, options) } as unknown as Env;
}

function pageStatus(db: DatabaseSync, id: string): string | null {
  return (
    db.prepare(`SELECT status FROM item_pages WHERE item_id = ?`).get(id) as
      | { status: string }
      | undefined
  )?.status ?? null;
}

describe('reconcileItemPageCompliance SQLite contract', () => {
  test('limit>100 仍只用单参数原子 UPDATE，一次处理 150 条且保留合规行', async () => {
    const db = makeFixture(150);

    const result = await reconcileItemPageCompliance(makeEnv(db), { limit: 150 });

    expect(result).toEqual({ scanned: 150, markedGone: 150, remaining: 0 });
    expect(pageStatus(db, 'blog:eligible-0000')).toBe('live');
    db.close();
  });

  test('未传 limit 时默认单批处理 300 条', async () => {
    const db = makeFixture(301, 0);

    const result = await reconcileItemPageCompliance(makeEnv(db));

    expect(result).toEqual({ scanned: 300, markedGone: 300, remaining: 1 });
    db.close();
  });

  test('dry 按 limit 报告扫描量但零写，remaining 保持全量', async () => {
    const db = makeFixture(4);

    const result = await reconcileItemPageCompliance(makeEnv(db), { limit: 2, dry: true });

    expect(result).toEqual({ scanned: 2, markedGone: 0, remaining: 4 });
    expect(pageStatus(db, 'blog:sensitive-0000')).toBe('live');
    expect(pageStatus(db, 'blog:eligible-0000')).toBe('live');
    db.close();
  });

  test('limit 分批后 remaining 单调收敛，markedGone 取真实 changes', async () => {
    const db = makeFixture(5);
    const env = makeEnv(db);

    expect(await reconcileItemPageCompliance(env, { limit: 2 })).toEqual({
      scanned: 2,
      markedGone: 2,
      remaining: 3,
    });
    expect(await reconcileItemPageCompliance(env, { limit: 2 })).toEqual({
      scanned: 2,
      markedGone: 2,
      remaining: 1,
    });
    expect(await reconcileItemPageCompliance(env, { limit: 2 })).toEqual({
      scanned: 1,
      markedGone: 1,
      remaining: 0,
    });
    db.close();
  });

  test('UPDATE 执行前恢复合规的行不误下架，changes/scanned 不虚报', async () => {
    const db = makeFixture(2, 0);
    const recoveredId = 'blog:sensitive-0001';
    const env = makeEnv(db, {
      beforeUpdate(sqlite) {
        sqlite
          .prepare(`UPDATE items SET extra = '{"cn_sensitive":0}' WHERE id = ?`)
          .run(recoveredId);
      },
    });

    const result = await reconcileItemPageCompliance(env, { limit: 2 });

    expect(result).toEqual({ scanned: 1, markedGone: 1, remaining: 0 });
    expect(pageStatus(db, 'blog:sensitive-0000')).toBe('gone');
    expect(pageStatus(db, recoveredId)).toBe('live');
    db.close();
  });

  test('limit 先处理非有限值与小数：NaN/Infinity 回退 300，2.9 截断为 2', async () => {
    const nanDb = makeFixture(301, 0);
    expect(
      await reconcileItemPageCompliance(makeEnv(nanDb), { limit: Number.NaN }),
    ).toEqual({ scanned: 300, markedGone: 300, remaining: 1 });
    nanDb.close();

    const infinityDb = makeFixture(350, 0);
    expect(
      await reconcileItemPageCompliance(makeEnv(infinityDb), { limit: Number.POSITIVE_INFINITY }),
    ).toEqual({ scanned: 300, markedGone: 300, remaining: 50 });
    infinityDb.close();

    const fractionalDb = makeFixture(3, 0);
    expect(
      await reconcileItemPageCompliance(makeEnv(fractionalDb), { limit: 2.9 }),
    ).toEqual({ scanned: 2, markedGone: 2, remaining: 1 });
    fractionalDb.close();
  });
});
