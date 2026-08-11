import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

import type { Env } from '../index';
import { confirmManualNewsLeadCandidate } from './manual-news-leads-store';
import { freezeNewsReviewBatch, getActiveNewsReviewBatch, type NewsReviewCandidate } from './news-review';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrations = path.resolve(here, '../../migrations');

class SerialSqliteD1 {
  readonly sqlite = new DatabaseSync(':memory:');
  private batchTail: Promise<unknown> = Promise.resolve();

  constructor() {
    this.sqlite.exec(`CREATE TABLE items (
      id TEXT PRIMARY KEY, source_type TEXT, source_id TEXT, source_ref TEXT, title TEXT,
      content TEXT, content_translated TEXT, author TEXT, url TEXT, published_at TEXT,
      scraped_at TEXT, is_relevant INTEGER, matched_by TEXT, lang TEXT, extra TEXT,
      deleted_at TEXT
    )`);
    this.sqlite.exec(fs.readFileSync(path.join(migrations, '032-daily-news-review.sql'), 'utf8'));
    this.sqlite.exec(fs.readFileSync(path.join(migrations, '033-manual-news-leads.sql'), 'utf8'));
  }

  prepare(sql: string) {
    let bindings: SQLInputValue[] = [];
    const statement = this.sqlite.prepare(sql);
    const prepared = {
      bind: (...values: unknown[]) => {
        bindings = values as SQLInputValue[];
        return prepared;
      },
      first: async <T>() => (statement.get(...bindings) as T | undefined) ?? null,
      all: async <T>() => ({ results: statement.all(...bindings) as T[], success: true, meta: {} }),
      run: async () => {
        const result = statement.run(...bindings);
        return { success: true, meta: { changes: Number(result.changes) } };
      },
    };
    return prepared;
  }

  batch(statements: Array<{ run(): Promise<unknown> }>): Promise<unknown[]> {
    const execute = async () => {
      this.sqlite.exec('BEGIN');
      try {
        const results: unknown[] = [];
        for (const statement of statements) results.push(await statement.run());
        this.sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        this.sqlite.exec('ROLLBACK');
        throw error;
      }
    };
    const result = this.batchTail.then(execute, execute);
    this.batchTail = result.then(() => undefined, () => undefined);
    return result;
  }

  close(): void { this.sqlite.close(); }
}

const states: SerialSqliteD1[] = [];
afterEach(() => {
  while (states.length) states.pop()!.close();
});

function state() {
  const db = new SerialSqliteD1();
  states.push(db);
  const env = { DB: db as unknown as D1Database, DAILY_NEWS_REVIEW_SECRET: 'test-secret' } as Env;
  return { db, env };
}

function candidates(prefix: string): NewsReviewCandidate[] {
  return Array.from({ length: 5 }, (_, index) => ({
    item_id: `${prefix}-${index + 1}`, title: `${prefix}新闻${index + 1}`,
    summary: '摘要', source: '来源', score: 100 - index, event_key: `${prefix}-event-${index + 1}`,
  }));
}

function insertLead(db: SerialSqliteD1, id: string, eventKey: string): void {
  const assessment = {
    title: `${id}核验标题`, summary: '核验摘要', event_key: eventKey,
    event_type: 'product_release', material_update: true, score: 90,
    recommendation: 'recommended', occurred_at: '2026-08-11', uncertainties: [],
    claims: [{ text: '官方发布。', evidence_ids: [`ev-${id}`] }], matched_event_key: null,
    evidence_tier: 'official_primary', duplicate_scope: null, matched_lead_id: null,
  };
  db.sqlite.prepare(`INSERT INTO manual_news_leads (
    id, review_date, input_type, input_text, input_url, note, status, version,
    submit_idempotency_key, created_at, updated_at
  ) VALUES (?, '2026-08-11', 'url', '', ?, '', 'recommended', 7, ?, 1, 1)`).run(
    id, `https://www.anthropic.com/news/${id}`, `submit-${id}`,
  );
  db.sqlite.prepare(`INSERT INTO manual_news_evidence (
    lead_id, evidence_id, url, source_type, publisher, published_at, retrieved_at,
    title, excerpt, claims_supported_json, reliable
  ) VALUES (?, ?, ?, 'official_primary', 'anthropic.com', '2026-08-11', 1,
    'Official', 'Official release.', '["Official release."]', 1)`).run(
    id, `ev-${id}`, `https://www.anthropic.com/news/${id}`,
  );
  db.sqlite.prepare(`INSERT INTO manual_news_event_assessments (
    lead_id, assessment_version, event_key, event_type, material_update, score,
    recommendation, assessment_json, created_at
  ) VALUES (?, 7, ?, 'product_release', 1, 90, 'recommended', ?, 1)`).run(
    id, eventKey, JSON.stringify(assessment),
  );
}

function activeCount(db: SerialSqliteD1): number {
  return Number((db.sqlite.prepare(`SELECT COUNT(*) AS count FROM daily_news_review_batches
    WHERE review_date = '2026-08-11' AND lineage_id = '2026-08-11' AND is_current = 1`).get() as { count: number }).count);
}

describe('news review revision CAS', () => {
  test('concurrent scheduled freezes converge on one DB-enforced active revision', async () => {
    const current = state();
    const [left, right] = await Promise.all([
      freezeNewsReviewBatch(current.env, '2026-08-11', candidates('left'), candidates('left').map((item) => item.item_id), 100),
      freezeNewsReviewBatch(current.env, '2026-08-11', candidates('right'), candidates('right').map((item) => item.item_id), 100),
    ]);

    expect(activeCount(current.db)).toBe(1);
    const active = await getActiveNewsReviewBatch(current.env, '2026-08-11');
    expect(active?.is_current).toBe(true);
    expect([left.batch.batch_id, right.batch.batch_id]).toContain(active?.batch_id);
    const retry = await freezeNewsReviewBatch(
      current.env, '2026-08-11', candidates('left'), candidates('left').map((item) => item.item_id), 200,
    );
    expect(retry).toMatchObject({ created: false, batch: { batch_id: active?.batch_id, is_current: true } });
  });

  test('competing manual confirmations allow one CAS winner, then the loser retries onto V3', async () => {
    const current = state();
    const initial = await freezeNewsReviewBatch(
      current.env, '2026-08-11', candidates('base'), candidates('base').map((item) => item.item_id), 100,
    );
    insertLead(current.db, 'ml-20260811-aaaaaaaaaaaa', 'event-manual-a');
    insertLead(current.db, 'ml-20260811-bbbbbbbbbbbb', 'event-manual-b');
    const firstRound = await Promise.all([
      confirmManualNewsLeadCandidate(current.env, 'ml-20260811-aaaaaaaaaaaa', 7, 1, 'confirm-a', 200),
      confirmManualNewsLeadCandidate(current.env, 'ml-20260811-bbbbbbbbbbbb', 7, 1, 'confirm-b', 200),
    ]);
    const winner = firstRound.find((result) => result.ok)!;
    const loser = firstRound.find((result) => !result.ok)!;
    expect(winner).toMatchObject({ ok: true, rerender_enqueued: false, batch: { revision: 2, current: true } });
    expect(loser).toMatchObject({ ok: false, status: 409 });
    expect(activeCount(current.db)).toBe(1);

    const loserId = firstRound[0] === loser ? 'ml-20260811-aaaaaaaaaaaa' : 'ml-20260811-bbbbbbbbbbbb';
    const activeV2 = await getActiveNewsReviewBatch(current.env, '2026-08-11');
    const retry = await confirmManualNewsLeadCandidate(current.env, loserId, 7, activeV2!.batch_revision, `retry-${loserId}`, 300);
    expect(retry).toMatchObject({ ok: true, rerender_enqueued: false, batch: { revision: 3, current: true } });
    const activeV3 = await getActiveNewsReviewBatch(current.env, '2026-08-11');
    expect(activeCount(current.db)).toBe(1);
    expect(activeV3).toMatchObject({ batch_revision: 3, default_selected_ids: initial.batch.default_selected_ids });
    expect(activeV3?.applied_selected_ids).toBeNull();
  });

  test('scheduled freeze racing a manual confirm leaves one active revision and confirm can safely retry', async () => {
    const current = state();
    await freezeNewsReviewBatch(
      current.env, '2026-08-11', candidates('base'), candidates('base').map((item) => item.item_id), 100,
    );
    const leadId = 'ml-20260811-cccccccccccc';
    insertLead(current.db, leadId, 'event-manual-c');
    const [, confirmation] = await Promise.all([
      freezeNewsReviewBatch(current.env, '2026-08-11', candidates('scheduled'), candidates('scheduled').map((item) => item.item_id), 200),
      confirmManualNewsLeadCandidate(current.env, leadId, 7, 1, 'confirm-c', 200),
    ]);
    expect(activeCount(current.db)).toBe(1);
    if (!confirmation.ok) {
      const active = await getActiveNewsReviewBatch(current.env, '2026-08-11');
      const retry = await confirmManualNewsLeadCandidate(current.env, leadId, 7, active!.batch_revision, 'confirm-c-retry', 300);
      expect(retry).toMatchObject({ ok: true, rerender_enqueued: false });
    }
    expect(activeCount(current.db)).toBe(1);
  });
});
