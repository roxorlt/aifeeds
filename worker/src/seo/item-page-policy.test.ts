import { describe, expect, test } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

import { isCnSensitive, isDedupSuppressed } from './item-page-policy';
import { ITEM_ELIGIBILITY } from './item-archive';

function eligibilityIds(rows: Array<{ id: string; extra: string | null }>): string[] {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE items (
      id TEXT PRIMARY KEY,
      is_relevant INTEGER,
      deleted_at TEXT,
      extra TEXT
    );
  `);
  const insert = db.prepare(
    `INSERT INTO items (id, is_relevant, deleted_at, extra) VALUES (?, 1, NULL, ?)`,
  );
  for (const row of rows) insert.run(row.id, row.extra);

  const result = (
    db
      .prepare(`SELECT i.id FROM items i WHERE ${ITEM_ELIGIBILITY} ORDER BY i.id`)
      .all() as Array<{ id: string }>
  ).map((row) => row.id);
  db.close();
  return result;
}

describe('item page JSON compliance policy contract', () => {
  test('TypeScript 仅把 JSON number 1 判为敏感', () => {
    expect(isCnSensitive('{"cn_sensitive":1}')).toBe(true);
    expect(isCnSensitive('{"cn_sensitive":1.0}')).toBe(true);
    expect(isCnSensitive('{"cn_sensitive":true}')).toBe(false);
    expect(isCnSensitive('{"cn_sensitive":"1"}')).toBe(false);
    expect(isCnSensitive('{"cn_sensitive":null}')).toBe(false);
    expect(isCnSensitive('{}')).toBe(false);
    expect(isCnSensitive('{malformed')).toBe(false);
    expect(isCnSensitive(null)).toBe(false);
  });

  test('真实 SQLite eligibility 与 TypeScript 对齐：boolean true/string 1 放行，仅 number 1 拦截', () => {
    const ids = eligibilityIds([
      { id: 'boolean-true', extra: '{"cn_sensitive":true}' },
      { id: 'json-null', extra: '{"cn_sensitive":null}' },
      { id: 'missing', extra: '{}' },
      { id: 'number-1', extra: '{"cn_sensitive":1}' },
      { id: 'number-1-real', extra: '{"cn_sensitive":1.0}' },
      { id: 'string-1', extra: '{"cn_sensitive":"1"}' },
    ]);

    expect(ids).toEqual(['boolean-true', 'json-null', 'missing', 'string-1']);
  });

  test('真实 SQLite eligibility 对 malformed/null extra 不抛，并按非敏感、非 dedup 放行', () => {
    expect(() =>
      eligibilityIds([
        { id: 'malformed', extra: '{malformed' },
        { id: 'null-extra', extra: null },
      ]),
    ).not.toThrow();
    expect(
      eligibilityIds([
        { id: 'malformed', extra: '{malformed' },
        { id: 'null-extra', extra: null },
      ]),
    ).toEqual(['malformed', 'null-extra']);
  });

  test('真实 SQLite eligibility 仍排除合法 JSON 中 dedup_of 非 null 的条目', () => {
    expect(isDedupSuppressed('{"dedup_of":"blog:main"}')).toBe(true);
    expect(isDedupSuppressed('{"dedup_of":""}')).toBe(false);
    expect(isDedupSuppressed('{"dedup_of":null}')).toBe(false);
    expect(isDedupSuppressed('{malformed')).toBe(false);
    expect(
      eligibilityIds([
        { id: 'dedup', extra: '{"dedup_of":"blog:main"}' },
        { id: 'empty-dedup', extra: '{"dedup_of":""}' },
        { id: 'eligible', extra: '{"dedup_of":null}' },
      ]),
    ).toEqual(['eligible', 'empty-dedup']);
  });
});
