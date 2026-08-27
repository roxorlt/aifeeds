import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const migration040 = path.resolve(here, '../../migrations/040-daily-release-publications.sql');
const migration042 = path.resolve(here, '../../migrations/042-publication-capacity-warning-outbox.sql');

function migratedDb(budgetBytes = 3_298_534_883_328): DatabaseSync {
  expect(existsSync(migration042), '042 capacity warning migration must exist').toBe(true);
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(migration040, 'utf8'));
  if (budgetBytes !== 3_298_534_883_328) {
    db.prepare(`UPDATE publication_storage_budget SET budget_bytes=? WHERE singleton_id=1`)
      .run(budgetBytes);
  }
  db.exec(readFileSync(migration042, 'utf8'));
  return db;
}

function auditAndActivate(db: DatabaseSync, baseline: number, at = 10): void {
  const budget = db.prepare(`SELECT budget_bytes,legacy_baseline_bytes+reserved_bytes occupied,
    version FROM publication_storage_budget WHERE singleton_id=1`).get() as Record<string, number>;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`INSERT INTO publication_budget_audit(
      audit_id,action,old_budget_bytes,new_budget_bytes,old_occupied_bytes,new_occupied_bytes,
      inventory_digest,actor,reason,ticket_ref,created_at_ms
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      'activate-1', 'activate_inventory', budget.budget_bytes, budget.budget_bytes,
      budget.occupied, baseline, 'a'.repeat(64), 'test-operator', 'fixture inventory', 'TEST-1', at,
    );
    db.prepare(`UPDATE publication_storage_budget
      SET legacy_baseline_bytes=?,state='active',legacy_inventory_digest=?,
          legacy_inventory_object_count=0,legacy_inventory_at_ms=?,version=version+1,updated_at_ms=?
      WHERE singleton_id=1 AND state='uninitialized' AND version=?`).run(
      baseline, 'a'.repeat(64), at, at, budget.version,
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function auditAndIncrease(db: DatabaseSync, nextBudget: number, at = 20): void {
  const budget = db.prepare(`SELECT budget_bytes,legacy_baseline_bytes+reserved_bytes occupied,
    version FROM publication_storage_budget WHERE singleton_id=1`).get() as Record<string, number>;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`INSERT INTO publication_budget_audit(
      audit_id,action,old_budget_bytes,new_budget_bytes,old_occupied_bytes,new_occupied_bytes,
      inventory_digest,actor,reason,ticket_ref,created_at_ms
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      `increase-${at}`, 'increase_budget', budget.budget_bytes, nextBudget,
      budget.occupied, budget.occupied, null, 'test-operator', 'capacity expansion', 'TEST-2', at,
    );
    db.prepare(`UPDATE publication_storage_budget
      SET budget_bytes=?,version=version+1,updated_at_ms=?
      WHERE singleton_id=1 AND state='active' AND version=?`).run(nextBudget, at, budget.version);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function reservePage(db: DatabaseSync, revision: string, slot: number, size: number, at: number): void {
  const version = Number((db.prepare(`SELECT version FROM publication_storage_budget`).get() as { version: number }).version);
  db.prepare(`INSERT INTO publication_reservations(
    reservation_token,publication_date,publication_type,slot_no,business_revision_id,
    attempt_key,manifest_digest,object_count,vtt_present,reserved_bytes,budget_version_before,
    state,created_at_ms,updated_at_ms
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,'reserved',?,?)`).run(
    revision.slice(0, 1).repeat(64), '2026-08-27', 'page', slot, revision,
    revision.slice(1, 2).repeat(64), revision.slice(2, 3).repeat(64),
    1, 0, size, version, at, at,
  );
}

describe('042 publication capacity warning migration', () => {
  test('creates an exact control singleton, permanent crossings, and independent capacity outbox', () => {
    const db = migratedDb();
    expect(db.prepare(`SELECT namespace,schema_version,epoch,state,budget_bytes_snapshot,
      legacy_baseline_bytes_snapshot,reserved_bytes_snapshot,last_audit_id
      FROM publication_capacity_warning_control`).get()).toEqual({
      namespace: 'daily-publications-v1', schema_version: 1, epoch: 0,
      state: 'uninitialized', budget_bytes_snapshot: 3_298_534_883_328,
      legacy_baseline_bytes_snapshot: 0, reserved_bytes_snapshot: 0, last_audit_id: null,
    });
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all()
      .map((row) => String(row.name));
    expect(tables).toEqual(expect.arrayContaining([
      'publication_capacity_warning_control', 'publication_capacity_threshold_crossings',
      'publication_capacity_warning_outbox',
    ]));
  });

  test('activation atomically records exact threshold crossings and requires its audit row', () => {
    const db = migratedDb(10_000);
    expect(() => db.prepare(`UPDATE publication_storage_budget SET state='active',
      legacy_inventory_digest=?,legacy_inventory_object_count=0,legacy_inventory_at_ms=1,
      version=1,updated_at_ms=1 WHERE singleton_id=1`).run('a'.repeat(64)))
      .toThrow(/PUBLICATION_CAPACITY_AUDIT_REQUIRED/);
    auditAndActivate(db, 8_600);
    expect(db.prepare(`SELECT epoch,state,budget_version_snapshot,budget_bytes_snapshot,
      legacy_baseline_bytes_snapshot,reserved_bytes_snapshot,occupied_bytes_snapshot,last_audit_id
      FROM publication_capacity_warning_control`).get()).toEqual({
      epoch: 1, state: 'active', budget_version_snapshot: 1, budget_bytes_snapshot: 10_000,
      legacy_baseline_bytes_snapshot: 8_600, reserved_bytes_snapshot: 0,
      occupied_bytes_snapshot: 8_600, last_audit_id: 'activate-1',
    });
    expect(db.prepare(`SELECT epoch,threshold_bps,budget_version,occupied_bytes,
      materialization_state,materialized_event_id FROM publication_capacity_threshold_crossings
      ORDER BY threshold_bps`).all()).toEqual([
      { epoch: 1, threshold_bps: 7000, budget_version: 1, occupied_bytes: 8_600,
        materialization_state: 'pending', materialized_event_id: null },
      { epoch: 1, threshold_bps: 8500, budget_version: 1, occupied_bytes: 8_600,
        materialization_state: 'pending', materialized_event_id: null },
    ]);
  });

  test('a failed reservation rolls budget and crossing back in the same transaction', () => {
    const db = migratedDb(10_000);
    auditAndActivate(db, 6_998);
    reservePage(db, `1${'2'.repeat(63)}`, 1, 1, 11);
    expect(() => reservePage(db, `1${'3'.repeat(63)}`, 2, 1, 12)).toThrow(/UNIQUE constraint failed/);
    expect(db.prepare(`SELECT reserved_bytes,version FROM publication_storage_budget`).get())
      .toEqual({ reserved_bytes: 1, version: 2 });
    expect(db.prepare(`SELECT COUNT(*) count FROM publication_capacity_threshold_crossings`).get())
      .toEqual({ count: 0 });
  });

  test('100 percent is not an event and the next positive reservation is rejected by 040', () => {
    const db = migratedDb(10_000);
    auditAndActivate(db, 9_999);
    reservePage(db, `4${'5'.repeat(63)}`, 1, 1, 11);
    expect(db.prepare(`SELECT threshold_bps FROM publication_capacity_threshold_crossings
      ORDER BY threshold_bps`).all()).toEqual([
      { threshold_bps: 7000 }, { threshold_bps: 8500 }, { threshold_bps: 9500 },
    ]);
    expect(() => reservePage(db, `6${'7'.repeat(63)}`, 2, 1, 12))
      .toThrow(/PUBLICATION_BUDGET_OR_VERSION_REJECTED/);
    expect(db.prepare(`SELECT reserved_bytes FROM publication_storage_budget`).get())
      .toEqual({ reserved_bytes: 1 });
  });

  test('audited expansion rearms a new epoch only after the ratio drops below and rises again', () => {
    const db = migratedDb(10_000);
    auditAndActivate(db, 8_600);
    auditAndIncrease(db, 20_000);
    expect(db.prepare(`SELECT epoch,budget_bytes_snapshot,occupied_bytes_snapshot,last_audit_id
      FROM publication_capacity_warning_control`).get()).toEqual({
      epoch: 2, budget_bytes_snapshot: 20_000, occupied_bytes_snapshot: 8_600,
      last_audit_id: 'increase-20',
    });
    expect(db.prepare(`SELECT epoch,threshold_bps FROM publication_capacity_threshold_crossings
      ORDER BY epoch,threshold_bps`).all()).toEqual([
      { epoch: 1, threshold_bps: 7000 }, { epoch: 1, threshold_bps: 8500 },
    ]);
    reservePage(db, `8${'9'.repeat(63)}`, 1, 5_400, 21);
    expect(db.prepare(`SELECT epoch,threshold_bps,occupied_bytes FROM publication_capacity_threshold_crossings
      ORDER BY epoch,threshold_bps`).all()).toEqual([
      { epoch: 1, threshold_bps: 7000, occupied_bytes: 8_600 },
      { epoch: 1, threshold_bps: 8500, occupied_bytes: 8_600 },
      { epoch: 2, threshold_bps: 7000, occupied_bytes: 14_000 },
    ]);
  });

  test('does not immediately repeat thresholds that remain crossed after a small audited expansion', () => {
    const db = migratedDb(10_000);
    auditAndActivate(db, 9_600);
    auditAndIncrease(db, 10_100);
    expect(db.prepare(`SELECT epoch FROM publication_capacity_warning_control`).get())
      .toEqual({ epoch: 2 });
    expect(db.prepare(`SELECT epoch,threshold_bps FROM publication_capacity_threshold_crossings
      ORDER BY epoch,threshold_bps`).all()).toEqual([
      { epoch: 1, threshold_bps: 7000 },
      { epoch: 1, threshold_bps: 8500 },
      { epoch: 1, threshold_bps: 9500 },
    ]);
  });

  test('records each cumulative 70/85/95 upcross exactly once and never creates a 100 percent event', () => {
    const db = migratedDb(10_000);
    auditAndActivate(db, 6_999);
    reservePage(db, `1${'2'.repeat(63)}`, 1, 1, 11);
    reservePage(db, `3${'4'.repeat(63)}`, 2, 1_500, 12);
    reservePage(db, `5${'6'.repeat(63)}`, 3, 1_000, 13);
    reservePage(db, `7${'8'.repeat(63)}`, 4, 1, 14);
    expect(db.prepare(`SELECT threshold_bps,COUNT(*) count
      FROM publication_capacity_threshold_crossings GROUP BY threshold_bps ORDER BY threshold_bps`).all())
      .toEqual([
        { threshold_bps: 7000, count: 1 },
        { threshold_bps: 8500, count: 1 },
        { threshold_bps: 9500, count: 1 },
      ]);
    expect(db.prepare(`SELECT COUNT(*) count FROM publication_capacity_threshold_crossings
      WHERE threshold_bps=10000`).get()).toEqual({ count: 0 });
  });

  test('crossings are permanent and capacity outbox rejects invalid quarantine and lease shapes', () => {
    const db = migratedDb(10_000);
    auditAndActivate(db, 7_000);
    expect(() => db.exec(`DELETE FROM publication_capacity_threshold_crossings`))
      .toThrow(/PUBLICATION_CAPACITY_CROSSING_DELETE_FORBIDDEN/);
    const base = [
      'a'.repeat(64), 1, 'publication_capacity_threshold_crossed', 'daily-publications-v1',
      1, 7000, 10, 'failed', 0, 10, 10,
    ] as const;
    expect(() => db.prepare(`INSERT INTO publication_capacity_warning_outbox(
      event_id,schema_version,event_type,namespace,epoch,threshold_bps,crossed_at_ms,record_kind,state,
      attempts,created_at_ms,updated_at_ms
    ) VALUES(?,?,?,?,?,?,?,'quarantine',?,?,?,?)`).run(...base))
      .toThrow(/CHECK constraint failed/);
  });
});
