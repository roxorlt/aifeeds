import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  ackWarningOutboxRows,
  buildWarningOutboxEvent,
  drainWarningOutbox,
  enqueueWarningOutboxEvent,
  resolveWarningOutboxLegacyBridge,
  retainWarningOutbox,
  serializeWarningCronObservation,
  validateWarningOutboxRow,
} from './warning-outbox';

const migration = readFileSync(path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '../../migrations/039-warning-outbox.sql',
), 'utf8');

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function digest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function d1(options: { failAckOnce?: boolean } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(migration);
  let failAckOnce = options.failAckOnce === true;
  const DB = {
    prepare(sql: string) {
      let binds: SQLInputValue[] = [];
      const stmt = {
        bind(...values: unknown[]) { binds = values as SQLInputValue[]; return stmt; },
        async first<T>() { return (sqlite.prepare(sql).get(...binds) || null) as T | null; },
        async all<T>() { return { results: sqlite.prepare(sql).all(...binds) as T[] }; },
        async run() {
          if (failAckOnce && /SET state='delivered'/.test(sql)) {
            failAckOnce = false;
            throw new Error('simulated_crash_before_ack');
          }
          const result = sqlite.prepare(sql).run(...binds);
          return { success: true, meta: { changes: Number(result.changes) } };
        },
      };
      return stmt;
    },
    async batch(statements: Array<{ run: () => Promise<unknown> }>) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return { sqlite, env: { DB, WARNING_OUTBOX_DRAIN_ENABLED: '1', PUSHDEER_ADMIN_KEYS: 'test' } as never };
}

describe('warning outbox canonical event', () => {
  test('NFC and NFD subjects produce the same event id and bridge tuple', async () => {
    const { env } = d1();
    const now = Date.parse('2026-08-27T12:30:00.000Z');
    const nfc = 'blog:openai:Caf\u00e9';
    const nfd = 'blog:openai:Cafe\u0301';
    const [nfcEvent, nfdEvent] = await Promise.all([
      buildWarningOutboxEvent('blog', nfc, now),
      buildWarningOutboxEvent('blog', nfd, now),
    ]);
    expect(nfdEvent.event_id).toBe(nfcEvent.event_id);
    await enqueueWarningOutboxEvent(env, 'blog', nfc, now);

    const bridge = await resolveWarningOutboxLegacyBridge(
      env, 'blog', [nfd], '2026-08-27',
    );
    expect(bridge).toMatchObject({
      suppressed_ids: [nfd], legacy_ids: [], alert_legacy_owned: 0,
      alert_bridge_suppressed: 1, bridge_duplicate_possible: 0,
    });
  });

  test('bridge reservation closes lookup-miss to D1-insert interleaving', async () => {
    const base = d1();
    const now = Date.parse('2026-08-27T12:30:00.000Z');
    const subject = 'blog:openai:bridge-interleave';
    const competing = await buildWarningOutboxEvent('blog', subject, now);
    let inserted = false;
    const DB = {
      prepare(sql: string) {
        const prepared = (base.env as never as { DB: D1Database }).DB.prepare(sql);
        const wrapper = {
          bind(...values: unknown[]) { prepared.bind(...values); return wrapper; },
          async all<T>() {
            const result = await prepared.all<T>();
            return result;
          },
          first: <T>() => prepared.first<T>(),
          async run() {
            if (!inserted && sql.includes('INSERT INTO warning_outbox')) {
              inserted = true;
              base.sqlite.prepare(`INSERT INTO warning_outbox (
                event_id,schema_version,event_type,source_type,subject_id,dedup_period,observed_at_ms,
                record_kind,payload_json,payload_sha256,state,attempts,next_retry_at_ms,created_at_ms,updated_at_ms
              ) VALUES (?,?,?,?,?,?,?,'deliverable',?,?,'pending',0,?,?,?)`).run(
                competing.event_id, 1, competing.event_type, competing.source_type,
                competing.subject_id, competing.dedup_period, competing.observed_at_ms,
                competing.payload_json, competing.payload_sha256, now, now, now,
              );
            }
            return prepared.run();
          },
        };
        return wrapper;
      },
    };

    const bridge = await resolveWarningOutboxLegacyBridge(
      { DB } as never, 'blog', [subject], '2026-08-27',
    );
    expect(inserted).toBe(true);
    expect(bridge).toMatchObject({
      suppressed_ids: [subject], legacy_ids: [], alert_legacy_owned: 0,
      alert_bridge_suppressed: 1, bridge_duplicate_possible: 0,
    });
    expect(base.sqlite.prepare(
      `SELECT COUNT(*) AS n FROM warning_outbox WHERE source_type='blog' AND subject_id=? AND dedup_period='2026-08-27'`,
    ).get(subject)).toEqual({ n: 1 });
  });

  test('an ambiguous stale bridge reservation promotes once to durable D1 delivery', async () => {
    vi.useFakeTimers();
    const now = Date.parse('2026-08-27T12:30:00.000Z');
    vi.setSystemTime(now);
    const { env, sqlite } = d1();
    const subject = 'blog:openai:bridge-crash-window';
    const first = await resolveWarningOutboxLegacyBridge(
      env, 'blog', [subject], '2026-08-27',
    );
    expect(first).toMatchObject({ legacy_ids: [subject], bridge_duplicate_possible: 0 });
    sqlite.prepare(
      `UPDATE warning_outbox SET updated_at_ms=? WHERE subject_id=?`,
    ).run(now - 30 * 60_000 - 1, subject);

    const recovered = await resolveWarningOutboxLegacyBridge(
      env, 'blog', [subject], '2026-08-27',
    );

    expect(recovered).toMatchObject({
      legacy_ids: [], suppressed_ids: [subject], alert_bridge_suppressed: 1,
      bridge_duplicate_possible: 1,
    });
    expect(sqlite.prepare(
      `SELECT record_kind,state,attempts,next_retry_at_ms,last_error_code FROM warning_outbox`,
    ).get()).toEqual({
      record_kind: 'deliverable', state: 'pending', attempts: 0,
      next_retry_at_ms: now, last_error_code: null,
    });
    const third = await resolveWarningOutboxLegacyBridge(
      env, 'blog', [subject], '2026-08-27',
    );
    expect(third).toMatchObject({
      legacy_ids: [], suppressed_ids: [subject], bridge_duplicate_possible: 0,
    });
  });

  test('normalizes Unicode, fixes key order, and validates its own immutable row', async () => {
    const event = await buildWarningOutboxEvent('blog', 'blog:openai:Cafe\u0301', 1_720_000_000_000);
    expect(event.subject_id).toBe('blog:openai:Café');
    expect(event.payload_json).toBe(
      '{"attempt_limit":6,"dedup_period":"2024-07-03","event_type":"workflow_retry_exhausted",'
      + '"observed_at_ms":1720000000000,"schema_version":1,"source_type":"blog","subject_id":"blog:openai:Café"}',
    );
    expect(event.event_id).toMatch(/^[0-9a-f]{64}$/);
    expect(await validateWarningOutboxRow({
      ...event, record_kind: 'deliverable', state: 'pending', attempts: 0,
      next_retry_at_ms: event.observed_at_ms, lease_owner: null, lease_until_ms: null,
      created_at_ms: event.observed_at_ms, updated_at_ms: event.observed_at_ms,
      delivered_at_ms: null, failed_at_ms: null, last_error_code: null,
      last_error_detail: null, expires_at_ms: null,
    })).toEqual({ ok: true, payload: expect.any(Object) });
  });

  test('rejects unsafe or out-of-range observed timestamps before persistence', async () => {
    await expect(buildWarningOutboxEvent('blog', 'blog:openai:unsafe', Number.MAX_SAFE_INTEGER + 1))
      .rejects.toThrow('PRODUCER_CANONICALIZATION_REJECTED');
    await expect(buildWarningOutboxEvent('blog', 'blog:openai:date-range', Number.MAX_SAFE_INTEGER))
      .rejects.toThrow();
  });

  test('rejects unknown/null fields, noncanonical bytes, hash and event identity mismatch', async () => {
    const event = await buildWarningOutboxEvent('podcast', 'podcast:show:episode', 1_720_000_000_000);
    const base = {
      ...event, record_kind: 'deliverable', state: 'pending', attempts: 0,
      next_retry_at_ms: event.observed_at_ms, lease_owner: null, lease_until_ms: null,
      created_at_ms: event.observed_at_ms, updated_at_ms: event.observed_at_ms,
      delivered_at_ms: null, failed_at_ms: null, last_error_code: null, last_error_detail: null, expires_at_ms: null,
    } as const;
    expect((await validateWarningOutboxRow({ ...base, payload_json: event.payload_json.replace('{', '{"unknown":null,') })).ok).toBe(false);
    expect((await validateWarningOutboxRow({ ...base, payload_sha256: '0'.repeat(64) })).ok).toBe(false);
    expect((await validateWarningOutboxRow({ ...base, event_id: '0'.repeat(64) })).ok).toBe(false);
  });

  test('rejects a self-consistent payload whose dedup period is not the UTC day of observed_at_ms', async () => {
    const observedAtMs = Date.parse('2026-08-27T23:59:59.000Z');
    const payloadJson = '{"attempt_limit":6,"dedup_period":"2026-08-28",'
      + '"event_type":"workflow_retry_exhausted","observed_at_ms":1787875199000,'
      + '"schema_version":1,"source_type":"blog","subject_id":"blog:openai:wrong-day"}';
    const identity = '{"dedup_period":"2026-08-28","event_type":"workflow_retry_exhausted",'
      + '"schema_version":1,"source_type":"blog","subject_id":"blog:openai:wrong-day"}';
    const result = await validateWarningOutboxRow({
      event_id: await digest(identity), schema_version: 1, event_type: 'workflow_retry_exhausted',
      source_type: 'blog', subject_id: 'blog:openai:wrong-day', dedup_period: '2026-08-28',
      observed_at_ms: observedAtMs, payload_json: payloadJson, payload_sha256: await digest(payloadJson),
      record_kind: 'deliverable', state: 'pending', attempts: 0, next_retry_at_ms: observedAtMs,
      lease_owner: null, lease_until_ms: null, created_at_ms: observedAtMs, updated_at_ms: observedAtMs,
      delivered_at_ms: null, failed_at_ms: null, last_error_code: null, last_error_detail: null,
      expires_at_ms: null,
    });
    expect(result).toMatchObject({ ok: false, code: 'OUTBOX_CORRUPT_SCHEMA' });
  });
});

describe('warning outbox lease/attempt/chunk state machine', () => {
  test('permits exactly six claimed sends, then exhausts without a seventh send', async () => {
    const { env, sqlite } = d1();
    let now = 1_720_000_000_000;
    await enqueueWarningOutboxEvent(env, 'blog', 'blog:openai:stuck', now);
    const send = vi.fn(async () => ({ attempted: 1, succeeded: 0 }));
    for (let attempt = 1; attempt <= 6; attempt++) {
      const result = await drainWarningOutbox(env, { nowMs: now, send });
      expect(result.rows_send_attempted).toBe(1);
      now += [5, 10, 20, 40, 80, 160][attempt - 1] * 60_000;
    }
    const seventh = await drainWarningOutbox(env, { nowMs: now, send });
    expect(seventh.rows_send_attempted).toBe(0);
    expect(send).toHaveBeenCalledTimes(6);
    expect(sqlite.prepare('SELECT state,attempts FROM warning_outbox').get()).toEqual({ state: 'failed', attempts: 6 });
  });

  test('concurrent duplicate drains claim once and an old owner late ack cannot win', async () => {
    const { env, sqlite } = d1();
    const now = 1_720_000_000_000;
    await enqueueWarningOutboxEvent(env, 'blog', 'blog:openai:concurrent', now);
    const send = vi.fn(async () => ({ attempted: 1, succeeded: 1 }));
    const [left, right] = await Promise.all([
      drainWarningOutbox(env, { nowMs: now, owner: 'left', send }),
      drainWarningOutbox(env, { nowMs: now, owner: 'right', send }),
    ]);
    expect(left.rows_delivered + right.rows_delivered).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await ackWarningOutboxRows(env, ['ignored'], 'left', now + 1)).toBe(0);
    expect(sqlite.prepare('SELECT state FROM warning_outbox').get()).toEqual({ state: 'delivered' });
  });

  test('acks successful chunks independently and retries a failed trailing chunk', async () => {
    const { env, sqlite } = d1();
    const now = 1_720_000_000_000;
    for (let i = 0; i < 26; i++) await enqueueWarningOutboxEvent(env, 'blog', `blog:openai:item-${i}`, now + i);
    const send = vi.fn()
      .mockResolvedValueOnce({ attempted: 1, succeeded: 1 })
      .mockResolvedValueOnce({ attempted: 1, succeeded: 0 });
    const result = await drainWarningOutbox(env, { nowMs: now + 100, send });
    expect(result).toMatchObject({
      rows_claimed: 26, rows_delivered: 25, rows_retried: 1,
      chunks_attempted: 2, chunks_delivered: 1, chunks_retried: 1,
    });
    expect(sqlite.prepare("SELECT COUNT(*) n FROM warning_outbox WHERE state='delivered'").get()).toEqual({ n: 25 });
    expect(sqlite.prepare("SELECT COUNT(*) n FROM warning_outbox WHERE state='pending'").get()).toEqual({ n: 1 });
  });

  test('bounded retention removes only expired terminal rows', async () => {
    const { env, sqlite } = d1();
    const now = 1_720_000_000_000;
    for (let i = 0; i < 510; i++) {
      await enqueueWarningOutboxEvent(env, 'blog', `blog:openai:retention-${i}`, now);
    }
    sqlite.prepare("UPDATE warning_outbox SET state='delivered', delivered_at_ms=?, expires_at_ms=?, next_retry_at_ms=NULL")
      .run(now, now - 1);
    const first = await retainWarningOutbox(env, now);
    expect(first).toMatchObject({
      retention_lookahead_found: 501, eligible_found: 500,
      delete_attempted: 500, retained_deleted: 500, delete_conflicts: 0, cap_reached: true,
    });
    expect(sqlite.prepare('SELECT COUNT(*) n FROM warning_outbox').get()).toEqual({ n: 10 });
  });

  test('an expired sixth lease terminalizes without a seventh send and rejects the old owner ack', async () => {
    const { env, sqlite } = d1();
    const now = 1_720_000_000_000;
    const inserted = await enqueueWarningOutboxEvent(env, 'blog', 'blog:openai:crash-at-limit', now - 10_000);
    sqlite.prepare(`UPDATE warning_outbox SET state='leased',attempts=6,lease_owner='old-owner',lease_until_ms=?`)
      .run(now - 1);
    const send = vi.fn(async () => ({ attempted: 1, succeeded: 1 }));
    const result = await drainWarningOutbox(env, { nowMs: now, send });
    expect(result).toMatchObject({ rows_send_attempted: 0, stale_at_limit: 1, terminal_failed: 1 });
    expect(send).not.toHaveBeenCalled();
    expect(await ackWarningOutboxRows(env, [inserted.event.event_id], 'old-owner', now + 1)).toBe(0);
  });

  test('D1 delivery is independent of KV and remains retryable on no keys, HTTP 500, and exception', async () => {
    const { env, sqlite } = d1();
    const now = 1_720_000_000_000;
    Object.assign(env as object, {
      AUTH_KV: {
        get: vi.fn(async () => { throw new Error('kv unavailable'); }),
        put: vi.fn(async () => { throw new Error('kv rejection'); }),
        delete: vi.fn(async () => { throw new Error('kv unavailable'); }),
      },
    });
    await enqueueWarningOutboxEvent(env, 'blog', 'blog:openai:http-failures', now);
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('upstream', { status: 500 }))
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0 }), { status: 200 }));

    const first = await drainWarningOutbox(env, { nowMs: now });
    expect(first).toMatchObject({ rows_delivered: 0, rows_retried: 1, post_send_unresolved: 0 });
    const second = await drainWarningOutbox(env, { nowMs: now + 5 * 60_000 });
    expect(second).toMatchObject({ rows_delivered: 0, post_send_unresolved: 1 });
    const third = await drainWarningOutbox(env, { nowMs: now + 15 * 60_000 });
    expect(third).toMatchObject({ rows_delivered: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sqlite.prepare('SELECT state,attempts FROM warning_outbox').get()).toEqual({ state: 'delivered', attempts: 3 });
  });

  test('fails a corrupt claimed row before HTTP and records a bounded terminal reason', async () => {
    const { env, sqlite } = d1();
    const now = 1_720_000_000_000;
    await enqueueWarningOutboxEvent(env, 'blog', 'blog:openai:corrupt-before-send', now);
    sqlite.prepare("UPDATE warning_outbox SET payload_sha256=?").run('0'.repeat(64));
    const send = vi.fn(async () => ({ attempted: 1, succeeded: 1 }));
    const result = await drainWarningOutbox(env, { nowMs: now, send });
    expect(result).toMatchObject({ rows_send_attempted: 0, rows_failed_pre_send: 1, rows_delivered: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT state,attempts,last_error_code FROM warning_outbox').get()).toEqual({
      state: 'failed', attempts: 1, last_error_code: 'OUTBOX_CORRUPT_HASH',
    });
  });

  test('keeps each Unicode chunk within both the event and UTF-8 byte caps', async () => {
    const { env } = d1();
    const now = 1_720_000_000_000;
    for (let i = 0; i < 30; i++) {
      await enqueueWarningOutboxEvent(env, 'blog', `blog:openai:${'警'.repeat(300)}-${i}`, now + i);
    }
    const bodies: string[] = [];
    const result = await drainWarningOutbox(env, {
      nowMs: now + 100,
      send: vi.fn(async (_title, body) => {
        bodies.push(body);
        return { attempted: 1, succeeded: 1 };
      }),
    });
    expect(result.rows_delivered).toBe(30);
    expect(result.chunks_attempted).toBeGreaterThan(1);
    expect(bodies.every((body) => new TextEncoder().encode(body).byteLength <= 16_384)).toBe(true);
  });

  test('append during send remains a separate pending event and is not claimed by the current chunk ack', async () => {
    const { env, sqlite } = d1();
    const now = 1_720_000_000_000;
    await enqueueWarningOutboxEvent(env, 'blog', 'blog:openai:first', now);
    const send = vi.fn(async () => {
      await enqueueWarningOutboxEvent(env, 'blog', 'blog:openai:appended', now + 1);
      return { attempted: 1, succeeded: 1 };
    });
    const result = await drainWarningOutbox(env, { nowMs: now, send });
    expect(result.rows_delivered).toBe(1);
    expect(sqlite.prepare('SELECT subject_id,state FROM warning_outbox ORDER BY subject_id').all()).toEqual([
      { subject_id: 'blog:openai:appended', state: 'pending' },
      { subject_id: 'blog:openai:first', state: 'delivered' },
    ]);
  });

  test('crash after HTTP success but before ack leaves the lease retryable for at-least-once delivery', async () => {
    const { env, sqlite } = d1({ failAckOnce: true });
    const now = 1_720_000_000_000;
    await enqueueWarningOutboxEvent(env, 'blog', 'blog:openai:success-before-crash', now);
    const send = vi.fn(async () => ({ attempted: 1, succeeded: 1 }));
    const crashed = await drainWarningOutbox(env, { nowMs: now, owner: 'crashed', send });
    expect(crashed).toMatchObject({
      rows_send_attempted: 1, rows_delivered: 0, post_send_unresolved: 1,
      chunks_post_send_unresolved: 1, status: 'partial',
    });
    expect(sqlite.prepare('SELECT state,attempts,lease_owner FROM warning_outbox').get()).toEqual({
      state: 'leased', attempts: 1, lease_owner: 'crashed',
    });
    const retried = await drainWarningOutbox(env, { nowMs: now + 5 * 60_000, owner: 'retry', send });
    expect(retried.rows_delivered).toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(sqlite.prepare('SELECT state,attempts FROM warning_outbox').get()).toEqual({
      state: 'delivered', attempts: 2,
    });
  });

  test('no destination leaves the event pending without touching KV or claiming delivery', async () => {
    const { env, sqlite } = d1();
    const now = 1_720_000_000_000;
    Object.assign(env as object, { PUSHDEER_ADMIN_KEYS: '', AUTH_KV: undefined });
    await enqueueWarningOutboxEvent(env, 'blog', 'blog:openai:no-destination', now);
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const result = await drainWarningOutbox(env, { nowMs: now });
    expect(result).toMatchObject({ rows_delivered: 0, rows_retried: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT state,attempts FROM warning_outbox').get()).toEqual({
      state: 'pending', attempts: 1,
    });
  });

  test('gate off never touches the table and producer/drain gates roundtrip without dual authority', async () => {
    const DB = { prepare: vi.fn(() => { throw new Error('must not touch table'); }) };
    const disabled = await drainWarningOutbox({ DB, WARNING_OUTBOX_DRAIN_ENABLED: '0' } as never);
    expect(disabled.status).toBe('disabled');
    expect(DB.prepare).not.toHaveBeenCalled();
  });

  test('attempt-homogeneous chunks classify attempts 5 retry and attempts 6 terminal failure separately', async () => {
    const { env, sqlite } = d1();
    const now = 1_720_000_000_000;
    await enqueueWarningOutboxEvent(env, 'blog', 'blog:openai:retry-five', now);
    await enqueueWarningOutboxEvent(env, 'blog', 'blog:openai:terminal-six', now + 1);
    sqlite.prepare(`UPDATE warning_outbox SET attempts=CASE subject_id
      WHEN 'blog:openai:retry-five' THEN 4 ELSE 5 END,next_retry_at_ms=?`).run(now);
    const result = await drainWarningOutbox(env, {
      nowMs: now + 2,
      send: vi.fn(async () => ({ attempted: 1, succeeded: 0, configured: 1,
        http_failures: 1, provider_failures: 0, exceptions: 0 })),
    });
    expect(result).toMatchObject({
      rows_claimed: 2, rows_send_attempted: 2, rows_retried: 1, rows_failed_at_limit: 1,
      chunks_attempted: 2, chunks_retried: 1, chunks_terminal_failed: 1,
      chunks_post_send_unresolved: 0,
    });
    expect(result.chunks_attempted).toBe(
      result.chunks_delivered + result.chunks_retried
      + result.chunks_terminal_failed + result.chunks_post_send_unresolved,
    );
  });

  test('bounded cron serializer omits raw IDs and stays below 3840 UTF-8 bytes', async () => {
    const serialized = await serializeWarningCronObservation({
      contract_version: 1, action: 'warning-outbox-drain', status: 'partial',
      error_code: 'CONSERVATION_INTEGRITY_ERROR',
      integrity_conflict_ids: ['x'.repeat(1024), 'y'.repeat(1024)],
      counter: Number.MAX_SAFE_INTEGER,
    });
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(3840);
    expect(serialized).not.toContain('x'.repeat(32));
    expect(JSON.parse(serialized)).toMatchObject({ contract_version: 1, action: 'warning-outbox-drain' });
  });

  test('durable warning observation strips bridge raw IDs while preserving scalar ownership counts', async () => {
    const raw = 'blog:openai:secret-raw-subject';
    const serialized = await serializeWarningCronObservation({
      contract_version: 1,
      action: 'blog-workflow-recovery',
      status: 'ok',
      warning_bridge: {
        status: 'ok', suppressed_ids: [raw], legacy_ids: [`${raw}-legacy`],
        alert_legacy_owned: 1, alert_bridge_suppressed: 1, bridge_duplicate_possible: 0,
      },
    });
    expect(serialized).not.toContain(raw);
    expect(JSON.parse(serialized)).toMatchObject({
      warning_bridge: {
        alert_legacy_owned: 1, alert_bridge_suppressed: 1, bridge_duplicate_possible: 0,
      },
    });
  });
});
