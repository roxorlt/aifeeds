/** Independent durable outbox for append-only publication capacity thresholds. */

import type { Env } from '../index';
import { pushDeerMessage, type PushDeerSendResult } from '../notifier';
import {
  drainReliableOutbox,
  retainReliableOutbox,
  type ReliableOutboxDrainResult,
  type ReliableOutboxRetentionResult,
  type ReliableOutboxRow,
} from './reliable-outbox';

export const PUBLICATION_CAPACITY_SCHEMA_VERSION = 1;
export const PUBLICATION_CAPACITY_PAYLOAD_MAX_BYTES = 2048;
export const PUBLICATION_CAPACITY_CRON_RESULT_MAX_BYTES = 3840;
const CAPACITY_TERMINAL_RETENTION_MS = 90 * 24 * 60 * 60_000;
const encoder = new TextEncoder();

type CapacityThreshold = 7000 | 8500 | 9500;

export interface PublicationCapacityCrossing {
  namespace: 'daily-publications-v1';
  epoch: number;
  threshold_bps: CapacityThreshold;
  budget_version: number;
  budget_bytes: number;
  legacy_baseline_bytes: number;
  reserved_bytes: number;
  occupied_bytes: number;
  crossed_at_ms: number;
}

export interface BuiltPublicationCapacityWarningEvent extends PublicationCapacityCrossing {
  schema_version: 1;
  event_type: 'publication_capacity_threshold_crossed';
  event_id: string;
  payload_json: string;
  payload_sha256: string;
}

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function safeInteger(value: unknown, name: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new Error(`CAPACITY_PRODUCER_INVALID_${name.toUpperCase()}`);
  }
  return Number(value);
}

function capacityIdentity(input: Pick<PublicationCapacityCrossing, 'namespace' | 'epoch' | 'threshold_bps'>): string {
  return JSON.stringify({
    epoch: input.epoch,
    event_type: 'publication_capacity_threshold_crossed',
    namespace: input.namespace,
    schema_version: 1,
    threshold_bps: input.threshold_bps,
  });
}

function canonicalCapacityPayload(input: PublicationCapacityCrossing): string {
  return JSON.stringify({
    budget_bytes: input.budget_bytes,
    budget_version: input.budget_version,
    crossed_at_ms: input.crossed_at_ms,
    epoch: input.epoch,
    event_type: 'publication_capacity_threshold_crossed',
    legacy_baseline_bytes: input.legacy_baseline_bytes,
    namespace: input.namespace,
    occupied_bytes: input.occupied_bytes,
    reserved_bytes: input.reserved_bytes,
    schema_version: 1,
    threshold_bps: input.threshold_bps,
  });
}

function validateCrossing(input: PublicationCapacityCrossing): void {
  if (input.namespace !== 'daily-publications-v1') throw new Error('CAPACITY_PRODUCER_INVALID_NAMESPACE');
  if (![7000, 8500, 9500].includes(input.threshold_bps)) {
    throw new Error('CAPACITY_PRODUCER_INVALID_THRESHOLD');
  }
  safeInteger(input.epoch, 'epoch', 1);
  safeInteger(input.budget_version, 'budget_version', 1);
  safeInteger(input.budget_bytes, 'budget_bytes', 1);
  safeInteger(input.legacy_baseline_bytes, 'legacy_baseline_bytes');
  safeInteger(input.reserved_bytes, 'reserved_bytes');
  safeInteger(input.occupied_bytes, 'occupied_bytes');
  safeInteger(input.crossed_at_ms, 'crossed_at_ms');
  if (input.occupied_bytes !== input.legacy_baseline_bytes + input.reserved_bytes
    || input.occupied_bytes > input.budget_bytes
    || input.occupied_bytes * 10_000 < input.budget_bytes * input.threshold_bps) {
    throw new Error('CAPACITY_PRODUCER_INVALID_SNAPSHOT');
  }
}

export async function buildPublicationCapacityWarningEvent(
  input: PublicationCapacityCrossing,
): Promise<BuiltPublicationCapacityWarningEvent> {
  validateCrossing(input);
  const payloadJson = canonicalCapacityPayload(input);
  if (byteLength(payloadJson) > PUBLICATION_CAPACITY_PAYLOAD_MAX_BYTES) {
    throw new Error('CAPACITY_PRODUCER_PAYLOAD_OVERSIZE');
  }
  return {
    ...input,
    schema_version: 1,
    event_type: 'publication_capacity_threshold_crossed',
    event_id: await sha256(capacityIdentity(input)),
    payload_json: payloadJson,
    payload_sha256: await sha256(payloadJson),
  };
}

interface BudgetRow {
  singleton_id: number;
  namespace: string;
  budget_bytes: number;
  legacy_baseline_bytes: number;
  reserved_bytes: number;
  version: number;
  state: 'uninitialized' | 'active' | 'frozen';
  legacy_inventory_digest: string | null;
  legacy_inventory_object_count: number | null;
  legacy_inventory_at_ms: number | null;
  updated_at_ms: number;
}

interface CapacityControlRow {
  epoch: number;
  budget_version_snapshot: number;
  budget_bytes_snapshot: number;
  legacy_baseline_bytes_snapshot: number;
  reserved_bytes_snapshot: number;
  occupied_bytes_snapshot: number;
  state: string;
  last_audit_id: string | null;
  updated_at_ms: number;
}

function exactChanges(value: unknown): number {
  const result = value as { meta?: { changes?: number } } | undefined;
  return Number(result?.meta?.changes || 0);
}

function validHex64(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

async function loadBudget(db: D1Database): Promise<BudgetRow | null> {
  return db.prepare(`SELECT singleton_id,namespace,budget_bytes,legacy_baseline_bytes,
    reserved_bytes,version,state,legacy_inventory_digest,legacy_inventory_object_count,
    legacy_inventory_at_ms,updated_at_ms
    FROM publication_storage_budget WHERE singleton_id=1`).first<BudgetRow>();
}

async function loadControl(db: D1Database): Promise<CapacityControlRow | null> {
  return db.prepare(`SELECT epoch,budget_version_snapshot,budget_bytes_snapshot,
    legacy_baseline_bytes_snapshot,reserved_bytes_snapshot,occupied_bytes_snapshot,state,last_audit_id
    ,updated_at_ms
    FROM publication_capacity_warning_control WHERE singleton_id=1`).first<CapacityControlRow>();
}

export interface PublicationCapacityBudgetSnapshot {
  singleton_id: 1;
  namespace: 'daily-publications-v1';
  budget_bytes: number;
  legacy_baseline_bytes: number;
  reserved_bytes: number;
  version: number;
  state: 'uninitialized';
  legacy_inventory_digest: null;
  legacy_inventory_object_count: null;
  legacy_inventory_at_ms: null;
  updated_at_ms: number;
}

export interface ActivatePublicationCapacityBudgetInput {
  audit_id: string;
  legacy_baseline_bytes: number;
  inventory_digest: string;
  inventory_object_count: number;
  inventory_at_ms: number;
  actor: string;
  reason: string;
  ticket_ref: string;
  now_ms: number;
  old_budget_snapshot: PublicationCapacityBudgetSnapshot;
}

const ACTIVATION_AUDIT_ID_DOMAIN = 'aifeeds-publication-capacity-activation-request-v1\0';

function activationAuditIdentity(
  input: Omit<ActivatePublicationCapacityBudgetInput, 'audit_id'>,
): string {
  const old = input.old_budget_snapshot;
  return JSON.stringify([
    1,
    input.legacy_baseline_bytes,
    input.inventory_digest,
    input.inventory_object_count,
    input.inventory_at_ms,
    input.actor,
    input.reason,
    input.ticket_ref,
    input.now_ms,
    [
      old.singleton_id,
      old.namespace,
      old.budget_bytes,
      old.legacy_baseline_bytes,
      old.reserved_bytes,
      old.version,
      old.state,
      old.legacy_inventory_digest,
      old.legacy_inventory_object_count,
      old.legacy_inventory_at_ms,
      old.updated_at_ms,
    ],
  ]);
}

export async function derivePublicationCapacityActivationAuditId(
  input: Omit<ActivatePublicationCapacityBudgetInput, 'audit_id'>,
): Promise<string> {
  return sha256(`${ACTIVATION_AUDIT_ID_DOMAIN}${activationAuditIdentity(input)}`);
}

function validateAuditText(value: string, name: string): void {
  if (!value || byteLength(value) > 256) throw new Error(`PUBLICATION_CAPACITY_${name}_INVALID`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const ACTIVATION_SNAPSHOT_KEYS = [
  'budget_bytes',
  'legacy_baseline_bytes',
  'legacy_inventory_at_ms',
  'legacy_inventory_digest',
  'legacy_inventory_object_count',
  'namespace',
  'reserved_bytes',
  'singleton_id',
  'state',
  'updated_at_ms',
  'version',
] as const;

function validateActivationSnapshot(value: unknown): PublicationCapacityBudgetSnapshot {
  if (!isRecord(value)) throw new Error('PUBLICATION_CAPACITY_OLD_SNAPSHOT_INVALID');
  const keys = Object.keys(value).sort();
  if (keys.length !== ACTIVATION_SNAPSHOT_KEYS.length
    || keys.some((key, index) => key !== [...ACTIVATION_SNAPSHOT_KEYS].sort()[index])) {
    throw new Error('PUBLICATION_CAPACITY_OLD_SNAPSHOT_INVALID');
  }
  if (value.singleton_id !== 1 || value.namespace !== 'daily-publications-v1'
    || value.state !== 'uninitialized' || value.version !== 0
    || value.legacy_baseline_bytes !== 0 || value.reserved_bytes !== 0
    || value.legacy_inventory_digest !== null
    || value.legacy_inventory_object_count !== null
    || value.legacy_inventory_at_ms !== null) {
    throw new Error('PUBLICATION_CAPACITY_OLD_SNAPSHOT_INVALID');
  }
  safeInteger(value.budget_bytes, 'old_snapshot_budget_bytes', 1);
  safeInteger(value.updated_at_ms, 'old_snapshot_updated_at_ms');
  return value as unknown as PublicationCapacityBudgetSnapshot;
}

function sameBudgetSnapshot(
  budget: BudgetRow | null,
  snapshot: PublicationCapacityBudgetSnapshot,
): boolean {
  return budget?.singleton_id === snapshot.singleton_id
    && budget.namespace === snapshot.namespace
    && budget.budget_bytes === snapshot.budget_bytes
    && budget.legacy_baseline_bytes === snapshot.legacy_baseline_bytes
    && budget.reserved_bytes === snapshot.reserved_bytes
    && budget.version === snapshot.version
    && budget.state === snapshot.state
    && budget.legacy_inventory_digest === snapshot.legacy_inventory_digest
    && budget.legacy_inventory_object_count === snapshot.legacy_inventory_object_count
    && budget.legacy_inventory_at_ms === snapshot.legacy_inventory_at_ms
    && budget.updated_at_ms === snapshot.updated_at_ms;
}

interface ActivationAuditRow {
  action: string;
  old_budget_bytes: number;
  new_budget_bytes: number;
  old_occupied_bytes: number;
  new_occupied_bytes: number;
  inventory_digest: string | null;
  actor: string;
  reason: string;
  ticket_ref: string;
  created_at_ms: number;
}

async function exactActivation(
  db: D1Database,
  input: ActivatePublicationCapacityBudgetInput,
): Promise<CapacityControlRow | null> {
  const budget = await loadBudget(db);
  const control = await loadControl(db);
  const old = input.old_budget_snapshot;
  const audit = await db.prepare(`SELECT action,old_budget_bytes,new_budget_bytes,
      old_occupied_bytes,new_occupied_bytes,inventory_digest,actor,reason,ticket_ref,created_at_ms
    FROM publication_budget_audit WHERE audit_id=?`).bind(input.audit_id).first<ActivationAuditRow>();
  const oldOccupied = old.legacy_baseline_bytes + old.reserved_bytes;
  const newOccupied = input.legacy_baseline_bytes + old.reserved_bytes;
  const auditMatches = audit?.action === 'activate_inventory'
    && audit.old_budget_bytes === old.budget_bytes
    && audit.new_budget_bytes === old.budget_bytes
    && audit.old_occupied_bytes === oldOccupied
    && audit.new_occupied_bytes === newOccupied
    && audit.inventory_digest === input.inventory_digest
    && audit.actor === input.actor
    && audit.reason === input.reason
    && audit.ticket_ref === input.ticket_ref
    && audit.created_at_ms === input.now_ms;
  const occupied = (budget?.legacy_baseline_bytes ?? 0) + (budget?.reserved_bytes ?? 0);
  return budget?.singleton_id === old.singleton_id
    && budget.namespace === old.namespace
    && budget.state === 'active'
    && budget.budget_bytes === old.budget_bytes
    && budget.legacy_baseline_bytes === input.legacy_baseline_bytes
    && budget.reserved_bytes >= old.reserved_bytes
    && budget.version >= old.version + 1
    && budget.legacy_inventory_digest === input.inventory_digest
    && budget.legacy_inventory_object_count === input.inventory_object_count
    && budget.legacy_inventory_at_ms === input.inventory_at_ms
    && control?.state === 'active'
    && control.epoch === 1
    && control.last_audit_id === input.audit_id
    && control.budget_version_snapshot === budget.version
    && control.budget_bytes_snapshot === budget.budget_bytes
    && control.legacy_baseline_bytes_snapshot === budget.legacy_baseline_bytes
    && control.reserved_bytes_snapshot === budget.reserved_bytes
    && control.occupied_bytes_snapshot === occupied
    && control.updated_at_ms === budget.updated_at_ms
    && auditMatches ? control : null;
}

export async function activatePublicationCapacityBudget(
  env: Pick<Env, 'DB'>,
  input: ActivatePublicationCapacityBudgetInput,
): Promise<{ status: 'activated' | 'replayed'; epoch: number; budget_version: number }> {
  safeInteger(input.legacy_baseline_bytes, 'legacy_baseline_bytes');
  safeInteger(input.inventory_object_count, 'inventory_object_count');
  safeInteger(input.inventory_at_ms, 'inventory_at_ms');
  safeInteger(input.now_ms, 'now_ms');
  if (!validHex64(input.inventory_digest)) throw new Error('PUBLICATION_CAPACITY_INVENTORY_DIGEST_INVALID');
  for (const [name, value] of Object.entries({
    AUDIT_ID: input.audit_id, ACTOR: input.actor, REASON: input.reason, TICKET_REF: input.ticket_ref,
  })) validateAuditText(value, name);
  const old = validateActivationSnapshot(input.old_budget_snapshot);
  if (!validHex64(input.audit_id)
    || input.audit_id !== await derivePublicationCapacityActivationAuditId(input)) {
    throw new Error('PUBLICATION_CAPACITY_AUDIT_ID_INVALID');
  }
  const existing = await exactActivation(env.DB, input);
  if (existing) return { status: 'replayed', epoch: existing.epoch, budget_version: existing.budget_version_snapshot };
  const budget = await loadBudget(env.DB);
  if (!sameBudgetSnapshot(budget, old)
    || input.legacy_baseline_bytes + old.reserved_bytes > old.budget_bytes) {
    throw new Error('PUBLICATION_CAPACITY_ACTIVATION_STALE');
  }
  const audit = env.DB.prepare(`INSERT INTO publication_budget_audit(
    audit_id,action,old_budget_bytes,new_budget_bytes,old_occupied_bytes,new_occupied_bytes,
    inventory_digest,actor,reason,ticket_ref,created_at_ms
  ) SELECT ?,'activate_inventory',?,?,?,?,?,?,?,?,?
      FROM publication_storage_budget b
     WHERE b.singleton_id=? AND b.namespace=? AND b.budget_bytes=?
       AND b.legacy_baseline_bytes=? AND b.reserved_bytes=? AND b.version=? AND b.state=?
       AND b.legacy_inventory_digest IS ? AND b.legacy_inventory_object_count IS ?
       AND b.legacy_inventory_at_ms IS ? AND b.updated_at_ms=?`).bind(
    input.audit_id, old.budget_bytes, old.budget_bytes,
    old.legacy_baseline_bytes + old.reserved_bytes,
    input.legacy_baseline_bytes + old.reserved_bytes,
    input.inventory_digest, input.actor, input.reason, input.ticket_ref, input.now_ms,
    old.singleton_id, old.namespace, old.budget_bytes, old.legacy_baseline_bytes,
    old.reserved_bytes, old.version, old.state, old.legacy_inventory_digest,
    old.legacy_inventory_object_count, old.legacy_inventory_at_ms, old.updated_at_ms,
  );
  const update = env.DB.prepare(`UPDATE publication_storage_budget
    SET legacy_baseline_bytes=?,state='active',legacy_inventory_digest=?,
        legacy_inventory_object_count=?,legacy_inventory_at_ms=?,version=version+1,updated_at_ms=?
    WHERE singleton_id=? AND namespace=? AND budget_bytes=? AND legacy_baseline_bytes=?
      AND reserved_bytes=? AND version=? AND state=? AND legacy_inventory_digest IS ?
      AND legacy_inventory_object_count IS ? AND legacy_inventory_at_ms IS ? AND updated_at_ms=?`).bind(
    input.legacy_baseline_bytes, input.inventory_digest, input.inventory_object_count,
    input.inventory_at_ms, input.now_ms, old.singleton_id, old.namespace, old.budget_bytes,
    old.legacy_baseline_bytes, old.reserved_bytes, old.version, old.state,
    old.legacy_inventory_digest, old.legacy_inventory_object_count,
    old.legacy_inventory_at_ms, old.updated_at_ms,
  );
  try {
    const results = await env.DB.batch([audit, update]);
    if (exactChanges(results[0]) !== 1 || exactChanges(results[1]) !== 1) {
      throw new Error('PUBLICATION_CAPACITY_ACTIVATION_CAS_FAILED');
    }
  } catch (error) {
    const reconciled = await exactActivation(env.DB, input);
    if (reconciled) return {
      status: 'replayed', epoch: reconciled.epoch, budget_version: reconciled.budget_version_snapshot,
    };
    throw error;
  }
  const control = await exactActivation(env.DB, input);
  if (!control) throw new Error('PUBLICATION_CAPACITY_ACTIVATION_INCOMPLETE');
  return { status: 'activated', epoch: control.epoch, budget_version: control.budget_version_snapshot };
}

export interface IncreasePublicationCapacityBudgetInput {
  audit_id: string;
  new_budget_bytes: number;
  actor: string;
  reason: string;
  ticket_ref: string;
  now_ms: number;
}

async function exactIncrease(
  db: D1Database,
  input: IncreasePublicationCapacityBudgetInput,
): Promise<CapacityControlRow | null> {
  const budget = await loadBudget(db);
  const control = await loadControl(db);
  const audit = await db.prepare(`SELECT old_budget_bytes,new_budget_bytes,
      old_occupied_bytes,new_occupied_bytes,inventory_digest,actor,reason,ticket_ref,created_at_ms
    FROM publication_budget_audit
    WHERE audit_id=? AND action='increase_budget' AND new_budget_bytes=?
      AND actor=? AND reason=? AND ticket_ref=? AND created_at_ms=?
      AND inventory_digest IS NULL AND old_occupied_bytes=new_occupied_bytes
      AND new_budget_bytes>old_budget_bytes`).bind(
    input.audit_id, input.new_budget_bytes, input.actor, input.reason, input.ticket_ref, input.now_ms,
  ).first<{
    old_budget_bytes: number;
    new_budget_bytes: number;
    old_occupied_bytes: number;
    new_occupied_bytes: number;
    inventory_digest: null;
    actor: string;
    reason: string;
    ticket_ref: string;
    created_at_ms: number;
  }>();
  const occupied = (budget?.legacy_baseline_bytes || 0) + (budget?.reserved_bytes || 0);
  return budget?.state === 'active' && budget.budget_bytes === input.new_budget_bytes
    && control?.state === 'active' && control.last_audit_id === input.audit_id
    && control.budget_version_snapshot === budget.version
    && control.budget_bytes_snapshot === budget.budget_bytes
    && control.legacy_baseline_bytes_snapshot === budget.legacy_baseline_bytes
    && control.reserved_bytes_snapshot === budget.reserved_bytes
    && control.occupied_bytes_snapshot === occupied
    && audit !== null && audit !== undefined
    && occupied >= audit.new_occupied_bytes
    ? control : null;
}

export async function increasePublicationCapacityBudget(
  env: Pick<Env, 'DB'>,
  input: IncreasePublicationCapacityBudgetInput,
): Promise<{ status: 'increased' | 'replayed'; epoch: number; budget_version: number }> {
  safeInteger(input.new_budget_bytes, 'new_budget_bytes', 1);
  safeInteger(input.now_ms, 'now_ms');
  for (const [name, value] of Object.entries({
    AUDIT_ID: input.audit_id, ACTOR: input.actor, REASON: input.reason, TICKET_REF: input.ticket_ref,
  })) validateAuditText(value, name);
  const existing = await exactIncrease(env.DB, input);
  if (existing) return { status: 'replayed', epoch: existing.epoch, budget_version: existing.budget_version_snapshot };
  const budget = await loadBudget(env.DB);
  if (!budget || budget.state !== 'active' || input.new_budget_bytes <= budget.budget_bytes) {
    throw new Error('PUBLICATION_CAPACITY_INCREASE_STALE');
  }
  const occupied = budget.legacy_baseline_bytes + budget.reserved_bytes;
  const audit = env.DB.prepare(`INSERT INTO publication_budget_audit(
    audit_id,action,old_budget_bytes,new_budget_bytes,old_occupied_bytes,new_occupied_bytes,
    inventory_digest,actor,reason,ticket_ref,created_at_ms
  ) VALUES(?,'increase_budget',?,?,?,?,NULL,?,?,?,?)`).bind(
    input.audit_id, budget.budget_bytes, input.new_budget_bytes, occupied, occupied,
    input.actor, input.reason, input.ticket_ref, input.now_ms,
  );
  const update = env.DB.prepare(`UPDATE publication_storage_budget
    SET budget_bytes=?,version=version+1,updated_at_ms=?
    WHERE singleton_id=1 AND state='active' AND version=? AND budget_bytes=?`).bind(
    input.new_budget_bytes, input.now_ms, budget.version, budget.budget_bytes,
  );
  try {
    const results = await env.DB.batch([audit, update]);
    if (exactChanges(results[0]) !== 1 || exactChanges(results[1]) !== 1) {
      throw new Error('PUBLICATION_CAPACITY_INCREASE_CAS_FAILED');
    }
  } catch (error) {
    const reconciled = await exactIncrease(env.DB, input);
    if (reconciled) return {
      status: 'replayed', epoch: reconciled.epoch, budget_version: reconciled.budget_version_snapshot,
    };
    throw error;
  }
  const control = await exactIncrease(env.DB, input);
  if (!control) throw new Error('PUBLICATION_CAPACITY_INCREASE_INCOMPLETE');
  return { status: 'increased', epoch: control.epoch, budget_version: control.budget_version_snapshot };
}

interface CrossingRow extends PublicationCapacityCrossing {
  materialization_state: 'pending' | 'materialized' | 'quarantined';
  materialized_event_id: string | null;
}

export interface ProducePublicationCapacityWarningsResult {
  contract_version: 1;
  action: 'publication-capacity-warning-produce';
  status: 'disabled' | 'ok' | 'partial' | 'error';
  gate_state: 'missing' | 'disabled' | 'enabled';
  table_state: 'not_checked' | 'ready' | 'error';
  error_code: string | null;
  crossings_found: number;
  materialized: number;
  duplicates: number;
  quarantined: number;
  integrity_errors: number;
  enqueue_failures: number;
  conflicts: number;
  cap_reached: boolean;
  oldest_crossing_age: number | null;
}

function emptyProducer(gate: string | undefined): ProducePublicationCapacityWarningsResult {
  const enabled = gate === '1';
  return {
    contract_version: 1, action: 'publication-capacity-warning-produce',
    status: enabled ? 'ok' : 'disabled',
    gate_state: gate === undefined ? 'missing' : enabled ? 'enabled' : 'disabled',
    table_state: enabled ? 'ready' : 'not_checked', error_code: null,
    crossings_found: 0, materialized: 0, duplicates: 0, quarantined: 0,
    integrity_errors: 0, enqueue_failures: 0, conflicts: 0,
    cap_reached: false, oldest_crossing_age: null,
  };
}

async function exactMaterialization(
  db: D1Database,
  event: BuiltPublicationCapacityWarningEvent,
): Promise<'materialized' | 'quarantined' | null> {
  const row = await db.prepare(`SELECT c.materialization_state
    FROM publication_capacity_threshold_crossings c
    JOIN publication_capacity_warning_outbox o ON o.event_id=c.materialized_event_id
    WHERE c.namespace=? AND c.epoch=? AND c.threshold_bps=?
      AND c.materialized_event_id=?
      AND ((c.materialization_state='materialized' AND o.record_kind='deliverable'
        AND o.schema_version=1 AND o.event_type=? AND o.namespace=? AND o.epoch=?
        AND o.threshold_bps=? AND o.crossed_at_ms=? AND o.payload_json=? AND o.payload_sha256=?)
       OR (c.materialization_state='quarantined' AND c.last_error_code GLOB 'CAPACITY_PRODUCER_*'))`).bind(
    event.namespace, event.epoch, event.threshold_bps, event.event_id,
    event.event_type, event.namespace, event.epoch, event.threshold_bps,
    event.crossed_at_ms, event.payload_json, event.payload_sha256,
  ).first<{ materialization_state: 'materialized' | 'quarantined' }>();
  return row?.materialization_state || null;
}

async function quarantineCrossing(
  db: D1Database,
  crossing: CrossingRow,
  eventId: string,
  nowMs: number,
  code: string,
): Promise<boolean> {
  try {
    await db.prepare(`INSERT INTO publication_capacity_warning_outbox(
      event_id,schema_version,event_type,namespace,epoch,threshold_bps,crossed_at_ms,
      record_kind,payload_json,payload_sha256,state,attempts,next_retry_at_ms,lease_owner,
      lease_until_ms,created_at_ms,updated_at_ms,delivered_at_ms,failed_at_ms,expires_at_ms,
      last_error_code,last_error_detail
    ) VALUES(?,1,'publication_capacity_threshold_crossed',?,?,?,?,'quarantine',NULL,NULL,
      'failed',0,NULL,NULL,NULL,?,?,NULL,?,?,?,?)
    ON CONFLICT(namespace,epoch,threshold_bps) DO NOTHING`).bind(
      eventId, crossing.namespace, crossing.epoch, crossing.threshold_bps, crossing.crossed_at_ms,
      nowMs, nowMs, nowMs, nowMs + CAPACITY_TERMINAL_RETENTION_MS, code, code,
    ).run();
  } catch {
    // The crossing remains the permanent integrity observation if the conflicting row owns the identity.
  }
  const update = await db.prepare(`UPDATE publication_capacity_threshold_crossings
    SET materialization_state='quarantined',materialized_event_id=?,materialized_at_ms=?,
        last_error_code=?,updated_at_ms=?
    WHERE namespace=? AND epoch=? AND threshold_bps=? AND materialization_state='pending'`).bind(
    eventId, nowMs, code, nowMs, crossing.namespace, crossing.epoch, crossing.threshold_bps,
  ).run();
  return exactChanges(update) === 1;
}

export async function producePublicationCapacityWarnings(
  env: Pick<Env, 'DB'> & { PUBLICATION_CAPACITY_WARNING_PRODUCER_ENABLED?: string },
  options: { nowMs?: number; limit?: number } = {},
): Promise<ProducePublicationCapacityWarningsResult> {
  const result = emptyProducer(env.PUBLICATION_CAPACITY_WARNING_PRODUCER_ENABLED);
  if (result.gate_state !== 'enabled') return result;
  const nowMs = options.nowMs ?? Date.now();
  const limit = Math.max(1, Math.min(100, options.limit ?? 50));
  let rows: CrossingRow[];
  try {
    const found = await env.DB.prepare(`SELECT namespace,epoch,threshold_bps,budget_version,budget_bytes,
      legacy_baseline_bytes,reserved_bytes,occupied_bytes,crossed_at_ms,
      materialization_state,materialized_event_id
      FROM publication_capacity_threshold_crossings
      WHERE materialization_state='pending'
      ORDER BY crossed_at_ms ASC,epoch ASC,threshold_bps ASC LIMIT ?`).bind(limit + 1).all<CrossingRow>();
    rows = (found.results || []).slice(0, limit);
    result.cap_reached = (found.results || []).length === limit + 1;
  } catch (error) {
    result.status = 'error';
    result.table_state = 'error';
    result.error_code = 'CAPACITY_PRODUCER_TABLE_ERROR';
    console.error('[publication-capacity] producer query failed:', error);
    return result;
  }
  result.crossings_found = rows.length;
  if (rows.length) {
    result.oldest_crossing_age = Math.max(0, Math.floor((nowMs - rows[0].crossed_at_ms) / 1000));
  }
  for (const crossing of rows) {
    let event: BuiltPublicationCapacityWarningEvent;
    let eventId: string;
    try {
      eventId = await sha256(capacityIdentity(crossing));
      event = await buildPublicationCapacityWarningEvent(crossing);
    } catch (error) {
      eventId = await sha256(capacityIdentity(crossing));
      result.integrity_errors++;
      if (await quarantineCrossing(
        env.DB, crossing, eventId, nowMs, 'CAPACITY_PRODUCER_CROSSING_INTEGRITY',
      )) result.quarantined++;
      else result.conflicts++;
      continue;
    }
    const insert = env.DB.prepare(`INSERT INTO publication_capacity_warning_outbox(
      event_id,schema_version,event_type,namespace,epoch,threshold_bps,crossed_at_ms,
      record_kind,payload_json,payload_sha256,state,attempts,next_retry_at_ms,
      created_at_ms,updated_at_ms
    ) VALUES(?,?,?,?,?,?,?,'deliverable',?,?,'pending',0,?,?,?)
    ON CONFLICT(namespace,epoch,threshold_bps) DO NOTHING`).bind(
      event.event_id, 1, event.event_type, event.namespace, event.epoch,
      event.threshold_bps, event.crossed_at_ms, event.payload_json, event.payload_sha256,
      nowMs, nowMs, nowMs,
    );
    const bindCrossing = env.DB.prepare(`UPDATE publication_capacity_threshold_crossings
      SET materialization_state='materialized',materialized_event_id=?,materialized_at_ms=?,
          last_error_code=NULL,updated_at_ms=?
      WHERE namespace=? AND epoch=? AND threshold_bps=? AND materialization_state='pending'
        AND EXISTS (SELECT 1 FROM publication_capacity_warning_outbox o
          WHERE o.event_id=? AND o.schema_version=1 AND o.event_type=? AND o.namespace=?
            AND o.epoch=? AND o.threshold_bps=? AND o.crossed_at_ms=?
            AND o.record_kind='deliverable' AND o.payload_json=? AND o.payload_sha256=?)`).bind(
      event.event_id, nowMs, nowMs, event.namespace, event.epoch, event.threshold_bps,
      event.event_id, event.event_type, event.namespace, event.epoch, event.threshold_bps,
      event.crossed_at_ms, event.payload_json, event.payload_sha256,
    );
    try {
      const batch = await env.DB.batch([insert, bindCrossing]);
      const bound = exactChanges(batch[1]);
      if (bound === 1) result.materialized++;
      else {
        const authoritative = await exactMaterialization(env.DB, event);
        if (authoritative === 'materialized') result.duplicates++;
        else if (authoritative === 'quarantined') result.quarantined++;
        else {
          result.integrity_errors++;
          if (await quarantineCrossing(
            env.DB, crossing, event.event_id, nowMs, 'CAPACITY_PRODUCER_DUPLICATE_INTEGRITY',
          )) result.quarantined++;
          else result.conflicts++;
        }
      }
    } catch (error) {
      const authoritative = await exactMaterialization(env.DB, event);
      if (authoritative === 'materialized') result.materialized++;
      else if (authoritative === 'quarantined') result.quarantined++;
      else {
        const duplicate = await env.DB.prepare(`SELECT 1 ok FROM publication_capacity_warning_outbox
          WHERE namespace=? AND epoch=? AND threshold_bps=?`).bind(
          event.namespace, event.epoch, event.threshold_bps,
        ).first<{ ok: number }>();
        if (duplicate) {
          result.integrity_errors++;
          if (await quarantineCrossing(
            env.DB, crossing, event.event_id, nowMs, 'CAPACITY_PRODUCER_DUPLICATE_INTEGRITY',
          )) result.quarantined++;
          else result.conflicts++;
        } else {
          result.enqueue_failures++;
          console.error('[publication-capacity] producer batch failed:', error);
        }
      }
    }
  }
  if (result.integrity_errors || result.enqueue_failures || result.conflicts) result.status = 'partial';
  return result;
}

function boundedObservation(value: unknown, key = ''): unknown {
  if (/id|payload|secret|token|detail/i.test(key)) return undefined;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  if (typeof value === 'string') return value.slice(0, 64);
  if (Array.isArray(value)) return { count: value.length };
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const childKey of Object.keys(value as Record<string, unknown>).sort()) {
      const bounded = boundedObservation((value as Record<string, unknown>)[childKey], childKey);
      if (bounded !== undefined) output[childKey] = bounded;
    }
    return output;
  }
  return null;
}

export async function serializePublicationCapacityCronObservation(value: unknown): Promise<string> {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const normalized = boundedObservation(source) as Record<string, unknown>;
  const json = JSON.stringify(normalized);
  if (byteLength(json) <= PUBLICATION_CAPACITY_CRON_RESULT_MAX_BYTES) return json;
  return JSON.stringify({
    action: typeof source.action === 'string' ? source.action.slice(0, 64) : 'publication-capacity-warning',
    contract_version: 1,
    error_code: 'CAPACITY_CRON_RESULT_OVERSIZE',
    status: 'error',
  });
}

interface PublicationCapacityOutboxRow extends ReliableOutboxRow {
  schema_version: 1;
  event_type: 'publication_capacity_threshold_crossed';
  namespace: 'daily-publications-v1';
  epoch: number;
  threshold_bps: CapacityThreshold;
  crossed_at_ms: number;
  payload_json: string;
  payload_sha256: string;
}

const CAPACITY_PAYLOAD_KEYS = [
  'budget_bytes', 'budget_version', 'crossed_at_ms', 'epoch', 'event_type',
  'legacy_baseline_bytes', 'namespace', 'occupied_bytes', 'reserved_bytes',
  'schema_version', 'threshold_bps',
] as const;

async function validatePublicationCapacityOutboxRow(
  row: PublicationCapacityOutboxRow,
): Promise<{ ok: true } | { ok: false; code: string; detail: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload_json);
  } catch (error) {
    return { ok: false, code: 'CAPACITY_OUTBOX_CORRUPT_JSON', detail: String(error) };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, code: 'CAPACITY_OUTBOX_CORRUPT_SCHEMA', detail: 'payload_not_object' };
  }
  const value = parsed as Record<string, unknown>;
  if (Object.keys(value).sort().join(',') !== [...CAPACITY_PAYLOAD_KEYS].sort().join(',')) {
    return { ok: false, code: 'CAPACITY_OUTBOX_CORRUPT_SCHEMA', detail: 'payload_keys' };
  }
  const crossing = {
    namespace: value.namespace,
    epoch: value.epoch,
    threshold_bps: value.threshold_bps,
    budget_version: value.budget_version,
    budget_bytes: value.budget_bytes,
    legacy_baseline_bytes: value.legacy_baseline_bytes,
    reserved_bytes: value.reserved_bytes,
    occupied_bytes: value.occupied_bytes,
    crossed_at_ms: value.crossed_at_ms,
  } as PublicationCapacityCrossing;
  let expected: BuiltPublicationCapacityWarningEvent;
  try {
    if (value.schema_version !== 1 || value.event_type !== 'publication_capacity_threshold_crossed') {
      throw new Error('schema_or_event_type');
    }
    expected = await buildPublicationCapacityWarningEvent(crossing);
  } catch (error) {
    return { ok: false, code: 'CAPACITY_OUTBOX_CORRUPT_SCHEMA', detail: String(error) };
  }
  if (byteLength(row.payload_json) > PUBLICATION_CAPACITY_PAYLOAD_MAX_BYTES
    || expected.payload_json !== row.payload_json) {
    return { ok: false, code: 'CAPACITY_OUTBOX_CORRUPT_CANONICAL', detail: 'payload_not_canonical' };
  }
  if (expected.payload_sha256 !== row.payload_sha256) {
    return { ok: false, code: 'CAPACITY_OUTBOX_CORRUPT_HASH', detail: 'payload_hash' };
  }
  if (expected.event_id !== row.event_id) {
    return { ok: false, code: 'CAPACITY_OUTBOX_CORRUPT_EVENT_ID', detail: 'event_id' };
  }
  if (row.schema_version !== 1 || row.event_type !== expected.event_type
    || row.namespace !== expected.namespace || Number(row.epoch) !== expected.epoch
    || Number(row.threshold_bps) !== expected.threshold_bps
    || Number(row.crossed_at_ms) !== expected.crossed_at_ms) {
    return { ok: false, code: 'CAPACITY_OUTBOX_CORRUPT_COLUMNS', detail: 'payload_columns' };
  }
  return { ok: true };
}

function renderPublicationCapacityChunks(
  rows: readonly PublicationCapacityOutboxRow[],
): Array<{ rows: PublicationCapacityOutboxRow[]; title: string; body: string }> {
  const ordered = [...rows].sort((left, right) => (
    left.attempts - right.attempts
    || left.epoch - right.epoch
    || left.threshold_bps - right.threshold_bps
    || left.event_id.localeCompare(right.event_id)
  ));
  const chunks: Array<{ rows: PublicationCapacityOutboxRow[]; title: string; body: string }> = [];
  let current: PublicationCapacityOutboxRow[] = [];
  let lines = ['Append-only daily publication storage crossed an audited capacity threshold.', ''];
  let attemptBucket: number | null = null;
  const flush = () => {
    if (!current.length) return;
    chunks.push({
      rows: current,
      title: 'aifeeds容量告警 | publication storage',
      body: lines.join('\n'),
    });
    current = [];
    lines = ['Append-only daily publication storage crossed an audited capacity threshold.', ''];
  };
  for (const row of ordered) {
    if (attemptBucket !== null && attemptBucket !== row.attempts) flush();
    attemptBucket = row.attempts;
    const payload = JSON.parse(row.payload_json) as Record<string, number>;
    const line = `- epoch ${row.epoch} / ${row.threshold_bps / 100}% / `
      + `${payload.occupied_bytes} of ${payload.budget_bytes} bytes / event ${row.event_id.slice(0, 12)}`;
    const candidate = [...lines, line].join('\n');
    if (current.length >= 25 || byteLength(candidate) > 16_384) flush();
    current.push(row);
    lines.push(line);
  }
  flush();
  return chunks;
}

export type DrainPublicationCapacityWarningOutboxResult = ReliableOutboxDrainResult<
  'publication-capacity-warning-drain'
>;

export async function drainPublicationCapacityWarningOutbox(
  env: Pick<Env, 'DB' | 'PUSHDEER_ADMIN_KEYS'> & {
    PUBLICATION_CAPACITY_WARNING_DRAIN_ENABLED?: string;
  },
  options: {
    nowMs?: number;
    owner?: string;
    send?: (title: string, body: string) => Promise<PushDeerSendResult>;
  } = {},
): Promise<DrainPublicationCapacityWarningOutboxResult> {
  return drainReliableOutbox<
    PublicationCapacityOutboxRow,
    'publication-capacity-warning-drain'
  >({
    db: env.DB,
    table: 'publication_capacity_warning_outbox',
    action: 'publication-capacity-warning-drain',
    gate: env.PUBLICATION_CAPACITY_WARNING_DRAIN_ENABLED,
    nowMs: options.nowMs ?? Date.now(),
    owner: options.owner || crypto.randomUUID(),
    validate: validatePublicationCapacityOutboxRow,
    renderChunks: renderPublicationCapacityChunks,
    send: options.send || ((title, body) => pushDeerMessage(env as Env, title, body)),
    logLabel: 'publication-capacity-outbox',
  });
}

export type RetainPublicationCapacityWarningOutboxResult = ReliableOutboxRetentionResult<
  'publication-capacity-warning-retention'
>;

export async function retainPublicationCapacityWarningOutbox(
  env: Pick<Env, 'DB'> & { PUBLICATION_CAPACITY_WARNING_DRAIN_ENABLED?: string },
  nowMs = Date.now(),
): Promise<RetainPublicationCapacityWarningOutboxResult> {
  return retainReliableOutbox({
    db: env.DB,
    table: 'publication_capacity_warning_outbox',
    action: 'publication-capacity-warning-retention',
    gate: env.PUBLICATION_CAPACITY_WARNING_DRAIN_ENABLED,
    nowMs,
    logLabel: 'publication-capacity-outbox',
  });
}
