import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  activatePublicationCapacityBudget,
  buildPublicationCapacityWarningEvent,
  drainPublicationCapacityWarningOutbox,
  increasePublicationCapacityBudget,
  producePublicationCapacityWarnings,
  retainPublicationCapacityWarningOutbox,
  serializePublicationCapacityCronObservation,
} from './publication-capacity-outbox';

const modulePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'publication-capacity-outbox.ts',
);
const migration040 = path.resolve(path.dirname(modulePath), '../../migrations/040-daily-release-publications.sql');
const migration042 = path.resolve(path.dirname(modulePath), '../../migrations/042-publication-capacity-warning-outbox.sql');

function sqliteD1(
  sqlite: DatabaseSync,
  hooks: {
    batchOutcome?: 'normal' | 'throw_before' | 'throw_after';
    beforeRun?: (sql: string) => void;
    afterRun?: (sql: string) => void;
    afterBatchCommit?: () => void;
  } = {},
) {
  return {
    prepare(sql: string) {
      let binds: SQLInputValue[] = [];
      const statement = {
        bind(...values: unknown[]) { binds = values as SQLInputValue[]; return statement; },
        async first<T>() { return (sqlite.prepare(sql).get(...binds) || null) as T | null; },
        async all<T>() { return { results: sqlite.prepare(sql).all(...binds) as T[] }; },
        async run() {
          hooks.beforeRun?.(sql);
          const result = sqlite.prepare(sql).run(...binds);
          hooks.afterRun?.(sql);
          return { success: true, meta: { changes: Number(result.changes) } };
        },
      };
      return statement;
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      if (hooks.batchOutcome === 'throw_before') throw new Error('D1 response unknown before commit');
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        hooks.afterBatchCommit?.();
        if (hooks.batchOutcome === 'throw_after') {
          hooks.batchOutcome = 'normal';
          throw new Error('D1 response unknown after commit');
        }
        return results;
      } catch (error) {
        if (sqlite.isTransaction) sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

function capacityDb(
  budgetBytes = 10_000,
  hooks: {
    batchOutcome?: 'normal' | 'throw_before' | 'throw_after';
    beforeRun?: (sql: string) => void;
    afterRun?: (sql: string) => void;
    afterBatchCommit?: () => void;
  } = {},
) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(migration040, 'utf8'));
  sqlite.prepare(`UPDATE publication_storage_budget SET budget_bytes=? WHERE singleton_id=1`).run(budgetBytes);
  sqlite.exec(readFileSync(migration042, 'utf8'));
  return { sqlite, DB: sqliteD1(sqlite, hooks) as unknown as D1Database, hooks };
}

async function activate(DB: D1Database, baseline: number, nowMs = 10) {
  return activatePublicationCapacityBudget({ DB } as never, {
    audit_id: `activate-${nowMs}`,
    legacy_baseline_bytes: baseline,
    inventory_digest: 'a'.repeat(64),
    inventory_object_count: 3,
    inventory_at_ms: nowMs,
    actor: 'test-operator', reason: 'audited fixture', ticket_ref: 'TEST-42', now_ms: nowMs,
  });
}

function reserveCapacityBytes(sqlite: DatabaseSync, slot: number, bytes: number, nowMs: number): void {
  const budget = sqlite.prepare(`SELECT version FROM publication_storage_budget WHERE singleton_id=1`)
    .get() as { version: number };
  const hex = slot.toString(16).padStart(64, '0');
  sqlite.prepare(`INSERT INTO publication_reservations(
    reservation_token,publication_date,publication_type,slot_no,business_revision_id,
    attempt_key,manifest_digest,object_count,vtt_present,reserved_bytes,budget_version_before,
    state,created_at_ms,updated_at_ms
  ) VALUES(?,?,'page',?,?,?,?,1,0,?,?,'reserved',?,?)`).run(
    hex, `2026-09-${String(slot).padStart(2, '0')}`, 1,
    (slot + 100).toString(16).padStart(64, '0'),
    (slot + 200).toString(16).padStart(64, '0'),
    (slot + 300).toString(16).padStart(64, '0'),
    bytes, budget.version, nowMs, nowMs,
  );
}

async function pendingCapacityEvent(
  baseline = 7_000,
  hooks: { beforeRun?: (sql: string) => void } = {},
) {
  const fixture = capacityDb(10_000, hooks);
  await activate(fixture.DB, baseline);
  await producePublicationCapacityWarnings({
    DB: fixture.DB, PUBLICATION_CAPACITY_WARNING_PRODUCER_ENABLED: '1',
  } as never, { nowMs: 100 });
  return fixture;
}

describe('publication capacity warning outbox', () => {
  test('has an independent producer and delivery module', () => {
    expect(existsSync(modulePath)).toBe(true);
  });

  test('missing or disabled gates fail closed before any 042 table access', async () => {
    const DB = { prepare() { throw new Error('capacity table must not be touched'); } } as never;
    await expect(producePublicationCapacityWarnings({ DB } as never)).resolves.toMatchObject({
      status: 'disabled', gate_state: 'missing', table_state: 'not_checked',
    });
    await expect(drainPublicationCapacityWarningOutbox({ DB } as never)).resolves.toMatchObject({
      status: 'disabled', gate_state: 'missing', table_state: 'not_checked',
    });
    await expect(retainPublicationCapacityWarningOutbox({
      DB, PUBLICATION_CAPACITY_WARNING_DRAIN_ENABLED: '0',
    } as never)).resolves.toMatchObject({
      status: 'disabled', gate_state: 'disabled', table_state: 'not_checked',
    });
  });

  test('reports enabled-but-missing 042 tables as durable action errors', async () => {
    const DB = { prepare() { throw new Error('no such table'); } } as never;
    await expect(producePublicationCapacityWarnings({
      DB, PUBLICATION_CAPACITY_WARNING_PRODUCER_ENABLED: '1',
    } as never)).resolves.toMatchObject({
      status: 'error', table_state: 'error', error_code: 'CAPACITY_PRODUCER_TABLE_ERROR',
    });
    await expect(drainPublicationCapacityWarningOutbox({
      DB, PUBLICATION_CAPACITY_WARNING_DRAIN_ENABLED: '1',
    } as never)).resolves.toMatchObject({
      status: 'error', table_state: 'error', error_code: 'OUTBOX_TABLE_OR_CLAIM_ERROR',
    });
    await expect(retainPublicationCapacityWarningOutbox({
      DB, PUBLICATION_CAPACITY_WARNING_DRAIN_ENABLED: '1',
    } as never)).resolves.toMatchObject({
      status: 'error', table_state: 'error', error_code: 'OUTBOX_RETENTION_ERROR',
    });
  });

  test('uses stable identity without budget version and canonical payload bounded to 2048 bytes', async () => {
    const crossing = {
      namespace: 'daily-publications-v1' as const, epoch: 7, threshold_bps: 8500 as const,
      budget_version: 11, budget_bytes: 20_000, legacy_baseline_bytes: 5_000,
      reserved_bytes: 12_000, occupied_bytes: 17_000, crossed_at_ms: 123,
    };
    const first = await buildPublicationCapacityWarningEvent(crossing);
    const second = await buildPublicationCapacityWarningEvent({
      ...crossing, budget_version: 12, reserved_bytes: 12_001, occupied_bytes: 17_001,
    });
    expect(first.event_id).toBe(second.event_id);
    expect(first.payload_sha256).not.toBe(second.payload_sha256);
    expect(new TextEncoder().encode(first.payload_json).byteLength).toBeLessThanOrEqual(2048);
    expect(first.payload_json).toBe(JSON.stringify({
      budget_bytes: 20_000,
      budget_version: 11,
      crossed_at_ms: 123,
      epoch: 7,
      event_type: 'publication_capacity_threshold_crossed',
      legacy_baseline_bytes: 5_000,
      namespace: 'daily-publications-v1',
      occupied_bytes: 17_000,
      reserved_bytes: 12_000,
      schema_version: 1,
      threshold_bps: 8500,
    }));
    expect(first.payload_json).not.toMatch(/subject_id|raw|secret|token/i);
  });

  test('audited activation and expansion update epoch exactly and replay without duplicate audit', async () => {
    const { sqlite, DB } = capacityDb();
    await expect(activate(DB, 8_600)).resolves.toMatchObject({ status: 'activated', epoch: 1 });
    await expect(activate(DB, 8_600)).resolves.toMatchObject({ status: 'replayed', epoch: 1 });
    await expect(increasePublicationCapacityBudget({ DB } as never, {
      audit_id: 'increase-1', new_budget_bytes: 20_000,
      actor: 'test-operator', reason: 'reviewed expansion', ticket_ref: 'TEST-43', now_ms: 20,
    })).resolves.toMatchObject({ status: 'increased', epoch: 2 });
    expect(sqlite.prepare(`SELECT action,COUNT(*) count FROM publication_budget_audit
      GROUP BY action ORDER BY action`).all()).toEqual([
      { action: 'activate_inventory', count: 1 }, { action: 'increase_budget', count: 1 },
    ]);
  });

  test('unknown committed budget increase replays after one or more legal reservation descendants', async () => {
    const fixture = capacityDb(10_000);
    await activate(fixture.DB, 1_000);
    fixture.hooks.batchOutcome = 'throw_after';
    fixture.hooks.afterBatchCommit = () => {
      reserveCapacityBytes(fixture.sqlite, 1, 100, 21);
      reserveCapacityBytes(fixture.sqlite, 2, 200, 22);
      fixture.hooks.afterBatchCommit = undefined;
    };
    const command = {
      audit_id: 'increase-descendant', new_budget_bytes: 20_000,
      actor: 'capacity-operator', reason: 'approved audited expansion',
      ticket_ref: 'CAP-77', now_ms: 20,
    };

    await expect(increasePublicationCapacityBudget({ DB: fixture.DB } as never, command))
      .resolves.toMatchObject({ status: 'replayed', epoch: 2, budget_version: 4 });
    await expect(increasePublicationCapacityBudget({ DB: fixture.DB } as never, command))
      .resolves.toMatchObject({ status: 'replayed', epoch: 2, budget_version: 4 });
    expect(fixture.sqlite.prepare(`SELECT COUNT(*) count FROM publication_budget_audit
      WHERE action='increase_budget'`).get()).toEqual({ count: 1 });
    expect(fixture.sqlite.prepare(`SELECT epoch,budget_version_snapshot,reserved_bytes_snapshot,last_audit_id
      FROM publication_capacity_warning_control`).get()).toEqual({
      epoch: 2, budget_version_snapshot: 4, reserved_bytes_snapshot: 300,
      last_audit_id: 'increase-descendant',
    });
    expect(fixture.sqlite.prepare(`SELECT COUNT(*) count FROM publication_capacity_threshold_crossings`).get())
      .toEqual({ count: 0 });
  });

  test('budget increase replay rejects every immutable audit command tuple mismatch', async () => {
    const { sqlite, DB } = capacityDb(10_000);
    await activate(DB, 1_000);
    const command = {
      audit_id: 'increase-immutable', new_budget_bytes: 20_000,
      actor: 'capacity-operator', reason: 'approved audited expansion',
      ticket_ref: 'CAP-78', now_ms: 20,
    };
    await increasePublicationCapacityBudget({ DB } as never, command);
    reserveCapacityBytes(sqlite, 1, 100, 21);

    for (const changed of [
      { actor: 'other-operator' },
      { reason: 'changed reason' },
      { ticket_ref: 'CAP-CHANGED' },
      { now_ms: 21 },
    ]) {
      await expect(increasePublicationCapacityBudget({ DB } as never, { ...command, ...changed }))
        .rejects.toThrow('PUBLICATION_CAPACITY_INCREASE_STALE');
    }
    expect(sqlite.prepare(`SELECT COUNT(*) count FROM publication_budget_audit
      WHERE action='increase_budget'`).get()).toEqual({ count: 1 });
  });

  test('materializes crossings once under concurrent producers and validates authoritative duplicates', async () => {
    const { sqlite, DB } = capacityDb();
    await activate(DB, 8_600);
    const env = { DB, PUBLICATION_CAPACITY_WARNING_PRODUCER_ENABLED: '1' } as never;
    const results = await Promise.all([
      producePublicationCapacityWarnings(env, { nowMs: 100 }),
      producePublicationCapacityWarnings(env, { nowMs: 100 }),
    ]);
    expect(results.reduce((sum, result) => sum + result.materialized, 0)).toBe(2);
    expect(sqlite.prepare(`SELECT COUNT(*) count FROM publication_capacity_warning_outbox
      WHERE record_kind='deliverable' AND state='pending'`).get()).toEqual({ count: 2 });
    expect(sqlite.prepare(`SELECT COUNT(*) count FROM publication_capacity_threshold_crossings
      WHERE materialization_state='materialized' AND materialized_event_id IS NOT NULL`).get())
      .toEqual({ count: 2 });
  });

  test('reconciles committed unknown outcome and leaves uncommitted unknown retryable', async () => {
    const committed = capacityDb();
    await activate(committed.DB, 7_000);
    committed.hooks.batchOutcome = 'throw_after';
    await expect(producePublicationCapacityWarnings({
      DB: committed.DB, PUBLICATION_CAPACITY_WARNING_PRODUCER_ENABLED: '1',
    } as never, { nowMs: 100 })).resolves.toMatchObject({ materialized: 1, enqueue_failures: 0 });

    const rolledBack = capacityDb();
    await activate(rolledBack.DB, 7_000);
    rolledBack.hooks.batchOutcome = 'throw_before';
    const failed = await producePublicationCapacityWarnings({
      DB: rolledBack.DB, PUBLICATION_CAPACITY_WARNING_PRODUCER_ENABLED: '1',
    } as never, { nowMs: 100 });
    expect(failed).toMatchObject({ status: 'partial', materialized: 0, enqueue_failures: 1 });
    expect(rolledBack.sqlite.prepare(`SELECT materialization_state
      FROM publication_capacity_threshold_crossings`).get()).toEqual({ materialization_state: 'pending' });
    rolledBack.hooks.batchOutcome = 'normal';
    await expect(producePublicationCapacityWarnings({
      DB: rolledBack.DB, PUBLICATION_CAPACITY_WARNING_PRODUCER_ENABLED: '1',
    } as never, { nowMs: 101 })).resolves.toMatchObject({ materialized: 1 });
  });

  test('quarantines a one-sided duplicate integrity conflict without overwriting the row', async () => {
    const { sqlite, DB } = capacityDb();
    await activate(DB, 7_000);
    const crossing = sqlite.prepare(`SELECT namespace,epoch,threshold_bps,budget_version,budget_bytes,
      legacy_baseline_bytes,reserved_bytes,occupied_bytes,crossed_at_ms
      FROM publication_capacity_threshold_crossings`).get() as never;
    const event = await buildPublicationCapacityWarningEvent(crossing);
    sqlite.prepare(`INSERT INTO publication_capacity_warning_outbox(
      event_id,schema_version,event_type,namespace,epoch,threshold_bps,crossed_at_ms,
      record_kind,payload_json,payload_sha256,state,attempts,next_retry_at_ms,created_at_ms,updated_at_ms
    ) VALUES(?,?,?,?,?,?,?,'deliverable',?,?,'pending',0,?,?,?)`).run(
      event.event_id, 1, event.event_type, event.namespace, event.epoch, event.threshold_bps,
      event.crossed_at_ms, '{"corrupt":true}', 'f'.repeat(64), 10, 10, 10,
    );
    const result = await producePublicationCapacityWarnings({
      DB, PUBLICATION_CAPACITY_WARNING_PRODUCER_ENABLED: '1',
    } as never, { nowMs: 100 });
    expect(result).toMatchObject({ status: 'partial', integrity_errors: 1, quarantined: 1 });
    expect(sqlite.prepare(`SELECT materialization_state,last_error_code
      FROM publication_capacity_threshold_crossings`).get()).toEqual({
      materialization_state: 'quarantined', last_error_code: 'CAPACITY_PRODUCER_DUPLICATE_INTEGRITY',
    });
    expect(sqlite.prepare(`SELECT payload_json,state FROM publication_capacity_warning_outbox`).get())
      .toEqual({ payload_json: '{"corrupt":true}', state: 'pending' });
  });

  test('serializes required producer observations below 3840 bytes without IDs or payloads', async () => {
    const json = await serializePublicationCapacityCronObservation({
      contract_version: 1, action: 'publication-capacity-warning-produce', status: 'partial',
      materialized_event_ids: Array.from({ length: 100 }, (_, index) => `raw-${index}-${'x'.repeat(100)}`),
      payload_json: 'secret'.repeat(1000), integrity_conflict_ids: ['a'.repeat(1024)],
      materialized: 1,
    });
    expect(new TextEncoder().encode(json).byteLength).toBeLessThanOrEqual(3840);
    expect(json).not.toContain('raw-');
    expect(json).not.toContain('secret');
    expect(JSON.parse(json)).toMatchObject({
      action: 'publication-capacity-warning-produce', materialized: 1,
    });
  });

  test('leases once under concurrent drains and acknowledges when one destination succeeds', async () => {
    const { sqlite, DB } = await pendingCapacityEvent();
    let sends = 0;
    const send = async () => {
      sends++;
      return { configured: 2, attempted: 2, succeeded: 1,
        http_failures: 1, provider_failures: 0, exceptions: 0 };
    };
    const env = { DB, PUBLICATION_CAPACITY_WARNING_DRAIN_ENABLED: '1' } as never;
    const results = await Promise.all([
      drainPublicationCapacityWarningOutbox(env, { nowMs: 1_000, owner: 'left', send }),
      drainPublicationCapacityWarningOutbox(env, { nowMs: 1_000, owner: 'right', send }),
    ]);
    expect(sends).toBe(1);
    expect(results.reduce((sum, result) => sum + result.rows_delivered, 0)).toBe(1);
    expect(sqlite.prepare(`SELECT state,attempts,delivered_at_ms,expires_at_ms
      FROM publication_capacity_warning_outbox`).get()).toEqual({
      state: 'delivered', attempts: 1, delivered_at_ms: 1_000,
      expires_at_ms: 1_000 + 30 * 24 * 60 * 60_000,
    });
  });

  test('retries HTTP failures, keeps thrown send unresolved, and never performs a seventh send', async () => {
    const httpFixture = await pendingCapacityEvent();
    let httpSends = 0;
    const httpSend = async () => {
      httpSends++;
      return { configured: 1, attempted: 1, succeeded: 0,
        http_failures: 1, provider_failures: 0, exceptions: 0 };
    };
    for (let attempt = 0; attempt < 7; attempt++) {
      await drainPublicationCapacityWarningOutbox({
        DB: httpFixture.DB, PUBLICATION_CAPACITY_WARNING_DRAIN_ENABLED: '1',
      } as never, { nowMs: 1_000 + attempt * 3 * 60 * 60_000, owner: `http-${attempt}`, send: httpSend });
    }
    expect(httpSends).toBe(6);
    expect(httpFixture.sqlite.prepare(`SELECT state,attempts,last_error_code,expires_at_ms
      FROM publication_capacity_warning_outbox`).get()).toEqual({
      state: 'failed', attempts: 6, last_error_code: 'DELIVERY_FAILED',
      expires_at_ms: 1_000 + 5 * 3 * 60 * 60_000 + 90 * 24 * 60 * 60_000,
    });

    const thrownFixture = await pendingCapacityEvent();
    const thrown = await drainPublicationCapacityWarningOutbox({
      DB: thrownFixture.DB, PUBLICATION_CAPACITY_WARNING_DRAIN_ENABLED: '1',
    } as never, {
      nowMs: 1_000, owner: 'throws', send: async () => { throw new Error('network exception'); },
    });
    expect(thrown).toMatchObject({
      status: 'partial', exceptions: 1, post_send_unresolved: 1, rows_retried: 0,
    });
    expect(thrownFixture.sqlite.prepare(`SELECT state,attempts,lease_owner
      FROM publication_capacity_warning_outbox`).get()).toEqual({
      state: 'leased', attempts: 1, lease_owner: 'throws',
    });
  });

  test('treats a provider callback failure as retryable and reports destination conservation', async () => {
    const fixture = await pendingCapacityEvent();
    const result = await drainPublicationCapacityWarningOutbox({
      DB: fixture.DB, PUBLICATION_CAPACITY_WARNING_DRAIN_ENABLED: '1',
    } as never, {
      nowMs: 1_000,
      owner: 'provider-failure',
      send: async () => ({ configured: 1, attempted: 1, succeeded: 0,
        http_failures: 0, provider_failures: 1, exceptions: 0 }),
    });
    expect(result).toMatchObject({
      status: 'partial', destinations_configured: 1, destinations_attempted: 1,
      destinations_succeeded: 0, provider_failures: 1, rows_retried: 1,
      chunks_retried: 1, post_send_unresolved: 0,
    });
    expect(fixture.sqlite.prepare(`SELECT state,attempts,last_error_code
      FROM publication_capacity_warning_outbox`).get()).toEqual({
      state: 'pending', attempts: 1, last_error_code: 'DELIVERY_FAILED',
    });
  });

  test('terminalizes an expired sixth lease without send and fences the old owner callback', async () => {
    const fixture = await pendingCapacityEvent();
    fixture.sqlite.prepare(`UPDATE publication_capacity_warning_outbox
      SET state='leased',attempts=6,lease_owner='old-owner',lease_until_ms=999,
          next_retry_at_ms=NULL`).run();
    let sends = 0;
    const result = await drainPublicationCapacityWarningOutbox({
      DB: fixture.DB, PUBLICATION_CAPACITY_WARNING_DRAIN_ENABLED: '1',
    } as never, {
      nowMs: 1_000,
      owner: 'new-owner',
      send: async () => {
        sends++;
        return { configured: 1, attempted: 1, succeeded: 1,
          http_failures: 0, provider_failures: 0, exceptions: 0 };
      },
    });
    expect(sends).toBe(0);
    expect(result).toMatchObject({ stale_at_limit: 1, terminal_failed: 1 });
    const late = await fixture.DB.prepare(`UPDATE publication_capacity_warning_outbox
      SET state='delivered' WHERE state='leased' AND lease_owner='old-owner'`).run();
    expect(Number(late.meta?.changes || 0)).toBe(0);
    expect(fixture.sqlite.prepare(`SELECT state,attempts,last_error_code
      FROM publication_capacity_warning_outbox`).get()).toEqual({
      state: 'failed', attempts: 6, last_error_code: 'DELIVERY_LEASE_EXPIRED_AT_LIMIT',
    });
  });

  test('treats send success plus ack unknown as post-send unresolved and fences a late owner', async () => {
    let throwAck = true;
    const fixture = await pendingCapacityEvent(7_000, { beforeRun(sql) {
      if (throwAck && sql.includes("SET state='delivered'")) {
        throwAck = false;
        throw new Error('ack response unknown');
      }
    } });
    const send = async () => ({ configured: 1, attempted: 1, succeeded: 1,
      http_failures: 0, provider_failures: 0, exceptions: 0 });
    const first = await drainPublicationCapacityWarningOutbox({
      DB: fixture.DB, PUBLICATION_CAPACITY_WARNING_DRAIN_ENABLED: '1',
    } as never, { nowMs: 1_000, owner: 'old', send });
    expect(first).toMatchObject({ rows_send_attempted: 1, rows_delivered: 0, post_send_unresolved: 1 });
    const second = await drainPublicationCapacityWarningOutbox({
      DB: fixture.DB, PUBLICATION_CAPACITY_WARNING_DRAIN_ENABLED: '1',
    } as never, { nowMs: 1_000 + 5 * 60_000, owner: 'new', send });
    expect(second.rows_delivered).toBe(1);
    const late = await fixture.DB.prepare(`UPDATE publication_capacity_warning_outbox
      SET state='delivered' WHERE state='leased' AND lease_owner='old'`).run();
    expect(Number(late.meta?.changes || 0)).toBe(0);
  });

  test('authoritatively preserves a committed ack whose response is unknown without resending', async () => {
    let throwAfterAck = true;
    const fixture = capacityDb(10_000, { afterRun(sql) {
      if (throwAfterAck && sql.includes("SET state='delivered'")) {
        throwAfterAck = false;
        throw new Error('ack committed but response unknown');
      }
    } });
    await activate(fixture.DB, 7_000);
    await producePublicationCapacityWarnings({
      DB: fixture.DB, PUBLICATION_CAPACITY_WARNING_PRODUCER_ENABLED: '1',
    } as never, { nowMs: 100 });
    let sends = 0;
    const send = async () => {
      sends++;
      return { configured: 1, attempted: 1, succeeded: 1,
        http_failures: 0, provider_failures: 0, exceptions: 0 };
    };
    const env = { DB: fixture.DB, PUBLICATION_CAPACITY_WARNING_DRAIN_ENABLED: '1' } as never;
    const first = await drainPublicationCapacityWarningOutbox(env, {
      nowMs: 1_000, owner: 'ack-unknown', send,
    });
    expect(first).toMatchObject({ rows_delivered: 0, post_send_unresolved: 1, status: 'partial' });
    expect(fixture.sqlite.prepare(`SELECT state,attempts,delivered_at_ms
      FROM publication_capacity_warning_outbox`).get()).toEqual({
      state: 'delivered', attempts: 1, delivered_at_ms: 1_000,
    });
    const second = await drainPublicationCapacityWarningOutbox(env, {
      nowMs: 1_000 + 5 * 60_000, owner: 'next', send,
    });
    expect(second.rows_claimed).toBe(0);
    expect(sends).toBe(1);
  });

  test('quarantines a corrupt deliverable before send and retains it as failed for 90 days', async () => {
    const fixture = await pendingCapacityEvent();
    fixture.sqlite.prepare(`UPDATE publication_capacity_warning_outbox
      SET payload_sha256=?`).run('0'.repeat(64));
    let sends = 0;
    const result = await drainPublicationCapacityWarningOutbox({
      DB: fixture.DB, PUBLICATION_CAPACITY_WARNING_DRAIN_ENABLED: '1',
    } as never, {
      nowMs: 1_000,
      owner: 'corrupt',
      send: async () => {
        sends++;
        return { configured: 1, attempted: 1, succeeded: 1 };
      },
    });
    expect(sends).toBe(0);
    expect(result).toMatchObject({ rows_failed_pre_send: 1, rows_send_attempted: 0, terminal_failed: 1 });
    expect(fixture.sqlite.prepare(`SELECT state,attempts,last_error_code,expires_at_ms
      FROM publication_capacity_warning_outbox`).get()).toEqual({
      state: 'failed', attempts: 1, last_error_code: 'CAPACITY_OUTBOX_CORRUPT_HASH',
      expires_at_ms: 1_000 + 90 * 24 * 60 * 60_000,
    });
  });

  test('keeps capacity consumption independent of publication writer rollback gates', async () => {
    const { DB } = await pendingCapacityEvent();
    const result = await drainPublicationCapacityWarningOutbox({
      DB,
      DAILY_PUBLICATION_RESERVATION_ENABLED: '0',
      DAILY_PUBLICATION_PUT_ENABLED: '0',
      DAILY_PUBLICATION_PROMOTION_ENABLED: '0',
      PUBLICATION_CAPACITY_WARNING_DRAIN_ENABLED: '1',
    } as never, {
      nowMs: 1_000,
      send: async () => ({ configured: 1, attempted: 1, succeeded: 1,
        http_failures: 0, provider_failures: 0, exceptions: 0 }),
    });
    expect(result).toMatchObject({ gate_state: 'enabled', rows_delivered: 1 });
  });

  test('retains delivered for 30 days, failed/quarantine for 90 days, and never deletes crossings', async () => {
    const delivered = await pendingCapacityEvent();
    await drainPublicationCapacityWarningOutbox({
      DB: delivered.DB, PUBLICATION_CAPACITY_WARNING_DRAIN_ENABLED: '1',
    } as never, {
      nowMs: 1_000,
      send: async () => ({ configured: 1, attempted: 1, succeeded: 1,
        http_failures: 0, provider_failures: 0, exceptions: 0 }),
    });
    const before = await retainPublicationCapacityWarningOutbox({
      DB: delivered.DB, PUBLICATION_CAPACITY_WARNING_DRAIN_ENABLED: '1',
    } as never, 1_000 + 30 * 24 * 60 * 60_000 - 1);
    expect(before.retained_deleted).toBe(0);
    const after = await retainPublicationCapacityWarningOutbox({
      DB: delivered.DB, PUBLICATION_CAPACITY_WARNING_DRAIN_ENABLED: '1',
    } as never, 1_000 + 30 * 24 * 60 * 60_000);
    expect(after.retained_deleted).toBe(1);
    expect(delivered.sqlite.prepare(`SELECT COUNT(*) count
      FROM publication_capacity_threshold_crossings`).get()).toEqual({ count: 1 });

    const quarantine = capacityDb();
    await activate(quarantine.DB, 7_000);
    const crossing = quarantine.sqlite.prepare(`SELECT namespace,epoch,threshold_bps,budget_version,
      budget_bytes,legacy_baseline_bytes,reserved_bytes,occupied_bytes,crossed_at_ms
      FROM publication_capacity_threshold_crossings`).get() as never;
    const event = await buildPublicationCapacityWarningEvent(crossing);
    quarantine.sqlite.prepare(`UPDATE publication_capacity_threshold_crossings
      SET materialization_state='quarantined',materialized_event_id=?,materialized_at_ms=100,
          last_error_code='CAPACITY_PRODUCER_FIXTURE',updated_at_ms=100`).run(event.event_id);
    quarantine.sqlite.prepare(`INSERT INTO publication_capacity_warning_outbox(
      event_id,schema_version,event_type,namespace,epoch,threshold_bps,crossed_at_ms,record_kind,
      state,attempts,created_at_ms,updated_at_ms,failed_at_ms,expires_at_ms,last_error_code
    ) VALUES(?,?,?,?,?,?,?,'quarantine','failed',0,100,100,100,?,?)`).run(
      event.event_id, 1, event.event_type, event.namespace, event.epoch, event.threshold_bps,
      event.crossed_at_ms, 100 + 90 * 24 * 60 * 60_000, 'CAPACITY_PRODUCER_FIXTURE',
    );
    const retained = await retainPublicationCapacityWarningOutbox({
      DB: quarantine.DB, PUBLICATION_CAPACITY_WARNING_DRAIN_ENABLED: '1',
    } as never, 100 + 90 * 24 * 60 * 60_000);
    expect(retained.retained_deleted).toBe(1);
    expect(quarantine.sqlite.prepare(`SELECT COUNT(*) count
      FROM publication_capacity_threshold_crossings`).get()).toEqual({ count: 1 });
  });
});
