import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

import type { Env } from '../index';
import {
  applyManualLeadEvidencePolicy,
  createManualLeadVerificationMarker,
  validateManualLeadAssessment,
} from './manual-news-leads';
import { confirmManualNewsLeadCandidate, retryManualNewsLead } from './manual-news-leads-store';
import {
  createNewsReviewToken,
  freezeNewsReviewBatch,
  getActiveNewsReviewBatch,
  getAppliedNewsReviewSelection,
  submitNewsReviewSelection,
  type NewsReviewCandidate,
} from './news-review';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrations = path.resolve(here, '../../migrations');

class SerialSqliteD1 {
  readonly sqlite = new DatabaseSync(':memory:');
  private batchTail: Promise<unknown> = Promise.resolve();
  private nextBatchGate: {
    entered: () => void;
    released: Promise<void>;
  } | null = null;

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
    const gate = this.nextBatchGate;
    this.nextBatchGate = null;
    if (gate) {
      return Promise.resolve()
        .then(() => gate.entered())
        .then(() => gate.released)
        .then(() => {
          const previousTail = this.batchTail;
          const gatedResult = previousTail.then(execute, execute);
          this.batchTail = gatedResult.then(() => undefined, () => undefined);
          return gatedResult;
        });
    }
    const result = this.batchTail.then(execute, execute);
    this.batchTail = result.then(() => undefined, () => undefined);
    return result;
  }

  pauseNextBatch(): { entered: Promise<void>; release: () => void } {
    let markEntered!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    this.nextBatchGate = { entered: markEntered, released };
    return { entered, release };
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

async function insertLead(db: SerialSqliteD1, id: string, eventKey: string): Promise<void> {
  const rawAssessment = {
    title: `${id}核验标题`, summary: '核验摘要', event_key: eventKey,
    event_type: 'product_release', material_update: true, score: 90,
    recommendation: 'recommended', occurred_at: '2026-08-11', uncertainties: [],
    claims: [{ text: '官方发布。', evidence_ids: [`ev-${id}`] }], matched_event_key: null,
  };
  const evidence = {
    id: `ev-${id}`,
    url: `https://www.anthropic.com/news/${id}`,
    source_type: 'official_primary' as const,
    publisher: 'anthropic.com',
    published_at: '2026-08-11',
    retrieved_at: 1,
    title: 'Official',
    excerpt: 'Official release.',
    claims_supported: ['Official release.'],
    reliable: true,
    fetch_audit: null,
  };
  const core = validateManualLeadAssessment(rawAssessment, [evidence]);
  const processed = applyManualLeadEvidencePolicy(core, [evidence]);
  const assessment = {
    ...processed,
    duplicate_scope: null,
    matched_lead_id: null,
    verification: await createManualLeadVerificationMarker(processed, [evidence]),
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
  test('a retry CAS loser cannot write an audit for a concurrent confirmation winner', async () => {
    const current = state();
    const leadId = 'ml-20260811-a11111111111';
    await insertLead(current.db, leadId, 'event-retry-confirm-race-a');
    current.db.sqlite.prepare("UPDATE manual_news_leads SET status = 'needs_review' WHERE id = ?").run(leadId);
    await freezeNewsReviewBatch(
      current.env, '2026-08-11', candidates('base-a'), candidates('base-a').map((item) => item.item_id), 100,
    );
    const gate = current.db.pauseNextBatch();

    const retry = retryManualNewsLead(current.env, leadId, 7, 'retry-race-a', 150);
    await gate.entered;
    const confirmation = await confirmManualNewsLeadCandidate(
      current.env, leadId, 7, 1, 'confirm-race-a', 160,
    );
    gate.release();

    expect(confirmation).toMatchObject({ ok: true, changed: true });
    expect(await retry).toMatchObject({ ok: false, status: 409, error: 'lead_version_conflict' });
    expect(current.db.sqlite.prepare(
      `SELECT action FROM manual_news_lead_audit WHERE lead_id = ? ORDER BY id`,
    ).all(leadId)).toEqual([{ action: 'confirm_candidate' }]);
  });

  test('a confirmation CAS loser cannot write an audit for a concurrent retry winner', async () => {
    const current = state();
    const leadId = 'ml-20260811-b22222222222';
    await insertLead(current.db, leadId, 'event-retry-confirm-race-b');
    current.db.sqlite.prepare("UPDATE manual_news_leads SET status = 'needs_review' WHERE id = ?").run(leadId);
    await freezeNewsReviewBatch(
      current.env, '2026-08-11', candidates('base-b'), candidates('base-b').map((item) => item.item_id), 100,
    );
    const gate = current.db.pauseNextBatch();

    const confirmation = confirmManualNewsLeadCandidate(
      current.env, leadId, 7, 1, 'confirm-race-b', 150,
    );
    await gate.entered;
    const retry = await retryManualNewsLead(current.env, leadId, 7, 'retry-race-b', 160);
    gate.release();

    expect(retry).toMatchObject({ ok: true, changed: true });
    expect(await confirmation).toMatchObject({ ok: false, status: 409, error: 'lead_version_conflict' });
    expect(current.db.sqlite.prepare(
      `SELECT action FROM manual_news_lead_audit WHERE lead_id = ? ORDER BY id`,
    ).all(leadId)).toEqual([{ action: 'retry' }]);
  });

  test('prefreeze confirmation invalidates a freeze that already snapshotted no confirmed leads', async () => {
    const current = state();
    const leadId = 'ml-20260811-ffffffffffff';
    await insertLead(current.db, leadId, 'event-manual-reverse-race');
    const gate = current.db.pauseNextBatch();

    const freezePromise = freezeNewsReviewBatch(
      current.env, '2026-08-11', candidates('stale'), candidates('stale').map((item) => item.item_id), 100,
    );
    await gate.entered;
    const confirmation = await confirmManualNewsLeadCandidate(
      current.env, leadId, 7, 0, 'confirm-after-snapshot', 150,
    );
    expect(confirmation).toMatchObject({
      ok: true,
      changed: true,
      pending_initial_freeze: true,
      batch: null,
      rerender_enqueued: false,
    });
    const replay = await confirmManualNewsLeadCandidate(
      current.env, leadId, 7, 0, 'confirm-after-snapshot', 175,
    );
    expect(replay).toMatchObject({ ok: true, changed: false, pending_initial_freeze: true });
    gate.release();
    const frozen = await freezePromise;

    expect(frozen.batch).toMatchObject({ batch_revision: 1, is_current: true, candidate_generation: 1 });
    expect(frozen.batch.candidates).toContainEqual(expect.objectContaining({
      item_id: `blog:manual:${leadId}`,
      origin: 'manual_lead',
      lead_id: leadId,
      event_key: 'event-manual-reverse-race',
    }));
    expect(activeCount(current.db)).toBe(1);
    expect(current.db.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM daily_news_review_batches WHERE review_date = '2026-08-11'",
    ).get()).toEqual({ count: 1 });
    expect(current.db.sqlite.prepare(
      "SELECT generation FROM daily_news_review_candidate_generations WHERE review_date = '2026-08-11' AND lineage_id = '2026-08-11'",
    ).get()).toEqual({ generation: 1 });
  });

  test('initial freeze winning after a no-batch confirm read leaves no partial confirmation and retry creates V2', async () => {
    const current = state();
    const leadId = 'ml-20260811-000000000000';
    await insertLead(current.db, leadId, 'event-manual-initial-race');
    const gate = current.db.pauseNextBatch();

    const confirmationPromise = confirmManualNewsLeadCandidate(
      current.env, leadId, 7, 0, 'confirm-before-freeze', 150,
    );
    await gate.entered;
    const initial = await freezeNewsReviewBatch(
      current.env, '2026-08-11', candidates('initial'), candidates('initial').map((item) => item.item_id), 200,
    );
    gate.release();
    const confirmation = await confirmationPromise;

    expect(initial.batch).toMatchObject({ batch_revision: 1, is_current: true, candidate_generation: 0 });
    expect(confirmation).toMatchObject({
      ok: false,
      status: 409,
      error: 'candidate_batch_revision_conflict',
    });
    expect(current.db.sqlite.prepare('SELECT COUNT(*) AS count FROM items WHERE id = ?')
      .get(`blog:manual:${leadId}`)).toEqual({ count: 0 });
    expect(current.db.sqlite.prepare(
      'SELECT version, confirmed_at, confirmed_batch_id FROM manual_news_leads WHERE id = ?',
    ).get(leadId)).toEqual({ version: 7, confirmed_at: null, confirmed_batch_id: null });
    expect(current.db.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM manual_news_lead_audit WHERE lead_id = ? AND action = 'confirm_candidate'",
    ).get(leadId)).toEqual({ count: 0 });
    expect(current.db.sqlite.prepare(
      "SELECT generation FROM daily_news_review_candidate_generations WHERE review_date = '2026-08-11' AND lineage_id = '2026-08-11'",
    ).get()).toEqual({ generation: 0 });

    const retry = await confirmManualNewsLeadCandidate(
      current.env, leadId, 7, 1, 'confirm-after-freeze', 300,
    );
    expect(retry).toMatchObject({
      ok: true,
      changed: true,
      pending_initial_freeze: false,
      rerender_enqueued: false,
      batch: { revision: 2, supersedes_revision: 1, current: true },
    });
    expect(activeCount(current.db)).toBe(1);
  });

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
    const activeCandidates = active?.candidate_ids[0]?.startsWith('left-') ? candidates('left') : candidates('right');
    const retry = await freezeNewsReviewBatch(
      current.env, '2026-08-11', activeCandidates, activeCandidates.map((item) => item.item_id), 200,
    );
    expect(retry).toMatchObject({ created: false, batch: { batch_id: active?.batch_id, is_current: true } });
  });

  test('competing manual confirmations allow one CAS winner, then the loser retries onto V3', async () => {
    const current = state();
    const initial = await freezeNewsReviewBatch(
      current.env, '2026-08-11', candidates('base'), candidates('base').map((item) => item.item_id), 100,
    );
    await insertLead(current.db, 'ml-20260811-aaaaaaaaaaaa', 'event-manual-a');
    await insertLead(current.db, 'ml-20260811-bbbbbbbbbbbb', 'event-manual-b');
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
    expect(activeV3?.candidates.filter((candidate) => candidate.origin === 'manual_lead').map((candidate) => candidate.lead_id).sort())
      .toEqual(['ml-20260811-aaaaaaaaaaaa', 'ml-20260811-bbbbbbbbbbbb']);
  });

  test('scheduled freeze racing a manual confirm leaves one active revision and confirm can safely retry', async () => {
    const current = state();
    await freezeNewsReviewBatch(
      current.env, '2026-08-11', candidates('base'), candidates('base').map((item) => item.item_id), 100,
    );
    const leadId = 'ml-20260811-cccccccccccc';
    await insertLead(current.db, leadId, 'event-manual-c');
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

  test('a changed scheduled V3 preserves the confirmed manual candidate from V2 before deterministic capping', async () => {
    const current = state();
    const base = candidates('base');
    const initial = await freezeNewsReviewBatch(
      current.env, '2026-08-11', base, base.map((item) => item.item_id), 100,
    );
    const leadId = 'ml-20260811-dddddddddddd';
    await insertLead(current.db, leadId, 'event-manual-durable');
    const confirmed = await confirmManualNewsLeadCandidate(
      current.env, leadId, 7, 1, 'confirm-durable', 200,
    );
    expect(confirmed).toMatchObject({ ok: true, batch: { revision: 2 } });

    const changedScheduled = [
      ...base.map((candidate) => ({ ...candidate, title: `${candidate.title}（重评分）`, score: Number(candidate.score) - 5 })),
      ...candidates('fresh'),
    ];
    const scheduled = await freezeNewsReviewBatch(
      current.env, '2026-08-11', changedScheduled, base.map((item) => item.item_id), 300,
    );

    expect(scheduled.batch).toMatchObject({
      batch_revision: 3,
      supersedes_batch_id: confirmed.ok ? confirmed.batch?.batch_id : undefined,
      revision_origin: 'scheduled_freeze',
      default_selected_ids: initial.batch.default_selected_ids,
      applied_selected_ids: null,
    });
    expect(scheduled.batch.candidates).toHaveLength(10);
    expect(scheduled.batch.candidates.filter((candidate) => candidate.origin === 'manual_lead')).toEqual([
      expect.objectContaining({
        item_id: `blog:manual:${leadId}`,
        lead_id: leadId,
        event_key: 'event-manual-durable',
      }),
    ]);
    expect(scheduled.batch.candidate_ids).not.toContain('fresh-5');
    expect(activeCount(current.db)).toBe(1);
  });

  test('inactive legacy token is read-only and inactive applied selection is ignored', async () => {
    const current = state();
    const active = await freezeNewsReviewBatch(
      current.env, '2026-08-11', candidates('active'), candidates('active').map((item) => item.item_id), 100,
    );
    current.db.sqlite.prepare(`UPDATE daily_news_review_batches SET
      applied_selected_ids = ?, edit_revision = 1, created_at = 100
      WHERE review_date = ? AND batch_id = ?`).run(
      JSON.stringify(['active-2']), '2026-08-11', active.batch.batch_id,
    );
    const inactiveCandidates = candidates('inactive');
    const inactiveBatchId = 'nr-20260811-111111111111';
    current.db.sqlite.prepare(`INSERT INTO daily_news_review_batches (
      review_date, batch_id, candidate_ids, candidates_json, default_selected_ids,
      applied_selected_ids, created_at, expires_at, batch_revision, lineage_id,
      is_current, candidate_generation
    ) VALUES ('2026-08-11', ?, ?, ?, ?, ?, 999, 999999, 1, '2026-08-11', 0, 0)`).run(
      inactiveBatchId,
      JSON.stringify(inactiveCandidates.map((item) => item.item_id)),
      JSON.stringify(inactiveCandidates),
      JSON.stringify(inactiveCandidates.slice(0, 5).map((item) => item.item_id)),
      JSON.stringify(['inactive-3']),
    );

    await expect(getAppliedNewsReviewSelection(current.env, '2026-08-11')).resolves.toEqual(['active-2']);
    const token = await createNewsReviewToken('test-secret', '2026-08-11', inactiveBatchId);
    const result = await submitNewsReviewSelection(current.env, {
      date: '2026-08-11', batch_id: inactiveBatchId, token, selected_ids: ['inactive-1'],
    }, 200);

    expect(result).toMatchObject({ ok: false, status: 409, error: 'review_batch_superseded' });
    expect(current.db.sqlite.prepare(`SELECT applied_selected_ids, edit_revision
      FROM daily_news_review_batches WHERE review_date = '2026-08-11' AND batch_id = ?`)
      .get(inactiveBatchId)).toEqual({ applied_selected_ids: JSON.stringify(['inactive-3']), edit_revision: 0 });
  });

  test('sixth manual candidate cannot evict five published selections or five confirmed manual candidates', async () => {
    const current = state();
    const scheduled = [...candidates('selected'), ...candidates('tail')];
    const initial = await freezeNewsReviewBatch(
      current.env, '2026-08-11', scheduled, scheduled.slice(0, 5).map((item) => item.item_id), 100,
    );
    let revision = initial.batch.batch_revision;
    for (let index = 1; index <= 6; index++) {
      const leadId = `ml-20260811-${String(index).repeat(12)}`;
      await insertLead(current.db, leadId, `manual-cap-event-${index}`);
      const beforeBatchCount = Number((current.db.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM daily_news_review_batches WHERE review_date = '2026-08-11'",
      ).get() as { count: number }).count);
      const result = await confirmManualNewsLeadCandidate(
        current.env, leadId, 7, revision, `confirm-cap-${index}`, 100 + index,
      );
      if (index <= 5) {
        expect(result).toMatchObject({ ok: true, batch: { revision: revision + 1 } });
        revision += 1;
      } else {
        expect(result).toMatchObject({ ok: false, status: 409, error: 'candidate_cap_exhausted' });
        expect(Number((current.db.sqlite.prepare(
          "SELECT COUNT(*) AS count FROM daily_news_review_batches WHERE review_date = '2026-08-11'",
        ).get() as { count: number }).count)).toBe(beforeBatchCount);
        expect(current.db.sqlite.prepare(
          'SELECT version, confirmed_at, confirmed_batch_id FROM manual_news_leads WHERE id = ?',
        ).get(leadId)).toEqual({ version: 7, confirmed_at: null, confirmed_batch_id: null });
      }
    }
    const active = await getActiveNewsReviewBatch(current.env, '2026-08-11');
    expect(active?.candidates.filter((candidate) => candidate.origin === 'manual_lead')).toHaveLength(5);
    expect(active?.candidate_ids.slice(0, 5)).toEqual(scheduled.slice(0, 5).map((item) => item.item_id));
  });
});
