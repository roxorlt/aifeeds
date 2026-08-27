/** Append-only publication R2 boundary. This module intentionally exposes no delete API. */

import {
  buildPublicationManifest,
  canonicalPublicationJson,
  canonicalizePublicationObject,
  MAX_PUBLICATION_REVISIONS_PER_DATE,
  verifyPublicationObjectBytes,
  type CanonicalPublicationObject,
  type CanonicalPublicationManifest,
  type PublicationObjectRole,
  type PublicationType,
} from './publication-canonical';

interface PublicationR2Head {
  key?: string;
  size: number;
  customMetadata?: Record<string, string>;
  httpMetadata?: { contentType?: string };
}

export interface PublicationR2Bucket {
  head(key: string): Promise<PublicationR2Head | null>;
  put(
    key: string,
    value: Uint8Array | ArrayBuffer,
    options: {
      httpMetadata: { contentType: string };
      customMetadata: Record<string, string>;
    },
  ): Promise<unknown>;
}

function metadata(object: CanonicalPublicationObject): Record<string, string> {
  return {
    schema_version: '1',
    business_revision_id: object.business_revision_id,
    attempt_key: object.attempt_key,
    object_role: object.object_role,
    sha256: object.sha256,
    size_bytes: String(object.size_bytes),
    mime: object.mime,
    tuple_digest: object.tuple_digest,
  };
}

export function publicationObjectHeadFixture(
  object: CanonicalPublicationObject,
): PublicationR2Head {
  return {
    key: object.r2_key,
    size: object.size_bytes,
    customMetadata: metadata(object),
    httpMetadata: { contentType: object.mime },
  };
}

function headMatches(head: PublicationR2Head, object: CanonicalPublicationObject): boolean {
  const expectedMetadata = metadata(object);
  return head.size === object.size_bytes
    && (!head.key || head.key === object.r2_key)
    && head.httpMetadata?.contentType === object.mime
    && Object.entries(expectedMetadata).every(([key, value]) => head.customMetadata?.[key] === value);
}

export async function putImmutablePublicationObject(
  bucket: PublicationR2Bucket,
  object: CanonicalPublicationObject,
  actualBytes: Uint8Array | ArrayBuffer,
): Promise<{ status: 'put' | 'reused' }> {
  await verifyPublicationObjectBytes(object, actualBytes);
  const existing = await bucket.head(object.r2_key);
  if (existing) {
    if (!headMatches(existing, object)) throw new Error('PUBLICATION_R2_INTEGRITY_MISMATCH');
    return { status: 'reused' };
  }
  try {
    await bucket.put(object.r2_key, actualBytes, {
      httpMetadata: { contentType: object.mime },
      customMetadata: metadata(object),
    });
  } catch (error) {
    throw new Error('PUBLICATION_PUT_UNKNOWN', { cause: error });
  }
  return { status: 'put' };
}

export interface ReservePublicationObjectInput {
  object_role: PublicationObjectRole;
  mime: string;
  bytes: Uint8Array | ArrayBuffer;
}

export interface ReserveAppendOnlyPublicationInput {
  publication_date: string;
  publication_type: PublicationType;
  business_revision_id: string;
  objects: ReservePublicationObjectInput[];
  metadata?: Record<string, unknown>;
  formal_news_item_ids?: string[];
  formal_guard_expected?: unknown[];
  review_batch?: Record<string, unknown> | null;
  release_binding?: {
    video_mode?: 'none' | 'reuse_current' | 'joint_new';
    bound_video_publication_id?: string | null;
    bound_video_digest?: string | null;
    base_release_generation?: number;
    base_page_publication_id?: string | null;
    base_video_publication_id?: string | null;
    base_video_digest?: string | null;
  };
}

export interface ReservedAppendOnlyPublication {
  reservation_token: string;
  publication_id: string;
  publication_date: string;
  publication_type: PublicationType;
  slot_no: number;
  business_revision_id: string;
  attempt_key: string;
  manifest: CanonicalPublicationManifest;
}

interface ExistingReservationRow {
  reservation_token: string;
  publication_id: string;
  publication_date: string;
  publication_type: PublicationType;
  slot_no: number;
  business_revision_id: string;
  attempt_key: string;
  manifest_digest: string;
  object_count: number;
  reserved_bytes: number;
  metadata_json: string;
  formal_news_item_ids: string;
  formal_guard_expected_json: string;
  review_batch_json: string | null;
  video_mode: 'none' | 'reuse_current' | 'joint_new' | null;
  bound_video_publication_id: string | null;
  bound_video_digest: string | null;
  base_release_generation: number;
  base_page_publication_id: string | null;
  base_video_publication_id: string | null;
  base_video_digest: string | null;
}

function normalizedReleaseFields(input: ReserveAppendOnlyPublicationInput) {
  const binding = input.release_binding || {};
  const page = input.publication_type === 'page';
  const videoMode = page ? (binding.video_mode || 'none') : null;
  const fields = {
    metadata_json: canonicalPublicationJson(input.metadata || {}),
    formal_news_item_ids: canonicalPublicationJson((input.formal_news_item_ids || []).map((id) => id.normalize('NFC'))),
    formal_guard_expected_json: canonicalPublicationJson(input.formal_guard_expected || []),
    review_batch_json: input.review_batch === null || input.review_batch === undefined
      ? null
      : canonicalPublicationJson(input.review_batch),
    video_mode: videoMode,
    bound_video_publication_id: page ? (binding.bound_video_publication_id ?? null) : null,
    bound_video_digest: page ? (binding.bound_video_digest ?? null) : null,
    base_release_generation: binding.base_release_generation ?? 0,
    base_page_publication_id: binding.base_page_publication_id ?? null,
    base_video_publication_id: binding.base_video_publication_id ?? null,
    base_video_digest: binding.base_video_digest ?? null,
  };
  if (!Number.isSafeInteger(fields.base_release_generation) || fields.base_release_generation < 0) {
    throw new Error('PUBLICATION_BASE_GENERATION_INVALID');
  }
  if (page) {
    if (videoMode === 'none' && (fields.bound_video_publication_id || fields.bound_video_digest)) {
      throw new Error('PUBLICATION_VIDEO_MODE_BINDING_INVALID');
    }
    if (videoMode !== 'none' && (!fields.bound_video_publication_id || !fields.bound_video_digest)) {
      throw new Error('PUBLICATION_VIDEO_MODE_BINDING_INVALID');
    }
  }
  return fields;
}

function randomHex32(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function objectKey(attemptKey: string, role: PublicationObjectRole, mime: string): string {
  if (role === 'html') return `daily/versions/${attemptKey}/page.html`;
  if (role === 'mp4') return `daily-video/candidates/${attemptKey}/video.mp4`;
  if (role === 'vtt') return `daily-video/candidates/${attemptKey}/captions.vtt`;
  const extension = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
  return `daily-video/candidates/${attemptKey}/poster.${extension}`;
}

async function canonicalForReservation(
  input: ReserveAppendOnlyPublicationInput,
  attemptKey: string,
  slotNo: number,
): Promise<CanonicalPublicationManifest> {
  const objects: CanonicalPublicationObject[] = [];
  for (const object of input.objects) {
    objects.push(await canonicalizePublicationObject({
      schema_version: 1,
      r2_key: objectKey(attemptKey, object.object_role, object.mime),
      business_revision_id: input.business_revision_id,
      attempt_key: attemptKey,
      object_role: object.object_role,
      mime: object.mime,
    }, object.bytes));
  }
  return buildPublicationManifest({
    schema_version: 1,
    publication_date: input.publication_date,
    publication_type: input.publication_type,
    slot_no: slotNo,
    business_revision_id: input.business_revision_id,
    attempt_key: attemptKey,
    vtt_present: objects.some((object) => object.object_role === 'vtt') ? 1 : 0,
    objects,
  });
}

async function loadExistingReservation(
  db: D1Database,
  input: ReserveAppendOnlyPublicationInput,
): Promise<ExistingReservationRow | null> {
  return db.prepare(
    `SELECT r.reservation_token,p.publication_id,r.publication_date,r.publication_type,
            r.slot_no,r.business_revision_id,r.attempt_key,r.manifest_digest,
            r.object_count,r.reserved_bytes,p.metadata_json,p.formal_news_item_ids,
            p.formal_guard_expected_json,p.review_batch_json,p.video_mode,
            p.bound_video_publication_id,p.bound_video_digest,p.base_release_generation,
            p.base_page_publication_id,p.base_video_publication_id,p.base_video_digest
       FROM publication_reservations r
       JOIN append_only_publications p ON p.reservation_token=r.reservation_token
       JOIN publication_manifest_commits m ON m.reservation_token=r.reservation_token
      WHERE r.publication_date=? AND r.publication_type=? AND r.business_revision_id=?
        AND p.manifest_digest=r.manifest_digest AND m.manifest_digest=r.manifest_digest`,
  ).bind(input.publication_date, input.publication_type, input.business_revision_id)
    .first<ExistingReservationRow>();
}

async function replayExisting(
  existing: ExistingReservationRow,
  input: ReserveAppendOnlyPublicationInput,
): Promise<ReservedAppendOnlyPublication> {
  const manifest = await canonicalForReservation(input, existing.attempt_key, existing.slot_no);
  const fields = normalizedReleaseFields(input);
  if (
    manifest.manifest_digest !== existing.manifest_digest
    || manifest.object_count !== existing.object_count
    || manifest.total_size_bytes !== existing.reserved_bytes
    || fields.metadata_json !== existing.metadata_json
    || fields.formal_news_item_ids !== existing.formal_news_item_ids
    || fields.formal_guard_expected_json !== existing.formal_guard_expected_json
    || fields.review_batch_json !== existing.review_batch_json
    || fields.video_mode !== existing.video_mode
    || fields.bound_video_publication_id !== existing.bound_video_publication_id
    || fields.bound_video_digest !== existing.bound_video_digest
    || fields.base_release_generation !== Number(existing.base_release_generation)
    || fields.base_page_publication_id !== existing.base_page_publication_id
    || fields.base_video_publication_id !== existing.base_video_publication_id
    || fields.base_video_digest !== existing.base_video_digest
  ) throw new Error('PUBLICATION_REPLAY_INTEGRITY_MISMATCH');
  return {
    reservation_token: existing.reservation_token,
    publication_id: existing.publication_id,
    publication_date: existing.publication_date,
    publication_type: existing.publication_type,
    slot_no: existing.slot_no,
    business_revision_id: existing.business_revision_id,
    attempt_key: existing.attempt_key,
    manifest,
  };
}

export async function reserveAppendOnlyPublication(
  env: { DB: D1Database },
  input: ReserveAppendOnlyPublicationInput,
): Promise<{ status: 'reserved' | 'replayed'; reservation: ReservedAppendOnlyPublication }> {
  const existing = await loadExistingReservation(env.DB, input);
  if (existing) return { status: 'replayed', reservation: await replayExisting(existing, input) };

  const occupied = await env.DB.prepare(
    `SELECT slot_no FROM publication_reservations
      WHERE publication_date=? AND publication_type=? ORDER BY slot_no`,
  ).bind(input.publication_date, input.publication_type).all<{ slot_no: number }>();
  const limit = MAX_PUBLICATION_REVISIONS_PER_DATE[input.publication_type];
  const used = new Set((occupied.results || []).map((row) => Number(row.slot_no)));
  let slotNo = 1;
  while (used.has(slotNo)) slotNo++;
  if (slotNo > limit) throw new Error('PUBLICATION_QUOTA_EXHAUSTED');

  const budget = await env.DB.prepare(
    `SELECT version,state FROM publication_storage_budget WHERE singleton_id=1`,
  ).first<{ version: number; state: string }>();
  if (!budget || budget.state !== 'active') throw new Error('PUBLICATION_BUDGET_NOT_ACTIVE');

  const reservationToken = randomHex32();
  const attemptKey = randomHex32();
  const publicationId = randomHex32();
  const manifest = await canonicalForReservation(input, attemptKey, slotNo);
  const fields = normalizedReleaseFields(input);
  const nowMs = Date.now();
  const reservation = env.DB.prepare(
    `INSERT INTO publication_reservations(
      reservation_token,publication_date,publication_type,slot_no,business_revision_id,
      attempt_key,manifest_digest,object_count,vtt_present,reserved_bytes,budget_version_before,
      state,created_at_ms,updated_at_ms
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,'reserved',?,?)`,
  ).bind(
    reservationToken, input.publication_date, input.publication_type, slotNo,
    input.business_revision_id, attemptKey, manifest.manifest_digest,
    manifest.object_count, manifest.vtt_present, manifest.total_size_bytes,
    budget.version, nowMs, nowMs,
  );
  const publication = env.DB.prepare(
    `INSERT INTO append_only_publications(
      publication_id,reservation_token,publication_date,publication_type,slot_no,
      business_revision_id,attempt_key,manifest_digest,metadata_json,formal_news_item_ids,
      formal_guard_expected_json,review_batch_json,video_mode,bound_video_publication_id,
      bound_video_digest,base_release_generation,base_page_publication_id,
      base_video_publication_id,base_video_digest,state,created_at_ms,updated_at_ms
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'reserved',?,?)`,
  ).bind(
    publicationId, reservationToken, input.publication_date, input.publication_type,
    slotNo, input.business_revision_id, attemptKey, manifest.manifest_digest,
    fields.metadata_json, fields.formal_news_item_ids, fields.formal_guard_expected_json,
    fields.review_batch_json, fields.video_mode, fields.bound_video_publication_id,
    fields.bound_video_digest, fields.base_release_generation, fields.base_page_publication_id,
    fields.base_video_publication_id, fields.base_video_digest, nowMs, nowMs,
  );
  const objectStatements = manifest.objects.map((object) => env.DB.prepare(
    `INSERT INTO append_only_publication_objects(
      object_id,reservation_token,publication_id,publication_date,publication_type,slot_no,
      business_revision_id,attempt_key,object_role,r2_key,sha256,size_bytes,mime,tuple_digest,
      state,created_at_ms,updated_at_ms
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'reserved',?,?)`,
  ).bind(
    randomHex32(), reservationToken, publicationId, input.publication_date,
    input.publication_type, slotNo, input.business_revision_id, attemptKey,
    object.object_role, object.r2_key, object.sha256, object.size_bytes,
    object.mime, object.tuple_digest, nowMs, nowMs,
  ));
  const commit = env.DB.prepare(
    `INSERT INTO publication_manifest_commits(
      reservation_token,publication_id,manifest_digest,object_count,total_size_bytes,committed_at_ms
    ) VALUES(?,?,?,?,?,?)`,
  ).bind(
    reservationToken, publicationId, manifest.manifest_digest,
    manifest.object_count, manifest.total_size_bytes, nowMs,
  );
  const statements = [reservation, publication, ...objectStatements, commit];
  for (let transactionAttempt = 0; transactionAttempt < 2; transactionAttempt++) {
    try {
      await env.DB.batch(statements);
      return {
        status: 'reserved',
        reservation: {
          reservation_token: reservationToken,
          publication_id: publicationId,
          publication_date: input.publication_date,
          publication_type: input.publication_type,
          slot_no: slotNo,
          business_revision_id: input.business_revision_id,
          attempt_key: attemptKey,
          manifest,
        },
      };
    } catch (error) {
      const winner = await loadExistingReservation(env.DB, input);
      if (winner) return { status: 'replayed', reservation: await replayExisting(winner, input) };

      const currentSlots = await env.DB.prepare(
        `SELECT slot_no FROM publication_reservations
          WHERE publication_date=? AND publication_type=? ORDER BY slot_no`,
      ).bind(input.publication_date, input.publication_type).all<{ slot_no: number }>();
      const currentUsed = new Set((currentSlots.results || []).map((row) => Number(row.slot_no)));
      if (currentUsed.size >= limit) {
        throw new Error('PUBLICATION_QUOTA_EXHAUSTED', { cause: error });
      }
      const currentBudget = await env.DB.prepare(
        `SELECT version,state FROM publication_storage_budget WHERE singleton_id=1`,
      ).first<{ version: number; state: string }>();
      const unchangedAllocationState = currentBudget?.state === 'active'
        && Number(currentBudget.version) === Number(budget.version);
      if (transactionAttempt === 0 && unchangedAllocationState) {
        // D1 may return an unknown outcome after rolling the transaction back.
        // Reusing the already-built statements preserves token/slot/attempt/object tuples.
        continue;
      }
      const message = String(error);
      if (currentUsed.has(slotNo)
        || /slot_no|PUBLICATION_BUDGET|UNIQUE constraint|constraint failed/i.test(message)
        || !unchangedAllocationState) {
        throw new Error('PUBLICATION_QUOTA_OR_BUDGET_CONTENTION', { cause: error });
      }
      throw error;
    }
  }
  throw new Error('PUBLICATION_RESERVATION_UNREACHABLE');
}
