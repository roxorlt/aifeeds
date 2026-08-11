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

    expect(tableColumns(db, 'daily_news_review_batches')).toEqual(expect.arrayContaining([
      'batch_revision', 'supersedes_batch_id', 'revision_origin', 'lineage_id', 'is_current',
    ]));
    expect(tableColumns(db, 'manual_news_leads')).toEqual(expect.arrayContaining([
      'review_date', 'status', 'version', 'confirmed_batch_id', 'confirmed_at',
      'submit_idempotency_key', 'last_mutation_idempotency_key',
    ]));
    expect(tableColumns(db, 'manual_news_evidence')).toContain('claims_supported_json');
    expect(tableColumns(db, 'manual_news_event_assessments')).toContain('assessment_json');
    expect(tableColumns(db, 'manual_news_lead_audit')).toContain('metadata_json');
    const insert = db.prepare(`INSERT INTO daily_news_review_batches (
      review_date, batch_id, candidate_ids, candidates_json, default_selected_ids,
      created_at, expires_at, batch_revision, lineage_id, is_current
    ) VALUES ('2026-08-11', ?, '[]', '[]', '[]', 1, 2, ?, '2026-08-11', 1)`);
    insert.run('batch-v1', 1);
    expect(() => insert.run('batch-v2', 2)).toThrow(/UNIQUE constraint failed/);
  });
});
