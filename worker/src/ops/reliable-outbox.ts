/** Shared lease/chunk/delivery primitives for isolated D1 outbox schemas. */

export const RELIABLE_OUTBOX_MAX_ATTEMPTS = 6;
export const RELIABLE_OUTBOX_LEASE_MS = 5 * 60_000;
export const RELIABLE_OUTBOX_DELIVERED_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const RELIABLE_OUTBOX_FAILED_RETENTION_MS = 90 * 24 * 60 * 60_000;
const CLAIM_BATCH_MAX = 100;
const INVOCATION_BATCH_MAX = 2;
const RETENTION_DELETE_MAX = 500;
const RETRY_MINUTES = [5, 10, 20, 40, 80] as const;
const encoder = new TextEncoder();

export type ReliableOutboxTable = 'warning_outbox' | 'publication_capacity_warning_outbox';

export interface ReliableOutboxRow {
  event_id: string;
  record_kind: string;
  state: 'pending' | 'leased' | 'delivered' | 'failed';
  attempts: number;
  next_retry_at_ms: number | null;
  lease_owner: string | null;
  lease_until_ms: number | null;
  created_at_ms: number;
  updated_at_ms: number;
  delivered_at_ms: number | null;
  failed_at_ms: number | null;
  expires_at_ms: number | null;
  last_error_code: string | null;
  last_error_detail: string | null;
}

export interface ReliableDeliveryResult {
  attempted: number;
  succeeded: number;
  configured?: number;
  http_failures?: number;
  provider_failures?: number;
  exceptions?: number;
}

export interface ReliableOutboxChunk<Row extends ReliableOutboxRow> {
  rows: Row[];
  title: string;
  body: string;
}

export interface ReliableOutboxDrainResult<Action extends string> {
  contract_version: 1;
  action: Action;
  status: 'disabled' | 'ok' | 'partial' | 'error';
  gate_state: 'missing' | 'disabled' | 'enabled';
  table_state: 'not_checked' | 'ready' | 'error';
  error_code: string | null;
  due_found: number;
  due_lookahead_found: number;
  due_cap_reached: boolean;
  stale_at_limit: number;
  rows_claimed: number;
  lease_conflicts: number;
  rows_failed_pre_send: number;
  rows_send_attempted: number;
  pre_send_unresolved: number;
  rows_delivered: number;
  rows_retried: number;
  rows_failed_at_limit: number;
  post_send_unresolved: number;
  rows_unresolved: number;
  terminal_failed: number;
  chunks_attempted: number;
  chunks_delivered: number;
  chunks_retried: number;
  chunks_terminal_failed: number;
  chunks_post_send_unresolved: number;
  destinations_configured: number;
  destinations_attempted: number;
  destinations_succeeded: number;
  http_failures: number;
  provider_failures: number;
  exceptions: number;
  oldest_due_age: number | null;
  attempts_claimed: Record<'1' | '2' | '3' | '4' | '5' | '6', number>;
}

export interface ReliableOutboxRetentionResult<Action extends string> {
  contract_version: 1;
  action: Action;
  status: 'disabled' | 'ok' | 'partial' | 'error';
  gate_state: 'missing' | 'disabled' | 'enabled';
  table_state: 'not_checked' | 'ready' | 'error';
  error_code: string | null;
  retention_lookahead_found: number;
  eligible_found: number;
  delete_attempted: number;
  retained_deleted: number;
  delete_conflicts: number;
  cap_reached: boolean;
  oldest_expired_age: number | null;
}

function tableSql(table: ReliableOutboxTable): string {
  if (table === 'warning_outbox' || table === 'publication_capacity_warning_outbox') return table;
  throw new Error('RELIABLE_OUTBOX_TABLE_INVALID');
}

function placeholders(length: number): string {
  return Array.from({ length }, () => '?').join(',');
}

export function sanitizeReliableOutboxDetail(value: unknown): string {
  const clean = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ');
  if (encoder.encode(clean).byteLength <= 500) return clean;
  let bounded = '';
  for (const scalar of clean) {
    if (encoder.encode(bounded + scalar).byteLength > 500) break;
    bounded += scalar;
  }
  return bounded;
}

function emptyDrain<Action extends string>(
  action: Action,
  gate: string | undefined,
): ReliableOutboxDrainResult<Action> {
  const enabled = gate === '1';
  return {
    contract_version: 1, action, status: enabled ? 'ok' : 'disabled',
    gate_state: gate === undefined ? 'missing' : enabled ? 'enabled' : 'disabled',
    table_state: enabled ? 'ready' : 'not_checked', error_code: null,
    due_found: 0, due_lookahead_found: 0, due_cap_reached: false, stale_at_limit: 0,
    rows_claimed: 0, lease_conflicts: 0, rows_failed_pre_send: 0,
    rows_send_attempted: 0, pre_send_unresolved: 0, rows_delivered: 0,
    rows_retried: 0, rows_failed_at_limit: 0, post_send_unresolved: 0,
    rows_unresolved: 0, terminal_failed: 0,
    chunks_attempted: 0, chunks_delivered: 0, chunks_retried: 0,
    chunks_terminal_failed: 0, chunks_post_send_unresolved: 0,
    destinations_configured: 0, destinations_attempted: 0, destinations_succeeded: 0,
    http_failures: 0, provider_failures: 0, exceptions: 0, oldest_due_age: null,
    attempts_claimed: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0, '6': 0 },
  };
}

export async function ackReliableOutboxRows(
  db: D1Database,
  table: ReliableOutboxTable,
  ids: readonly string[],
  owner: string,
  nowMs: number,
): Promise<number> {
  if (!ids.length) return 0;
  const result = await db.prepare(
    `UPDATE ${tableSql(table)}
        SET state='delivered',delivered_at_ms=?,updated_at_ms=?,expires_at_ms=?,
            lease_owner=NULL,lease_until_ms=NULL,next_retry_at_ms=NULL,
            failed_at_ms=NULL,last_error_code=NULL,last_error_detail=NULL
      WHERE event_id IN (${placeholders(ids.length)}) AND record_kind='deliverable'
        AND state='leased' AND lease_owner=? AND lease_until_ms>?`,
  ).bind(
    nowMs, nowMs, nowMs + RELIABLE_OUTBOX_DELIVERED_RETENTION_MS,
    ...ids, owner, nowMs,
  ).run();
  return Number(result.meta?.changes || 0);
}

async function terminalizeCorrupt<Row extends ReliableOutboxRow>(
  db: D1Database,
  table: ReliableOutboxTable,
  row: Row,
  owner: string,
  nowMs: number,
  code: string,
  detail: string,
): Promise<number> {
  const result = await db.prepare(
    `UPDATE ${tableSql(table)}
        SET state='failed',lease_owner=NULL,lease_until_ms=NULL,next_retry_at_ms=NULL,
            failed_at_ms=?,expires_at_ms=?,updated_at_ms=?,last_error_code=?,last_error_detail=?
      WHERE event_id=? AND record_kind='deliverable' AND state='leased'
        AND lease_owner=? AND lease_until_ms>?`,
  ).bind(
    nowMs, nowMs + RELIABLE_OUTBOX_FAILED_RETENTION_MS, nowMs,
    code, sanitizeReliableOutboxDetail(detail), row.event_id, owner, nowMs,
  ).run();
  return Number(result.meta?.changes || 0);
}

async function nackRows<Row extends ReliableOutboxRow>(
  db: D1Database,
  table: ReliableOutboxTable,
  rows: readonly Row[],
  owner: string,
  nowMs: number,
  detail: string,
): Promise<{ pending: number; failed: number }> {
  let pending = 0;
  let failed = 0;
  for (const row of rows) {
    const atLimit = row.attempts >= RELIABLE_OUTBOX_MAX_ATTEMPTS;
    const retryAt = atLimit ? null : nowMs + RETRY_MINUTES[Math.max(0, row.attempts - 1)] * 60_000;
    const update = await db.prepare(
      `UPDATE ${tableSql(table)}
          SET state=?,next_retry_at_ms=?,lease_owner=NULL,lease_until_ms=NULL,
              failed_at_ms=?,expires_at_ms=?,updated_at_ms=?,
              last_error_code='DELIVERY_FAILED',last_error_detail=?
        WHERE event_id=? AND record_kind='deliverable' AND state='leased'
          AND lease_owner=? AND lease_until_ms>?`,
    ).bind(
      atLimit ? 'failed' : 'pending', retryAt, nowMs,
      atLimit ? nowMs + RELIABLE_OUTBOX_FAILED_RETENTION_MS : null,
      nowMs, sanitizeReliableOutboxDetail(detail), row.event_id, owner, nowMs,
    ).run();
    if (Number(update.meta?.changes || 0) === 1) atLimit ? failed++ : pending++;
  }
  return { pending, failed };
}

export async function drainReliableOutbox<
  Row extends ReliableOutboxRow,
  Action extends string,
>(options: {
  db: D1Database;
  table: ReliableOutboxTable;
  action: Action;
  gate: string | undefined;
  nowMs: number;
  owner: string;
  validate: (row: Row) => Promise<{ ok: true } | { ok: false; code: string; detail: string }>;
  renderChunks: (rows: readonly Row[]) => Array<ReliableOutboxChunk<Row>>;
  send: (title: string, body: string) => Promise<ReliableDeliveryResult>;
  logLabel: string;
}): Promise<ReliableOutboxDrainResult<Action>> {
  const result = emptyDrain(options.action, options.gate);
  if (result.gate_state !== 'enabled') return result;
  const table = tableSql(options.table);
  const nowMs = options.nowMs;
  try {
    const expired = await options.db.prepare(
      `SELECT event_id FROM ${table}
        WHERE record_kind='deliverable' AND state='leased' AND attempts=6 AND lease_until_ms<=?
        ORDER BY lease_until_ms ASC,created_at_ms ASC,event_id ASC LIMIT 100`,
    ).bind(nowMs).all<{ event_id: string }>();
    for (const row of expired.results || []) {
      const update = await options.db.prepare(
        `UPDATE ${table}
            SET state='failed',lease_owner=NULL,lease_until_ms=NULL,next_retry_at_ms=NULL,
                failed_at_ms=?,updated_at_ms=?,expires_at_ms=?,
                last_error_code='DELIVERY_LEASE_EXPIRED_AT_LIMIT'
          WHERE event_id=? AND record_kind='deliverable' AND state='leased'
            AND attempts=6 AND lease_until_ms<=?`,
      ).bind(
        nowMs, nowMs, nowMs + RELIABLE_OUTBOX_FAILED_RETENTION_MS, row.event_id, nowMs,
      ).run();
      const changed = Number(update.meta?.changes || 0);
      result.stale_at_limit += changed;
      result.terminal_failed += changed;
    }

    for (let batch = 0; batch < INVOCATION_BATCH_MAX; batch++) {
      const due = await options.db.prepare(
        `SELECT event_id,CASE WHEN state='leased' THEN lease_until_ms ELSE next_retry_at_ms END effective_due_ms
           FROM ${table}
          WHERE record_kind='deliverable' AND attempts<6
            AND ((state='pending' AND next_retry_at_ms<=?) OR (state='leased' AND lease_until_ms<=?))
          ORDER BY effective_due_ms ASC,created_at_ms ASC,event_id ASC LIMIT ?`,
      ).bind(nowMs, nowMs, CLAIM_BATCH_MAX + 1)
        .all<{ event_id: string; effective_due_ms: number }>();
      if (!(due.results || []).length) break;
      result.due_lookahead_found += due.results.length;
      if (due.results.length === CLAIM_BATCH_MAX + 1) result.due_cap_reached = true;
      const claimable = due.results.slice(0, CLAIM_BATCH_MAX);
      result.due_found += claimable.length;
      const oldest = Math.max(0, nowMs - Number(due.results[0].effective_due_ms));
      const oldestSeconds = Math.floor(oldest / 1000);
      result.oldest_due_age = result.oldest_due_age == null
        ? oldestSeconds : Math.max(result.oldest_due_age, oldestSeconds);
      const claimedIds: string[] = [];
      for (const candidate of claimable) {
        const claim = await options.db.prepare(
          `UPDATE ${table}
              SET state='leased',attempts=attempts+1,lease_owner=?,lease_until_ms=?,updated_at_ms=?
            WHERE event_id=? AND record_kind='deliverable' AND attempts<6
              AND ((state='pending' AND next_retry_at_ms<=?) OR (state='leased' AND lease_until_ms<=?))`,
        ).bind(
          options.owner, nowMs + RELIABLE_OUTBOX_LEASE_MS, nowMs,
          candidate.event_id, nowMs, nowMs,
        ).run();
        if (Number(claim.meta?.changes || 0) === 1) claimedIds.push(candidate.event_id);
        else result.lease_conflicts++;
      }
      result.rows_claimed += claimedIds.length;
      if (!claimedIds.length) continue;
      const claimed = await options.db.prepare(
        `SELECT * FROM ${table}
          WHERE event_id IN (${placeholders(claimedIds.length)})
            AND record_kind='deliverable' AND state='leased' AND lease_owner=? AND lease_until_ms=?
          ORDER BY CASE WHEN next_retry_at_ms IS NULL THEN created_at_ms ELSE next_retry_at_ms END,
                   created_at_ms,event_id`,
      ).bind(...claimedIds, options.owner, nowMs + RELIABLE_OUTBOX_LEASE_MS).all<Row>();
      const claimedRows = claimed.results || [];
      result.pre_send_unresolved += claimedIds.length - claimedRows.length;
      const validRows: Row[] = [];
      for (const row of claimedRows) {
        const attemptKey = String(row.attempts) as keyof typeof result.attempts_claimed;
        if (attemptKey in result.attempts_claimed) result.attempts_claimed[attemptKey]++;
        const valid = await options.validate(row);
        if (valid.ok) validRows.push(row);
        else {
          try {
            const changed = await terminalizeCorrupt(
              options.db, options.table, row, options.owner, nowMs, valid.code, valid.detail,
            );
            if (changed === 1) result.rows_failed_pre_send++;
            else result.pre_send_unresolved++;
          } catch {
            result.pre_send_unresolved++;
          }
        }
      }
      for (const chunk of options.renderChunks(validRows)) {
        result.chunks_attempted++;
        result.rows_send_attempted += chunk.rows.length;
        let delivery: ReliableDeliveryResult;
        try {
          delivery = await options.send(chunk.title, chunk.body);
        } catch (error) {
          delivery = { configured: 1, attempted: 1, succeeded: 0,
            http_failures: 0, provider_failures: 0, exceptions: 1 };
          console.error(`[${options.logLabel}] delivery exception:`, error);
        }
        const configured = Number(delivery.configured ?? delivery.attempted);
        const httpFailures = Number(delivery.http_failures || 0);
        const exceptions = Number(delivery.exceptions || 0);
        const providerFailures = Number(delivery.provider_failures
          ?? Math.max(0, delivery.attempted - delivery.succeeded - httpFailures - exceptions));
        result.destinations_configured += configured;
        result.destinations_attempted += Number(delivery.attempted || 0);
        result.destinations_succeeded += Number(delivery.succeeded || 0);
        result.http_failures += httpFailures;
        result.provider_failures += providerFailures;
        result.exceptions += exceptions;
        if (delivery.succeeded > 0) {
          let acked = 0;
          try {
            acked = await ackReliableOutboxRows(
              options.db, options.table, chunk.rows.map((row) => row.event_id), options.owner, nowMs,
            );
          } catch {
            acked = 0;
          }
          result.rows_delivered += acked;
          const unresolved = chunk.rows.length - acked;
          result.post_send_unresolved += unresolved;
          if (unresolved > 0) result.chunks_post_send_unresolved++;
          else result.chunks_delivered++;
        } else if (exceptions > 0) {
          result.post_send_unresolved += chunk.rows.length;
          result.chunks_post_send_unresolved++;
        } else {
          let nack = { pending: 0, failed: 0 };
          try {
            nack = await nackRows(
              options.db, options.table, chunk.rows, options.owner, nowMs, 'no_destination_succeeded',
            );
          } catch {
            // Unknown D1 outcome remains post-send unresolved.
          }
          result.rows_retried += nack.pending;
          result.rows_failed_at_limit += nack.failed;
          const unresolved = chunk.rows.length - nack.pending - nack.failed;
          result.post_send_unresolved += unresolved;
          if (unresolved > 0) result.chunks_post_send_unresolved++;
          else if (nack.pending === chunk.rows.length) result.chunks_retried++;
          else if (nack.failed === chunk.rows.length) result.chunks_terminal_failed++;
          else {
            result.status = 'error';
            result.error_code = 'CONSERVATION_INTEGRITY_ERROR';
          }
        }
      }
      if (claimable.length < CLAIM_BATCH_MAX) break;
    }
  } catch (error) {
    result.status = 'error';
    result.table_state = 'error';
    result.error_code = 'OUTBOX_TABLE_OR_CLAIM_ERROR';
    console.error(`[${options.logLabel}] drain failed:`, error);
  }
  result.rows_unresolved = result.pre_send_unresolved + result.post_send_unresolved;
  result.terminal_failed = result.rows_failed_pre_send + result.rows_failed_at_limit + result.stale_at_limit;
  const rowsConserve = result.rows_claimed
    === result.rows_failed_pre_send + result.rows_send_attempted + result.pre_send_unresolved
    && result.rows_send_attempted
      === result.rows_delivered + result.rows_retried + result.rows_failed_at_limit + result.post_send_unresolved;
  const chunksConserve = result.chunks_attempted
    === result.chunks_delivered + result.chunks_retried
      + result.chunks_terminal_failed + result.chunks_post_send_unresolved;
  const destinationsConserve = result.destinations_attempted
    === result.destinations_succeeded + result.http_failures
      + result.provider_failures + result.exceptions;
  if (!rowsConserve || !chunksConserve || !destinationsConserve) {
    result.status = 'error';
    result.error_code = 'CONSERVATION_INTEGRITY_ERROR';
  } else if (
    result.rows_retried || result.terminal_failed || result.rows_unresolved
    || result.http_failures || result.provider_failures || result.exceptions || result.lease_conflicts
  ) result.status = 'partial';
  return result;
}

export async function retainReliableOutbox<Action extends string>(options: {
  db: D1Database;
  table: ReliableOutboxTable;
  action: Action;
  gate: string | undefined;
  nowMs: number;
  logLabel: string;
}): Promise<ReliableOutboxRetentionResult<Action>> {
  const enabled = options.gate === '1';
  const result: ReliableOutboxRetentionResult<Action> = {
    contract_version: 1, action: options.action, status: enabled ? 'ok' : 'disabled',
    gate_state: options.gate === undefined ? 'missing' : enabled ? 'enabled' : 'disabled',
    table_state: enabled ? 'ready' : 'not_checked', error_code: null,
    retention_lookahead_found: 0, eligible_found: 0, delete_attempted: 0,
    retained_deleted: 0, delete_conflicts: 0, cap_reached: false, oldest_expired_age: null,
  };
  if (!enabled) return result;
  const table = tableSql(options.table);
  try {
    const eligible = await options.db.prepare(
      `SELECT event_id,state,expires_at_ms FROM ${table}
        WHERE state IN ('delivered','failed') AND expires_at_ms IS NOT NULL AND expires_at_ms<=?
        ORDER BY expires_at_ms ASC,event_id ASC LIMIT ?`,
    ).bind(options.nowMs, RETENTION_DELETE_MAX + 1)
      .all<{ event_id: string; state: string; expires_at_ms: number }>();
    const lookahead = eligible.results || [];
    result.retention_lookahead_found = lookahead.length;
    result.cap_reached = lookahead.length === RETENTION_DELETE_MAX + 1;
    const attempted = lookahead.slice(0, RETENTION_DELETE_MAX);
    result.eligible_found = attempted.length;
    result.delete_attempted = attempted.length;
    if (attempted.length) {
      result.oldest_expired_age = Math.max(
        0, Math.floor((options.nowMs - Number(attempted[0].expires_at_ms)) / 1000),
      );
    }
    for (const row of attempted) {
      const deleted = await options.db.prepare(
        `DELETE FROM ${table} WHERE event_id=? AND state=? AND expires_at_ms<=?`,
      ).bind(row.event_id, row.state, options.nowMs).run();
      result.retained_deleted += Number(deleted.meta?.changes || 0);
    }
    result.delete_conflicts = result.delete_attempted - result.retained_deleted;
    if (result.delete_conflicts) result.status = 'partial';
  } catch (error) {
    result.status = 'error';
    result.table_state = 'error';
    result.error_code = 'OUTBOX_RETENTION_ERROR';
    console.error(`[${options.logLabel}] retention failed:`, error);
  }
  return result;
}
