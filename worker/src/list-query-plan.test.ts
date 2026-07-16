import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.resolve(here, '../migrations/028-feed-list-query-indexes.sql');

const CLAWHUB_PREDICATE = `
  source_type = 'clawhub'
  AND is_relevant = 1
  AND deleted_at IS NULL
  AND json_extract(extra, '$.workflow_completed_at') IS NOT NULL
  AND COALESCE(json_extract(extra, '$.is_suspicious'), 0) = 0
`;
const STARS_EXPR = `CAST(json_extract(metrics, '$.stars') AS INTEGER)`;

function normalized(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

describe('028 ClawHub feed indexes', () => {
  test('migration contains only the two evidence-backed ClawHub indexes', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
    const sql = fs.readFileSync(migrationPath, 'utf8');
    const creates = [...sql.matchAll(/CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+(\w+)/gi)]
      .map((match) => match[1]);

    expect(creates).toEqual([
      'idx_items_clawhub_feed_stars',
      'idx_items_clawhub_category_stars',
    ]);
    expect(normalized(sql)).toContain(normalized(STARS_EXPR));
    expect(normalized(sql)).toContain(normalized(CLAWHUB_PREDICATE));
    expect(sql.match(/workflow_completed_at'\) IS NOT NULL/g)).toHaveLength(2);
    expect(sql).not.toMatch(/idx_items_(?:product_hunt|github|huodongxing|hf|news)/i);
  });

  test('migration records the explicit rollback statements', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');
    expect(sql).toContain('DROP INDEX IF EXISTS idx_items_clawhub_feed_stars;');
    expect(sql).toContain('DROP INDEX IF EXISTS idx_items_clawhub_category_stars;');
  });
});

const sqlite = await import('node:sqlite').catch(() => null);
const sqliteTest = sqlite ? test : test.skip;

sqliteTest('SQLite plan loses the ClawHub temp sort after migration', () => {
  const { DatabaseSync } = sqlite!;
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE items (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      is_relevant INTEGER,
      deleted_at INTEGER,
      content_translated TEXT,
      published_at TEXT,
      metrics TEXT,
      extra TEXT
    );
    CREATE INDEX idx_items_feed_src_pub
      ON items(source_type, is_relevant, (content_translated IS NULL), published_at DESC, id DESC);
  `);
  const insert = db.prepare(
    `INSERT INTO items
      (id, source_type, is_relevant, deleted_at, content_translated, published_at, metrics, extra)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let index = 0; index < 2_000; index++) {
    insert.run(
      `clawhub:${String(index).padStart(5, '0')}`,
      'clawhub',
      1,
      null,
      null,
      '2026-07-10T00:00:00.000Z',
      JSON.stringify({ stars: (index * 37) % 997 }),
      JSON.stringify({
        category: index % 2 === 0 ? 'mcp-tools' : 'automation',
        is_suspicious: 0,
        workflow_completed_at: '2026-07-10T00:00:00.000Z',
      }),
    );
  }

  const allQuery = `
    SELECT id FROM items
    WHERE ${CLAWHUB_PREDICATE}
    ORDER BY ${STARS_EXPR} DESC, id ASC
    LIMIT 31
  `;
  const categoryQuery = `
    SELECT id FROM items
    WHERE ${CLAWHUB_PREDICATE}
      AND json_extract(extra, '$.category') = 'mcp-tools'
    ORDER BY ${STARS_EXPR} DESC, id ASC
    LIMIT 31
  `;
  const explain = (sql: string): string[] => (
    db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all()
      .map((row) => String((row as { detail?: unknown }).detail ?? ''))
  );

  expect(explain(allQuery).join('\n')).toMatch(/USE TEMP B-TREE FOR ORDER BY/i);
  db.exec(fs.readFileSync(migrationPath, 'utf8'));

  const allPlan = explain(allQuery).join('\n');
  expect(allPlan).toMatch(/idx_items_clawhub_feed_stars/i);
  expect(allPlan).not.toMatch(/USE TEMP B-TREE FOR ORDER BY/i);

  const categoryPlan = explain(categoryQuery).join('\n');
  expect(categoryPlan).toMatch(/idx_items_clawhub_category_stars/i);
  expect(categoryPlan).not.toMatch(/USE TEMP B-TREE FOR ORDER BY/i);
  db.close();
});
