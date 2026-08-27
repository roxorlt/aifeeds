import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const migrationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations/040-daily-release-publications.sql',
);

function migratedDb(): DatabaseSync {
  expect(existsSync(migrationPath), '040 append-only publication migration must exist').toBe(true);
  const sql = readFileSync(migrationPath, 'utf8');
  expect(sql).not.toMatch(/sha256\s*\(/i);
  const db = new DatabaseSync(':memory:');
  db.exec(sql);
  return db;
}

function activateBudget(db: DatabaseSync, baseline = 0): void {
  db.prepare(`UPDATE publication_storage_budget
    SET legacy_baseline_bytes=?, state='active', legacy_inventory_digest=?,
        legacy_inventory_object_count=0, legacy_inventory_at_ms=1, version=1, updated_at_ms=1
    WHERE singleton_id=1 AND state='uninitialized' AND version=0`)
    .run(baseline, 'a'.repeat(64));
}

const PAGE = {
  token: '1'.repeat(64), date: '2026-08-27', type: 'page', slot: 1,
  business: '2'.repeat(64), attempt: '3'.repeat(64), manifest: '4'.repeat(64),
  publication: '5'.repeat(64), object: '6'.repeat(64), tuple: '7'.repeat(64),
  sha: '8'.repeat(64), size: 1024,
};

function insertPageReservation(db: DatabaseSync, over: Partial<typeof PAGE> & { budgetVersion?: number } = {}): void {
  const row = { ...PAGE, ...over };
  db.prepare(`INSERT INTO publication_reservations(
    reservation_token,publication_date,publication_type,slot_no,business_revision_id,
    attempt_key,manifest_digest,object_count,vtt_present,reserved_bytes,budget_version_before,
    state,created_at_ms,updated_at_ms
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,'reserved',2,2)`).run(
    row.token, row.date, row.type, row.slot, row.business, row.attempt, row.manifest,
    1, 0, row.size, over.budgetVersion ?? 1,
  );
}

function insertPageGraph(db: DatabaseSync, over: Partial<typeof PAGE> = {}): void {
  const row = { ...PAGE, ...over };
  db.prepare(`INSERT INTO append_only_publications(
    publication_id,reservation_token,publication_date,publication_type,slot_no,
    business_revision_id,attempt_key,manifest_digest,video_mode,state,created_at_ms,updated_at_ms
  ) VALUES(?,?,?,?,?,?,?,?,?, 'reserved',2,2)`).run(
    row.publication, row.token, row.date, row.type, row.slot,
    row.business, row.attempt, row.manifest, row.type === 'page' ? 'none' : null,
  );
  db.prepare(`INSERT INTO append_only_publication_objects(
    object_id,reservation_token,publication_id,publication_date,publication_type,slot_no,
    business_revision_id,attempt_key,object_role,r2_key,sha256,size_bytes,mime,tuple_digest,
    state,created_at_ms,updated_at_ms
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'reserved',2,2)`).run(
    row.object, row.token, row.publication, row.date, row.type, row.slot,
    row.business, row.attempt, 'html', `daily/versions/${row.attempt}/page.html`,
    row.sha, row.size, 'text/html; charset=utf-8', row.tuple,
  );
  db.prepare(`INSERT INTO publication_manifest_commits(
    reservation_token,publication_id,manifest_digest,object_count,total_size_bytes,committed_at_ms
  ) VALUES(?,?,?,?,?,2)`).run(row.token, row.publication, row.manifest, 1, row.size);
}

describe('040 append-only daily release/publication migration', () => {
  test('creates an uninitialized 3 TiB cumulative singleton and exact release tables', () => {
    const db = migratedDb();
    expect(db.prepare(`SELECT singleton_id,namespace,budget_bytes,legacy_baseline_bytes,
      reserved_bytes,version,state FROM publication_storage_budget`).get()).toEqual({
      singleton_id: 1, namespace: 'daily-publications-v1', budget_bytes: 3_298_534_883_328,
      legacy_baseline_bytes: 0, reserved_bytes: 0, version: 0, state: 'uninitialized',
    });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
      .map((row) => String(row.name));
    expect(tables).toEqual(expect.arrayContaining([
      'daily_release_heads', 'publication_storage_budget', 'publication_reservations',
      'append_only_publications', 'append_only_publication_objects',
      'publication_manifest_commits',
    ]));
  });

  test('rejects reservation while inventory is uninitialized without changing budget', () => {
    const db = migratedDb();
    expect(() => insertPageReservation(db, { budgetVersion: 0 })).toThrow(/PUBLICATION_BUDGET_OR_VERSION_REJECTED/);
    expect(db.prepare('SELECT reserved_bytes,version FROM publication_storage_budget').get())
      .toEqual({ reserved_bytes: 0, version: 0 });
  });

  test('rolls budget trigger changes back when the main reservation hits a unique conflict', () => {
    const db = migratedDb();
    activateBudget(db);
    insertPageReservation(db);
    expect(() => insertPageReservation(db, {
      token: '9'.repeat(64), attempt: 'a'.repeat(64), slot: 2, budgetVersion: 2,
    })).toThrow(/UNIQUE constraint failed/);
    expect(db.prepare('SELECT reserved_bytes,version FROM publication_storage_budget').get())
      .toEqual({ reserved_bytes: PAGE.size, version: 2 });
    expect(db.prepare('SELECT COUNT(*) n FROM publication_reservations').get()).toEqual({ n: 1 });
  });

  test('enforces page/video slot and executable 64 MiB media limits', () => {
    const db = migratedDb();
    activateBudget(db);
    expect(() => insertPageReservation(db, { slot: 17 })).toThrow(/CHECK constraint failed/);
    expect(() => db.prepare(`INSERT INTO publication_reservations(
      reservation_token,publication_date,publication_type,slot_no,business_revision_id,
      attempt_key,manifest_digest,object_count,vtt_present,reserved_bytes,budget_version_before,
      state,created_at_ms,updated_at_ms
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,'reserved',2,2)`).run(
      'a'.repeat(64), PAGE.date, 'video', 5, 'b'.repeat(64), 'c'.repeat(64),
      'd'.repeat(64), 3, 1, 73 * 1024 * 1024, 1,
    )).toThrow(/CHECK constraint failed/);
    expect(() => db.prepare(`INSERT INTO append_only_publication_objects(
      object_id,reservation_token,publication_id,publication_date,publication_type,slot_no,
      business_revision_id,attempt_key,object_role,r2_key,sha256,size_bytes,mime,tuple_digest,
      state,created_at_ms,updated_at_ms
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'reserved',2,2)`).run(
      'e'.repeat(64), PAGE.token, PAGE.publication, PAGE.date, 'video', 1,
      PAGE.business, PAGE.attempt, 'mp4', `daily-video/candidates/${PAGE.attempt}/video.mp4`,
      PAGE.sha, 64 * 1024 * 1024 + 1, 'video/mp4', PAGE.tuple,
    )).toThrow();
  });

  test('requires exact reservation linkage and manifest count/sum without a SHA UDF', () => {
    const db = migratedDb();
    activateBudget(db);
    insertPageReservation(db);
    expect(() => insertPageGraph(db, { token: 'f'.repeat(64) })).toThrow(/PUBLICATION_RESERVATION_MISMATCH/);
    expect(db.prepare('SELECT COUNT(*) n FROM append_only_publications').get()).toEqual({ n: 0 });
    insertPageGraph(db);
    expect(db.prepare('SELECT COUNT(*) n FROM publication_manifest_commits').get()).toEqual({ n: 1 });
  });

  test('forbids deleting append-only reservation/publication/object/manifest rows', () => {
    const db = migratedDb();
    activateBudget(db);
    insertPageReservation(db);
    insertPageGraph(db);
    for (const table of [
      'publication_reservations', 'append_only_publications',
      'append_only_publication_objects', 'publication_manifest_commits',
    ]) expect(() => db.exec(`DELETE FROM ${table}`)).toThrow(/APPEND_ONLY_DELETE_FORBIDDEN/);
  });

  test('release head accepts only an exact ready page graph and exact video mode binding', () => {
    const db = migratedDb();
    activateBudget(db);
    expect(() => db.prepare(`INSERT INTO daily_release_heads(
      date,release_generation,page_publication_id,video_publication_id,video_mode,
      page_manifest_digest,video_manifest_digest,promoted_at_ms
    ) VALUES(?,1,?,NULL,'none',?,NULL,3)`).run(
      PAGE.date, PAGE.publication, PAGE.manifest,
    )).toThrow(/RELEASE_HEAD_GRAPH_MISMATCH/);

    insertPageReservation(db);
    insertPageGraph(db);
    db.prepare(`UPDATE append_only_publications
      SET state='put_verified',updated_at_ms=3
      WHERE publication_id=?`).run(PAGE.publication);
    db.prepare(`UPDATE append_only_publication_objects
      SET state='put_verified',verified_at_ms=3,updated_at_ms=3
      WHERE publication_id=?`).run(PAGE.publication);

    expect(() => db.prepare(`INSERT INTO daily_release_heads(
      date,release_generation,page_publication_id,video_publication_id,video_mode,
      page_manifest_digest,video_manifest_digest,promoted_at_ms
    ) VALUES(?,1,?,NULL,'none',?,NULL,3)`).run(
      PAGE.date, PAGE.publication, 'f'.repeat(64),
    )).toThrow(/RELEASE_HEAD_GRAPH_MISMATCH/);
    db.prepare(`INSERT INTO daily_release_heads(
      date,release_generation,page_publication_id,video_publication_id,video_mode,
      page_manifest_digest,video_manifest_digest,promoted_at_ms
    ) VALUES(?,1,?,NULL,'none',?,NULL,3)`).run(
      PAGE.date, PAGE.publication, PAGE.manifest,
    );
    expect(db.prepare(`SELECT release_generation,page_publication_id,video_mode
      FROM daily_release_heads WHERE date=?`).get(PAGE.date)).toEqual({
      release_generation: 1, page_publication_id: PAGE.publication, video_mode: 'none',
    });
  });
});
