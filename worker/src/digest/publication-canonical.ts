/** Shared Worker/WebCrypto boundary for append-only daily publications. */

export type PublicationObjectRole = 'html' | 'mp4' | 'poster' | 'vtt';
export type PublicationType = 'page' | 'video';

export const MAX_PUBLICATION_OBJECT_BYTES: Readonly<Record<PublicationObjectRole, number>> = {
  html: 2 * 1024 * 1024,
  mp4: 64 * 1024 * 1024,
  poster: 8 * 1024 * 1024,
  vtt: 1024 * 1024,
};

export const MAX_PUBLICATION_REVISIONS_PER_DATE: Readonly<Record<PublicationType, number>> = {
  page: 16,
  video: 4,
};

export const MAX_PUBLICATION_OBJECTS_PER_DATE =
  MAX_PUBLICATION_REVISIONS_PER_DATE.page
  + MAX_PUBLICATION_REVISIONS_PER_DATE.video * 3;

export const MAX_PUBLICATION_BYTES_PER_DATE =
  MAX_PUBLICATION_REVISIONS_PER_DATE.page * MAX_PUBLICATION_OBJECT_BYTES.html
  + MAX_PUBLICATION_REVISIONS_PER_DATE.video * (
    MAX_PUBLICATION_OBJECT_BYTES.mp4
    + MAX_PUBLICATION_OBJECT_BYTES.poster
    + MAX_PUBLICATION_OBJECT_BYTES.vtt
  );

export const PUBLICATION_STORAGE_BUDGET_BYTES = 3 * 1024 ** 4;

const MIME_BY_ROLE: Readonly<Record<PublicationObjectRole, readonly string[]>> = {
  html: ['text/html; charset=utf-8'],
  mp4: ['video/mp4'],
  poster: ['image/jpeg', 'image/png', 'image/webp'],
  vtt: ['text/vtt; charset=utf-8'],
};

const ROLE_ORDER: Readonly<Record<PublicationObjectRole, number>> = {
  html: 0, mp4: 0, poster: 1, vtt: 2,
};

const HEX64 = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();

export interface PublicationObjectIdentity {
  schema_version: 1;
  r2_key: string;
  business_revision_id: string;
  attempt_key: string;
  object_role: PublicationObjectRole;
  mime: string;
}

export interface CanonicalPublicationObject extends PublicationObjectIdentity {
  sha256: string;
  size_bytes: number;
  tuple_digest: string;
  canonical_json: string;
}

export interface PublicationManifestInput {
  schema_version: 1;
  publication_date: string;
  publication_type: PublicationType;
  slot_no: number;
  business_revision_id: string;
  attempt_key: string;
  vtt_present: 0 | 1;
  objects: CanonicalPublicationObject[];
}

export interface CanonicalPublicationManifest extends Omit<PublicationManifestInput, 'objects'> {
  objects: CanonicalPublicationObject[];
  object_count: number;
  total_size_bytes: number;
  manifest_digest: string;
  canonical_json: string;
}

function nfc(value: string): string {
  return value.normalize('NFC');
}

function bytesView(value: Uint8Array | ArrayBuffer): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

async function digestHex(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', value);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function digestText(value: string): Promise<string> {
  return digestHex(encoder.encode(value));
}

function assertIdentity(input: PublicationObjectIdentity): void {
  if (input.schema_version !== 1 || !HEX64.test(input.business_revision_id) || !HEX64.test(input.attempt_key)) {
    throw new Error('PUBLICATION_OBJECT_IDENTITY_INVALID');
  }
  if (!MIME_BY_ROLE[input.object_role]?.includes(input.mime)) {
    throw new Error('PUBLICATION_OBJECT_MIME_INVALID');
  }
}

function tupleValue(
  input: PublicationObjectIdentity,
  sha256: string,
  sizeBytes: number,
): Omit<CanonicalPublicationObject, 'tuple_digest' | 'canonical_json'> {
  return {
    schema_version: 1,
    r2_key: nfc(input.r2_key),
    business_revision_id: input.business_revision_id,
    attempt_key: input.attempt_key,
    object_role: input.object_role,
    sha256,
    size_bytes: sizeBytes,
    mime: nfc(input.mime),
  };
}

export async function canonicalizePublicationObject(
  input: PublicationObjectIdentity,
  actualBytes: Uint8Array | ArrayBuffer,
): Promise<CanonicalPublicationObject> {
  assertIdentity(input);
  const bytes = bytesView(actualBytes);
  if (bytes.byteLength > MAX_PUBLICATION_OBJECT_BYTES[input.object_role]) {
    throw new Error('PUBLICATION_OBJECT_TOO_LARGE');
  }
  const sha256 = await digestHex(bytes);
  const tuple = tupleValue(input, sha256, bytes.byteLength);
  const canonicalJson = JSON.stringify(tuple);
  return {
    ...tuple,
    tuple_digest: await digestText(canonicalJson),
    canonical_json: canonicalJson,
  };
}

export async function verifyPublicationObjectBytes(
  expected: CanonicalPublicationObject,
  actualBytes: Uint8Array | ArrayBuffer,
): Promise<CanonicalPublicationObject> {
  const actual = await canonicalizePublicationObject(expected, actualBytes);
  if (
    actual.sha256 !== expected.sha256
    || actual.size_bytes !== expected.size_bytes
    || actual.tuple_digest !== expected.tuple_digest
    || actual.canonical_json !== expected.canonical_json
  ) throw new Error('PUBLICATION_OBJECT_BYTES_MISMATCH');
  return expected;
}

function manifestObject(object: CanonicalPublicationObject) {
  return {
    schema_version: 1,
    r2_key: nfc(object.r2_key),
    business_revision_id: object.business_revision_id,
    attempt_key: object.attempt_key,
    object_role: object.object_role,
    sha256: object.sha256,
    size_bytes: object.size_bytes,
    mime: nfc(object.mime),
  };
}

export async function buildPublicationManifest(
  input: PublicationManifestInput,
): Promise<CanonicalPublicationManifest> {
  if (
    input.schema_version !== 1
    || !/^\d{4}-\d{2}-\d{2}$/.test(input.publication_date)
    || !Number.isInteger(input.slot_no)
    || input.slot_no < 1
    || !HEX64.test(input.business_revision_id)
    || !HEX64.test(input.attempt_key)
  ) throw new Error('PUBLICATION_MANIFEST_IDENTITY_INVALID');
  const objects = [...input.objects].sort((left, right) => ROLE_ORDER[left.object_role] - ROLE_ORDER[right.object_role]);
  const roles = objects.map((object) => object.object_role).join(',');
  const expectedRoles = input.publication_type === 'page'
    ? 'html'
    : input.vtt_present ? 'mp4,poster,vtt' : 'mp4,poster';
  if (roles !== expectedRoles) throw new Error('PUBLICATION_MANIFEST_ROLE_MISMATCH');
  if (objects.some((object) => (
    object.business_revision_id !== input.business_revision_id
    || object.attempt_key !== input.attempt_key
  ))) throw new Error('PUBLICATION_MANIFEST_OBJECT_MISMATCH');
  const canonicalValue = {
    schema_version: 1,
    publication_date: input.publication_date,
    publication_type: input.publication_type,
    slot_no: input.slot_no,
    business_revision_id: input.business_revision_id,
    attempt_key: input.attempt_key,
    vtt_present: input.vtt_present,
    objects: objects.map(manifestObject),
  };
  const canonicalJson = JSON.stringify(canonicalValue);
  return {
    ...input,
    objects,
    object_count: objects.length,
    total_size_bytes: objects.reduce((sum, object) => sum + object.size_bytes, 0),
    manifest_digest: await digestText(canonicalJson),
    canonical_json: canonicalJson,
  };
}

export async function canonicalBusinessRevision(value: Record<string, unknown>): Promise<string> {
  return digestText(canonicalPublicationJson(value));
}

function canonicalJsonValue(value: unknown): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return nfc(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new Error('PUBLICATION_CANONICAL_NUMBER_INVALID');
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry === undefined) throw new Error('PUBLICATION_CANONICAL_UNDEFINED');
      result[nfc(key)] = canonicalJsonValue(entry);
    }
    return result;
  }
  throw new Error('PUBLICATION_CANONICAL_VALUE_INVALID');
}

export function canonicalPublicationJson(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}
