import { beforeEach, describe, expect, test, vi } from 'vitest';

const previousCandidates = Array.from({ length: 10 }, (_, index) => ({
  item_id: `news-${index + 1}`, title: `新闻${index + 1}`, summary: '摘要', source: '来源', score: 100 - index,
  event_key: `event-${index + 1}`,
}));
const activeBatch = {
  review_date: '2026-08-11', batch_id: 'nr-20260811-oldoldoldold', candidate_ids: previousCandidates.map((item) => item.item_id),
  candidates: previousCandidates, default_selected_ids: ['news-1', 'news-2', 'news-3', 'news-4', 'news-5'],
  applied_selected_ids: null, selection_hash: null, edit_revision: 0, publish_status: 'not_requested',
  publish_error: null, published_at: null, notified_at: 1, notification_hash: 'old',
  auto_repaired_from_batch: null, auto_repaired_invalid_ids: [], superseded_by: null,
  batch_revision: 1, supersedes_batch_id: null, revision_origin: 'scheduled_freeze',
  lineage_id: '2026-08-11', is_current: true, candidate_generation: 0, created_at: 1, expires_at: 9,
};

let insertedBatch: any = null;
vi.mock('./news-review', () => ({
  buildNewsReviewBatchId: vi.fn(async () => 'nr-20260811-newnewnewnew'),
  createNewsReviewToken: vi.fn(async () => 'review-token'),
  getActiveNewsReviewBatch: vi.fn(async () => activeBatch),
  getPublishedNewsReviewSelection: vi.fn(async () => ['news-2', 'news-1', 'news-5']),
  getNewsReviewBatch: vi.fn(async () => insertedBatch),
  newsReviewExpiresAt: vi.fn(() => 999),
  newsReviewSecret: vi.fn(() => 'secret'),
  sanitizeCurrentNewsReviewBatch: vi.fn(async () => ({
    batch: activeBatch, changed: false, dropped_ids: [],
  })),
}));

import { confirmManualNewsLeadCandidate } from './manual-news-leads-store';
import {
  proofForLegacyPolicy,
  TEST_MANUAL_NEWS_RESPONSE_SECRET,
  testManualNewsResponseKeyring,
  testManualNewsVerificationKeyring,
  withSignedArticleTextV2Audit,
} from './manual-news-signed-evidence.test-fixture';
import {
  applyManualLeadEvidencePolicy,
  buildManualLeadFactVerificationPrompt,
  createManualLeadVerificationProof,
  validateManualLeadGeneratedAssessment,
  validateManualLeadFactVerification,
} from './manual-news-leads';
import { getActiveNewsReviewBatch, newsReviewExpiresAt } from './news-review';

async function fakeConfirmationEnv() {
  const verificationSecret = 'a'.repeat(64);
  const supportedFact = 'Anthropic documented provenance coverage for supported Claude outputs only on 2026-08-10.';
  const rawAssessment = {
    event_key: 'anthropic-output-provenance-2026-08', event_type: 'product_documentation',
    material_update: false, score: 82, recommendation: 'recommended',
    occurred_at: '2026-08-10', uncertainties: [],
    source_facts: [{
      fact_ref: 'fact-01', source_language: 'en',
      atomic_fact: {
        subject: 'Anthropic', subject_role: 'organization', predicate: 'documented',
        object: 'provenance coverage for supported Claude outputs only on 2026-08-10',
      },
      evidence_ids: ['ev-1'],
    }],
    evidence_dispositions: [{
      evidence_id: 'ev-1', disposition: 'supports_core',
      source_fact_refs: ['fact-01'], reason_code: null,
    }],
    editorial_projection: {
      title: {
        projection_ref: 'title-01', source_fact_refs: ['fact-01'],
        atomic_fact: {
          subject: 'Anthropic', subject_role: 'organization', predicate: '已披露',
          object: '2026年8月10日仅适用于受支持Claude输出的来源信息',
        },
      },
      summary: [{
        projection_ref: 'summary-01', source_fact_refs: ['fact-01'],
        atomic_fact: {
          subject: 'Anthropic', subject_role: 'organization', predicate: '已披露',
          object: '2026年8月10日仅适用于受支持Claude输出的来源信息',
        },
      }],
    },
    matched_event_key: null,
  };
  const row: Record<string, any> = {
    id: 'ml-20260811-abc123def456', review_date: '2026-08-11', input_type: 'url', input_text: '',
    input_url: 'https://support.claude.com/example', note: '', status: 'recommended', version: 7,
    error_code: null, error_message: null, submit_idempotency_key: 'submit',
    last_mutation_kind: null, last_mutation_idempotency_key: null, last_mutation_nonce: null,
    confirmed_batch_id: null, confirmed_at: null, created_at: 1, updated_at: 1,
  };
  const evidenceForMarker = withSignedArticleTextV2Audit({
    id: 'ev-1',
    url: row.input_url,
    source_type: 'official_help' as const,
    publisher: 'Anthropic',
    published_at: null,
    retrieved_at: 2,
    title: 'Documentation',
    excerpt: supportedFact,
    claims_supported: [supportedFact],
    reliable: true,
  });
  const evidence = {
    evidence_id: evidenceForMarker.id,
    response_key_id: evidenceForMarker.response_key_id,
    url: evidenceForMarker.url,
    source_type: evidenceForMarker.source_type,
    publisher: evidenceForMarker.publisher,
    published_at: evidenceForMarker.published_at,
    retrieved_at: evidenceForMarker.retrieved_at,
    title: evidenceForMarker.title,
    excerpt: evidenceForMarker.excerpt,
    claims_supported_json: JSON.stringify(evidenceForMarker.claims_supported),
    fetch_audit_json: JSON.stringify(evidenceForMarker.fetch_audit),
    reliable: 1,
  };
  const core = validateManualLeadGeneratedAssessment(rawAssessment, [evidenceForMarker]);
  const processedCore = applyManualLeadEvidencePolicy(core, [evidenceForMarker]);
  const assessment = {
    ...processedCore,
    duplicate_scope: null, matched_lead_id: null,
  };
  const promptBody = JSON.parse(buildManualLeadFactVerificationPrompt({
    assessment, evidence: [evidenceForMarker],
  }).user) as {
    facts: Array<{ fact_id: string }>;
    projections: Array<{ projection_id: string; source_fact_ids: string[] }>;
    evidence_dispositions: Array<{ evidence_id: string; disposition: string }>;
  };
  const facts = promptBody.facts;
  const factVerification = validateManualLeadFactVerification({
    overall_verdict: 'supported',
    fact_results: facts.map((fact) => ({
      fact_id: fact.fact_id,
      supported: true,
      issue_code: 'none',
      source_quotes: [{ evidence_id: evidenceForMarker.id, quote: evidenceForMarker.excerpt }],
      ...(fact.fact_id === 'field:material_update' ? {
        comparison_result: {
          value: false, matched_event_key: null, prior_event_keys: [], reason_code: 'no_prior_match',
          current_evidence_id: evidenceForMarker.id, current_quote: evidenceForMarker.excerpt,
        },
      } : {}),
    })),
    projection_results: promptBody.projections.map((projection) => ({
      projection_id: projection.projection_id, source_fact_ids: projection.source_fact_ids,
      supported: true, issue_code: 'none',
    })),
    disposition_results: promptBody.evidence_dispositions.map((disposition) => ({
      evidence_id: disposition.evidence_id,
      disposition: disposition.disposition,
      supported: true,
      issue_code: 'none',
      source_quotes: [{ evidence_id: evidenceForMarker.id, quote: evidenceForMarker.excerpt }],
    })),
  }, assessment, [evidenceForMarker]);
  const assessmentVersion = 7;
  const proof = await createManualLeadVerificationProof({
    lead_id: row.id, assessment_version: assessmentVersion, assessment,
    evidence: [evidenceForMarker], verification: factVerification,
  }, testManualNewsVerificationKeyring(verificationSecret), testManualNewsResponseKeyring());
  const verification: Record<string, any> = {
    verification_id: 'mav-confirm-7',
    lead_id: row.id,
    assessment_version: assessmentVersion,
    ...proof,
    verification_json: JSON.stringify(factVerification),
    processing_owner: 'workflow-owner',
    processing_attempt: 1,
    creation_nonce: 'verification-create-confirm-7',
    status: 'active',
    reason: null,
    created_at: 3,
    invalidated_at: null,
    assessment_json: JSON.stringify(assessment),
  };
  const prepared: any[] = [];
  const db = {
    prepare(sql: string) {
      let binds: any[] = [];
      const stmt = {
        sql,
        get binds() { return binds; },
        bind(...values: any[]) { binds = values; return stmt; },
        async first() {
          if (sql.includes('manual_lead:by_id')) return { ...row };
          if (sql.includes('manual_evidence:preflight')) {
            return {
              evidence_count: 1,
              max_evidence_id_bytes: 4,
              max_response_key_id_bytes: 26,
              max_url_bytes: 42,
              max_source_type_bytes: 13,
              max_publisher_bytes: 9,
              max_published_at_bytes: 0,
              max_title_bytes: 13,
              max_excerpt_code_points: evidenceForMarker.excerpt.length,
              max_excerpt_bytes: new TextEncoder().encode(evidenceForMarker.excerpt).length,
              max_claims_bytes: evidence.claims_supported_json.length,
              max_fetch_audit_bytes: evidence.fetch_audit_json.length,
            };
          }
          if (sql.includes('manual_verification:active_assessment')) {
            return verification.status === 'active' ? { ...verification } : null;
          }
          return null;
        },
        async all() {
          if (sql.includes('manual_evidence:list')) return { results: [evidence] };
          return { results: [] };
        },
        async run() { return { success: true, meta: { changes: 1 } }; },
      };
      prepared.push(stmt);
      return stmt;
    },
    async batch(statements: any[]) {
      const quarantineStmt = statements.find((stmt: any) => stmt.sql.includes('manual_verification:quarantine */'));
      if (quarantineStmt) {
        verification.status = 'invalidated';
        verification.reason = quarantineStmt.binds[0];
        verification.invalidated_at = quarantineStmt.binds[1];
        return statements.map((stmt: any) => ({
          success: true,
          meta: { changes: stmt.sql.includes('quarantine_item') ? 0 : 1 },
        }));
      }
      const batchStmt = statements.find((stmt: any) => stmt.sql.includes('manual_lead:confirm_batch'));
      const confirmStmt = statements.find((stmt: any) => stmt.sql.includes('manual_lead:confirm */'));
      const prefreezeStmt = statements.find((stmt: any) => stmt.sql.includes('manual_lead:confirm_prefreeze'));
      const expectedVersion = batchStmt ? confirmStmt.binds[6] : prefreezeStmt.binds[5];
      if (row.version === expectedVersion && batchStmt) {
        const candidates = JSON.parse(batchStmt.binds[3]);
        insertedBatch = {
          ...activeBatch,
          batch_id: batchStmt.binds[1], candidate_ids: JSON.parse(batchStmt.binds[2]), candidates,
          default_selected_ids: JSON.parse(batchStmt.binds[4]), batch_revision: batchStmt.binds[7],
          supersedes_batch_id: batchStmt.binds[8], revision_origin: 'manual_lead',
        };
        row.version += 1;
        row.confirmed_batch_id = confirmStmt.binds[0];
        row.confirmed_at = confirmStmt.binds[1];
        row.last_mutation_kind = 'confirm';
        row.last_mutation_idempotency_key = confirmStmt.binds[2];
        row.last_mutation_nonce = confirmStmt.binds[3];
      } else if (row.version === expectedVersion && prefreezeStmt) {
        row.version += 1;
        row.confirmed_at = prefreezeStmt.binds[0];
        row.last_mutation_kind = 'confirm';
        row.last_mutation_idempotency_key = prefreezeStmt.binds[1];
        row.last_mutation_nonce = prefreezeStmt.binds[2];
      }
      return statements.map(() => ({ success: true, meta: { changes: 1 } }));
    },
  };
  return {
    env: {
      DB: db,
      DAILY_NEWS_REVIEW_SECRET: 'secret',
      MANUAL_NEWS_VERIFICATION_SECRET: verificationSecret,
      MANUAL_NEWS_VERIFICATION_KEY_ID: 'verification-key-2026-08-11',
      MANUAL_NEWS_RESEARCH_RESPONSE_SECRET: TEST_MANUAL_NEWS_RESPONSE_SECRET,
      MANUAL_NEWS_RESEARCH_RESPONSE_KEY_ID: 'response-key-2026-08-11',
    } as never,
    row,
    evidence,
    assessment,
    verification,
    prepared,
  };
}

describe('manual lead candidate confirmation', () => {
  beforeEach(() => {
    insertedBatch = null;
    vi.mocked(newsReviewExpiresAt).mockReturnValue(999);
  });

  test('atomically supersedes V1 with a capped V2 while preserving current published Top selection', async () => {
    const memory = await fakeConfirmationEnv();
    const result = await confirmManualNewsLeadCandidate(
      memory.env, memory.row.id, 7, 1, 'confirm-key-1', 100,
    );

    expect(result).toMatchObject({
      ok: true, changed: true, rerender_enqueued: false, pending_initial_freeze: false,
      batch: { batch_id: 'nr-20260811-newnewnewnew', revision: 2, supersedes_revision: 1, current: true },
    });
    expect(insertedBatch.candidates).toHaveLength(10);
    expect(insertedBatch.candidates.at(-1)).toMatchObject({
      item_id: `blog:manual:${memory.row.id}`, origin: 'manual_lead', lead_id: memory.row.id,
      title: 'Anthropic已披露2026年8月10日仅适用于受支持Claude输出的来源信息。',
      summary: 'Anthropic已披露2026年8月10日仅适用于受支持Claude输出的来源信息。',
    });
    expect(insertedBatch.candidates.some((item: any) => item.item_id === 'news-10')).toBe(false);
    expect(insertedBatch.default_selected_ids).toEqual(['news-2', 'news-1', 'news-5']);
    expect(insertedBatch.applied_selected_ids).toBeNull();
  });

  test('replays the same confirmation key without another mutation and rejects a second confirmation', async () => {
    const memory = await fakeConfirmationEnv();
    const first = await confirmManualNewsLeadCandidate(memory.env, memory.row.id, 7, 1, 'confirm-key-1', 100);
    expect(first.ok).toBe(true);
    const repeated = await confirmManualNewsLeadCandidate(memory.env, memory.row.id, 7, 1, 'confirm-key-1', 200);
    expect(repeated).toMatchObject({ ok: true, changed: false, rerender_enqueued: false });
    const conflict = await confirmManualNewsLeadCandidate(memory.env, memory.row.id, 7, 1, 'confirm-key-2', 300);
    expect(conflict).toMatchObject({ ok: false, status: 409, error: 'lead_already_confirmed', lead: { version: 8 } });
  });

  test('idempotent confirmation replay reports that its historical batch is no longer current', async () => {
    const memory = await fakeConfirmationEnv();
    const first = await confirmManualNewsLeadCandidate(memory.env, memory.row.id, 7, 1, 'confirm-key-aba', 100);
    expect(first).toMatchObject({ ok: true, batch: { current: true } });
    insertedBatch.is_current = false;
    insertedBatch.superseded_by = 'nr-20260811-currentcurrent';

    const repeated = await confirmManualNewsLeadCandidate(
      memory.env, memory.row.id, 7, 1, 'confirm-key-aba', 200,
    );

    expect(repeated).toMatchObject({ ok: true, changed: false, batch: { current: false } });
  });

  test('persists a pre-freeze confirmed lead as a candidate item without selecting or rendering it', async () => {
    vi.mocked(getActiveNewsReviewBatch).mockResolvedValueOnce(null);
    const memory = await fakeConfirmationEnv();

    const result = await confirmManualNewsLeadCandidate(
      memory.env, memory.row.id, 7, 0, 'confirm-prefreeze', 100,
    );

    expect(result).toMatchObject({
      ok: true, changed: true, pending_initial_freeze: true, batch: null, rerender_enqueued: false,
      lead: { confirmed_at: 100 },
    });
    const itemStatement = memory.prepared.find((statement) => statement.sql.includes('manual_lead:confirm_item'));
    expect(itemStatement?.sql).toMatch(/NOT EXISTS \(SELECT 1 FROM daily_news_review_batches/);
    expect(memory.prepared.some((statement) => statement.sql.includes('manual_lead:candidate_generation_init'))).toBe(true);
    expect(memory.prepared.some((statement) => statement.sql.includes('manual_lead:candidate_generation_advance'))).toBe(true);
    expect(memory.prepared.some((statement) => statement.sql.includes('manual_lead:confirm_batch'))).toBe(false);
    expect(memory.prepared.some((statement) => statement.sql.includes('manual_lead:supersede_batch'))).toBe(false);
    expect(memory.prepared.some((statement) => statement.sql.includes('manual_lead:activate_batch'))).toBe(false);

    const second = await confirmManualNewsLeadCandidate(
      memory.env, memory.row.id, 8, 0, 'different-confirm-key', 200,
    );
    expect(second).toMatchObject({ ok: false, status: 409, error: 'lead_already_confirmed' });
  });

  test('rejects a stale expected candidate revision before creating another batch', async () => {
    const memory = await fakeConfirmationEnv();
    const result = await confirmManualNewsLeadCandidate(
      memory.env, memory.row.id, 7, 0, 'confirm-stale-batch', 100,
    );
    expect(result).toMatchObject({ ok: false, status: 409, error: 'candidate_batch_revision_conflict' });
    expect(insertedBatch).toBeNull();
  });

  test('rejects confirmation after the date-scoped review window expires', async () => {
    vi.mocked(newsReviewExpiresAt).mockReturnValueOnce(99);
    const memory = await fakeConfirmationEnv();
    const result = await confirmManualNewsLeadCandidate(
      memory.env, memory.row.id, 7, 1, 'confirm-after-expiry', 100,
    );

    expect(result).toMatchObject({ ok: false, status: 409, error: 'review_expired' });
    expect(insertedBatch).toBeNull();
  });

  test.each([
    ['no active verification', (verification: Record<string, any>) => { verification.status = 'invalidated'; }],
    ['old policy', (verification: Record<string, any>) => { verification.policy_version = 'legacy-v0'; }],
    ['wrong HMAC', (verification: Record<string, any>) => { verification.hmac_sha256 = '0'.repeat(64); }],
    ['tampered verification JSON', (verification: Record<string, any>) => {
      const parsed = JSON.parse(verification.verification_json);
      parsed.fact_results[0].source_quotes[0].quote = 'Unrelated tampered quotation with enough words.';
      verification.verification_json = JSON.stringify(parsed);
    }],
    ['wrong assessment version', (verification: Record<string, any>) => { verification.assessment_version = 6; }],
  ])('rejects confirmation with %s before any candidate mutation', async (_label, mutate) => {
    const memory = await fakeConfirmationEnv();
    mutate(memory.verification);

    const result = await confirmManualNewsLeadCandidate(
      memory.env, memory.row.id, 7, 1, `confirm-${_label}`, 100,
    );

    expect(result).toMatchObject({ ok: false, status: 409, error: 'lead_not_fact_verified' });
    expect(insertedBatch).toBeNull();
    expect(memory.row.confirmed_at).toBeNull();
  });

  test('rejects an active v9 proof before confirmation mutates the candidate pool', async () => {
    const memory = await fakeConfirmationEnv();
    Object.assign(memory.verification, proofForLegacyPolicy(
      {
        policy_version: String(memory.verification.policy_version),
        canonical_digest: String(memory.verification.canonical_digest),
        hmac_sha256: String(memory.verification.hmac_sha256),
      },
      { lead_id: memory.row.id, assessment_version: memory.verification.assessment_version },
      'a'.repeat(64),
    ));

    const result = await confirmManualNewsLeadCandidate(
      memory.env, memory.row.id, 7, 1, 'confirm-v9-proof', 100,
    );

    expect(result).toMatchObject({ ok: false, status: 409, error: 'lead_not_fact_verified' });
    expect(insertedBatch).toBeNull();
    expect(memory.row.confirmed_at).toBeNull();
  });

  test('rejects a v10 proof whose persisted evidence has become unsigned before confirmation', async () => {
    const memory = await fakeConfirmationEnv();
    memory.evidence.fetch_audit_json = 'null';

    const result = await confirmManualNewsLeadCandidate(
      memory.env, memory.row.id, 7, 1, 'confirm-unsigned-v10-proof', 100,
    );

    expect(result).toMatchObject({ ok: false, status: 409, error: 'lead_not_fact_verified' });
    expect(insertedBatch).toBeNull();
    expect(memory.row.confirmed_at).toBeNull();
  });

  test('rejects confirmation when a quoted evidence field changed after verification', async () => {
    const memory = await fakeConfirmationEnv();
    memory.evidence.excerpt = 'Changed evidence after the fact verification completed.';

    const result = await confirmManualNewsLeadCandidate(
      memory.env, memory.row.id, 7, 1, 'confirm-quote-tamper', 100,
    );

    expect(result).toMatchObject({ ok: false, status: 409, error: 'lead_not_fact_verified' });
    expect(insertedBatch).toBeNull();
  });
});
