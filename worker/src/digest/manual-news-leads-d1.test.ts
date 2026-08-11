import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, test } from 'vitest';

import type { Env } from '../index';
import { processManualNewsLead, type ManualLeadProcessingAdapters } from './manual-news-leads-pipeline';
import { D1ManualLeadProcessingStore } from './manual-news-leads-store';

class SqliteD1 {
  readonly sqlite = new DatabaseSync(':memory:');

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
        metadata_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
      );
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
      first: async <T>() => (statement.get(...bindings) as T | undefined) ?? null,
      all: async <T>() => ({ results: statement.all(...bindings) as T[], success: true, meta: {} }),
      run: async () => {
        const result = statement.run(...bindings);
        return { success: true, meta: { changes: Number(result.changes) } };
      },
    };
    return prepared;
  }

  async batch(statements: Array<{ run(): Promise<unknown> }>): Promise<unknown[]> {
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
    claims: [{ text: '范围仅限受支持产品。', evidence_ids: ['ev-official'] }], matched_event_key: null,
  };
}

function verifyingAdapters(): ManualLeadProcessingAdapters {
  return {
    search: async () => [], fetch: async () => { throw new Error('unused'); },
    extract: async () => null, assess: async () => assessment(),
  };
}

describe('manual lead D1-backed dedupe', () => {
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
});
