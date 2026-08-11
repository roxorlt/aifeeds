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
      'claims_supported_json', 'fetch_audit_json',
    ]));
    expect(tableColumns(db, 'manual_news_event_assessments')).toContain('assessment_json');
    expect(tableColumns(db, 'manual_news_assessment_verifications')).toEqual(expect.arrayContaining([
      'verification_id', 'lead_id', 'assessment_version', 'policy_version', 'canonical_digest',
      'hmac_sha256', 'verification_json', 'processing_owner', 'processing_attempt',
      'status', 'reason', 'created_at', 'invalidated_at',
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
      status, reason, created_at, invalidated_at
    ) VALUES (?, 'lead-1', ?, 'fact-evidence-hmac-v2', ?, ?, '{}', 'owner-1', 1, ?, ?, 1, ?)`);
    insert.run('verification-1', 4, 'a'.repeat(64), 'b'.repeat(64), 'active', null, null);

    expect(() => insert.run(
      'verification-2', 5, 'c'.repeat(64), 'd'.repeat(64), 'active', null, null,
    )).toThrow(/UNIQUE constraint failed/);
    db.prepare(`UPDATE manual_news_assessment_verifications
      SET status = 'invalidated', reason = 'evidence_replaced', invalidated_at = 2
      WHERE verification_id = 'verification-1'`).run();
    insert.run('verification-2', 5, 'c'.repeat(64), 'd'.repeat(64), 'active', null, null);

    expect(db.prepare(`SELECT verification_id, status, reason, invalidated_at
      FROM manual_news_assessment_verifications ORDER BY verification_id`).all()).toEqual([
      { verification_id: 'verification-1', status: 'invalidated', reason: 'evidence_replaced', invalidated_at: 2 },
      { verification_id: 'verification-2', status: 'active', reason: null, invalidated_at: null },
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
