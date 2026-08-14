import { canonicalJsonV2 } from './manual-news-canonical-json-v2';
import { isNfc15, isUnicodeScalarString15 } from './manual-news-unicode15';

export const MANUAL_NEWS_V11_CONTRACT_VERSION = 'manual-news-v11-spec-v6' as const;
export const MANUAL_NEWS_V11_PROFILE = 'unicode-15.1.0-nfc-nfkc-egc-scalar-canonical-json-v2' as const;
export const MANUAL_NEWS_V11_POLICY_VERSION = 'fact-evidence-projection-hmac-v11' as const;

export type ManualNewsV11CanonicalKind = 'A' | 'P' | 'V' | 'H';
export interface PriorVerificationRef {
  assessment_version: number; event_key: string; lead_id: string;
  policy_version: 'fact-evidence-projection-hmac-v10' | typeof MANUAL_NEWS_V11_POLICY_VERSION;
  review_date: string; verification_digest: string;
}
/**
 * A validated 64-lowercase-hex commitment to a leaf payload.
 *
 * PR-A intentionally treats this as opaque: it does not receive, canonicalize,
 * or recompute the corresponding leaf preimage. PR-B owns that work.
 */
export type ManualNewsV11OpaqueLeafCommitment = string;

export interface ManualNewsV11AssessmentDomainPreimage {
  assessment_payload_digest: ManualNewsV11OpaqueLeafCommitment; assessment_version: number; contract_version: typeof MANUAL_NEWS_V11_CONTRACT_VERSION;
  domain: 'A'; event_key: string; lead_id: string; prior_verifications: PriorVerificationRef[]; profile: typeof MANUAL_NEWS_V11_PROFILE;
}
export interface ManualNewsV11ProvenanceDomainPreimage {
  assessment_version: number; contract_version: typeof MANUAL_NEWS_V11_CONTRACT_VERSION; domain: 'P'; event_key: string;
  lead_id: string; profile: typeof MANUAL_NEWS_V11_PROFILE; provenance_payload_digest: ManualNewsV11OpaqueLeafCommitment; response_key_ids: string[];
}
export interface ManualNewsV11VerificationDomainPreimage {
  assessment_digest: string; assessment_version: number; contract_version: typeof MANUAL_NEWS_V11_CONTRACT_VERSION; domain: 'V';
  event_key: string; lead_id: string; policy_version: typeof MANUAL_NEWS_V11_POLICY_VERSION;
  prior_verifications: PriorVerificationRef[]; profile: typeof MANUAL_NEWS_V11_PROFILE;
  provenance_digest: string; verification_payload_digest: ManualNewsV11OpaqueLeafCommitment;
}
export interface ManualNewsV11HmacDomainPreimage {
  assessment_version: number; contract_version: typeof MANUAL_NEWS_V11_CONTRACT_VERSION; domain: 'H'; event_key: string;
  hmac_algorithm: 'hmac-sha256'; lead_id: string; policy_version: typeof MANUAL_NEWS_V11_POLICY_VERSION;
  profile: typeof MANUAL_NEWS_V11_PROFILE; response_key_ids: string[]; verification_digest: string; verification_key_id: string;
}
export interface ManualNewsV11Assessment { assessment: ManualNewsV11AssessmentDomainPreimage; }
export interface ManualNewsV11Provenance { provenance: ManualNewsV11ProvenanceDomainPreimage; }
export interface ManualNewsV11Verification { verification: ManualNewsV11VerificationDomainPreimage; }
export interface ManualNewsV11Hmac { hmac: ManualNewsV11HmacDomainPreimage; }
/** Feature-off A ∥ P → V → H envelope DAG; leaf compilation is deferred to PR-B. */
export interface ManualNewsV11EnvelopeDag {
  assessment: ManualNewsV11Assessment; provenance: ManualNewsV11Provenance;
  verification: ManualNewsV11Verification; hmac: ManualNewsV11Hmac;
}

const DIGEST = /^[a-f0-9]{64}$/u;
const LEAD_ID = /^ml-[0-9]{8}-[a-f0-9]{12}$/u;
const EVENT_KEY = /^[a-z0-9][a-z0-9:_-]{5,199}$/u;
const KEY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const PRIOR_KEYS = ['assessment_version', 'event_key', 'lead_id', 'policy_version', 'review_date', 'verification_digest'] as const;
const A_KEYS = ['assessment_payload_digest', 'assessment_version', 'contract_version', 'domain', 'event_key', 'lead_id', 'prior_verifications', 'profile'] as const;
const P_KEYS = ['assessment_version', 'contract_version', 'domain', 'event_key', 'lead_id', 'profile', 'provenance_payload_digest', 'response_key_ids'] as const;
const V_KEYS = ['assessment_digest', 'assessment_version', 'contract_version', 'domain', 'event_key', 'lead_id', 'policy_version', 'prior_verifications', 'profile', 'provenance_digest', 'verification_payload_digest'] as const;
const H_KEYS = ['assessment_version', 'contract_version', 'domain', 'event_key', 'hmac_algorithm', 'lead_id', 'policy_version', 'profile', 'response_key_ids', 'verification_digest', 'verification_key_id'] as const;

function invalid(): never { throw new Error('manual_news_v11_domain_invalid'); }

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactRecord(value: unknown, expected: readonly string[]): Record<string, unknown> {
  if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length !== 0) invalid();
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== expected.length || !expected.every((key) => names.includes(key))) invalid();
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid();
  }
  return value;
}

function exactDomain(value: unknown, root: string, keys: readonly string[]): Record<string, unknown> {
  const outer = exactRecord(value, [root]);
  return exactRecord(outer[root], keys);
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !isUnicodeScalarString15(value) || !isNfc15(value)) invalid();
  return value;
}

function safeVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) invalid();
  return Number(value);
}

function digest(value: unknown): string { const result = text(value); return DIGEST.test(result) ? result : invalid(); }
function leadId(value: unknown): string { const result = text(value); return LEAD_ID.test(result) ? result : invalid(); }
function eventKey(value: unknown): string { const result = text(value); return EVENT_KEY.test(result) ? result : invalid(); }
function keyId(value: unknown): string { const result = text(value); return KEY_ID.test(result) ? result : invalid(); }

function reviewDate(value: unknown): string {
  const result = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(result)) invalid();
  const date = new Date(`${result}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === result ? result : invalid();
}

function compareScalar(left: string, right: string): number {
  const l = Array.from(left, (character) => character.codePointAt(0)!);
  const r = Array.from(right, (character) => character.codePointAt(0)!);
  for (let index = 0; index < Math.min(l.length, r.length); index += 1) {
    if (l[index] !== r[index]) return l[index] - r[index];
  }
  return l.length - r.length;
}

function denseArray(value: unknown): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length !== 0) invalid();
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== value.length + 1 || !names.includes('length')) invalid();
  const values: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid();
    values.push(descriptor.value);
  }
  return values;
}

function priorVerifications(value: unknown, currentLead: string): PriorVerificationRef[] {
  const entries = denseArray(value);
  if (entries.length > 20) invalid();
  const parsed = entries.map((entry) => {
    const record = exactRecord(entry, PRIOR_KEYS);
    const prior = {
      assessment_version: safeVersion(record.assessment_version), event_key: eventKey(record.event_key),
      lead_id: leadId(record.lead_id), policy_version: text(record.policy_version),
      review_date: reviewDate(record.review_date), verification_digest: digest(record.verification_digest),
    };
    if (!['fact-evidence-projection-hmac-v10', MANUAL_NEWS_V11_POLICY_VERSION].includes(prior.policy_version)
      || prior.lead_id === currentLead) invalid();
    return prior as PriorVerificationRef;
  });
  for (let index = 1; index < parsed.length; index += 1) {
    const previous = parsed[index - 1]; const current = parsed[index];
    const order = compareScalar(previous.lead_id, current.lead_id)
      || previous.assessment_version - current.assessment_version
      || compareScalar(previous.verification_digest, current.verification_digest);
    if (order >= 0) invalid();
  }
  return parsed;
}

function responseKeyIds(value: unknown): string[] {
  const ids = denseArray(value).map(keyId);
  if (ids.length < 1 || ids.length > 8) invalid();
  for (let index = 1; index < ids.length; index += 1) {
    if (compareScalar(ids[index - 1], ids[index]) >= 0) invalid();
  }
  return ids;
}

function common(record: Record<string, unknown>, domain: ManualNewsV11CanonicalKind): { lead: string; event: string; version: number } {
  if (text(record.contract_version) !== MANUAL_NEWS_V11_CONTRACT_VERSION || text(record.profile) !== MANUAL_NEWS_V11_PROFILE
    || text(record.domain) !== domain) invalid();
  return { lead: leadId(record.lead_id), event: eventKey(record.event_key), version: safeVersion(record.assessment_version) };
}

function assertA(value: unknown): Record<string, unknown> {
  const record = exactDomain(value, 'assessment', A_KEYS); const identity = common(record, 'A');
  digest(record.assessment_payload_digest); priorVerifications(record.prior_verifications, identity.lead); return record;
}
function assertP(value: unknown): Record<string, unknown> {
  const record = exactDomain(value, 'provenance', P_KEYS); common(record, 'P');
  digest(record.provenance_payload_digest); responseKeyIds(record.response_key_ids); return record;
}
function assertV(value: unknown): Record<string, unknown> {
  const record = exactDomain(value, 'verification', V_KEYS); const identity = common(record, 'V');
  if (text(record.policy_version) !== MANUAL_NEWS_V11_POLICY_VERSION) invalid();
  digest(record.assessment_digest); digest(record.provenance_digest); digest(record.verification_payload_digest);
  priorVerifications(record.prior_verifications, identity.lead); return record;
}
function assertH(value: unknown): Record<string, unknown> {
  const record = exactDomain(value, 'hmac', H_KEYS); common(record, 'H');
  if (text(record.policy_version) !== MANUAL_NEWS_V11_POLICY_VERSION || text(record.hmac_algorithm) !== 'hmac-sha256') invalid();
  responseKeyIds(record.response_key_ids); digest(record.verification_digest); keyId(record.verification_key_id); return record;
}

function canonical(value: unknown, assertion: (value: unknown) => Record<string, unknown>): string {
  assertion(value); try { return canonicalJsonV2(value); } catch { return invalid(); }
}

export function canonicalA11(value: unknown): string { return canonical(value, assertA); }
export function canonicalP11(value: unknown): string { return canonical(value, assertP); }
export function canonicalV11(value: unknown): string { return canonical(value, assertV); }
export function canonicalH11(value: unknown): string { return canonical(value, assertH); }

export function dispatchManualNewsV11Canonical(input: unknown): string {
  const record = exactRecord(input, ['kind', 'value']);
  if (typeof record.kind !== 'string' || !['A', 'P', 'V', 'H'].includes(record.kind)) invalid();
  const kind = record.kind as ManualNewsV11CanonicalKind;
  return ({ A: canonicalA11, P: canonicalP11, V: canonicalV11, H: canonicalH11 } as const)[kind](record.value);
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
async function sha256Utf8(value: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

function freezeRecursively<T>(value: T): T {
  if (!value || typeof value !== 'object') return value;
  for (const key of Object.getOwnPropertyNames(value)) {
    freezeRecursively((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

function detachedEnvelopeDag(value: unknown): ManualNewsV11EnvelopeDag {
  // The canonical encoder synchronously rechecks every nested value before JSON
  // parsing creates a fresh data-only graph with standard object/array prototypes.
  return freezeRecursively(JSON.parse(canonicalJsonV2(value)) as ManualNewsV11EnvelopeDag);
}

export async function validateManualNewsV11EnvelopeDag(input: unknown): Promise<ManualNewsV11EnvelopeDag> {
  const source = exactRecord(input, ['assessment', 'provenance', 'verification', 'hmac']) as unknown as ManualNewsV11EnvelopeDag;
  assertA(source.assessment); assertP(source.provenance);
  assertV(source.verification); assertH(source.hmac);

  // No caller-owned reference is observed after this line. In particular, the
  // first await below may yield to a hostile queueMicrotask mutation.
  const dag = detachedEnvelopeDag(source);
  const a = assertA(dag.assessment); const p = assertP(dag.provenance);
  const v = assertV(dag.verification); const h = assertH(dag.hmac);
  const identities = [common(a, 'A'), common(p, 'P'), common(v, 'V'), common(h, 'H')];
  if (identities.some((identity) => identity.lead !== identities[0].lead || identity.event !== identities[0].event || identity.version !== identities[0].version)) invalid();
  const canonicalA = canonicalA11(dag.assessment);
  const canonicalP = canonicalP11(dag.provenance);
  const canonicalV = canonicalV11(dag.verification);
  const expectedAssessmentDigest = v.assessment_digest;
  const expectedProvenanceDigest = v.provenance_digest;
  const expectedVerificationDigest = h.verification_digest;
  const expectedPriorVerifications = canonicalJsonV2(a.prior_verifications);
  const expectedVerificationPriors = canonicalJsonV2(v.prior_verifications);
  const expectedResponseKeyIds = canonicalJsonV2(p.response_key_ids);
  const expectedHmacResponseKeyIds = canonicalJsonV2(h.response_key_ids);
  if (await sha256Utf8(canonicalA) !== expectedAssessmentDigest
    || await sha256Utf8(canonicalP) !== expectedProvenanceDigest
    || await sha256Utf8(canonicalV) !== expectedVerificationDigest) invalid();
  if (expectedPriorVerifications !== expectedVerificationPriors
    || expectedResponseKeyIds !== expectedHmacResponseKeyIds) invalid();
  return dag;
}
