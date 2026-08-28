import type { Env } from '../index';
import { FEED_REGISTRY } from '../feeds/registry';
import type { EditorialType, FeedDef } from '../feeds/types';
import {
  loadVerifiedManualCandidateProof,
  type PersistedManualVerificationRow,
} from './manual-news-leads-verification';
import {
  MANUAL_LEAD_VERIFICATION_POLICY_VERSION,
  MANUAL_NEWS_SOURCE_SUPPORT_POLICY,
} from './manual-news-leads';

const LEGACY_RADAR_KEY = 'weibo-hot-tech';
const LEGACY_RADAR_FEED_ID = `blog:${LEGACY_RADAR_KEY}`;
const EDITORIAL_TYPES = new Set<EditorialType>([
  'official', 'third-party-media', 'independent', 'radar',
]);

export interface NewsItemIdentity {
  id: string;
  sourceId?: string | null;
  sourceRef?: string | null;
  extra?: string | null | Record<string, unknown>;
}

export type FormalNewsDecisionCode =
  | 'ALLOW_SCHEDULED_FORMAL'
  | 'ALLOW_VERIFIED_MANUAL'
  | 'DENY_MISSING_ITEM'
  | 'DENY_DELETED_ITEM'
  | 'DENY_MALFORMED_ITEM_IDENTITY'
  | 'DENY_EXPLICIT_ITEM_RADAR'
  | 'DENY_UNVERIFIED_MANUAL'
  | 'DENY_MANUAL_IDENTITY_MISMATCH'
  | 'DENY_NO_REGISTRY_SOURCE'
  | 'DENY_NO_SOURCE_ROW'
  | 'DENY_SOURCE_DISABLED'
  | 'DENY_SOURCE_RADAR'
  | 'DENY_SOURCE_MISMATCH'
  | 'DENY_LEGACY_RADAR_ITEM_ID'
  | 'DENY_LEGACY_RADAR_SOURCE_ID'
  | 'DENY_LEGACY_RADAR_SOURCE_REF'
  | 'DENY_LEGACY_RADAR_FEED_ID'
  | 'DENY_LEGACY_RADAR_FEED_KEY'
  | 'DENY_ITEM_SOURCE_MISMATCH'
  | 'DENY_AUTHORIZATION_STALE';

export interface FormalNewsDecision {
  item_id: string;
  allowed: boolean;
  code: FormalNewsDecisionCode;
  lead_id?: string;
  verification_id?: string;
  /** Exact early/final snapshot binding; never accepted as an authority by itself. */
  guard_fingerprint?: string;
  /** Internal immutable expectation consumed only by the canonical SQL guard. */
  guard_snapshot?: FormalNewsGuardExpected;
}

export interface FormalNewsAuthorizationResult {
  allowed_ids: string[];
  decisions: FormalNewsDecision[];
  final_guard?: FormalNewsFinalGuardContract;
}

export interface FormalNewsFinalGuardContract {
  registry_json: string;
  expected_json: string;
  review_date: string;
}

export interface FormalNewsGuardExpected {
  requested_index: number;
  item_id: string;
  kind: 'scheduled' | 'manual';
  item: {
    id: string;
    source_type: string;
    source_id: string | null;
    source_ref: string | null;
    extra: string;
    deleted_at: string | null;
  };
  registry?: RegistryDescriptor;
  source?: SourceRow;
  lead?: ManualLeadAuthorizationRow;
  verification?: PersistedManualVerificationRow;
}

interface ItemRow {
  requested_index: number;
  requested_id: string;
  id: string | null;
  source_type: string | null;
  source_id: string | null;
  source_ref: string | null;
  extra: string | null;
  deleted_at: string | null;
}

interface SourceRow {
  id: string;
  source_type: string;
  source_ref: string | null;
  config: string | null;
}

interface AuthorizationRow extends ItemRow {
  registry_id: string | null;
  backing_source_id: string | null;
  backing_source_type: string | null;
  backing_source_ref: string | null;
  backing_source_config: string | null;
}

interface RegistryDescriptor {
  editorial_type: EditorialType;
  enabled: boolean;
  id: string;
  key: string;
  kind: 'blog' | 'podcast';
}

function strictObject(value: unknown): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { ok: true, value: value as Record<string, unknown> };
  }
  if (typeof value !== 'string' || !value.trim()) return { ok: false };
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { ok: true, value: parsed as Record<string, unknown> }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}

function parseExtraForDeny(value: NewsItemIdentity['extra']): Record<string, unknown> {
  const parsed = strictObject(value);
  return parsed.ok ? parsed.value : {};
}

function hasMalformedItemIdentity(extra: Record<string, unknown>): boolean {
  for (const key of ['feed_id', 'feed_key', 'show_key'] as const) {
    if (Object.prototype.hasOwnProperty.call(extra, key) && typeof extra[key] !== 'string') return true;
  }
  return Object.prototype.hasOwnProperty.call(extra, 'editorial_type')
    && !EDITORIAL_TYPES.has(extra.editorial_type as EditorialType);
}

function descriptorFromFeed(feed: FeedDef): RegistryDescriptor {
  if (!/^[a-z0-9-]+$/.test(feed.key)
    || feed.id !== `${feed.kind}:${feed.key}`
    || !EDITORIAL_TYPES.has(feed.editorial_type)) {
    throw new Error(`invalid_feed_registry_descriptor:${feed.id}`);
  }
  return {
    editorial_type: feed.editorial_type,
    enabled: feed.enabled !== false,
    id: feed.id.normalize('NFC'),
    key: feed.key.normalize('NFC'),
    kind: feed.kind,
  };
}

function registryDescriptors(): RegistryDescriptor[] {
  const rows = FEED_REGISTRY.map(descriptorFromFeed)
    .sort((a, b) => a.id.localeCompare(b.id));
  const identities = new Set<string>();
  for (const row of rows) {
    const identity = `${row.id}\0${row.kind}\0${row.key}`;
    if (identities.has(identity)) throw new Error(`duplicate_feed_registry_descriptor:${row.id}`);
    identities.add(identity);
  }
  return rows;
}

export function buildFormalNewsRegistryJson(): string {
  return JSON.stringify(registryDescriptors());
}

function formalNewsRegistryCte(registryJsonExpression: string): string {
  return `registry AS (
  SELECT
    json_extract(value, '$.id') AS id,
    json_extract(value, '$.key') AS key,
    json_extract(value, '$.kind') AS kind,
    json_extract(value, '$.editorial_type') AS editorial_type,
    CASE json_extract(value, '$.enabled') WHEN 1 THEN 1 ELSE 0 END AS enabled
  FROM json_each(${registryJsonExpression})
  WHERE type = 'object'
)`;
}

export const FORMAL_NEWS_REGISTRY_CTE = formalNewsRegistryCte('?');

/** Highest-priority item-side radar/legacy deny signals. */
export function isRadarNewsItemIdentity(item: NewsItemIdentity): boolean {
  const extra = parseExtraForDeny(item.extra);
  if (extra.editorial_type === 'radar') return true;
  if (item.id.startsWith(`${LEGACY_RADAR_FEED_ID}:`)) return true;
  if (item.sourceId === LEGACY_RADAR_KEY || item.sourceId?.startsWith(`${LEGACY_RADAR_KEY}:`)) return true;
  if (item.sourceRef === LEGACY_RADAR_KEY) return true;
  if (extra.feed_id === LEGACY_RADAR_FEED_ID) return true;
  if (extra.feed_key === LEGACY_RADAR_KEY) return true;
  return false;
}

/** Legacy deny only. Positive authorization requires the canonical runtime/registry join. */
export function formalNewsItemSqlPredicate(alias = ''): string {
  const column = (name: string) => `${alias ? `${alias}.` : ''}${name}`;
  const extra = `CASE WHEN ${column('extra')} IS NOT NULL AND json_valid(${column('extra')})=1 THEN ${column('extra')} ELSE '{}' END`;
  return `(
    COALESCE(json_extract(${extra}, '$.editorial_type'), '') <> 'radar'
    AND ${column('id')} NOT LIKE 'blog:weibo-hot-tech:%'
    AND COALESCE(${column('source_id')}, '') <> 'weibo-hot-tech'
    AND COALESCE(${column('source_id')}, '') NOT LIKE 'weibo-hot-tech:%'
    AND COALESCE(${column('source_ref')}, '') <> 'weibo-hot-tech'
    AND COALESCE(json_extract(${extra}, '$.feed_id'), '') <> 'blog:weibo-hot-tech'
    AND COALESCE(json_extract(${extra}, '$.feed_key'), '') <> 'weibo-hot-tech'
  )`;
}

/** Positive scheduled provenance predicate; aliases are compile-time constants. */
export function formalNewsScheduledSqlPredicate(
  itemAlias = 'i',
  registryAlias = 'r',
  sourceAlias = 's',
): string {
  const item = (column: string) => `${itemAlias}.${column}`;
  const registry = (column: string) => `${registryAlias}.${column}`;
  const source = (column: string) => `${sourceAlias}.${column}`;
  const itemExtra = `CASE WHEN ${item('extra')} IS NOT NULL AND json_valid(${item('extra')})=1 THEN ${item('extra')} ELSE '{}' END`;
  const sourceConfig = `CASE WHEN ${source('config')} IS NOT NULL AND json_valid(${source('config')})=1 THEN ${source('config')} ELSE '{}' END`;
  const itemEditorialType = `json_extract(${itemExtra}, '$.editorial_type')`;
  const sourceEnabledType = `json_type(${sourceConfig}, '$.enabled')`;
  const sourceEnabled = `json_extract(${sourceConfig}, '$.enabled')`;
  return `(
    ${item('deleted_at')} IS NULL
    AND ${item('source_ref')} IS NULL
    AND ${item('extra')} IS NOT NULL
    AND json_valid(${item('extra')})=1
    AND json_type(${itemExtra})='object'
    AND json_extract(${itemExtra}, '$.feed_id')=${registry('id')}
    AND ${registry('enabled')}=1
    AND ${registry('editorial_type')}<>'radar'
    AND ${source('id')}=${registry('id')}
    AND ${source('source_type')}=${registry('kind')}
    AND ${source('source_ref')}=${registry('key')}
    AND ${source('config')} IS NOT NULL
    AND json_valid(${source('config')})=1
    AND json_type(${sourceConfig})='object'
    AND json_extract(${sourceConfig}, '$.id')=${registry('id')}
    AND json_extract(${sourceConfig}, '$.key')=${registry('key')}
    AND json_extract(${sourceConfig}, '$.kind')=${registry('kind')}
    AND json_extract(${sourceConfig}, '$.editorial_type')=${registry('editorial_type')}
    AND json_extract(${sourceConfig}, '$.editorial_type')<>'radar'
    AND (${sourceEnabledType} IS NULL OR (${sourceEnabledType} IN ('true','false') AND ${sourceEnabled}=1))
    AND (json_type(${itemExtra}, '$.editorial_type') IS NULL OR ${itemEditorialType}=${registry('editorial_type')})
    AND COALESCE(${itemEditorialType}, '')<>'radar'
    AND ${formalNewsItemSqlPredicate(itemAlias)}
    AND (
      (${registry('kind')}='blog'
        AND ${item('source_type')}='blog'
        AND ${item('source_id')} LIKE ${registry('key')} || ':%'
        AND length(${item('source_id')})>length(${registry('key')})+1
        AND ${item('id')}='blog:' || ${item('source_id')}
        AND json_extract(${itemExtra}, '$.feed_key')=${registry('key')})
      OR
      (${registry('kind')}='podcast'
        AND ${item('source_id')} LIKE ${registry('key')} || ':%'
        AND length(${item('source_id')})>length(${registry('key')})+1
        AND ${item('id')}='podcast:' || ${item('source_id')}
        AND (
          (${item('source_type')}='podcast' AND json_extract(${itemExtra}, '$.show_key')=${registry('key')})
          OR (${item('source_type')}='blog' AND json_extract(${itemExtra}, '$.feed_key')=${registry('key')})
        ))
    )
  )`;
}

function deny(itemId: string, code: Exclude<FormalNewsDecisionCode, 'ALLOW_SCHEDULED_FORMAL' | 'ALLOW_VERIFIED_MANUAL'>): FormalNewsDecision {
  return { item_id: itemId, allowed: false, code };
}

function allowScheduled(
  itemId: string,
  guardSnapshot: FormalNewsGuardExpected,
): FormalNewsDecision {
  return {
    item_id: itemId,
    allowed: true,
    code: 'ALLOW_SCHEDULED_FORMAL',
    guard_fingerprint: JSON.stringify(guardSnapshot),
    guard_snapshot: guardSnapshot,
  };
}

function manualLooking(row: ItemRow, extra: Record<string, unknown>): boolean {
  return row.requested_id.startsWith('blog:manual:')
    || row.requested_id.startsWith('manual-news:')
    || row.source_ref === 'manual_lead'
    || Object.prototype.hasOwnProperty.call(extra, 'manual_lead');
}

interface ManualLeadAuthorizationRow {
  id: string;
  review_date: string;
  status: string;
  confirmed_at: number | null;
  version: number;
}

function itemFingerprint(row: ItemRow): readonly unknown[] {
  return [row.id, row.source_type, row.source_id, row.source_ref, row.extra, row.deleted_at];
}

function manualGuardFingerprint(
  row: ItemRow,
  lead: ManualLeadAuthorizationRow,
  verification: PersistedManualVerificationRow,
): string {
  return JSON.stringify({
    item: itemFingerprint(row),
    lead: [lead.id, lead.review_date, lead.status, lead.confirmed_at, lead.version],
    verification: [
      verification.verification_id,
      verification.lead_id,
      verification.assessment_version,
      verification.policy_version,
      verification.verification_key_id,
      verification.canonical_digest,
      verification.hmac_sha256,
      verification.processing_owner,
      verification.processing_attempt,
      verification.creation_nonce,
      verification.status,
      verification.invalidation_nonce ?? null,
      verification.invalidated_at,
    ],
  });
}

function itemGuardSnapshot(row: ItemRow): FormalNewsGuardExpected['item'] {
  return {
    id: row.id || '',
    source_type: row.source_type || '',
    source_id: row.source_id,
    source_ref: row.source_ref,
    extra: row.extra || '',
    deleted_at: row.deleted_at,
  };
}

async function authorizeManualItem(
  env: Env,
  reviewDate: string,
  row: ItemRow,
  extra: Record<string, unknown>,
): Promise<FormalNewsDecision> {
  const itemPrefix = 'blog:manual:';
  const leadId = row.requested_id.startsWith(itemPrefix)
    ? row.requested_id.slice(itemPrefix.length)
    : '';
  const manualIdentity = extra.manual_lead;
  if (!leadId
    || row.source_type !== 'blog'
    || row.source_id !== `manual:${leadId}`
    || row.source_ref !== 'manual_lead'
    || !manualIdentity
    || typeof manualIdentity !== 'object'
    || Array.isArray(manualIdentity)
    || (manualIdentity as Record<string, unknown>).lead_id !== leadId
    || !Array.isArray((manualIdentity as Record<string, unknown>).evidence_ids)) {
    return deny(row.requested_id, 'DENY_MANUAL_IDENTITY_MISMATCH');
  }
  const lead = await env.DB.prepare(
    `SELECT id, review_date, status, confirmed_at, version
       FROM manual_news_leads WHERE id = ?`,
  ).bind(leadId).first<ManualLeadAuthorizationRow>();
  if (!lead
    || lead.review_date !== reviewDate
    || !['recommended', 'needs_review'].includes(lead.status)
    || lead.confirmed_at === null) {
    return deny(row.requested_id, 'DENY_UNVERIFIED_MANUAL');
  }
  const verified = await loadVerifiedManualCandidateProof(env, leadId);
  if (!verified || verified.record.status !== 'active' || verified.record.lead_id !== leadId) {
    return deny(row.requested_id, 'DENY_UNVERIFIED_MANUAL');
  }
  return {
    item_id: row.requested_id,
    allowed: true,
    code: 'ALLOW_VERIFIED_MANUAL',
    lead_id: leadId,
    verification_id: verified.record.verification_id,
    guard_fingerprint: manualGuardFingerprint(row, lead, verified.record),
    guard_snapshot: {
      requested_index: row.requested_index,
      item_id: row.requested_id,
      kind: 'manual',
      item: itemGuardSnapshot(row),
      lead,
      verification: verified.record,
    },
  };
}

function legacyRadarReason(
  row: ItemRow,
  extra: Record<string, unknown>,
): Exclude<FormalNewsDecisionCode, 'ALLOW_SCHEDULED_FORMAL' | 'ALLOW_VERIFIED_MANUAL'> | null {
  if (row.requested_id.startsWith(`${LEGACY_RADAR_FEED_ID}:`)) return 'DENY_LEGACY_RADAR_ITEM_ID';
  if (row.source_id === LEGACY_RADAR_KEY || row.source_id?.startsWith(`${LEGACY_RADAR_KEY}:`)) {
    return 'DENY_LEGACY_RADAR_SOURCE_ID';
  }
  if (row.source_ref === LEGACY_RADAR_KEY) return 'DENY_LEGACY_RADAR_SOURCE_REF';
  if (extra.feed_id === LEGACY_RADAR_FEED_ID) return 'DENY_LEGACY_RADAR_FEED_ID';
  if (extra.feed_key === LEGACY_RADAR_KEY) return 'DENY_LEGACY_RADAR_FEED_KEY';
  return null;
}

function sourceMirrorDecision(
  descriptor: RegistryDescriptor,
  row: SourceRow,
): Exclude<FormalNewsDecisionCode, 'ALLOW_SCHEDULED_FORMAL' | 'ALLOW_VERIFIED_MANUAL'> | null {
  const parsed = strictObject(row.config);
  if (!parsed.ok) return 'DENY_SOURCE_MISMATCH';
  const config = parsed.value;
  if (descriptor.enabled === false || config.enabled === false) return 'DENY_SOURCE_DISABLED';
  if (config.enabled !== undefined && typeof config.enabled !== 'boolean') return 'DENY_SOURCE_MISMATCH';
  if (descriptor.editorial_type === 'radar' || config.editorial_type === 'radar') return 'DENY_SOURCE_RADAR';
  if (row.id !== descriptor.id
    || row.source_type !== descriptor.kind
    || row.source_ref !== descriptor.key
    || config.id !== descriptor.id
    || config.key !== descriptor.key
    || config.kind !== descriptor.kind
    || config.editorial_type !== descriptor.editorial_type) return 'DENY_SOURCE_MISMATCH';
  return null;
}

function matchesProducerShape(row: ItemRow, extra: Record<string, unknown>, descriptor: RegistryDescriptor): boolean {
  if (row.source_ref !== null || typeof row.source_id !== 'string') return false;
  const prefix = `${descriptor.key}:`;
  if (!row.source_id.startsWith(prefix) || row.source_id.length <= prefix.length) return false;
  if (extra.feed_id !== descriptor.id) return false;
  if (extra.editorial_type !== undefined) {
    if (!EDITORIAL_TYPES.has(extra.editorial_type as EditorialType)
      || extra.editorial_type !== descriptor.editorial_type) return false;
  }
  if (descriptor.kind === 'blog') {
    return row.source_type === 'blog'
      && row.requested_id === `blog:${row.source_id}`
      && extra.feed_key === descriptor.key;
  }
  if (row.requested_id !== `podcast:${row.source_id}`) return false;
  return (row.source_type === 'podcast' && extra.show_key === descriptor.key)
    || (row.source_type === 'blog' && extra.feed_key === descriptor.key);
}

function formalNewsFinalGuardCtes(
  registryJsonExpression = '?',
  expectedJsonExpression = '?',
  reviewDateExpression = '?',
): string {
  const expected = (path: string) => `json_extract(e.value, '$.${path}')`;
  const itemExact = `(
    i.id IS ${expected('item.id')}
    AND i.source_type IS ${expected('item.source_type')}
    AND i.source_id IS ${expected('item.source_id')}
    AND i.source_ref IS ${expected('item.source_ref')}
    AND i.extra IS ${expected('item.extra')}
    AND i.deleted_at IS ${expected('item.deleted_at')}
  )`;
  const scheduledExact = `(
    ${itemExact}
    AND r.id IS ${expected('registry.id')}
    AND r.key IS ${expected('registry.key')}
    AND r.kind IS ${expected('registry.kind')}
    AND r.editorial_type IS ${expected('registry.editorial_type')}
    AND r.enabled IS ${expected('registry.enabled')}
    AND s.id IS ${expected('source.id')}
    AND s.source_type IS ${expected('source.source_type')}
    AND s.source_ref IS ${expected('source.source_ref')}
    AND s.config IS ${expected('source.config')}
    AND ${formalNewsScheduledSqlPredicate('i', 'r', 's')}
  )`;
  const manualExact = `(
    ${itemExact}
    AND i.deleted_at IS NULL
    AND i.source_type='blog'
    AND i.source_id='manual:' || ${expected('lead.id')}
    AND i.source_ref='manual_lead'
    AND i.id='blog:manual:' || ${expected('lead.id')}
    AND i.extra IS NOT NULL AND json_valid(i.extra)=1 AND json_type(i.extra)='object'
    AND json_type(i.extra,'$.manual_lead')='object'
    AND json_extract(i.extra,'$.manual_lead.lead_id')=${expected('lead.id')}
    AND json_type(i.extra,'$.manual_lead.evidence_ids')='array'
    AND ${formalNewsItemSqlPredicate('i')}
    AND l.id IS ${expected('lead.id')}
    AND l.review_date=${reviewDateExpression}
    AND l.review_date IS ${expected('lead.review_date')}
    AND l.status IN ('recommended','needs_review')
    AND l.status IS ${expected('lead.status')}
    AND l.confirmed_at IS NOT NULL
    AND l.confirmed_at IS ${expected('lead.confirmed_at')}
    AND l.version IS ${expected('lead.version')}
    AND v.verification_id IS ${expected('verification.verification_id')}
    AND v.lead_id IS ${expected('verification.lead_id')}
    AND v.assessment_version IS ${expected('verification.assessment_version')}
    AND v.policy_version IS ${expected('verification.policy_version')}
    AND v.verification_key_id IS ${expected('verification.verification_key_id')}
    AND v.canonical_digest IS ${expected('verification.canonical_digest')}
    AND v.hmac_sha256 IS ${expected('verification.hmac_sha256')}
    AND v.verification_json IS ${expected('verification.verification_json')}
    AND v.processing_owner IS ${expected('verification.processing_owner')}
    AND v.processing_attempt IS ${expected('verification.processing_attempt')}
    AND v.creation_nonce IS ${expected('verification.creation_nonce')}
    AND v.status='active' AND v.status IS ${expected('verification.status')}
    AND v.reason IS ${expected('verification.reason')}
    AND v.created_at IS ${expected('verification.created_at')}
    AND v.invalidation_nonce IS ${expected('verification.invalidation_nonce')}
    AND v.invalidated_at IS ${expected('verification.invalidated_at')}
    AND v.invalidation_nonce IS NULL AND v.invalidated_at IS NULL
    AND (
      (v.policy_version='${MANUAL_NEWS_SOURCE_SUPPORT_POLICY}'
        AND ${expected('verification.assessment_json')} IS NULL
        AND json_valid(v.verification_json)=1
        AND json_extract(v.verification_json,'$.contract')='manual-news-source-support-proof-v1'
        AND i.id IS json_extract(v.verification_json,'$.item_projection.item_id')
        AND i.source_id IS json_extract(v.verification_json,'$.item_projection.source_id')
        AND i.title IS json_extract(v.verification_json,'$.item_projection.title')
        AND i.content IS json_extract(v.verification_json,'$.item_projection.summary')
        AND i.content_translated IS json_extract(v.verification_json,'$.item_projection.summary')
        AND i.author IS json_extract(v.verification_json,'$.item_projection.source')
        AND i.url IS json_extract(v.verification_json,'$.item_projection.url')
        AND i.published_at IS json_extract(v.verification_json,'$.item_projection.published_at')
        AND json_extract(i.extra,'$.manual_source_support.policy_version')=v.policy_version
        AND json_extract(i.extra,'$.manual_source_support.verification_id')=v.verification_id
        AND json_extract(i.extra,'$.manual_source_support.canonical_digest')=v.canonical_digest
        AND NOT EXISTS (SELECT 1 FROM manual_news_event_assessments source_assessment
          WHERE source_assessment.lead_id=v.lead_id
            AND source_assessment.assessment_version=v.assessment_version))
      OR
      (v.policy_version='${MANUAL_LEAD_VERIFICATION_POLICY_VERSION}'
        AND EXISTS (SELECT 1 FROM manual_news_event_assessments legacy_assessment
          WHERE legacy_assessment.lead_id=v.lead_id
            AND legacy_assessment.assessment_version=v.assessment_version
            AND legacy_assessment.assessment_json IS ${expected('verification.assessment_json')}))
    )
  )`;
  return `${formalNewsRegistryCte(registryJsonExpression)},
  formal_expected AS (
    SELECT CAST(key AS INTEGER) AS expected_index, value
      FROM json_each(${expectedJsonExpression}) WHERE type='object'
  ),
  formal_guarded AS (
    SELECT e.expected_index,
           ${expected('requested_index')} AS requested_index,
           ${expected('item_id')} AS item_id,
           ${expected('kind')} AS kind,
           CASE
             WHEN ${expected('kind')}='scheduled' THEN ${scheduledExact}
             WHEN ${expected('kind')}='manual' THEN ${manualExact}
             ELSE 0
           END AS guard_ok
      FROM formal_expected e
      LEFT JOIN items i ON i.id=${expected('item_id')}
      LEFT JOIN registry r ON r.id=json_extract(
        CASE WHEN i.extra IS NOT NULL AND json_valid(i.extra)=1 THEN i.extra ELSE '{}' END,
        '$.feed_id')
      LEFT JOIN sources s ON s.id=r.id
      LEFT JOIN manual_news_leads l
        ON ${expected('kind')}='manual' AND l.id=${expected('lead.id')}
      LEFT JOIN manual_news_assessment_verifications v
        ON ${expected('kind')}='manual' AND v.verification_id=${expected('verification.verification_id')}
  )`;
}

/** SQL/CAS predicate shared by review writes and final outward snapshot reads. */
export function formalNewsFinalGuardSqlPredicate(): string {
  return `NOT EXISTS (
    WITH ${formalNewsFinalGuardCtes()}
    SELECT 1 FROM formal_guarded WHERE guard_ok<>1
  )`;
}

/**
 * Collection-level outward guard for immutable publication rows. The caller
 * supplies the one canonical registry JSON bind; expected/manual snapshots and
 * review date are read from the exact page publication joined by the same SQL.
 */
export function formalNewsStoredSnapshotFinalGuardSqlPredicate(): string {
  const expectedType = `CASE WHEN json_valid(p.formal_guard_expected_json)=1
    THEN json_type(p.formal_guard_expected_json) ELSE NULL END`;
  const idsType = `CASE WHEN json_valid(p.formal_news_item_ids)=1
    THEN json_type(p.formal_news_item_ids) ELSE NULL END`;
  const safeExpected = `CASE WHEN ${expectedType}='array'
    THEN p.formal_guard_expected_json ELSE '[]' END`;
  const safeIds = `CASE WHEN ${idsType}='array'
    THEN p.formal_news_item_ids ELSE '[]' END`;
  return `(
    p.formal_guard_expected_json IS NOT NULL
    AND ${expectedType}='array'
    AND p.formal_news_item_ids IS NOT NULL
    AND ${idsType}='array'
    AND json_array_length(${safeExpected})=json_array_length(${safeIds})
    AND NOT EXISTS (
      SELECT 1
        FROM json_each(${safeExpected}) expected_entry
        LEFT JOIN json_each(${safeIds}) item_entry ON item_entry.key=expected_entry.key
       WHERE expected_entry.type<>'object'
          OR item_entry.type<>'text'
          OR json_extract(
               CASE WHEN expected_entry.type='object' AND json_valid(expected_entry.value)=1
                    THEN expected_entry.value ELSE '{}' END,
               '$.requested_index') IS NOT CAST(expected_entry.key AS INTEGER)
          OR json_extract(
               CASE WHEN expected_entry.type='object' AND json_valid(expected_entry.value)=1
                    THEN expected_entry.value ELSE '{}' END,
               '$.item_id') IS NOT item_entry.value
    )
    AND NOT EXISTS (
      WITH ${formalNewsFinalGuardCtes('?', safeExpected, 'p.publication_date')}
      SELECT 1 FROM formal_guarded WHERE guard_ok<>1
    )
  )`;
}

export function formalNewsFinalGuardBindings(
  authorization: FormalNewsAuthorizationResult,
): unknown[] {
  const contract = authorization.final_guard;
  if (!contract || JSON.stringify(authorization.allowed_ids)
    !== JSON.stringify(authorization.decisions.filter((entry) => entry.allowed).map((entry) => entry.item_id))) {
    throw new Error('formal_news_final_guard_contract_missing');
  }
  return [contract.registry_json, contract.expected_json, contract.review_date];
}

function sameManualProof(
  expected: PersistedManualVerificationRow,
  current: PersistedManualVerificationRow,
): boolean {
  const fields: Array<keyof PersistedManualVerificationRow> = [
    'verification_id', 'lead_id', 'assessment_version', 'policy_version',
    'verification_key_id', 'canonical_digest', 'hmac_sha256', 'verification_json',
    'processing_owner', 'processing_attempt', 'creation_nonce', 'status',
    'reason', 'created_at', 'invalidation_nonce', 'invalidated_at',
    'assessment_json', 'review_date',
  ];
  return fields.every((field) => (expected[field] ?? null) === (current[field] ?? null));
}

async function executeFormalNewsFinalGuard(
  env: Env,
  reviewDate: string,
  expectedRows: readonly FormalNewsGuardExpected[],
  registryJson: string,
): Promise<Array<{ expected_index: number; requested_index: number; item_id: string; kind: string; guard_ok: number }>> {
  if (!expectedRows.length) return [];
  const result = await env.DB.prepare(
    `/* formal_news:final_guard_single_snapshot */
     WITH ${formalNewsFinalGuardCtes()}
     SELECT expected_index,requested_index,item_id,kind,guard_ok
       FROM formal_guarded ORDER BY expected_index`,
  ).bind(registryJson, JSON.stringify(expectedRows), reviewDate)
    .all<{ expected_index: number; requested_index: number; item_id: string; kind: string; guard_ok: number }>();
  return result.results || [];
}

async function loadRequestedItems(
  env: Env,
  ids: readonly string[],
): Promise<ItemRow[]> {
  const result = await env.DB.prepare(
    `/* formal_news:early_authorization */
     WITH requested AS (
       SELECT CAST(key AS INTEGER) AS requested_index, value AS requested_id FROM json_each(?)
     )
     SELECT requested.requested_index, requested.requested_id,
            i.id, i.source_type, i.source_id, i.source_ref, i.extra, i.deleted_at
     FROM requested LEFT JOIN items i ON i.id = requested.requested_id
     ORDER BY requested.requested_index`,
  ).bind(JSON.stringify(ids)).all<ItemRow>();
  return result.results || [];
}

async function loadScheduledAuthorizationRows(
  env: Env,
  ids: readonly string[],
  registryJson: string,
): Promise<AuthorizationRow[]> {
  if (!ids.length) return [];
  const result = await env.DB.prepare(
    `/* formal_news:early_scheduled_join */
     WITH ${FORMAL_NEWS_REGISTRY_CTE}, requested AS (
       SELECT CAST(key AS INTEGER) AS requested_index, value AS requested_id FROM json_each(?)
     )
     SELECT requested.requested_index, requested.requested_id,
            i.id, i.source_type, i.source_id, i.source_ref, i.extra, i.deleted_at,
            r.id AS registry_id, s.id AS backing_source_id,
            s.source_type AS backing_source_type, s.source_ref AS backing_source_ref,
            s.config AS backing_source_config
     FROM requested LEFT JOIN items i ON i.id=requested.requested_id
     LEFT JOIN registry r ON r.id=json_extract(
       CASE WHEN i.extra IS NOT NULL AND json_valid(i.extra)=1 THEN i.extra ELSE '{}' END,
       '$.feed_id')
     LEFT JOIN sources s ON s.id=r.id
     ORDER BY requested.requested_index`,
  ).bind(registryJson, JSON.stringify(ids)).all<AuthorizationRow>();
  return result.results || [];
}

async function collectFormalNewsPreflight(
  env: Env,
  reviewDate: string,
  candidateIds: readonly string[],
): Promise<FormalNewsAuthorizationResult> {
  const ids = [...candidateIds];
  if (!ids.length) return { allowed_ids: [], decisions: [] };
  const descriptors = registryDescriptors();
  const descriptorById = new Map(descriptors.map((entry) => [entry.id, entry]));
  const items = await loadRequestedItems(env, ids);
  const scheduledIds = items.filter((row) => {
    if (!row.id) return false;
    const parsed = strictObject(row.extra);
    return !manualLooking(row, parsed.ok ? parsed.value : {});
  }).map((row) => row.requested_id);
  const scheduledRows = await loadScheduledAuthorizationRows(
    env, scheduledIds, JSON.stringify(descriptors),
  );
  const scheduledById = new Map<string, AuthorizationRow[]>();
  for (const row of scheduledRows) {
    const queue = scheduledById.get(row.requested_id) || [];
    queue.push(row);
    scheduledById.set(row.requested_id, queue);
  }
  const decisions: FormalNewsDecision[] = [];

  for (const initialRow of items) {
    const initiallyParsed = strictObject(initialRow.extra);
    const initialManual = initialRow.id
      ? manualLooking(initialRow, initiallyParsed.ok ? initiallyParsed.value : {})
      : false;
    const row = initialManual
      ? initialRow
      : scheduledById.get(initialRow.requested_id)?.shift() || initialRow;
    if (!row.id) {
      decisions.push(deny(row.requested_id, 'DENY_MISSING_ITEM'));
      continue;
    }
    if (row.deleted_at !== null) {
      decisions.push(deny(row.requested_id, 'DENY_DELETED_ITEM'));
      continue;
    }
    const parsed = strictObject(row.extra);
    if (!parsed.ok || Object.keys(parsed.value).length === 0 || hasMalformedItemIdentity(parsed.value)) {
      decisions.push(deny(row.requested_id, 'DENY_MALFORMED_ITEM_IDENTITY'));
      continue;
    }
    const extra = parsed.value;
    if (extra.editorial_type === 'radar') {
      decisions.push(deny(row.requested_id, 'DENY_EXPLICIT_ITEM_RADAR'));
      continue;
    }
    if (manualLooking(row, extra)) {
      decisions.push(await authorizeManualItem(env, reviewDate, row, extra));
      continue;
    }
    const feedId = typeof extra.feed_id === 'string' ? extra.feed_id : '';
    const descriptor = descriptorById.get(feedId);
    if (!descriptor) {
      decisions.push(deny(row.requested_id, 'DENY_NO_REGISTRY_SOURCE'));
      continue;
    }
    const scheduledRow = row as AuthorizationRow;
    if (!scheduledRow.registry_id || !scheduledRow.backing_source_id) {
      decisions.push(deny(row.requested_id, 'DENY_NO_SOURCE_ROW'));
      continue;
    }
    const source: SourceRow = {
      id: scheduledRow.backing_source_id,
      source_type: scheduledRow.backing_source_type || '',
      source_ref: scheduledRow.backing_source_ref,
      config: scheduledRow.backing_source_config,
    };
    const sourceDecision = sourceMirrorDecision(descriptor, source);
    if (sourceDecision) {
      decisions.push(deny(row.requested_id, sourceDecision));
      continue;
    }
    const legacyReason = legacyRadarReason(row, extra);
    if (legacyReason) {
      decisions.push(deny(row.requested_id, legacyReason));
      continue;
    }
    if (!matchesProducerShape(row, extra, descriptor)) {
      decisions.push(deny(row.requested_id, 'DENY_ITEM_SOURCE_MISMATCH'));
      continue;
    }
    decisions.push(allowScheduled(
      row.requested_id,
      {
        requested_index: row.requested_index,
        item_id: row.requested_id,
        kind: 'scheduled',
        item: itemGuardSnapshot(row),
        registry: descriptor,
        source,
      },
    ));
  }

  return {
    allowed_ids: decisions.filter((entry) => entry.allowed).map((entry) => entry.item_id),
    decisions,
  };
}

/** Canonical outward-time authorization with one normative joined final read. */
export async function authorizeFormalNewsSet(
  env: Env,
  reviewDate: string,
  candidateIds: readonly string[],
  _purpose: string,
): Promise<FormalNewsAuthorizationResult> {
  if (!candidateIds.length) {
    return {
      allowed_ids: [], decisions: [],
      final_guard: {
        registry_json: buildFormalNewsRegistryJson(), expected_json: '[]', review_date: reviewDate,
      },
    };
  }
  const early = await collectFormalNewsPreflight(env, reviewDate, candidateIds);
  const earlyAllowed = early.decisions.filter((decision) => decision.allowed);
  if (!earlyAllowed.length) return early;
  const staleIndexes = new Set<number>();
  const expectedRows: FormalNewsGuardExpected[] = [];
  for (const decision of earlyAllowed) {
    const snapshot = decision.guard_snapshot;
    if (!snapshot) {
      staleIndexes.add(decision.guard_snapshot?.requested_index ?? -1);
      continue;
    }
    if (snapshot.kind === 'manual') {
      const refreshed = snapshot.lead
        ? await loadVerifiedManualCandidateProof(env, snapshot.lead.id)
        : null;
      if (!refreshed?.record || !snapshot.verification
        || !sameManualProof(snapshot.verification, refreshed.record)) {
        staleIndexes.add(snapshot.requested_index);
        continue;
      }
    }
    expectedRows.push(snapshot);
  }
  const registryJson = buildFormalNewsRegistryJson();
  const guardedRows = await executeFormalNewsFinalGuard(env, reviewDate, expectedRows, registryJson);
  const guardByRequestedIndex = new Map(
    guardedRows.map((row) => [Number(row.requested_index), Number(row.guard_ok) === 1]),
  );
  const decisions = early.decisions.map((decision): FormalNewsDecision => {
    if (!decision.allowed) return decision;
    const index = decision.guard_snapshot?.requested_index ?? -1;
    if (staleIndexes.has(index) || guardByRequestedIndex.get(index) !== true) {
      return deny(decision.item_id, 'DENY_AUTHORIZATION_STALE');
    }
    return decision;
  });
  const allowedSnapshots = decisions
    .filter((decision) => decision.allowed)
    .map((decision) => decision.guard_snapshot)
    .filter((snapshot): snapshot is FormalNewsGuardExpected => Boolean(snapshot));
  return {
    allowed_ids: decisions.filter((decision) => decision.allowed).map((decision) => decision.item_id),
    decisions,
    final_guard: {
      registry_json: registryJson,
      expected_json: JSON.stringify(allowedSnapshots),
      review_date: reviewDate,
    },
  };
}

/** Fail-closed exact-set guard for write/send boundaries. */
export async function assertFormalNewsAuthorizationCurrent(
  env: Env,
  reviewDate: string,
  expectedIds: readonly string[],
  purpose: string,
): Promise<FormalNewsAuthorizationResult> {
  const result = await authorizeFormalNewsSet(env, reviewDate, expectedIds, purpose);
  if (JSON.stringify(result.allowed_ids) !== JSON.stringify(expectedIds)) {
    throw new Error(`formal_news_final_guard_failed:${purpose}`);
  }
  return result;
}
