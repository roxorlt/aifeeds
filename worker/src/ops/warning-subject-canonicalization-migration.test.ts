import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const migrationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations/041-warning-subject-canonicalization.sql',
);

function migratedDb(): DatabaseSync {
  expect(existsSync(migrationPath), '041 canonical subject migration must exist').toBe(true);
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(migrationPath, 'utf8'));
  return db;
}

describe('041 warning canonical subject migration', () => {
  test('creates exact canonical, alias, cursor and readiness indexes', () => {
    const db = migratedDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
      .map((row) => String(row.name));
    expect(tables).toEqual(expect.arrayContaining([
      'warning_canonical_subjects', 'warning_subject_aliases', 'warning_subject_scan_cursors',
    ]));
    expect(db.prepare(`SELECT source_type,after_item_rowid,cycle_high_water_rowid,cycle_no,
      initial_backfill_complete,future_hook_contract_version,ready
      FROM warning_subject_scan_cursors ORDER BY source_type`).all()).toEqual([
      { source_type: 'blog', after_item_rowid: 0, cycle_high_water_rowid: 0, cycle_no: 0,
        initial_backfill_complete: 0, future_hook_contract_version: 0, ready: 0 },
      { source_type: 'podcast', after_item_rowid: 0, cycle_high_water_rowid: 0, cycle_no: 0,
        initial_backfill_complete: 0, future_hook_contract_version: 0, ready: 0 },
    ]);
  });

  test('stores byte-distinct NFC/NFD aliases against one exact canonical row', () => {
    const db = migratedDb();
    const nfc = 'blog:openai:caf\u00e9';
    const nfd = 'blog:openai:cafe\u0301';
    expect(nfc).not.toBe(nfd);
    expect(nfc.normalize('NFC')).toBe(nfd.normalize('NFC'));
    const canonicalRowId = 'a'.repeat(64);
    db.prepare(`INSERT INTO warning_canonical_subjects(
      source_type,canonical_subject_id,canonical_version,canonical_row_id,first_item_rowid,
      sort_attempts,sort_scraped_at,sort_raw_subject_id,state,created_at_ms,updated_at_ms
    ) VALUES('blog',?,1,?,1,6,'2026-08-27T00:00:00.000Z',?,'mapped',1,1)`)
      .run(nfc, canonicalRowId, nfd);
    const alias = db.prepare(`INSERT INTO warning_subject_aliases(
      source_type,raw_subject_id,canonical_subject_id,canonical_version,canonical_row_id,
      item_rowid,state,last_error_code,mapped_at_ms,updated_at_ms
    ) VALUES('blog',?,?,1,?,?, 'mapped',NULL,1,1)`);
    alias.run(nfc, nfc, canonicalRowId, 1);
    alias.run(nfd, nfc, canonicalRowId, 2);
    expect(db.prepare('SELECT COUNT(*) n FROM warning_canonical_subjects').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) n FROM warning_subject_aliases').get()).toEqual({ n: 2 });
  });

  test.each([
    ['canonical version', `INSERT INTO warning_canonical_subjects VALUES('blog','x',2,${"'"}a${"'"},1,0,'x','x','mapped',1,1)`],
    ['alias error prefix', `INSERT INTO warning_subject_aliases VALUES('blog','r','c',1,${"'"}a${"'"},1,'quarantined','BAD',1,1)`],
    ['cursor partial lease', `UPDATE warning_subject_scan_cursors SET lease_owner='x' WHERE source_type='blog'`],
  ])('rejects invalid %s state', (_label, sql) => {
    const db = migratedDb();
    expect(() => db.exec(sql)).toThrow(/CHECK constraint failed/);
  });
});
