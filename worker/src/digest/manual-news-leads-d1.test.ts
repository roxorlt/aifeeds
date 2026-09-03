import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { Env } from '../index';
import { normalizeFeedEventFingerprint } from '../feeds/classify-translate';
import { FEED_REGISTRY } from '../feeds/registry';
import { handleManualNewsLeadsApi } from './manual-news-leads-api';
import { processManualNewsLead, type ManualLeadProcessingAdapters } from './manual-news-leads-pipeline';
import {
  applyManualLeadEvidencePolicy,
  buildManualLeadFactVerificationPrompt,
  createManualLeadVerificationProof,
  createManualNewsSourceSupportPayload,
  createManualNewsSourceSupportProof,
  isCurrentManualLeadVerification,
  MANUAL_LEAD_EDITORIAL_PROJECTION_CONTRACT,
  MANUAL_LEAD_EVIDENCE_DISPOSITION_CONTRACT,
  MANUAL_LEAD_GENERATED_CLAIM_CONTRACT,
  MANUAL_LEAD_SOURCE_FACT_CONTRACT,
  MANUAL_LEAD_VERIFICATION_POLICY_VERSION,
  validateManualLeadAssessment,
  validateManualLeadGeneratedAssessment,
  validateManualLeadFactVerification,
  validateManualNewsSourceSupportSelection,
  validateManualNewsSourceSupportVerification,
  type ManualLeadPriorEvent,
  type ManualNewsEvidence,
  type ManualNewsProcessedAssessment,
} from './manual-news-leads';
import {
  claimManualNewsLeadProcessing,
  D1ManualLeadProcessingStore,
  failManualNewsLeadAfterExhaustion,
  getManualNewsLead,
  markManualNewsLeadEnqueueFailure,
  recoverStaleManualNewsLeads,
  retryManualNewsLead,
  submitManualNewsLead,
  vouchManualNewsLeadCandidate,
} from './manual-news-leads-store';
import {
  loadManualNewsEvidence,
  loadVerifiedManualCandidateProof,
} from './manual-news-leads-verification';
import { ManualNewsProviderError } from './manual-news-provider';
import { authorizeFormalNewsSet } from './news-source-policy';
import {
  durableConfirmedManualCandidates,
  freezeNewsReviewBatchFromPool,
  newsReviewSelectionHash,
  sanitizeCurrentNewsReviewBatch,
} from './news-review';
import {
  TEST_MANUAL_NEWS_RESPONSE_KEY_ID,
  proofForLegacyPolicy,
  TEST_MANUAL_NEWS_RESPONSE_SECRET,
  testManualNewsResponseKeyring,
  testManualNewsVerificationKeyring,
  withSignedArticleTextV2Audit,
} from './manual-news-signed-evidence.test-fixture';

class SqliteD1 {
  readonly sqlite = new DatabaseSync(':memory:');
  failAudit = false;
  failAssessmentInvalidate = false;
  failQuarantineAudit = false;
  rejectEvidenceBlobMaterialization = false;
  readonly preparedSql: string[] = [];
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
        lead_id TEXT NOT NULL, evidence_id TEXT NOT NULL,
        response_key_id TEXT NOT NULL DEFAULT 'response-key-2026-08-11',
        url TEXT NOT NULL, source_type TEXT NOT NULL,
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
        policy_version TEXT NOT NULL,
        verification_key_id TEXT NOT NULL DEFAULT 'verification-key-2026-08-11',
        canonical_digest TEXT NOT NULL, hmac_sha256 TEXT NOT NULL,
        verification_json TEXT NOT NULL, processing_owner TEXT NOT NULL,
        processing_attempt INTEGER NOT NULL, creation_nonce TEXT NOT NULL UNIQUE,
        invalidation_nonce TEXT UNIQUE,
        status TEXT NOT NULL, reason TEXT,
        created_at INTEGER NOT NULL, invalidated_at INTEGER
      );
      CREATE UNIQUE INDEX idx_manual_news_verification_one_active_lead
        ON manual_news_assessment_verifications(lead_id) WHERE status = 'active';
      CREATE TABLE manual_news_assessment_generation_cycles_v2 (
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
      );
      CREATE UNIQUE INDEX idx_manual_news_generation_v2_one_current_lead
        ON manual_news_assessment_generation_cycles_v2(lead_id) WHERE is_current = 1;
      CREATE TABLE manual_news_assessment_generation_revisions_v2 (
        cycle_id TEXT NOT NULL, generation_revision INTEGER NOT NULL,
        call_kind TEXT NOT NULL, call_state TEXT NOT NULL,
        validation_code TEXT, validation_path TEXT, validated_assessment_json TEXT,
        provider_failure_json TEXT, start_nonce TEXT NOT NULL UNIQUE, result_nonce TEXT UNIQUE,
        created_at INTEGER NOT NULL, completed_at INTEGER,
        PRIMARY KEY (cycle_id, generation_revision), UNIQUE (cycle_id, call_kind)
      );
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
    this.preparedSql.push(sql);
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
      all: async <T>() => {
        if (this.rejectEvidenceBlobMaterialization && sql.includes('manual_evidence:list')) {
          throw new Error('evidence_blob_materialized');
        }
        return { results: statement.all(...bindings) as T[], success: true, meta: {} };
      },
      run: async () => {
        if (this.failAudit && sql.includes('manual_audit:mutation')) throw new Error('injected_audit_failure');
        if (this.failAssessmentInvalidate && sql.includes('manual_verification:invalidate')) {
          throw new Error('injected_invalidate_failure');
        }
        if (this.failQuarantineAudit && sql.includes('manual_verification:quarantine_audit')) {
          throw new Error('injected_quarantine_audit_failure');
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
const VERIFICATION_KEY_ID = 'verification-key-2026-08-11';

function fixture(status = 'verifying', version = 4, processingOwner: string | null = PROCESSING_OWNER) {
  const db = new SqliteD1();
  databases.push(db);
  const leadId = 'ml-20260811-abc123def456';
  const signedEvidence = fixtureEvidence()[0];
  db.sqlite.prepare(`INSERT INTO manual_news_leads (
    id, review_date, input_type, input_text, input_url, note, status, version,
    submit_idempotency_key, processing_owner, processing_attempt, created_at, updated_at
  ) VALUES (?, '2026-08-11', 'url', '', 'https://support.claude.com/example', '', ?, ?, 'submit', ?, 1, 1, 1)`).run(
    leadId, status, version, processingOwner,
  );
  db.sqlite.prepare(`INSERT INTO manual_news_evidence (
    lead_id, evidence_id, url, source_type, publisher, published_at, retrieved_at,
    title, excerpt, claims_supported_json, fetch_audit_json, reliable
  ) VALUES (?, 'ev-official', 'https://support.claude.com/example', 'official_help', 'claude.com',
    '2026-08-10T13:30:00.000Z', 2, 'Official help',
    'Anthropic documented Claude provenance for supported products on 2026-08-10.',
    '["Anthropic documented Claude provenance for supported products on 2026-08-10."]', ?, 1)`).run(
    leadId, JSON.stringify(signedEvidence.fetch_audit),
  );
  return {
    db,
    env: {
      DB: db as unknown as D1Database,
      MANUAL_NEWS_VERIFICATION_SECRET: VERIFICATION_SECRET,
      MANUAL_NEWS_VERIFICATION_KEY_ID: VERIFICATION_KEY_ID,
      MANUAL_NEWS_RESEARCH_RESPONSE_SECRET: TEST_MANUAL_NEWS_RESPONSE_SECRET,
      MANUAL_NEWS_RESEARCH_RESPONSE_KEY_ID: TEST_MANUAL_NEWS_RESPONSE_KEY_ID,
    } as Env,
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
    evidence_dispositions: [{
      evidence_id: 'ev-official',
      disposition: 'supports_core',
      source_fact_refs: ['fact-01'],
      reason_code: null,
    }],
    matched_event_key: null,
    ...rest,
  };
}

function processedAssessment() {
  const evidence = fixtureEvidence();
  return {
    ...applyManualLeadEvidencePolicy(validateManualLeadGeneratedAssessment(generatedAssessment(), evidence), evidence),
    duplicate_scope: null, matched_lead_id: null,
  };
}

function fixtureEvidence(): ManualNewsEvidence[] {
  return [withSignedArticleTextV2Audit({
    id: 'ev-official', url: 'https://support.claude.com/example', source_type: 'official_help',
    publisher: 'claude.com', published_at: '2026-08-10T13:30:00.000Z', retrieved_at: 2,
    title: 'Official help', excerpt: fixtureFact,
    claims_supported: [fixtureFact],
    reliable: true,
  })];
}

const sourceSupportFact = 'Anthropic 开放 Model Hardware Standard（MHS）研究预览。';
const sourceSupportExcerpt = 'Anthropic is opening a research preview of the Model Hardware Standard (MHS), '
  + 'a shared specification for AI agents to safely operate physical devices, '
  + 'to a first group of scientific research labs and advanced manufacturers.';

async function sourceSupportFixture() {
  const state = fixture('verifying', 4);
  state.db.sqlite.prepare('DELETE FROM manual_news_leads').run();
  state.db.sqlite.prepare('DELETE FROM manual_news_evidence').run();
  const submitted = await submitManualNewsLead(state.env, {
    date: '2026-08-28', text: sourceSupportFact,
    url: 'https://www.anthropic.com/news/model-hardware-standard-research-preview', note: '',
    candidate_authorization: 'source_support_v1',
  }, 'submit-source-support-proof', 10);
  state.db.sqlite.prepare(`UPDATE manual_news_leads SET status = 'verifying', version = 4,
    processing_owner = ?, processing_attempt = 1 WHERE id = ?`).run(PROCESSING_OWNER, submitted.lead.id);
  const evidence = withSignedArticleTextV2Audit({
    id: 'ev-anthropic-mhs',
    url: 'https://www.anthropic.com/news/model-hardware-standard-research-preview',
    source_type: 'official_primary', publisher: 'Anthropic',
    published_at: '2026-08-28T00:00:00.000Z', retrieved_at: 11,
    title: 'Previewing the Model Hardware Standard \\ Anthropic',
    excerpt: sourceSupportExcerpt, claims_supported: [sourceSupportExcerpt], reliable: true,
  });
  state.db.sqlite.prepare(`INSERT INTO manual_news_evidence (
    lead_id, evidence_id, response_key_id, url, source_type, publisher, published_at, retrieved_at,
    title, excerpt, claims_supported_json, fetch_audit_json, reliable
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(
    submitted.lead.id, evidence.id, evidence.response_key_id, evidence.url, evidence.source_type,
    evidence.publisher, evidence.published_at, evidence.retrieved_at, evidence.title, evidence.excerpt,
    JSON.stringify(evidence.claims_supported), JSON.stringify(evidence.fetch_audit),
  );
  const authorization = await new D1ManualLeadProcessingStore(state.env)
    .getSourceSupportAuthorization(submitted.lead.id);
  if (!authorization) throw new Error('source support authorization fixture missing');
  const selection = validateManualNewsSourceSupportSelection(
    { evidence_id: evidence.id, quote: sourceSupportExcerpt },
    { fact: sourceSupportFact, evidence: [evidence] },
  );
  const verification = validateManualNewsSourceSupportVerification(
    { supported: true, evidence_id: evidence.id }, selection,
  );
  const payload = await createManualNewsSourceSupportPayload({
    lead: {
      id: submitted.lead.id, review_date: '2026-08-28', input_type: 'text_url',
      input_text: sourceSupportFact, input_url: evidence.url, note: '',
    },
    authorization, evidence: [evidence], selection, verification,
  });
  const assessmentVersion = 4_000_001;
  const proof = await createManualNewsSourceSupportProof(
    { lead_id: submitted.lead.id, assessment_version: assessmentVersion, payload },
    testManualNewsVerificationKeyring(VERIFICATION_SECRET), testManualNewsResponseKeyring(),
  );
  return { ...state, leadId: submitted.lead.id, evidence, payload, proof, assessmentVersion };
}

async function addSourceSupportLead(
  state: { db: SqliteD1; env: Env },
  input: {
    idempotencyKey: string;
    owner: string;
    fact: string;
    excerpt: string;
    url: string;
    evidenceId: string;
    publisher: string;
    now: number;
  },
) {
  const submitted = await submitManualNewsLead(state.env, {
    date: '2026-08-28', text: input.fact, url: input.url, note: '',
    candidate_authorization: 'source_support_v1',
  }, input.idempotencyKey, input.now);
  state.db.sqlite.prepare(`UPDATE manual_news_leads SET status = 'verifying', version = 4,
    processing_owner = ?, processing_attempt = 1 WHERE id = ?`).run(input.owner, submitted.lead.id);
  const evidence = withSignedArticleTextV2Audit({
    id: input.evidenceId, url: input.url, source_type: 'official_primary',
    publisher: input.publisher, published_at: '2026-08-28T00:00:00.000Z',
    retrieved_at: input.now + 1, title: input.fact, excerpt: input.excerpt,
    claims_supported: [input.excerpt], reliable: true,
  });
  state.db.sqlite.prepare(`INSERT INTO manual_news_evidence (
    lead_id, evidence_id, response_key_id, url, source_type, publisher, published_at, retrieved_at,
    title, excerpt, claims_supported_json, fetch_audit_json, reliable
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(
    submitted.lead.id, evidence.id, evidence.response_key_id, evidence.url, evidence.source_type,
    evidence.publisher, evidence.published_at, evidence.retrieved_at, evidence.title, evidence.excerpt,
    JSON.stringify(evidence.claims_supported), JSON.stringify(evidence.fetch_audit),
  );
  const authorization = await new D1ManualLeadProcessingStore(state.env)
    .getSourceSupportAuthorization(submitted.lead.id);
  if (!authorization) throw new Error('source support authorization fixture missing');
  const selection = validateManualNewsSourceSupportSelection(
    { evidence_id: evidence.id, quote: input.excerpt },
    { fact: input.fact, evidence: [evidence] },
  );
  const verification = validateManualNewsSourceSupportVerification(
    { supported: true, evidence_id: evidence.id }, selection,
  );
  const payload = await createManualNewsSourceSupportPayload({
    lead: {
      id: submitted.lead.id, review_date: '2026-08-28', input_type: 'text_url',
      input_text: input.fact, input_url: input.url, note: '',
    },
    authorization, evidence: [evidence], selection, verification,
  });
  return { leadId: submitted.lead.id, evidence, payload, owner: input.owner };
}

function installSourceSupportReviewSchema(
  state: { db: SqliteD1 },
  candidates: Array<Record<string, unknown>> = Array.from({ length: 10 }, (_, index) => ({
    item_id: `auto-${index + 1}`, title: `自动${index + 1}`, summary: '摘要', source: '来源',
    score: 100 - index, event_key: `automatic-event-${index + 1}`,
  })),
): void {
  state.db.sqlite.exec(`
    ALTER TABLE items ADD COLUMN source_type TEXT;
    ALTER TABLE items ADD COLUMN source_id TEXT;
    ALTER TABLE items ADD COLUMN title TEXT;
    ALTER TABLE items ADD COLUMN content TEXT;
    ALTER TABLE items ADD COLUMN content_translated TEXT;
    ALTER TABLE items ADD COLUMN author TEXT;
    ALTER TABLE items ADD COLUMN url TEXT;
    ALTER TABLE items ADD COLUMN matched_by TEXT;
    ALTER TABLE items ADD COLUMN lang TEXT;
    CREATE TABLE daily_news_review_batches (
      review_date TEXT NOT NULL, batch_id TEXT NOT NULL,
      candidate_ids TEXT NOT NULL, candidates_json TEXT NOT NULL,
      default_selected_ids TEXT NOT NULL, applied_selected_ids TEXT,
      selection_hash TEXT, edit_revision INTEGER NOT NULL DEFAULT 0,
      publish_status TEXT NOT NULL DEFAULT 'not_requested', publish_error TEXT,
      published_at INTEGER, notified_at INTEGER, notification_hash TEXT,
      auto_repaired_from_batch TEXT, auto_repaired_invalid_ids TEXT,
      superseded_by TEXT, human_reviewed INTEGER NOT NULL DEFAULT 0,
      batch_revision INTEGER NOT NULL DEFAULT 1, supersedes_batch_id TEXT,
      revision_origin TEXT NOT NULL DEFAULT 'scheduled_freeze',
      lineage_id TEXT NOT NULL, is_current INTEGER NOT NULL DEFAULT 0,
      candidate_generation INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      PRIMARY KEY (review_date, batch_id)
    );
    CREATE UNIQUE INDEX idx_daily_news_review_one_current
      ON daily_news_review_batches(review_date, lineage_id) WHERE is_current = 1;
    CREATE TABLE daily_news_review_candidate_generations (
      review_date TEXT NOT NULL, lineage_id TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
      PRIMARY KEY (review_date, lineage_id)
    );
    CREATE TABLE sources (
      id TEXT PRIMARY KEY, source_type TEXT NOT NULL, source_ref TEXT, name TEXT, config TEXT
    );
  `);
  const candidateIds = candidates.map((candidate) => candidate.item_id);
  state.db.sqlite.prepare(`INSERT INTO daily_news_review_batches (
    review_date, batch_id, candidate_ids, candidates_json, default_selected_ids,
    applied_selected_ids, selection_hash, edit_revision, publish_status, publish_error,
    published_at, notified_at, notification_hash, auto_repaired_from_batch,
    auto_repaired_invalid_ids, superseded_by, human_reviewed, batch_revision,
    supersedes_batch_id, revision_origin, lineage_id, is_current, candidate_generation,
    created_at, expires_at
  ) VALUES ('2026-08-28', 'batch-r1', ?, ?, ?, NULL, NULL, 0, 'not_requested', NULL,
    NULL, NULL, NULL, NULL, '[]', NULL, 0, 1, NULL, 'scheduled_freeze',
    '2026-08-28', 1, 0, 1, 9999999999999)`).run(
    JSON.stringify(candidateIds), JSON.stringify(candidates), JSON.stringify(candidateIds.slice(0, 5)),
  );
  state.db.sqlite.prepare(`INSERT INTO daily_news_review_candidate_generations
    (review_date, lineage_id, generation, updated_at) VALUES ('2026-08-28', '2026-08-28', 0, 1)`).run();
}

function installSourceSupportAutomaticPool(
  state: { db: SqliteD1 },
  mhsIndex: number | null,
): Array<Record<string, unknown>> {
  const feed = FEED_REGISTRY.find((entry) => entry.id === 'blog:anthropic');
  if (!feed) throw new Error('Anthropic feed fixture missing');
  state.db.sqlite.exec(`CREATE TABLE digest_pool (
    id INTEGER PRIMARY KEY AUTOINCREMENT, slot_key TEXT NOT NULL, source TEXT NOT NULL,
    density TEXT NOT NULL, item_ids TEXT NOT NULL, items_meta TEXT, generated_at INTEGER NOT NULL,
    UNIQUE(slot_key, source, density)
  )`);
  state.db.sqlite.prepare(
    `INSERT INTO sources(id, source_type, source_ref, name, config) VALUES (?, ?, ?, ?, ?)`,
  ).run(feed.id, feed.kind, feed.key, feed.name, JSON.stringify(feed));
  const realMhsFingerprint = normalizeFeedEventFingerprint({
    event_type: 'research_result', primary_actor: 'Anthropic',
    primary_object: 'Model Hardware Standard (MHS)', object_family: '', object_variant: '',
    object_version: '', action: 'other', canonical_event: 'Anthropic MHS research preview',
    confidence: 0.98,
  });
  if (!realMhsFingerprint) throw new Error('MHS fingerprint fixture missing');
  const candidates = Array.from({ length: 10 }, (_, index) => {
    const sourceId = `${feed.key}:pool-${index + 1}`;
    const itemId = `blog:${sourceId}`;
    const title = `自动候选${index + 1}`;
    const summary = `自动摘要${index + 1}`;
    const url = `https://www.anthropic.com/news/pool-${index + 1}`;
    const extra = {
      feed_id: feed.id,
      feed_key: feed.key,
      editorial_type: feed.editorial_type,
      title_zh: title,
      ai_summary_zh: summary,
      source_company: feed.name,
      ...(index === mhsIndex ? { event_fingerprint: realMhsFingerprint } : {}),
    };
    state.db.sqlite.prepare(`INSERT INTO items (
      id, source_type, source_id, source_ref, title, content, content_translated, author,
      url, published_at, scraped_at, is_relevant, matched_by, lang, extra, deleted_at
    ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, '2026-08-28T00:00:00.000Z',
      '2026-08-28T00:00:00.000Z', 1, 'feed', 'zh', ?, NULL)`).run(
      itemId, feed.kind, sourceId, title, summary, summary, feed.name, url,
      JSON.stringify(extra),
    );
    return {
      // published_at 跟在 url 之后 —— 与 freezeNewsReviewBatchFromPool 里候选字面量的
      // 展开顺序逐字对应,这两处黄金串比较是逐字节的。
      item_id: itemId, title, summary, source: feed.name, score: 100 - index, url,
      published_at: '2026-08-28T00:00:00.000Z',
    };
  });
  state.db.sqlite.prepare(`INSERT INTO digest_pool (
    slot_key, source, density, item_ids, items_meta, generated_at
  ) VALUES ('2026-08-28-08', 'news', 'normal', ?, ?, 1)`).run(
    JSON.stringify(candidates.slice(0, 5).map((candidate) => candidate.item_id)),
    JSON.stringify({
      candidate_ids_after_exact_dedup: candidates.map((candidate) => candidate.item_id),
      candidates: candidates.map((candidate, index) => ({
        rank: index + 1,
        id: candidate.item_id,
        title: candidate.title,
        title_zh: candidate.title,
        source_company: candidate.source,
        adjusted_score: candidate.score,
      })),
    }),
  );
  return candidates;
}

function replacementEvidence(count: number): ManualNewsEvidence[] {
  return Array.from({ length: count }, (_, index) => withSignedArticleTextV2Audit({
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

function insertPersistedEvidenceCopy(
  state: ReturnType<typeof fixture>,
  evidenceId: string,
  url: string,
): void {
  state.db.sqlite.prepare(`INSERT INTO manual_news_evidence (
    lead_id, evidence_id, url, source_type, publisher, published_at, retrieved_at,
    title, excerpt, claims_supported_json, fetch_audit_json, reliable
  ) SELECT lead_id, ?, ?, source_type, publisher, published_at, retrieved_at,
    title, excerpt, claims_supported_json, fetch_audit_json, reliable
    FROM manual_news_evidence WHERE lead_id = ? LIMIT 1`).run(evidenceId, url, state.leadId);
}

function allowDuplicatePersistedEvidenceIds(state: ReturnType<typeof fixture>): void {
  state.db.sqlite.exec(`
    ALTER TABLE manual_news_evidence RENAME TO manual_news_evidence_unique;
    CREATE TABLE manual_news_evidence (
      lead_id TEXT NOT NULL, evidence_id TEXT NOT NULL,
      response_key_id TEXT NOT NULL DEFAULT 'response-key-2026-08-11',
      url TEXT NOT NULL, source_type TEXT NOT NULL,
      publisher TEXT NOT NULL, published_at TEXT, retrieved_at INTEGER NOT NULL, title TEXT NOT NULL,
      excerpt TEXT NOT NULL, claims_supported_json TEXT NOT NULL, fetch_audit_json TEXT NOT NULL DEFAULT 'null',
      reliable INTEGER NOT NULL
    );
    INSERT INTO manual_news_evidence SELECT * FROM manual_news_evidence_unique;
    INSERT INTO manual_news_evidence SELECT * FROM manual_news_evidence_unique;
    DROP TABLE manual_news_evidence_unique;
  `);
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
    evidence_dispositions?: Array<{ evidence_id: string; disposition: string }>;
  };
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
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
    ...(promptBody.evidence_dispositions?.length ? {
      disposition_results: promptBody.evidence_dispositions.map((disposition) => {
        const item = evidenceById.get(disposition.evidence_id)!;
        return {
          evidence_id: disposition.evidence_id,
          disposition: disposition.disposition,
          supported: true,
          issue_code: 'none',
          source_quotes: [{ evidence_id: item.id, quote: item.excerpt }],
        };
      }),
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

async function addTruncatedExactPriorContext(state: ReturnType<typeof fixture>) {
  const targetEventKey = assessment().event_key;
  const priorLeadId = 'manual-prior-exact-truncated';
  state.db.sqlite.prepare(`INSERT INTO manual_news_leads (
    id, review_date, input_type, input_text, input_url, note, status, version,
    submit_idempotency_key, processing_owner, processing_attempt, created_at, updated_at
  ) VALUES (?, '2026-07-29', 'url', '', 'https://support.claude.com/example', '', 'verifying', 4,
    ?, ?, 1, 1, 1)`).run(priorLeadId, `submit-${priorLeadId}`, PROCESSING_OWNER);
  state.db.sqlite.prepare(`INSERT INTO manual_news_evidence (
    lead_id, evidence_id, response_key_id, url, source_type, publisher, published_at,
    retrieved_at, title, excerpt, claims_supported_json, fetch_audit_json, reliable
  ) SELECT ?, evidence_id, response_key_id, url, source_type, publisher, published_at,
    retrieved_at, title, excerpt, claims_supported_json, fetch_audit_json, reliable
    FROM manual_news_evidence WHERE lead_id = ?`).run(priorLeadId, state.leadId);
  await saveFixtureAssessment(
    new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1),
    priorLeadId,
    4,
    { ...processedAssessment(), event_key: targetEventKey },
  );
  for (let index = 0; index < 24; index += 1) {
    state.db.sqlite.prepare(`INSERT INTO items (
      id, source_ref, extra, published_at, scraped_at, is_relevant, deleted_at
    ) VALUES (?, 'rss', ?, '2026-08-11', '2026-08-11', 1, NULL)`).run(
      `newer-automatic-prior-${String(index).padStart(2, '0')}`,
      JSON.stringify({ event_fingerprint: `newer-automatic-event-${String(index).padStart(2, '0')}` }),
    );
  }
  return { targetEventKey, priorLeadId };
}

function verifyingAdapters(): ManualLeadProcessingAdapters {
  return {
    search: async () => [], fetch: async () => { throw new Error('unused'); },
    extract: async () => null, assess: async () => generatedAssessment(),
    verify: async (prompt) => {
      const body = JSON.parse(prompt.user) as {
        untrusted_evidence: Array<{ id: string; excerpt: string }>;
        facts: Array<{ fact_id: string; allowed_evidence_ids: string[] }>;
        projections?: Array<{ projection_id: string; source_fact_ids: string[] }>;
        evidence_dispositions?: Array<{ evidence_id: string; disposition: string }>;
      };
      const evidenceById = new Map(body.untrusted_evidence.map((item) => [item.id, item]));
      return {
        overall_verdict: 'supported',
        fact_results: body.facts.map((fact) => {
          const evidence = evidenceById.get(fact.allowed_evidence_ids[0])!;
          return {
            fact_id: fact.fact_id, supported: true, issue_code: 'none',
            source_quotes: [{ evidence_id: evidence.id, quote: evidence.excerpt }],
            ...(fact.fact_id === 'field:material_update' ? {
              comparison_result: {
                value: false, matched_event_key: null, prior_event_keys: [], reason_code: 'no_prior_match',
                current_evidence_id: evidence.id,
                current_quote: evidence.excerpt,
              },
            } : {}),
          };
        }),
        ...(body.projections?.length ? {
          projection_results: body.projections.map((projection) => ({
            projection_id: projection.projection_id, source_fact_ids: projection.source_fact_ids,
            supported: true, issue_code: 'none',
          })),
        } : {}),
        ...(body.evidence_dispositions?.length ? {
          disposition_results: body.evidence_dispositions.map((disposition) => {
            const evidence = evidenceById.get(disposition.evidence_id)!;
            return {
              evidence_id: disposition.evidence_id,
              disposition: disposition.disposition,
              supported: true,
              issue_code: 'none',
              source_quotes: [{ evidence_id: evidence.id, quote: evidence.excerpt }],
            };
          }),
        } : {}),
      };
    },
  };
}

describe('manual lead D1-backed dedupe', () => {
  test('persists one assessment generation and one regeneration across Workflow fencing attempts', async () => {
    const state = fixture('verifying', 4);
    const first = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1);

    const initial = await first.beginAssessmentGenerationCycle(state.leadId, 4);
    expect(initial).toMatchObject({ acquired_call: true, generation_revision: 1, call_state: 'initial_started' });

    const attempt2 = await claimManualNewsLeadProcessing(state.env, state.leadId, PROCESSING_OWNER, 10);
    expect(attempt2).toBe(2);
    const resumed = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 2);
    expect(await resumed.beginAssessmentGenerationCycle(state.leadId, 4)).toMatchObject({
      acquired_call: false, generation_revision: 1, call_state: 'initial_started',
    });
    await expect(first.recordAssessmentGenerationValidation(state.leadId, 4, {
      generation_revision: 1, validation_code: 'non_atomic_source_object',
      validation_path: 'source_facts[0].atomic_fact.object', regeneratable: true,
    })).rejects.toThrow(/stale_processing_owner/);

    await resumed.recordAssessmentGenerationValidation(state.leadId, 4, {
      generation_revision: 1, validation_code: 'non_atomic_source_object',
      validation_path: 'source_facts[0].atomic_fact.object', regeneratable: true,
    });
    expect(await resumed.consumeAssessmentRegeneration(state.leadId, 4)).toMatchObject({
      acquired_call: true, generation_revision: 2, call_state: 'regeneration_started',
    });

    const attempt3 = await claimManualNewsLeadProcessing(state.env, state.leadId, PROCESSING_OWNER, 20);
    expect(attempt3).toBe(3);
    const resumedAgain = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 3);
    expect(await resumedAgain.consumeAssessmentRegeneration(state.leadId, 4)).toMatchObject({
      acquired_call: false, generation_revision: 2, call_state: 'regeneration_started',
    });

    expect(state.db.sqlite.prepare(`SELECT generation_revision, call_kind, call_state
      FROM manual_news_assessment_generation_revisions_v2 ORDER BY generation_revision`).all()).toEqual([
      { generation_revision: 1, call_kind: 'initial', call_state: 'validation_failed' },
      { generation_revision: 2, call_kind: 'regeneration', call_state: 'started' },
    ]);
  });

  test('ignores unverifiable legacy v1 generation state and starts a fresh v2 initial revision', async () => {
    const state = fixture('verifying', 4);
    state.db.sqlite.exec(`CREATE TABLE manual_news_assessment_generation_cycles (
      cycle_id TEXT PRIMARY KEY, lead_id TEXT NOT NULL, processing_owner TEXT NOT NULL,
      base_version INTEGER NOT NULL, call_state TEXT NOT NULL,
      regeneration_consumed INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`);
    state.db.sqlite.prepare(`INSERT INTO manual_news_assessment_generation_cycles (
      cycle_id, lead_id, processing_owner, base_version, call_state,
      regeneration_consumed, created_at, updated_at
    ) VALUES ('legacy-v1-cycle', ?, ?, 4, 'regeneration_started', 1, 1, 1)`).run(
      state.leadId, PROCESSING_OWNER,
    );

    const cycle = await new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1)
      .beginAssessmentGenerationCycle(state.leadId, 4);

    expect(cycle).toMatchObject({
      generation_revision: 1, regeneration_consumed: false,
      call_state: 'initial_started', acquired_call: true,
    });
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count
      FROM manual_news_assessment_generation_cycles_v2 WHERE lead_id = ?`).get(state.leadId))
      .toEqual({ count: 1 });
    expect(state.db.sqlite.prepare(`SELECT call_state, regeneration_consumed
      FROM manual_news_assessment_generation_cycles WHERE cycle_id = 'legacy-v1-cycle'`).get())
      .toEqual({ call_state: 'regeneration_started', regeneration_consumed: 1 });
  });

  test('binds start, result, and regeneration audits to the exact concurrent mutation nonce', async () => {
    const state = fixture('verifying', 4);
    const firstStore = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1);
    const secondStore = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1);

    const startBarrier = state.db.pauseNextFirstCalls('manual_generation:current_fenced', 2);
    const startOne = firstStore.beginAssessmentGenerationCycle(state.leadId, 4);
    const startTwo = secondStore.beginAssessmentGenerationCycle(state.leadId, 4);
    await startBarrier.entered;
    startBarrier.release();
    const starts = await Promise.all([startOne, startTwo]);
    expect(starts.filter((result) => result.acquired_call)).toHaveLength(1);

    const cycleStart = state.db.sqlite.prepare(`SELECT start_nonce FROM manual_news_assessment_generation_cycles_v2
      WHERE lead_id = ? AND is_current = 1`).get(state.leadId) as { start_nonce: string };
    const revisionStart = state.db.sqlite.prepare(`SELECT start_nonce FROM manual_news_assessment_generation_revisions_v2
      WHERE generation_revision = 1`).get() as { start_nonce: string };
    const startAudits = state.db.sqlite.prepare(`SELECT mutation_nonce FROM manual_news_lead_audit
      WHERE lead_id = ? AND action = 'assessment_generation_start_1'`).all(state.leadId) as Array<{ mutation_nonce: string }>;
    expect(startAudits).toEqual([{ mutation_nonce: cycleStart.start_nonce }]);
    expect(revisionStart.start_nonce).toBe(cycleStart.start_nonce);

    const resultBarrier = state.db.pauseNextFirstCalls('manual_generation:current_fenced', 2);
    const validation = {
      generation_revision: 1 as const,
      validation_code: 'non_atomic_source_object',
      validation_path: 'source_facts[0].atomic_fact.object',
      regeneratable: true,
    };
    const resultOne = firstStore.recordAssessmentGenerationValidation(state.leadId, 4, validation);
    const resultTwo = secondStore.recordAssessmentGenerationValidation(state.leadId, 4, validation);
    await resultBarrier.entered;
    resultBarrier.release();
    await expect(Promise.all([resultOne, resultTwo])).resolves.toHaveLength(2);

    const cycleResult = state.db.sqlite.prepare(`SELECT last_result_nonce
      FROM manual_news_assessment_generation_cycles_v2 WHERE lead_id = ? AND is_current = 1`)
      .get(state.leadId) as { last_result_nonce: string };
    const revisionResult = state.db.sqlite.prepare(`SELECT result_nonce
      FROM manual_news_assessment_generation_revisions_v2 WHERE generation_revision = 1`)
      .get() as { result_nonce: string };
    const resultAudits = state.db.sqlite.prepare(`SELECT mutation_nonce FROM manual_news_lead_audit
      WHERE lead_id = ? AND action = 'assessment_generation_result_1'`).all(state.leadId) as Array<{ mutation_nonce: string }>;
    expect(resultAudits).toEqual([{ mutation_nonce: cycleResult.last_result_nonce }]);
    expect(revisionResult.result_nonce).toBe(cycleResult.last_result_nonce);

    const regenerationBarrier = state.db.pauseNextFirstCalls('manual_generation:current_fenced', 2);
    const regenerationOne = firstStore.consumeAssessmentRegeneration(state.leadId, 4);
    const regenerationTwo = secondStore.consumeAssessmentRegeneration(state.leadId, 4);
    await regenerationBarrier.entered;
    regenerationBarrier.release();
    const regenerations = await Promise.all([regenerationOne, regenerationTwo]);
    expect(regenerations.filter((result) => result.acquired_call)).toHaveLength(1);

    const cycleRegeneration = state.db.sqlite.prepare(`SELECT regeneration_nonce
      FROM manual_news_assessment_generation_cycles_v2 WHERE lead_id = ? AND is_current = 1`)
      .get(state.leadId) as { regeneration_nonce: string };
    const revisionRegeneration = state.db.sqlite.prepare(`SELECT start_nonce
      FROM manual_news_assessment_generation_revisions_v2 WHERE generation_revision = 2`)
      .get() as { start_nonce: string };
    const regenerationAudits = state.db.sqlite.prepare(`SELECT mutation_nonce FROM manual_news_lead_audit
      WHERE lead_id = ? AND action = 'assessment_generation_start_2'`).all(state.leadId) as Array<{ mutation_nonce: string }>;
    expect(regenerationAudits).toEqual([{ mutation_nonce: cycleRegeneration.regeneration_nonce }]);
    expect(revisionRegeneration.start_nonce).toBe(cycleRegeneration.regeneration_nonce);

    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM manual_news_lead_audit
      WHERE lead_id = ? AND action IN (
        'assessment_generation_start_1', 'assessment_generation_result_1', 'assessment_generation_start_2'
      )`).get(state.leadId)).toEqual({ count: 3 });
  });

  test('an old generation nonce cannot mutate or audit a superseding current-cycle lineage', async () => {
    const state = fixture('verifying', 4);
    const oldStore = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1);
    const oldCycle = await oldStore.beginAssessmentGenerationCycle(state.leadId, 4);
    await oldStore.recordAssessmentGenerationValidation(state.leadId, 4, {
      generation_revision: 1,
      validation_code: 'non_atomic_source_object',
      validation_path: 'source_facts[0].atomic_fact.object',
      regeneratable: false,
    });
    state.db.sqlite.prepare(`UPDATE manual_news_leads SET status = 'needs_review', version = 5,
      processing_owner = NULL, processing_lease_until = NULL WHERE id = ?`).run(state.leadId);

    const retried = await retryManualNewsLead(state.env, state.leadId, 5, 'retry-generation-aba', 50);
    expect(retried).toMatchObject({ ok: true, changed: true, lead: { version: 6 } });
    if (!retried.ok) throw new Error('expected retry success');
    state.db.sqlite.prepare(`UPDATE manual_news_leads SET status = 'verifying' WHERE id = ?`).run(state.leadId);
    const nextOwner = `manual-news-${state.leadId}-v6`;
    const nextStore = new D1ManualLeadProcessingStore(state.env, nextOwner, 1);
    const nextCycle = await nextStore.beginAssessmentGenerationCycle(state.leadId, 6);
    expect(nextCycle.cycle_id).not.toBe(oldCycle.cycle_id);

    const auditsBefore = state.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM manual_news_lead_audit
      WHERE lead_id = ? AND action LIKE 'assessment_generation_%'`).get(state.leadId);
    await expect(oldStore.recordAssessmentGenerationValidation(state.leadId, 4, {
      generation_revision: 1, validation_code: 'valid', regeneratable: false,
      validated_assessment: processedAssessment(),
    })).rejects.toThrow(/stale_processing_owner/);
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM manual_news_lead_audit
      WHERE lead_id = ? AND action LIKE 'assessment_generation_%'`).get(state.leadId)).toEqual(auditsBefore);
    expect(state.db.sqlite.prepare(`SELECT cycle_id, is_current, call_state FROM manual_news_assessment_generation_cycles_v2
      WHERE lead_id = ? ORDER BY created_at, cycle_id`).all(state.leadId)).toEqual(expect.arrayContaining([
        { cycle_id: oldCycle.cycle_id, is_current: 0, call_state: 'superseded' },
        { cycle_id: nextCycle.cycle_id, is_current: 1, call_state: 'initial_started' },
      ]));
  });

  test('manual retry supersedes the old generation cycle and hides its diagnostics', async () => {
    const state = fixture('verifying', 4);
    const store = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1);
    await store.beginAssessmentGenerationCycle(state.leadId, 4);
    await store.recordAssessmentGenerationValidation(state.leadId, 4, {
      generation_revision: 1, validation_code: 'non_atomic_source_object',
      validation_path: 'source_facts[0].atomic_fact.object', regeneratable: false,
    });
    state.db.sqlite.prepare(`UPDATE manual_news_leads SET status = 'needs_review', version = 5,
      processing_owner = NULL, processing_lease_until = NULL WHERE id = ?`).run(state.leadId);

    const retried = await retryManualNewsLead(state.env, state.leadId, 5, 'retry-cycle-1', 30);
    expect(retried).toMatchObject({ ok: true, changed: true });
    if (!retried.ok) throw new Error('expected retry success');
    expect('assessment_generation' in retried.lead).toBe(false);
    expect(state.db.sqlite.prepare(`SELECT call_state, superseded_by_processing_owner
      FROM manual_news_assessment_generation_cycles_v2`).get()).toMatchObject({
      call_state: 'superseded',
    });
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM manual_news_assessment_generation_cycles_v2
      WHERE lead_id = ? AND is_current = 1`).get(state.leadId)).toEqual({ count: 0 });
  });

  test('exposes generation diagnostics only for the lead row current cycle owner and base version', async () => {
    const state = fixture('verifying', 4);
    const store = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1);
    await store.beginAssessmentGenerationCycle(state.leadId, 4);
    await store.recordAssessmentGenerationValidation(state.leadId, 4, {
      generation_revision: 1,
      validation_code: 'non_atomic_source_object',
      validation_path: 'source_facts[0].atomic_fact.object',
      regeneratable: false,
    });
    await expect(getManualNewsLead(state.env, state.leadId)).resolves.toMatchObject({
      assessment_generation: {
        assessment_generation_attempts: 1,
        assessment_last_validation_code: 'non_atomic_source_object',
      },
    });

    state.db.sqlite.prepare(`UPDATE manual_news_assessment_generation_cycles_v2
      SET processing_owner = 'stale-owner' WHERE lead_id = ?`).run(state.leadId);
    const mismatched = await getManualNewsLead(state.env, state.leadId);
    expect(mismatched && 'assessment_generation' in mismatched).toBe(false);

    state.db.sqlite.prepare(`UPDATE manual_news_assessment_generation_cycles_v2
      SET processing_owner = ? WHERE lead_id = ?`).run(PROCESSING_OWNER, state.leadId);
    state.db.sqlite.prepare(`UPDATE manual_news_leads SET status = 'needs_review', version = 5,
      processing_owner = NULL, processing_lease_until = NULL WHERE id = ?`).run(state.leadId);
    await expect(getManualNewsLead(state.env, state.leadId)).resolves.toMatchObject({
      assessment_generation: {
        assessment_generation_attempts: 1,
        assessment_last_validation_code: 'non_atomic_source_object',
      },
    });
  });
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

  test('loads source-support authority only from the exact immutable submit audit', async () => {
    const state = fixture();
    state.db.sqlite.prepare('DELETE FROM manual_news_leads').run();
    state.db.sqlite.prepare('DELETE FROM manual_news_evidence').run();
    const submitted = await submitManualNewsLead(state.env, {
      date: '2026-08-28',
      text: 'Anthropic 开放 Model Hardware Standard（MHS）研究预览。',
      url: 'https://www.anthropic.com/news/model-hardware-standard-research-preview',
      note: '',
      candidate_authorization: 'source_support_v1',
    }, 'submit-source-support-authority', 21);
    const store = new D1ManualLeadProcessingStore(state.env);

    await expect(store.getSourceSupportAuthorization(submitted.lead.id)).resolves.toMatchObject({
      audit_id: expect.any(Number),
      candidate_authorization: 'source_support_v1',
      submit_identity_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      idempotency_key: 'submit-source-support-authority',
    });

    state.db.sqlite.prepare(`UPDATE manual_news_lead_audit
      SET metadata_json = json_set(metadata_json, '$.submit_identity_digest', ?)
      WHERE lead_id = ? AND action = 'submit'`).run('0'.repeat(64), submitted.lead.id);
    await expect(store.getSourceSupportAuthorization(submitted.lead.id)).resolves.toBeNull();
  });

  test('loads a source-support proof without an assessment row and revalidates its HMAC snapshot', async () => {
    const state = await sourceSupportFixture();
    state.db.sqlite.prepare(`INSERT INTO manual_news_assessment_verifications (
      verification_id, lead_id, assessment_version, policy_version, verification_key_id,
      canonical_digest, hmac_sha256, verification_json, processing_owner, processing_attempt,
      creation_nonce, status, reason, created_at, invalidated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'active', NULL, 12, NULL)`).run(
      `mav:${state.leadId}:source-support`, state.leadId, state.assessmentVersion,
      state.proof.policy_version, state.proof.verification_key_id,
      state.proof.canonical_digest, state.proof.hmac_sha256, JSON.stringify(state.payload),
      PROCESSING_OWNER, 'source-support-proof-create',
    );

    await expect(loadVerifiedManualCandidateProof(state.env, state.leadId)).resolves.toMatchObject({
      policy_version: 'source_support_v1',
      candidate: {
        item_id: `blog:manual:${state.leadId}`,
        title: sourceSupportFact,
        summary: sourceSupportFact,
        score: null,
        event_key: state.payload.event_identity.event_key,
      },
      record: { policy_version: 'source_support_v1' },
    });
    expect(state.db.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM manual_news_event_assessments WHERE lead_id = ?',
    ).get(state.leadId)).toEqual({ count: 0 });
    expect(state.db.preparedSql.some((sql) => sql.includes('manual_verification:source_support')
      && /manual_news_event_assessments/i.test(sql))).toBe(false);
  });

  test('fails hidden on an unknown verification policy before any evidence load or quarantine write', async () => {
    const state = await sourceSupportFixture();
    state.db.sqlite.prepare(`INSERT INTO manual_news_assessment_verifications (
      verification_id, lead_id, assessment_version, policy_version, verification_key_id,
      canonical_digest, hmac_sha256, verification_json, processing_owner, processing_attempt,
      creation_nonce, status, reason, created_at, invalidated_at
    ) VALUES (?, ?, ?, 'future-policy-v99', ?, ?, ?, ?, ?, 1, ?, 'active', NULL, 12, NULL)`).run(
      `mav:${state.leadId}:unknown`, state.leadId, state.assessmentVersion,
      state.proof.verification_key_id, state.proof.canonical_digest, state.proof.hmac_sha256,
      JSON.stringify(state.payload), PROCESSING_OWNER, 'unknown-proof-create',
    );
    const sqlStart = state.db.preparedSql.length;
    state.db.rejectEvidenceBlobMaterialization = true;

    await expect(loadVerifiedManualCandidateProof(state.env, state.leadId)).resolves.toBeNull();

    const sql = state.db.preparedSql.slice(sqlStart).join('\n');
    expect(sql).not.toContain('manual_evidence:');
    expect(sql).not.toContain('manual_verification:quarantine');
    expect(state.db.sqlite.prepare(`SELECT status, reason FROM manual_news_assessment_verifications
      WHERE lead_id = ?`).get(state.leadId)).toEqual({ status: 'active', reason: null });
  });

  test('derives bounded 14-day prior-event identities only from real automatic fingerprints', async () => {
    const state = await sourceSupportFixture();
    const fingerprint = {
      event_type: 'research_result', primary_actor: 'Anthropic',
      primary_object: 'Model Hardware Standard (MHS)', object_family: '', object_variant: '',
      object_version: '', action: 'preview', canonical_event: 'Anthropic MHS research preview',
      confidence: 0.98,
    };
    state.db.sqlite.prepare(`INSERT INTO items (
      id, source_ref, extra, published_at, scraped_at, is_relevant, deleted_at
    ) VALUES (?, 'rss', ?, '2026-08-20', '2026-08-20', 1, NULL)`).run(
      'automatic-mhs-prior', JSON.stringify({ event_fingerprint: fingerprint }),
    );
    state.db.sqlite.prepare(`INSERT INTO items (
      id, source_ref, extra, published_at, scraped_at, is_relevant, deleted_at
    ) VALUES (?, 'rss', ?, '2026-08-01', '2026-08-01', 1, NULL)`).run(
      'automatic-mhs-too-old', JSON.stringify({ event_fingerprint: fingerprint }),
    );
    state.db.sqlite.prepare(`INSERT INTO items (
      id, source_ref, extra, published_at, scraped_at, is_relevant, deleted_at
    ) VALUES (?, 'rss', ?, '2026-08-21', '2026-08-21', 1, NULL)`).run(
      'automatic-unstructured', JSON.stringify({ title: sourceSupportFact }),
    );

    await expect(new D1ManualLeadProcessingStore(state.env)
      .listSourceSupportPriorEvents('2026-08-28', state.leadId)).resolves.toEqual([{
      event_key: state.payload.event_identity.event_key,
      review_date: '2026-08-20',
      origin: 'automatic',
      item_id: 'automatic-mhs-prior',
    }]);
  });

  test('bulk-verifies the legal 700 source-support prior proofs with a fixed query bound', async () => {
    const state = await sourceSupportFixture();
    const selection = validateManualNewsSourceSupportSelection(
      { evidence_id: state.evidence.id, quote: sourceSupportExcerpt },
      { fact: sourceSupportFact, evidence: [state.evidence] },
    );
    const verification = validateManualNewsSourceSupportVerification(
      { supported: true, evidence_id: state.evidence.id }, selection,
    );
    const leadInsert = state.db.sqlite.prepare(`INSERT INTO manual_news_leads (
      id, review_date, input_type, input_text, input_url, note, status, version,
      submit_idempotency_key, processing_owner, processing_attempt, confirmed_at,
      created_at, updated_at
    ) VALUES (?, '2026-08-27', 'text_url', ?, ?, '', 'recommended', 5, ?, NULL, 1, 1, 1, 1)`);
    const auditInsert = state.db.sqlite.prepare(`INSERT INTO manual_news_lead_audit (
      lead_id, action, from_status, to_status, idempotency_key, mutation_nonce,
      resulting_version, metadata_json, created_at
    ) VALUES (?, 'submit', NULL, 'submitted', ?, ?, 1, ?, 1)`);
    const evidenceInsert = state.db.sqlite.prepare(`INSERT INTO manual_news_evidence (
      lead_id, evidence_id, response_key_id, url, source_type, publisher, published_at,
      retrieved_at, title, excerpt, claims_supported_json, fetch_audit_json, reliable
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`);
    const proofInsert = state.db.sqlite.prepare(`INSERT INTO manual_news_assessment_verifications (
      verification_id, lead_id, assessment_version, policy_version, verification_key_id,
      canonical_digest, hmac_sha256, verification_json, processing_owner, processing_attempt,
      creation_nonce, status, reason, created_at, invalidated_at
    ) VALUES (?, ?, 5000001, 'source_support_v1', ?, ?, ?, ?, 'prior-owner', 1,
      ?, 'active', NULL, ?, NULL)`);
    const leadIds: string[] = [];
    for (let index = 0; index < 700; index += 1) {
      const leadId = `ml-20260827-prior-${String(index).padStart(4, '0')}`;
      const idempotencyKey = `submit-prior-${index}`;
      const submitIdentityDigest = index.toString(16).padStart(64, '0');
      leadInsert.run(leadId, sourceSupportFact, state.evidence.url, idempotencyKey);
      const metadata = JSON.stringify({
        input_type: 'text_url', candidate_authorization: 'source_support_v1',
        submit_identity_contract: 'manual_news_submit_identity_v1',
        submit_identity_digest: submitIdentityDigest,
      });
      const audit = auditInsert.run(
        leadId, idempotencyKey, `submit-prior-nonce-${index}`, metadata,
      );
      const auditId = Number(audit.lastInsertRowid);
      evidenceInsert.run(
        leadId, state.evidence.id, state.evidence.response_key_id, state.evidence.url,
        state.evidence.source_type, state.evidence.publisher, state.evidence.published_at,
        state.evidence.retrieved_at, state.evidence.title, state.evidence.excerpt,
        JSON.stringify(state.evidence.claims_supported), JSON.stringify(state.evidence.fetch_audit),
      );
      const priorPayload = await createManualNewsSourceSupportPayload({
        lead: {
          id: leadId, review_date: '2026-08-27', input_type: 'text_url',
          input_text: sourceSupportFact, input_url: state.evidence.url, note: '',
        },
        authorization: {
          audit_id: auditId, candidate_authorization: 'source_support_v1',
          submit_identity_digest: submitIdentityDigest, idempotency_key: idempotencyKey,
        },
        evidence: [state.evidence], selection, verification,
      });
      const priorProof = await createManualNewsSourceSupportProof(
        { lead_id: leadId, assessment_version: 5_000_001, payload: priorPayload },
        testManualNewsVerificationKeyring(VERIFICATION_SECRET), testManualNewsResponseKeyring(),
      );
      proofInsert.run(
        `mav:${leadId}`, leadId, priorProof.verification_key_id, priorProof.canonical_digest,
        priorProof.hmac_sha256, JSON.stringify(priorPayload), `prior-creation-${index}`, index + 2,
      );
      leadIds.push(leadId);
    }
    const tamperedLeadId = leadIds[leadIds.length - 1]!;
    state.db.sqlite.prepare(`UPDATE manual_news_assessment_verifications
      SET hmac_sha256 = ? WHERE lead_id = ?`).run('0'.repeat(64), tamperedLeadId);
    const sqlStart = state.db.preparedSql.length;

    const events = await new D1ManualLeadProcessingStore(state.env)
      .listSourceSupportPriorEvents('2026-08-28', state.leadId);

    const verificationQueries = state.db.preparedSql.slice(sqlStart).filter((sql) =>
      /manual_(?:verification|evidence):|manual_source_support:recent_manual_events/.test(sql));
    expect(verificationQueries.length).toBeLessThanOrEqual(40);
    expect(events).toEqual([{
      event_key: state.payload.event_identity.event_key,
      review_date: '2026-08-27',
      origin: 'manual',
      item_id: `blog:manual:${leadIds[0]}`,
    }]);
    expect(state.db.sqlite.prepare(`SELECT status, reason
      FROM manual_news_assessment_verifications WHERE lead_id = ?`).get(tamperedLeadId)).toEqual({
      status: 'invalidated', reason: 'verification_integrity_invalid',
    });
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count
      FROM manual_news_assessment_verifications WHERE status = 'active'`).get()).toEqual({ count: 699 });
  }, 120_000);

  test('atomically writes source proof, item, revision, lead confirmation, and final audit', async () => {
    const state = await sourceSupportFixture();
    installSourceSupportReviewSchema(state);
    const result = await new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1)
      .saveSourceSupportedCandidate(state.leadId, 4, state.payload);

    expect(result).toMatchObject({
      status: 'recommended', version: 5, confirmed_at: expect.any(Number),
      confirmed_batch_id: expect.stringMatching(/^nr-/), processing_owner: null,
    });
    expect(state.db.sqlite.prepare(`SELECT policy_version, verification_json, status
      FROM manual_news_assessment_verifications WHERE lead_id = ?`).get(state.leadId))
      .toMatchObject({ policy_version: 'source_support_v1', status: 'active' });
    expect(state.db.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM manual_news_event_assessments WHERE lead_id = ?',
    ).get(state.leadId)).toEqual({ count: 0 });
    expect(state.db.sqlite.prepare(`SELECT id, source_id, source_ref, title, content, extra
      FROM items WHERE id = ?`).get(`blog:manual:${state.leadId}`)).toMatchObject({
      id: `blog:manual:${state.leadId}`,
      source_id: `manual:${state.leadId}`,
      source_ref: 'manual_lead',
      title: sourceSupportFact,
      content: sourceSupportFact,
    });
    const active = state.db.sqlite.prepare(`SELECT candidates_json, default_selected_ids,
      batch_revision, revision_origin, is_current FROM daily_news_review_batches
      WHERE review_date = '2026-08-28' AND is_current = 1`).get() as {
      candidates_json: string; default_selected_ids: string;
      batch_revision: number; revision_origin: string; is_current: number;
    };
    const candidates = JSON.parse(active.candidates_json) as Array<{ item_id: string }>;
    expect(candidates).toHaveLength(11);
    expect(candidates.slice(0, 10).map((candidate) => candidate.item_id))
      .toEqual(Array.from({ length: 10 }, (_, index) => `auto-${index + 1}`));
    expect(candidates[10].item_id).toBe(`blog:manual:${state.leadId}`);
    expect(active).toMatchObject({ batch_revision: 2, revision_origin: 'manual_lead', is_current: 1 });
    expect(state.db.sqlite.prepare(`SELECT action, from_status, to_status, metadata_json
      FROM manual_news_lead_audit WHERE lead_id = ? AND action = 'confirm_candidate'`)
      .get(state.leadId)).toMatchObject({
      action: 'confirm_candidate', from_status: 'verifying', to_status: 'recommended',
    });
  });

  test('uses the final NOT NULL audit gate to roll back every earlier write on stale evidence', async () => {
    const state = await sourceSupportFixture();
    installSourceSupportReviewSchema(state);
    const gate = state.db.pauseNextBatch();
    const saving = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1)
      .saveSourceSupportedCandidate(state.leadId, 4, state.payload);
    await gate.entered;
    state.db.sqlite.prepare(`UPDATE manual_news_evidence SET excerpt = 'tampered'
      WHERE lead_id = ?`).run(state.leadId);
    gate.release();

    await expect(saving).rejects.toThrow(/(?:NOT NULL|constraint)/i);
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count
      FROM manual_news_assessment_verifications WHERE lead_id = ?`).get(state.leadId))
      .toEqual({ count: 0 });
    expect(state.db.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM items WHERE id = ?',
    ).get(`blog:manual:${state.leadId}`)).toEqual({ count: 0 });
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM daily_news_review_batches
      WHERE review_date = '2026-08-28' AND batch_revision = 2`).get()).toEqual({ count: 0 });
    expect(state.db.sqlite.prepare(`SELECT status, version, confirmed_at
      FROM manual_news_leads WHERE id = ?`).get(state.leadId)).toEqual({
      status: 'verifying', version: 4, confirmed_at: null,
    });
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM manual_news_lead_audit
      WHERE lead_id = ? AND action = 'confirm_candidate'`).get(state.leadId)).toEqual({ count: 0 });
  });

  test('authorizes a persisted source-support item without loading a v10 assessment row', async () => {
    const state = await sourceSupportFixture();
    installSourceSupportReviewSchema(state);
    await new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1)
      .saveSourceSupportedCandidate(state.leadId, 4, state.payload);
    const sqlStart = state.db.preparedSql.length;

    await expect(authorizeFormalNewsSet(
      state.env, '2026-08-28', [`blog:manual:${state.leadId}`], 'source-support-test',
    )).resolves.toMatchObject({
      allowed_ids: [`blog:manual:${state.leadId}`],
      decisions: [{ allowed: true, code: 'ALLOW_VERIFIED_MANUAL' }],
    });
    const sourceSupportSql = state.db.preparedSql.slice(sqlStart)
      .filter((sql) => sql.includes('manual_verification:source_support'));
    expect(sourceSupportSql.some((sql) => /manual_news_event_assessments/i.test(sql))).toBe(false);
  });

  test('fails the final guard when a source-support item projection drifts from its signed proof', async () => {
    const state = await sourceSupportFixture();
    installSourceSupportReviewSchema(state);
    await new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1)
      .saveSourceSupportedCandidate(state.leadId, 4, state.payload);
    state.db.sqlite.prepare('UPDATE items SET title = ? WHERE id = ?')
      .run('tampered projection', `blog:manual:${state.leadId}`);

    await expect(authorizeFormalNewsSet(
      state.env, '2026-08-28', [`blog:manual:${state.leadId}`], 'projection-drift-test',
    )).resolves.toMatchObject({
      allowed_ids: [],
      decisions: [{ allowed: false, code: 'DENY_AUTHORIZATION_STALE' }],
    });
  });

  test('keeps a source-support candidate through the review sanitizer and proof snapshot guard', async () => {
    const state = await sourceSupportFixture();
    installSourceSupportReviewSchema(state);
    await new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1)
      .saveSourceSupportedCandidate(state.leadId, 4, state.payload);

    const sanitized = await sanitizeCurrentNewsReviewBatch(state.env, '2026-08-28', 100);

    expect(sanitized.batch.candidates).toEqual([
      expect.objectContaining({
        item_id: `blog:manual:${state.leadId}`,
        title: sourceSupportFact,
        summary: sourceSupportFact,
        score: null,
      }),
    ]);
    expect(sanitized.manual_verifications).toEqual([
      expect.objectContaining({
        lead_id: state.leadId,
        verification: expect.objectContaining({ policy_version: 'source_support_v1' }),
      }),
    ]);
  });

  test('fails hidden and quarantines a tampered source-support proof before final authorization', async () => {
    const state = await sourceSupportFixture();
    installSourceSupportReviewSchema(state);
    await new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1)
      .saveSourceSupportedCandidate(state.leadId, 4, state.payload);
    state.db.sqlite.prepare(`UPDATE manual_news_assessment_verifications
      SET verification_json = json_set(verification_json, '$.selection.quote', 'forged quote')
      WHERE lead_id = ? AND status = 'active'`).run(state.leadId);

    await expect(authorizeFormalNewsSet(
      state.env, '2026-08-28', [`blog:manual:${state.leadId}`], 'tamper-test',
    )).resolves.toMatchObject({
      allowed_ids: [],
      decisions: [{ allowed: false, code: 'DENY_UNVERIFIED_MANUAL' }],
    });
    expect(state.db.sqlite.prepare(`SELECT status, reason
      FROM manual_news_assessment_verifications WHERE lead_id = ?`).get(state.leadId)).toEqual({
      status: 'invalidated', reason: 'verification_integrity_invalid',
    });
    expect(state.db.sqlite.prepare(`SELECT deleted_at FROM items WHERE id = ?`)
      .get(`blog:manual:${state.leadId}`)).toEqual({ deleted_at: expect.any(String) });
  });

  test('atomically authorizes a source-support candidate before the initial review freeze', async () => {
    const state = await sourceSupportFixture();
    installSourceSupportReviewSchema(state);
    state.db.sqlite.prepare(`DELETE FROM daily_news_review_batches
      WHERE review_date = '2026-08-28'`).run();
    state.db.sqlite.prepare(`DELETE FROM daily_news_review_candidate_generations
      WHERE review_date = '2026-08-28'`).run();

    await expect(new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1)
      .saveSourceSupportedCandidate(state.leadId, 4, state.payload)).resolves.toMatchObject({
      status: 'recommended', version: 5, confirmed_batch_id: null,
      confirmed_at: expect.any(Number), processing_owner: null,
    });
    expect(state.db.sqlite.prepare(`SELECT generation FROM daily_news_review_candidate_generations
      WHERE review_date = '2026-08-28' AND lineage_id = '2026-08-28'`).get())
      .toEqual({ generation: 1 });
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM items WHERE id = ?`)
      .get(`blog:manual:${state.leadId}`)).toEqual({ count: 1 });
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM manual_news_assessment_verifications
      WHERE lead_id = ? AND policy_version = 'source_support_v1' AND status = 'active'`)
      .get(state.leadId)).toEqual({ count: 1 });
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM daily_news_review_batches
      WHERE review_date = '2026-08-28'`).get()).toEqual({ count: 0 });
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM manual_news_lead_audit
      WHERE lead_id = ? AND action = 'confirm_candidate'`).get(state.leadId)).toEqual({ count: 1 });
  });

  test('rolls back prefreeze generation initialization with every source-support write', async () => {
    const state = await sourceSupportFixture();
    installSourceSupportReviewSchema(state);
    state.db.sqlite.prepare(`DELETE FROM daily_news_review_batches
      WHERE review_date = '2026-08-28'`).run();
    state.db.sqlite.prepare(`DELETE FROM daily_news_review_candidate_generations
      WHERE review_date = '2026-08-28'`).run();
    const gate = state.db.pauseNextBatch();
    const saving = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1)
      .saveSourceSupportedCandidate(state.leadId, 4, state.payload);
    await gate.entered;
    state.db.sqlite.prepare(`UPDATE manual_news_evidence SET excerpt = 'tampered'
      WHERE lead_id = ?`).run(state.leadId);
    gate.release();

    await expect(saving).rejects.toThrow(/(?:NOT NULL|constraint)/i);
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count
      FROM daily_news_review_candidate_generations WHERE review_date = '2026-08-28'`).get())
      .toEqual({ count: 0 });
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count
      FROM manual_news_assessment_verifications WHERE lead_id = ?`).get(state.leadId))
      .toEqual({ count: 0 });
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM items WHERE id = ?`)
      .get(`blog:manual:${state.leadId}`)).toEqual({ count: 0 });
  });

  test.each(['active', 'prefreeze'] as const)(
    'fails with the dedicated manual cap error without writing a source-support proof (%s)',
    async (mode) => {
    const state = await sourceSupportFixture();
    installSourceSupportReviewSchema(state);
    if (mode === 'prefreeze') {
      state.db.sqlite.prepare(`DELETE FROM daily_news_review_batches
        WHERE review_date = '2026-08-28'`).run();
    }
    for (let index = 0; index < 50; index += 1) {
      const leadId = `ml-20260828-cap-${String(index).padStart(2, '0')}`;
      state.db.sqlite.prepare(`INSERT INTO manual_news_leads (
        id, review_date, input_type, input_text, input_url, note, status, version,
        submit_idempotency_key, processing_attempt, confirmed_at, created_at, updated_at
      ) VALUES (?, '2026-08-28', 'text', 'cap fixture', '', '', 'recommended', 1,
        ?, 0, 1, ?, ?)` ).run(leadId, `cap-${index}`, index + 20, index + 20);
    }

    await expect(new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1)
      .saveSourceSupportedCandidate(state.leadId, 4, state.payload))
      .rejects.toThrow('manual_candidate_limit_exceeded');
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count
      FROM manual_news_assessment_verifications WHERE lead_id = ?`).get(state.leadId))
      .toEqual({ count: 0 });
    expect(state.db.sqlite.prepare(`SELECT status, version, confirmed_at
      FROM manual_news_leads WHERE id = ?`).get(state.leadId)).toEqual({
      status: 'verifying', version: 4, confirmed_at: null,
    });
    },
  );

  test('orders the manual suffix by first authorization even when B verifies before A', async () => {
    const state = await sourceSupportFixture();
    installSourceSupportReviewSchema(state);
    const second = await addSourceSupportLead(state, {
      idempotencyKey: 'submit-source-support-b', owner: 'source-support-owner-b',
      fact: 'OpenAI 发布 GPT-5。', excerpt: 'OpenAI released GPT-5.',
      url: 'https://openai.com/index/gpt-5/', evidenceId: 'ev-openai-gpt-5',
      publisher: 'OpenAI', now: 10,
    });

    await new D1ManualLeadProcessingStore(state.env, second.owner, 1)
      .saveSourceSupportedCandidate(second.leadId, 4, second.payload);
    await new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1)
      .saveSourceSupportedCandidate(state.leadId, 4, state.payload);

    const active = state.db.sqlite.prepare(`SELECT candidates_json
      FROM daily_news_review_batches WHERE review_date = '2026-08-28' AND is_current = 1`)
      .get() as { candidates_json: string };
    const candidates = JSON.parse(active.candidates_json) as Array<{ item_id: string }>;
    expect(candidates.slice(0, 10).map((candidate) => candidate.item_id))
      .toEqual(Array.from({ length: 10 }, (_, index) => `auto-${index + 1}`));
    expect(candidates.slice(10).map((candidate) => candidate.item_id)).toEqual([
      `blog:manual:${state.leadId}`,
      `blog:manual:${second.leadId}`,
    ]);
  });

  test('replaces a same-event automatic item in place and inherits human selections without rerender', async () => {
    const state = await sourceSupportFixture();
    const selected = Array.from({ length: 5 }, (_, index) => `auto-${index + 1}`);
    const candidates = Array.from({ length: 10 }, (_, index) => ({
      item_id: `auto-${index + 1}`, title: `自动${index + 1}`, summary: '摘要', source: '来源',
      score: 100 - index,
    }));
    installSourceSupportReviewSchema(state, candidates);
    const fingerprint = normalizeFeedEventFingerprint({
      event_type: 'research_result', primary_actor: 'Anthropic',
      primary_object: 'Model Hardware Standard (MHS)', object_family: '', object_variant: '',
      object_version: '', action: 'other', canonical_event: 'Anthropic MHS research preview',
      confidence: 0.98,
    });
    state.db.sqlite.prepare(`INSERT INTO items (
      id, source_ref, extra, published_at, scraped_at, is_relevant, deleted_at
    ) VALUES ('auto-4', 'rss', ?, '2026-08-28', '2026-08-28', 1, NULL)`).run(
      JSON.stringify({ event_fingerprint: fingerprint }),
    );
    state.db.sqlite.prepare(`UPDATE daily_news_review_batches
      SET applied_selected_ids = ?, selection_hash = ?, edit_revision = 2,
        publish_status = 'published', human_reviewed = 1
      WHERE review_date = '2026-08-28' AND is_current = 1`).run(
      JSON.stringify(selected), await newsReviewSelectionHash(selected),
    );

    await new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1)
      .saveSourceSupportedCandidate(state.leadId, 4, state.payload);

    const active = state.db.sqlite.prepare(`SELECT candidates_json, default_selected_ids,
      applied_selected_ids, publish_status FROM daily_news_review_batches
      WHERE review_date = '2026-08-28' AND is_current = 1`).get() as {
      candidates_json: string; default_selected_ids: string;
      applied_selected_ids: string; publish_status: string;
    };
    const ids = (JSON.parse(active.candidates_json) as Array<{ item_id: string }>)
      .map((candidate) => candidate.item_id);
    expect(ids).toHaveLength(10);
    expect(ids[3]).toBe(`blog:manual:${state.leadId}`);
    const inherited = ['auto-1', 'auto-2', 'auto-3', `blog:manual:${state.leadId}`, 'auto-5'];
    expect(JSON.parse(active.default_selected_ids)).toEqual(inherited);
    expect(JSON.parse(active.applied_selected_ids)).toEqual(inherited);
    expect(active.publish_status).toBe('published');
    const audit = state.db.sqlite.prepare(`SELECT metadata_json FROM manual_news_lead_audit
      WHERE lead_id = ? AND action = 'confirm_candidate'`).get(state.leadId) as { metadata_json: string };
    expect(JSON.parse(audit.metadata_json)).toMatchObject({
      event_aliases: { 'auto-4': `blog:manual:${state.leadId}` },
      rerender_enqueued: false,
    });
  });

  test('freezes ten real pool items and replaces the MHS item from its sidecar fingerprint', async () => {
    const state = await sourceSupportFixture();
    installSourceSupportReviewSchema(state);
    state.db.sqlite.prepare(`DELETE FROM daily_news_review_batches
      WHERE review_date = '2026-08-28'`).run();
    const automatic = installSourceSupportAutomaticPool(state, 3);

    await new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1)
      .saveSourceSupportedCandidate(state.leadId, 4, state.payload);
    const frozen = await freezeNewsReviewBatchFromPool(state.env, '2026-08-28', 100);

    expect(frozen.batch.candidates).toHaveLength(10);
    expect(frozen.batch.candidates[3]).toMatchObject({
      item_id: `blog:manual:${state.leadId}`,
      event_key: state.payload.event_identity.event_key,
      origin: 'manual_lead',
    });
    expect(frozen.batch.default_selected_ids).toEqual([
      'blog:anthropic:pool-1', 'blog:anthropic:pool-2', 'blog:anthropic:pool-3',
      `blog:manual:${state.leadId}`, 'blog:anthropic:pool-5',
    ]);
    expect(new Set(frozen.batch.candidate_ids)).toHaveLength(10);
    expect(JSON.stringify(frozen.batch.candidates.filter((candidate) => candidate.origin !== 'manual_lead')))
      .toBe(JSON.stringify(automatic.filter((_candidate, index) => index !== 3)));
    const audit = state.db.sqlite.prepare(`SELECT metadata_json FROM manual_news_lead_audit
      WHERE lead_id = ? AND action = 'confirm_candidate'`).get(state.leadId) as { metadata_json: string };
    expect(JSON.parse(audit.metadata_json)).toMatchObject({ rerender_enqueued: false });
  });

  test('freezes the prefreeze source-support suffix by first marker submit order', async () => {
    const state = await sourceSupportFixture();
    installSourceSupportReviewSchema(state);
    state.db.sqlite.prepare(`DELETE FROM daily_news_review_batches
      WHERE review_date = '2026-08-28'`).run();
    const automatic = installSourceSupportAutomaticPool(state, null);
    const second = await addSourceSupportLead(state, {
      idempotencyKey: 'submit-source-support-b-prefreeze', owner: 'source-support-owner-b-prefreeze',
      fact: 'OpenAI 发布 GPT-5。', excerpt: 'OpenAI released GPT-5.',
      url: 'https://openai.com/index/gpt-5/', evidenceId: 'ev-openai-gpt-5-prefreeze',
      publisher: 'OpenAI', now: 20,
    });

    await new D1ManualLeadProcessingStore(state.env, second.owner, 1)
      .saveSourceSupportedCandidate(second.leadId, 4, second.payload);
    await new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1)
      .saveSourceSupportedCandidate(state.leadId, 4, state.payload);
    const frozen = await freezeNewsReviewBatchFromPool(state.env, '2026-08-28', 100);

    expect(JSON.stringify(frozen.batch.candidates.slice(0, 10))).toBe(JSON.stringify(automatic));
    expect(frozen.batch.candidates.slice(10).map((candidate) => candidate.item_id)).toEqual([
      `blog:manual:${state.leadId}`,
      `blog:manual:${second.leadId}`,
    ]);
    const prefreezeOrderSql = state.db.preparedSql.find((sql) =>
      sql.includes('news_review:prefreeze_confirmed_manual')) || '';
    expect(prefreezeOrderSql).toContain('verification.policy_version = ?');
    expect(prefreezeOrderSql).toContain("audit.action = 'submit'");
    expect(prefreezeOrderSql).toContain("$.candidate_authorization");
    expect(prefreezeOrderSql).toContain("audit.action = 'confirm_candidate'");
  });

  test('atomically elects one winner for concurrent source-support leads with the same event', async () => {
    const state = await sourceSupportFixture();
    installSourceSupportReviewSchema(state);
    const second = await addSourceSupportLead(state, {
      idempotencyKey: 'submit-source-support-same-event', owner: 'source-support-owner-same',
      fact: sourceSupportFact, excerpt: sourceSupportExcerpt,
      url: 'https://www.anthropic.com/news/model-hardware-standard-research-preview',
      evidenceId: 'ev-anthropic-mhs-second', publisher: 'Anthropic', now: 30,
    });
    const barrier = state.db.pauseNextFirstCalls('manual_source_support:manual_cap_preflight', 2);
    const firstSave = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1)
      .saveSourceSupportedCandidate(state.leadId, 4, state.payload);
    const secondSave = new D1ManualLeadProcessingStore(state.env, second.owner, 1)
      .saveSourceSupportedCandidate(second.leadId, 4, second.payload);
    await barrier.entered;
    barrier.release();

    const settled = await Promise.allSettled([firstSave, secondSave]);
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toEqual(expect.objectContaining({
      message: 'manual_candidate_event_conflict',
    }));
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count
      FROM manual_news_assessment_verifications WHERE policy_version = 'source_support_v1'
        AND status = 'active'`).get()).toEqual({ count: 1 });
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM manual_news_lead_audit
      WHERE action = 'confirm_candidate'`).get()).toEqual({ count: 1 });
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM manual_news_leads
      WHERE status = 'recommended' AND confirmed_at IS NOT NULL`).get()).toEqual({ count: 1 });
  });

  test.each([
    ['lead CAS', `UPDATE manual_news_leads SET version = version + 1 WHERE id = ?`],
    ['authorization audit', `UPDATE manual_news_lead_audit SET metadata_json = '{}'
      WHERE lead_id = ? AND action = 'submit'`],
    ['active batch snapshot', `UPDATE daily_news_review_batches SET candidate_generation = 1
      WHERE review_date = '2026-08-28' AND is_current = 1`],
  ])('leaves no partial source-support writes when the %s changes after preflight', async (_label, sql) => {
    const state = await sourceSupportFixture();
    installSourceSupportReviewSchema(state);
    const gate = state.db.pauseNextBatch();
    const saving = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1)
      .saveSourceSupportedCandidate(state.leadId, 4, state.payload);
    await gate.entered;
    const concurrentMutation = state.db.sqlite.prepare(sql);
    if (sql.includes('?')) concurrentMutation.run(state.leadId);
    else concurrentMutation.run();
    gate.release();

    await expect(saving).rejects.toThrow(/(?:NOT NULL|constraint)/i);
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count
      FROM manual_news_assessment_verifications WHERE lead_id = ?`).get(state.leadId))
      .toEqual({ count: 0 });
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM items WHERE id = ?`)
      .get(`blog:manual:${state.leadId}`)).toEqual({ count: 0 });
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM daily_news_review_batches
      WHERE review_date = '2026-08-28' AND batch_revision = 2`).get()).toEqual({ count: 0 });
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM manual_news_lead_audit
      WHERE lead_id = ? AND action = 'confirm_candidate'`).get(state.leadId)).toEqual({ count: 0 });
  });

  test('replays the exact completed source-support state after a lost response without another write', async () => {
    const state = await sourceSupportFixture();
    installSourceSupportReviewSchema(state);
    const store = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1);
    const first = await store.saveSourceSupportedCandidate(state.leadId, 4, state.payload);
    const replay = await store.saveSourceSupportedCandidate(state.leadId, 4, state.payload);

    expect(replay).toEqual(first);
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count
      FROM manual_news_assessment_verifications WHERE lead_id = ?`).get(state.leadId))
      .toEqual({ count: 1 });
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM manual_news_lead_audit
      WHERE lead_id = ? AND action = 'confirm_candidate'`).get(state.leadId)).toEqual({ count: 1 });
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM daily_news_review_batches
      WHERE review_date = '2026-08-28'`).get()).toEqual({ count: 2 });
  });

  test('persists the signed bounded proof-excerpt audit with evidence', async () => {
    const state = fixture('extracting');
    const signedEvidence = withSignedArticleTextV2Audit({
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
    });
    const store = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1);
    await store.replaceEvidence(state.leadId, 4, [signedEvidence]);

    const saved = await store.getLead(state.leadId);
    expect(saved?.evidence).toEqual([expect.objectContaining({
      id: 'ev-audited', fetch_audit: signedEvidence.fetch_audit,
    })]);
    expect(JSON.parse(String(state.db.sqlite.prepare(
      'SELECT fetch_audit_json FROM manual_news_evidence WHERE lead_id = ? AND evidence_id = ?',
    ).get(state.leadId, 'ev-audited')?.fetch_audit_json))).toEqual(signedEvidence.fetch_audit);
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

  test('persists and reloads 8 bounded sources as current without retaining a complete-body tail', async () => {
    const state = fixture('extracting');
    const excerpt = `${fixtureFact} ${'A'.repeat(3_000 - Array.from(fixtureFact).length - 1)}`;
    const completeBody = `${excerpt} COMPLETE-BODY-TAIL-SENTINEL`;
    const first = withSignedArticleTextV2Audit({
      ...fixtureEvidence()[0], excerpt, claims_supported: [excerpt],
    }, completeBody);
    const evidence = [first, ...replacementEvidence(7)];
    const store = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1);

    await store.replaceEvidence(state.leadId, 4, evidence);
    const loaded = (await store.getLead(state.leadId))!.evidence;
    expect(loaded).toHaveLength(8);
    expect(JSON.stringify(loaded)).not.toContain('COMPLETE-BODY-TAIL-SENTINEL');
    expect(JSON.stringify(state.db.sqlite.prepare(
      'SELECT * FROM manual_news_evidence WHERE lead_id = ? ORDER BY evidence_id',
    ).all(state.leadId))).not.toContain('COMPLETE-BODY-TAIL-SENTINEL');
    expect(JSON.stringify(state.db.sqlite.prepare(
      'SELECT * FROM manual_news_lead_audit WHERE lead_id = ? ORDER BY id',
    ).all(state.leadId))).not.toContain('COMPLETE-BODY-TAIL-SENTINEL');

    const candidate = processedAssessment();
    const proofInput = {
      lead_id: state.leadId,
      assessment_version: 4,
      assessment: candidate,
      evidence: loaded,
      verification: verifiedAssessment(candidate),
    };
    const proof = await createManualLeadVerificationProof(
      proofInput, testManualNewsVerificationKeyring(VERIFICATION_SECRET), testManualNewsResponseKeyring(),
    );
    expect(JSON.stringify(proof)).not.toContain('COMPLETE-BODY-TAIL-SENTINEL');
    await expect(isCurrentManualLeadVerification(
      proofInput, proof,
      testManualNewsVerificationKeyring(VERIFICATION_SECRET), testManualNewsResponseKeyring(),
    )).resolves.toBe(true);
  });

  test('fails closed when persisted evidence is bypassed to a ninth source before load', async () => {
    const state = fixture('extracting');
    const store = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1);
    const beforeRejectedStore = state.db.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM manual_news_evidence WHERE lead_id = ?',
    ).get(state.leadId);
    await expect(store.replaceEvidence(state.leadId, 4, replacementEvidence(9)))
      .rejects.toThrow(/manual_news_evidence_set_invalid/);
    expect(state.db.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM manual_news_evidence WHERE lead_id = ?',
    ).get(state.leadId)).toEqual(beforeRejectedStore);
    await store.replaceEvidence(state.leadId, 4, replacementEvidence(8));
    const ninth = replacementEvidence(9)[8];
    state.db.sqlite.prepare(`INSERT INTO manual_news_evidence (
      lead_id, evidence_id, url, source_type, publisher, published_at, retrieved_at,
      title, excerpt, claims_supported_json, fetch_audit_json, reliable
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      state.leadId, ninth.id, ninth.url, ninth.source_type, ninth.publisher, ninth.published_at,
      ninth.retrieved_at, ninth.title, ninth.excerpt, JSON.stringify(ninth.claims_supported),
      JSON.stringify(ninth.fetch_audit), ninth.reliable ? 1 : 0,
    );

    await expect(getManualNewsLead(state.env, state.leadId)).resolves.toMatchObject({
      assessment: null, evidence: [],
    });
  });

  test.each([
    ['ninth source', (state: ReturnType<typeof fixture>) => {
      for (let index = 2; index <= 9; index += 1) {
        insertPersistedEvidenceCopy(
          state, `ev-legacy-${index}`, `https://support.claude.com/legacy-${index}`,
        );
      }
    }],
    ['duplicate evidence id', (state: ReturnType<typeof fixture>) => {
      allowDuplicatePersistedEvidenceIds(state);
    }],
    ['duplicate final URL', (state: ReturnType<typeof fixture>) => {
      insertPersistedEvidenceCopy(state, 'ev-duplicate-url', 'https://support.claude.com/example');
    }],
    ['3001 code points', (state: ReturnType<typeof fixture>) => {
      const excerpt = 'x'.repeat(3_001);
      state.db.sqlite.prepare(`UPDATE manual_news_evidence
        SET excerpt = ?, claims_supported_json = ? WHERE lead_id = ?`)
        .run(excerpt, JSON.stringify([excerpt]), state.leadId);
    }],
    ['12001 UTF-8 bytes', (state: ReturnType<typeof fixture>) => {
      const excerpt = `${'😀'.repeat(3_000)}x`;
      expect(new TextEncoder().encode(excerpt).byteLength).toBe(12_001);
      state.db.sqlite.prepare(`UPDATE manual_news_evidence
        SET excerpt = ?, claims_supported_json = ? WHERE lead_id = ?`)
        .run(excerpt, JSON.stringify([excerpt]), state.leadId);
    }],
  ] as const)('atomically quarantines persisted bounds failure: %s', async (_name, corrupt) => {
    const state = fixture('verifying', 9);
    const store = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1);
    await saveFixtureAssessment(store, state.leadId, 9);
    addPublishedManualItem(state);
    corrupt(state);

    await expect(loadManualNewsEvidence(state.env, state.leadId)).resolves.toEqual([]);
    await expect(getManualNewsLead(state.env, state.leadId)).resolves.toMatchObject({
      assessment: null, evidence: [],
    });

    const verification = state.db.sqlite.prepare(`SELECT verification_id, assessment_version, status, reason
      FROM manual_news_assessment_verifications WHERE lead_id = ?`).get(state.leadId) as {
        verification_id: string; assessment_version: number; status: string; reason: string;
      };
    expect(verification).toMatchObject({
      status: 'invalidated', reason: 'verification_integrity_invalid',
    });
    expect(state.db.sqlite.prepare('SELECT deleted_at FROM items WHERE id = ?')
      .get(`blog:manual:${state.leadId}`)).toEqual({ deleted_at: expect.any(String) });
    const audits = state.db.sqlite.prepare(`SELECT metadata_json FROM manual_news_lead_audit
      WHERE lead_id = ? AND action = 'verification_quarantine'`).all(state.leadId) as Array<{
        metadata_json: string;
      }>;
    expect(audits).toHaveLength(1);
    expect(JSON.parse(audits[0].metadata_json)).toMatchObject({
      verification_id: verification.verification_id,
      assessment_version: verification.assessment_version,
      reason: 'verification_integrity_invalid',
      mutation_nonce: expect.stringMatching(/^verification_quarantine:/),
    });

    const apiEnv = {
      ...state.env,
      DAILY_NEWS_REVIEW_SECRET: 'shared-secret',
      DAILY_NEWS_REVIEW_ENABLED: '1',
    } as Env;
    const detail = await handleManualNewsLeadsApi(new Request(
      `https://api.example.test/api/digest/daily-news-leads/${state.leadId}`,
      { headers: { Authorization: 'Bearer shared-secret' } },
    ), apiEnv, { waitUntil() {} } as never);
    expect(detail.status).toBe(200);
    const detailText = await detail.text();
    expect(detailText).not.toContain('COMPLETE-BODY-TAIL-SENTINEL');
    expect(JSON.parse(detailText)).toMatchObject({ lead: { assessment: null, evidence: [] } });

    const confirm = await handleManualNewsLeadsApi(new Request(
      `https://api.example.test/api/digest/daily-news-leads/${state.leadId}/confirm-candidate`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer shared-secret', 'Content-Type': 'application/json',
          'Idempotency-Key': `confirm-malformed-${String(_name).replaceAll(' ', '-')}`,
        },
        body: JSON.stringify({ expected_version: 9, expected_batch_revision: 0 }),
      },
    ), apiEnv, { waitUntil() {} } as never);
    expect(confirm.status).toBe(409);
    await expect(confirm.json()).resolves.toMatchObject({
      ok: false, error: 'lead_not_fact_verified', lead: { assessment: null, evidence: [] },
    });
    await expect(store.findPriorEventsByEventKey(processedAssessment().event_key, 'other-lead'))
      .resolves.toEqual([]);
  });

  test('quarantines a historical generic-feature assessment without making a recommended lead retryable', async () => {
    const state = fixture('verifying', 9);
    const store = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1);
    await saveFixtureAssessment(store, state.leadId, 9);
    addPublishedManualItem(state);
    state.db.sqlite.prepare("UPDATE manual_news_leads SET status = 'recommended' WHERE id = ?")
      .run(state.leadId);
    const row = state.db.sqlite.prepare(`SELECT assessment_json FROM manual_news_event_assessments
      WHERE lead_id = ? ORDER BY assessment_version DESC LIMIT 1`).get(state.leadId) as { assessment_json: string };
    const historical = JSON.parse(row.assessment_json) as Record<string, any>;
    historical.source_facts[0].atomic_fact.object = 'feature in Google Sheets';
    historical.source_facts[0].text = 'Anthropic has disclosed feature in Google Sheets.';
    historical.editorial_projection.title.atomic_fact.object = 'Google Sheets功能';
    historical.editorial_projection.title.text_zh = 'Anthropic已披露Google Sheets功能。';
    historical.editorial_projection.summary[0].atomic_fact.object = 'Google Sheets功能';
    historical.editorial_projection.summary[0].text_zh = 'Anthropic已披露Google Sheets功能。';
    state.db.sqlite.prepare(`UPDATE manual_news_event_assessments SET assessment_json = ?
      WHERE lead_id = ?`).run(JSON.stringify(historical), state.leadId);

    const hidden = await getManualNewsLead(state.env, state.leadId);
    expect(hidden).toMatchObject({ status: 'recommended', assessment: null });
    expect(hidden?.evidence).toHaveLength(1);
    await expect(store.findPriorEventsByEventKey(
      processedAssessment().event_key, 'different-lead',
    )).resolves.toEqual([]);
    await expect(retryManualNewsLead(
      state.env, state.leadId, hidden!.version, 'retry-quarantined-generic-feature', 100,
    )).resolves.toMatchObject({ ok: false, status: 409, error: 'lead_not_retryable' });
    expect(state.db.sqlite.prepare(`SELECT status, reason FROM manual_news_assessment_verifications
      WHERE lead_id = ?`).get(state.leadId)).toEqual({
      status: 'invalidated', reason: 'verification_integrity_invalid',
    });
    expect(state.db.sqlite.prepare('SELECT deleted_at FROM items WHERE id = ?')
      .get(`blog:manual:${state.leadId}`)).toEqual({ deleted_at: expect.any(String) });
    expect(state.db.sqlite.prepare(`SELECT from_status, to_status FROM manual_news_lead_audit
      WHERE lead_id = ? AND action = 'verification_quarantine'`).get(state.leadId)).toEqual({
      from_status: 'recommended', to_status: 'recommended',
    });
  });

  test.each([
    ['many rows', (state: ReturnType<typeof fixture>) => {
      for (let index = 2; index <= 64; index += 1) {
        insertPersistedEvidenceCopy(
          state, `ev-many-${index}`, `https://support.claude.com/many-${index}`,
        );
      }
    }],
    ['multi-megabyte legacy column', (state: ReturnType<typeof fixture>) => {
      state.db.sqlite.prepare(`UPDATE manual_news_evidence SET claims_supported_json = ?
        WHERE lead_id = ?`).run(`"${'X'.repeat(2 * 1024 * 1024)}"`, state.leadId);
    }],
  ] as const)('preflights %s and quarantines without materializing evidence blobs', async (_name, corrupt) => {
    const state = fixture('verifying', 9);
    const store = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1);
    await saveFixtureAssessment(store, state.leadId, 9);
    addPublishedManualItem(state);
    corrupt(state);
    state.db.preparedSql.length = 0;
    state.db.rejectEvidenceBlobMaterialization = true;

    await expect(loadManualNewsEvidence(state.env, state.leadId)).resolves.toEqual([]);

    expect(state.db.preparedSql.some((sql) => sql.includes('manual_evidence:preflight'))).toBe(true);
    expect(state.db.preparedSql.some((sql) => sql.includes('manual_evidence:list'))).toBe(false);
    expect(state.db.sqlite.prepare(`SELECT status, reason FROM manual_news_assessment_verifications
      WHERE lead_id = ?`).get(state.leadId)).toEqual({
      status: 'invalidated', reason: 'verification_integrity_invalid',
    });
    expect(state.db.sqlite.prepare('SELECT deleted_at FROM items WHERE id = ?')
      .get(`blog:manual:${state.leadId}`)).toEqual({ deleted_at: expect.any(String) });
  });

  test.each(['detail', 'confirm', 'prior-event'] as const)(
    '%s boundary preflights an overcount and quarantines without materializing evidence',
    async (boundary) => {
      const state = fixture('verifying', 9);
      const store = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1);
      await saveFixtureAssessment(store, state.leadId, 9);
      addPublishedManualItem(state);
      for (let index = 2; index <= 9; index += 1) {
        insertPersistedEvidenceCopy(
          state, `ev-${boundary}-${index}`, `https://support.claude.com/${boundary}-${index}`,
        );
      }
      state.db.preparedSql.length = 0;
      state.db.rejectEvidenceBlobMaterialization = true;
      const apiEnv = {
        ...state.env,
        DAILY_NEWS_REVIEW_SECRET: 'shared-secret',
        DAILY_NEWS_REVIEW_ENABLED: '1',
      } as Env;

      if (boundary === 'detail') {
        const result = await handleManualNewsLeadsApi(new Request(
          `https://api.example.test/api/digest/daily-news-leads/${state.leadId}`,
          { headers: { Authorization: 'Bearer shared-secret' } },
        ), apiEnv, { waitUntil() {} } as never);
        expect(result.status).toBe(200);
        await expect(result.json()).resolves.toMatchObject({
          lead: { assessment: null, evidence: [] },
        });
      } else if (boundary === 'confirm') {
        const result = await handleManualNewsLeadsApi(new Request(
          `https://api.example.test/api/digest/daily-news-leads/${state.leadId}/confirm-candidate`,
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer shared-secret', 'Content-Type': 'application/json',
              'Idempotency-Key': 'confirm-preflight-overcount',
            },
            body: JSON.stringify({ expected_version: 9, expected_batch_revision: 0 }),
          },
        ), apiEnv, { waitUntil() {} } as never);
        expect(result.status).toBe(409);
        await expect(result.json()).resolves.toMatchObject({ error: 'lead_not_fact_verified' });
      } else {
        await expect(store.findPriorEventsByEventKey(
          processedAssessment().event_key, 'different-lead',
        )).resolves.toEqual([]);
      }

      expect(state.db.preparedSql.some((sql) => sql.includes('manual_evidence:preflight'))).toBe(true);
      expect(state.db.preparedSql.some((sql) => sql.includes('manual_evidence:list'))).toBe(false);
      expect(state.db.sqlite.prepare(`SELECT status, reason FROM manual_news_assessment_verifications
        WHERE lead_id = ?`).get(state.leadId)).toEqual({
        status: 'invalidated', reason: 'verification_integrity_invalid',
      });
      expect(state.db.sqlite.prepare('SELECT deleted_at FROM items WHERE id = ?')
        .get(`blog:manual:${state.leadId}`)).toEqual({ deleted_at: expect.any(String) });
    },
  );

  test('materializes at most nine bounded evidence rows after a successful preflight', async () => {
    const state = fixture();

    await expect(loadManualNewsEvidence(state.env, state.leadId)).resolves.toHaveLength(1);

    const listSql = state.db.preparedSql.find((sql) => sql.includes('manual_evidence:list')) || '';
    expect(listSql).toMatch(/LIMIT\s+9\b/i);
    expect(listSql).not.toContain('SELECT *');
  });

  test('rolls back the entire preflight quarantine when its causal audit write fails', async () => {
    const state = fixture('verifying', 9);
    const store = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1);
    await saveFixtureAssessment(store, state.leadId, 9);
    addPublishedManualItem(state);
    for (let index = 2; index <= 9; index += 1) {
      insertPersistedEvidenceCopy(
        state, `ev-rollback-${index}`, `https://support.claude.com/rollback-${index}`,
      );
    }
    state.db.rejectEvidenceBlobMaterialization = true;
    state.db.failQuarantineAudit = true;

    await expect(loadManualNewsEvidence(state.env, state.leadId))
      .rejects.toThrow(/injected_quarantine_audit_failure/);

    expect(state.db.sqlite.prepare(`SELECT status, reason, invalidation_nonce
      FROM manual_news_assessment_verifications WHERE lead_id = ?`).get(state.leadId)).toEqual({
      status: 'active', reason: null, invalidation_nonce: null,
    });
    expect(state.db.sqlite.prepare('SELECT deleted_at FROM items WHERE id = ?')
      .get(`blog:manual:${state.leadId}`)).toEqual({ deleted_at: null });
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM manual_news_lead_audit
      WHERE lead_id = ? AND action = 'verification_quarantine'`).get(state.leadId)).toEqual({ count: 0 });
  });

  test('quarantines a real legacy claims body and keeps mutation responses bounded', async () => {
    const state = fixture('verifying', 9);
    const proofStore = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1);
    await saveFixtureAssessment(proofStore, state.leadId, 9);
    state.db.sqlite.prepare(`UPDATE manual_news_leads SET status = 'needs_review',
      processing_owner = NULL, processing_lease_until = NULL WHERE id = ?`).run(state.leadId);
    addPublishedManualItem(state);
    state.db.sqlite.prepare(`UPDATE manual_news_evidence SET claims_supported_json = ? WHERE lead_id = ?`)
      .run(JSON.stringify(['COMPLETE-BODY-TAIL-SENTINEL']), state.leadId);

    const apiEnv = {
      ...state.env,
      DAILY_NEWS_REVIEW_SECRET: 'shared-secret', DAILY_NEWS_REVIEW_ENABLED: '1',
      MANUAL_NEWS_LEAD_WORKFLOW: { create: async () => ({ id: 'workflow' }) },
      MANUAL_NEWS_RESEARCH_ORIGIN: 'https://research-gateway.example',
      MANUAL_NEWS_RESEARCH_TOKEN: 'test-research-token', DEEPSEEK_API_KEY: 'test-key',
    } as Env;
    const retried = await handleManualNewsLeadsApi(new Request(
      `https://api.example.test/api/digest/daily-news-leads/${state.leadId}/retry`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer shared-secret', 'Content-Type': 'application/json',
          'Idempotency-Key': 'retry-legacy-body-bounded',
        },
        body: JSON.stringify({ expected_version: 9 }),
      },
    ), apiEnv, { waitUntil() {} } as never, 100);
    expect(retried.status).toBe(202);
    const retriedText = await retried.text();
    expect(retriedText).not.toContain('COMPLETE-BODY-TAIL-SENTINEL');
    expect(retriedText).not.toContain('claims_supported');
    expect(retriedText).not.toContain('fetch_audit');
    expect(JSON.parse(retriedText)).toMatchObject({
      ok: true, changed: true, lead: { evidence: [] },
    });
    expect(state.db.sqlite.prepare(`SELECT status, reason FROM manual_news_assessment_verifications
      WHERE lead_id = ?`).get(state.leadId)).toEqual({
      status: 'invalidated', reason: 'verification_integrity_invalid',
    });
    expect(state.db.sqlite.prepare('SELECT deleted_at FROM items WHERE id = ?')
      .get(`blog:manual:${state.leadId}`)).toEqual({ deleted_at: expect.any(String) });

  });

  test('quarantines a real legacy claims body during submit replay without leaking it', async () => {
    const state = fixture('verifying', 9);
    const store = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1);
    await saveFixtureAssessment(store, state.leadId, 9);
    addPublishedManualItem(state);
    state.db.sqlite.prepare(`UPDATE manual_news_leads SET submit_idempotency_key = ? WHERE id = ?`)
      .run('submit-legacy-replay', state.leadId);
    state.db.sqlite.prepare(`UPDATE manual_news_evidence SET claims_supported_json = ? WHERE lead_id = ?`)
      .run(JSON.stringify(['COMPLETE-BODY-TAIL-SENTINEL']), state.leadId);
    const apiEnv = {
      ...state.env,
      DAILY_NEWS_REVIEW_SECRET: 'shared-secret', DAILY_NEWS_REVIEW_ENABLED: '1',
      MANUAL_NEWS_LEAD_WORKFLOW: { create: async () => ({ id: 'workflow' }) },
      MANUAL_NEWS_RESEARCH_ORIGIN: 'https://research-gateway.example',
      MANUAL_NEWS_RESEARCH_TOKEN: 'test-research-token', DEEPSEEK_API_KEY: 'test-key',
    } as Env;

    const replay = await handleManualNewsLeadsApi(new Request(
      'https://api.example.test/api/digest/daily-news-leads',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer shared-secret', 'Content-Type': 'application/json',
          'Idempotency-Key': 'submit-legacy-replay',
        },
        body: JSON.stringify({ date: '2026-08-11', url: 'https://support.claude.com/example' }),
      },
    ), apiEnv, { waitUntil() {} } as never, 100);
    expect(replay.status).toBe(200);
    const replayText = await replay.text();
    expect(replayText).not.toContain('COMPLETE-BODY-TAIL-SENTINEL');
    expect(replayText).not.toContain('claims_supported');
    expect(replayText).not.toContain('fetch_audit');
    expect(JSON.parse(replayText)).toMatchObject({
      ok: true, created: false, lead: { assessment: null, evidence: [] },
    });
    expect(state.db.sqlite.prepare(`SELECT status, reason FROM manual_news_assessment_verifications
      WHERE lead_id = ?`).get(state.leadId)).toEqual({
      status: 'invalidated', reason: 'verification_integrity_invalid',
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
      assessment_evidence_disposition_contract: MANUAL_LEAD_EVIDENCE_DISPOSITION_CONTRACT,
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

  test('loads historical response and proof keys only by their retained explicit IDs', async () => {
    const state = fixture('verifying', 9);
    const store = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1);
    await saveFixtureAssessment(store, state.leadId, 9);
    const rotatedEnv = {
      ...state.env,
      MANUAL_NEWS_VERIFICATION_KEY_ID: 'verification-key-2026-09-01',
      MANUAL_NEWS_VERIFICATION_SECRET: 'b'.repeat(64),
      MANUAL_NEWS_VERIFICATION_KEYRING_JSON: JSON.stringify([
        { id: VERIFICATION_KEY_ID, secret: VERIFICATION_SECRET },
      ]),
      MANUAL_NEWS_RESEARCH_RESPONSE_KEY_ID: 'response-key-2026-09-01',
      MANUAL_NEWS_RESEARCH_RESPONSE_SECRET: '22'.repeat(32),
      MANUAL_NEWS_RESEARCH_RESPONSE_KEYRING_JSON: JSON.stringify([
        { id: TEST_MANUAL_NEWS_RESPONSE_KEY_ID, secret: TEST_MANUAL_NEWS_RESPONSE_SECRET },
      ]),
    } as Env;

    const loaded = await new D1ManualLeadProcessingStore(rotatedEnv).getLead(state.leadId);

    expect(loaded?.assessment).not.toBeNull();
    expect(state.db.sqlite.prepare(`SELECT status, reason FROM manual_news_assessment_verifications
      WHERE lead_id = ?`).get(state.leadId)).toEqual({ status: 'active', reason: null });
  });

  test.each([
    ['verification key', (env: Env) => ({
      ...env,
      MANUAL_NEWS_VERIFICATION_KEY_ID: 'verification-key-2026-09-01',
      MANUAL_NEWS_VERIFICATION_SECRET: 'b'.repeat(64),
    })],
    ['response key', (env: Env) => ({
      ...env,
      MANUAL_NEWS_RESEARCH_RESPONSE_KEY_ID: 'response-key-2026-09-01',
      MANUAL_NEWS_RESEARCH_RESPONSE_SECRET: '22'.repeat(32),
    })],
  ] as const)('hides a removed historical %s without mutating durable state', async (_name, removeKey) => {
    const state = fixture('verifying', 9);
    const store = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1);
    await saveFixtureAssessment(store, state.leadId, 9);
    addPublishedManualItem(state);

    expect((await new D1ManualLeadProcessingStore(removeKey(state.env) as Env)
      .getLead(state.leadId))?.assessment).toBeNull();
    expect(state.db.sqlite.prepare(`SELECT status, reason, invalidation_nonce
      FROM manual_news_assessment_verifications WHERE lead_id = ?`).get(state.leadId)).toEqual({
      status: 'active', reason: null, invalidation_nonce: null,
    });
    expect(state.db.sqlite.prepare('SELECT deleted_at FROM items WHERE id = ?')
      .get(`blog:manual:${state.leadId}`)).toEqual({ deleted_at: null });
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM manual_news_lead_audit
      WHERE lead_id = ? AND action = 'verification_quarantine'`).get(state.leadId)).toEqual({ count: 0 });
  });

  test('unknown key lineage takes dependency-unavailable precedence over malformed evidence bounds', async () => {
    const state = fixture('verifying', 9);
    const store = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1);
    await saveFixtureAssessment(store, state.leadId, 9);
    addPublishedManualItem(state);
    state.db.sqlite.prepare(`UPDATE manual_news_evidence
      SET claims_supported_json = ? WHERE lead_id = ?`)
      .run(`"${'X'.repeat(2 * 1024 * 1024)}"`, state.leadId);
    for (let index = 2; index <= 9; index += 1) {
      insertPersistedEvidenceCopy(
        state, `ev-known-${index}`, `https://support.claude.com/known-${index}`,
      );
    }
    state.db.sqlite.prepare(`UPDATE manual_news_evidence
      SET response_key_id = 'response-key-removed' WHERE evidence_id = 'ev-known-9'`).run();
    state.db.rejectEvidenceBlobMaterialization = true;

    await expect(loadManualNewsEvidence(state.env, state.leadId)).resolves.toEqual([]);

    expect(state.db.sqlite.prepare(`SELECT status, reason, invalidation_nonce
      FROM manual_news_assessment_verifications WHERE lead_id = ?`).get(state.leadId)).toEqual({
      status: 'active', reason: null, invalidation_nonce: null,
    });
    expect(state.db.sqlite.prepare('SELECT deleted_at FROM items WHERE id = ?')
      .get(`blog:manual:${state.leadId}`)).toEqual({ deleted_at: null });
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM manual_news_lead_audit
      WHERE lead_id = ? AND action = 'verification_quarantine'`).get(state.leadId)).toEqual({ count: 0 });
  });

  test.each([
    ['missing current key ID', (env: Env) => ({ ...env, MANUAL_NEWS_VERIFICATION_KEY_ID: undefined })],
    ['missing current secret', (env: Env) => ({ ...env, MANUAL_NEWS_VERIFICATION_SECRET: undefined })],
    ['malformed keyring', (env: Env) => ({
      ...env,
      MANUAL_NEWS_VERIFICATION_KEYRING_JSON: JSON.stringify([
        { id: VERIFICATION_KEY_ID, secret: VERIFICATION_SECRET },
      ]),
    })],
  ] as const)('treats %s as unavailable and never quarantines', async (_name, configure) => {
    const state = fixture('verifying', 9);
    const store = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1);
    await saveFixtureAssessment(store, state.leadId, 9);
    addPublishedManualItem(state);

    const loaded = await new D1ManualLeadProcessingStore(configure(state.env) as Env).getLead(state.leadId);

    expect(loaded?.assessment).toBeNull();
    expect(state.db.sqlite.prepare(`SELECT status, reason, invalidation_nonce
      FROM manual_news_assessment_verifications WHERE lead_id = ?`).get(state.leadId)).toEqual({
      status: 'active', reason: null, invalidation_nonce: null,
    });
    expect(state.db.sqlite.prepare('SELECT deleted_at FROM items WHERE id = ?')
      .get(`blog:manual:${state.leadId}`)).toEqual({ deleted_at: null });
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM manual_news_lead_audit
      WHERE lead_id = ? AND action = 'verification_quarantine'`).get(state.leadId)).toEqual({ count: 0 });
  });

  test('quarantines a known response key whose persisted HMAC is cryptographically invalid', async () => {
    const state = fixture('verifying', 9);
    const store = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1);
    await saveFixtureAssessment(store, state.leadId, 9);
    addPublishedManualItem(state);
    const audit = JSON.parse(String(state.db.sqlite.prepare(`SELECT fetch_audit_json
      FROM manual_news_evidence WHERE lead_id = ?`).get(state.leadId)!.fetch_audit_json));
    audit.response_hmac = '0'.repeat(64);
    state.db.sqlite.prepare(`UPDATE manual_news_evidence SET fetch_audit_json = ? WHERE lead_id = ?`)
      .run(JSON.stringify(audit), state.leadId);

    expect((await store.getLead(state.leadId))?.assessment).toBeNull();
    expect(state.db.sqlite.prepare(`SELECT status, reason FROM manual_news_assessment_verifications
      WHERE lead_id = ?`).get(state.leadId)).toEqual({
      status: 'invalidated', reason: 'verification_integrity_invalid',
    });
    expect(state.db.sqlite.prepare('SELECT deleted_at FROM items WHERE id = ?')
      .get(`blog:manual:${state.leadId}`)).toEqual({ deleted_at: expect.any(String) });
  });

  test('fails closed when verification secret or HMAC is invalid', async () => {
    const state = fixture('verifying', 9);
    const missingSecret = { ...state.env, MANUAL_NEWS_VERIFICATION_SECRET: undefined } as Env;
    await expect(saveFixtureAssessment(
      new D1ManualLeadProcessingStore(missingSecret, PROCESSING_OWNER, 1), state.leadId, 9,
    ))
      .rejects.toThrow(/manual_news_verification_keys_unavailable/);
    expect(state.db.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM manual_news_event_assessments WHERE lead_id = ?',
    ).get(state.leadId)).toEqual({ count: 0 });

    const store = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1);
    await saveFixtureAssessment(store, state.leadId, 9);
    const rotatedSecretStore = new D1ManualLeadProcessingStore({
      ...state.env, MANUAL_NEWS_VERIFICATION_SECRET: 'b'.repeat(64),
    } as Env);
    expect((await rotatedSecretStore.getLead(state.leadId))?.assessment).toBeNull();
    expect(state.db.sqlite.prepare(`SELECT status, reason FROM manual_news_assessment_verifications
      WHERE lead_id = ?`).get(state.leadId)).toEqual({
      status: 'invalidated', reason: 'verification_integrity_invalid',
    });
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

  test('quarantines a persisted active v9 proof instead of upgrading it in place', async () => {
    const state = fixture('verifying', 9);
    const store = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1);
    await saveFixtureAssessment(store, state.leadId, 9);
    const proof = state.db.sqlite.prepare(`SELECT policy_version, canonical_digest, hmac_sha256
      FROM manual_news_assessment_verifications WHERE lead_id = ? AND status = 'active'`)
      .get(state.leadId) as any;
    const legacy = proofForLegacyPolicy(
      proof,
      { lead_id: state.leadId, assessment_version: 9_000_001 },
      VERIFICATION_SECRET,
    );
    state.db.sqlite.prepare(`UPDATE manual_news_assessment_verifications
      SET policy_version = ?, hmac_sha256 = ? WHERE lead_id = ? AND status = 'active'`)
      .run(legacy.policy_version, legacy.hmac_sha256, state.leadId);

    expect((await store.getLead(state.leadId))?.assessment).toBeNull();
    expect(state.db.sqlite.prepare(`SELECT policy_version, status, reason
      FROM manual_news_assessment_verifications WHERE lead_id = ?`).get(state.leadId)).toEqual({
      policy_version: 'fact-evidence-projection-hmac-v9',
      status: 'invalidated',
      reason: 'verification_integrity_invalid',
    });
  });

  test('quarantines a v10 proof after its persisted evidence provenance becomes unsigned', async () => {
    const state = fixture('verifying', 9);
    const store = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1);
    await saveFixtureAssessment(store, state.leadId, 9);
    state.db.sqlite.prepare(`UPDATE manual_news_evidence SET fetch_audit_json = 'null'
      WHERE lead_id = ?`).run(state.leadId);

    expect((await store.getLead(state.leadId))?.assessment).toBeNull();
    expect(state.db.sqlite.prepare(`SELECT policy_version, status, reason
      FROM manual_news_assessment_verifications WHERE lead_id = ?`).get(state.leadId)).toEqual({
      policy_version: MANUAL_LEAD_VERIFICATION_POLICY_VERSION,
      status: 'invalidated',
      reason: 'verification_integrity_invalid',
    });
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
      assessment_evidence_disposition_contract: MANUAL_LEAD_EVIDENCE_DISPOSITION_CONTRACT,
      assessment_verification_policy: MANUAL_LEAD_VERIFICATION_POLICY_VERSION,
      assessment_recovery: 'persisted_verified',
    });
    const createAudit = state.db.sqlite.prepare(`SELECT metadata_json FROM manual_news_lead_audit
      WHERE lead_id = ? AND action = 'verification_create'`).get(state.leadId) as { metadata_json: string };
    expect(JSON.parse(createAudit.metadata_json)).toMatchObject({
      assessment_claim_contract: MANUAL_LEAD_GENERATED_CLAIM_CONTRACT,
      assessment_source_fact_contract: MANUAL_LEAD_SOURCE_FACT_CONTRACT,
      assessment_editorial_projection_contract: MANUAL_LEAD_EDITORIAL_PROJECTION_CONTRACT,
      assessment_evidence_disposition_contract: MANUAL_LEAD_EVIDENCE_DISPOSITION_CONTRACT,
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
      assessment_first_validation_code: 'unknown_evidence_id',
      assessment_first_validation_path: 'source_facts[0].evidence_ids[0]',
      assessment_last_validation_code: 'valid',
      assessment_regeneration_trigger_code: 'unknown_evidence_id',
      assessment_regeneration_trigger_path: 'source_facts[0].evidence_ids[0]',
      assessment_claim_contract: MANUAL_LEAD_GENERATED_CLAIM_CONTRACT,
      assessment_source_fact_contract: MANUAL_LEAD_SOURCE_FACT_CONTRACT,
      assessment_editorial_projection_contract: MANUAL_LEAD_EDITORIAL_PROJECTION_CONTRACT,
      assessment_evidence_disposition_contract: MANUAL_LEAD_EVIDENCE_DISPOSITION_CONTRACT,
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
      assessment_first_validation_code: 'unknown_evidence_id',
      assessment_first_validation_path: 'source_facts[0].evidence_ids[0]',
      assessment_last_validation_code: 'unknown_evidence_id',
      assessment_last_validation_path: 'source_facts[0].evidence_ids[0]',
      assessment_regeneration_trigger_code: 'unknown_evidence_id',
      assessment_regeneration_trigger_path: 'source_facts[0].evidence_ids[0]',
      assessment_claim_contract: MANUAL_LEAD_GENERATED_CLAIM_CONTRACT,
      assessment_source_fact_contract: MANUAL_LEAD_SOURCE_FACT_CONTRACT,
      assessment_editorial_projection_contract: MANUAL_LEAD_EDITORIAL_PROJECTION_CONTRACT,
      assessment_evidence_disposition_contract: MANUAL_LEAD_EVIDENCE_DISPOSITION_CONTRACT,
      assessment_verification_policy: MANUAL_LEAD_VERIFICATION_POLICY_VERSION,
    });
    await expect(getManualNewsLead(state.env, state.leadId)).resolves.toMatchObject({
      assessment_generation: {
        assessment_generation_attempts: 2,
        assessment_first_validation_code: 'unknown_evidence_id',
        assessment_first_validation_path: 'source_facts[0].evidence_ids[0]',
        assessment_last_validation_code: 'unknown_evidence_id',
        assessment_last_validation_path: 'source_facts[0].evidence_ids[0]',
        assessment_regeneration_trigger_code: 'unknown_evidence_id',
        assessment_regeneration_trigger_path: 'source_facts[0].evidence_ids[0]',
      },
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

  test('bounds and deterministically orders verified manual and automatic prior events', async () => {
    const state = fixture();
    const store = new D1ManualLeadProcessingStore(state.env);
    const addVerifiedManualPrior = async (leadId: string, reviewDate: string, eventKey: string) => {
      state.db.sqlite.prepare(`INSERT INTO manual_news_leads (
        id, review_date, input_type, input_text, input_url, note, status, version,
        submit_idempotency_key, processing_owner, processing_attempt, created_at, updated_at
      ) VALUES (?, ?, 'url', '', 'https://support.claude.com/example', '', 'verifying', 4,
        ?, ?, 1, 1, 1)`).run(leadId, reviewDate, `submit-${leadId}`, PROCESSING_OWNER);
      state.db.sqlite.prepare(`INSERT INTO manual_news_evidence (
        lead_id, evidence_id, response_key_id, url, source_type, publisher, published_at,
        retrieved_at, title, excerpt, claims_supported_json, fetch_audit_json, reliable
      ) SELECT ?, evidence_id, response_key_id, url, source_type, publisher, published_at,
        retrieved_at, title, excerpt, claims_supported_json, fetch_audit_json, reliable
        FROM manual_news_evidence WHERE lead_id = ?`).run(leadId, state.leadId);
      await saveFixtureAssessment(
        new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1),
        leadId,
        4,
        { ...processedAssessment(), event_key: eventKey },
      );
    };

    const sharedEventKey = 'shared-prior-event-2026-08-28';
    await addVerifiedManualPrior('manual-prior-shared', '2026-08-27', sharedEventKey);
    await addVerifiedManualPrior('manual-prior-unique', '2026-08-27', 'manual-prior-unique-2026-08-27');
    for (let index = 0; index < 36; index += 1) {
      const reviewDate = `2026-08-${String(28 - (index % 14)).padStart(2, '0')}`;
      const eventKey = index === 0 ? sharedEventKey : `automatic-prior-event-${String(index).padStart(2, '0')}`;
      state.db.sqlite.prepare(`INSERT INTO items (
        id, source_ref, extra, published_at, scraped_at, is_relevant, deleted_at
      ) VALUES (?, 'rss', ?, ?, ?, 1, NULL)`).run(
        `automatic-prior-${String(index).padStart(2, '0')}`,
        JSON.stringify({ event_fingerprint: eventKey }),
        reviewDate,
        reviewDate,
      );
    }
    state.db.sqlite.prepare(`INSERT INTO items (
      id, source_ref, extra, published_at, scraped_at, is_relevant, deleted_at
    ) VALUES ('automatic-outside-window', 'rss', ?, '2026-08-13', '2026-08-13', 1, NULL)`).run(
      JSON.stringify({ event_fingerprint: 'outside-window-event-2026-08-13' }),
    );

    const priorEvents = await store.listRecentPriorEvents('2026-08-28', state.leadId);

    expect(priorEvents).toHaveLength(24);
    expect(new Set(priorEvents.map((event) => event.event_key))).toHaveLength(24);
    expect(priorEvents).toEqual([...priorEvents].sort((left, right) =>
      right.review_date.localeCompare(left.review_date)
      || left.event_key.localeCompare(right.event_key)
      || (Number(!left.verification_digest) - Number(!right.verification_digest))
      || left.lead_id.localeCompare(right.lead_id)));
    expect(priorEvents.find((event) => event.event_key === sharedEventKey)).toMatchObject({
      lead_id: 'manual-prior-shared',
      review_date: '2026-08-27',
      verification_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(priorEvents.some((event) => event.lead_id === 'manual-prior-unique')).toBe(true);
    expect(priorEvents.some((event) => event.lead_id.startsWith('automatic-prior-'))).toBe(true);
    expect(priorEvents.some((event) => event.event_key === 'outside-window-event-2026-08-13')).toBe(false);
    const manualSql = state.db.preparedSql.find((sql) => sql.includes('manual_assessment:recent_prior_events')) || '';
    const automaticSql = state.db.preparedSql.find((sql) => sql.includes('manual_assessment:recent_non_manual_items')) || '';
    expect(manualSql).toMatch(/ORDER BY l\.review_date DESC, a\.event_key ASC, l\.id ASC\s+LIMIT \?/i);
    expect(automaticSql).toMatch(/ORDER BY review_date DESC, event_key ASC, lead_id ASC\s+LIMIT \?/i);
  });

  test('reinjects a truncated exact HMAC context after a transient verification retry without reassessment', async () => {
    const state = fixture();
    const { targetEventKey, priorLeadId } = await addTruncatedExactPriorContext(state);

    const firstStore = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1);
    const bounded = await firstStore.listRecentPriorEvents('2026-08-11', state.leadId);
    expect(bounded).toHaveLength(24);
    expect(bounded.some((event) => event.event_key === targetEventKey)).toBe(false);
    await expect(firstStore.findPriorEventsByEventKey(targetEventKey, state.leadId)).resolves.toEqual([
      expect.objectContaining({
        event_key: targetEventKey,
        lead_id: priorLeadId,
        verification_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);

    const adapters = verifyingAdapters();
    const baseVerify = adapters.verify;
    let assessmentCalls = 0;
    let verificationCalls = 0;
    adapters.assess = async () => {
      assessmentCalls += 1;
      return generatedAssessment({ material_update: true });
    };
    let verificationPriorEventKeys: string[] = [];
    adapters.verify = async (prompt, context) => {
      verificationCalls += 1;
      if (verificationCalls === 1) throw new Error('trusted_gateway_http_503');
      const body = JSON.parse(prompt.user) as {
        facts: Array<{
          fact_id: string;
          untrusted_prior_events?: Array<{ event_key: string }>;
        }>;
      };
      verificationPriorEventKeys = body.facts.find((fact) => fact.fact_id === 'field:material_update')
        ?.untrusted_prior_events?.map((event) => event.event_key) || [];
      const raw = await baseVerify(prompt, context) as {
        fact_results: Array<Record<string, unknown>>;
      };
      return {
        ...raw,
        fact_results: raw.fact_results.map((fact) => fact.fact_id === 'field:material_update'
          ? {
            ...fact,
            comparison_result: {
              ...(fact.comparison_result as Record<string, unknown>),
              value: true,
              matched_event_key: targetEventKey,
              prior_event_keys: [targetEventKey],
              reason_code: 'material_change',
            },
          }
          : fact),
      };
    };

    await expect(processManualNewsLead(state.leadId, firstStore, adapters))
      .rejects.toThrow(/trusted_gateway_http_503/);
    expect(assessmentCalls).toBe(1);
    expect(verificationCalls).toBe(1);
    expect(state.db.sqlite.prepare(`SELECT call_state, validated_assessment_json
      FROM manual_news_assessment_generation_cycles_v2 WHERE lead_id = ? AND is_current = 1`)
      .get(state.leadId)).toMatchObject({
      call_state: 'validated',
      validated_assessment_json: expect.stringContaining(`"matched_event_key":"${targetEventKey}"`),
    });

    expect(await claimManualNewsLeadProcessing(state.env, state.leadId, PROCESSING_OWNER, 10)).toBe(2);
    const result = await processManualNewsLead(
      state.leadId,
      new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 2),
      adapters,
    );

    expect(assessmentCalls).toBe(1);
    expect(verificationCalls).toBe(2);
    expect(verificationPriorEventKeys).toHaveLength(24);
    expect(verificationPriorEventKeys).toContain(targetEventKey);
    expect(result).toMatchObject({
      error_code: null,
      assessment: {
        material_update: true,
        matched_event_key: targetEventKey,
        matched_lead_id: priorLeadId,
      },
    });
  }, 15_000);

  test.each(['missing', 'damaged'] as const)(
    'fails closed on validated-cycle recovery when the exact HMAC context is %s',
    async (failureMode) => {
      const state = fixture();
      const { priorLeadId } = await addTruncatedExactPriorContext(state);
      let assessmentCalls = 0;
      let verificationCalls = 0;
      const firstAdapters = verifyingAdapters();
      firstAdapters.assess = async () => {
        assessmentCalls += 1;
        return generatedAssessment({ material_update: true });
      };
      firstAdapters.verify = async () => {
        verificationCalls += 1;
        throw new Error('trusted_gateway_http_503');
      };
      await expect(processManualNewsLead(
        state.leadId,
        new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1),
        firstAdapters,
      )).rejects.toThrow(/trusted_gateway_http_503/);

      if (failureMode === 'missing') {
        state.db.sqlite.prepare(`DELETE FROM manual_news_assessment_verifications
          WHERE lead_id = ? AND status = 'active'`).run(priorLeadId);
      } else {
        state.db.sqlite.prepare(`UPDATE manual_news_assessment_verifications
          SET hmac_sha256 = ? WHERE lead_id = ? AND status = 'active'`)
          .run('0'.repeat(64), priorLeadId);
      }
      expect(await claimManualNewsLeadProcessing(state.env, state.leadId, PROCESSING_OWNER, 10)).toBe(2);
      const retryAdapters = verifyingAdapters();
      retryAdapters.assess = async () => {
        assessmentCalls += 1;
        throw new Error('unexpected_reassessment');
      };
      retryAdapters.verify = async () => {
        verificationCalls += 1;
        throw new Error('unexpected_reverification');
      };

      const result = await processManualNewsLead(
        state.leadId,
        new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 2),
        retryAdapters,
      );

      expect(assessmentCalls).toBe(1);
      expect(verificationCalls).toBe(1);
      expect(result).toMatchObject({
        status: 'failed',
        error_code: 'processing_failed',
        error_message: 'persisted_assessment_exact_context_invalid',
        assessment: null,
      });
    },
  );

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

    const proof = state.db.sqlite.prepare(`SELECT policy_version, canonical_digest, hmac_sha256
      FROM manual_news_assessment_verifications WHERE lead_id = 'old-lead' AND status = 'active'`)
      .get() as any;
    const legacy = proofForLegacyPolicy(
      proof,
      { lead_id: 'old-lead', assessment_version: 3_000_001 },
      VERIFICATION_SECRET,
    );
    state.db.sqlite.prepare(`UPDATE manual_news_assessment_verifications
      SET policy_version = ?, hmac_sha256 = ? WHERE lead_id = 'old-lead' AND status = 'active'`)
      .run(legacy.policy_version, legacy.hmac_sha256);
    expect(await store.findPriorEventsByEventKey(assessment().event_key, state.leadId)).toEqual([]);
    expect(await store.listRecentPriorEvents('2026-01-02', state.leadId)).toEqual([]);
    expect(state.db.sqlite.prepare(`SELECT policy_version, status, reason
      FROM manual_news_assessment_verifications WHERE lead_id = 'old-lead'`).get()).toEqual({
      policy_version: 'fact-evidence-projection-hmac-v9',
      status: 'invalidated',
      reason: 'verification_integrity_invalid',
    });
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
         AND processing_lease_until = 960100`,
    ).get()).toMatchObject({ count: statuses.length });
    expect(state.db.sqlite.prepare(
      `SELECT COUNT(*) AS count FROM manual_news_lead_audit
       WHERE action = 'stale_recovery' AND resulting_version = 5`,
    ).get()).toMatchObject({ count: statuses.length });
  });

  test.each(['initial_started', 'regeneration_started'] as const)(
    'atomically supersedes the current %s generation cycle during stale recovery',
    async (cycleState) => {
      const state = fixture('verifying', 4);
      const oldStore = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1);
      const initial = await oldStore.beginAssessmentGenerationCycle(state.leadId, 4);
      if (cycleState === 'regeneration_started') {
        await oldStore.recordAssessmentGenerationValidation(state.leadId, 4, {
          generation_revision: 1, validation_code: 'non_atomic_source_object',
          validation_path: 'source_facts[0].atomic_fact.object', regeneratable: true,
        });
        await oldStore.consumeAssessmentRegeneration(state.leadId, 4);
      }
      state.db.sqlite.prepare(`UPDATE manual_news_leads
        SET processing_lease_until = 10 WHERE id = ?`).run(state.leadId);

      const recovered = await recoverStaleManualNewsLeads(state.env, '2026-08-11', 100);

      expect(recovered).toHaveLength(1);
      expect(state.db.sqlite.prepare(`SELECT call_state, is_current, supersede_nonce,
          superseded_by_processing_owner AS next_owner
        FROM manual_news_assessment_generation_cycles_v2 WHERE cycle_id = ?`).get(initial.cycle_id))
        .toMatchObject({
          call_state: 'superseded', is_current: 0,
          supersede_nonce: expect.stringMatching(/^assessment_generation_stale_supersede:/),
          next_owner: `manual-news-${state.leadId}-v5`,
        });
      expect(state.db.sqlite.prepare(`SELECT action, mutation_nonce, resulting_version
        FROM manual_news_lead_audit WHERE lead_id = ? AND action = 'assessment_generation_supersede'`)
        .all(state.leadId)).toEqual([{
        action: 'assessment_generation_supersede',
        mutation_nonce: expect.stringMatching(/^assessment_generation_stale_supersede:/),
        resulting_version: 5,
      }]);
      const recoveredOwner = `manual-news-${state.leadId}-v5`;
      const recoveredStore = new D1ManualLeadProcessingStore(state.env, recoveredOwner, 1);
      await recoveredStore.transition(state.leadId, 'validating', 'researching');
      await recoveredStore.transition(state.leadId, 'researching', 'extracting');
      await recoveredStore.transition(state.leadId, 'extracting', 'verifying');
      await expect(recoveredStore.beginAssessmentGenerationCycle(state.leadId, 8)).resolves.toMatchObject({
        call_state: 'initial_started', acquired_call: true,
      });
      expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count
        FROM manual_news_assessment_generation_cycles_v2
        WHERE lead_id = ? AND is_current = 1`).get(state.leadId)).toEqual({ count: 1 });
    },
  );

  test('recovers a stale lead without a v2 cycle and emits no supersede ghost audit', async () => {
    const state = fixture('verifying', 4);
    state.db.sqlite.prepare(`UPDATE manual_news_leads
      SET processing_lease_until = 10 WHERE id = ?`).run(state.leadId);

    await expect(recoverStaleManualNewsLeads(state.env, '2026-08-11', 100))
      .resolves.toHaveLength(1);
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM manual_news_lead_audit
      WHERE lead_id = ? AND action = 'assessment_generation_supersede'`).get(state.leadId))
      .toEqual({ count: 0 });
  });

  test('stale recovery has one CAS winner and no loser cycle audit or ABA nonce reuse', async () => {
    const state = fixture('verifying', 4);
    const oldStore = new D1ManualLeadProcessingStore(state.env, PROCESSING_OWNER, 1);
    const current = await oldStore.beginAssessmentGenerationCycle(state.leadId, 4);
    state.db.sqlite.prepare(`UPDATE manual_news_assessment_generation_cycles_v2
      SET call_state = 'superseded', is_current = 0, superseded_by_processing_owner = 'older-owner',
          supersede_nonce = 'old-aba-nonce' WHERE cycle_id = ?`).run(current.cycle_id);
    state.db.sqlite.prepare(`INSERT INTO manual_news_assessment_generation_cycles_v2 (
      cycle_id, lead_id, processing_owner, base_version, call_state, regeneration_consumed,
      is_current, start_nonce, created_at, updated_at
    ) VALUES ('cycle-current-replacement', ?, 'stale-cycle-owner', 4, 'initial_started', 0, 1,
      'replacement-start-nonce', 2, 2)`).run(state.leadId);
    state.db.sqlite.prepare(`UPDATE manual_news_leads
      SET processing_lease_until = 10 WHERE id = ?`).run(state.leadId);

    const [left, right] = await Promise.all([
      recoverStaleManualNewsLeads(state.env, '2026-08-11', 100),
      recoverStaleManualNewsLeads(state.env, '2026-08-11', 100),
    ]);

    expect(left.length + right.length).toBe(1);
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM manual_news_lead_audit
      WHERE lead_id = ? AND action = 'stale_recovery'`).get(state.leadId)).toEqual({ count: 1 });
    expect(state.db.sqlite.prepare(`SELECT mutation_nonce FROM manual_news_lead_audit
      WHERE lead_id = ? AND action = 'assessment_generation_supersede'`).all(state.leadId))
      .toEqual([{ mutation_nonce: expect.not.stringMatching(/^old-aba-nonce$/) }]);
    expect(state.db.sqlite.prepare(`SELECT call_state, is_current, supersede_nonce
      FROM manual_news_assessment_generation_cycles_v2 WHERE cycle_id = 'cycle-current-replacement'`).get())
      .toMatchObject({
        call_state: 'superseded', is_current: 0,
        supersede_nonce: expect.stringMatching(/^assessment_generation_stale_supersede:/),
      });
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

  test('persists only a stable provider root cause, stage, and prompt metrics after retry exhaustion', async () => {
    const state = fixture('verifying', 7);
    state.db.sqlite.prepare(
      `UPDATE manual_news_leads SET processing_owner = 'workflow-owner', processing_attempt = 6,
       processing_lease_until = 999 WHERE id = ?`,
    ).run(state.leadId);
    const error = new ManualNewsProviderError({
      stage: 'assessment', provider_error_code: 'provider_output_exhausted',
      metrics: {
        stage: 'assessment', request_id: `${state.leadId}:p6:assessment:1`,
        system_chars: 1_200, user_chars: 7_200, evidence_count: 1, attempt: 6,
      },
      assessment_generation_attempt: 1,
      assessment_last_validation_code: 'not_validated',
      provider_diagnostics: {
        finish_reason: 'length', content_chars: 0, reasoning_chars: 3_500,
        usage: {
          prompt_tokens: 1_200, completion_tokens: 3_500,
          total_tokens: 4_700, reasoning_tokens: 3_500,
        },
      },
    });

    expect(await failManualNewsLeadAfterExhaustion(
      state.env, state.leadId, 'workflow-owner', 6, error, 100,
    )).toBe(true);

    expect(state.db.sqlite.prepare(
      'SELECT status, error_code, error_message FROM manual_news_leads WHERE id = ?',
    ).get(state.leadId)).toEqual({
      status: 'failed', error_code: 'processing_retry_exhausted',
      error_message: 'manual_news_provider_error:assessment:provider_output_exhausted',
    });
    const audit = state.db.sqlite.prepare(
      `SELECT metadata_json FROM manual_news_lead_audit
       WHERE lead_id = ? AND action = 'processing_exhausted'`,
    ).get(state.leadId) as { metadata_json: string };
    const metadata = JSON.parse(audit.metadata_json);
    expect(metadata).toEqual({
      processing_owner: 'workflow-owner', processing_attempt: 6,
      provider_failure: {
        stage: 'assessment', provider_error_code: 'provider_output_exhausted',
        request_id: `${state.leadId}:p6:assessment:1`,
        system_chars: 1_200, user_chars: 7_200, evidence_count: 1, attempt: 6,
        assessment_generation_attempt: 1,
        assessment_last_validation_code: 'not_validated',
        provider_diagnostics: {
          finish_reason: 'length', content_chars: 0, reasoning_chars: 3_500,
          usage: {
            prompt_tokens: 1_200, completion_tokens: 3_500,
            total_tokens: 4_700, reasoning_tokens: 3_500,
          },
        },
      },
    });
    await expect(getManualNewsLead(state.env, state.leadId)).resolves.toMatchObject({
      provider_failure: {
        stage: 'assessment', provider_error_code: 'provider_output_exhausted',
        provider_diagnostics: {
          finish_reason: 'length', content_chars: 0, reasoning_chars: 3_500,
          usage: { reasoning_tokens: 3_500 },
        },
      },
    });
    expect(JSON.stringify(metadata)).not.toContain('https://');
    expect(JSON.stringify(metadata)).not.toContain('Bearer');
    expect(JSON.stringify(metadata)).not.toContain('reasoning_content');
  });

  test('recovers safe provider diagnostics after a Workflow error serialization boundary', async () => {
    const state = fixture('verifying', 7);
    state.db.sqlite.prepare(
      `UPDATE manual_news_leads SET processing_owner = 'workflow-owner', processing_attempt = 6,
       processing_lease_until = 999 WHERE id = ?`,
    ).run(state.leadId);
    const original = new ManualNewsProviderError({
      stage: 'verification', provider_error_code: 'provider_capacity',
      metrics: {
        stage: 'verification', request_id: `${state.leadId}:p6:verification:2`,
        system_chars: 900, user_chars: 5_100, evidence_count: 1, attempt: 6,
      },
      provider_diagnostics: {
        finish_reason: 'insufficient_system_resource',
        content_chars: 0,
        reasoning_chars: 900,
        usage: { prompt_tokens: 800, completion_tokens: 900, total_tokens: 1_700, reasoning_tokens: 900 },
      },
    });
    const deserialized = new Error(original.message);

    expect(await failManualNewsLeadAfterExhaustion(
      state.env, state.leadId, 'workflow-owner', 6, deserialized, 100,
    )).toBe(true);

    expect(state.db.sqlite.prepare(
      'SELECT error_message FROM manual_news_leads WHERE id = ?',
    ).get(state.leadId)).toEqual({
      error_message: 'manual_news_provider_error:verification:provider_capacity',
    });
    const audit = state.db.sqlite.prepare(
      `SELECT metadata_json FROM manual_news_lead_audit
       WHERE lead_id = ? AND action = 'processing_exhausted'`,
    ).get(state.leadId) as { metadata_json: string };
    expect(JSON.parse(audit.metadata_json)).toMatchObject({
      provider_failure: {
        stage: 'verification', provider_error_code: 'provider_capacity',
        request_id: `${state.leadId}:p6:verification:2`,
        system_chars: 900, user_chars: 5_100, evidence_count: 1, attempt: 6,
        provider_diagnostics: {
          finish_reason: 'insufficient_system_resource',
          content_chars: 0,
          reasoning_chars: 900,
          usage: { prompt_tokens: 800, completion_tokens: 900, total_tokens: 1_700, reasoning_tokens: 900 },
        },
      },
    });
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
        processing_lease_until: 960100,
      },
    });
    expect(await recoverStaleManualNewsLeads(state.env, '2026-08-11', 101)).toEqual([]);

    const recovered = await recoverStaleManualNewsLeads(state.env, '2026-08-11', 960101);
    expect(recovered).toEqual([expect.objectContaining({
      version: 9,
      processing_owner: `manual-news-${state.leadId}-v9`,
      processing_lease_until: 1920101,
    })]);
    expect(await recoverStaleManualNewsLeads(state.env, '2026-08-11', 960102)).toEqual([]);
    expect(state.db.sqlite.prepare(
      `SELECT version, processing_owner AS owner, processing_lease_until AS lease
       FROM manual_news_leads WHERE id = ?`,
    ).get(state.leadId)).toEqual({
      version: 9,
      owner: `manual-news-${state.leadId}-v9`,
      lease: 1920101,
    });
  });

  test('list-triggered stale recovery reuses the explicit retry epoch after a terminal paid retrieval crash', async () => {
    const state = fixture('failed', 7);
    state.db.sqlite.prepare(
      'UPDATE manual_news_leads SET input_url = ? WHERE id = ?',
    ).run('https://mp.weixin.qq.com/s/a0kOMCJ78T8GlQ8dJ_fUDw', state.leadId);
    const retried = await retryManualNewsLead(
      state.env, state.leadId, 7, 'retry-terminal-crash-window', 100,
    );
    expect(retried).toMatchObject({
      ok: true,
      changed: true,
      lead: { status: 'validating', version: 8 },
    });
    const retrievalEpoch = Number((state.db.sqlite.prepare(
      `SELECT id FROM manual_news_lead_audit
       WHERE lead_id = ? AND action = 'retry' ORDER BY id DESC LIMIT 1`,
    ).get(state.leadId) as { id: number }).id);
    expect(retrievalEpoch).toBeGreaterThan(0);

    const initialOwner = `manual-news-${state.leadId}-v8`;
    const initialStore = new D1ManualLeadProcessingStore(state.env, initialOwner, 1);
    await initialStore.transition(state.leadId, 'validating', 'researching');
    await initialStore.transition(state.leadId, 'researching', 'extracting');
    state.db.sqlite.prepare(
      'UPDATE manual_news_leads SET processing_lease_until = 10 WHERE id = ?',
    ).run(state.leadId);

    // The paid provider has already exhausted generation N. CF crashed before it
    // could persist needs_review, leaving the lead in extracting with an expired lease.
    let upstreamCalls = 1;
    const terminalGenerations = new Set([retrievalEpoch]);
    const requestedGenerations: number[] = [];
    const workflowCreates: Array<{ id: string; params: { lead_id: string; processing_owner: string } }> = [];
    const pending: Promise<unknown>[] = [];
    state.db.sqlite.exec(`CREATE TABLE daily_news_review_batches (
      review_date TEXT NOT NULL, batch_id TEXT NOT NULL, lineage_id TEXT NOT NULL,
      is_current INTEGER NOT NULL, created_at INTEGER NOT NULL
    )`);
    const apiEnv = {
      ...state.env,
      DAILY_NEWS_REVIEW_SECRET: 'shared-secret',
      DAILY_NEWS_REVIEW_ENABLED: '1',
      MANUAL_NEWS_LEAD_WORKFLOW: {
        create: async (input: { id: string; params: { lead_id: string; processing_owner: string } }) => {
          workflowCreates.push(input);
          return { id: input.id };
        },
      },
      MANUAL_NEWS_RESEARCH_ORIGIN: 'https://research-gateway.example',
      MANUAL_NEWS_RESEARCH_TOKEN: 'test-research-token',
      DEEPSEEK_API_KEY: 'test-key',
    } as Env;

    const listed = await handleManualNewsLeadsApi(new Request(
      'https://api.example.test/api/digest/daily-news-leads?date=2026-08-11',
      { headers: { Authorization: 'Bearer shared-secret' } },
    ), apiEnv, {
      waitUntil(promise: Promise<unknown>) { pending.push(promise); },
    } as never, 1_000_000);
    expect(listed.status).toBe(200);
    await Promise.all(pending);
    expect(workflowCreates).toHaveLength(1);
    expect(await getManualNewsLead(state.env, state.leadId)).toMatchObject({
      status: 'validating',
      version: 11,
      processing_owner: workflowCreates[0].params.processing_owner,
    });

    const recoveredOwner = workflowCreates[0].params.processing_owner;
    const processingAttempt = await claimManualNewsLeadProcessing(
      state.env, state.leadId, recoveredOwner, 1_000_001,
    );
    expect(processingAttempt).not.toBeNull();
    await processManualNewsLead(
      state.leadId,
      new D1ManualLeadProcessingStore(state.env, recoveredOwner, processingAttempt!),
      {
        search: async () => [],
        fetch: async (_url, context) => {
          const generation = Number(context?.retrieval_generation);
          requestedGenerations.push(generation);
          if (!terminalGenerations.has(generation)) upstreamCalls += 1;
          throw new Error('provider_billing_retry_exhausted');
        },
        extract: async () => { throw new Error('unexpected_extract'); },
        assess: async () => { throw new Error('unexpected_assess'); },
        verify: async () => { throw new Error('unexpected_verify'); },
      },
    );

    expect(requestedGenerations).toEqual([retrievalEpoch]);
    expect(upstreamCalls).toBe(1);
    expect(await getManualNewsLead(state.env, state.leadId)).toMatchObject({
      status: 'needs_review', error_code: 'evidence_insufficient',
    });
  });

  test('paid retrieval epoch changes only after a committed explicit retry audit', async () => {
    const state = fixture('failed', 7);
    const epochStore = new D1ManualLeadProcessingStore(state.env);

    expect(await epochStore.getPaidRetrievalEpoch(state.leadId)).toBe(0);

    const failedCas = await retryManualNewsLead(
      state.env, state.leadId, 6, 'retry-epoch-failed-cas', 50,
    );
    expect(failedCas).toMatchObject({ ok: false, error: 'lead_version_conflict' });
    expect(await epochStore.getPaidRetrievalEpoch(state.leadId)).toBe(0);

    state.db.failAudit = true;
    await expect(retryManualNewsLead(
      state.env, state.leadId, 7, 'retry-epoch-failed-audit', 60,
    )).rejects.toThrow('injected_audit_failure');
    state.db.failAudit = false;
    expect(await epochStore.getPaidRetrievalEpoch(state.leadId)).toBe(0);

    const first = await retryManualNewsLead(
      state.env, state.leadId, 7, 'retry-epoch-first', 100,
    );
    expect(first).toMatchObject({ ok: true, changed: true, lead: { version: 8 } });
    const firstAuditId = Number((state.db.sqlite.prepare(
      `SELECT id FROM manual_news_lead_audit
       WHERE lead_id = ? AND action = 'retry' ORDER BY id DESC LIMIT 1`,
    ).get(state.leadId) as { id: number }).id);
    expect(firstAuditId).not.toBe(8);
    expect(await epochStore.getPaidRetrievalEpoch(state.leadId)).toBe(firstAuditId);

    const replay = await retryManualNewsLead(
      state.env, state.leadId, 7, 'retry-epoch-first', 110,
    );
    expect(replay).toMatchObject({ ok: true, changed: false });
    expect(await epochStore.getPaidRetrievalEpoch(state.leadId)).toBe(firstAuditId);

    const firstOwner = `manual-news-${state.leadId}-v8`;
    const processingAttempt = await claimManualNewsLeadProcessing(
      state.env, state.leadId, firstOwner, 120,
    );
    expect(processingAttempt).toBe(2);
    expect(await epochStore.getPaidRetrievalEpoch(state.leadId)).toBe(firstAuditId);

    await new D1ManualLeadProcessingStore(state.env, firstOwner, processingAttempt!)
      .transition(state.leadId, 'validating', 'researching');
    expect((await getManualNewsLead(state.env, state.leadId))?.version).toBe(9);
    expect(await epochStore.getPaidRetrievalEpoch(state.leadId)).toBe(firstAuditId);

    state.db.sqlite.prepare(
      'UPDATE manual_news_leads SET processing_lease_until = 10 WHERE id = ?',
    ).run(state.leadId);
    await expect(recoverStaleManualNewsLeads(state.env, '2026-08-11', 1_000_000))
      .resolves.toHaveLength(1);
    expect(await epochStore.getPaidRetrievalEpoch(state.leadId)).toBe(firstAuditId);
    state.db.sqlite.prepare(
      'UPDATE manual_news_leads SET processing_lease_until = 10 WHERE id = ?',
    ).run(state.leadId);
    await expect(recoverStaleManualNewsLeads(state.env, '2026-08-11', 2_000_000))
      .resolves.toHaveLength(1);
    expect(await epochStore.getPaidRetrievalEpoch(state.leadId)).toBe(firstAuditId);

    const recovered = await getManualNewsLead(state.env, state.leadId);
    expect(recovered).not.toBeNull();
    const recoveredAttempt = await claimManualNewsLeadProcessing(
      state.env, state.leadId, recovered!.processing_owner!, 2_000_001,
    );
    expect(recoveredAttempt).toBe(3);
    expect(await failManualNewsLeadAfterExhaustion(
      state.env, state.leadId, recovered!.processing_owner!, recoveredAttempt!,
      new Error('automatic workflow exhaustion'), 2_000_002,
    )).toBe(true);
    const failed = await getManualNewsLead(state.env, state.leadId);
    expect(failed).toMatchObject({ status: 'failed' });
    expect(await epochStore.getPaidRetrievalEpoch(state.leadId)).toBe(firstAuditId);

    const staleExpectedVersion = failed!.version - 1;
    const staleRetry = await retryManualNewsLead(
      state.env, state.leadId, staleExpectedVersion, 'retry-epoch-stale-cas', 2_000_003,
    );
    expect(staleRetry).toMatchObject({ ok: false, error: 'lead_version_conflict' });
    expect(await epochStore.getPaidRetrievalEpoch(state.leadId)).toBe(firstAuditId);

    const second = await retryManualNewsLead(
      state.env, state.leadId, failed!.version, 'retry-epoch-second', 2_000_004,
    );
    expect(second).toMatchObject({ ok: true, changed: true });
    const secondAuditId = Number((state.db.sqlite.prepare(
      `SELECT id FROM manual_news_lead_audit
       WHERE lead_id = ? AND action = 'retry' ORDER BY id DESC LIMIT 1`,
    ).get(state.leadId) as { id: number }).id);
    expect(secondAuditId).toBeGreaterThan(firstAuditId);
    expect(await epochStore.getPaidRetrievalEpoch(state.leadId)).toBe(secondAuditId);

    const epochQuery = state.db.preparedSql.find((sql) => sql.includes('manual_audit:paid_retrieval_epoch')) || '';
    expect(epochQuery).toMatch(/action\s*=\s*'retry'/i);
    expect(epochQuery).toMatch(/LIMIT\s+1\b/i);
    expect(epochQuery).not.toMatch(/COUNT\s*\(/i);
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
      state.env, state.leadId, 8, ownerV8, error, 960102,
    ));

    const recovered = await recoverStaleManualNewsLeads(state.env, '2026-08-11', 960101);
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

const VOUCH_STATEMENT = 'OpenAI 发布 GPT-6 并向 Plus 用户开放。';
const VOUCH_EXCERPT = 'OpenAI is rolling out GPT-6 to Plus users today.';
const VOUCH_URL = 'https://openai.com/index/gpt-6/';

async function vouchFixture(status: 'needs_review' | 'failed' = 'needs_review', evidenceCount = 1) {
  const state = fixture('verifying', 4);
  state.db.sqlite.prepare('DELETE FROM manual_news_leads').run();
  state.db.sqlite.prepare('DELETE FROM manual_news_evidence').run();
  const submitted = await submitManualNewsLead(state.env, {
    date: '2026-08-28', text: 'OpenAI 发布 GPT-6', url: VOUCH_URL, note: '',
  }, 'submit-owner-vouch', 10);
  state.db.sqlite.prepare(`UPDATE manual_news_leads SET status = ?, version = 4,
    processing_owner = NULL, processing_attempt = 0,
    error_code = ?, error_message = ? WHERE id = ?`).run(
    status,
    status === 'failed' ? 'assessment_validation_failed' : null,
    status === 'failed' ? 'invalid_claim_predicate' : null,
    submitted.lead.id,
  );
  const evidence = Array.from({ length: evidenceCount }, (_, index) => withSignedArticleTextV2Audit({
    id: index === 0 ? 'ev-openai-gpt-6' : `ev-openai-mirror-${index}`,
    url: index === 0 ? VOUCH_URL : `${VOUCH_URL}mirror-${index}/`,
    source_type: index === 0 ? 'official_primary' : 'other',
    publisher: index === 0 ? 'OpenAI' : 'mirror.example.com',
    published_at: '2026-08-28T00:00:00.000Z', retrieved_at: 11 + index,
    title: 'Introducing GPT-6', excerpt: VOUCH_EXCERPT,
    claims_supported: [VOUCH_EXCERPT], reliable: index === 0,
  }));
  for (const item of evidence) {
    state.db.sqlite.prepare(`INSERT INTO manual_news_evidence (
      lead_id, evidence_id, response_key_id, url, source_type, publisher, published_at, retrieved_at,
      title, excerpt, claims_supported_json, fetch_audit_json, reliable
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      submitted.lead.id, item.id, item.response_key_id, item.url, item.source_type, item.publisher,
      item.published_at, item.retrieved_at, item.title, item.excerpt,
      JSON.stringify(item.claims_supported), JSON.stringify(item.fetch_audit), item.reliable ? 1 : 0,
    );
  }
  return {
    ...state,
    env: { ...state.env, DAILY_NEWS_REVIEW_SECRET: 'owner-vouch-review-secret' } as Env,
    leadId: submitted.lead.id,
    evidence,
  };
}

async function frozenVouchBatch(state: { db: SqliteD1; env: Env }) {
  installSourceSupportReviewSchema(state);
  state.db.sqlite.prepare(`DELETE FROM daily_news_review_batches
    WHERE review_date = '2026-08-28'`).run();
  installSourceSupportAutomaticPool(state, null);
  return freezeNewsReviewBatchFromPool(state.env, '2026-08-28', 100);
}

describe('manual news owner vouch', () => {
  test('confirms a needs_review lead without an assessment into the pre-freeze pool', async () => {
    const state = await vouchFixture();
    installSourceSupportReviewSchema(state);
    state.db.sqlite.prepare(`DELETE FROM daily_news_review_batches
      WHERE review_date = '2026-08-28'`).run();

    const result = await vouchManualNewsLeadCandidate(
      state.env, state.leadId, 4, 0, VOUCH_STATEMENT, 'vouch-key-1', 100,
    );

    expect(result).toMatchObject({
      ok: true, changed: true, batch: null, pending_initial_freeze: true, rerender_enqueued: false,
      lead: { status: 'needs_review', version: 6, confirmed_at: 100, confirmed_batch_id: null },
    });
    expect(state.db.sqlite.prepare(`SELECT policy_version, status, assessment_version,
      processing_attempt FROM manual_news_assessment_verifications WHERE lead_id = ?`)
      .get(state.leadId)).toMatchObject({
      policy_version: 'owner_vouched_v1', status: 'active', assessment_version: 4_900_000,
      processing_attempt: 1,
    });
    expect(state.db.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM manual_news_event_assessments WHERE lead_id = ?',
    ).get(state.leadId)).toEqual({ count: 0 });
    expect(state.db.sqlite.prepare(`SELECT id, source_id, source_ref, title, content, extra
      FROM items WHERE id = ?`).get(`blog:manual:${state.leadId}`)).toMatchObject({
      id: `blog:manual:${state.leadId}`,
      source_id: `manual:${state.leadId}`,
      source_ref: 'manual_lead',
      title: VOUCH_STATEMENT,
      content: VOUCH_STATEMENT,
    });
    const audits = state.db.sqlite.prepare(`SELECT action, from_status, to_status,
      resulting_version, metadata_json FROM manual_news_lead_audit
      WHERE lead_id = ? AND action IN ('vouch_candidate', 'confirm_candidate') ORDER BY id`)
      .all(state.leadId) as Array<Record<string, unknown>>;
    expect(audits.map((audit) => [audit.action, audit.resulting_version])).toEqual([
      ['vouch_candidate', 5], ['confirm_candidate', 6],
    ]);
    expect(JSON.parse(String(audits[0].metadata_json))).toMatchObject({
      candidate_authorization: 'owner_vouched_v1',
      statement: VOUCH_STATEMENT,
      canonical_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  test('appends the vouched candidate and keeps the gate, durable rebuild and sanitizer stable', async () => {
    const state = await vouchFixture();
    const frozen = await frozenVouchBatch(state);

    const result = await vouchManualNewsLeadCandidate(
      state.env, state.leadId, 4, frozen.batch.batch_revision, VOUCH_STATEMENT, 'vouch-key-1', 100,
    );

    expect(result).toMatchObject({
      ok: true,
      changed: true,
      rerender_enqueued: false,
      pending_initial_freeze: false,
      batch: { revision: frozen.batch.batch_revision + 1, current: true },
      lead: { confirmed_at: 100 },
    });
    const active = state.db.sqlite.prepare(`SELECT candidates_json FROM daily_news_review_batches
      WHERE review_date = '2026-08-28' AND is_current = 1`).get() as { candidates_json: string };
    const candidates = JSON.parse(active.candidates_json) as Array<Record<string, unknown>>;
    expect(candidates[candidates.length - 1]).toMatchObject({
      item_id: `blog:manual:${state.leadId}`,
      title: VOUCH_STATEMENT,
      summary: VOUCH_STATEMENT,
      source: 'OpenAI',
      score: null,
      url: VOUCH_URL,
      published_at: '2026-08-28T00:00:00.000Z',
      origin: 'manual_lead',
      lead_id: state.leadId,
    });

    await expect(durableConfirmedManualCandidates(state.env, '2026-08-28')).resolves.toEqual([
      expect.objectContaining({
        item_id: `blog:manual:${state.leadId}`,
        title: VOUCH_STATEMENT,
        lead_id: state.leadId,
      }),
    ]);
    await expect(authorizeFormalNewsSet(
      state.env, '2026-08-28', [`blog:manual:${state.leadId}`], 'owner-vouch-test',
    )).resolves.toMatchObject({
      allowed_ids: [`blog:manual:${state.leadId}`],
      decisions: [{ allowed: true, code: 'ALLOW_VERIFIED_MANUAL' }],
    });

    const firstSanitize = await sanitizeCurrentNewsReviewBatch(state.env, '2026-08-28', 100);
    const secondSanitize = await sanitizeCurrentNewsReviewBatch(state.env, '2026-08-28', 100);
    expect(firstSanitize.changed).toBe(false);
    expect(secondSanitize.changed).toBe(false);
    expect(secondSanitize.batch.batch_id).toBe(firstSanitize.batch.batch_id);
    expect(secondSanitize.batch.batch_revision).toBe(frozen.batch.batch_revision + 1);
    expect(secondSanitize.manual_verifications).toEqual([
      expect.objectContaining({
        lead_id: state.leadId,
        verification: expect.objectContaining({ policy_version: 'owner_vouched_v1' }),
      }),
    ]);
  });

  test('returns the same result when the vouch idempotency key is replayed', async () => {
    const state = await vouchFixture();
    const frozen = await frozenVouchBatch(state);

    const first = await vouchManualNewsLeadCandidate(
      state.env, state.leadId, 4, frozen.batch.batch_revision, VOUCH_STATEMENT, 'vouch-key-1', 100,
    );
    const replay = await vouchManualNewsLeadCandidate(
      state.env, state.leadId, 4, frozen.batch.batch_revision, VOUCH_STATEMENT, 'vouch-key-1', 100,
    );

    expect(first.ok).toBe(true);
    expect(replay).toMatchObject({ ok: true, changed: false, pending_initial_freeze: false });
    expect(replay.ok && replay.batch?.batch_id).toBe(first.ok && first.batch?.batch_id);
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM manual_news_lead_audit
      WHERE lead_id = ? AND action IN ('vouch_candidate', 'confirm_candidate')`)
      .get(state.leadId)).toEqual({ count: 2 });
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count
      FROM manual_news_assessment_verifications WHERE lead_id = ?`).get(state.leadId))
      .toEqual({ count: 1 });
  });

  test('keeps the proof row on a batch revision conflict and confirms on retry', async () => {
    const state = await vouchFixture();
    const frozen = await frozenVouchBatch(state);

    const conflicted = await vouchManualNewsLeadCandidate(
      state.env, state.leadId, 4, frozen.batch.batch_revision + 5, VOUCH_STATEMENT, 'vouch-key-1', 100,
    );

    expect(conflicted).toMatchObject({
      ok: false, status: 409, error: 'candidate_batch_revision_conflict',
    });
    expect(state.db.sqlite.prepare(`SELECT policy_version, status
      FROM manual_news_assessment_verifications WHERE lead_id = ?`).get(state.leadId))
      .toMatchObject({ policy_version: 'owner_vouched_v1', status: 'active' });
    expect(state.db.sqlite.prepare('SELECT version, confirmed_at FROM manual_news_leads WHERE id = ?')
      .get(state.leadId)).toEqual({ version: 5, confirmed_at: null });

    const retried = await vouchManualNewsLeadCandidate(
      state.env, state.leadId, 5, frozen.batch.batch_revision, VOUCH_STATEMENT, 'vouch-key-2', 101,
    );

    expect(retried).toMatchObject({ ok: true, changed: true, lead: { version: 6, confirmed_at: 101 } });
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM manual_news_lead_audit
      WHERE lead_id = ? AND action = 'vouch_candidate'`).get(state.leadId)).toEqual({ count: 1 });
  });

  test('rejects an invalid statement with 400 before touching the database', async () => {
    const state = await vouchFixture();
    installSourceSupportReviewSchema(state);
    const sqlStart = state.db.preparedSql.length;

    await expect(vouchManualNewsLeadCandidate(
      state.env, state.leadId, 4, 1, '太短', 'vouch-key-1', 100,
    )).resolves.toEqual({ ok: false, status: 400, error: 'invalid_vouch_statement' });
    expect(state.db.preparedSql.slice(sqlStart)).toEqual([]);
  });

  test('refuses a lead without evidence', async () => {
    const state = await vouchFixture();
    installSourceSupportReviewSchema(state);
    state.db.sqlite.prepare('DELETE FROM manual_news_evidence WHERE lead_id = ?').run(state.leadId);

    await expect(vouchManualNewsLeadCandidate(
      state.env, state.leadId, 4, 1, VOUCH_STATEMENT, 'vouch-key-1', 100,
    )).resolves.toMatchObject({ ok: false, status: 409, error: 'lead_not_vouchable' });
    expect(state.db.sqlite.prepare(`SELECT COUNT(*) AS count
      FROM manual_news_assessment_verifications WHERE lead_id = ?`).get(state.leadId))
      .toEqual({ count: 0 });
  });

  test('refuses a lead that already carries a verified assessment', async () => {
    const state = await vouchFixture();
    installSourceSupportReviewSchema(state);
    addActiveVerification(state as unknown as ReturnType<typeof fixture>);

    await expect(vouchManualNewsLeadCandidate(
      state.env, state.leadId, 4, 1, VOUCH_STATEMENT, 'vouch-key-1', 100,
    )).resolves.toMatchObject({ ok: false, status: 409, error: 'lead_not_vouchable' });
  });

  test('refuses a stale version, a confirmed lead and an expired review window', async () => {
    const state = await vouchFixture();
    const frozen = await frozenVouchBatch(state);

    await expect(vouchManualNewsLeadCandidate(
      state.env, state.leadId, 3, frozen.batch.batch_revision, VOUCH_STATEMENT, 'vouch-stale', 100,
    )).resolves.toMatchObject({ ok: false, status: 409, error: 'lead_version_conflict' });
    await expect(vouchManualNewsLeadCandidate(
      state.env, state.leadId, 4, frozen.batch.batch_revision, VOUCH_STATEMENT, 'vouch-expired',
      Date.parse('2026-09-30T00:00:00.000Z'),
    )).resolves.toMatchObject({ ok: false, status: 409, error: 'review_expired' });

    await vouchManualNewsLeadCandidate(
      state.env, state.leadId, 4, frozen.batch.batch_revision, VOUCH_STATEMENT, 'vouch-key-1', 100,
    );

    await expect(vouchManualNewsLeadCandidate(
      state.env, state.leadId, 6, frozen.batch.batch_revision + 1, '阿里巴巴发布通义千问新模型。',
      'vouch-key-3', 102,
    )).resolves.toMatchObject({ ok: false, status: 409, error: 'lead_not_vouchable' });
  });

  test('vouches a failed lead that still has verifiable evidence', async () => {
    const state = await vouchFixture('failed');
    const frozen = await frozenVouchBatch(state);

    const result = await vouchManualNewsLeadCandidate(
      state.env, state.leadId, 4, frozen.batch.batch_revision, VOUCH_STATEMENT, 'vouch-key-1', 100,
    );

    expect(result).toMatchObject({
      ok: true, changed: true, lead: { status: 'needs_review', confirmed_at: 100 },
    });
    expect(state.db.sqlite.prepare(`SELECT from_status, to_status FROM manual_news_lead_audit
      WHERE lead_id = ? AND action = 'vouch_candidate'`).get(state.leadId))
      .toEqual({ from_status: 'failed', to_status: 'needs_review' });
  });

  test('writes the signed projection time when an earlier evidence id carries another date', async () => {
    const state = await vouchFixture();
    state.db.sqlite.prepare('DELETE FROM manual_news_evidence WHERE lead_id = ?').run(state.leadId);
    const mirror = withSignedArticleTextV2Audit({
      id: 'ev-aaa-mirror', url: `${VOUCH_URL}mirror/`, source_type: 'other',
      publisher: 'mirror.example.com', published_at: '2026-08-01T00:00:00.000Z', retrieved_at: 12,
      title: 'Mirror', excerpt: VOUCH_EXCERPT, claims_supported: [VOUCH_EXCERPT], reliable: false,
    });
    for (const item of [mirror, state.evidence[0]]) {
      state.db.sqlite.prepare(`INSERT INTO manual_news_evidence (
        lead_id, evidence_id, response_key_id, url, source_type, publisher, published_at, retrieved_at,
        title, excerpt, claims_supported_json, fetch_audit_json, reliable
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        state.leadId, item.id, item.response_key_id, item.url, item.source_type, item.publisher,
        item.published_at, item.retrieved_at, item.title, item.excerpt,
        JSON.stringify(item.claims_supported), JSON.stringify(item.fetch_audit), item.reliable ? 1 : 0,
      );
    }
    const frozen = await frozenVouchBatch(state);

    await expect(vouchManualNewsLeadCandidate(
      state.env, state.leadId, 4, frozen.batch.batch_revision, VOUCH_STATEMENT, 'vouch-key-1', 100,
    )).resolves.toMatchObject({ ok: true, changed: true });

    expect(state.db.sqlite.prepare('SELECT published_at, url, author FROM items WHERE id = ?')
      .get(`blog:manual:${state.leadId}`)).toEqual({
      published_at: '2026-08-28T00:00:00.000Z', url: VOUCH_URL, author: 'OpenAI',
    });
    await expect(authorizeFormalNewsSet(
      state.env, '2026-08-28', [`blog:manual:${state.leadId}`], 'owner-vouch-multi-evidence',
    )).resolves.toMatchObject({
      allowed_ids: [`blog:manual:${state.leadId}`],
      decisions: [{ allowed: true, code: 'ALLOW_VERIFIED_MANUAL' }],
    });
  });

  test('quarantines a tampered vouch proof before the formal gate', async () => {
    const state = await vouchFixture();
    const frozen = await frozenVouchBatch(state);
    await vouchManualNewsLeadCandidate(
      state.env, state.leadId, 4, frozen.batch.batch_revision, VOUCH_STATEMENT, 'vouch-key-1', 100,
    );
    state.db.sqlite.prepare(`UPDATE manual_news_assessment_verifications
      SET verification_json = json_set(verification_json, '$.item_projection.title', '伪造的候选标题内容')
      WHERE lead_id = ? AND status = 'active'`).run(state.leadId);

    await expect(authorizeFormalNewsSet(
      state.env, '2026-08-28', [`blog:manual:${state.leadId}`], 'owner-vouch-tamper',
    )).resolves.toMatchObject({
      allowed_ids: [], decisions: [{ allowed: false, code: 'DENY_UNVERIFIED_MANUAL' }],
    });
    expect(state.db.sqlite.prepare(`SELECT status, reason
      FROM manual_news_assessment_verifications WHERE lead_id = ?`).get(state.leadId))
      .toMatchObject({ status: 'invalidated', reason: 'verification_integrity_invalid' });
  });

  test('rejects a vouch proof whose authorization audit no longer matches', async () => {
    const state = await vouchFixture();
    const frozen = await frozenVouchBatch(state);
    await vouchManualNewsLeadCandidate(
      state.env, state.leadId, 4, frozen.batch.batch_revision, VOUCH_STATEMENT, 'vouch-key-1', 100,
    );
    state.db.sqlite.prepare(`UPDATE manual_news_lead_audit
      SET metadata_json = json_set(metadata_json, '$.canonical_digest', ?)
      WHERE lead_id = ? AND action = 'vouch_candidate'`).run('0'.repeat(64), state.leadId);

    await expect(loadVerifiedManualCandidateProof(state.env, state.leadId)).resolves.toBeNull();
  });

  test('orders a vouched candidate by its vouch authorization, not by its confirmation', async () => {
    const state = await vouchFixture();
    const frozen = await frozenVouchBatch(state);

    // 先制造一次「担保已写、确认撞版本」的中间态,让担保审计与确认审计之间夹进另一条线索。
    await vouchManualNewsLeadCandidate(
      state.env, state.leadId, 4, frozen.batch.batch_revision + 5, VOUCH_STATEMENT, 'vouch-key-1', 100,
    );
    const second = await addSourceSupportLead(state, {
      idempotencyKey: 'submit-source-support-after-vouch', owner: 'source-support-owner-b',
      fact: 'Anthropic 开放 Model Hardware Standard（MHS）研究预览。',
      excerpt: 'Anthropic is opening a research preview of the Model Hardware Standard (MHS), '
        + 'a shared specification for AI agents to safely operate physical devices, '
        + 'to a first group of scientific research labs and advanced manufacturers.',
      url: 'https://www.anthropic.com/news/model-hardware-standard-research-preview',
      evidenceId: 'ev-anthropic-mhs', publisher: 'Anthropic', now: 101,
    });
    await vouchManualNewsLeadCandidate(
      state.env, state.leadId, 5, frozen.batch.batch_revision, VOUCH_STATEMENT, 'vouch-key-2', 102,
    );
    await new D1ManualLeadProcessingStore(state.env, second.owner, 1)
      .saveSourceSupportedCandidate(second.leadId, 4, second.payload);

    const active = state.db.sqlite.prepare(`SELECT candidates_json FROM daily_news_review_batches
      WHERE review_date = '2026-08-28' AND is_current = 1`).get() as { candidates_json: string };
    const manualIds = (JSON.parse(active.candidates_json) as Array<{ item_id: string }>)
      .map((candidate) => candidate.item_id)
      .filter((itemId) => itemId.startsWith('blog:manual:'));
    expect(manualIds).toEqual([
      `blog:manual:${state.leadId}`,
      `blog:manual:${second.leadId}`,
    ]);
  });
});
