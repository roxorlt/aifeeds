import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { Env } from '../index';
import { processManualNewsLead, type ManualLeadProcessingAdapters } from './manual-news-leads-pipeline';
import {
  applyManualLeadEvidencePolicy,
  buildManualLeadFactVerificationPrompt,
  MANUAL_LEAD_EDITORIAL_PROJECTION_CONTRACT,
  MANUAL_LEAD_GENERATED_CLAIM_CONTRACT,
  MANUAL_LEAD_SOURCE_FACT_CONTRACT,
  MANUAL_LEAD_VERIFICATION_POLICY_VERSION,
  validateManualLeadAssessment,
  validateManualLeadGeneratedAssessment,
  validateManualLeadFactVerification,
  type ManualLeadPriorEvent,
  type ManualNewsEvidence,
  type ManualNewsProcessedAssessment,
} from './manual-news-leads';
import {
  claimManualNewsLeadProcessing,
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
  failAssessmentInvalidate = false;
  private batchTail: Promise<void> = Promise.resolve();
  private nextBatchGate: { entered: () => void; released: Promise<void> } | null = null;
  private nextFirstGate: { marker: string; entered: () => void; released: Promise<void> } | null = null;
  private nextFirstBarrier: {
    marker: string; remaining: number; entered: () => void; released: Promise<void>;
  } | null = null;

  constructor() {
    this.sqlite.exec(`
      CREATE TABLE items (
        id TEXT PRIMARY KEY, source_ref TEXT, extra TEXT, published_at TEXT, scraped_at TEXT,
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
      CREATE TABLE manual_news_assessment_verifications (
        verification_id TEXT PRIMARY KEY, lead_id TEXT NOT NULL, assessment_version INTEGER NOT NULL,
        policy_version TEXT NOT NULL, canonical_digest TEXT NOT NULL, hmac_sha256 TEXT NOT NULL,
        verification_json TEXT NOT NULL, processing_owner TEXT NOT NULL,
        processing_attempt INTEGER NOT NULL, creation_nonce TEXT NOT NULL UNIQUE,
        invalidation_nonce TEXT UNIQUE,
        status TEXT NOT NULL, reason TEXT,
        created_at INTEGER NOT NULL, invalidated_at INTEGER
      );
      CREATE UNIQUE INDEX idx_manual_news_verification_one_active_lead
        ON manual_news_assessment_verifications(lead_id) WHERE status = 'active';
      CREATE TABLE manual_news_lead_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id TEXT NOT NULL, action TEXT NOT NULL,
        from_status TEXT, to_status TEXT, idempotency_key TEXT,
        mutation_nonce TEXT NOT NULL, resulting_version INTEGER NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX idx_manual_news_lead_audit_version
        ON manual_news_lead_audit(lead_id, resulting_version, action)
        WHERE action NOT IN ('evidence_replace', 'verification_create', 'assessment_invalidate', 'verification_quarantine');
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
        const barrier = this.nextFirstBarrier;
        if (barrier && sql.includes(barrier.marker)) {
          barrier.remaining -= 1;
          if (barrier.remaining === 0) barrier.entered();
          await barrier.released;
          if (barrier.remaining === 0) this.nextFirstBarrier = null;
        }
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
        if (this.failAssessmentInvalidate && sql.includes('manual_verification:invalidate')) {
          throw new Error('injected_invalidate_failure');
        }
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

  pauseNextFirstCalls(marker: string, count: number): { entered: Promise<void>; release: () => void } {
    let markEntered!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    this.nextFirstBarrier = { marker, remaining: count, entered: markEntered, released };
    return { entered, release };
  }

  close(): void { this.sqlite.close(); }
}

const databases: SqliteD1[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (databases.length) databases.pop()!.close();
});

const PROCESSING_OWNER = 'manual-news-test-owner';
const VERIFICATION_SECRET = 'a'.repeat(64);

function fixture(status = 'verifying', version = 4, processingOwner: string | null = PROCESSING_OWNER) {
  const db = new SqliteD1();
  databases.push(db);
  const leadId = 'ml-20260811-abc123def456';
  db.sqlite.prepare(`INSERT INTO manual_news_leads (
    id, review_date, input_type, input_text, input_url, note, status, version,
    submit_idempotency_key, processing_owner, processing_attempt, created_at, updated_at
  ) VALUES (?, '2026-08-11', 'url', '', 'https://support.claude.com/example', '', ?, ?, 'submit', ?, 1, 1, 1)`).run(
    leadId, status, version, processingOwner,
  );
  db.sqlite.prepare(`INSERT INTO manual_news_evidence (
    lead_id, evidence_id, url, source_type, publisher, published_at, retrieved_at,
    title, excerpt, claims_supported_json, reliable
  ) VALUES (?, 'ev-official', 'https://support.claude.com/example', 'official_help', 'claude.com',
    '2026-08-10T13:30:00.000Z', 2, 'Official help',
    'Anthropic documented Claude provenance for supported products on 2026-08-10.',
    '["Anthropic documented Claude provenance for supported products on 2026-08-10."]', 1)`).run(leadId);
  return {
    db,
    env: { DB: db as unknown as D1Database, MANUAL_NEWS_VERIFICATION_SECRET: VERIFICATION_SECRET } as Env,
    leadId,
  };
}

const fixtureFact = 'Anthropic documented Claude provenance for supported products on 2026-08-10.';

function assessment() {
  return {
    title: fixtureFact,
    summary: fixtureFact,
    event_key: 'anthropic-supported-output-provenance-2026-08-10',
    event_type: 'product_documentation', material_update: false, score: 82,
    recommendation: 'recommended', occurred_at: '2026-08-10', uncertainties: [],
    claims: [{ text: fixtureFact, evidence_ids: ['ev-official'] }], matched_event_key: null,
  };
}

function generatedAssessment(overrides: Record<string, unknown> = {}) {
  const overrideClaims = Array.isArray(overrides.claims) ? overrides.claims : null;
  const sourceFacts = (overrideClaims || [{
    atomic_fact: {
      subject: 'Anthropic', predicate: 'documented',
      object: 'Claude provenance for supported products on 2026-08-10',
    },
    evidence_ids: ['ev-official'],
  }]).map((claim, index) => {
    const row = claim as { atomic_fact?: Record<string, unknown>; evidence_ids?: string[] };
    return {
      fact_ref: `fact-${String(index + 1).padStart(2, '0')}`,
      source_language: /\p{Script=Han}/u.test(JSON.stringify(row.atomic_fact)) ? 'zh' : 'en',
      ...(row.atomic_fact ? { atomic_fact: { subject_role: 'organization', ...row.atomic_fact } } : {}),
      evidence_ids: row.evidence_ids,
      ...(!row.atomic_fact ? claim as Record<string, unknown> : {}),
    };
  });
  const { claims: _claims, title: _title, summary: _summary, ...rest } = overrides;
  return {
    event_key: assessment().event_key,
    event_type: assessment().event_type, material_update: false, score: 82,
    recommendation: 'recommended', occurred_at: '2026-08-10', uncertainties: [],
    source_facts: sourceFacts,
    editorial_projection: {
      title: {
        projection_ref: 'title-01', source_fact_refs: ['fact-01'],
        atomic_fact: {
          subject: 'Anthropic', subject_role: 'organization', predicate: '已披露',
          object: '2026年8月10日受支持产品的Claude来源信息',
        },
      },
      summary: [{
        projection_ref: 'summary-01', source_fact_refs: ['fact-01'],
        atomic_fact: {
          subject: 'Anthropic', subject_role: 'organization', predicate: '已披露',
          object: '2026年8月10日受支持产品的Claude来源信息',
        },
      }],
    },
    matched_event_key: null,
    ...rest,
  };
}

function processedAssessment() {
  const evidence = [{
    id: 'ev-official', url: 'https://support.claude.com/example', source_type: 'official_help' as const,
    publisher: 'claude.com', published_at: '2026-08-10T13:30:00.000Z', retrieved_at: 2,
    title: 'Official help', excerpt: fixtureFact,
    claims_supported: [fixtureFact],
    reliable: true, fetch_audit: null,
  }];
  return {
    ...applyManualLeadEvidencePolicy(validateManualLeadGeneratedAssessment(generatedAssessment(), evidence), evidence),
    duplicate_scope: null, matched_lead_id: null,
  };
}

function fixtureEvidence(): ManualNewsEvidence[] {
  return [{
    id: 'ev-official', url: 'https://support.claude.com/example', source_type: 'official_help',
    publisher: 'claude.com', published_at: '2026-08-10T13:30:00.000Z', retrieved_at: 2,
    title: 'Official help', excerpt: fixtureFact,
    claims_supported: [fixtureFact],
    reliable: true, fetch_audit: null,
  }];
}

function replacementEvidence(count: number): ManualNewsEvidence[] {
  return Array.from({ length: count }, (_, index) => ({
    ...fixtureEvidence()[0],
    id: `ev-replacement-${index + 1}`,
    url: `https://support.claude.com/replacement-${index + 1}`,
    title: `Replacement evidence ${index + 1}`,
  }));
}

function setExistingEvidenceCount(state: ReturnType<typeof fixture>, count: number): void {
  state.db.sqlite.prepare('DELETE FROM manual_news_evidence WHERE lead_id = ?').run(state.leadId);
  for (let index = 0; index < count; index += 1) {
    state.db.sqlite.prepare(`INSERT INTO manual_news_evidence (
      lead_id, evidence_id, url, source_type, publisher, published_at, retrieved_at,
      title, excerpt, claims_supported_json, fetch_audit_json, reliable
    ) VALUES (?, ?, ?, 'official_help', 'claude.com', NULL, 2, ?, ?, ?, 'null', 1)`).run(
      state.leadId, `ev-existing-${index + 1}`, `https://support.claude.com/existing-${index + 1}`,
      `Existing evidence ${index + 1}`, fixtureFact, JSON.stringify([fixtureFact]),
    );
  }
}

function addActiveVerification(state: ReturnType<typeof fixture>): void {
  state.db.sqlite.prepare(`INSERT INTO manual_news_assessment_verifications (
    verification_id, lead_id, assessment_version, policy_version, canonical_digest,
    hmac_sha256, verification_json, processing_owner, processing_attempt,
    creation_nonce, status, created_at
  ) VALUES (?, ?, 1, 'test-policy', ?, ?, '{}', ?, 1, ?, 'active', 1)`).run(
    `verification-${state.leadId}`, state.leadId, '0'.repeat(64), '0'.repeat(64),
    PROCESSING_OWNER, `creation-${state.leadId}`,
  );
}

function addHistoricalInvalidatedVerification(
  state: ReturnType<typeof fixture>,
  invalidatedAt: number,
  invalidationNonce = `historical-invalidation-${state.leadId}`,
): void {
  state.db.sqlite.prepare(`INSERT INTO manual_news_assessment_verifications (
    verification_id, lead_id, assessment_version, policy_version, canonical_digest,
    hmac_sha256, verification_json, processing_owner, processing_attempt,
    creation_nonce, invalidation_nonce, status, reason, created_at, invalidated_at
  ) VALUES (?, ?, 1, 'historical-policy', ?, ?, '{}', 'historical-owner', 1, ?, ?,
    'invalidated', 'evidence_replaced', 1, ?)`).run(
    `historical-verification-${state.leadId}`, state.leadId, '1'.repeat(64), '1'.repeat(64),
    `historical-creation-${state.leadId}`, invalidationNonce, invalidatedAt,
  );
}

function addPublishedManualItem(state: ReturnType<typeof fixture>): void {
  state.db.sqlite.prepare(`INSERT INTO items (
    id, source_ref, extra, published_at, scraped_at, is_relevant, deleted_at
  ) VALUES (?, 'manual_lead', '{}', '2026-08-11', '2026-08-11', 1, NULL)`).run(
    `blog:manual:${state.leadId}`,
  );
}

function verifiedAssessment(
  candidate: ManualNewsProcessedAssessment = processedAssessment(),
  evidence: ManualNewsEvidence[] = fixtureEvidence(),
  priorEvents: ManualLeadPriorEvent[] = [],
) {
  const facts = (JSON.parse(buildManualLeadFactVerificationPrompt({
    assessment: candidate, evidence, prior_events: priorEvents,
  }).user) as {
    facts: Array<{ fact_id: string; untrusted_prior_events?: Array<{ event_key: string }> }>;
    projections?: Array<{ projection_id: string; source_fact_ids: string[] }>;
  }).facts;
  const promptBody = JSON.parse(buildManualLeadFactVerificationPrompt({
    assessment: candidate, evidence, prior_events: priorEvents,
  }).user) as {
    facts: Array<{ fact_id: string; untrusted_prior_events?: Array<{ event_key: string }> }>;
    projections?: Array<{ projection_id: string; source_fact_ids: string[] }>;
  };
  return validateManualLeadFactVerification({
    overall_verdict: 'supported',
    fact_results: facts.map((fact) => ({
      fact_id: fact.fact_id, supported: true, issue_code: 'none',
      source_quotes: [{ evidence_id: evidence[0].id, quote: evidence[0].excerpt }],
      ...(fact.fact_id === 'field:material_update' ? {
        comparison_result: {
          value: candidate.material_update,
          matched_event_key: candidate.matched_event_key,
          prior_event_keys: fact.untrusted_prior_events?.map((event) => event.event_key) || [],
          reason_code: candidate.matched_event_key
            ? (candidate.material_update ? 'material_change' : 'no_material_change')
            : 'no_prior_match',
          current_evidence_id: evidence[0].id, current_quote: evidence[0].excerpt,
        },
      } : {}),
    })),
    ...(promptBody.projections?.length ? {
      projection_results: promptBody.projections.map((projection) => ({
        projection_id: projection.projection_id, source_fact_ids: projection.source_fact_ids,
        supported: true, issue_code: 'none',
      })),
    } : {}),
  }, candidate, evidence, { prior_events: priorEvents });
}

function saveFixtureAssessment(
  store: D1ManualLeadProcessingStore,
  leadId: string,
  version: number,
  candidate: ManualNewsProcessedAssessment = processedAssessment(),
) {
  return store.saveVerifiedAssessment(leadId, version, candidate, verifiedAssessment(candidate));
}

function verifyingAdapters(): ManualLeadProcessingAdapters {
  return {
    search: async () => [], fetch: async () => { throw new Error('unused'); },
    extract: async () => null, assess: async () => generatedAssessment(),
    verify: async (prompt) => {
      const body = JSON.parse(prompt.user) as {
        facts: Array<{ fact_id: string; allowed_evidence: Array<{ id: string; excerpt: string }> }>;
        projections?: Array<{ projection_id: string; source_fact_ids: string[] }>;
      };
      return {
        overall_verdict: 'supported',
        fact_results: body.facts.map((fact) => ({
          fact_id: fact.fact_id, supported: true, issue_code: 'none',
          source_quotes: [{ evidence_id: fact.allowed_evidence[0].id, quote: fact.allowed_evidence[0].excerpt }],
          ...(fact.fact_id === 'field:material_update' ? {
            comparison_result: {
              value: false, matched_event_key: null, prior_event_keys: [], reason_code: 'no_prior_match',
              current_evidence_id: fact.allowed_evidence[0].id,
              current_quote: fact.allowed_evidence[0].excerpt,
            },
          } : {}),
        })),
        ...(body.projections?.length ? {
          projection_results: body.projections.map((projection) => ({
            projection_id: projection.projection_id, source_fact_ids: projection.source_fact_ids,
            supported: true, issue_code: 'none',
          })),
        } : {}),
      };
    },
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
    const state = fixture('extracting');
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
    const store = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1);
    await store.replaceEvidence(state.leadId, 4, [{
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
    const audit = state.db.sqlite.prepare(`SELECT mutation_nonce, metadata_json FROM manual_news_lead_audit
      WHERE lead_id = ? AND action = 'evidence_replace'`).get(state.leadId) as {
        mutation_nonce: string;
        metadata_json: string;
      };
    expect(JSON.parse(audit.metadata_json)).toMatchObject({
      processing_owner: PROCESSING_OWNER,
      processing_attempt: 1,
      lead_version: 4,
      evidence_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      mutation_nonce: audit.mutation_nonce,
    });
  });

  test('replaces an initially empty evidence set without treating DELETE changes=0 as stale', async () => {
    const state = fixture('extracting', 4);
    setExistingEvidenceCount(state, 0);
    const store = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1);

    await expect(store.replaceEvidence(state.leadId, 4, replacementEvidence(2))).resolves.toBeUndefined();
    expect(state.db.sqlite.prepare(
      'SELECT evidence_id FROM manual_news_evidence WHERE lead_id = ? ORDER BY evidence_id',
    ).all(state.leadId)).toEqual([
      { evidence_id: 'ev-replacement-1' },
      { evidence_id: 'ev-replacement-2' },
    ]);
  });

  test.each([
    { existing: 0, replacement: 2, activeVerification: false, publishedItem: false },
    { existing: 1, replacement: 0, activeVerification: false, publishedItem: true },
    { existing: 3, replacement: 1, activeVerification: false, publishedItem: false },
    { existing: 1, replacement: 2, activeVerification: true, publishedItem: false },
    { existing: 2, replacement: 0, activeVerification: true, publishedItem: true },
  ])('keeps D1 result causality for evidence replacement %#', async ({
    existing, replacement, activeVerification, publishedItem,
  }) => {
    const state = fixture('extracting', 4);
    setExistingEvidenceCount(state, existing);
    if (activeVerification) addActiveVerification(state);
    if (publishedItem) addPublishedManualItem(state);
    const store = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1);

    await expect(store.replaceEvidence(state.leadId, 4, replacementEvidence(replacement)))
      .resolves.toBeUndefined();
    expect(state.db.sqlite.prepare(
      'SELECT evidence_id FROM manual_news_evidence WHERE lead_id = ? ORDER BY evidence_id',
    ).all(state.leadId)).toEqual(replacementEvidence(replacement).map((item) => ({ evidence_id: item.id })));
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM manual_news_lead_audit
      WHERE lead_id = ? AND action = 'evidence_replace'`).get(state.leadId)).toEqual({ count: 1 });
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM manual_news_lead_audit
      WHERE lead_id = ? AND action = 'assessment_invalidate'`).get(state.leadId))
      .toEqual({ count: activeVerification ? 1 : 0 });
    if (activeVerification) {
      expect(state.db.sqlite.prepare(`SELECT status, reason FROM manual_news_assessment_verifications
        WHERE lead_id = ?`).get(state.leadId)).toEqual({
        status: 'invalidated', reason: 'evidence_replaced',
      });
    }
    if (publishedItem) {
      expect(state.db.sqlite.prepare('SELECT deleted_at FROM items WHERE id = ?')
        .get(`blog:manual:${state.leadId}`)).toEqual({
        deleted_at: activeVerification ? expect.any(String) : null,
      });
    }
  });

  test.each([
    { owner: 'stale-owner', attempt: 1, version: 4 },
    { owner: PROCESSING_OWNER, attempt: 2, version: 4 },
    { owner: PROCESSING_OWNER, attempt: 1, version: 5 },
  ])('rejects evidence replacement with stale fence %#', async ({ owner, attempt, version }) => {
    const state = fixture('extracting', 4);
    setExistingEvidenceCount(state, 0);
    const store = new D1ManualLeadProcessingStore(state.env, owner, attempt);

    await expect(store.replaceEvidence(state.leadId, version, replacementEvidence(2)))
      .rejects.toThrow(/stale_processing_owner/);
    expect(state.db.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM manual_news_evidence WHERE lead_id = ?',
    ).get(state.leadId)).toEqual({ count: 0 });
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM manual_news_lead_audit
      WHERE lead_id = ? AND action = 'evidence_replace'`).get(state.leadId)).toEqual({ count: 0 });
  });

  test('ignores a same-millisecond historical invalidation when no active proof exists', async () => {
    const fixedNow = 1_723_333_333_333;
    vi.spyOn(Date, 'now').mockReturnValue(fixedNow);
    const state = fixture('extracting', 4);
    setExistingEvidenceCount(state, 0);
    addHistoricalInvalidatedVerification(state, fixedNow, 'historical-evidence-invalidation');
    addPublishedManualItem(state);
    const store = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1);

    await expect(store.replaceEvidence(state.leadId, 4, replacementEvidence(2))).resolves.toBeUndefined();
    expect(state.db.sqlite.prepare('SELECT deleted_at FROM items WHERE id = ?')
      .get(`blog:manual:${state.leadId}`)).toEqual({ deleted_at: null });
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM manual_news_lead_audit
      WHERE lead_id = ? AND action = 'assessment_invalidate'`).get(state.leadId)).toEqual({ count: 0 });
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM manual_news_lead_audit
      WHERE lead_id = ? AND action = 'evidence_replace'`).get(state.leadId)).toEqual({ count: 1 });
    expect(state.db.sqlite.prepare(`SELECT invalidation_nonce FROM manual_news_assessment_verifications
      WHERE lead_id = ?`).get(state.leadId)).toEqual({
      invalidation_nonce: 'historical-evidence-invalidation',
    });
    expect(state.db.sqlite.prepare(
      'SELECT evidence_id FROM manual_news_evidence WHERE lead_id = ? ORDER BY evidence_id',
    ).all(state.leadId)).toEqual([
      { evidence_id: 'ev-replacement-1' },
      { evidence_id: 'ev-replacement-2' },
    ]);
  });

  test('quarantines only the active proof invalidated by this evidence replacement nonce', async () => {
    const fixedNow = 1_723_333_333_333;
    vi.spyOn(Date, 'now').mockReturnValue(fixedNow);
    const state = fixture('extracting', 4);
    addHistoricalInvalidatedVerification(state, fixedNow, 'historical-evidence-invalidation');
    addActiveVerification(state);
    addPublishedManualItem(state);
    const store = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1);

    await store.replaceEvidence(state.leadId, 4, replacementEvidence(1));
    const rows = state.db.sqlite.prepare(`SELECT verification_id, invalidation_nonce
      FROM manual_news_assessment_verifications WHERE lead_id = ? ORDER BY verification_id`)
      .all(state.leadId) as Array<{ verification_id: string; invalidation_nonce: string | null }>;
    expect(rows).toEqual([
      {
        verification_id: `historical-verification-${state.leadId}`,
        invalidation_nonce: 'historical-evidence-invalidation',
      },
      {
        verification_id: `verification-${state.leadId}`,
        invalidation_nonce: expect.stringMatching(/^assessment_invalidate:/),
      },
    ]);
    expect(state.db.sqlite.prepare('SELECT deleted_at FROM items WHERE id = ?')
      .get(`blog:manual:${state.leadId}`)).toEqual({ deleted_at: expect.any(String) });
    expect(state.db.sqlite.prepare(`SELECT mutation_nonce FROM manual_news_lead_audit
      WHERE lead_id = ? AND action = 'assessment_invalidate'`).get(state.leadId)).toEqual({
      mutation_nonce: rows[1].invalidation_nonce,
    });
  });

  test('a concurrent same-fence loser cannot reuse the winner invalidation nonce for audit or item quarantine', async () => {
    const fixedNow = 1_723_333_333_333;
    vi.spyOn(Date, 'now').mockReturnValue(fixedNow);
    const state = fixture('extracting', 4);
    addActiveVerification(state);
    const store = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1);

    await expect(Promise.all([
      store.replaceEvidence(state.leadId, 4, replacementEvidence(1)),
      store.replaceEvidence(state.leadId, 4, replacementEvidence(2)),
    ])).resolves.toEqual([undefined, undefined]);
    const winner = state.db.sqlite.prepare(`SELECT invalidation_nonce
      FROM manual_news_assessment_verifications WHERE lead_id = ?`).get(state.leadId) as {
        invalidation_nonce: string;
      };
    addPublishedManualItem(state);

    await expect(store.replaceEvidence(state.leadId, 4, replacementEvidence(3))).resolves.toBeUndefined();
    expect(state.db.sqlite.prepare('SELECT deleted_at FROM items WHERE id = ?')
      .get(`blog:manual:${state.leadId}`)).toEqual({ deleted_at: null });
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM manual_news_lead_audit
      WHERE lead_id = ? AND action = 'assessment_invalidate'`).get(state.leadId)).toEqual({ count: 1 });
    expect(state.db.sqlite.prepare(`SELECT invalidation_nonce FROM manual_news_assessment_verifications
      WHERE lead_id = ?`).get(state.leadId)).toEqual(winner);
  });

  test('hides legacy assessments and preserves assessment history when active verification is invalidated', async () => {
    const state = fixture('verifying', 9);
    state.db.sqlite.prepare(`INSERT INTO manual_news_event_assessments (
      lead_id, assessment_version, event_key, event_type, material_update, score,
      recommendation, assessment_json, created_at
    ) VALUES (?, 9, ?, 'product_documentation', 0, 82, 'recommended', ?, 7)`).run(
      state.leadId, assessment().event_key, JSON.stringify(assessment()),
    );
    const store = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1);
    expect((await store.getLead(state.leadId))?.assessment).toBeNull();

    const saved = await saveFixtureAssessment(store, state.leadId, 9);
    expect(saved.assessment_version).toBe(9_000_001);
    expect((await store.getLead(state.leadId))?.assessment).toMatchObject({ score: 82 });
    const createdAudit = state.db.sqlite.prepare(`SELECT mutation_nonce, metadata_json
      FROM manual_news_lead_audit WHERE lead_id = ? AND action = 'verification_create'`)
      .get(state.leadId) as { mutation_nonce: string; metadata_json: string };
    const createdVerification = state.db.sqlite.prepare(`SELECT creation_nonce
      FROM manual_news_assessment_verifications WHERE lead_id = ? AND status = 'active'`)
      .get(state.leadId) as { creation_nonce: string };
    expect(createdAudit.mutation_nonce).toBe(createdVerification.creation_nonce);
    expect(JSON.parse(createdAudit.metadata_json)).toMatchObject({
      assessment_version: 9_000_001,
      policy_version: MANUAL_LEAD_VERIFICATION_POLICY_VERSION,
      assessment_claim_contract: MANUAL_LEAD_GENERATED_CLAIM_CONTRACT,
      assessment_source_fact_contract: MANUAL_LEAD_SOURCE_FACT_CONTRACT,
      assessment_editorial_projection_contract: MANUAL_LEAD_EDITORIAL_PROJECTION_CONTRACT,
      assessment_verification_policy: MANUAL_LEAD_VERIFICATION_POLICY_VERSION,
      canonical_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      processing_owner: PROCESSING_OWNER,
      processing_attempt: 1,
      mutation_nonce: createdAudit.mutation_nonce,
    });
    state.db.sqlite.prepare(`INSERT INTO items (
      id, source_ref, extra, published_at, scraped_at, is_relevant, deleted_at
    ) VALUES (?, 'manual_lead', '{}', '2026-08-11', '2026-08-11', 1, NULL)`).run(
      `blog:manual:${state.leadId}`,
    );
    await store.invalidateAssessment(state.leadId, 9, 'schema_invalid');

    expect((await store.getLead(state.leadId))?.assessment).toBeNull();
    expect(state.db.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM manual_news_event_assessments WHERE lead_id = ?',
    ).get(state.leadId)).toEqual({ count: 2 });
    expect(state.db.sqlite.prepare(`SELECT status, reason, invalidated_at
      FROM manual_news_assessment_verifications WHERE lead_id = ?`).get(state.leadId)).toMatchObject({
      status: 'invalidated', reason: 'schema_invalid', invalidated_at: expect.any(Number),
    });
    expect(state.db.sqlite.prepare('SELECT deleted_at FROM items WHERE id = ?')
      .get(`blog:manual:${state.leadId}`)).toEqual({ deleted_at: expect.any(String) });
    expect(state.db.sqlite.prepare(`SELECT action, metadata_json FROM manual_news_lead_audit
      WHERE lead_id = ? AND action = 'assessment_invalidate'`).get(state.leadId)).toMatchObject({
      action: 'assessment_invalidate', metadata_json: expect.stringContaining('schema_invalid'),
    });
  });

  test('classifies verification invalidation failure as transient and preserves the active proof', async () => {
    const state = fixture('verifying', 9);
    const store = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1);
    await saveFixtureAssessment(store, state.leadId, 9);
    state.db.failAssessmentInvalidate = true;

    await expect(store.invalidateAssessment(state.leadId, 9, 'schema_invalid'))
      .rejects.toThrow(/d1_invalidate_assessment_failed/);
    expect(state.db.sqlite.prepare(
      `SELECT COUNT(*) AS count FROM manual_news_assessment_verifications
       WHERE lead_id = ? AND status = 'active'`,
    ).get(state.leadId)).toEqual({ count: 1 });
  });

  test('rejects stale owners for evidence replacement, assessment save, and invalidation without writes', async () => {
    const extracting = fixture('extracting', 4, 'new-owner');
    const staleExtracting = new D1ManualLeadProcessingStore(extracting.env, 'old-owner', 1);
    await expect(staleExtracting.replaceEvidence(extracting.leadId, 4, [])).rejects.toThrow(/stale_processing_owner/);
    expect(extracting.db.sqlite.prepare(
      'SELECT evidence_id FROM manual_news_evidence WHERE lead_id = ?',
    ).all(extracting.leadId)).toEqual([{ evidence_id: 'ev-official' }]);

    const verifying = fixture('verifying', 9, 'new-owner');
    const staleVerifying = new D1ManualLeadProcessingStore(verifying.env, 'old-owner', 1);
    await expect(saveFixtureAssessment(staleVerifying, verifying.leadId, 9))
      .rejects.toThrow(/stale_processing_owner/);
    expect(verifying.db.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM manual_news_event_assessments WHERE lead_id = ?',
    ).get(verifying.leadId)).toEqual({ count: 0 });

    const current = new D1ManualLeadProcessingStore(verifying.env, 'new-owner', 1);
    await saveFixtureAssessment(current, verifying.leadId, 9);
    await expect(staleVerifying.invalidateAssessment(verifying.leadId, 9, 'stale_attempt'))
      .rejects.toThrow(/stale_processing_owner/);
    expect(verifying.db.sqlite.prepare(`SELECT status FROM manual_news_assessment_verifications
      WHERE lead_id = ?`).get(verifying.leadId)).toEqual({ status: 'active' });
  });

  test('fences the same processing owner by attempt for transition, evidence, save, and invalidation', async () => {
    const transitioning = fixture('validating', 4);
    transitioning.db.sqlite.prepare('UPDATE manual_news_leads SET processing_attempt = 2 WHERE id = ?')
      .run(transitioning.leadId);
    await expect(new D1ManualLeadProcessingStore(transitioning.env, PROCESSING_OWNER, 1)
      .transition(transitioning.leadId, 'validating', 'researching'))
      .rejects.toThrow(/lead_transition_conflict/);

    const extracting = fixture('extracting', 4);
    extracting.db.sqlite.prepare('UPDATE manual_news_leads SET processing_attempt = 2 WHERE id = ?')
      .run(extracting.leadId);
    await expect(new D1ManualLeadProcessingStore(extracting.env, PROCESSING_OWNER, 1)
      .replaceEvidence(extracting.leadId, 4, []))
      .rejects.toThrow(/stale_processing_owner/);

    const verifying = fixture('verifying', 9);
    verifying.db.sqlite.prepare('UPDATE manual_news_leads SET processing_attempt = 2 WHERE id = ?')
      .run(verifying.leadId);
    const stale = new D1ManualLeadProcessingStore(verifying.env, PROCESSING_OWNER, 1);
    await expect(saveFixtureAssessment(stale, verifying.leadId, 9))
      .rejects.toThrow(/stale_processing_owner/);
    const current = new D1ManualLeadProcessingStore(verifying.env, PROCESSING_OWNER, 2);
    await saveFixtureAssessment(current, verifying.leadId, 9);
    await expect(stale.invalidateAssessment(verifying.leadId, 9, 'stale_attempt'))
      .rejects.toThrow(/stale_processing_owner/);
    expect(verifying.db.sqlite.prepare(`SELECT status FROM manual_news_assessment_verifications
      WHERE lead_id = ?`).get(verifying.leadId)).toEqual({ status: 'active' });
  });

  test('a stale owner cannot soft-delete an item through a colliding historical invalidation timestamp', async () => {
    const fixedNow = 1_723_333_333_333;
    vi.spyOn(Date, 'now').mockReturnValue(fixedNow);
    const state = fixture('verifying', 9, 'new-owner');
    const current = new D1ManualLeadProcessingStore(state.env, 'new-owner', 1);
    await saveFixtureAssessment(current, state.leadId, 9);
    state.db.sqlite.prepare(`INSERT INTO manual_news_assessment_verifications (
      verification_id, lead_id, assessment_version, policy_version, canonical_digest,
      hmac_sha256, verification_json, processing_owner, processing_attempt,
      creation_nonce, status, reason, created_at, invalidated_at
    ) VALUES ('historical-verification', ?, 1, 'old-policy', ?, ?, '{}', 'old-owner', 1,
      'historical-creation-nonce', 'invalidated', 'stale_attempt', 1, ?)`).run(
      state.leadId, '0'.repeat(64), '0'.repeat(64), fixedNow,
    );
    state.db.sqlite.prepare(`INSERT INTO items (
      id, source_ref, extra, published_at, scraped_at, is_relevant, deleted_at
    ) VALUES (?, 'manual_lead', '{}', '2026-08-11', '2026-08-11', 1, NULL)`).run(
      `blog:manual:${state.leadId}`,
    );

    await expect(new D1ManualLeadProcessingStore(state.env, 'old-owner', 1)
      .invalidateAssessment(state.leadId, 9, 'stale_attempt'))
      .rejects.toThrow(/stale_processing_owner/);

    expect(state.db.sqlite.prepare('SELECT deleted_at FROM items WHERE id = ?')
      .get(`blog:manual:${state.leadId}`)).toEqual({ deleted_at: null });
  });

  test('same-owner claims mint monotonically increasing fencing attempts', async () => {
    const state = fixture('validating', 4);
    await expect(claimManualNewsLeadProcessing(state.env, state.leadId, PROCESSING_OWNER, 10))
      .resolves.toBe(2);
    await expect(claimManualNewsLeadProcessing(state.env, state.leadId, PROCESSING_OWNER, 11))
      .resolves.toBe(3);
    expect(state.db.sqlite.prepare(`SELECT processing_attempt FROM manual_news_leads WHERE id = ?`)
      .get(state.leadId)).toEqual({ processing_attempt: 3 });
  });

  test('same-fence concurrent assessments create only one active verification and one audit', async () => {
    const state = fixture('verifying', 9);
    const store = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1);
    const first = processedAssessment();
    const second = { ...processedAssessment(), score: 81 };

    const results = await Promise.allSettled([
      saveFixtureAssessment(store, state.leadId, 9, first),
      saveFixtureAssessment(store, state.leadId, 9, second),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM manual_news_assessment_verifications
      WHERE lead_id = ? AND status = 'active'`).get(state.leadId)).toEqual({ count: 1 });
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM manual_news_event_assessments
      WHERE lead_id = ?`).get(state.leadId)).toEqual({ count: 1 });
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM manual_news_lead_audit
      WHERE lead_id = ? AND action = 'verification_create'`).get(state.leadId)).toEqual({ count: 1 });
  });

  test('an in-flight assessment save becomes a zero-write loser after processing-owner takeover', async () => {
    const state = fixture('verifying', 9, 'old-owner');
    const gate = state.db.pauseNextBatch();
    const saving = saveFixtureAssessment(
      new D1ManualLeadProcessingStore(state.env, 'old-owner', 1), state.leadId, 9,
    );
    await gate.entered;
    state.db.sqlite.prepare(`UPDATE manual_news_leads SET processing_owner = 'new-owner'
      WHERE id = ?`).run(state.leadId);
    gate.release();

    await expect(saving).rejects.toThrow(/stale_processing_owner/);
    expect(state.db.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM manual_news_event_assessments WHERE lead_id = ?',
    ).get(state.leadId)).toEqual({ count: 0 });
    expect(state.db.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM manual_news_assessment_verifications WHERE lead_id = ?',
    ).get(state.leadId)).toEqual({ count: 0 });
  });

  test('fails closed when verification secret or HMAC is invalid', async () => {
    const state = fixture('verifying', 9);
    const missingSecret = { ...state.env, MANUAL_NEWS_VERIFICATION_SECRET: undefined } as Env;
    await expect(saveFixtureAssessment(
      new D1ManualLeadProcessingStore(missingSecret, PROCESSING_OWNER, 1), state.leadId, 9,
    ))
      .rejects.toThrow(/manual_news_verification_secret_invalid/);
    expect(state.db.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM manual_news_event_assessments WHERE lead_id = ?',
    ).get(state.leadId)).toEqual({ count: 0 });

    const store = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1);
    await saveFixtureAssessment(store, state.leadId, 9);
    const rotatedSecretStore = new D1ManualLeadProcessingStore({
      ...state.env, MANUAL_NEWS_VERIFICATION_SECRET: 'b'.repeat(64),
    } as Env);
    expect((await rotatedSecretStore.getLead(state.leadId))?.assessment).toBeNull();
    state.db.sqlite.prepare(`UPDATE manual_news_assessment_verifications SET hmac_sha256 = ?
      WHERE lead_id = ?`).run('0'.repeat(64), state.leadId);
    expect((await store.getLead(state.leadId))?.assessment).toBeNull();
  });

  test('quarantines an invalid active proof and its published item exactly once on shared load', async () => {
    const state = fixture('verifying', 9);
    const store = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1);
    await saveFixtureAssessment(store, state.leadId, 9);
    state.db.sqlite.prepare(`INSERT INTO items (
      id, source_ref, extra, published_at, scraped_at, is_relevant, deleted_at
    ) VALUES (?, 'manual_lead', '{}', '2026-08-11', '2026-08-11', 1, NULL)`).run(
      `blog:manual:${state.leadId}`,
    );
    state.db.sqlite.prepare(`UPDATE manual_news_assessment_verifications SET hmac_sha256 = ?
      WHERE lead_id = ? AND status = 'active'`).run('0'.repeat(64), state.leadId);

    expect((await store.getLead(state.leadId))?.assessment).toBeNull();
    expect(state.db.sqlite.prepare(`SELECT status, reason, invalidation_nonce FROM manual_news_assessment_verifications
      WHERE lead_id = ?`).get(state.leadId)).toEqual({
      status: 'invalidated', reason: 'verification_integrity_invalid',
      invalidation_nonce: expect.stringMatching(/^verification_invalidation:/),
    });
    expect(state.db.sqlite.prepare('SELECT deleted_at FROM items WHERE id = ?')
      .get(`blog:manual:${state.leadId}`)).toEqual({ deleted_at: expect.any(String) });
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM manual_news_lead_audit
      WHERE lead_id = ? AND action = 'verification_quarantine'`).get(state.leadId)).toEqual({ count: 1 });

    expect((await store.getLead(state.leadId))?.assessment).toBeNull();
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM manual_news_lead_audit
      WHERE lead_id = ? AND action = 'verification_quarantine'`).get(state.leadId)).toEqual({ count: 1 });
  });

  test('concurrent quarantine attempts audit only the exact active snapshot invalidation winner', async () => {
    const state = fixture('verifying', 9);
    const store = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1);
    await saveFixtureAssessment(store, state.leadId, 9);
    state.db.sqlite.prepare(`UPDATE manual_news_assessment_verifications SET hmac_sha256 = ?
      WHERE lead_id = ? AND status = 'active'`).run('0'.repeat(64), state.leadId);
    const now = vi.spyOn(Date, 'now').mockReturnValue(123456789);
    const gate = state.db.pauseNextFirstCalls('manual_verification:active_assessment', 2);

    const first = store.getLead(state.leadId);
    const second = store.getLead(state.leadId);
    await gate.entered;
    gate.release();
    const results = await Promise.allSettled([first, second]);
    now.mockRestore();

    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM manual_news_lead_audit
      WHERE lead_id = ? AND action = 'verification_quarantine'`).get(state.leadId)).toEqual({ count: 1 });
  });

  test('revalidates the verified prior context used by material_update and quarantines dependent drift', async () => {
    const state = fixture('verifying', 9);
    state.db.sqlite.prepare(`INSERT INTO manual_news_leads (
      id, review_date, input_type, input_text, input_url, note, status, version,
      submit_idempotency_key, processing_owner, processing_attempt, created_at, updated_at
    ) VALUES ('old-lead', '2026-08-10', 'text', 'old', '', '', 'verifying', 3,
      'old-submit', 'old-owner', 1, 1, 1)`).run();
    state.db.sqlite.prepare(`INSERT INTO manual_news_evidence (
      lead_id, evidence_id, url, source_type, publisher, published_at, retrieved_at,
      title, excerpt, claims_supported_json, fetch_audit_json, reliable
    ) SELECT 'old-lead', evidence_id, url, source_type, publisher, published_at, retrieved_at,
      title, excerpt, claims_supported_json, fetch_audit_json, reliable
      FROM manual_news_evidence WHERE lead_id = ?`).run(state.leadId);
    await saveFixtureAssessment(
      new D1ManualLeadProcessingStore(state.env, 'old-owner', 1), 'old-lead', 3,
    );
    const currentStore = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1);
    const priorEvents = await currentStore.findPriorEventsByEventKey(processedAssessment().event_key, state.leadId);
    const candidate = {
      ...processedAssessment(),
      material_update: true,
      matched_event_key: processedAssessment().event_key,
      matched_lead_id: 'old-lead',
    };
    await currentStore.saveVerifiedAssessment(
      state.leadId, 9, candidate, verifiedAssessment(candidate, fixtureEvidence(), priorEvents),
    );

    expect((await currentStore.getLead(state.leadId))?.assessment).toMatchObject({ material_update: true });
    state.db.sqlite.prepare(`UPDATE manual_news_event_assessments SET assessment_json = json_set(
      assessment_json, '$.summary', 'tampered prior summary'
    ) WHERE lead_id = 'old-lead'`).run();

    expect((await currentStore.getLead(state.leadId))?.assessment).toBeNull();
    expect(state.db.sqlite.prepare(`SELECT status, reason FROM manual_news_assessment_verifications
      WHERE lead_id = ?`).get(state.leadId)).toEqual({
      status: 'invalidated', reason: 'verification_integrity_invalid',
    });
  });

  test('hides assessments when verification JSON, quoted evidence, or assessment schema is tampered', async () => {
    const verificationState = fixture('verifying', 9);
    const verificationStore = new D1ManualLeadProcessingStore(
      verificationState.env, PROCESSING_OWNER, 1,
    );
    await saveFixtureAssessment(verificationStore, verificationState.leadId, 9);
    const row = verificationState.db.sqlite.prepare(`SELECT verification_json FROM manual_news_assessment_verifications
      WHERE lead_id = ? AND status = 'active'`).get(verificationState.leadId) as { verification_json: string };
    const altered = JSON.parse(row.verification_json);
    altered.fact_results[0].source_quotes[0].quote = 'Tampered source quotation with unrelated words.';
    verificationState.db.sqlite.prepare(`UPDATE manual_news_assessment_verifications SET verification_json = ?
      WHERE lead_id = ? AND status = 'active'`).run(JSON.stringify(altered), verificationState.leadId);
    expect((await verificationStore.getLead(verificationState.leadId))?.assessment).toBeNull();

    const quoteState = fixture('verifying', 9);
    const quoteStore = new D1ManualLeadProcessingStore(quoteState.env, PROCESSING_OWNER, 1);
    await saveFixtureAssessment(quoteStore, quoteState.leadId, 9);
    quoteState.db.sqlite.prepare(`UPDATE manual_news_evidence SET excerpt = 'Changed evidence text.'
      WHERE lead_id = ?`).run(quoteState.leadId);
    expect((await quoteStore.getLead(quoteState.leadId))?.assessment).toBeNull();

    const schemaState = fixture('verifying', 9);
    const schemaStore = new D1ManualLeadProcessingStore(schemaState.env, PROCESSING_OWNER, 1);
    await expect(schemaStore.saveVerifiedAssessment(schemaState.leadId, 9, {
      ...processedAssessment(), unexpected: true,
    } as ManualNewsProcessedAssessment, verifiedAssessment()))
      .rejects.toThrow(/invalid_processed_assessment_fields/);
  });

  test('store rejects a fabricated matched event even when the caller supplies typed assessment data', async () => {
    const state = fixture('verifying', 9);
    const store = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1);
    const candidate = {
      ...processedAssessment(),
      matched_event_key: processedAssessment().event_key,
      matched_lead_id: 'invented-prior-lead',
    };

    await expect(store.saveVerifiedAssessment(
      state.leadId, 9, candidate, verifiedAssessment(),
    )).rejects.toThrow(/unknown_matched_event_key/);
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM manual_news_assessment_verifications
      WHERE lead_id = ?`).get(state.leadId)).toEqual({ count: 0 });
  });

  test('retry invalidates a persisted bad-HMAC proof before saving a recovered assessment version', async () => {
    const state = fixture('verifying', 9);
    const store = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1);
    await saveFixtureAssessment(store, state.leadId, 9);
    state.db.sqlite.prepare(`UPDATE manual_news_assessment_verifications SET hmac_sha256 = ?
      WHERE lead_id = ?`).run('0'.repeat(64), state.leadId);

    state.db.sqlite.prepare(`UPDATE manual_news_leads SET processing_attempt = 2 WHERE id = ?`).run(state.leadId);
    const result = await processManualNewsLead(
      state.leadId,
      new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 2),
      verifyingAdapters(),
    );

    expect(result).toMatchObject({ status: 'recommended', assessment: { score: 82 } });
    expect(state.db.sqlite.prepare(`SELECT assessment_version, status, reason
      FROM manual_news_assessment_verifications WHERE lead_id = ? ORDER BY assessment_version`).all(state.leadId))
      .toEqual([
        { assessment_version: 9_000_001, status: 'invalidated', reason: 'verification_integrity_invalid' },
        { assessment_version: 9_000_002, status: 'active', reason: null },
      ]);
  });

  test('operator retry invalidates an active verified assessment so the next run can regenerate it', async () => {
    const state = fixture('verifying', 7);
    const processingStore = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1);
    await saveFixtureAssessment(processingStore, state.leadId, 7);
    await processingStore.transition(state.leadId, 'verifying', 'needs_review');

    const retried = await retryManualNewsLead(state.env, state.leadId, 8, 'retry-regenerate', 100);

    expect(retried).toMatchObject({
      ok: true, changed: true, lead: { version: 9, status: 'validating', assessment: null },
    });
    expect(state.db.sqlite.prepare(`SELECT status, reason FROM manual_news_assessment_verifications
      WHERE lead_id = ?`).get(state.leadId)).toEqual({ status: 'invalidated', reason: 'manual_retry' });
    const audit = state.db.sqlite.prepare(`SELECT metadata_json FROM manual_news_lead_audit
      WHERE lead_id = ? AND action = 'assessment_invalidate' AND resulting_version = 9`)
      .get(state.leadId) as { metadata_json: string };
    expect(JSON.parse(audit.metadata_json)).toMatchObject({
      reason: 'manual_retry', lead_version: 9,
      next_processing_owner: `manual-news-${state.leadId}-v9`,
    });
  });

  test('replays an active fully verified assessment with zero model calls', async () => {
    const state = fixture('verifying', 9);
    const store = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1);
    await saveFixtureAssessment(store, state.leadId, 9);
    let assessCalls = 0;
    let verifyCalls = 0;

    const result = await processManualNewsLead(state.leadId, store, {
      search: async () => { throw new Error('unexpected_search'); },
      fetch: async () => { throw new Error('unexpected_fetch'); },
      extract: async () => { throw new Error('unexpected_extract'); },
      assess: async () => { assessCalls += 1; throw new Error('unexpected_assess'); },
      verify: async () => { verifyCalls += 1; throw new Error('unexpected_verify'); },
    });

    expect(result).toMatchObject({ status: 'recommended', assessment: { score: 82 } });
    expect(assessCalls).toBe(0);
    expect(verifyCalls).toBe(0);
    const transitionAudit = state.db.sqlite.prepare(`SELECT metadata_json FROM manual_news_lead_audit
      WHERE lead_id = ? AND action = 'status_transition'
        AND from_status = 'verifying' AND to_status = 'clustering'`).get(state.leadId) as { metadata_json: string };
    expect(JSON.parse(transitionAudit.metadata_json)).toEqual({
      assessment_claim_contract: MANUAL_LEAD_GENERATED_CLAIM_CONTRACT,
      assessment_source_fact_contract: MANUAL_LEAD_SOURCE_FACT_CONTRACT,
      assessment_editorial_projection_contract: MANUAL_LEAD_EDITORIAL_PROJECTION_CONTRACT,
      assessment_verification_policy: MANUAL_LEAD_VERIFICATION_POLICY_VERSION,
      assessment_recovery: 'persisted_verified',
    });
    const createAudit = state.db.sqlite.prepare(`SELECT metadata_json FROM manual_news_lead_audit
      WHERE lead_id = ? AND action = 'verification_create'`).get(state.leadId) as { metadata_json: string };
    expect(JSON.parse(createAudit.metadata_json)).toMatchObject({
      assessment_claim_contract: MANUAL_LEAD_GENERATED_CLAIM_CONTRACT,
      assessment_source_fact_contract: MANUAL_LEAD_SOURCE_FACT_CONTRACT,
      assessment_editorial_projection_contract: MANUAL_LEAD_EDITORIAL_PROJECTION_CONTRACT,
      assessment_verification_policy: MANUAL_LEAD_VERIFICATION_POLICY_VERSION,
    });
  });

  test('persists one HMAC verification after validation-guided assessment regeneration', async () => {
    const state = fixture('verifying', 9);
    const baseAdapters = verifyingAdapters();
    let assessCalls = 0;
    let verifyCalls = 0;
    const result = await processManualNewsLead(
      state.leadId,
      new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1),
      {
        ...baseAdapters,
        assess: async () => {
          assessCalls += 1;
          return assessCalls === 1
            ? generatedAssessment({ claims: [{
              atomic_fact: {
                subject: 'Anthropic', predicate: 'documented',
                object: 'Claude provenance for supported products on 2026-08-10',
              },
              evidence_ids: ['ev-model-invented'],
            }] })
            : generatedAssessment();
        },
        verify: async (prompt) => {
          verifyCalls += 1;
          return baseAdapters.verify(prompt);
        },
      },
    );

    expect(result).toMatchObject({ status: 'recommended', assessment: { score: 82 } });
    expect(assessCalls).toBe(2);
    expect(verifyCalls).toBe(1);
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM manual_news_assessment_verifications
      WHERE lead_id = ? AND status = 'active'`).get(state.leadId)).toEqual({ count: 1 });
    const audit = state.db.sqlite.prepare(`SELECT metadata_json FROM manual_news_lead_audit
      WHERE lead_id = ? AND action = 'status_transition'
        AND from_status = 'verifying' AND to_status = 'clustering'`).get(state.leadId) as { metadata_json: string };
    expect(JSON.parse(audit.metadata_json)).toEqual({
      assessment_generation_attempts: 2,
      assessment_last_validation_code: 'valid',
      assessment_regeneration_trigger_code: 'unknown_evidence_id',
      assessment_claim_contract: MANUAL_LEAD_GENERATED_CLAIM_CONTRACT,
      assessment_source_fact_contract: MANUAL_LEAD_SOURCE_FACT_CONTRACT,
      assessment_editorial_projection_contract: MANUAL_LEAD_EDITORIAL_PROJECTION_CONTRACT,
      assessment_verification_policy: MANUAL_LEAD_VERIFICATION_POLICY_VERSION,
    });
  });

  test('audits exhausted assessment generations without creating assessment or verification rows', async () => {
    const state = fixture('verifying', 9);
    let assessCalls = 0;
    const result = await processManualNewsLead(
      state.leadId,
      new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1),
      {
        ...verifyingAdapters(),
        assess: async () => {
          assessCalls += 1;
          return generatedAssessment({ claims: [{
            atomic_fact: {
              subject: 'Anthropic', predicate: 'documented',
              object: 'Claude provenance for supported products on 2026-08-10',
            },
            evidence_ids: ['ev-model-invented'],
          }] });
        },
        verify: async () => { throw new Error('unexpected_verify'); },
      },
    );

    expect(result).toMatchObject({
      status: 'needs_review', assessment: null,
      error_code: 'assessment_validation_failed', error_message: 'unknown_evidence_id',
    });
    expect(assessCalls).toBe(2);
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM manual_news_event_assessments
      WHERE lead_id = ?`).get(state.leadId)).toEqual({ count: 0 });
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM manual_news_assessment_verifications
      WHERE lead_id = ?`).get(state.leadId)).toEqual({ count: 0 });
    const audit = state.db.sqlite.prepare(`SELECT metadata_json FROM manual_news_lead_audit
      WHERE lead_id = ? AND action = 'status_transition'
        AND from_status = 'verifying' AND to_status = 'needs_review'`).get(state.leadId) as { metadata_json: string };
    expect(JSON.parse(audit.metadata_json)).toEqual({
      assessment_generation_attempts: 2,
      assessment_last_validation_code: 'unknown_evidence_id',
      assessment_regeneration_trigger_code: 'unknown_evidence_id',
      assessment_claim_contract: MANUAL_LEAD_GENERATED_CLAIM_CONTRACT,
      assessment_source_fact_contract: MANUAL_LEAD_SOURCE_FACT_CONTRACT,
      assessment_editorial_projection_contract: MANUAL_LEAD_EDITORIAL_PROJECTION_CONTRACT,
      assessment_verification_policy: MANUAL_LEAD_VERIFICATION_POLICY_VERSION,
    });
  });

  test('a lone lead cannot classify itself as a same-day duplicate after its assessment is saved', async () => {
    const state = fixture();
    const result = await processManualNewsLead(
      state.leadId, new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1), verifyingAdapters(),
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
      state.leadId, new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1), verifyingAdapters(),
    );
    expect(result).toMatchObject({ status: 'recommended', assessment: { duplicate_scope: null, matched_lead_id: null } });
  });

  test('dedupe history ignores legacy rows and includes only independently verified assessments', async () => {
    const state = fixture();
    state.db.sqlite.prepare(`INSERT INTO manual_news_leads (
      id, review_date, input_type, input_text, input_url, note, status, version,
      submit_idempotency_key, processing_owner, processing_attempt, created_at, updated_at
    ) VALUES ('old-lead', '2026-01-01', 'text', 'old', '', '', 'verifying', 3,
      'old-submit', 'old-owner', 1, 1, 1)`).run();
    state.db.sqlite.prepare(`INSERT INTO manual_news_evidence (
      lead_id, evidence_id, url, source_type, publisher, published_at, retrieved_at,
      title, excerpt, claims_supported_json, fetch_audit_json, reliable
    ) SELECT 'old-lead', evidence_id, url, source_type, publisher, published_at, retrieved_at,
      title, excerpt, claims_supported_json, fetch_audit_json, reliable
      FROM manual_news_evidence WHERE lead_id = ?`).run(state.leadId);
    state.db.sqlite.prepare(`INSERT INTO manual_news_event_assessments (
      lead_id, assessment_version, event_key, event_type, material_update, score,
      recommendation, assessment_json, created_at
    ) VALUES ('old-lead', 3, ?, 'product_documentation', 0, 80, 'recommended', ?, 3)`).run(
      assessment().event_key, JSON.stringify(assessment()),
    );
    const store = new D1ManualLeadProcessingStore(state.env);

    expect(await store.findPriorEventsByEventKey(assessment().event_key, state.leadId)).toEqual([]);
    await saveFixtureAssessment(
      new D1ManualLeadProcessingStore(state.env, 'old-owner', 1), 'old-lead', 3,
    );
    state.db.sqlite.prepare(`UPDATE manual_news_leads SET status = 'recommended', processing_owner = NULL
      WHERE id = 'old-lead'`).run();
    expect(await store.findPriorEventsByEventKey(assessment().event_key, state.leadId))
      .toEqual([expect.objectContaining({
        event_key: assessment().event_key,
        review_date: '2026-01-01',
        lead_id: 'old-lead',
        verification_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      })]);
    expect(await store.listRecentPriorEvents('2026-08-11', state.leadId)).toEqual([]);

    state.db.sqlite.prepare(`UPDATE manual_news_assessment_verifications SET hmac_sha256 = ?
      WHERE lead_id = 'old-lead' AND status = 'active'`).run('0'.repeat(64));
    expect(await store.findPriorEventsByEventKey(assessment().event_key, state.leadId)).toEqual([]);
    expect(await store.listRecentPriorEvents('2026-01-02', state.leadId)).toEqual([]);
  });

  test('rolls back a status transition when its audit insert fails', async () => {
    const state = fixture('validating', 4);
    state.db.failAudit = true;

    await expect(new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1).transition(
      state.leadId, 'validating', 'researching',
    )).rejects.toThrow('injected_audit_failure');

    expect(state.db.sqlite.prepare('SELECT status, version FROM manual_news_leads WHERE id = ?')
      .get(state.leadId)).toMatchObject({ status: 'validating', version: 4 });
    expect(state.db.sqlite.prepare('SELECT COUNT(*) AS count FROM manual_news_lead_audit')
      .get()).toMatchObject({ count: 0 });
  });

  test('concurrent transition CAS writes exactly one winner audit', async () => {
    const state = fixture('validating', 4);
    const store = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1);

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
    await new D1ManualLeadProcessingStore(state.env, 'stale-owner', 1).transition(
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

    const transition = new D1ManualLeadProcessingStore(state.env, 'stale-owner', 1)
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
      state.env, state.leadId, 'workflow-owner', 1, new Error('gateway timeout'), 100,
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
    await new D1ManualLeadProcessingStore(state.env, owner, 1).transition(
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
