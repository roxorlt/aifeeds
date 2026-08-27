import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const migrationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations/039-warning-outbox.sql',
);
const warningOutboxSourcePath = path.resolve(path.dirname(migrationPath), '../src/ops/warning-outbox.ts');

function migratedDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(migrationPath, 'utf8'));
  return db;
}

const columns = [
  'event_id', 'schema_version', 'event_type', 'source_type', 'subject_id', 'dedup_period',
  'observed_at_ms', 'record_kind', 'payload_json', 'payload_sha256', 'state', 'attempts',
  'next_retry_at_ms', 'lease_owner', 'lease_until_ms', 'created_at_ms', 'updated_at_ms',
  'delivered_at_ms', 'failed_at_ms', 'last_error_code', 'last_error_detail', 'expires_at_ms',
] as const;

function quarantine(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: 'a'.repeat(64), schema_version: 1, event_type: 'workflow_retry_exhausted', source_type: 'blog',
    subject_id: 'blog:openai:release', dedup_period: '2026-08-27', observed_at_ms: 1000,
    record_kind: 'producer_quarantine', payload_json: null, payload_sha256: null, state: 'failed', attempts: 0,
    next_retry_at_ms: null, lease_owner: null, lease_until_ms: null, created_at_ms: 1000, updated_at_ms: 1000,
    delivered_at_ms: null, failed_at_ms: 1000, last_error_code: 'PRODUCER_SUBJECT_INVALID',
    last_error_detail: 'invalid', expires_at_ms: 2000,
    ...overrides,
  };
}

function insert(db: DatabaseSync, row: Record<string, unknown>): void {
  db.prepare(`INSERT INTO warning_outbox (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
    .run(...columns.map((column) => row[column] as never));
}

describe('039 warning_outbox migration constraints', () => {
  test('keeps migration 039 byte-for-byte frozen while sharing only low-level delivery primitives', () => {
    const migration = readFileSync(migrationPath);
    expect(createHash('sha256').update(migration).digest('hex'))
      .toBe('9ff4aa15ecfd9297afb6b56f7e67dea4230399926c5a7a4722a9e66d25b97bc1');
    const source = readFileSync(warningOutboxSourcePath, 'utf8');
    expect(source).toContain("from './reliable-outbox'");
    expect(source).toContain("table: 'warning_outbox'");
  });

  test('creates the exact table/indexes and accepts a complete producer quarantine', () => {
    const db = migratedDb();
    insert(db, quarantine());
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='warning_outbox'")
      .all().map((row) => String(row.name));
    expect(indexes).toEqual(expect.arrayContaining(['warning_outbox_due_idx', 'warning_outbox_retention_idx']));
    expect(db.prepare('SELECT record_kind,state,attempts,last_error_code FROM warning_outbox').get()).toEqual({
      record_kind: 'producer_quarantine', state: 'failed', attempts: 0,
      last_error_code: 'PRODUCER_SUBJECT_INVALID',
    });
  });

  test.each([
    ['missing error', { last_error_code: null }],
    ['missing failed time', { failed_at_ms: null }],
    ['missing expiry', { expires_at_ms: null }],
    ['wrong prefix', { last_error_code: 'OUTBOX_CORRUPT_HASH' }],
    ['lowercase prefix', { last_error_code: 'producer_bad' }],
    ['nonzero attempts', { attempts: 1 }],
    ['residual lease owner', { lease_owner: 'owner' }],
    ['residual lease expiry', { lease_until_ms: 2000 }],
    ['residual retry time', { next_retry_at_ms: 2000 }],
    ['residual delivered time', { delivered_at_ms: 2000 }],
  ])('rejects quarantine with %s', (_label, overrides) => {
    const db = migratedDb();
    expect(() => insert(db, quarantine(overrides))).toThrow(/CHECK constraint failed/);
  });
});
