/** D1 release-head linearization and full-byte publication verification. */

import type { Env } from '../index';
import type { DailyVideoRow } from './daily-video';
import {
  authorizeFormalNewsSet,
  buildFormalNewsRegistryJson,
  formalNewsFinalGuardBindings,
  formalNewsFinalGuardSqlPredicate,
  formalNewsStoredSnapshotFinalGuardSqlPredicate,
} from './news-source-policy';
import {
  buildPublicationManifest,
  canonicalPublicationJson,
  canonicalizePublicationObject,
  type CanonicalPublicationManifest,
  type CanonicalPublicationObject,
  type PublicationObjectRole,
  type PublicationType,
} from './publication-canonical';
import {
  putImmutablePublicationObject,
  type PublicationR2Bucket,
  type ReservedAppendOnlyPublication,
} from './publication-storage';

interface PublicationR2Body {
  size?: number;
  customMetadata?: Record<string, string>;
  httpMetadata?: { contentType?: string };
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface PublicationReadBucket extends PublicationR2Bucket {
  get(key: string): Promise<PublicationR2Body | null>;
}

export interface PublicationReleaseEnv extends Pick<Env, 'DB'> {
  READMES?: PublicationReadBucket;
}

interface PublicationRow {
  publication_id: string;
  reservation_token: string;
  publication_date: string;
  publication_type: PublicationType;
  slot_no: number;
  business_revision_id: string;
  attempt_key: string;
  manifest_digest: string;
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
  state: string;
}

interface PublicationObjectRow {
  object_id: string;
  publication_id: string;
  publication_date: string;
  publication_type: PublicationType;
  slot_no: number;
  business_revision_id: string;
  attempt_key: string;
  object_role: PublicationObjectRole;
  r2_key: string;
  sha256: string;
  size_bytes: number;
  mime: string;
  tuple_digest: string;
  state: string;
}

interface ReleaseHeadRow {
  date: string;
  release_generation: number;
  page_publication_id: string;
  video_publication_id: string | null;
  video_mode: 'none' | 'reuse_current' | 'joint_new';
  page_manifest_digest: string;
  video_manifest_digest: string | null;
  promoted_at_ms: number;
}

interface PublicationGraph {
  publication: PublicationRow;
  objects: PublicationObjectRow[];
}

export interface DailyReleaseResult extends ReleaseHeadRow {
  status: 'published' | 'replayed';
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string')) return parsed;
  } catch {
    // fail below
  }
  throw new Error('PUBLICATION_FORMAL_IDS_MALFORMED');
}

function exactChanges(result: D1Result<unknown>): number {
  return Number(result.meta?.changes || 0);
}

async function loadPublicationGraph(db: D1Database, publicationId: string): Promise<PublicationGraph> {
  const publication = await db.prepare(
    `SELECT * FROM append_only_publications WHERE publication_id=?`,
  ).bind(publicationId).first<PublicationRow>();
  if (!publication) throw new Error('PUBLICATION_NOT_FOUND');
  const result = await db.prepare(
    `SELECT object_id,publication_id,publication_date,publication_type,slot_no,
            business_revision_id,attempt_key,object_role,r2_key,sha256,size_bytes,
            mime,tuple_digest,state
       FROM append_only_publication_objects
      WHERE publication_id=? ORDER BY CASE object_role
        WHEN 'html' THEN 0 WHEN 'mp4' THEN 0 WHEN 'poster' THEN 1 ELSE 2 END`,
  ).bind(publicationId).all<PublicationObjectRow>();
  const objects = result.results || [];
  if (!objects.length) throw new Error('PUBLICATION_OBJECTS_MISSING');
  return { publication, objects };
}

function expectedObject(row: PublicationObjectRow): CanonicalPublicationObject {
  const canonicalValue = {
    schema_version: 1 as const,
    r2_key: row.r2_key.normalize('NFC'),
    business_revision_id: row.business_revision_id,
    attempt_key: row.attempt_key,
    object_role: row.object_role,
    sha256: row.sha256,
    size_bytes: Number(row.size_bytes),
    mime: row.mime.normalize('NFC'),
  };
  return {
    ...canonicalValue,
    tuple_digest: row.tuple_digest,
    canonical_json: JSON.stringify(canonicalValue),
  };
}

function headMatchesExpected(
  head: Awaited<ReturnType<PublicationR2Bucket['head']>>,
  expected: CanonicalPublicationObject,
): boolean {
  if (!head) return false;
  const metadata = head.customMetadata || {};
  return head.size === expected.size_bytes
    && (!head.key || head.key === expected.r2_key)
    && head.httpMetadata?.contentType === expected.mime
    && metadata.schema_version === '1'
    && metadata.business_revision_id === expected.business_revision_id
    && metadata.attempt_key === expected.attempt_key
    && metadata.object_role === expected.object_role
    && metadata.sha256 === expected.sha256
    && metadata.size_bytes === String(expected.size_bytes)
    && metadata.mime === expected.mime
    && metadata.tuple_digest === expected.tuple_digest;
}

async function readAndVerifyGraph(
  bucket: PublicationReadBucket,
  graph: PublicationGraph,
): Promise<{ manifest: CanonicalPublicationManifest; bytes: Map<PublicationObjectRole, Uint8Array> }> {
  const canonicalObjects: CanonicalPublicationObject[] = [];
  const bytesByRole = new Map<PublicationObjectRole, Uint8Array>();
  for (const row of graph.objects) {
    const expected = expectedObject(row);
    const head = await bucket.head(row.r2_key);
    if (!headMatchesExpected(head, expected)) throw new Error('PUBLICATION_R2_INTEGRITY_MISMATCH');
    if (Number(head!.size) > Number(row.size_bytes)) throw new Error('PUBLICATION_R2_SIZE_LIMIT_MISMATCH');
    const body = await bucket.get(row.r2_key);
    if (!body) throw new Error('PUBLICATION_R2_OBJECT_MISSING');
    const raw = await body.arrayBuffer();
    if (raw.byteLength !== Number(row.size_bytes)) throw new Error('PUBLICATION_R2_SIZE_MISMATCH');
    const actual = await canonicalizePublicationObject(expected, raw);
    if (actual.sha256 !== expected.sha256
      || actual.tuple_digest !== expected.tuple_digest
      || actual.canonical_json !== expected.canonical_json) {
      throw new Error('PUBLICATION_R2_DIGEST_MISMATCH');
    }
    canonicalObjects.push(actual);
    bytesByRole.set(row.object_role, new Uint8Array(raw));
  }
  const manifest = await buildPublicationManifest({
    schema_version: 1,
    publication_date: graph.publication.publication_date,
    publication_type: graph.publication.publication_type,
    slot_no: Number(graph.publication.slot_no),
    business_revision_id: graph.publication.business_revision_id,
    attempt_key: graph.publication.attempt_key,
    vtt_present: canonicalObjects.some((object) => object.object_role === 'vtt') ? 1 : 0,
    objects: canonicalObjects,
  });
  if (manifest.manifest_digest !== graph.publication.manifest_digest) {
    throw new Error('PUBLICATION_MANIFEST_DIGEST_MISMATCH');
  }
  return { manifest, bytes: bytesByRole };
}

async function markState(
  db: D1Database,
  table: 'publication_reservations' | 'append_only_publications',
  idColumn: 'reservation_token' | 'publication_id',
  id: string,
  fromStates: readonly string[],
  state: string,
): Promise<void> {
  const placeholders = fromStates.map(() => '?').join(',');
  const result = await db.prepare(
    `UPDATE ${table} SET state=?,updated_at_ms=?
      WHERE ${idColumn}=? AND state IN (${placeholders})`,
  ).bind(state, Date.now(), id, ...fromStates).run();
  if (exactChanges(result) !== 1) {
    const current = await db.prepare(`SELECT state FROM ${table} WHERE ${idColumn}=?`)
      .bind(id).first<{ state: string }>();
    if (current?.state !== state) throw new Error('PUBLICATION_STATE_CAS_FAILED');
  }
}

export async function materializeAppendOnlyPublication(
  env: PublicationReleaseEnv,
  reservation: ReservedAppendOnlyPublication,
  actualBytes: Partial<Record<PublicationObjectRole, Uint8Array | ArrayBuffer>>,
): Promise<void> {
  if (!env.READMES) throw new Error('PUBLICATION_R2_NOT_CONFIGURED');
  let graph = await loadPublicationGraph(env.DB, reservation.publication_id);
  if (graph.publication.reservation_token !== reservation.reservation_token
    || graph.publication.manifest_digest !== reservation.manifest.manifest_digest) {
    throw new Error('PUBLICATION_RESERVATION_GRAPH_MISMATCH');
  }
  const canonicalObjects: CanonicalPublicationObject[] = [];
  for (const row of graph.objects) {
    const bytes = actualBytes[row.object_role];
    if (!bytes) throw new Error(`PUBLICATION_LOCAL_BYTES_MISSING:${row.object_role}`);
    const actual = await canonicalizePublicationObject(expectedObject(row), bytes);
    const expected = expectedObject(row);
    if (actual.sha256 !== expected.sha256
      || actual.size_bytes !== expected.size_bytes
      || actual.tuple_digest !== expected.tuple_digest
      || actual.canonical_json !== expected.canonical_json) {
      throw new Error('PUT_BOUNDARY_DIGEST_MISMATCH');
    }
    canonicalObjects.push(actual);
  }
  const manifest = await buildPublicationManifest({
    schema_version: 1,
    publication_date: graph.publication.publication_date,
    publication_type: graph.publication.publication_type,
    slot_no: Number(graph.publication.slot_no),
    business_revision_id: graph.publication.business_revision_id,
    attempt_key: graph.publication.attempt_key,
    vtt_present: canonicalObjects.some((object) => object.object_role === 'vtt') ? 1 : 0,
    objects: canonicalObjects,
  });
  if (manifest.manifest_digest !== graph.publication.manifest_digest) {
    throw new Error('PUT_BOUNDARY_MANIFEST_MISMATCH');
  }

  await markState(env.DB, 'publication_reservations', 'reservation_token', reservation.reservation_token,
    ['reserved', 'put_pending', 'put_unknown'], 'put_pending');
  await markState(env.DB, 'append_only_publications', 'publication_id', reservation.publication_id,
    ['reserved', 'put_pending', 'put_unknown'], 'put_pending');

  try {
    for (const object of canonicalObjects) {
      const row = graph.objects.find((entry) => entry.object_role === object.object_role)!;
      const claimed = await env.DB.prepare(
        `UPDATE append_only_publication_objects SET state='put_pending',updated_at_ms=?
          WHERE object_id=? AND publication_id=? AND state IN ('reserved','put_pending','put_unknown')`,
      ).bind(Date.now(), row.object_id, graph.publication.publication_id).run();
      if (exactChanges(claimed) !== 1 && row.state !== 'put_verified') {
        const current = await env.DB.prepare(`SELECT state FROM append_only_publication_objects WHERE object_id=?`)
          .bind(row.object_id).first<{ state: string }>();
        if (current?.state !== 'put_verified') throw new Error('PUBLICATION_OBJECT_STATE_CAS_FAILED');
      }
      await putImmutablePublicationObject(env.READMES, object, actualBytes[object.object_role]!);
    }
  } catch (error) {
    await env.DB.prepare(
      `UPDATE append_only_publication_objects SET state='put_unknown',updated_at_ms=?
        WHERE publication_id=? AND state='put_pending'`,
    ).bind(Date.now(), reservation.publication_id).run();
    await env.DB.prepare(
      `UPDATE append_only_publications SET state='put_unknown',updated_at_ms=?
        WHERE publication_id=? AND state='put_pending'`,
    ).bind(Date.now(), reservation.publication_id).run();
    await env.DB.prepare(
      `UPDATE publication_reservations SET state='put_unknown',updated_at_ms=?
        WHERE reservation_token=? AND state='put_pending'`,
    ).bind(Date.now(), reservation.reservation_token).run();
    throw error;
  }

  graph = await loadPublicationGraph(env.DB, reservation.publication_id);
  await readAndVerifyGraph(env.READMES, graph);
  const now = Date.now();
  const objectFinalize = await env.DB.prepare(
    `UPDATE append_only_publication_objects
        SET state='put_verified',verified_at_ms=?,updated_at_ms=?
      WHERE publication_id=? AND state IN ('put_pending','put_unknown','put_verified')`,
  ).bind(now, now, reservation.publication_id).run();
  if (exactChanges(objectFinalize) !== graph.objects.length) {
    const remaining = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM append_only_publication_objects
        WHERE publication_id=? AND state<>'put_verified'`,
    ).bind(reservation.publication_id).first<{ count: number }>();
    if (Number(remaining?.count || 0) !== 0) throw new Error('PUBLICATION_OBJECT_FINALIZE_FAILED');
  }
  await markState(env.DB, 'append_only_publications', 'publication_id', reservation.publication_id,
    ['put_pending', 'put_unknown', 'put_verified'], 'put_verified');
  await markState(env.DB, 'publication_reservations', 'reservation_token', reservation.reservation_token,
    ['put_pending', 'put_unknown', 'put_verified'], 'put_verified');
}

async function loadHead(db: D1Database, date: string): Promise<ReleaseHeadRow | null> {
  return db.prepare(`SELECT * FROM daily_release_heads WHERE date=?`).bind(date).first<ReleaseHeadRow>();
}

const REVIEW_BATCH_GUARD = `(
  (? IS NULL AND NOT EXISTS (
    SELECT 1 FROM daily_news_review_batches rb0
     WHERE rb0.review_date=p.publication_date AND rb0.lineage_id=p.publication_date
       AND rb0.is_current=1 AND rb0.applied_selected_ids IS NOT NULL
  ))
  OR
  (? IS NOT NULL AND EXISTS (
    SELECT 1 FROM daily_news_review_batches rb
     WHERE rb.review_date=p.publication_date AND rb.lineage_id=p.publication_date
       AND rb.batch_id=json_extract(?, '$.batch_id')
       AND rb.batch_revision=json_extract(?, '$.batch_revision')
       AND rb.is_current=json_extract(?, '$.is_current')
       AND rb.edit_revision=json_extract(?, '$.edit_revision')
       AND rb.candidate_generation=json_extract(?, '$.candidate_generation')
       AND rb.candidate_ids=json_extract(?, '$.candidate_ids_json')
       AND rb.default_selected_ids=json_extract(?, '$.default_selected_ids_json')
       AND COALESCE(rb.applied_selected_ids,'')=json_extract(?, '$.applied_selected_ids_json')
       AND COALESCE(rb.selection_hash,'')=json_extract(?, '$.selection_hash')
       AND rb.superseded_by IS json_extract(?, '$.superseded_by')
  ))
)`;

function reviewBindings(json: string | null): unknown[] {
  return Array.from({ length: 12 }, () => json);
}

function storedReviewBatchGuardSqlPredicate(): string {
  const reviewType = `CASE WHEN json_valid(p.review_batch_json)=1
    THEN json_type(p.review_batch_json) ELSE NULL END`;
  const safeReview = `CASE WHEN ${reviewType}='object'
    THEN p.review_batch_json ELSE '{}' END`;
  return `(
    (p.review_batch_json IS NULL AND NOT EXISTS (
      SELECT 1 FROM daily_news_review_batches rb0
       WHERE rb0.review_date=p.publication_date AND rb0.lineage_id=p.publication_date
         AND rb0.is_current=1 AND rb0.applied_selected_ids IS NOT NULL
    ))
    OR
    (p.review_batch_json IS NOT NULL AND ${reviewType}='object' AND EXISTS (
      SELECT 1 FROM daily_news_review_batches rb
       WHERE rb.review_date=p.publication_date AND rb.lineage_id=p.publication_date
         AND rb.batch_id=json_extract(${safeReview}, '$.batch_id')
         AND rb.batch_revision=json_extract(${safeReview}, '$.batch_revision')
         AND rb.is_current=json_extract(${safeReview}, '$.is_current')
         AND rb.edit_revision=json_extract(${safeReview}, '$.edit_revision')
         AND rb.candidate_generation=json_extract(${safeReview}, '$.candidate_generation')
         AND rb.candidate_ids=json_extract(${safeReview}, '$.candidate_ids_json')
         AND rb.default_selected_ids=json_extract(${safeReview}, '$.default_selected_ids_json')
         AND COALESCE(rb.applied_selected_ids,'')=json_extract(${safeReview}, '$.applied_selected_ids_json')
         AND COALESCE(rb.selection_hash,'')=json_extract(${safeReview}, '$.selection_hash')
         AND rb.superseded_by IS json_extract(${safeReview}, '$.superseded_by')
    ))
  )`;
}

async function exactFormalAuthorization(env: PublicationReleaseEnv, publication: PublicationRow) {
  const ids = parseStringArray(publication.formal_news_item_ids);
  const authorization = await authorizeFormalNewsSet(
    env as Env, publication.publication_date, ids, 'daily_release_final_guard',
  );
  let currentExpected = '';
  try {
    currentExpected = canonicalPublicationJson(JSON.parse(authorization.final_guard?.expected_json || 'null'));
  } catch {
    currentExpected = '';
  }
  if (JSON.stringify(authorization.allowed_ids) !== JSON.stringify(ids)
    || currentExpected !== publication.formal_guard_expected_json) {
    throw new Error('PUBLICATION_FORMAL_AUTHORIZATION_STALE');
  }
  return authorization;
}

function publicationReadyPredicate(): string {
  return `EXISTS (
    SELECT 1 FROM append_only_publications p2
     WHERE p2.publication_id=p.publication_id AND p2.state='put_verified'
       AND NOT EXISTS (SELECT 1 FROM append_only_publication_objects o2
         WHERE o2.publication_id=p2.publication_id AND o2.state<>'put_verified')
  )`;
}

async function finalizeRelease(
  db: D1Database,
  head: ReleaseHeadRow,
  page: PublicationRow,
): Promise<void> {
  const now = Date.now();
  await db.prepare(
    `UPDATE append_only_publications SET state='published',published_at_ms=?,updated_at_ms=?
      WHERE publication_id=? AND state IN ('put_verified','published')
        AND EXISTS (SELECT 1 FROM daily_release_heads h WHERE h.date=?
          AND h.release_generation=? AND h.page_publication_id=?
          AND h.video_publication_id IS ? AND h.video_mode=?
          AND h.page_manifest_digest=? AND h.video_manifest_digest IS ?)`,
  ).bind(
    now, now, page.publication_id, head.date, head.release_generation,
    page.publication_id, head.video_publication_id, head.video_mode,
    head.page_manifest_digest, head.video_manifest_digest,
  ).run();
  await db.prepare(
    `UPDATE append_only_publication_objects SET state='publication_bound',updated_at_ms=?
      WHERE publication_id=? AND state IN ('put_verified','publication_bound')
        AND EXISTS (SELECT 1 FROM daily_release_heads h WHERE h.date=?
          AND h.release_generation=? AND h.page_publication_id=?)`,
  ).bind(now, page.publication_id, head.date, head.release_generation, page.publication_id).run();
  await db.prepare(
    `UPDATE publication_reservations SET state='published',updated_at_ms=?
      WHERE reservation_token=? AND state IN ('put_verified','published')
        AND EXISTS (SELECT 1 FROM daily_release_heads h WHERE h.date=?
          AND h.release_generation=? AND h.page_publication_id=?)`,
  ).bind(now, page.reservation_token, head.date, head.release_generation, page.publication_id).run();

  if (head.video_mode === 'joint_new' && head.video_publication_id) {
    await db.prepare(
      `UPDATE append_only_publications SET state='published',published_at_ms=?,updated_at_ms=?
        WHERE publication_id=? AND publication_type='video' AND state IN ('put_verified','published')
          AND manifest_digest=? AND EXISTS (SELECT 1 FROM daily_release_heads h
            WHERE h.date=? AND h.release_generation=? AND h.page_publication_id=?
              AND h.video_publication_id=? AND h.video_mode='joint_new')`,
    ).bind(now, now, head.video_publication_id, head.video_manifest_digest,
      head.date, head.release_generation, page.publication_id, head.video_publication_id).run();
    await db.prepare(
      `UPDATE append_only_publication_objects SET state='publication_bound',updated_at_ms=?
        WHERE publication_id=? AND state IN ('put_verified','publication_bound')
          AND EXISTS (SELECT 1 FROM daily_release_heads h WHERE h.date=?
            AND h.release_generation=? AND h.video_publication_id=? AND h.video_mode='joint_new')`,
    ).bind(now, head.video_publication_id, head.date, head.release_generation,
      head.video_publication_id).run();
    await db.prepare(
      `UPDATE publication_reservations SET state='published',updated_at_ms=?
        WHERE reservation_token=(SELECT reservation_token FROM append_only_publications WHERE publication_id=?)
          AND state IN ('put_verified','published')`,
    ).bind(now, head.video_publication_id).run();
  }
}

async function completeHead(db: D1Database, expected: ReleaseHeadRow): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 AS ok FROM daily_release_heads h
      JOIN append_only_publications p ON p.publication_id=h.page_publication_id
     WHERE h.date=? AND h.release_generation=? AND h.page_publication_id=?
       AND h.video_publication_id IS ? AND h.video_mode=?
       AND h.page_manifest_digest=? AND h.video_manifest_digest IS ?
       AND p.state='published'
       AND NOT EXISTS (SELECT 1 FROM append_only_publication_objects po
         WHERE po.publication_id=p.publication_id AND po.state<>'publication_bound')
       AND (h.video_publication_id IS NULL OR EXISTS (
         SELECT 1 FROM append_only_publications v
          WHERE v.publication_id=h.video_publication_id AND v.state='published'
            AND v.manifest_digest=h.video_manifest_digest
            AND NOT EXISTS (SELECT 1 FROM append_only_publication_objects vo
              WHERE vo.publication_id=v.publication_id AND vo.state<>'publication_bound')))`,
  ).bind(
    expected.date, expected.release_generation, expected.page_publication_id,
    expected.video_publication_id, expected.video_mode, expected.page_manifest_digest,
    expected.video_manifest_digest,
  ).first<{ ok: number }>();
  return Number(row?.ok || 0) === 1;
}

function isExactHead(actual: ReleaseHeadRow, expected: ReleaseHeadRow): boolean {
  return actual !== null
    && actual.date === expected.date
    && Number(actual.release_generation) === Number(expected.release_generation)
    && actual.page_publication_id === expected.page_publication_id
    && actual.video_publication_id === expected.video_publication_id
    && actual.video_mode === expected.video_mode
    && actual.page_manifest_digest === expected.page_manifest_digest
    && actual.video_manifest_digest === expected.video_manifest_digest;
}

async function replayFinalGuard(
  env: PublicationReleaseEnv,
  expected: ReleaseHeadRow,
  page: PublicationRow,
  authorization: Awaited<ReturnType<typeof exactFormalAuthorization>>,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `/* daily_release:head_replay_final_guard */ SELECT 1 AS ok
       FROM daily_release_heads h
       JOIN append_only_publications p ON p.publication_id=h.page_publication_id
      WHERE h.date=? AND h.release_generation=? AND h.page_publication_id=?
        AND h.video_publication_id IS ? AND h.video_mode=?
        AND h.page_manifest_digest=? AND h.video_manifest_digest IS ?
        AND p.publication_date=h.date AND p.publication_type='page'
        AND p.manifest_digest=h.page_manifest_digest
        AND p.state IN ('put_verified','published')
        AND NOT EXISTS (SELECT 1 FROM append_only_publication_objects po
          WHERE po.publication_id=p.publication_id
            AND po.state NOT IN ('put_verified','publication_bound'))
        AND (h.video_publication_id IS NULL OR EXISTS (
          SELECT 1 FROM append_only_publications v
           WHERE v.publication_id=h.video_publication_id AND v.publication_date=h.date
             AND v.publication_type='video' AND v.manifest_digest=h.video_manifest_digest
             AND v.state IN ('put_verified','published')
             AND NOT EXISTS (SELECT 1 FROM append_only_publication_objects vo
               WHERE vo.publication_id=v.publication_id
                 AND vo.state NOT IN ('put_verified','publication_bound'))))
        AND ${REVIEW_BATCH_GUARD} AND ${formalNewsFinalGuardSqlPredicate()}`,
  ).bind(
    expected.date, expected.release_generation, expected.page_publication_id,
    expected.video_publication_id, expected.video_mode, expected.page_manifest_digest,
    expected.video_manifest_digest, ...reviewBindings(page.review_batch_json),
    ...formalNewsFinalGuardBindings(authorization),
  ).first<{ ok: number }>();
  return Number(row?.ok || 0) === 1;
}

export async function promoteDailyRelease(
  env: PublicationReleaseEnv,
  pagePublicationId: string,
): Promise<DailyReleaseResult> {
  if (!env.READMES) throw new Error('PUBLICATION_R2_NOT_CONFIGURED');
  const pageGraph = await loadPublicationGraph(env.DB, pagePublicationId);
  const page = pageGraph.publication;
  if (page.publication_type !== 'page'
    || !['put_verified', 'published'].includes(page.state)
    || !page.video_mode) {
    throw new Error('PUBLICATION_PAGE_NOT_READY');
  }
  await readAndVerifyGraph(env.READMES, pageGraph);
  let video: PublicationGraph | null = null;
  if (page.video_mode !== 'none') {
    if (!page.bound_video_publication_id || !page.bound_video_digest) {
      throw new Error('PUBLICATION_VIDEO_BINDING_MISSING');
    }
    video = await loadPublicationGraph(env.DB, page.bound_video_publication_id);
    if (video.publication.manifest_digest !== page.bound_video_digest) {
      throw new Error('PUBLICATION_VIDEO_BINDING_STALE');
    }
    await readAndVerifyGraph(env.READMES, video);
  }
  const authorization = await exactFormalAuthorization(env, page);
  const formalPredicate = formalNewsFinalGuardSqlPredicate();
  const formalBindings = formalNewsFinalGuardBindings(authorization);
  const current = await loadHead(env.DB, page.publication_date);
  const next: ReleaseHeadRow = {
    date: page.publication_date,
    release_generation: Number(page.base_release_generation) + 1,
    page_publication_id: page.publication_id,
    video_publication_id: page.bound_video_publication_id,
    video_mode: page.video_mode,
    page_manifest_digest: page.manifest_digest,
    video_manifest_digest: page.bound_video_digest,
    promoted_at_ms: Date.now(),
  };
  if (current && isExactHead(current, next)) {
    if (!await replayFinalGuard(env, current, page, authorization)) {
      throw new Error('PUBLICATION_RELEASE_HEAD_STALE');
    }
    await finalizeRelease(env.DB, current, page);
    if (!await completeHead(env.DB, current)) throw new Error('PUBLICATION_RELEASE_FINALIZE_INCOMPLETE');
    return { ...current, status: 'replayed' };
  }
  if (page.state !== 'put_verified') throw new Error('PUBLICATION_PAGE_NOT_READY');
  if (Number(page.base_release_generation) === 0 ? current !== null : (
    !current
    || Number(current.release_generation) !== Number(page.base_release_generation)
    || current.page_publication_id !== page.base_page_publication_id
    || current.video_publication_id !== page.base_video_publication_id
    || current.video_manifest_digest !== page.base_video_digest
  )) throw new Error('PUBLICATION_BASE_RELEASE_STALE');
  if (page.video_mode === 'none' && current?.video_publication_id) {
    throw new Error('PUBLICATION_NONE_CANNOT_REMOVE_VIDEO');
  }
  if (page.video_mode === 'reuse_current' && (
    !current?.video_publication_id
    || current.video_publication_id !== page.bound_video_publication_id
    || current.video_manifest_digest !== page.bound_video_digest
    || video?.publication.state !== 'published'
  )) throw new Error('PUBLICATION_REUSE_VIDEO_STALE');
  if (page.video_mode === 'joint_new' && video?.publication.state !== 'put_verified') {
    throw new Error('PUBLICATION_JOINT_VIDEO_NOT_READY');
  }
  let changed = 0;
  if (!current) {
    const result = await env.DB.prepare(
      `/* daily_release:head_insert_final_guard */
       INSERT INTO daily_release_heads(
         date,release_generation,page_publication_id,video_publication_id,video_mode,
         page_manifest_digest,video_manifest_digest,promoted_at_ms
       ) SELECT ?,?,?,?,?,?,?,?
        FROM append_only_publications p
       WHERE p.publication_id=? AND p.publication_date=? AND p.publication_type='page'
         AND p.manifest_digest=? AND p.base_release_generation=0
         AND p.base_page_publication_id IS NULL AND p.base_video_publication_id IS NULL
         AND p.base_video_digest IS NULL AND p.video_mode=?
         AND p.bound_video_publication_id IS ? AND p.bound_video_digest IS ?
         AND ${publicationReadyPredicate()}
         AND NOT EXISTS (SELECT 1 FROM daily_release_heads WHERE date=p.publication_date)
         AND ${REVIEW_BATCH_GUARD} AND ${formalPredicate}`,
    ).bind(
      next.date, next.release_generation, next.page_publication_id, next.video_publication_id,
      next.video_mode, next.page_manifest_digest, next.video_manifest_digest, next.promoted_at_ms,
      page.publication_id, page.publication_date, page.manifest_digest, page.video_mode,
      page.bound_video_publication_id, page.bound_video_digest,
      ...reviewBindings(page.review_batch_json), ...formalBindings,
    ).run();
    changed = exactChanges(result);
  } else {
    const result = await env.DB.prepare(
      `/* daily_release:head_update_final_guard */
       UPDATE daily_release_heads SET release_generation=?,page_publication_id=?,
         video_publication_id=?,video_mode=?,page_manifest_digest=?,video_manifest_digest=?,
         promoted_at_ms=?
       WHERE date=? AND release_generation=? AND page_publication_id=?
         AND video_publication_id IS ? AND video_manifest_digest IS ?
         AND EXISTS (SELECT 1 FROM append_only_publications p
           WHERE p.publication_id=? AND p.publication_date=? AND p.publication_type='page'
             AND p.manifest_digest=? AND p.base_release_generation=?
             AND p.base_page_publication_id=? AND p.base_video_publication_id IS ?
             AND p.base_video_digest IS ? AND p.video_mode=?
             AND p.bound_video_publication_id IS ? AND p.bound_video_digest IS ?
             AND ${publicationReadyPredicate()}
             AND ${REVIEW_BATCH_GUARD} AND ${formalPredicate})`,
    ).bind(
      next.release_generation, next.page_publication_id, next.video_publication_id,
      next.video_mode, next.page_manifest_digest, next.video_manifest_digest,
      next.promoted_at_ms, current.date, current.release_generation,
      current.page_publication_id, current.video_publication_id, current.video_manifest_digest,
      page.publication_id, page.publication_date, page.manifest_digest,
      page.base_release_generation, page.base_page_publication_id,
      page.base_video_publication_id, page.base_video_digest, page.video_mode,
      page.bound_video_publication_id, page.bound_video_digest,
      ...reviewBindings(page.review_batch_json), ...formalBindings,
    ).run();
    changed = exactChanges(result);
  }
  if (changed !== 1) {
    const authoritative = await loadHead(env.DB, page.publication_date);
    if (!authoritative
      || authoritative.release_generation !== next.release_generation
      || authoritative.page_publication_id !== next.page_publication_id
      || authoritative.video_publication_id !== next.video_publication_id
      || authoritative.page_manifest_digest !== next.page_manifest_digest
      || authoritative.video_manifest_digest !== next.video_manifest_digest) {
      throw new Error('PUBLICATION_RELEASE_HEAD_STALE');
    }
  }
  await finalizeRelease(env.DB, next, page);
  if (!await completeHead(env.DB, next)) throw new Error('PUBLICATION_RELEASE_FINALIZE_INCOMPLETE');
  return { ...next, status: changed === 1 ? 'published' : 'replayed' };
}

async function finalOutwardGuard(
  env: PublicationReleaseEnv,
  head: ReleaseHeadRow,
  page: PublicationRow,
): Promise<void> {
  const authorization = await exactFormalAuthorization(env, page);
  const result = await env.DB.prepare(
    `/* daily_release:outward_final_guard */ SELECT 1 AS ok
       FROM daily_release_heads h
       JOIN append_only_publications p ON p.publication_id=h.page_publication_id
      WHERE h.date=? AND h.release_generation=? AND h.page_publication_id=?
        AND h.video_publication_id IS ? AND h.video_mode=?
        AND h.page_manifest_digest=? AND h.video_manifest_digest IS ?
        AND p.state='published' AND p.publication_date=h.date
        AND p.manifest_digest=h.page_manifest_digest
        AND p.bound_video_publication_id IS h.video_publication_id
        AND p.bound_video_digest IS h.video_manifest_digest
        AND NOT EXISTS (SELECT 1 FROM append_only_publication_objects po
          WHERE po.publication_id=p.publication_id AND po.state<>'publication_bound')
        AND (h.video_publication_id IS NULL OR EXISTS (
          SELECT 1 FROM append_only_publications v
           WHERE v.publication_id=h.video_publication_id AND v.publication_date=h.date
             AND v.publication_type='video' AND v.state='published'
             AND v.manifest_digest=h.video_manifest_digest
             AND NOT EXISTS (SELECT 1 FROM append_only_publication_objects vo
               WHERE vo.publication_id=v.publication_id AND vo.state<>'publication_bound')))
        AND ${REVIEW_BATCH_GUARD} AND ${formalNewsFinalGuardSqlPredicate()}`,
  ).bind(
    head.date, head.release_generation, head.page_publication_id,
    head.video_publication_id, head.video_mode, head.page_manifest_digest,
    head.video_manifest_digest, ...reviewBindings(page.review_batch_json),
    ...formalNewsFinalGuardBindings(authorization),
  ).first<{ ok: number }>();
  if (Number(result?.ok || 0) !== 1) throw new Error('PUBLICATION_OUTWARD_AUTHORIZATION_STALE');
}

export async function readAuthorizedDailyPage(
  env: PublicationReleaseEnv,
  date: string,
): Promise<{ bytes: Uint8Array; release_generation: number; metadata: Record<string, unknown> }> {
  if (!env.READMES) throw new Error('PUBLICATION_R2_NOT_CONFIGURED');
  const head = await loadHead(env.DB, date);
  if (!head) throw new Error('PUBLICATION_RELEASE_NOT_FOUND');
  const pageGraph = await loadPublicationGraph(env.DB, head.page_publication_id);
  const verified = await readAndVerifyGraph(env.READMES, pageGraph);
  const bytes = verified.bytes.get('html');
  if (!bytes) throw new Error('PUBLICATION_PAGE_BYTES_MISSING');
  await finalOutwardGuard(env, head, pageGraph.publication);
  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(pageGraph.publication.metadata_json) as Record<string, unknown>;
  } catch {
    throw new Error('PUBLICATION_METADATA_MALFORMED');
  }
  return { bytes, release_generation: head.release_generation, metadata };
}

function publicationMetadata(publication: PublicationRow): Record<string, unknown> {
  try {
    const value = JSON.parse(publication.metadata_json);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // fail below
  }
  throw new Error('PUBLICATION_METADATA_MALFORMED');
}

function videoRowFromGraph(
  head: ReleaseHeadRow,
  graph: PublicationGraph,
): DailyVideoRow {
  if (!head.video_publication_id || graph.publication.publication_type !== 'video') {
    throw new Error('PUBLICATION_VIDEO_NOT_FOUND');
  }
  const metadata = publicationMetadata(graph.publication);
  const byRole = new Map(graph.objects.map((object) => [object.object_role, object]));
  const mp4 = byRole.get('mp4');
  const poster = byRole.get('poster');
  const vtt = byRole.get('vtt');
  if (!mp4 || !poster) throw new Error('PUBLICATION_VIDEO_OBJECTS_MISSING');
  const uploadedAt = typeof metadata.uploaded_at === 'string'
    ? metadata.uploaded_at
    : new Date(head.promoted_at_ms).toISOString();
  const updatedAt = typeof metadata.updated_at === 'string'
    ? metadata.updated_at
    : new Date(head.promoted_at_ms).toISOString();
  return {
    date: head.date,
    title: typeof metadata.title === 'string' ? metadata.title : '',
    description: typeof metadata.description === 'string' ? metadata.description : '',
    duration_seconds: Number(metadata.duration_millis || 0) / 1000,
    mp4_key: `daily-video/public/${head.video_publication_id}/mp4`,
    mp4_sha256: mp4.sha256,
    mp4_size: Number(mp4.size_bytes),
    poster_key: `daily-video/public/${head.video_publication_id}/poster`,
    poster_sha256: poster.sha256,
    poster_size: Number(poster.size_bytes),
    vtt_key: vtt ? `daily-video/public/${head.video_publication_id}/vtt` : '',
    vtt_sha256: vtt?.sha256 || '',
    vtt_size: Number(vtt?.size_bytes || 0),
    uploaded_at: uploadedAt,
    updated_at: updatedAt,
  };
}

export async function loadCurrentDailyReleaseForBuild(
  env: PublicationReleaseEnv,
  date: string,
): Promise<{
  head: ReleaseHeadRow;
  page_metadata: Record<string, unknown>;
  formal_news_item_ids: string[];
  formal_guard_expected: unknown[];
  review_batch: Record<string, unknown> | null;
  video: DailyVideoRow | null;
} | null> {
  const head = await loadHead(env.DB, date);
  if (!head) return null;
  const page = await loadPublicationGraph(env.DB, head.page_publication_id);
  if (!await completeHead(env.DB, head)) throw new Error('PUBLICATION_RELEASE_INCOMPLETE');
  const video = head.video_publication_id
    ? videoRowFromGraph(head, await loadPublicationGraph(env.DB, head.video_publication_id))
    : null;
  await finalOutwardGuard(env, head, page.publication);
  let formalGuardExpected: unknown[];
  let reviewBatch: Record<string, unknown> | null;
  try {
    const parsedExpected = JSON.parse(page.publication.formal_guard_expected_json);
    if (!Array.isArray(parsedExpected)) throw new Error('expected array');
    formalGuardExpected = parsedExpected as unknown[];
    const parsedReview = page.publication.review_batch_json === null
      ? null
      : JSON.parse(page.publication.review_batch_json);
    if (parsedReview !== null && (!parsedReview || typeof parsedReview !== 'object' || Array.isArray(parsedReview))) {
      throw new Error('expected object');
    }
    reviewBatch = parsedReview as Record<string, unknown> | null;
  } catch {
    throw new Error('PUBLICATION_RELEASE_GUARD_METADATA_MALFORMED');
  }
  return {
    head,
    page_metadata: publicationMetadata(page.publication),
    formal_news_item_ids: parseStringArray(page.publication.formal_news_item_ids),
    formal_guard_expected: formalGuardExpected,
    review_batch: reviewBatch,
    video,
  };
}

export async function readAuthorizedDailyVideo(
  env: PublicationReleaseEnv,
  date: string,
): Promise<{
  row: DailyVideoRow;
  bytes: Map<PublicationObjectRole, Uint8Array>;
  release_generation: number;
}> {
  if (!env.READMES) throw new Error('PUBLICATION_R2_NOT_CONFIGURED');
  const head = await loadHead(env.DB, date);
  if (!head?.video_publication_id) throw new Error('PUBLICATION_VIDEO_NOT_FOUND');
  const page = await loadPublicationGraph(env.DB, head.page_publication_id);
  const video = await loadPublicationGraph(env.DB, head.video_publication_id);
  const verified = await readAndVerifyGraph(env.READMES, video);
  await finalOutwardGuard(env, head, page.publication);
  return {
    row: videoRowFromGraph(head, video),
    bytes: verified.bytes,
    release_generation: head.release_generation,
  };
}

export async function readAuthorizedDailyVideoObject(
  env: PublicationReleaseEnv,
  videoPublicationId: string,
  role: 'mp4' | 'poster' | 'vtt',
): Promise<{ bytes: Uint8Array; mime: string; sha256: string; size: number }> {
  if (!env.READMES) throw new Error('PUBLICATION_R2_NOT_CONFIGURED');
  const head = await env.DB.prepare(
    `SELECT * FROM daily_release_heads WHERE video_publication_id=?`,
  ).bind(videoPublicationId).first<ReleaseHeadRow>();
  if (!head) throw new Error('PUBLICATION_VIDEO_NOT_CURRENT');
  const page = await loadPublicationGraph(env.DB, head.page_publication_id);
  const video = await loadPublicationGraph(env.DB, videoPublicationId);
  const verified = await readAndVerifyGraph(env.READMES, video);
  await finalOutwardGuard(env, head, page.publication);
  const bytes = verified.bytes.get(role);
  const object = video.objects.find((entry) => entry.object_role === role);
  if (!bytes || !object) throw new Error('PUBLICATION_VIDEO_ROLE_NOT_FOUND');
  return { bytes, mime: object.mime, sha256: object.sha256, size: Number(object.size_bytes) };
}

export interface AuthorizedDailyReleaseSummary {
  date: string;
  release_generation: number;
  promoted_at_ms: number;
  title: string;
  item_count: number;
  video: DailyVideoRow | null;
}

type DailyReleaseGuardExpectation = Pick<ReleaseHeadRow,
  'release_generation' | 'page_publication_id' | 'video_publication_id' | 'video_mode'
  | 'page_manifest_digest' | 'video_manifest_digest'>;

/**
 * Complete every D1 graph read first, then make the shared joined formal-news/head
 * guard the final authorization read. Callers use this immediately before a
 * compatibility write, IndexNow attempt, or successful upload response.
 */
export async function assertCurrentDailyReleaseAuthorization(
  env: PublicationReleaseEnv,
  date: string,
  expected?: DailyReleaseGuardExpectation,
): Promise<void> {
  const head = await loadHead(env.DB, date);
  if (!head || (expected && (
    head.release_generation !== expected.release_generation
    || head.page_publication_id !== expected.page_publication_id
    || head.video_publication_id !== expected.video_publication_id
    || head.video_mode !== expected.video_mode
    || head.page_manifest_digest !== expected.page_manifest_digest
    || head.video_manifest_digest !== expected.video_manifest_digest
  ))) throw new Error('PUBLICATION_OUTWARD_AUTHORIZATION_STALE');
  if (!await completeHead(env.DB, head)) throw new Error('PUBLICATION_OUTWARD_AUTHORIZATION_STALE');
  const page = await loadPublicationGraph(env.DB, head.page_publication_id);
  if (head.video_publication_id) {
    videoRowFromGraph(head, await loadPublicationGraph(env.DB, head.video_publication_id));
  }
  await finalOutwardGuard(env, head, page.publication);
}

/**
 * Bind an entire IndexNow URL date set to one authoritative D1 read. Per-date
 * graph/proof work is deliberately preparatory; only the final correlated SQL
 * authorizes the set, so a mutation while a later date is being prepared makes
 * the whole operation fail closed.
 */
export async function assertCurrentDailyReleaseSetAuthorization(
  env: PublicationReleaseEnv,
  dates: readonly string[],
): Promise<void> {
  if (!dates.length) throw new Error('PUBLICATION_OUTWARD_AUTHORIZATION_STALE');
  const uniqueDates = new Set(dates);
  if (uniqueDates.size !== dates.length
    || dates.some((date) => !/^\d{4}-\d{2}-\d{2}$/.test(date))) {
    throw new Error('PUBLICATION_OUTWARD_AUTHORIZATION_STALE');
  }

  const expectedHeads: ReleaseHeadRow[] = [];
  for (const date of dates) {
    const head = await loadHead(env.DB, date);
    if (!head || !await completeHead(env.DB, head)) {
      throw new Error('PUBLICATION_OUTWARD_AUTHORIZATION_STALE');
    }
    const page = await loadPublicationGraph(env.DB, head.page_publication_id);
    if (head.video_publication_id) {
      videoRowFromGraph(head, await loadPublicationGraph(env.DB, head.video_publication_id));
    }
    // Cryptographic/manual proof verification is a Worker boundary. The single
    // SQL below rebinds its immutable snapshot to all current D1 rows at once.
    await exactFormalAuthorization(env, page.publication);
    expectedHeads.push(head);
  }

  const expectedJson = JSON.stringify(expectedHeads.map((head) => ({
    date: head.date,
    release_generation: Number(head.release_generation),
    page_publication_id: head.page_publication_id,
    video_publication_id: head.video_publication_id,
    video_mode: head.video_mode,
    page_manifest_digest: head.page_manifest_digest,
    video_manifest_digest: head.video_manifest_digest,
  })));
  const formalGuard = formalNewsStoredSnapshotFinalGuardSqlPredicate();
  const reviewGuard = storedReviewBatchGuardSqlPredicate();
  const row = await env.DB.prepare(
    `/* daily_release:outward_set_final_guard */
     WITH requested AS (
       SELECT CAST(key AS INTEGER) requested_index,value
         FROM json_each(?) WHERE type='object'
     ), guarded AS (
       SELECT requested_index,
         CASE WHEN
           h.date IS json_extract(requested.value,'$.date')
           AND h.release_generation IS json_extract(requested.value,'$.release_generation')
           AND h.page_publication_id IS json_extract(requested.value,'$.page_publication_id')
           AND h.video_publication_id IS json_extract(requested.value,'$.video_publication_id')
           AND h.video_mode IS json_extract(requested.value,'$.video_mode')
           AND h.page_manifest_digest IS json_extract(requested.value,'$.page_manifest_digest')
           AND h.video_manifest_digest IS json_extract(requested.value,'$.video_manifest_digest')
           AND p.state='published' AND p.publication_date=h.date
           AND p.publication_type='page' AND p.manifest_digest=h.page_manifest_digest
           AND p.bound_video_publication_id IS h.video_publication_id
           AND p.bound_video_digest IS h.video_manifest_digest
           AND NOT EXISTS (SELECT 1 FROM append_only_publication_objects po
             WHERE po.publication_id=p.publication_id AND po.state<>'publication_bound')
           AND (h.video_publication_id IS NULL OR EXISTS (
             SELECT 1 FROM append_only_publications v
              WHERE v.publication_id=h.video_publication_id AND v.publication_date=h.date
                AND v.publication_type='video' AND v.state='published'
                AND v.manifest_digest=h.video_manifest_digest
                AND NOT EXISTS (SELECT 1 FROM append_only_publication_objects vo
                  WHERE vo.publication_id=v.publication_id AND vo.state<>'publication_bound')))
           AND ${reviewGuard} AND ${formalGuard}
         THEN 1 ELSE 0 END AS guard_ok
       FROM requested
       LEFT JOIN daily_release_heads h ON h.date=json_extract(requested.value,'$.date')
       LEFT JOIN append_only_publications p ON p.publication_id=h.page_publication_id
     )
     SELECT COUNT(*) AS requested_count,COALESCE(SUM(guard_ok),0) AS authorized_count
       FROM guarded`,
  ).bind(expectedJson, buildFormalNewsRegistryJson())
    .first<{ requested_count: number; authorized_count: number }>();
  if (Number(row?.requested_count || 0) !== dates.length
    || Number(row?.authorized_count || 0) !== dates.length) {
    throw new Error('PUBLICATION_OUTWARD_AUTHORIZATION_STALE');
  }
}

export async function projectAuthorizedDailyPageCompatibility(
  env: PublicationReleaseEnv,
  expected: DailyReleaseGuardExpectation & { date: string },
  projection: { title: string; item_count: number; generated_at: string; lastmod: string },
): Promise<void> {
  const page = await loadPublicationGraph(env.DB, expected.page_publication_id);
  if (expected.video_publication_id) {
    const videoMode = page.publication.video_mode;
    if (videoMode !== 'reuse_current' && videoMode !== 'joint_new') {
      throw new Error('PUBLICATION_OUTWARD_AUTHORIZATION_STALE');
    }
    const headForVideo: ReleaseHeadRow = {
      ...expected,
      video_mode: videoMode,
      promoted_at_ms: 0,
    };
    videoRowFromGraph(headForVideo, await loadPublicationGraph(env.DB, expected.video_publication_id));
  }
  const authorization = await exactFormalAuthorization(env, page.publication);
  const write = await env.DB.prepare(
    `/* daily_release:compat_projection_final_guard */
     WITH authorized AS (
       SELECT 1 ok FROM daily_release_heads h
       JOIN append_only_publications p ON p.publication_id=h.page_publication_id
       WHERE h.date=? AND h.release_generation=? AND h.page_publication_id=?
         AND h.video_publication_id IS ? AND h.video_mode=? AND h.page_manifest_digest=?
         AND h.video_manifest_digest IS ? AND p.state='published'
         AND p.publication_date=h.date AND p.manifest_digest=h.page_manifest_digest
         AND p.bound_video_publication_id IS h.video_publication_id
         AND p.bound_video_digest IS h.video_manifest_digest
         AND NOT EXISTS (SELECT 1 FROM append_only_publication_objects po
           WHERE po.publication_id=p.publication_id AND po.state<>'publication_bound')
         AND (h.video_publication_id IS NULL OR EXISTS (
           SELECT 1 FROM append_only_publications v
            WHERE v.publication_id=h.video_publication_id AND v.publication_date=h.date
              AND v.publication_type='video' AND v.state='published'
              AND v.manifest_digest=h.video_manifest_digest
              AND NOT EXISTS (SELECT 1 FROM append_only_publication_objects vo
                WHERE vo.publication_id=v.publication_id AND vo.state<>'publication_bound')))
         AND ${REVIEW_BATCH_GUARD} AND ${formalNewsFinalGuardSqlPredicate()}
     ), projection(date,title,item_count,generated_at,lastmod) AS (VALUES(?,?,?,?,?))
     INSERT INTO daily_pages(date,title,item_count,generated_at,lastmod)
     SELECT date,title,item_count,generated_at,lastmod FROM projection
      WHERE EXISTS (SELECT 1 FROM authorized)
     ON CONFLICT(date) DO UPDATE SET
       title=excluded.title,item_count=excluded.item_count,
       generated_at=excluded.generated_at,lastmod=excluded.lastmod
     WHERE EXISTS (SELECT 1 FROM authorized)`,
  ).bind(
    expected.date, expected.release_generation, expected.page_publication_id,
    expected.video_publication_id, expected.video_mode,
    expected.page_manifest_digest, expected.video_manifest_digest,
    ...reviewBindings(page.publication.review_batch_json),
    ...formalNewsFinalGuardBindings(authorization),
    expected.date, projection.title, projection.item_count, projection.generated_at, projection.lastmod,
  ).run();
  if (Number(write.meta?.changes || 0) !== 1) {
    throw new Error('PUBLICATION_OUTWARD_AUTHORIZATION_STALE');
  }
}

export async function listAuthorizedDailyReleaseSummaries(
  env: PublicationReleaseEnv,
  limit?: number,
): Promise<AuthorizedDailyReleaseSummary[]> {
  const boundedLimit = limit === undefined ? null : Math.max(0, Math.min(10_000, Math.floor(limit)));
  const result = await env.DB.prepare(
    `SELECT * FROM daily_release_heads ORDER BY date DESC${boundedLimit === null ? '' : ' LIMIT ?'}`,
  ).bind(...(boundedLimit === null ? [] : [boundedLimit])).all<ReleaseHeadRow>();
  const summaries: AuthorizedDailyReleaseSummary[] = [];
  for (const head of result.results || []) {
    try {
      if (!await completeHead(env.DB, head)) continue;
      const page = await loadPublicationGraph(env.DB, head.page_publication_id);
      const metadata = publicationMetadata(page.publication);
      const video = head.video_publication_id
        ? videoRowFromGraph(head, await loadPublicationGraph(env.DB, head.video_publication_id))
        : null;
      await finalOutwardGuard(env, head, page.publication);
      summaries.push({
        date: head.date,
        release_generation: Number(head.release_generation),
        promoted_at_ms: Number(head.promoted_at_ms),
        title: typeof metadata.title === 'string' ? metadata.title : `AI 日报 ${head.date}`,
        item_count: Number(metadata.item_count || 0),
        video,
      });
    } catch {
      // One stale/unauthorized release must not reveal itself through archive or sitemap projection.
    }
  }
  return summaries;
}
