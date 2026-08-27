import type { Env } from '../index';
import { pushDeerMessage, type PushDeerSendResult } from '../notifier';
import { FEED_REGISTRY } from '../feeds/registry';
import {
  ackReliableOutboxRows,
  drainReliableOutbox,
  retainReliableOutbox,
  sanitizeReliableOutboxDetail,
  type ReliableOutboxDrainResult,
  type ReliableOutboxRetentionResult,
  type ReliableOutboxRow,
} from './reliable-outbox';

export const WARNING_OUTBOX_SCHEMA_VERSION = 1;
export const WARNING_OUTBOX_MAX_ATTEMPTS = 6;
const TERMINAL_RETENTION_MS = 90 * 24 * 60 * 60_000;
const CHUNK_EVENT_MAX = 25;
const CHUNK_BODY_MAX_BYTES = 16_384;
const LEGACY_RESERVATION_STALE_MS = 30 * 60_000;
export const WARNING_CRON_RESULT_MAX_UTF8_BYTES = 3840;

export type WarningSourceType = 'blog' | 'podcast';

export interface WarningOutboxBridgeResult {
  status: 'ok';
  suppressed_ids: string[];
  legacy_ids: string[];
  alert_legacy_owned: number;
  alert_bridge_suppressed: number;
  bridge_duplicate_possible: number;
}

export interface WarningOutboxPayload {
  attempt_limit: 6;
  dedup_period: string;
  event_type: 'workflow_retry_exhausted';
  observed_at_ms: number;
  schema_version: 1;
  source_type: WarningSourceType;
  subject_id: string;
}

export interface BuiltWarningOutboxEvent extends WarningOutboxPayload {
  event_id: string;
  payload_json: string;
  payload_sha256: string;
}

export interface WarningOutboxRow extends ReliableOutboxRow {
  event_id: string;
  schema_version: 1;
  event_type: 'workflow_retry_exhausted';
  source_type: WarningSourceType;
  subject_id: string;
  dedup_period: string;
  observed_at_ms: number;
  payload_json: string;
  payload_sha256: string;
  record_kind: 'deliverable' | 'producer_quarantine';
  state: 'pending' | 'leased' | 'delivered' | 'failed';
  attempts: number;
  next_retry_at_ms: number | null;
  lease_owner: string | null;
  lease_until_ms: number | null;
  created_at_ms: number;
  updated_at_ms: number;
  delivered_at_ms: number | null;
  failed_at_ms: number | null;
  last_error_code: string | null;
  last_error_detail: string | null;
  expires_at_ms: number | null;
}

const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function boundedObservationValue(value: unknown): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }
  if (typeof value === 'string') return value.length <= 64 ? value : value.slice(0, 64);
  if (Array.isArray(value)) return value.slice(0, 4).map(boundedObservationValue);
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (key === 'integrity_conflict_ids' || key === 'conflict_ids'
        || key === 'suppressed_ids' || key === 'legacy_ids'
        || key.endsWith('_raw_ids') || key === 'last_error_detail') continue;
      output[key] = boundedObservationValue((value as Record<string, unknown>)[key]);
    }
    return output;
  }
  return null;
}

/** Exact bounded JSON used by required warning cron records; never stores raw IDs. */
export async function serializeWarningCronObservation(value: unknown): Promise<string> {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const normalized = boundedObservationValue(source) as Record<string, unknown>;
  const conflicts = Array.isArray(source.integrity_conflict_ids)
    ? source.integrity_conflict_ids.map(String).sort() : [];
  if (conflicts.length) {
    normalized.integrity_conflict_count = conflicts.length;
    normalized.integrity_conflict_digest = await sha256(JSON.stringify(conflicts));
    normalized.integrity_conflict_sample_tokens = await Promise.all(
      conflicts.slice(0, 4).map(async (id) => (await sha256(id)).slice(0, 16)),
    );
  }
  const json = JSON.stringify(normalized);
  if (byteLength(json) <= WARNING_CRON_RESULT_MAX_UTF8_BYTES) return json;
  return JSON.stringify({
    action: typeof source.action === 'string' ? source.action.slice(0, 64) : 'warning-observation',
    contract_version: 1,
    error_code: 'CRON_RESULT_OVERSIZE',
    status: 'error',
  });
}

function utcPeriod(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Resolve the 0/1 rollback bridge without ever dual-writing a D1-owned event. */
export async function resolveWarningOutboxLegacyBridge(
  env: Pick<Env, 'DB'>,
  sourceType: WarningSourceType,
  itemIds: readonly string[],
  dedupPeriod: string,
): Promise<WarningOutboxBridgeResult> {
  const empty = {
    status: 'ok' as const,
    suppressed_ids: [],
    legacy_ids: [],
    alert_legacy_owned: 0,
    alert_bridge_suppressed: 0,
    bridge_duplicate_possible: 0,
  };
  if (itemIds.length === 0) return empty;
  const suppressedIds: string[] = [];
  const legacyIds: string[] = [];
  const claimed = new Set<string>();
  const nowMs = Date.now();
  for (const rawItemId of itemIds) {
    const subjectId = rawItemId.normalize('NFC');
    validateSubject(subjectId);
    if (claimed.has(subjectId)) {
      suppressedIds.push(rawItemId);
      continue;
    }
    const eventId = await sha256(canonicalIdentity(sourceType, subjectId, dedupPeriod));
    const reservation = await env.DB.prepare(
      `INSERT INTO warning_outbox (
         event_id,schema_version,event_type,source_type,subject_id,dedup_period,observed_at_ms,
         record_kind,payload_json,payload_sha256,state,attempts,next_retry_at_ms,lease_owner,lease_until_ms,
         created_at_ms,updated_at_ms,delivered_at_ms,failed_at_ms,last_error_code,last_error_detail,expires_at_ms
       ) VALUES (?,?,?,?,?,?,?,'producer_quarantine',NULL,NULL,'failed',0,NULL,NULL,NULL,?,?,NULL,?,
                 'PRODUCER_LEGACY_OWNED','legacy bridge owns canonical tuple',?)
       ON CONFLICT(event_type,source_type,subject_id,dedup_period) DO NOTHING`,
    ).bind(
      eventId, WARNING_OUTBOX_SCHEMA_VERSION, 'workflow_retry_exhausted', sourceType,
      subjectId, dedupPeriod, nowMs, nowMs, nowMs, nowMs, nowMs + TERMINAL_RETENTION_MS,
    ).run();
    if (Number(reservation.meta?.changes || 0) === 1) {
      claimed.add(subjectId);
      legacyIds.push(rawItemId);
    } else {
      const retryEvent = await buildWarningOutboxEvent(sourceType, subjectId, nowMs);
      const promoted = retryEvent.dedup_period === dedupPeriod
        ? await env.DB.prepare(
        `UPDATE warning_outbox
            SET observed_at_ms=?,record_kind='deliverable',payload_json=?,payload_sha256=?,
                state='pending',next_retry_at_ms=?,failed_at_ms=NULL,last_error_code=NULL,
                last_error_detail=NULL,expires_at_ms=NULL,updated_at_ms=?
          WHERE event_type='workflow_retry_exhausted' AND source_type=?
            AND subject_id=? AND dedup_period=? AND record_kind='producer_quarantine'
            AND state='failed' AND attempts=0
            AND last_error_code='PRODUCER_LEGACY_OWNED' AND updated_at_ms<=?`,
      ).bind(
        retryEvent.observed_at_ms, retryEvent.payload_json, retryEvent.payload_sha256,
        nowMs, nowMs, sourceType, subjectId, dedupPeriod,
        nowMs - LEGACY_RESERVATION_STALE_MS,
      ).run()
        : null;
      if (Number(promoted?.meta?.changes || 0) === 1) {
        suppressedIds.push(rawItemId);
        empty.bridge_duplicate_possible++;
      } else {
        suppressedIds.push(rawItemId);
      }
    }
  }
  return {
    status: 'ok',
    suppressed_ids: suppressedIds,
    legacy_ids: legacyIds,
    alert_legacy_owned: legacyIds.length,
    alert_bridge_suppressed: suppressedIds.length,
    bridge_duplicate_possible: empty.bridge_duplicate_possible,
  };
}

/** Release only a first-attempt reservation after a known KV non-delivery. */
export async function releaseWarningOutboxLegacyBridgeReservations(
  env: Pick<Env, 'DB'>,
  sourceType: WarningSourceType,
  itemIds: readonly string[],
  dedupPeriod: string,
): Promise<number> {
  const canonicalIds = [...new Set(itemIds.map((itemId) => itemId.normalize('NFC')))];
  if (!canonicalIds.length) return 0;
  const released = await env.DB.prepare(
    `DELETE FROM warning_outbox
      WHERE event_type='workflow_retry_exhausted' AND source_type=? AND dedup_period=?
        AND record_kind='producer_quarantine' AND state='failed' AND attempts=0
        AND last_error_code='PRODUCER_LEGACY_OWNED'
        AND subject_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))`,
  ).bind(sourceType, dedupPeriod, JSON.stringify(canonicalIds)).run();
  return Number(released.meta?.changes || 0);
}

function canonicalIdentity(
  sourceType: WarningSourceType,
  subjectId: string,
  dedupPeriod: string,
): string {
  return `{"dedup_period":${JSON.stringify(dedupPeriod)},"event_type":"workflow_retry_exhausted",`
    + `"schema_version":1,"source_type":${JSON.stringify(sourceType)},"subject_id":${JSON.stringify(subjectId)}}`;
}

function canonicalPayload(payload: WarningOutboxPayload): string {
  return `{"attempt_limit":6,"dedup_period":${JSON.stringify(payload.dedup_period)},`
    + `"event_type":"workflow_retry_exhausted","observed_at_ms":${payload.observed_at_ms},`
    + `"schema_version":1,"source_type":${JSON.stringify(payload.source_type)},`
    + `"subject_id":${JSON.stringify(payload.subject_id)}}`;
}

function validateSubject(subjectId: string): void {
  const bytes = byteLength(subjectId);
  if (bytes < 1 || bytes > 1024) throw new Error('PRODUCER_SUBJECT_INVALID');
}

export async function buildWarningOutboxEvent(
  sourceType: WarningSourceType,
  rawSubjectId: string,
  observedAtMs: number,
): Promise<BuiltWarningOutboxEvent> {
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
    throw new Error('PRODUCER_CANONICALIZATION_REJECTED');
  }
  const subjectId = rawSubjectId.normalize('NFC');
  validateSubject(subjectId);
  const dedupPeriod = utcPeriod(observedAtMs);
  const payload: WarningOutboxPayload = {
    attempt_limit: 6,
    dedup_period: dedupPeriod,
    event_type: 'workflow_retry_exhausted',
    observed_at_ms: observedAtMs,
    schema_version: 1,
    source_type: sourceType,
    subject_id: subjectId,
  };
  const payloadJson = canonicalPayload(payload);
  if (byteLength(payloadJson) > 8192) throw new Error('PRODUCER_CANONICALIZATION_REJECTED');
  return {
    ...payload,
    event_id: await sha256(canonicalIdentity(sourceType, subjectId, dedupPeriod)),
    payload_json: payloadJson,
    payload_sha256: await sha256(payloadJson),
  };
}

const PAYLOAD_KEYS = [
  'attempt_limit', 'dedup_period', 'event_type', 'observed_at_ms',
  'schema_version', 'source_type', 'subject_id',
];

export async function validateWarningOutboxRow(
  row: WarningOutboxRow,
): Promise<{ ok: true; payload: WarningOutboxPayload } | { ok: false; code: string; detail: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload_json);
  } catch (error) {
    return { ok: false, code: 'OUTBOX_CORRUPT_JSON', detail: String(error) };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, code: 'OUTBOX_CORRUPT_SCHEMA', detail: 'payload_not_object' };
  }
  const object = parsed as Record<string, unknown>;
  if (Object.keys(object).sort().join(',') !== [...PAYLOAD_KEYS].sort().join(',')) {
    return { ok: false, code: 'OUTBOX_CORRUPT_SCHEMA', detail: 'payload_keys' };
  }
  if (
    object.attempt_limit !== 6
    || object.event_type !== 'workflow_retry_exhausted'
    || object.schema_version !== 1
    || (object.source_type !== 'blog' && object.source_type !== 'podcast')
    || typeof object.subject_id !== 'string'
    || object.subject_id !== object.subject_id.normalize('NFC')
    || typeof object.dedup_period !== 'string'
    || !/^\d{4}-\d{2}-\d{2}$/.test(object.dedup_period)
    || !Number.isSafeInteger(object.observed_at_ms)
    || Number(object.observed_at_ms) < 0
    || byteLength(object.subject_id) < 1
    || byteLength(object.subject_id) > 1024
    || byteLength(row.payload_json) > 8192
  ) return { ok: false, code: 'OUTBOX_CORRUPT_SCHEMA', detail: 'payload_values' };
  let observedPeriod: string;
  try {
    observedPeriod = utcPeriod(Number(object.observed_at_ms));
  } catch {
    return { ok: false, code: 'OUTBOX_CORRUPT_SCHEMA', detail: 'observed_at_range' };
  }
  if (observedPeriod !== object.dedup_period) {
    return { ok: false, code: 'OUTBOX_CORRUPT_SCHEMA', detail: 'dedup_period_observed_at' };
  }
  const payload = object as unknown as WarningOutboxPayload;
  if (canonicalPayload(payload) !== row.payload_json) {
    return { ok: false, code: 'OUTBOX_CORRUPT_SCHEMA', detail: 'payload_not_canonical' };
  }
  if (await sha256(row.payload_json) !== row.payload_sha256) {
    return { ok: false, code: 'OUTBOX_CORRUPT_HASH', detail: 'payload_hash' };
  }
  const expectedEventId = await sha256(canonicalIdentity(payload.source_type, payload.subject_id, payload.dedup_period));
  if (expectedEventId !== row.event_id) {
    return { ok: false, code: 'OUTBOX_CORRUPT_EVENT_ID', detail: 'event_id' };
  }
  if (
    payload.source_type !== row.source_type
    || payload.subject_id !== row.subject_id
    || payload.dedup_period !== row.dedup_period
    || payload.observed_at_ms !== row.observed_at_ms
    || row.event_type !== 'workflow_retry_exhausted'
    || row.schema_version !== 1
  ) return { ok: false, code: 'OUTBOX_CORRUPT_COLUMNS', detail: 'payload_columns' };
  return { ok: true, payload };
}

export async function enqueueWarningOutboxEvent(
  env: Pick<Env, 'DB'>,
  sourceType: WarningSourceType,
  subjectId: string,
  nowMs: number,
): Promise<{ enqueued: boolean; event: BuiltWarningOutboxEvent }> {
  const event = await buildWarningOutboxEvent(sourceType, subjectId, nowMs);
  const result = await env.DB.prepare(
    `INSERT INTO warning_outbox (
       event_id,schema_version,event_type,source_type,subject_id,dedup_period,observed_at_ms,
       record_kind,payload_json,payload_sha256,state,attempts,next_retry_at_ms,
       created_at_ms,updated_at_ms
     ) VALUES (?,?,?,?,?,?,?,'deliverable',?,?,'pending',0,?,?,?)
     ON CONFLICT(event_type,source_type,subject_id,dedup_period) DO NOTHING`,
  ).bind(
    event.event_id, 1, event.event_type, event.source_type, event.subject_id, event.dedup_period,
    event.observed_at_ms, event.payload_json, event.payload_sha256, nowMs, nowMs, nowMs,
  ).run();
  return { enqueued: Number(result.meta?.changes || 0) === 1, event };
}

const PRODUCER_PAGE_SIZE = 50;
const PRODUCER_MAX_PAGES = 4;
const PRODUCER_MAX_SCANNED_ROWS = 200;
const CANONICAL_BACKFILL_PAGE_SIZE = 50;
const CANONICAL_BACKFILL_MAX_PAGES = 4;
const CANONICAL_BACKFILL_LEASE_MS = 10 * 60_000;

function recoveryRegistryJson(): string {
  return JSON.stringify(FEED_REGISTRY
    .filter((feed) => feed.kind === 'blog' || feed.kind === 'podcast')
    .map((feed) => ({
      config: JSON.stringify(feed), id: feed.id, key: feed.key, kind: feed.kind,
    }))
    .sort((left, right) => left.id.localeCompare(right.id)));
}

async function warningCanonicalRowId(
  sourceType: WarningSourceType,
  canonicalSubjectId: string,
): Promise<string> {
  return sha256(`warning-subject\0${sourceType}\0v1\0${canonicalSubjectId}`);
}

interface WarningCanonicalCursorRow {
  source_type: WarningSourceType;
  after_item_rowid: number;
  cycle_high_water_rowid: number;
  cycle_no: number;
  initial_backfill_complete: number;
  future_hook_contract_version: number;
  ready: number;
  error_code: string | null;
  lease_owner: string | null;
  lease_until_ms: number | null;
}

export interface WarningCanonicalReadiness {
  source_type: WarningSourceType;
  ready: boolean;
  error_code: string | null;
  after_item_rowid: number;
  cycle_high_water_rowid: number;
  cycle_no: number;
}

export interface WarningCanonicalBackfillResult {
  contract_version: 1;
  action: 'warning-subject-backfill-blog' | 'warning-subject-backfill-podcast';
  status: 'disabled' | 'ok' | 'partial' | 'error';
  backfill_gate: 'missing' | 'disabled' | 'enabled';
  table_state: 'not_checked' | 'ready' | 'error';
  source_type: WarningSourceType;
  canonicalization_ready: boolean;
  canonical_rows_scanned: number;
  canonical_rows_mapped: number;
  canonical_alias_duplicates: number;
  canonical_rows_quarantined: number;
  canonical_pages_scanned: number;
  canonical_scan_cap_reached: boolean;
  canonical_cursor_after_rowid: number;
  canonical_cycle_high_water_rowid: number;
  canonical_cycle_no: number;
  canonical_cursor_wrapped: boolean;
  canonical_lease_conflicts: number;
  error_code: string | null;
}

async function canonicalIntegrityError(
  env: Pick<Env, 'DB'>,
  sourceType: WarningSourceType,
): Promise<string | null> {
  const aliasGap = await env.DB.prepare(
    `SELECT 1 present FROM warning_subject_aliases a
      LEFT JOIN warning_canonical_subjects c
        ON c.source_type=a.source_type AND c.canonical_version=a.canonical_version
       AND c.canonical_subject_id=a.canonical_subject_id AND c.canonical_row_id=a.canonical_row_id
       AND c.state='mapped'
     WHERE a.source_type=? AND a.state='mapped' AND c.canonical_row_id IS NULL LIMIT 1`,
  ).bind(sourceType).first<{ present: number }>();
  if (aliasGap) return 'CANONICAL_MAPPING_INCOMPLETE';
  const canonicalGap = await env.DB.prepare(
    `SELECT 1 present FROM warning_canonical_subjects c
      LEFT JOIN warning_subject_aliases a
        ON a.source_type=c.source_type AND a.canonical_version=c.canonical_version
       AND a.canonical_subject_id=c.canonical_subject_id AND a.canonical_row_id=c.canonical_row_id
       AND a.state='mapped'
     WHERE c.source_type=? AND c.state='mapped' AND a.raw_subject_id IS NULL LIMIT 1`,
  ).bind(sourceType).first<{ present: number }>();
  if (canonicalGap) return 'CANONICAL_MAPPING_INCOMPLETE';
  const tokenGap = await env.DB.prepare(
    `WITH normalized AS (
       SELECT i.id,i.source_type,
              CASE WHEN i.extra IS NOT NULL AND json_valid(i.extra)=1 THEN i.extra ELSE '{}' END safe_extra
         FROM items i WHERE i.source_type=? AND i.deleted_at IS NULL
     )
     SELECT 1 present FROM normalized n
      WHERE json_extract(n.safe_extra,'$.workflow_recovery_transition_token') IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM warning_canonical_subjects c JOIN warning_subject_aliases a
            ON a.source_type=c.source_type AND a.canonical_version=c.canonical_version
           AND a.canonical_subject_id=c.canonical_subject_id AND a.canonical_row_id=c.canonical_row_id
           AND a.state='mapped'
           WHERE c.source_type=n.source_type AND c.canonical_version=1 AND c.state='mapped'
             AND c.canonical_subject_id=json_extract(n.safe_extra,'$.workflow_recovery_transition_canonical_id')
             AND c.canonical_row_id=json_extract(n.safe_extra,'$.workflow_recovery_transition_canonical_row_id')
             AND a.raw_subject_id=n.id)
      LIMIT 1`,
  ).bind(sourceType).first<{ present: number }>();
  return tokenGap ? 'CANONICAL_MAPPING_INCOMPLETE' : null;
}

export async function readWarningCanonicalReadiness(
  env: Pick<Env, 'DB'>,
  sourceType: WarningSourceType,
): Promise<WarningCanonicalReadiness> {
  const cursor = await env.DB.prepare(
    `SELECT * FROM warning_subject_scan_cursors WHERE source_type=?`,
  ).bind(sourceType).first<WarningCanonicalCursorRow>();
  if (!cursor) {
    return { source_type: sourceType, ready: false, error_code: 'CANONICAL_TABLE_MISSING',
      after_item_rowid: 0, cycle_high_water_rowid: 0, cycle_no: 0 };
  }
  const integrityError = await canonicalIntegrityError(env, sourceType);
  const ready = cursor.ready === 1
    && cursor.initial_backfill_complete === 1
    && cursor.future_hook_contract_version === 1
    && !cursor.error_code
    && !integrityError;
  return {
    source_type: sourceType,
    ready,
    error_code: integrityError || cursor.error_code || (ready ? null : 'CANONICAL_BACKFILL_PENDING'),
    after_item_rowid: Number(cursor.after_item_rowid),
    cycle_high_water_rowid: Number(cursor.cycle_high_water_rowid),
    cycle_no: Number(cursor.cycle_no),
  };
}

interface CanonicalBackfillCandidate {
  item_rowid: number;
  id: string;
  scraped_at: string;
  attempts: number;
  eligible: number;
}

export async function materializeWarningCanonicalSubjects(
  env: Pick<Env, 'DB'>,
  sourceType: WarningSourceType,
  options: { nowMs?: number; owner?: string } = {},
): Promise<WarningCanonicalBackfillResult> {
  const nowMs = options.nowMs ?? Date.now();
  const owner = options.owner || crypto.randomUUID();
  const result: WarningCanonicalBackfillResult = {
    contract_version: 1,
    action: sourceType === 'blog' ? 'warning-subject-backfill-blog' : 'warning-subject-backfill-podcast',
    status: 'ok', backfill_gate: 'enabled', table_state: 'ready',
    source_type: sourceType, canonicalization_ready: false,
    canonical_rows_scanned: 0, canonical_rows_mapped: 0, canonical_alias_duplicates: 0,
    canonical_rows_quarantined: 0, canonical_pages_scanned: 0,
    canonical_scan_cap_reached: false, canonical_cursor_after_rowid: 0,
    canonical_cycle_high_water_rowid: 0, canonical_cycle_no: 0,
    canonical_cursor_wrapped: false, canonical_lease_conflicts: 0, error_code: null,
  };
  const claim = await env.DB.prepare(
    `UPDATE warning_subject_scan_cursors SET lease_owner=?,lease_until_ms=?,updated_at_ms=?
      WHERE source_type=? AND (lease_owner IS NULL OR lease_until_ms<=?)`,
  ).bind(owner, nowMs + CANONICAL_BACKFILL_LEASE_MS, nowMs, sourceType, nowMs).run();
  if (Number(claim.meta?.changes || 0) !== 1) {
    result.status = 'partial';
    result.canonical_lease_conflicts = 1;
    result.error_code = 'CANONICAL_LEASE_CONFLICT';
    return result;
  }
  try {
    let cursor = await env.DB.prepare(
      `SELECT * FROM warning_subject_scan_cursors WHERE source_type=? AND lease_owner=?`,
    ).bind(sourceType, owner).first<WarningCanonicalCursorRow>();
    if (!cursor) throw new Error('CANONICAL_CURSOR_CLAIM_LOST');
    if (Number(cursor.cycle_no) === 0) {
      const high = await env.DB.prepare(
        `SELECT COALESCE(MAX(i.rowid),0) high_water FROM items i
          WHERE i.source_type=?`,
      ).bind(sourceType).first<{ high_water: number }>();
      const nextHigh = Number(high?.high_water || 0);
      const cycle = 1;
      const updated = await env.DB.prepare(
        `UPDATE warning_subject_scan_cursors
            SET cycle_high_water_rowid=?,cycle_no=?,future_hook_contract_version=1,updated_at_ms=?
          WHERE source_type=? AND lease_owner=? AND lease_until_ms>?
            AND cycle_no=0 AND after_item_rowid=0 AND cycle_high_water_rowid=0`,
      ).bind(nextHigh, cycle, nowMs, sourceType, owner, nowMs).run();
      if (Number(updated.meta?.changes || 0) !== 1) throw new Error('CANONICAL_CURSOR_ADVANCE_CONFLICT');
      cursor = { ...cursor, cycle_high_water_rowid: nextHigh, cycle_no: cycle };
    }
    const registryJson = recoveryRegistryJson();
    let after = Number(cursor.after_item_rowid);
    const highWater = Number(cursor.cycle_high_water_rowid);
    const cycle = Number(cursor.cycle_no);
    let complete = false;
    for (let pageNo = 0; pageNo < CANONICAL_BACKFILL_MAX_PAGES; pageNo++) {
      const pageAfter = after;
      const rows = await env.DB.prepare(
        `WITH registry AS (
           SELECT json_extract(value,'$.id') id,json_extract(value,'$.key') feed_key,
                  json_extract(value,'$.kind') kind,json_extract(value,'$.config') config
             FROM json_each(?)
         ), normalized AS (
           SELECT i.rowid item_rowid,i.*,
                  CASE WHEN i.extra IS NOT NULL AND json_valid(i.extra)=1 THEN i.extra ELSE '{}' END safe_extra,
                  CASE WHEN i.extra IS NOT NULL AND json_valid(i.extra)=1 THEN 1 ELSE 0 END extra_valid
             FROM items i
            WHERE i.rowid>? AND i.rowid<=? AND i.source_type=?
            ORDER BY i.rowid ASC LIMIT ?
         )
         SELECT n.item_rowid,n.id,n.scraped_at,
                COALESCE(CAST(json_extract(n.safe_extra,'$.workflow_recovery_attempts') AS INTEGER),0) attempts,
                CASE WHEN n.extra_valid=1 AND n.deleted_at IS NULL AND n.source_ref IS NULL
                  AND json_extract(n.safe_extra,'$.workflow_completed_at') IS NULL
                  AND COALESCE(CAST(json_extract(n.safe_extra,'$.workflow_recovery_attempts') AS INTEGER),0)>=6
                  AND EXISTS (
                    SELECT 1 FROM registry r JOIN sources s
                      ON s.id=r.id AND s.source_type=r.kind AND s.source_ref=r.feed_key AND s.config=r.config
                     WHERE r.id=json_extract(n.safe_extra,'$.feed_id')
                       AND r.feed_key=COALESCE(json_extract(n.safe_extra,'$.show_key'),json_extract(n.safe_extra,'$.feed_key'))
                       AND r.kind IN ('blog','podcast'))
                  AND NOT EXISTS (
                    SELECT 1 FROM warning_subject_aliases a
                     WHERE a.source_type=? AND a.raw_subject_id=n.id AND a.item_rowid=n.item_rowid)
                  THEN 1 ELSE 0 END eligible
           FROM normalized n ORDER BY n.item_rowid ASC`,
      ).bind(
        registryJson, pageAfter, highWater, sourceType, CANONICAL_BACKFILL_PAGE_SIZE, sourceType,
      ).all<CanonicalBackfillCandidate>();
      const candidates = rows.results || [];
      if (candidates.length === 0) {
        complete = true;
        break;
      }
      result.canonical_pages_scanned++;
      result.canonical_rows_scanned += candidates.length;
      for (const candidate of candidates) {
        if (candidate.eligible !== 1) continue;
      const canonicalSubjectId = candidate.id.normalize('NFC');
      const canonicalRowId = await warningCanonicalRowId(sourceType, canonicalSubjectId);
      if (byteLength(canonicalSubjectId) < 1 || byteLength(canonicalSubjectId) > 1024) {
        const quarantine = await env.DB.prepare(
          `INSERT INTO warning_subject_aliases(
             source_type,raw_subject_id,canonical_subject_id,canonical_version,canonical_row_id,
             item_rowid,state,last_error_code,mapped_at_ms,updated_at_ms)
           VALUES(?,?,?,1,?,?,'quarantined','CANONICAL_SUBJECT_INVALID',?,?)
           ON CONFLICT(source_type,raw_subject_id) DO NOTHING`,
        ).bind(sourceType, candidate.id, canonicalSubjectId, canonicalRowId,
          candidate.item_rowid, nowMs, nowMs).run();
        if (Number(quarantine.meta?.changes || 0) === 1) result.canonical_rows_quarantined++;
        else result.canonical_alias_duplicates++;
        continue;
      }
      const subjectInsert = env.DB.prepare(
        `INSERT INTO warning_canonical_subjects(
           source_type,canonical_subject_id,canonical_version,canonical_row_id,first_item_rowid,
           sort_attempts,sort_scraped_at,sort_raw_subject_id,state,created_at_ms,updated_at_ms)
         VALUES(?,?,1,?,?,?, ?,?,'mapped',?,?)
         ON CONFLICT(source_type,canonical_subject_id) DO UPDATE SET
           first_item_rowid=MIN(first_item_rowid,excluded.first_item_rowid),
           sort_attempts=MIN(sort_attempts,excluded.sort_attempts),
           sort_scraped_at=MIN(sort_scraped_at,excluded.sort_scraped_at),
           sort_raw_subject_id=MIN(sort_raw_subject_id,excluded.sort_raw_subject_id),
           updated_at_ms=excluded.updated_at_ms
         WHERE warning_canonical_subjects.canonical_version=1
           AND warning_canonical_subjects.canonical_row_id=excluded.canonical_row_id
           AND warning_canonical_subjects.state='mapped'`,
      ).bind(sourceType, canonicalSubjectId, canonicalRowId, candidate.item_rowid,
        candidate.attempts, candidate.scraped_at, candidate.id, nowMs, nowMs);
      const aliasInsert = env.DB.prepare(
        `INSERT INTO warning_subject_aliases(
           source_type,raw_subject_id,canonical_subject_id,canonical_version,canonical_row_id,
           item_rowid,state,last_error_code,mapped_at_ms,updated_at_ms)
         SELECT ?,?,?,1,c.canonical_row_id,?,'mapped',NULL,?,?
           FROM warning_canonical_subjects c
          WHERE c.source_type=? AND c.canonical_subject_id=? AND c.canonical_version=1
            AND c.canonical_row_id=? AND c.state='mapped'
         ON CONFLICT(source_type,raw_subject_id) DO NOTHING`,
      ).bind(sourceType, candidate.id, canonicalSubjectId, candidate.item_rowid,
        nowMs, nowMs, sourceType, canonicalSubjectId, canonicalRowId);
      const writes = await env.DB.batch([subjectInsert, aliasInsert]);
      if (Number(writes[1]?.meta?.changes || 0) === 1) result.canonical_rows_mapped++;
      else result.canonical_alias_duplicates++;
      }
      const lastRowid = Number(candidates.at(-1)!.item_rowid);
      const advance = await env.DB.prepare(
        `UPDATE warning_subject_scan_cursors
            SET after_item_rowid=?,future_hook_contract_version=1,
                lease_until_ms=?,updated_at_ms=?
          WHERE source_type=? AND lease_owner=? AND lease_until_ms>?
            AND after_item_rowid=? AND cycle_high_water_rowid=? AND cycle_no=?`,
      ).bind(
        lastRowid, nowMs + CANONICAL_BACKFILL_LEASE_MS, nowMs,
        sourceType, owner, nowMs, pageAfter, highWater, cycle,
      ).run();
      if (Number(advance.meta?.changes || 0) !== 1) throw new Error('CANONICAL_CURSOR_ADVANCE_CONFLICT');
      after = lastRowid;
      if (candidates.length < CANONICAL_BACKFILL_PAGE_SIZE || after >= highWater) {
        complete = true;
        break;
      }
    }
    result.canonical_scan_cap_reached = !complete
      && result.canonical_pages_scanned === CANONICAL_BACKFILL_MAX_PAGES;
    let integrityError: string | null = null;
    if (complete) {
      const high = await env.DB.prepare(
        `SELECT COALESCE(MAX(i.rowid),0) high_water FROM items i WHERE i.source_type=?`,
      ).bind(sourceType).first<{ high_water: number }>();
      const nextHigh = Number(high?.high_water || 0);
      const wrap = await env.DB.prepare(
        `UPDATE warning_subject_scan_cursors
            SET after_item_rowid=0,cycle_high_water_rowid=?,cycle_no=cycle_no+1,
                initial_backfill_complete=1,future_hook_contract_version=1,
                lease_owner=NULL,lease_until_ms=NULL,updated_at_ms=?
          WHERE source_type=? AND lease_owner=? AND lease_until_ms>?
            AND after_item_rowid=? AND cycle_high_water_rowid=? AND cycle_no=?`,
      ).bind(nextHigh, nowMs, sourceType, owner, nowMs, after, highWater, cycle).run();
      if (Number(wrap.meta?.changes || 0) !== 1) throw new Error('CANONICAL_CURSOR_ADVANCE_CONFLICT');
      result.canonical_cursor_wrapped = true;
      integrityError = await canonicalIntegrityError(env, sourceType);
      const readyWrite = await env.DB.prepare(
        `UPDATE warning_subject_scan_cursors SET ready=?,error_code=?,updated_at_ms=?
          WHERE source_type=? AND after_item_rowid=0 AND cycle_high_water_rowid=? AND cycle_no=?
            AND lease_owner IS NULL AND initial_backfill_complete=1 AND future_hook_contract_version=1`,
      ).bind(integrityError ? 0 : 1, integrityError, nowMs, sourceType, nextHigh, cycle + 1).run();
      if (Number(readyWrite.meta?.changes || 0) !== 1) throw new Error('CANONICAL_CURSOR_ADVANCE_CONFLICT');
    } else {
      const release = await env.DB.prepare(
        `UPDATE warning_subject_scan_cursors SET lease_owner=NULL,lease_until_ms=NULL,updated_at_ms=?
          WHERE source_type=? AND lease_owner=? AND lease_until_ms>?
            AND after_item_rowid=? AND cycle_high_water_rowid=? AND cycle_no=?`,
      ).bind(nowMs, sourceType, owner, nowMs, after, highWater, cycle).run();
      if (Number(release.meta?.changes || 0) !== 1) throw new Error('CANONICAL_CURSOR_ADVANCE_CONFLICT');
    }
    const readiness = await readWarningCanonicalReadiness(env, sourceType);
    result.canonicalization_ready = readiness.ready;
    result.canonical_cursor_after_rowid = readiness.after_item_rowid;
    result.canonical_cycle_high_water_rowid = readiness.cycle_high_water_rowid;
    result.canonical_cycle_no = readiness.cycle_no;
    result.error_code = integrityError;
    if (integrityError) result.status = 'partial';
    return result;
  } catch (error) {
    try {
      await env.DB.prepare(
        `UPDATE warning_subject_scan_cursors SET ready=0,error_code='CANONICAL_BACKFILL_ERROR',
            lease_owner=NULL,lease_until_ms=NULL,updated_at_ms=?
          WHERE source_type=? AND lease_owner=?`,
      ).bind(nowMs, sourceType, owner).run();
    } catch (releaseError) {
      console.error('[warning-outbox] canonical backfill lease release failed:', releaseError);
    }
    result.status = 'error';
    result.table_state = 'error';
    result.canonicalization_ready = false;
    result.error_code = 'CANONICAL_BACKFILL_ERROR';
    console.error('[warning-outbox] canonical backfill failed:', error);
    return result;
  }
}

export async function runWarningCanonicalBackfill(
  env: Pick<Env, 'DB'> & { WARNING_CANONICAL_BACKFILL_ENABLED?: string },
  sourceType: WarningSourceType,
  options: { nowMs?: number; owner?: string } = {},
): Promise<WarningCanonicalBackfillResult> {
  if (env.WARNING_CANONICAL_BACKFILL_ENABLED !== '1') {
    return {
      contract_version: 1,
      action: sourceType === 'blog' ? 'warning-subject-backfill-blog' : 'warning-subject-backfill-podcast',
      status: 'disabled',
      backfill_gate: env.WARNING_CANONICAL_BACKFILL_ENABLED === undefined ? 'missing' : 'disabled',
      table_state: 'not_checked', source_type: sourceType, canonicalization_ready: false,
      canonical_rows_scanned: 0, canonical_rows_mapped: 0, canonical_alias_duplicates: 0,
      canonical_rows_quarantined: 0, canonical_pages_scanned: 0,
      canonical_scan_cap_reached: false, canonical_cursor_after_rowid: 0,
      canonical_cycle_high_water_rowid: 0, canonical_cycle_no: 0,
      canonical_cursor_wrapped: false, canonical_lease_conflicts: 0, error_code: null,
    };
  }
  return materializeWarningCanonicalSubjects(env, sourceType, options);
}

const PRODUCER_CT122 = `
  registry AS (
    SELECT json_extract(value,'$.id') AS id,
           json_extract(value,'$.key') AS feed_key,
           json_extract(value,'$.kind') AS kind,
           json_extract(value,'$.config') AS config
      FROM json_each(?)
  ),
  normalized_items AS (
    SELECT i.*,
           CASE WHEN i.extra IS NOT NULL AND json_valid(i.extra)=1 THEN i.extra ELSE '{}' END AS safe_extra,
           CASE WHEN i.extra IS NOT NULL AND json_valid(i.extra)=1 THEN 1 ELSE 0 END AS extra_is_valid
      FROM items i
  ),
  decoded_items AS (
    SELECT n.*,
           CASE WHEN n.extra_is_valid=1
                     AND json_type(n.safe_extra,'$.workflow_recovery_attempts')='integer'
                THEN CAST(json_extract(n.safe_extra,'$.workflow_recovery_attempts') AS INTEGER)
                ELSE NULL END AS current_attempts,
           json_extract(n.safe_extra,'$.workflow_completed_at') AS workflow_completed_at,
           json_extract(n.safe_extra,'$.workflow_retry_exhausted_alert_day') AS legacy_alert_day,
           json_extract(n.safe_extra,'$.workflow_retry_exhausted_alert_pending_day') AS legacy_pending_day,
           json_extract(n.safe_extra,'$.feed_id') AS feed_id,
           json_extract(n.safe_extra,'$.feed_key') AS feed_key,
           json_extract(n.safe_extra,'$.show_key') AS show_key
      FROM normalized_items n
  )`;

interface ProducerCandidate {
  id: string;
  canonical_subject_id: string;
  scraped_at: string;
  attempts: number;
  legacy_pending_day?: string | null;
}

export interface WarningOutboxProducerResult {
  status: 'disabled' | 'ok' | 'partial' | 'error';
  source_type: WarningSourceType;
  producer_gate: 'missing' | 'disabled' | 'enabled';
  drain_gate: 'missing' | 'disabled' | 'enabled';
  table_state: 'not_checked' | 'ready' | 'missing' | 'error';
  canonicalization_ready: boolean;
  error_code: string | null;
  found: number;
  exhausted: number;
  pages_scanned: number;
  scanned_rows: number;
  scan_cap_reached: boolean;
  oldest_scanned_age: number | null;
  malformed_extra_excluded: number;
  alert_enqueued: number;
  alert_duplicates: number;
  alert_enqueue_failed: number;
  alert_producer_quarantined: number;
  alert_integrity_errors: number;
  alert_integrity_conflicts_active: number;
  alert_integrity_conflicts_delivered: number;
  alert_integrity_conflicts_failed: number;
  integrity_conflict_count: number;
  integrity_conflict_digest: string | null;
  integrity_conflict_sample_tokens: string[];
  alert_producer_quarantine_conflicts: number;
  quarantine_conflict_count: number;
  quarantine_conflict_digest: string | null;
  alert_legacy_owned: number;
  alert_bridge_suppressed: number;
  bridge_duplicate_possible: number;
  invalid_gate_combination: boolean;
}

const producerConflictIds = new WeakMap<WarningOutboxProducerResult, string[]>();

async function appendProducerConflict(
  result: WarningOutboxProducerResult,
  internalId: string,
): Promise<void> {
  const ids = producerConflictIds.get(result) || [];
  if (!ids.includes(internalId)) ids.push(internalId);
  ids.sort();
  producerConflictIds.set(result, ids);
  result.integrity_conflict_count = ids.length;
  result.integrity_conflict_digest = await sha256(JSON.stringify(ids));
  result.integrity_conflict_sample_tokens = await Promise.all(
    ids.slice(0, 4).map(async (id) => (await sha256(id)).slice(0, 16)),
  );
}

async function producerConflictId(row: WarningOutboxRow): Promise<string> {
  const canonical = `{"event_id":${JSON.stringify(row.event_id)},"lease_owner":${JSON.stringify(row.lease_owner || '')},`
    + `"lease_until_ms":${row.lease_until_ms || 0},"observed_state":${JSON.stringify(row.state)},`
    + `"observed_updated_at_ms":${row.updated_at_ms},"reason_code":"PRODUCER_DUPLICATE_INTEGRITY"}`;
  return sha256(canonical);
}

async function observeOrTerminalizeDuplicateIntegrity(
  env: Pick<Env, 'DB'>,
  row: WarningOutboxRow,
  nowMs: number,
  result: WarningOutboxProducerResult,
): Promise<void> {
  result.alert_integrity_errors++;
  let updateChanges = 0;
  if (row.record_kind === 'deliverable' && row.state === 'pending') {
    const update = await env.DB.prepare(
      `UPDATE warning_outbox
          SET state='failed',next_retry_at_ms=NULL,lease_owner=NULL,lease_until_ms=NULL,delivered_at_ms=NULL,
              failed_at_ms=?,expires_at_ms=?,updated_at_ms=?,last_error_code='PRODUCER_DUPLICATE_INTEGRITY',
              last_error_detail='existing pending row failed immutable integrity validation'
        WHERE event_id=? AND record_kind='deliverable' AND state='pending' AND updated_at_ms=?
          AND delivered_at_ms IS NULL`,
    ).bind(nowMs, nowMs + TERMINAL_RETENTION_MS, nowMs, row.event_id, row.updated_at_ms).run();
    updateChanges = Number(update.meta?.changes || 0);
  } else if (
    row.record_kind === 'deliverable'
    && row.state === 'leased'
    && row.lease_until_ms != null
    && row.lease_until_ms <= nowMs
  ) {
    const update = await env.DB.prepare(
      `UPDATE warning_outbox
          SET state='failed',next_retry_at_ms=NULL,lease_owner=NULL,lease_until_ms=NULL,delivered_at_ms=NULL,
              failed_at_ms=?,expires_at_ms=?,updated_at_ms=?,last_error_code='PRODUCER_DUPLICATE_INTEGRITY',
              last_error_detail='existing expired lease failed immutable integrity validation'
        WHERE event_id=? AND record_kind='deliverable' AND state='leased'
          AND lease_owner=? AND lease_until_ms=? AND updated_at_ms=? AND lease_until_ms<=?
          AND delivered_at_ms IS NULL`,
    ).bind(
      nowMs, nowMs + TERMINAL_RETENTION_MS, nowMs, row.event_id,
      row.lease_owner, row.lease_until_ms, row.updated_at_ms, nowMs,
    ).run();
    updateChanges = Number(update.meta?.changes || 0);
  }
  if (updateChanges === 1) {
    result.alert_producer_quarantined++;
    return;
  }
  const current = await env.DB.prepare('SELECT * FROM warning_outbox WHERE event_id=?')
    .bind(row.event_id).first<WarningOutboxRow>();
  if (!current) return;
  if (current.state === 'leased' && Number(current.lease_until_ms) > nowMs) {
    result.alert_integrity_conflicts_active++;
  } else if (current.state === 'delivered') {
    result.alert_integrity_conflicts_delivered++;
  } else {
    result.alert_integrity_conflicts_failed++;
  }
  const conflictId = await producerConflictId(current);
  await appendProducerConflict(result, conflictId);
}

async function insertProducerQuarantine(
  env: Pick<Env, 'DB'>,
  sourceType: WarningSourceType,
  rawSubjectId: string,
  nowMs: number,
  errorCode: string,
): Promise<boolean> {
  const subjectId = rawSubjectId.normalize('NFC');
  const dedupPeriod = utcPeriod(nowMs);
  const eventId = await sha256(canonicalIdentity(sourceType, subjectId, dedupPeriod));
  const write = await env.DB.prepare(
    `INSERT INTO warning_outbox (
       event_id,schema_version,event_type,source_type,subject_id,dedup_period,observed_at_ms,
       record_kind,payload_json,payload_sha256,state,attempts,next_retry_at_ms,lease_owner,lease_until_ms,
       created_at_ms,updated_at_ms,delivered_at_ms,failed_at_ms,last_error_code,last_error_detail,expires_at_ms
     ) VALUES (?,?,?,?,?,?,?,'producer_quarantine',NULL,NULL,'failed',0,NULL,NULL,NULL,?,?,NULL,?,?,?,?)
     ON CONFLICT(event_type,source_type,subject_id,dedup_period) DO NOTHING`,
  ).bind(
    eventId, 1, 'workflow_retry_exhausted', sourceType, subjectId, dedupPeriod, nowMs,
    nowMs, nowMs, nowMs, errorCode, sanitizeReliableOutboxDetail(rawSubjectId),
    nowMs + TERMINAL_RETENTION_MS,
  ).run();
  return Number(write.meta?.changes || 0) === 1;
}

async function guardedEnqueueCandidate(
  env: Pick<Env, 'DB'>,
  sourceType: WarningSourceType,
  candidate: ProducerCandidate,
  nowMs: number,
  registryJson: string,
  result: WarningOutboxProducerResult,
): Promise<void> {
  let event: BuiltWarningOutboxEvent;
  try {
    event = await buildWarningOutboxEvent(sourceType, candidate.canonical_subject_id, nowMs);
  } catch (error) {
    const code = String(error).includes('PRODUCER_SUBJECT_INVALID')
      ? 'PRODUCER_SUBJECT_INVALID'
      : 'PRODUCER_CANONICALIZATION_REJECTED';
    if (await insertProducerQuarantine(env, sourceType, candidate.id, nowMs, code)) {
      result.alert_producer_quarantined++;
    } else {
      result.alert_duplicates++;
      result.alert_producer_quarantine_conflicts++;
      result.quarantine_conflict_count++;
      result.quarantine_conflict_digest = await sha256(
        `${sourceType}\0${candidate.canonical_subject_id}\0${utcPeriod(nowMs)}`,
      );
    }
    return;
  }
  const insert = env.DB.prepare(
    `WITH ${PRODUCER_CT122}
     INSERT INTO warning_outbox (
       event_id,schema_version,event_type,source_type,subject_id,dedup_period,observed_at_ms,
       record_kind,payload_json,payload_sha256,state,attempts,next_retry_at_ms,created_at_ms,updated_at_ms
     )
     SELECT ?,1,'workflow_retry_exhausted',?,?,?,?,'deliverable',?,?,'pending',0,?,?,?
       FROM decoded_items d
       JOIN warning_subject_aliases a
         ON a.source_type=? AND a.raw_subject_id=d.id AND a.state='mapped'
       JOIN warning_canonical_subjects c
         ON c.source_type=a.source_type AND c.canonical_version=a.canonical_version
        AND c.canonical_subject_id=a.canonical_subject_id AND c.canonical_row_id=a.canonical_row_id
        AND c.state='mapped'
       JOIN registry r ON r.id=d.feed_id
        AND r.feed_key=CASE WHEN d.source_type='podcast' THEN d.show_key ELSE d.feed_key END
        AND r.kind IN ('blog','podcast')
       JOIN sources s ON s.id=r.id AND s.source_type=r.kind AND s.source_ref=r.feed_key AND s.config=r.config
      WHERE d.id=? AND c.canonical_subject_id=? AND d.extra_is_valid=1 AND d.source_type=? AND d.deleted_at IS NULL
        AND d.source_ref IS NULL AND d.workflow_completed_at IS NULL AND d.current_attempts>=6
     ON CONFLICT(event_type,source_type,subject_id,dedup_period) DO NOTHING`,
  ).bind(
    registryJson, event.event_id, sourceType, event.subject_id, event.dedup_period, event.observed_at_ms,
    event.payload_json, event.payload_sha256, nowMs, nowMs, nowMs, sourceType,
    candidate.id, candidate.canonical_subject_id, sourceType,
  );
  const cleanup = env.DB.prepare(
    `UPDATE items SET extra=json_remove(
       CASE WHEN extra IS NOT NULL AND json_valid(extra)=1 THEN extra ELSE '{}' END,
       '$.workflow_retry_exhausted_alert_pending_day',
       '$.workflow_retry_exhausted_alert_claim_token',
       '$.workflow_retry_exhausted_alert_claimed_at') WHERE id=?`,
  ).bind(candidate.id);
  const writes = await env.DB.batch([insert, cleanup]);
  if (Number(writes[0]?.meta?.changes || 0) === 1) {
    result.alert_enqueued++;
    if (candidate.legacy_pending_day === event.dedup_period) result.bridge_duplicate_possible++;
    return;
  }
  const existing = await env.DB.prepare(
    `SELECT * FROM warning_outbox WHERE event_type='workflow_retry_exhausted'
      AND source_type=? AND subject_id=? AND dedup_period=?`,
  ).bind(sourceType, event.subject_id, event.dedup_period).first<WarningOutboxRow>();
  if (!existing) return;
  const valid = existing.record_kind === 'deliverable' ? await validateWarningOutboxRow(existing) : null;
  if (valid?.ok) result.alert_duplicates++;
  else await observeOrTerminalizeDuplicateIntegrity(env, existing, nowMs, result);
}

export async function produceWorkflowRetryExhaustedWarnings(
  env: Pick<Env, 'DB'> & { WARNING_OUTBOX_PRODUCER_ENABLED?: string; WARNING_OUTBOX_DRAIN_ENABLED?: string },
  sourceType: WarningSourceType,
  nowMs = Date.now(),
): Promise<WarningOutboxProducerResult> {
  const gateState = (value: string | undefined): 'missing' | 'disabled' | 'enabled' => (
    value === undefined ? 'missing' : value === '1' ? 'enabled' : 'disabled'
  );
  const result: WarningOutboxProducerResult = {
    status: env.WARNING_OUTBOX_PRODUCER_ENABLED === '1' ? 'ok' : 'disabled',
    source_type: sourceType,
    producer_gate: gateState(env.WARNING_OUTBOX_PRODUCER_ENABLED),
    drain_gate: gateState(env.WARNING_OUTBOX_DRAIN_ENABLED),
    table_state: 'not_checked', canonicalization_ready: false, error_code: null,
    found: 0, exhausted: 0, pages_scanned: 0, scanned_rows: 0,
    scan_cap_reached: false, oldest_scanned_age: null, malformed_extra_excluded: 0,
    alert_enqueued: 0, alert_duplicates: 0, alert_enqueue_failed: 0,
    alert_producer_quarantined: 0, alert_integrity_errors: 0,
    alert_integrity_conflicts_active: 0, alert_integrity_conflicts_delivered: 0,
    alert_integrity_conflicts_failed: 0, integrity_conflict_count: 0,
    integrity_conflict_digest: null, integrity_conflict_sample_tokens: [],
    alert_producer_quarantine_conflicts: 0, quarantine_conflict_count: 0,
    quarantine_conflict_digest: null, alert_legacy_owned: 0,
    alert_bridge_suppressed: 0, bridge_duplicate_possible: 0,
    invalid_gate_combination: env.WARNING_OUTBOX_PRODUCER_ENABLED === '1'
      && env.WARNING_OUTBOX_DRAIN_ENABLED !== '1',
  };
  if (result.status === 'disabled') return result;
  if (result.invalid_gate_combination) {
    result.status = 'partial';
    result.error_code = 'WARNING_OUTBOX_INVALID_GATE_COMBINATION';
    return result;
  }
  let readiness: WarningCanonicalReadiness;
  try {
    readiness = await readWarningCanonicalReadiness(env, sourceType);
    result.table_state = readiness.error_code === 'CANONICAL_TABLE_MISSING' ? 'missing' : 'ready';
  } catch {
    result.status = 'error';
    result.table_state = 'error';
    result.error_code = 'CANONICAL_READINESS_LOOKUP_FAILED';
    return result;
  }
  result.canonicalization_ready = readiness.ready;
  if (!readiness.ready) {
    result.status = 'partial';
    result.error_code = readiness.error_code || 'CANONICAL_BACKFILL_PENDING';
    return result;
  }
  const threshold = new Date(nowMs - 30 * 60_000).toISOString();
  const period = utcPeriod(nowMs);
  const registryJson = recoveryRegistryJson();
  const malformed = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM items i
      WHERE i.source_type=? AND i.deleted_at IS NULL AND COALESCE(i.source_ref,'')<>'manual_lead'
        AND datetime(i.scraped_at)<=datetime(?)
        AND NOT (i.extra IS NOT NULL AND json_valid(i.extra)=1)`,
  ).bind(sourceType, threshold).first<{ n: number }>();
  result.malformed_extra_excluded = Number(malformed?.n || 0);
  const canonicalCtes = `eligible_aliases AS (
    SELECT d.id,d.scraped_at,d.current_attempts attempts,d.legacy_alert_day,d.legacy_pending_day,
           a.canonical_subject_id,a.canonical_row_id
      FROM decoded_items d
      JOIN warning_subject_aliases a
        ON a.source_type=? AND a.raw_subject_id=d.id AND a.canonical_version=1 AND a.state='mapped'
      JOIN warning_canonical_subjects c
        ON c.source_type=a.source_type AND c.canonical_version=a.canonical_version
       AND c.canonical_subject_id=a.canonical_subject_id AND c.canonical_row_id=a.canonical_row_id
       AND c.state='mapped'
      JOIN registry r ON r.id=d.feed_id
       AND r.feed_key=COALESCE(d.show_key,d.feed_key) AND r.kind IN ('blog','podcast')
      JOIN sources s ON s.id=r.id AND s.source_type=r.kind AND s.source_ref=r.feed_key AND s.config=r.config
     WHERE d.extra_is_valid=1 AND d.source_type=? AND d.deleted_at IS NULL
       AND COALESCE(d.source_ref,'')<>'manual_lead' AND d.workflow_completed_at IS NULL
       AND datetime(d.scraped_at)<=datetime(?) AND d.current_attempts>=6
  ), ranked_canonical AS (
    SELECT e.*,
           ROW_NUMBER() OVER(PARTITION BY e.canonical_subject_id
             ORDER BY e.attempts ASC,e.scraped_at ASC,e.id ASC) canonical_rank,
           MAX(CASE WHEN CAST(e.legacy_alert_day AS TEXT)=? THEN 1 ELSE 0 END)
             OVER(PARTITION BY e.canonical_subject_id) legacy_owned
      FROM eligible_aliases e
  )`;
  const legacyOwned = await env.DB.prepare(
    `WITH ${PRODUCER_CT122},${canonicalCtes}
     SELECT COUNT(DISTINCT canonical_subject_id) AS n FROM ranked_canonical WHERE legacy_owned=1`,
  ).bind(registryJson, sourceType, sourceType, threshold, period).first<{ n: number }>();
  result.alert_legacy_owned = Number(legacyOwned?.n || 0);
  const bridgeSuppressed = await env.DB.prepare(
    `WITH ${PRODUCER_CT122},${canonicalCtes}
     SELECT COUNT(*) AS n FROM eligible_aliases e
      WHERE EXISTS (
        SELECT 1 FROM warning_outbox o WHERE o.event_type='workflow_retry_exhausted'
          AND o.source_type=? AND o.subject_id=e.canonical_subject_id AND o.dedup_period=?)`,
  ).bind(
    registryJson, sourceType, sourceType, threshold, period, sourceType, period,
  ).first<{ n: number }>();
  result.alert_bridge_suppressed = Number(bridgeSuppressed?.n || 0);
  let cursor: ProducerCandidate | null = null;
  for (let page = 0; page < PRODUCER_MAX_PAGES; page++) {
    const keyset: string = cursor
      ? `AND (attempts>? OR (attempts=? AND scraped_at>?)
          OR (attempts=? AND scraped_at=? AND canonical_subject_id>?))`
      : '';
    const rows: D1Result<ProducerCandidate> = await env.DB.prepare(
      `WITH ${PRODUCER_CT122},${canonicalCtes}
       SELECT id,canonical_subject_id,scraped_at,attempts,legacy_pending_day
         FROM ranked_canonical
        WHERE canonical_rank=1 AND legacy_owned=0
          AND NOT EXISTS (
            SELECT 1 FROM warning_outbox o WHERE o.event_type='workflow_retry_exhausted'
              AND o.source_type=? AND o.subject_id=canonical_subject_id AND o.dedup_period=?)
          ${keyset}
        ORDER BY attempts ASC,scraped_at ASC,canonical_subject_id ASC LIMIT ?`,
    ).bind(
      registryJson, sourceType, sourceType, threshold, period, sourceType, period,
      ...(cursor ? [
        cursor.attempts, cursor.attempts, cursor.scraped_at,
        cursor.attempts, cursor.scraped_at, cursor.canonical_subject_id,
      ] : []),
      PRODUCER_PAGE_SIZE,
    ).all<ProducerCandidate>();
    const pageRows: ProducerCandidate[] = rows.results || [];
    if (!pageRows.length) break;
    result.pages_scanned++;
    result.scanned_rows += pageRows.length;
    result.found += pageRows.length;
    result.exhausted += pageRows.length;
    for (const candidate of pageRows) {
      const age = Math.max(0, Math.floor((nowMs - Date.parse(candidate.scraped_at)) / 1000));
      if (Number.isFinite(age)) {
        result.oldest_scanned_age = result.oldest_scanned_age == null
          ? age : Math.max(result.oldest_scanned_age, age);
      }
      try {
        await guardedEnqueueCandidate(env, sourceType, candidate, nowMs, registryJson, result);
      } catch (error) {
        result.alert_enqueue_failed++;
        console.error('[warning-outbox] canonical producer enqueue failed:', error);
      }
    }
    cursor = pageRows[pageRows.length - 1];
    if (pageRows.length < PRODUCER_PAGE_SIZE) break;
  }
  result.scan_cap_reached = result.scanned_rows >= PRODUCER_MAX_SCANNED_ROWS;
  if (result.alert_enqueue_failed || result.alert_integrity_errors) result.status = 'partial';
  return result;
}

export async function ackWarningOutboxRows(
  env: Pick<Env, 'DB'>,
  ids: readonly string[],
  owner: string,
  nowMs: number,
): Promise<number> {
  return ackReliableOutboxRows(env.DB, 'warning_outbox', ids, owner, nowMs);
}

function renderChunks(rows: readonly WarningOutboxRow[]): Array<{ rows: WarningOutboxRow[]; title: string; body: string }> {
  const chunks: Array<{ rows: WarningOutboxRow[]; title: string; body: string }> = [];
  const title = 'xList告警 | feed workflow 自动重试耗尽';
  let current: WarningOutboxRow[] = [];
  let lines = ['以下 feed item 已达到 6 次自动恢复上限：', ''];
  const flush = () => {
    if (!current.length) return;
    chunks.push({ rows: current, title, body: lines.join('\n') });
    current = [];
    lines = ['以下 feed item 已达到 6 次自动恢复上限：', ''];
  };
  const ordered = [...rows].sort((left, right) => (
    left.attempts - right.attempts
    || left.dedup_period.localeCompare(right.dedup_period)
    || left.event_id.localeCompare(right.event_id)
  ));
  let attemptBucket: number | null = null;
  for (const row of ordered) {
    if (attemptBucket !== null && row.attempts !== attemptBucket) flush();
    attemptBucket = row.attempts;
    const line = `- ${row.source_type} / ${row.subject_id} / ${row.dedup_period} / ${row.event_id.slice(0, 12)}`;
    const candidate = [...lines, line].join('\n');
    if (current.length >= CHUNK_EVENT_MAX || byteLength(candidate) > CHUNK_BODY_MAX_BYTES) flush();
    current.push(row);
    lines.push(line);
  }
  flush();
  return chunks;
}

export type DrainWarningOutboxResult = ReliableOutboxDrainResult<'warning-outbox-drain'>;

export async function drainWarningOutbox(
  env: Pick<Env, 'DB' | 'PUSHDEER_ADMIN_KEYS'> & { WARNING_OUTBOX_DRAIN_ENABLED?: string },
  options: {
    nowMs?: number;
    owner?: string;
    send?: (title: string, body: string) => Promise<PushDeerSendResult>;
  } = {},
): Promise<DrainWarningOutboxResult> {
  return drainReliableOutbox<WarningOutboxRow, 'warning-outbox-drain'>({
    db: env.DB,
    table: 'warning_outbox',
    action: 'warning-outbox-drain',
    gate: env.WARNING_OUTBOX_DRAIN_ENABLED,
    nowMs: options.nowMs ?? Date.now(),
    owner: options.owner || crypto.randomUUID(),
    validate: async (row) => {
      const validation = await validateWarningOutboxRow(row);
      return validation.ok ? { ok: true } : validation;
    },
    renderChunks,
    send: options.send || ((title, body) => pushDeerMessage(env as Env, title, body)),
    logLabel: 'warning-outbox',
  });
}

export type RetainWarningOutboxResult = ReliableOutboxRetentionResult<'warning-outbox-retention'>;

export async function retainWarningOutbox(
  env: Pick<Env, 'DB'> & { WARNING_OUTBOX_DRAIN_ENABLED?: string },
  nowMs = Date.now(),
): Promise<RetainWarningOutboxResult> {
  return retainReliableOutbox({
    db: env.DB,
    table: 'warning_outbox',
    action: 'warning-outbox-retention',
    gate: env.WARNING_OUTBOX_DRAIN_ENABLED,
    nowMs,
    logLabel: 'warning-outbox',
  });
}
