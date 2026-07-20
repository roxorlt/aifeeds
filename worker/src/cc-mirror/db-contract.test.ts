import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const migration029Path = path.resolve(here, '../../migrations/029-cc-content-mirror.sql');
const migration030Path = path.resolve(
  here,
  '../../migrations/030-cc-content-mirror-decision-token.sql',
);
const schemaPath = path.resolve(here, '../../schema.sql');

type TableInfoRow = {
  name: string;
  type: string;
  notnull: number;
  pk: number;
};

type IndexListRow = {
  name: string;
  unique: number;
};

type IndexInfoRow = {
  seqno: number;
  name: string;
};

const expectedColumns: Record<string, Array<[string, string, number, number]>> = {
  cc_item_reviews: [
    ['item_id', 'TEXT', 0, 1],
    ['policy_version', 'INTEGER', 1, 0],
    ['source_policy', 'TEXT', 1, 0],
    ['review_status', 'TEXT', 1, 0],
    ['flags_json', 'TEXT', 1, 0],
    ['reason', 'TEXT', 1, 0],
    ['review_text_hash', 'TEXT', 1, 0],
    ['model', 'TEXT', 0, 0],
    ['reviewed_at', 'TEXT', 1, 0],
  ],
  cc_item_overrides: [
    ['item_id', 'TEXT', 0, 1],
    ['action', 'TEXT', 1, 0],
    ['reason', 'TEXT', 1, 0],
    ['updated_at', 'TEXT', 1, 0],
    ['decision_token', 'TEXT', 1, 0],
  ],
  cc_item_pages: [
    ['item_id', 'TEXT', 0, 1],
    ['source', 'TEXT', 1, 0],
    ['url_path', 'TEXT', 1, 0],
    ['r2_key', 'TEXT', 1, 0],
    ['content_hash', 'TEXT', 0, 0],
    ['title', 'TEXT', 1, 0],
    ['published_at', 'TEXT', 0, 0],
    ['generated_at', 'TEXT', 1, 0],
    ['status', 'TEXT', 1, 0],
    ['reason', 'TEXT', 1, 0],
  ],
  cc_page_events: [
    ['seq', 'INTEGER', 0, 1],
    ['item_id', 'TEXT', 1, 0],
    ['op', 'TEXT', 1, 0],
    ['content_hash', 'TEXT', 0, 0],
    ['created_at', 'TEXT', 1, 0],
  ],
};

const expectedIndexes: Record<string, string[]> = {
  idx_cc_reviews_status: ['review_status', 'reviewed_at'],
  idx_cc_pages_status_source: ['status', 'source', 'generated_at'],
  idx_cc_page_events_item: ['item_id', 'seq'],
};

function readMigration029(): string {
  expect(fs.existsSync(migration029Path), '029 migration must exist').toBe(true);
  return fs.readFileSync(migration029Path, 'utf8');
}

function readMigration030(): string {
  expect(fs.existsSync(migration030Path), '030 migration must exist').toBe(true);
  return fs.readFileSync(migration030Path, 'utf8');
}

function tableInfo(db: DatabaseSync, tableName: string): TableInfoRow[] {
  return db.prepare(`PRAGMA table_info('${tableName}')`).all() as TableInfoRow[];
}

function indexColumns(db: DatabaseSync, indexName: string): string[] {
  const rows = db.prepare(`PRAGMA index_info('${indexName}')`).all() as IndexInfoRow[];
  return rows.sort((left, right) => left.seqno - right.seqno).map((row) => row.name);
}

function assertContract(db: DatabaseSync): void {
  const tableNames = db.prepare(
    `SELECT name FROM sqlite_master
     WHERE type = 'table' AND name LIKE 'cc_%'
     ORDER BY name`,
  ).all().map((row) => String((row as { name: unknown }).name));

  expect(tableNames).toEqual(Object.keys(expectedColumns).sort());

  for (const [tableName, columns] of Object.entries(expectedColumns)) {
    expect(
      tableInfo(db, tableName).map((column) => [
        column.name,
        column.type,
        column.notnull,
        column.pk,
      ]),
      `${tableName} columns`,
    ).toEqual(columns);
  }

  for (const [indexName, columns] of Object.entries(expectedIndexes)) {
    const index = db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`,
    ).get(indexName) as { name?: string } | undefined;
    expect(index?.name, `${indexName} must exist`).toBe(indexName);
    expect(indexColumns(db, indexName), `${indexName} columns`).toEqual(columns);
  }

  const pageIndexes = db.prepare(`PRAGMA index_list('cc_item_pages')`).all() as IndexListRow[];
  const uniqueUrlPathIndexes = pageIndexes.filter((index) => (
    index.unique === 1
    && indexColumns(db, index.name).length === 1
    && indexColumns(db, index.name)[0] === 'url_path'
  ));
  expect(uniqueUrlPathIndexes).toHaveLength(1);
}

function extractStatement(sql: string, kind: 'TABLE' | 'INDEX', name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = kind === 'TABLE'
    ? new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${escapedName}\\s*\\([\\s\\S]*?\\);`, 'i')
    : new RegExp(`CREATE\\s+INDEX\\s+IF\\s+NOT\\s+EXISTS\\s+${escapedName}\\s+ON\\s+[\\s\\S]*?\\);`, 'i');
  const match = sql.match(pattern);
  expect(match?.[0], `${kind.toLowerCase()} ${name} must be in schema.sql`).toBeTruthy();
  return match![0];
}

describe('029 + 030 cc content mirror DB contract', () => {
  test('ordered migrations create the exact tables and indexes', () => {
    const db = new DatabaseSync(':memory:');
    const migration029 = readMigration029();

    db.exec(migration029);
    db.exec(migration029);
    db.exec(readMigration030());

    assertContract(db);
    db.close();
  });

  test('030 upgrades an existing 029 database and safely backfills old overrides', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(readMigration029());
    db.prepare(
      `INSERT INTO cc_item_overrides (item_id, action, reason, updated_at)
       VALUES ('blog:legacy', 'allow', 'legacy row',
         '2026-07-20T00:00:00.000Z')`,
    ).run();

    db.exec(readMigration030());

    expect(
      tableInfo(db, 'cc_item_overrides').map((column) => column.name),
    ).toContain('decision_token');
    expect(
      db.prepare(
        `SELECT action, reason, decision_token
         FROM cc_item_overrides
         WHERE item_id = 'blog:legacy'`,
      ).get(),
    ).toEqual({
      action: 'allow',
      reason: 'legacy row',
      decision_token: '',
    });
    db.close();
  });

  test('page event sequence is globally increasing and AUTOINCREMENT never reuses a deleted seq', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(readMigration029());
    db.exec(readMigration030());
    const insert = db.prepare(
      `INSERT INTO cc_page_events (item_id, op, content_hash, created_at)
       VALUES (?, ?, ?, ?)`,
    );

    insert.run('blog:one', 'upsert', 'hash-1', '2026-07-20T01:00:00.000Z');
    insert.run('podcast:two', 'delete', null, '2026-07-20T01:01:00.000Z');
    insert.run('blog:one', 'delete', null, '2026-07-20T01:02:00.000Z');

    const initialSeqs = db.prepare('SELECT seq FROM cc_page_events ORDER BY seq').all()
      .map((row) => Number((row as { seq: unknown }).seq));
    expect(initialSeqs).toEqual([1, 2, 3]);
    const sequenceState = (): number | null => {
      const row = db.prepare(
        `SELECT seq FROM sqlite_sequence WHERE name = 'cc_page_events'`,
      ).get() as { seq?: unknown } | undefined;
      return row?.seq === undefined ? null : Number(row.seq);
    };
    expect(sequenceState()).toBe(3);

    db.prepare('DELETE FROM cc_page_events WHERE seq = 3').run();
    expect(sequenceState()).toBe(3);
    insert.run('github:three', 'upsert', 'hash-3', '2026-07-20T01:03:00.000Z');

    const finalSeqs = db.prepare('SELECT seq FROM cc_page_events ORDER BY seq').all()
      .map((row) => Number((row as { seq: unknown }).seq));
    expect(finalSeqs).toEqual([1, 2, 4]);
    expect(sequenceState()).toBe(4);
    db.close();
  });

  test('schema.sql initializes the same cc mirror contract as the migration', () => {
    const schema = fs.readFileSync(schemaPath, 'utf8');
    const statements = [
      ...Object.keys(expectedColumns).map((name) => extractStatement(schema, 'TABLE', name)),
      ...Object.keys(expectedIndexes).map((name) => extractStatement(schema, 'INDEX', name)),
    ];
    const db = new DatabaseSync(':memory:');

    db.exec(statements.join('\n'));

    assertContract(db);
    db.close();
  });
});
