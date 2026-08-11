import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, test } from 'vitest';

import type { Env } from '../index';
import { processManualNewsLead, type ManualLeadProcessingAdapters } from './manual-news-leads-pipeline';
import {
  D1ManualLeadProcessingStore,
  failManualNewsLeadAfterExhaustion,
  markManualNewsLeadEnqueueFailure,
  recoverStaleManualNewsLeads,
  retryManualNewsLead,
  submitManualNewsLead,
} from './manual-news-leads-store';

class SqliteD1 {
  readonly sqlite = new DatabaseSync(':memory:');
  failAudit = false;
  private batchTail: Promise<void> = Promise.resolve();
  private nextBatchGate: { entered: () => void; released: Promise<void> } | null = null;
  private nextFirstGate: { marker: string; entered: () => void; released: Promise<void> } | null = null;

  constructor() {
    this.sqlite.exec(`
      CREATE TABLE items (
        id TEXT PRIMARY KEY, extra TEXT, published_at TEXT, scraped_at TEXT,
        is_relevant INTEGER, deleted_at TEXT
      );
      CREATE TABLE manual_news_leads (
        id TEXT PRIMARY KEY, review_date TEXT NOT NULL, input_type TEXT NOT NULL,
        input_text TEXT NOT NULL DEFAULT '', input_url TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL, version INTEGER NOT NULL, error_code TEXT, error_message TEXT,
        submit_idempotency_key TEXT NOT NULL, last_mutation_kind TEXT, last_mutation_idempotency_key TEXT,
        last_mutation_nonce TEXT,
        processing_owner TEXT, processing_attempt INTEGER NOT NULL DEFAULT 0, processing_lease_until INTEGER,
        confirmed_batch_id TEXT, confirmed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE manual_news_evidence (
        lead_id TEXT NOT NULL, evidence_id TEXT NOT NULL, url TEXT NOT NULL, source_type TEXT NOT NULL,
        publisher TEXT NOT NULL, published_at TEXT, retrieved_at INTEGER NOT NULL, title TEXT NOT NULL,
        excerpt TEXT NOT NULL, claims_supported_json TEXT NOT NULL, fetch_audit_json TEXT NOT NULL DEFAULT 'null',
        reliable INTEGER NOT NULL,
        PRIMARY KEY (lead_id, evidence_id)
      );
      CREATE TABLE manual_news_event_assessments (
        lead_id TEXT NOT NULL, assessment_version INTEGER NOT NULL, event_key TEXT NOT NULL,
        event_type TEXT NOT NULL, material_update INTEGER NOT NULL, score REAL NOT NULL,
        recommendation TEXT NOT NULL, assessment_json TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY (lead_id, assessment_version)
      );
      CREATE INDEX idx_manual_news_assessments_event
        ON manual_news_event_assessments(event_key, created_at DESC);
      CREATE TABLE manual_news_lead_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id TEXT NOT NULL, action TEXT NOT NULL,
        from_status TEXT, to_status TEXT, idempotency_key TEXT,
        mutation_nonce TEXT NOT NULL, resulting_version INTEGER NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX idx_manual_news_lead_audit_version
        ON manual_news_lead_audit(lead_id, resulting_version, action);
      CREATE UNIQUE INDEX idx_manual_news_lead_audit_idempotency
        ON manual_news_lead_audit(lead_id, action, idempotency_key) WHERE idempotency_key IS NOT NULL;
    `);
  }

  prepare(sql: string) {
    let bindings: SQLInputValue[] = [];
    const statement = this.sqlite.prepare(sql);
    const prepared = {
      bind: (...values: unknown[]) => {
        bindings = values as SQLInputValue[];
        return prepared;
      },
      first: async <T>() => {
        const gate = this.nextFirstGate;
        if (gate && sql.includes(gate.marker)) {
          this.nextFirstGate = null;
          gate.entered();
          await gate.released;
        }
        return (statement.get(...bindings) as T | undefined) ?? null;
      },
      all: async <T>() => ({ results: statement.all(...bindings) as T[], success: true, meta: {} }),
      run: async () => {
        if (this.failAudit && sql.includes('manual_audit:mutation')) throw new Error('injected_audit_failure');
        const result = statement.run(...bindings);
        return { success: true, meta: { changes: Number(result.changes) } };
      },
    };
    return prepared;
  }

  async batch(statements: Array<{ run(): Promise<unknown> }>): Promise<unknown[]> {
    const gate = this.nextBatchGate;
    this.nextBatchGate = null;
    if (gate) {
      gate.entered();
      await gate.released;
    }
    let release!: () => void;
    const previous = this.batchTail;
    this.batchTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    this.sqlite.exec('BEGIN');
    try {
      const results: unknown[] = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    } finally {
      release();
    }
  }

  pauseNextBatch(): { entered: Promise<void>; release: () => void } {
    let markEntered!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    this.nextBatchGate = { entered: markEntered, released };
    return { entered, release };
  }

  pauseNextFirst(marker: string): { entered: Promise<void>; release: () => void } {
    let markEntered!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    this.nextFirstGate = { marker, entered: markEntered, released };
    return { entered, release };
  }

  close(): void { this.sqlite.close(); }
}

const databases: SqliteD1[] = [];
afterEach(() => {
  while (databases.length) databases.pop()!.close();
});

function fixture(status = 'verifying', version = 4) {
  const db = new SqliteD1();
  databases.push(db);
  const leadId = 'ml-20260811-abc123def456';
  db.sqlite.prepare(`INSERT INTO manual_news_leads (
    id, review_date, input_type, input_text, input_url, note, status, version,
    submit_idempotency_key, created_at, updated_at
  ) VALUES (?, '2026-08-11', 'url', '', 'https://support.claude.com/example', '', ?, ?, 'submit', 1, 1)`).run(leadId, status, version);
  db.sqlite.prepare(`INSERT INTO manual_news_evidence (
    lead_id, evidence_id, url, source_type, publisher, published_at, retrieved_at,
    title, excerpt, claims_supported_json, reliable
  ) VALUES (?, 'ev-official', 'https://support.claude.com/example', 'official_help', 'claude.com',
    '2026-08-10T13:30:00.000Z', 2, 'Official help', 'Supported products only.', '["Supported products only."]', 1)`).run(leadId);
  return { db, env: { DB: db as unknown as D1Database } as Env, leadId };
}

function assessment() {
  return {
    title: 'Anthropic披露支持范围内Claude输出的来源标记',
    summary: '官方帮助文档将能力范围限定为受支持产品。',
    event_key: 'anthropic-supported-output-provenance-2026-08-10',
    event_type: 'product_documentation', material_update: false, score: 82,
    recommendation: 'recommended', occurred_at: '2026-08-10T13:30:00.000Z', uncertainties: [],
    claims: [{
      text: 'Anthropic官方帮助文档披露支持范围内Claude输出的来源标记，并将能力范围限定为受支持产品。',
      evidence_ids: ['ev-official'],
    }], matched_event_key: null,
  };
}

function verifyingAdapters(): ManualLeadProcessingAdapters {
  return {
    search: async () => [], fetch: async () => { throw new Error('unused'); },
    extract: async () => null, assess: async () => assessment(),
  };
}

describe('manual lead D1-backed dedupe', () => {
  test('atomically rolls back submit if its audit insert fails and writes one audit on replay', async () => {
    const state = fixture();
    state.db.sqlite.prepare('DELETE FROM manual_news_leads').run();
    state.db.sqlite.prepare('DELETE FROM manual_news_evidence').run();
    state.db.failAudit = true;

    await expect(submitManualNewsLead(state.env, {
      date: '2026-08-11', text: 'Anthropic 输出水印', note: '限定范围',
    }, 'submit-atomic', 20)).rejects.toThrow('injected_audit_failure');
    expect(state.db.sqlite.prepare('SELECT COUNT(*) AS count FROM manual_news_leads').get())
      .toMatchObject({ count: 0 });

    state.db.failAudit = false;
    const first = await submitManualNewsLead(state.env, {
      date: '2026-08-11', text: 'Anthropic 输出水印', note: '限定范围',
    }, 'submit-atomic', 21);
    const replay = await submitManualNewsLead(state.env, {
      date: '2026-08-11', text: '  Anthropic 输出水印 ', note: ' 限定范围 ',
    }, 'submit-atomic', 22);
    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(state.db.sqlite.prepare(
      `SELECT COUNT(*) AS count FROM manual_news_lead_audit
       WHERE lead_id = ? AND action = 'submit' AND resulting_version = 1`,
    ).get(first.lead.id)).toMatchObject({ count: 1 });
  });

  test('persists the normalized bounded-fetch audit with evidence', async () => {
    const state = fixture();
    const fetchAudit = {
      hops: [{
        url: 'https://support.claude.com/example',
        validated_ip: '93.184.216.34',
        connected_ip: '93.184.216.34',
      }],
      source_content_type: 'text/html',
      extraction: 'html' as const,
      requested_limits: {
        source_bytes: 8_388_608, extracted_text_bytes: 2_097_152, extracted_text_characters: 1_000_000,
      },
      applied_limits: {
        source_bytes: 8_388_608, extracted_text_bytes: 2_097_152, extracted_text_characters: 1_000_000,
      },
      actual_sizes: { source_bytes: 80, extracted_text_bytes: 60, extracted_text_characters: 60 },
      truncation: { source: false, extracted_text: false },
      parser: { result: 'success' as const, version: 'research-gateway-parser/1.0.0' },
    };
    const store = new D1ManualLeadProcessingStore(state.env);
    await store.replaceEvidence(state.leadId, [{
      id: 'ev-audited',
      url: 'https://support.claude.com/example',
      source_type: 'official_help',
      publisher: 'claude.com',
      published_at: null,
      retrieved_at: 10,
      title: 'Official help',
      excerpt: 'Supported products only.',
      claims_supported: ['Supported products only.'],
      reliable: true,
      fetch_audit: fetchAudit,
    }]);

    const saved = await store.getLead(state.leadId);
    expect(saved?.evidence).toEqual([expect.objectContaining({ id: 'ev-audited', fetch_audit: fetchAudit })]);
    expect(JSON.parse(String(state.db.sqlite.prepare(
      'SELECT fetch_audit_json FROM manual_news_evidence WHERE lead_id = ? AND evidence_id = ?',
    ).get(state.leadId, 'ev-audited')?.fetch_audit_json))).toEqual(fetchAudit);
  });

  test('a lone lead cannot classify itself as a same-day duplicate after its assessment is saved', async () => {
    const state = fixture();
    const result = await processManualNewsLead(
      state.leadId, new D1ManualLeadProcessingStore(state.env), verifyingAdapters(),
    );

    expect(result).toMatchObject({ status: 'recommended', assessment: { duplicate_scope: null, matched_lead_id: null } });
  });

  test('retry ignores every stale assessment belonging to the current lead', async () => {
    const state = fixture('verifying', 9);
    for (const [assessmentVersion, eventKey] of [[2, assessment().event_key], [7, 'stale-current-lead-event']] as const) {
      state.db.sqlite.prepare(`INSERT INTO manual_news_event_assessments (
        lead_id, assessment_version, event_key, event_type, material_update, score,
        recommendation, assessment_json, created_at
      ) VALUES (?, ?, ?, 'product_documentation', 0, 60, 'needs_review', ?, ?)`).run(
        state.leadId, assessmentVersion, eventKey, JSON.stringify({ ...assessment(), event_key: eventKey }), assessmentVersion,
      );
    }

    const result = await processManualNewsLead(
      state.leadId, new D1ManualLeadProcessingStore(state.env), verifyingAdapters(),
    );
    expect(result).toMatchObject({ status: 'recommended', assessment: { duplicate_scope: null, matched_lead_id: null } });
  });

  test('exact event-key lookup covers all history while a material update remains eligible', async () => {
    const state = fixture();
    state.db.sqlite.prepare(`INSERT INTO manual_news_leads (
      id, review_date, input_type, input_text, input_url, note, status, version,
      submit_idempotency_key, created_at, updated_at
    ) VALUES ('old-lead', '2026-01-01', 'text', 'old', '', '', 'recommended', 3, 'old-submit', 1, 1)`).run();
    state.db.sqlite.prepare(`INSERT INTO manual_news_event_assessments (
      lead_id, assessment_version, event_key, event_type, material_update, score,
      recommendation, assessment_json, created_at
    ) VALUES ('old-lead', 3, ?, 'product_documentation', 0, 80, 'recommended', ?, 3)`).run(
      assessment().event_key, JSON.stringify(assessment()),
    );
    const store = new D1ManualLeadProcessingStore(state.env);

    expect(await store.findPriorEventsByEventKey(assessment().event_key, state.leadId))
      .toEqual([{ event_key: assessment().event_key, review_date: '2026-01-01', lead_id: 'old-lead' }]);
    expect(await store.listRecentPriorEvents('2026-08-11', state.leadId)).toEqual([]);
  });

  test('rolls back a status transition when its audit insert fails', async () => {
    const state = fixture('validating', 4);
    state.db.failAudit = true;

    await expect(new D1ManualLeadProcessingStore(state.env).transition(
      state.leadId, 'validating', 'researching',
    )).rejects.toThrow('injected_audit_failure');

    expect(state.db.sqlite.prepare('SELECT status, version FROM manual_news_leads WHERE id = ?')
      .get(state.leadId)).toMatchObject({ status: 'validating', version: 4 });
    expect(state.db.sqlite.prepare('SELECT COUNT(*) AS count FROM manual_news_lead_audit')
      .get()).toMatchObject({ count: 0 });
  });

  test('concurrent transition CAS writes exactly one winner audit', async () => {
    const state = fixture('validating', 4);
    const store = new D1ManualLeadProcessingStore(state.env);

    const results = await Promise.allSettled([
      store.transition(state.leadId, 'validating', 'researching'),
      store.transition(state.leadId, 'validating', 'researching'),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(state.db.sqlite.prepare(
      `SELECT COUNT(*) AS count, MAX(resulting_version) AS resulting_version
       FROM manual_news_lead_audit WHERE lead_id = ? AND action = 'status_transition'`,
    ).get(state.leadId)).toMatchObject({ count: 1, resulting_version: 5 });
  });

  test('a stale-recovery CAS loser cannot audit the winning status transition', async () => {
    const state = fixture('validating', 4);
    state.db.sqlite.prepare(
      `UPDATE manual_news_leads SET processing_owner = 'stale-owner', processing_lease_until = 10 WHERE id = ?`,
    ).run(state.leadId);
    const gate = state.db.pauseNextBatch();

    const recovery = recoverStaleManualNewsLeads(state.env, '2026-08-11', 100);
    await gate.entered;
    await new D1ManualLeadProcessingStore(state.env, 'stale-owner').transition(
      state.leadId, 'validating', 'researching',
    );
    gate.release();
    expect(await recovery).toEqual([]);

    expect(state.db.sqlite.prepare(
      `SELECT action, to_status AS toStatus FROM manual_news_lead_audit WHERE lead_id = ? ORDER BY id`,
    ).all(state.leadId)).toEqual([{ action: 'status_transition', toStatus: 'researching' }]);
  });

  test('a status-transition CAS loser cannot audit the winning stale recovery', async () => {
    const state = fixture('validating', 4);
    state.db.sqlite.prepare(
      `UPDATE manual_news_leads SET processing_owner = 'stale-owner', processing_lease_until = 10 WHERE id = ?`,
    ).run(state.leadId);
    const gate = state.db.pauseNextBatch();

    const transition = new D1ManualLeadProcessingStore(state.env, 'stale-owner')
      .transition(state.leadId, 'validating', 'researching');
    await gate.entered;
    const recovered = await recoverStaleManualNewsLeads(state.env, '2026-08-11', 100);
    gate.release();
    await expect(transition).rejects.toThrow('lead_transition_conflict');

    expect(recovered).toHaveLength(1);
    expect(state.db.sqlite.prepare(
      `SELECT action, to_status AS toStatus FROM manual_news_lead_audit WHERE lead_id = ? ORDER BY id`,
    ).all(state.leadId)).toEqual([{ action: 'stale_recovery', toStatus: 'validating' }]);
  });

  test('recovers every stale intermediate status to validating with an audited CAS', async () => {
    const state = fixture('validating', 4);
    const statuses = ['submitted', 'validating', 'researching', 'extracting', 'verifying', 'clustering', 'scored'] as const;
    state.db.sqlite.prepare('DELETE FROM manual_news_leads').run();
    for (const [index, status] of statuses.entries()) {
      state.db.sqlite.prepare(`INSERT INTO manual_news_leads (
        id, review_date, input_type, input_text, input_url, note, status, version,
        submit_idempotency_key, processing_owner, processing_attempt, processing_lease_until,
        created_at, updated_at
      ) VALUES (?, '2026-08-11', 'text', 'lead', '', '', ?, 4, ?, 'stale-owner', 1, 10, 1, ?)`)
        .run(`stale-${index}`, status, `submit-${index}`, index);
    }

    const recovered = await recoverStaleManualNewsLeads(state.env, '2026-08-11', 100);

    expect(recovered.map((lead) => lead.id).sort()).toEqual(statuses.map((_, index) => `stale-${index}`).sort());
    expect(state.db.sqlite.prepare(
      `SELECT COUNT(*) AS count FROM manual_news_leads
       WHERE status = 'validating' AND version = 5
         AND processing_owner = 'manual-news-' || id || '-v5'
         AND processing_lease_until = 360100`,
    ).get()).toMatchObject({ count: statuses.length });
    expect(state.db.sqlite.prepare(
      `SELECT COUNT(*) AS count FROM manual_news_lead_audit
       WHERE action = 'stale_recovery' AND resulting_version = 5`,
    ).get()).toMatchObject({ count: statuses.length });
  });

  test('marks a still-owned lead failed after workflow retry exhaustion and audits the terminal version', async () => {
    const state = fixture('researching', 7);
    state.db.sqlite.prepare(
      `UPDATE manual_news_leads SET processing_owner = 'workflow-owner', processing_lease_until = 999 WHERE id = ?`,
    ).run(state.leadId);

    expect(await failManualNewsLeadAfterExhaustion(
      state.env, state.leadId, 'workflow-owner', new Error('gateway timeout'), 100,
    )).toBe(true);

    expect(state.db.sqlite.prepare('SELECT status, version, error_code FROM manual_news_leads WHERE id = ?')
      .get(state.leadId)).toMatchObject({ status: 'failed', version: 8, error_code: 'processing_retry_exhausted' });
    expect(state.db.sqlite.prepare(
      `SELECT COUNT(*) AS count FROM manual_news_lead_audit
       WHERE lead_id = ? AND action = 'processing_exhausted' AND resulting_version = 8`,
    ).get(state.leadId)).toMatchObject({ count: 1 });
  });

  test('retry and stale recovery reserve a fresh owner lease and recover only after expiry', async () => {
    const state = fixture('failed', 7);
    const retry = await retryManualNewsLead(state.env, state.leadId, 7, 'retry-v8', 100);

    expect(retry).toMatchObject({
      ok: true,
      changed: true,
      lead: {
        version: 8,
        status: 'validating',
        processing_owner: `manual-news-${state.leadId}-v8`,
        processing_lease_until: 360100,
      },
    });
    expect(await recoverStaleManualNewsLeads(state.env, '2026-08-11', 101)).toEqual([]);

    const recovered = await recoverStaleManualNewsLeads(state.env, '2026-08-11', 360101);
    expect(recovered).toEqual([expect.objectContaining({
      version: 9,
      processing_owner: `manual-news-${state.leadId}-v9`,
      processing_lease_until: 720101,
    })]);
    expect(await recoverStaleManualNewsLeads(state.env, '2026-08-11', 360102)).toEqual([]);
    expect(state.db.sqlite.prepare(
      `SELECT version, processing_owner AS owner, processing_lease_until AS lease
       FROM manual_news_leads WHERE id = ?`,
    ).get(state.leadId)).toEqual({
      version: 9,
      owner: `manual-news-${state.leadId}-v9`,
      lease: 720101,
    });
  });

  test('retry replay remains idempotent after workflow transitions overwrite the current mutation marker', async () => {
    const state = fixture('failed', 7);
    const key = 'retry-survives-workflow';
    const owner = `manual-news-${state.leadId}-v8`;

    const first = await retryManualNewsLead(state.env, state.leadId, 7, key, 100);
    expect(first).toMatchObject({ ok: true, changed: true, lead: { version: 8 } });
    await new D1ManualLeadProcessingStore(state.env, owner).transition(
      state.leadId, 'validating', 'researching',
    );

    const replay = await retryManualNewsLead(state.env, state.leadId, 7, key, 200);
    expect(replay).toMatchObject({
      ok: true,
      changed: false,
      lead: { status: 'researching', version: 9, processing_owner: owner },
    });
    expect(state.db.sqlite.prepare(
      `SELECT action, idempotency_key AS key, resulting_version AS version
       FROM manual_news_lead_audit WHERE lead_id = ? AND action = 'retry'`,
    ).all(state.leadId)).toEqual([{ action: 'retry', key, version: 8 }]);
  });

  test('concurrent same-key retries converge to one changed result and one immutable audit', async () => {
    const state = fixture('failed', 7);
    const key = 'retry-concurrent-same-key';

    const results = await Promise.all([
      retryManualNewsLead(state.env, state.leadId, 7, key, 100),
      retryManualNewsLead(state.env, state.leadId, 7, key, 100),
    ]);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.map((result) => result.ok && result.changed).sort()).toEqual([false, true]);
    expect(state.db.sqlite.prepare(
      `SELECT COUNT(*) AS count FROM manual_news_lead_audit
       WHERE lead_id = ? AND action = 'retry' AND idempotency_key = ? AND resulting_version = 8`,
    ).get(state.leadId, key)).toEqual({ count: 1 });
  });

  test('an idempotent retry re-reads the lead after a concurrent winner audit becomes visible', async () => {
    const state = fixture('failed', 7);
    const key = 'retry-interleaved-current-lead';
    const gate = state.db.pauseNextFirst('manual_audit:retry_idempotency');

    const replayRequest = retryManualNewsLead(state.env, state.leadId, 7, key, 100);
    await gate.entered;
    const winner = await retryManualNewsLead(state.env, state.leadId, 7, key, 101);
    gate.release();
    const replay = await replayRequest;

    expect(winner).toMatchObject({ ok: true, changed: true, lead: { version: 8 } });
    expect(replay).toMatchObject({
      ok: true,
      changed: false,
      lead: { status: 'validating', version: 8, processing_owner: `manual-news-${state.leadId}-v8` },
    });
    expect(state.db.sqlite.prepare(
      `SELECT COUNT(*) AS count FROM manual_news_lead_audit
       WHERE lead_id = ? AND action = 'retry' AND idempotency_key = ?`,
    ).get(state.leadId, key)).toEqual({ count: 1 });
  });

  test('a deferred old enqueue failure cannot mutate or audit a newer recovered owner', async () => {
    const state = fixture('failed', 7);
    const retry = await retryManualNewsLead(state.env, state.leadId, 7, 'retry-v8', 100);
    expect(retry.ok).toBe(true);
    const ownerV8 = `manual-news-${state.leadId}-v8`;
    let rejectOldCreate!: (reason: Error) => void;
    const oldCreate = new Promise<never>((_resolve, reject) => { rejectOldCreate = reject; });
    const oldFailure = oldCreate.catch((error) => markManualNewsLeadEnqueueFailure(
      state.env, state.leadId, 8, ownerV8, error, 360102,
    ));

    const recovered = await recoverStaleManualNewsLeads(state.env, '2026-08-11', 360101);
    expect(recovered).toHaveLength(1);
    const before = state.db.sqlite.prepare(
      `SELECT status, version, processing_owner AS owner, processing_lease_until AS lease,
              last_mutation_nonce AS nonce
       FROM manual_news_leads WHERE id = ?`,
    ).get(state.leadId);
    const auditBefore = state.db.sqlite.prepare(
      `SELECT action, resulting_version AS version, mutation_nonce AS nonce
       FROM manual_news_lead_audit WHERE lead_id = ? ORDER BY id`,
    ).all(state.leadId);

    rejectOldCreate(new Error('v8 workflow create failed late'));
    await expect(oldFailure).resolves.toBe(false);

    expect(state.db.sqlite.prepare(
      `SELECT status, version, processing_owner AS owner, processing_lease_until AS lease,
              last_mutation_nonce AS nonce
       FROM manual_news_leads WHERE id = ?`,
    ).get(state.leadId)).toEqual(before);
    expect(state.db.sqlite.prepare(
      `SELECT action, resulting_version AS version, mutation_nonce AS nonce
       FROM manual_news_lead_audit WHERE lead_id = ? ORDER BY id`,
    ).all(state.leadId)).toEqual(auditBefore);
  });
});
