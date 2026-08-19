import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

import type { Env } from '../index';
import {
  applyManualLeadEvidencePolicy,
  buildManualLeadFactVerificationPrompt,
  createManualLeadVerificationProof,
  validateManualLeadGeneratedAssessment,
  validateManualLeadFactVerification,
} from './manual-news-leads';
import { confirmManualNewsLeadCandidate, retryManualNewsLead } from './manual-news-leads-store';
import {
  createNewsReviewToken,
  freezeNewsReviewBatch,
  getActiveNewsReviewBatch,
  getAppliedNewsReviewSelection,
  getNewsReviewBatch,
  getVerifiedNewsReviewSelectionSnapshot,
  sanitizeCurrentNewsReviewBatch,
  submitNewsReviewSelection,
  type NewsReviewCandidate,
} from './news-review';
import {
  proofForLegacyPolicy,
  TEST_MANUAL_NEWS_RESPONSE_SECRET,
  testManualNewsResponseKeyring,
  testManualNewsVerificationKeyring,
  withSignedArticleTextV2Audit,
} from './manual-news-signed-evidence.test-fixture';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrations = path.resolve(here, '../../migrations');

class SerialSqliteD1 {
  readonly sqlite = new DatabaseSync(':memory:');
  readonly preparedSql: string[] = [];
  rejectEvidenceBlobMaterialization = false;
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
    this.sqlite.exec(fs.readFileSync(path.join(migrations, '034-manual-news-assessment-verifications.sql'), 'utf8'));
    this.sqlite.exec(fs.readFileSync(path.join(migrations, '035-manual-news-assessment-generation-cycles.sql'), 'utf8'));
    this.sqlite.exec(fs.readFileSync(path.join(migrations, '036-manual-news-assessment-generation-cycles-v2.sql'), 'utf8'));
    this.sqlite.exec(fs.readFileSync(path.join(migrations, '037-manual-news-proof-key-ids.sql'), 'utf8'));
    this.sqlite.exec(fs.readFileSync(path.join(migrations, '038-news-review-human-priority.sql'), 'utf8'));
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
      first: async <T>() => (statement.get(...bindings) as T | undefined) ?? null,
      all: async <T>() => {
        if (this.rejectEvidenceBlobMaterialization && sql.includes('manual_evidence:list')) {
          throw new Error('evidence_blob_materialized');
        }
        return { results: statement.all(...bindings) as T[], success: true, meta: {} };
      },
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
  const env = {
    DB: db as unknown as D1Database,
    DAILY_NEWS_REVIEW_SECRET: 'test-secret',
    MANUAL_NEWS_VERIFICATION_SECRET: 'b'.repeat(64),
    MANUAL_NEWS_VERIFICATION_KEY_ID: 'verification-key-2026-08-11',
    MANUAL_NEWS_RESEARCH_RESPONSE_SECRET: TEST_MANUAL_NEWS_RESPONSE_SECRET,
    MANUAL_NEWS_RESEARCH_RESPONSE_KEY_ID: 'response-key-2026-08-11',
  } as Env;
  return { db, env };
}

function candidates(prefix: string): NewsReviewCandidate[] {
  return Array.from({ length: 5 }, (_, index) => ({
    item_id: `${prefix}-${index + 1}`, title: `${prefix}新闻${index + 1}`,
    summary: '摘要', source: '来源', score: 100 - index, event_key: `${prefix}-event-${index + 1}`,
  }));
}

async function insertLead(db: SerialSqliteD1, id: string, eventKey: string): Promise<void> {
  const supportingText = 'Anthropic released Claude 5 on 2026-08-11.';
  const rawAssessment = {
    event_key: eventKey,
    event_type: 'product_release', material_update: false, score: 90,
    recommendation: 'recommended', occurred_at: '2026-08-11', uncertainties: [],
    source_facts: [{
      fact_ref: 'fact-01', source_language: 'en',
      atomic_fact: {
        subject: 'Anthropic', subject_role: 'organization', predicate: 'released', object: 'Claude 5 on 2026-08-11',
      },
      evidence_ids: [`ev-${id}`],
    }],
    evidence_dispositions: [{
      evidence_id: `ev-${id}`, disposition: 'supports_core',
      source_fact_refs: ['fact-01'], reason_code: null,
    }],
    editorial_projection: {
      title: {
        projection_ref: 'title-01', source_fact_refs: ['fact-01'],
        atomic_fact: {
          subject: 'Anthropic', subject_role: 'organization', predicate: '已发布', object: '2026年8月11日的Claude 5',
        },
      },
      summary: [{
        projection_ref: 'summary-01', source_fact_refs: ['fact-01'],
        atomic_fact: {
          subject: 'Anthropic', subject_role: 'organization', predicate: '已发布', object: '2026年8月11日的Claude 5',
        },
      }],
    },
    matched_event_key: null,
  };
  const evidence = withSignedArticleTextV2Audit({
    id: `ev-${id}`,
    url: `https://www.anthropic.com/news/${id}`,
    source_type: 'official_primary' as const,
    publisher: 'anthropic.com',
    published_at: '2026-08-11',
    retrieved_at: 1,
    title: 'Official product release documentation',
    excerpt: supportingText,
    claims_supported: [supportingText],
    reliable: true,
  });
  const core = validateManualLeadGeneratedAssessment(rawAssessment, [evidence]);
  const processed = applyManualLeadEvidencePolicy(core, [evidence]);
  const assessment = {
    ...processed,
    duplicate_scope: null,
    matched_lead_id: null,
  };
  const promptBody = JSON.parse(buildManualLeadFactVerificationPrompt({
    assessment, evidence: [evidence],
  }).user) as {
    facts: Array<{ fact_id: string }>;
    projections: Array<{ projection_id: string; source_fact_ids: string[] }>;
    evidence_dispositions: Array<{ evidence_id: string; disposition: string }>;
  };
  const facts = promptBody.facts;
  const verification = validateManualLeadFactVerification({
    overall_verdict: 'supported',
    fact_results: facts.map((fact) => ({
      fact_id: fact.fact_id,
      supported: true,
      issue_code: 'none',
      source_quotes: [{ evidence_id: evidence.id, quote: supportingText }],
      ...(fact.fact_id === 'field:material_update' ? {
        comparison_result: {
          value: false, matched_event_key: null, prior_event_keys: [], reason_code: 'no_prior_match',
          current_evidence_id: evidence.id, current_quote: supportingText,
        },
      } : {}),
    })),
    projection_results: promptBody.projections.map((projection) => ({
      projection_id: projection.projection_id, source_fact_ids: projection.source_fact_ids,
      supported: true, issue_code: 'none',
    })),
    disposition_results: promptBody.evidence_dispositions.map((disposition) => ({
      evidence_id: disposition.evidence_id, disposition: disposition.disposition,
      supported: true, issue_code: 'none',
      source_quotes: [{ evidence_id: evidence.id, quote: supportingText }],
    })),
  }, assessment, [evidence]);
  const proof = await createManualLeadVerificationProof({
    lead_id: id, assessment_version: 7, assessment, evidence: [evidence], verification,
  }, testManualNewsVerificationKeyring('b'.repeat(64)), testManualNewsResponseKeyring());
  db.sqlite.prepare(`INSERT INTO manual_news_leads (
    id, review_date, input_type, input_text, input_url, note, status, version,
    submit_idempotency_key, processing_owner, processing_attempt, created_at, updated_at
  ) VALUES (?, '2026-08-11', 'url', '', ?, '', 'recommended', 7, ?, 'workflow-owner', 1, 1, 1)`).run(
    id, `https://www.anthropic.com/news/${id}`, `submit-${id}`,
  );
  db.sqlite.prepare(`INSERT INTO manual_news_evidence (
    lead_id, evidence_id, response_key_id, url, source_type, publisher, published_at, retrieved_at,
    title, excerpt, claims_supported_json, reliable, fetch_audit_json
  ) VALUES (?, ?, ?, ?, 'official_primary', 'anthropic.com', '2026-08-11', 1,
    'Official product release documentation', ?, ?, 1, ?)`).run(
    id, `ev-${id}`, evidence.response_key_id, `https://www.anthropic.com/news/${id}`, supportingText,
    JSON.stringify([supportingText]), JSON.stringify(evidence.fetch_audit),
  );
  db.sqlite.prepare(`INSERT INTO manual_news_event_assessments (
    lead_id, assessment_version, event_key, event_type, material_update, score,
    recommendation, assessment_json, created_at
  ) VALUES (?, 7, ?, 'product_release', 1, 90, 'recommended', ?, 1)`).run(
    id, eventKey, JSON.stringify(assessment),
  );
  db.sqlite.prepare(`INSERT INTO manual_news_assessment_verifications (
    verification_id, lead_id, assessment_version, policy_version, verification_key_id, canonical_digest,
    hmac_sha256, verification_json, processing_owner, processing_attempt,
    creation_nonce, status, reason, created_at, invalidated_at
  ) VALUES (?, ?, 7, ?, ?, ?, ?, ?, 'workflow-owner', 1, ?, 'active', NULL, 1, NULL)`).run(
    `mav-${id}`, id, proof.policy_version, proof.verification_key_id,
    proof.canonical_digest, proof.hmac_sha256,
    JSON.stringify(verification), `verification-create-${id}`,
  );
}

function downgradeActiveProofToV9(db: SerialSqliteD1, leadId: string): void {
  const proof = db.sqlite.prepare(`SELECT policy_version, canonical_digest, hmac_sha256, assessment_version
    FROM manual_news_assessment_verifications WHERE lead_id = ? AND status = 'active'`)
    .get(leadId) as any;
  const legacy = proofForLegacyPolicy(
    proof,
    { lead_id: leadId, assessment_version: proof.assessment_version },
    'b'.repeat(64),
  );
  db.sqlite.prepare(`UPDATE manual_news_assessment_verifications
    SET policy_version = ?, hmac_sha256 = ? WHERE lead_id = ? AND status = 'active'`)
    .run(legacy.policy_version, legacy.hmac_sha256, leadId);
}

function stripActiveEvidenceProvenance(db: SerialSqliteD1, leadId: string): void {
  db.sqlite.prepare(`UPDATE manual_news_evidence SET fetch_audit_json = 'null' WHERE lead_id = ?`)
    .run(leadId);
}

function oversizePersistedEvidence(db: SerialSqliteD1, leadId: string, excerpt: string): void {
  db.sqlite.prepare(`UPDATE manual_news_evidence SET excerpt = ?, claims_supported_json = ?
    WHERE lead_id = ?`).run(excerpt, JSON.stringify([excerpt]), leadId);
}

function appendPersistedEvidenceToNine(db: SerialSqliteD1, leadId: string): void {
  for (let index = 2; index <= 9; index += 1) {
    db.sqlite.prepare(`INSERT INTO manual_news_evidence (
      lead_id, evidence_id, response_key_id, url, source_type, publisher, published_at, retrieved_at,
      title, excerpt, claims_supported_json, reliable, fetch_audit_json
    ) SELECT lead_id, ?, response_key_id, ?, source_type, publisher, published_at, retrieved_at,
      title, excerpt, claims_supported_json, reliable, fetch_audit_json
      FROM manual_news_evidence WHERE lead_id = ? LIMIT 1`).run(
      `ev-${leadId}-${index}`, `https://www.anthropic.com/news/${leadId}-${index}`, leadId,
    );
  }
}

function activeCount(db: SerialSqliteD1): number {
  return Number((db.sqlite.prepare(`SELECT COUNT(*) AS count FROM daily_news_review_batches
    WHERE review_date = '2026-08-11' AND lineage_id = '2026-08-11' AND is_current = 1`).get() as { count: number }).count);
}

describe('news review revision CAS', () => {
  test('verified selection snapshot binds the active revision and fails closed on a soft-deleted selected item', async () => {
    const current = state();
    const selected = candidates('snapshot');
    const frozen = await freezeNewsReviewBatch(
      current.env, '2026-08-11', selected, selected.map((item) => item.item_id), 100,
    );
    const insert = current.db.sqlite.prepare('INSERT INTO items (id, deleted_at) VALUES (?, NULL)');
    for (const item of selected) insert.run(item.item_id);

    await expect(getVerifiedNewsReviewSelectionSnapshot(current.env, '2026-08-11', 110)).resolves.toMatchObject({
      batch_id: frozen.batch.batch_id,
      batch_revision: 1,
      selected_ids: selected.map((item) => item.item_id),
      manual_verifications: [],
    });

    current.db.sqlite.prepare('UPDATE items SET deleted_at = ? WHERE id = ?')
      .run('2026-08-11T00:00:00.000Z', selected[2].item_id);
    await expect(getVerifiedNewsReviewSelectionSnapshot(current.env, '2026-08-11', 120))
      .rejects.toThrow('news_review_verified_selection_stale');
  });

  test('refreshes the current batch into one immutable revision when a manual proof becomes invalid', async () => {
    const current = state();
    const leadId = 'ml-20260811-sanitize0001';
    await insertLead(current.db, leadId, 'event-sanitize-manual');
    const frozen = await freezeNewsReviewBatch(
      current.env, '2026-08-11', candidates('sanitize'),
      candidates('sanitize').map((item) => item.item_id), 100,
    );
    const confirmed = await confirmManualNewsLeadCandidate(
      current.env, leadId, 7, frozen.batch.batch_revision, 'confirm-sanitize', 110,
    );
    expect(confirmed).toMatchObject({ ok: true, batch: { revision: 2 } });
    const before = await getActiveNewsReviewBatch(current.env, '2026-08-11');
    current.db.sqlite.prepare(`UPDATE manual_news_assessment_verifications SET hmac_sha256 = ?
      WHERE lead_id = ? AND status = 'active'`).run('0'.repeat(64), leadId);

    const sanitized = await sanitizeCurrentNewsReviewBatch(current.env, '2026-08-11', 120);
    expect(sanitized).toMatchObject({ changed: true, dropped_ids: [`blog:manual:${leadId}`] });
    expect(sanitized.batch.batch_revision).toBe(3);
    expect(sanitized.batch.candidates.some((candidate) => candidate.lead_id === leadId)).toBe(false);
    expect((await getNewsReviewBatch(current.env, '2026-08-11', before!.batch_id))?.candidates
      .some((candidate) => candidate.lead_id === leadId)).toBe(true);
    expect(activeCount(current.db)).toBe(1);

    const replay = await sanitizeCurrentNewsReviewBatch(current.env, '2026-08-11', 130);
    expect(replay).toMatchObject({ changed: false, dropped_ids: [] });
    expect(replay.batch.batch_id).toBe(sanitized.batch.batch_id);
  });

  test('candidate reconstruction drops an otherwise active v9 manual proof', async () => {
    const current = state();
    const leadId = 'ml-20260811-v9candidate01';
    await insertLead(current.db, leadId, 'anthropic-claude-5-release-2026-08-11');
    const frozen = await freezeNewsReviewBatch(
      current.env, '2026-08-11', candidates('v9-candidate'),
      candidates('v9-candidate').map((item) => item.item_id), 100,
    );
    await confirmManualNewsLeadCandidate(
      current.env, leadId, 7, frozen.batch.batch_revision, 'confirm-v9-candidate', 110,
    );
    downgradeActiveProofToV9(current.db, leadId);

    const sanitized = await sanitizeCurrentNewsReviewBatch(current.env, '2026-08-11', 120);

    expect(sanitized.dropped_ids).toContain(`blog:manual:${leadId}`);
    expect(sanitized.batch.candidates.some((candidate) => candidate.lead_id === leadId)).toBe(false);
  });

  test('candidate reconstruction drops a v10 manual proof over unsigned persisted evidence', async () => {
    const current = state();
    const leadId = 'ml-20260811-unsignedcand1';
    await insertLead(current.db, leadId, 'anthropic-claude-5-release-2026-08-11');
    const frozen = await freezeNewsReviewBatch(
      current.env, '2026-08-11', candidates('unsigned-candidate'),
      candidates('unsigned-candidate').map((item) => item.item_id), 100,
    );
    await confirmManualNewsLeadCandidate(
      current.env, leadId, 7, frozen.batch.batch_revision, 'confirm-unsigned-candidate', 110,
    );
    stripActiveEvidenceProvenance(current.db, leadId);

    const sanitized = await sanitizeCurrentNewsReviewBatch(current.env, '2026-08-11', 120);

    expect(sanitized.dropped_ids).toContain(`blog:manual:${leadId}`);
    expect(sanitized.batch.candidates.some((candidate) => candidate.lead_id === leadId)).toBe(false);
  });

  test('candidate reconstruction quarantines and drops a manual proof over a 3001-code-point excerpt', async () => {
    const current = state();
    const leadId = 'ml-20260811-boundedcand1';
    await insertLead(current.db, leadId, 'event-bounded-candidate');
    const frozen = await freezeNewsReviewBatch(
      current.env, '2026-08-11', candidates('bounded-candidate'),
      candidates('bounded-candidate').map((item) => item.item_id), 100,
    );
    await confirmManualNewsLeadCandidate(
      current.env, leadId, 7, frozen.batch.batch_revision, 'confirm-bounded-candidate', 110,
    );
    oversizePersistedEvidence(current.db, leadId, 'x'.repeat(3_001));
    current.db.preparedSql.length = 0;
    current.db.rejectEvidenceBlobMaterialization = true;

    const sanitized = await sanitizeCurrentNewsReviewBatch(current.env, '2026-08-11', 120);

    expect(current.db.preparedSql.some((sql) => sql.includes('manual_evidence:preflight'))).toBe(true);
    expect(current.db.preparedSql.some((sql) => sql.includes('manual_evidence:list'))).toBe(false);
    expect(sanitized.dropped_ids).toContain(`blog:manual:${leadId}`);
    expect(sanitized.batch.candidates.some((candidate) => candidate.lead_id === leadId)).toBe(false);
    expect(current.db.sqlite.prepare(`SELECT status, reason FROM manual_news_assessment_verifications
      WHERE lead_id = ?`).get(leadId)).toEqual({
      status: 'invalidated', reason: 'verification_integrity_invalid',
    });
    expect(current.db.sqlite.prepare('SELECT deleted_at FROM items WHERE id = ?')
      .get(`blog:manual:${leadId}`)).toEqual({ deleted_at: expect.any(String) });
  });

  test('finalize snapshot excludes a selected manual item after its proof is downgraded to v9', async () => {
    const current = state();
    const leadId = 'ml-20260811-v9finalize01';
    const scheduled = candidates('v9-finalize');
    const itemInsert = current.db.sqlite.prepare('INSERT INTO items (id, deleted_at) VALUES (?, NULL)');
    for (const candidate of scheduled) itemInsert.run(candidate.item_id);
    await insertLead(current.db, leadId, 'anthropic-claude-5-release-2026-08-11');
    const frozen = await freezeNewsReviewBatch(
      current.env, '2026-08-11', scheduled, scheduled.map((item) => item.item_id), 100,
    );
    await confirmManualNewsLeadCandidate(
      current.env, leadId, 7, frozen.batch.batch_revision, 'confirm-v9-finalize', 110,
    );
    const active = await getActiveNewsReviewBatch(current.env, '2026-08-11');
    const token = await createNewsReviewToken('test-secret', '2026-08-11', active!.batch_id);
    const selectedIds = [`blog:manual:${leadId}`, ...scheduled.slice(0, 4).map((item) => item.item_id)];
    await submitNewsReviewSelection(current.env, {
      date: '2026-08-11', batch_id: active!.batch_id, token, selected_ids: selectedIds,
    }, 115);
    downgradeActiveProofToV9(current.db, leadId);

    const snapshot = await getVerifiedNewsReviewSelectionSnapshot(current.env, '2026-08-11', 120);
    expect(snapshot?.selected_ids).not.toContain(`blog:manual:${leadId}`);
    expect(snapshot?.manual_verifications).toEqual([]);
  });

  test('finalize snapshot excludes a selected v10 manual item after provenance becomes unsigned', async () => {
    const current = state();
    const leadId = 'ml-20260811-unsignedfinal';
    const scheduled = candidates('unsigned-finalize');
    const itemInsert = current.db.sqlite.prepare('INSERT INTO items (id, deleted_at) VALUES (?, NULL)');
    for (const candidate of scheduled) itemInsert.run(candidate.item_id);
    await insertLead(current.db, leadId, 'anthropic-claude-5-release-2026-08-11');
    const frozen = await freezeNewsReviewBatch(
      current.env, '2026-08-11', scheduled, scheduled.map((item) => item.item_id), 100,
    );
    await confirmManualNewsLeadCandidate(
      current.env, leadId, 7, frozen.batch.batch_revision, 'confirm-unsigned-finalize', 110,
    );
    const active = await getActiveNewsReviewBatch(current.env, '2026-08-11');
    const token = await createNewsReviewToken('test-secret', '2026-08-11', active!.batch_id);
    const selectedIds = [`blog:manual:${leadId}`, ...scheduled.slice(0, 4).map((item) => item.item_id)];
    await submitNewsReviewSelection(current.env, {
      date: '2026-08-11', batch_id: active!.batch_id, token, selected_ids: selectedIds,
    }, 115);
    stripActiveEvidenceProvenance(current.db, leadId);

    const snapshot = await getVerifiedNewsReviewSelectionSnapshot(current.env, '2026-08-11', 120);
    expect(snapshot?.selected_ids).not.toContain(`blog:manual:${leadId}`);
    expect(snapshot?.manual_verifications).toEqual([]);
  });

  test('finalize snapshot quarantines and excludes a selected manual item with a 12001-byte excerpt', async () => {
    const current = state();
    const leadId = 'ml-20260811-boundedfinal';
    const scheduled = candidates('bounded-finalize');
    const itemInsert = current.db.sqlite.prepare('INSERT INTO items (id, deleted_at) VALUES (?, NULL)');
    for (const candidate of scheduled) itemInsert.run(candidate.item_id);
    await insertLead(current.db, leadId, 'event-bounded-finalize');
    const frozen = await freezeNewsReviewBatch(
      current.env, '2026-08-11', scheduled, scheduled.map((item) => item.item_id), 100,
    );
    await confirmManualNewsLeadCandidate(
      current.env, leadId, 7, frozen.batch.batch_revision, 'confirm-bounded-finalize', 110,
    );
    const active = await getActiveNewsReviewBatch(current.env, '2026-08-11');
    const token = await createNewsReviewToken('test-secret', '2026-08-11', active!.batch_id);
    await submitNewsReviewSelection(current.env, {
      date: '2026-08-11', batch_id: active!.batch_id, token,
      selected_ids: [`blog:manual:${leadId}`, ...scheduled.slice(0, 4).map((item) => item.item_id)],
    }, 115);
    const oversized = `${'😀'.repeat(3_000)}x`;
    expect(Buffer.byteLength(oversized, 'utf8')).toBe(12_001);
    oversizePersistedEvidence(current.db, leadId, oversized);
    current.db.preparedSql.length = 0;
    current.db.rejectEvidenceBlobMaterialization = true;

    const snapshot = await getVerifiedNewsReviewSelectionSnapshot(current.env, '2026-08-11', 120);

    expect(current.db.preparedSql.some((sql) => sql.includes('manual_evidence:preflight'))).toBe(true);
    expect(current.db.preparedSql.some((sql) => sql.includes('manual_evidence:list'))).toBe(false);
    expect(snapshot?.selected_ids).not.toContain(`blog:manual:${leadId}`);
    expect(snapshot?.manual_verifications).toEqual([]);
    expect(current.db.sqlite.prepare(`SELECT status, reason FROM manual_news_assessment_verifications
      WHERE lead_id = ?`).get(leadId)).toEqual({
      status: 'invalidated', reason: 'verification_integrity_invalid',
    });
    expect(current.db.sqlite.prepare('SELECT deleted_at FROM items WHERE id = ?')
      .get(`blog:manual:${leadId}`)).toEqual({ deleted_at: expect.any(String) });
  });

  test('rejects selection of a just-invalidated manual candidate as stale without publishing', async () => {
    const current = state();
    const leadId = 'ml-20260811-staleselect1';
    await insertLead(current.db, leadId, 'event-stale-selection');
    const frozen = await freezeNewsReviewBatch(
      current.env, '2026-08-11', candidates('stale-selection'),
      candidates('stale-selection').map((item) => item.item_id), 100,
    );
    await confirmManualNewsLeadCandidate(
      current.env, leadId, 7, frozen.batch.batch_revision, 'confirm-stale-selection', 110,
    );
    const active = await getActiveNewsReviewBatch(current.env, '2026-08-11');
    const token = await createNewsReviewToken('test-secret', '2026-08-11', active!.batch_id);
    current.db.sqlite.prepare(`UPDATE manual_news_assessment_verifications SET hmac_sha256 = ?
      WHERE lead_id = ? AND status = 'active'`).run('0'.repeat(64), leadId);

    const result = await submitNewsReviewSelection(current.env, {
      date: '2026-08-11', batch_id: active!.batch_id, token,
      selected_ids: [`blog:manual:${leadId}`, ...active!.candidate_ids.slice(0, 2)],
    }, 120);
    expect(result).toMatchObject({ ok: false, status: 409, error: 'stale_candidate' });
    const refreshed = await getActiveNewsReviewBatch(current.env, '2026-08-11');
    expect(refreshed?.batch_revision).toBe(3);
    expect(refreshed?.applied_selected_ids).toBeNull();
  });

  test('sanitizes old manual snapshots before confirming another manual lead into the active batch', async () => {
    const current = state();
    const staleLeadId = 'ml-20260811-oldmanual001';
    const newLeadId = 'ml-20260811-newmanual001';
    await insertLead(current.db, staleLeadId, 'event-old-manual');
    await insertLead(current.db, newLeadId, 'event-new-manual');
    const frozen = await freezeNewsReviewBatch(
      current.env, '2026-08-11', candidates('confirm-sanitize'),
      candidates('confirm-sanitize').map((item) => item.item_id), 100,
    );
    await confirmManualNewsLeadCandidate(
      current.env, staleLeadId, 7, frozen.batch.batch_revision, 'confirm-old-manual', 110,
    );
    current.db.sqlite.prepare(`UPDATE manual_news_assessment_verifications SET hmac_sha256 = ?
      WHERE lead_id = ? AND status = 'active'`).run('0'.repeat(64), staleLeadId);

    const conflicted = await confirmManualNewsLeadCandidate(
      current.env, newLeadId, 7, 2, 'confirm-new-manual', 120,
    );
    expect(conflicted).toMatchObject({
      ok: false, status: 409, error: 'candidate_batch_revision_conflict',
    });
    const sanitized = await getActiveNewsReviewBatch(current.env, '2026-08-11');
    expect(sanitized?.batch_revision).toBe(3);
    expect(sanitized?.candidates.some((candidate) => candidate.lead_id === staleLeadId)).toBe(false);

    const retried = await confirmManualNewsLeadCandidate(
      current.env, newLeadId, 7, 3, 'confirm-new-manual', 130,
    );
    expect(retried).toMatchObject({ ok: true, batch: { revision: 4 } });
    const finalBatch = await getActiveNewsReviewBatch(current.env, '2026-08-11');
    expect(finalBatch?.candidates.some((candidate) => candidate.lead_id === staleLeadId)).toBe(false);
    expect(finalBatch?.candidates.some((candidate) => candidate.lead_id === newLeadId)).toBe(true);
  });

  test('retries batch sanitation when a verified manual proof changes after validation but before CAS', async () => {
    const current = state();
    const leadId = 'ml-20260811-sanitizeRace1';
    await insertLead(current.db, leadId, 'event-sanitize-race');
    const frozen = await freezeNewsReviewBatch(
      current.env, '2026-08-11', candidates('sanitize-race'),
      candidates('sanitize-race').map((item) => item.item_id), 100,
    );
    await confirmManualNewsLeadCandidate(
      current.env, leadId, 7, frozen.batch.batch_revision, 'confirm-sanitize-race', 110,
    );
    const active = await getActiveNewsReviewBatch(current.env, '2026-08-11');
    const staleSnapshot = active!.candidates.map((candidate) => candidate.lead_id === leadId
      ? { ...candidate, title: 'stale manual snapshot' }
      : candidate);
    current.db.sqlite.prepare(`UPDATE daily_news_review_batches SET candidates_json = ?
      WHERE review_date = '2026-08-11' AND batch_id = ?`).run(
      JSON.stringify(staleSnapshot), active!.batch_id,
    );
    const gate = current.db.pauseNextBatch();
    const sanitizing = sanitizeCurrentNewsReviewBatch(current.env, '2026-08-11', 120);
    await gate.entered;
    current.db.sqlite.prepare(`UPDATE manual_news_assessment_verifications SET hmac_sha256 = ?
      WHERE lead_id = ? AND status = 'active'`).run('0'.repeat(64), leadId);
    gate.release();

    const result = await sanitizing;
    expect(result).toMatchObject({ changed: true, dropped_ids: [`blog:manual:${leadId}`] });
    expect(result.batch.candidates.some((candidate) => candidate.lead_id === leadId)).toBe(false);
    expect(activeCount(current.db)).toBe(1);
  });

  test('does not merge another lead when an existing manual proof changes before confirm CAS', async () => {
    const current = state();
    const oldLeadId = 'ml-20260811-oldRace0001';
    const newLeadId = 'ml-20260811-newRace0001';
    await insertLead(current.db, oldLeadId, 'event-old-race');
    await insertLead(current.db, newLeadId, 'event-new-race');
    const frozen = await freezeNewsReviewBatch(
      current.env, '2026-08-11', candidates('confirm-proof-race'),
      candidates('confirm-proof-race').map((item) => item.item_id), 100,
    );
    await confirmManualNewsLeadCandidate(
      current.env, oldLeadId, 7, frozen.batch.batch_revision, 'confirm-old-race', 110,
    );
    const gate = current.db.pauseNextBatch();
    const confirming = confirmManualNewsLeadCandidate(
      current.env, newLeadId, 7, 2, 'confirm-new-race', 120,
    );
    await gate.entered;
    current.db.sqlite.prepare(`UPDATE manual_news_assessment_verifications SET hmac_sha256 = ?
      WHERE lead_id = ? AND status = 'active'`).run('0'.repeat(64), oldLeadId);
    gate.release();

    await expect(confirming).resolves.toMatchObject({ ok: false, status: 409, error: 'lead_version_conflict' });
    expect((await getActiveNewsReviewBatch(current.env, '2026-08-11'))?.batch_revision).toBe(2);
    expect(current.db.sqlite.prepare(`SELECT confirmed_at FROM manual_news_leads WHERE id = ?`)
      .get(newLeadId)).toEqual({ confirmed_at: null });
    expect(current.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM items WHERE id = ?`)
      .get(`blog:manual:${newLeadId}`)).toEqual({ count: 0 });
    const cleaned = await sanitizeCurrentNewsReviewBatch(current.env, '2026-08-11', 130);
    expect(cleaned.batch.batch_revision).toBe(3);
    expect(cleaned.batch.candidates.some((candidate) => candidate.lead_id === oldLeadId)).toBe(false);
  });

  test('selection CAS rejects a manual proof invalidated after preflight without publishing it', async () => {
    const current = state();
    const leadId = 'ml-20260811-selectRace01';
    await insertLead(current.db, leadId, 'event-selection-proof-race');
    const frozen = await freezeNewsReviewBatch(
      current.env, '2026-08-11', candidates('selection-proof-race'),
      candidates('selection-proof-race').map((item) => item.item_id), 100,
    );
    await confirmManualNewsLeadCandidate(
      current.env, leadId, 7, frozen.batch.batch_revision, 'confirm-selection-race', 110,
    );
    const active = await getActiveNewsReviewBatch(current.env, '2026-08-11');
    const token = await createNewsReviewToken('test-secret', '2026-08-11', active!.batch_id);
    const gate = current.db.pauseNextBatch();
    const selecting = submitNewsReviewSelection(current.env, {
      date: '2026-08-11', batch_id: active!.batch_id, token,
      selected_ids: [`blog:manual:${leadId}`, active!.candidate_ids[1]],
    }, 120);
    await gate.entered;
    current.db.sqlite.prepare(`UPDATE manual_news_assessment_verifications SET hmac_sha256 = ?
      WHERE lead_id = ? AND status = 'active'`).run('0'.repeat(64), leadId);
    gate.release();

    await expect(selecting).resolves.toMatchObject({ ok: false, status: 409, error: 'stale_candidate' });
    const refreshed = await getActiveNewsReviewBatch(current.env, '2026-08-11');
    expect(refreshed?.batch_revision).toBe(3);
    expect(refreshed?.applied_selected_ids).toBeNull();
    expect(refreshed?.candidates.some((candidate) => candidate.lead_id === leadId)).toBe(false);
  });

  test('confirmation cannot commit after its active verification is concurrently invalidated', async () => {
    const current = state();
    const leadId = 'ml-20260811-v00000000001';
    await insertLead(current.db, leadId, 'event-verification-confirm-race');
    await freezeNewsReviewBatch(
      current.env, '2026-08-11', candidates('verification-race'),
      candidates('verification-race').map((item) => item.item_id), 100,
    );
    const gate = current.db.pauseNextBatch();

    const confirmation = confirmManualNewsLeadCandidate(
      current.env, leadId, 7, 1, 'confirm-after-verification-check', 150,
    );
    await gate.entered;
    current.db.sqlite.prepare(`UPDATE manual_news_assessment_verifications
      SET status = 'invalidated', reason = 'concurrent_takeover', invalidated_at = 151
      WHERE lead_id = ? AND status = 'active'`).run(leadId);
    gate.release();

    await expect(confirmation).resolves.toMatchObject({ ok: false, status: 409 });
    expect(current.db.sqlite.prepare(`SELECT confirmed_at FROM manual_news_leads WHERE id = ?`)
      .get(leadId)).toEqual({ confirmed_at: null });
    expect(current.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM items WHERE id = ?`)
      .get(`blog:manual:${leadId}`)).toEqual({ count: 0 });
    expect(activeCount(current.db)).toBe(1);
  });

  test('confirmation cannot commit after verification JSON changes between validation and CAS', async () => {
    const current = state();
    const leadId = 'ml-20260811-q00000000001';
    await insertLead(current.db, leadId, 'event-verification-json-race');
    await freezeNewsReviewBatch(
      current.env, '2026-08-11', candidates('verification-json-race'),
      candidates('verification-json-race').map((item) => item.item_id), 100,
    );
    const gate = current.db.pauseNextBatch();

    const confirmation = confirmManualNewsLeadCandidate(
      current.env, leadId, 7, 1, 'confirm-after-verification-json-check', 150,
    );
    await gate.entered;
    const active = current.db.sqlite.prepare(`SELECT verification_json
      FROM manual_news_assessment_verifications WHERE lead_id = ? AND status = 'active'`)
      .get(leadId) as { verification_json: string };
    const changed = JSON.parse(active.verification_json);
    changed.fact_results[0].source_quotes[0].quote = 'Tampered quotation after the verifier check.';
    current.db.sqlite.prepare(`UPDATE manual_news_assessment_verifications SET verification_json = ?
      WHERE lead_id = ? AND status = 'active'`).run(JSON.stringify(changed), leadId);
    gate.release();

    await expect(confirmation).resolves.toMatchObject({ ok: false, status: 409 });
    expect(current.db.sqlite.prepare(`SELECT confirmed_at FROM manual_news_leads WHERE id = ?`)
      .get(leadId)).toEqual({ confirmed_at: null });
    expect(current.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM items WHERE id = ?`)
      .get(`blog:manual:${leadId}`)).toEqual({ count: 0 });
  });

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
    ).all(leadId)).toEqual([{ action: 'retry' }, { action: 'assessment_invalidate' }]);
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

  test('A to B to A creates a new immutable lineage revision instead of reusing historical A', async () => {
    const current = state();
    const firstA = await freezeNewsReviewBatch(
      current.env, '2026-08-11', candidates('a'), candidates('a').map((item) => item.item_id), 100,
    );
    const middleB = await freezeNewsReviewBatch(
      current.env, '2026-08-11', candidates('b'), candidates('b').map((item) => item.item_id), 200,
    );
    const secondA = await freezeNewsReviewBatch(
      current.env, '2026-08-11', candidates('a'), candidates('a').map((item) => item.item_id), 300,
    );

    expect(new Set([
      firstA.batch.batch_id, middleB.batch.batch_id, secondA.batch.batch_id,
    ])).toHaveLength(3);
    expect(secondA).toMatchObject({
      created: true,
      superseded_batch_id: middleB.batch.batch_id,
      batch: { batch_revision: 3, is_current: true, candidate_ids: candidates('a').map((item) => item.item_id) },
    });
    expect(current.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM daily_news_review_batches
      WHERE review_date = '2026-08-11'`).get()).toEqual({ count: 3 });
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

  test('scheduled freeze drops a snapshot manual candidate when its active HMAC no longer verifies', async () => {
    const current = state();
    const leadId = 'ml-20260811-h00000000001';
    await insertLead(current.db, leadId, 'event-invalidated-hmac');
    await freezeNewsReviewBatch(
      current.env, '2026-08-11', candidates('verified-v1'),
      candidates('verified-v1').map((item) => item.item_id), 100,
    );
    const confirmed = await confirmManualNewsLeadCandidate(
      current.env, leadId, 7, 1, 'confirm-before-hmac-tamper', 110,
    );
    expect(confirmed).toMatchObject({ ok: true, changed: true });
    expect((await getActiveNewsReviewBatch(current.env, '2026-08-11'))?.candidates
      .some((candidate) => candidate.lead_id === leadId)).toBe(true);

    current.db.sqlite.prepare(`UPDATE manual_news_assessment_verifications
      SET hmac_sha256 = ? WHERE lead_id = ? AND status = 'active'`).run('0'.repeat(64), leadId);
    const refreshed = await freezeNewsReviewBatch(
      current.env, '2026-08-11', candidates('verified-v3'),
      candidates('verified-v3').map((item) => item.item_id), 120,
    );

    expect(refreshed.batch.candidates.some((candidate) => candidate.lead_id === leadId)).toBe(false);
    expect(refreshed.batch.candidates.every((candidate) => candidate.origin !== 'manual_lead')).toBe(true);
  });

  test('scheduled freeze drops a manual candidate backed only by an active v9 proof', async () => {
    const current = state();
    const leadId = 'ml-20260811-v9freeze0001';
    await insertLead(current.db, leadId, 'anthropic-claude-5-release-2026-08-11');
    await freezeNewsReviewBatch(
      current.env, '2026-08-11', candidates('v9-freeze-v1'),
      candidates('v9-freeze-v1').map((item) => item.item_id), 100,
    );
    await confirmManualNewsLeadCandidate(
      current.env, leadId, 7, 1, 'confirm-v9-freeze', 110,
    );
    downgradeActiveProofToV9(current.db, leadId);

    const refreshed = await freezeNewsReviewBatch(
      current.env, '2026-08-11', candidates('v9-freeze-v2'),
      candidates('v9-freeze-v2').map((item) => item.item_id), 120,
    );

    expect(refreshed.batch.candidates.some((candidate) => candidate.lead_id === leadId)).toBe(false);
  });

  test('scheduled freeze drops a v10 manual candidate whose persisted evidence is unsigned', async () => {
    const current = state();
    const leadId = 'ml-20260811-unsignedfreeze';
    await insertLead(current.db, leadId, 'anthropic-claude-5-release-2026-08-11');
    await freezeNewsReviewBatch(
      current.env, '2026-08-11', candidates('unsigned-freeze-v1'),
      candidates('unsigned-freeze-v1').map((item) => item.item_id), 100,
    );
    await confirmManualNewsLeadCandidate(
      current.env, leadId, 7, 1, 'confirm-unsigned-freeze', 110,
    );
    stripActiveEvidenceProvenance(current.db, leadId);

    const refreshed = await freezeNewsReviewBatch(
      current.env, '2026-08-11', candidates('unsigned-freeze-v2'),
      candidates('unsigned-freeze-v2').map((item) => item.item_id), 120,
    );

    expect(refreshed.batch.candidates.some((candidate) => candidate.lead_id === leadId)).toBe(false);
  });

  test('scheduled freeze quarantines and drops a manual candidate with nine persisted sources', async () => {
    const current = state();
    const leadId = 'ml-20260811-boundedfreeze';
    await insertLead(current.db, leadId, 'event-bounded-freeze');
    await freezeNewsReviewBatch(
      current.env, '2026-08-11', candidates('bounded-freeze-v1'),
      candidates('bounded-freeze-v1').map((item) => item.item_id), 100,
    );
    await confirmManualNewsLeadCandidate(
      current.env, leadId, 7, 1, 'confirm-bounded-freeze', 110,
    );
    appendPersistedEvidenceToNine(current.db, leadId);
    current.db.preparedSql.length = 0;
    current.db.rejectEvidenceBlobMaterialization = true;

    const refreshed = await freezeNewsReviewBatch(
      current.env, '2026-08-11', candidates('bounded-freeze-v2'),
      candidates('bounded-freeze-v2').map((item) => item.item_id), 120,
    );

    expect(current.db.preparedSql.some((sql) => sql.includes('manual_evidence:preflight'))).toBe(true);
    expect(current.db.preparedSql.some((sql) => sql.includes('manual_evidence:list'))).toBe(false);
    expect(refreshed.batch.candidates.some((candidate) => candidate.lead_id === leadId)).toBe(false);
    expect(current.db.sqlite.prepare(`SELECT status, reason FROM manual_news_assessment_verifications
      WHERE lead_id = ?`).get(leadId)).toEqual({
      status: 'invalidated', reason: 'verification_integrity_invalid',
    });
    expect(current.db.sqlite.prepare('SELECT deleted_at FROM items WHERE id = ?')
      .get(`blog:manual:${leadId}`)).toEqual({ deleted_at: expect.any(String) });
  });

  test('scheduled freeze cannot preserve a manual-looking snapshot without a verified durable lead', async () => {
    const current = state();
    const scheduled = candidates('snapshot-guard');
    const injected = {
      item_id: 'blog:manual:ml-20260811-unverified001',
      title: 'Unverified snapshot title', summary: 'Unverified snapshot summary',
      source: 'snapshot', score: 99, event_key: 'unverified-snapshot-event',
    };

    const frozen = await freezeNewsReviewBatch(
      current.env, '2026-08-11', [...scheduled, injected],
      scheduled.map((candidate) => candidate.item_id), 100,
    );

    expect(frozen.batch.candidates).toEqual(scheduled);
    expect(frozen.batch.candidate_ids).not.toContain(injected.item_id);
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

  // This gate serially builds/signs six complete leads and runs six CAS confirmations; 10s avoids shared-CI 5s jitter without weakening behavior.
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
  }, 10_000);

  test('confirming a manual lead carries the human sequence and its review flag into the new revision', async () => {
    const current = state();
    const base = candidates('human-confirm');
    await freezeNewsReviewBatch(
      current.env, '2026-08-11', base, base.map((item) => item.item_id), 100,
    );
    const frozen = await getActiveNewsReviewBatch(current.env, '2026-08-11');
    const token = await createNewsReviewToken('test-secret', '2026-08-11', frozen!.batch_id);
    const humanOrder = ['human-confirm-4', 'human-confirm-1', 'human-confirm-3'];
    expect(await submitNewsReviewSelection(current.env, {
      date: '2026-08-11', batch_id: frozen!.batch_id, token, selected_ids: humanOrder,
    }, 110)).toMatchObject({ ok: true, changed: true });

    const leadId = 'ml-20260811-humanconfirm';
    await insertLead(current.db, leadId, 'event-human-confirm');
    const confirmed = await confirmManualNewsLeadCandidate(
      current.env, leadId, 7, frozen!.batch_revision, 'confirm-after-human-review', 120,
    );

    // 确认线索只扩候选池，不得把人审选择序列扔回自动排序，标记也必须继承，
    // 否则后一轮自动冻结就失去保护（2026-08-19 覆盖事故的入口之一）。
    expect(confirmed).toMatchObject({ ok: true, batch: { revision: 2 } });
    const after = await getActiveNewsReviewBatch(current.env, '2026-08-11');
    expect(after?.human_reviewed).toBe(true);
    expect(after?.applied_selected_ids).toEqual(humanOrder);
    expect(after?.candidates.some((candidate) => candidate.lead_id === leadId)).toBe(true);
    await expect(getAppliedNewsReviewSelection(current.env, '2026-08-11')).resolves.toEqual(humanOrder);
  });
});
