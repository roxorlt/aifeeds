import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, test } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrations = path.resolve(here, '../../migrations');

function tableColumns(db: DatabaseSync, table: string): string[] {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name));
}

describe('manual news lead migration', () => {
  test('extends review batches and creates evidence, assessment, and audit storage', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE items (id TEXT PRIMARY KEY, extra TEXT)');
    db.exec(fs.readFileSync(path.join(migrations, '032-daily-news-review.sql'), 'utf8'));
    db.exec(fs.readFileSync(path.join(migrations, '033-manual-news-leads.sql'), 'utf8'));
    db.exec(fs.readFileSync(path.join(migrations, '034-manual-news-assessment-verifications.sql'), 'utf8'));
    db.exec(fs.readFileSync(path.join(migrations, '035-manual-news-assessment-generation-cycles.sql'), 'utf8'));
    db.exec(fs.readFileSync(path.join(migrations, '036-manual-news-assessment-generation-cycles-v2.sql'), 'utf8'));
    db.exec(fs.readFileSync(path.join(migrations, '037-manual-news-proof-key-ids.sql'), 'utf8'));

    expect(tableColumns(db, 'daily_news_review_batches')).toEqual(expect.arrayContaining([
      'batch_revision', 'supersedes_batch_id', 'revision_origin', 'lineage_id', 'is_current',
      'candidate_generation',
    ]));
    expect(tableColumns(db, 'daily_news_review_candidate_generations')).toEqual(expect.arrayContaining([
      'review_date', 'lineage_id', 'generation', 'updated_at',
    ]));
    expect(tableColumns(db, 'manual_news_leads')).toEqual(expect.arrayContaining([
      'review_date', 'status', 'version', 'confirmed_batch_id', 'confirmed_at',
      'submit_idempotency_key', 'last_mutation_idempotency_key', 'last_mutation_nonce',
      'processing_owner', 'processing_attempt', 'processing_lease_until',
    ]));
    expect(tableColumns(db, 'manual_news_evidence')).toEqual(expect.arrayContaining([
      'response_key_id', 'claims_supported_json', 'fetch_audit_json',
    ]));
    expect(tableColumns(db, 'manual_news_event_assessments')).toContain('assessment_json');
    expect(tableColumns(db, 'manual_news_assessment_verifications')).toEqual(expect.arrayContaining([
      'verification_id', 'lead_id', 'assessment_version', 'policy_version', 'canonical_digest',
      'verification_key_id', 'hmac_sha256', 'verification_json', 'processing_owner', 'processing_attempt',
      'creation_nonce', 'invalidation_nonce', 'status', 'reason', 'created_at', 'invalidated_at',
    ]));
    expect(tableColumns(db, 'manual_news_leads')).toContain('assessment_generation_cycle_id');
    expect(tableColumns(db, 'manual_news_assessment_generation_cycles_v2')).toEqual(expect.arrayContaining([
      'cycle_id', 'lead_id', 'processing_owner', 'base_version', 'call_state',
      'first_validation_code', 'first_validation_path', 'last_validation_code',
      'last_validation_path', 'regeneration_consumed', 'validated_assessment_json',
      'provider_failure_json', 'superseded_by_processing_owner', 'is_current',
      'start_nonce', 'last_result_nonce', 'regeneration_nonce', 'supersede_nonce',
      'created_at', 'updated_at',
    ]));
    expect(tableColumns(db, 'manual_news_assessment_generation_revisions_v2')).toEqual(expect.arrayContaining([
      'cycle_id', 'generation_revision', 'call_kind', 'call_state', 'validation_code',
      'validation_path', 'validated_assessment_json', 'provider_failure_json',
      'start_nonce', 'result_nonce', 'created_at', 'completed_at',
    ]));
    expect(tableColumns(db, 'manual_news_lead_audit')).toEqual(expect.arrayContaining([
      'metadata_json', 'resulting_version', 'mutation_nonce',
    ]));
    const insert = db.prepare(`INSERT INTO daily_news_review_batches (
      review_date, batch_id, candidate_ids, candidates_json, default_selected_ids,
      created_at, expires_at, batch_revision, lineage_id, is_current
    ) VALUES ('2026-08-11', ?, '[]', '[]', '[]', 1, 2, ?, '2026-08-11', 1)`);
    insert.run('batch-v1', 1);
    expect(() => insert.run('batch-v2', 2)).toThrow(/UNIQUE constraint failed/);

    const insertCycle = db.prepare(`INSERT INTO manual_news_assessment_generation_cycles_v2 (
      cycle_id, lead_id, processing_owner, base_version, call_state,
      regeneration_consumed, is_current, start_nonce, created_at, updated_at
    ) VALUES (?, 'lead-cycle', 'owner-cycle', 7, 'initial_started', 0, ?, ?, 1, 1)`);
    insertCycle.run('cycle-1', 1, 'start-nonce-1');
    expect(() => insertCycle.run('cycle-2', 1, 'start-nonce-2')).toThrow(/UNIQUE constraint failed/);
    db.prepare(`INSERT INTO manual_news_assessment_generation_cycles_v2 (
      cycle_id, lead_id, processing_owner, base_version, call_state,
      regeneration_consumed, is_current, start_nonce, created_at, updated_at
    ) VALUES ('cycle-2', 'lead-cycle', 'owner-cycle-2', 8, 'initial_started', 0, 0,
      'start-nonce-2', 1, 1)`).run();
    expect(() => db.prepare(`INSERT INTO manual_news_assessment_generation_cycles_v2 (
      cycle_id, lead_id, processing_owner, base_version, call_state,
      regeneration_consumed, is_current, start_nonce, created_at, updated_at
    ) VALUES ('cycle-bad', 'lead-bad', 'owner-bad', 1, 'superseded', 0, 1, 'start-bad', 1, 1)`).run())
      .toThrow(/CHECK constraint failed/);

    const insertRevision = db.prepare(`INSERT INTO manual_news_assessment_generation_revisions_v2 (
      cycle_id, generation_revision, call_kind, call_state, start_nonce, created_at
    ) VALUES ('cycle-1', ?, ?, 'started', ?, 1)`);
    insertRevision.run(1, 'initial', 'revision-start-1');
    insertRevision.run(2, 'regeneration', 'revision-start-2');
    expect(() => insertRevision.run(2, 'regeneration', 'revision-start-3')).toThrow(/UNIQUE constraint failed/);
  });

  test('applies legacy 035 before additive 036 without inheriting uncertain v1 generation state', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE items (id TEXT PRIMARY KEY, extra TEXT)');
    db.exec(fs.readFileSync(path.join(migrations, '032-daily-news-review.sql'), 'utf8'));
    db.exec(fs.readFileSync(path.join(migrations, '033-manual-news-leads.sql'), 'utf8'));
    db.exec(fs.readFileSync(path.join(migrations, '034-manual-news-assessment-verifications.sql'), 'utf8'));
    const legacy = fs.readFileSync(path.join(migrations, '035-manual-news-assessment-generation-cycles.sql'), 'utf8');
    const v2 = fs.readFileSync(path.join(migrations, '036-manual-news-assessment-generation-cycles-v2.sql'), 'utf8');

    db.exec(legacy);
    db.prepare(`INSERT INTO manual_news_assessment_generation_cycles (
      cycle_id, lead_id, processing_owner, base_version, call_state,
      regeneration_consumed, created_at, updated_at
    ) VALUES ('legacy-cycle', 'legacy-lead', 'legacy-owner', 7, 'regeneration_started', 1, 1, 1)`).run();
    db.prepare(`INSERT INTO manual_news_assessment_generation_revisions (
      cycle_id, generation_revision, call_kind, call_state, created_at
    ) VALUES ('legacy-cycle', 2, 'regeneration', 'started', 1)`).run();

    expect(() => db.exec(v2)).not.toThrow();
    expect(tableColumns(db, 'manual_news_leads')).toContain('assessment_generation_cycle_id');
    expect(db.prepare('SELECT COUNT(*) AS count FROM manual_news_assessment_generation_cycles').get())
      .toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM manual_news_assessment_generation_cycles_v2').get())
      .toEqual({ count: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_manual_news_generation_v2_one_current_lead'`).get())
      .toEqual({ count: 1 });
  });

  test('migration 036 is replayable after fresh 035 and preserves a single current v2 cycle', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE items (id TEXT PRIMARY KEY, extra TEXT)');
    db.exec(fs.readFileSync(path.join(migrations, '032-daily-news-review.sql'), 'utf8'));
    db.exec(fs.readFileSync(path.join(migrations, '033-manual-news-leads.sql'), 'utf8'));
    db.exec(fs.readFileSync(path.join(migrations, '034-manual-news-assessment-verifications.sql'), 'utf8'));
    db.exec(fs.readFileSync(path.join(migrations, '035-manual-news-assessment-generation-cycles.sql'), 'utf8'));
    const migration = fs.readFileSync(path.join(migrations, '036-manual-news-assessment-generation-cycles-v2.sql'), 'utf8');

    expect(() => db.exec(migration)).not.toThrow();
    expect(() => db.exec(migration)).not.toThrow();
    expect(tableColumns(db, 'manual_news_assessment_generation_revisions_v2'))
      .toEqual(expect.arrayContaining(['start_nonce', 'result_nonce']));
    const insert = db.prepare(`INSERT INTO manual_news_assessment_generation_cycles_v2 (
      cycle_id, lead_id, processing_owner, base_version, call_state,
      regeneration_consumed, is_current, start_nonce, created_at, updated_at
    ) VALUES (?, 'lead-current', ?, ?, 'initial_started', 0, 1, ?, 1, 1)`);
    insert.run('cycle-current-1', 'owner-1', 1, 'nonce-current-1');
    expect(() => insert.run('cycle-current-2', 'owner-2', 2, 'nonce-current-2'))
      .toThrow(/UNIQUE constraint failed/);
  });

  test('migration 036 recovers when the complete v2 cycle table already exists but later objects do not', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE items (id TEXT PRIMARY KEY, extra TEXT)');
    db.exec(fs.readFileSync(path.join(migrations, '032-daily-news-review.sql'), 'utf8'));
    db.exec(fs.readFileSync(path.join(migrations, '033-manual-news-leads.sql'), 'utf8'));
    db.exec(fs.readFileSync(path.join(migrations, '034-manual-news-assessment-verifications.sql'), 'utf8'));
    db.exec(fs.readFileSync(path.join(migrations, '035-manual-news-assessment-generation-cycles.sql'), 'utf8'));
    db.exec(`CREATE TABLE manual_news_assessment_generation_cycles_v2 (
      cycle_id TEXT PRIMARY KEY, lead_id TEXT NOT NULL, processing_owner TEXT NOT NULL,
      base_version INTEGER NOT NULL, call_state TEXT NOT NULL,
      first_validation_code TEXT, first_validation_path TEXT,
      last_validation_code TEXT, last_validation_path TEXT,
      regeneration_consumed INTEGER NOT NULL DEFAULT 0,
      validated_assessment_json TEXT, provider_failure_json TEXT,
      superseded_by_processing_owner TEXT, is_current INTEGER NOT NULL DEFAULT 1,
      start_nonce TEXT NOT NULL UNIQUE, last_result_nonce TEXT UNIQUE,
      regeneration_nonce TEXT UNIQUE, supersede_nonce TEXT UNIQUE,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE (lead_id, processing_owner, base_version)
    )`);
    const migration = fs.readFileSync(path.join(migrations, '036-manual-news-assessment-generation-cycles-v2.sql'), 'utf8');

    expect(() => db.exec(migration)).not.toThrow();
    expect(tableColumns(db, 'manual_news_assessment_generation_revisions_v2'))
      .toEqual(expect.arrayContaining(['start_nonce', 'result_nonce']));
    expect(db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_manual_news_generation_v2_one_current_lead'`).get())
      .toEqual({ count: 1 });
  });

  test('allows only one active verification per lead while retaining invalidated history', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE items (id TEXT PRIMARY KEY, extra TEXT)');
    db.exec(fs.readFileSync(path.join(migrations, '032-daily-news-review.sql'), 'utf8'));
    db.exec(fs.readFileSync(path.join(migrations, '033-manual-news-leads.sql'), 'utf8'));
    db.exec(fs.readFileSync(path.join(migrations, '034-manual-news-assessment-verifications.sql'), 'utf8'));
    const insert = db.prepare(`INSERT INTO manual_news_assessment_verifications (
      verification_id, lead_id, assessment_version, policy_version, canonical_digest,
      hmac_sha256, verification_json, processing_owner, processing_attempt,
      creation_nonce, status, reason, created_at, invalidated_at
    ) VALUES (?, 'lead-1', ?, 'fact-evidence-hmac-v4', ?, ?, '{}', 'owner-1', 1, ?, ?, ?, 1, ?)`);
    insert.run('verification-1', 4, 'a'.repeat(64), 'b'.repeat(64), 'nonce-1', 'active', null, null);

    expect(() => insert.run(
      'verification-2', 5, 'c'.repeat(64), 'd'.repeat(64), 'nonce-2', 'active', null, null,
    )).toThrow(/UNIQUE constraint failed/);
    db.prepare(`UPDATE manual_news_assessment_verifications
      SET status = 'invalidated', reason = 'evidence_replaced', invalidated_at = 2,
          invalidation_nonce = 'invalidation-1'
      WHERE verification_id = 'verification-1'`).run();
    insert.run('verification-2', 5, 'c'.repeat(64), 'd'.repeat(64), 'nonce-2', 'active', null, null);

    expect(() => db.prepare(`INSERT INTO manual_news_assessment_verifications (
      verification_id, lead_id, assessment_version, policy_version, canonical_digest,
      hmac_sha256, verification_json, processing_owner, processing_attempt,
      creation_nonce, status, reason, created_at, invalidated_at
    ) VALUES ('verification-3', 'lead-2', 1, 'fact-evidence-hmac-v4', ?, ?, '{}',
      'owner-2', 1, 'nonce-2', 'active', NULL, 2, NULL)`).run(
      'e'.repeat(64), 'f'.repeat(64),
    )).toThrow(/UNIQUE constraint failed/);

    expect(() => db.prepare(`INSERT INTO manual_news_assessment_verifications (
      verification_id, lead_id, assessment_version, policy_version, canonical_digest,
      hmac_sha256, verification_json, processing_owner, processing_attempt,
      creation_nonce, invalidation_nonce, status, reason, created_at, invalidated_at
    ) VALUES ('verification-4', 'lead-3', 1, 'fact-evidence-hmac-v4', ?, ?, '{}',
      'owner-3', 1, 'nonce-4', 'invalidation-1', 'invalidated', 'quarantine', 2, 2)`).run(
      'e'.repeat(64), 'f'.repeat(64),
    )).toThrow(/UNIQUE constraint failed/);

    expect(db.prepare(`SELECT verification_id, status, reason, invalidation_nonce, invalidated_at
      FROM manual_news_assessment_verifications ORDER BY verification_id`).all()).toEqual([
      {
        verification_id: 'verification-1', status: 'invalidated', reason: 'evidence_replaced',
        invalidation_nonce: 'invalidation-1', invalidated_at: 2,
      },
      {
        verification_id: 'verification-2', status: 'active', reason: null,
        invalidation_nonce: null, invalidated_at: null,
      },
    ]);
  });

  test('chooses the newest legacy batch by created_at then rowid and supersedes every loser', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE items (id TEXT PRIMARY KEY, extra TEXT)');
    db.exec(fs.readFileSync(path.join(migrations, '032-daily-news-review.sql'), 'utf8'));
    const insert = db.prepare(`INSERT INTO daily_news_review_batches (
      review_date, batch_id, candidate_ids, candidates_json, default_selected_ids,
      created_at, expires_at
    ) VALUES (?, ?, '[]', '[]', '[]', ?, 999)`);
    // rowid order deliberately disagrees with created_at order.
    insert.run('2026-08-10', 'winner-by-time', 300);
    insert.run('2026-08-10', 'loser-by-rowid', 100);
    // created_at tie deliberately exercises the rowid DESC tie-break.
    insert.run('2026-08-11', 'tie-loser', 400);
    insert.run('2026-08-11', 'tie-winner', 400);

    db.exec(fs.readFileSync(path.join(migrations, '033-manual-news-leads.sql'), 'utf8'));

    expect(db.prepare(`SELECT batch_id, is_current, superseded_by
      FROM daily_news_review_batches ORDER BY review_date, rowid`).all()).toEqual([
      { batch_id: 'winner-by-time', is_current: 1, superseded_by: null },
      { batch_id: 'loser-by-rowid', is_current: 0, superseded_by: 'winner-by-time' },
      { batch_id: 'tie-loser', is_current: 0, superseded_by: 'tie-winner' },
      { batch_id: 'tie-winner', is_current: 1, superseded_by: null },
    ]);
  });
});
